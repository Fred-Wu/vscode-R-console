//! A session-lifetime key, disclosed only through an OS-protected local endpoint.
//! The endpoint name is public; no authentication credential or key is written to disk.
use std::io;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::thread::{self, JoinHandle};
use std::time::Duration;

struct Key { bytes: [u8; 32] }
impl Drop for Key {
    fn drop(&mut self) {
        for byte in &mut self.bytes { unsafe { std::ptr::write_volatile(byte, 0) }; }
        std::sync::atomic::compiler_fence(Ordering::SeqCst);
    }
}

pub(crate) struct Broker {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    #[cfg(unix)]
    endpoint: std::path::PathBuf,
}

impl Drop for Broker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.endpoint);
    }
}

fn valid_session_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) { b == b'-' }
        else { b.is_ascii_digit() || (b'a'..=b'f').contains(&b) }
    })
}

const MAX_STATE: usize = 16 * 1024 * 1024 - 32;

#[derive(Clone, Copy)]
enum PrivateRequest { Key, Get, Put(usize) }

fn request_kind(request: &[u8; 37]) -> Option<PrivateRequest> {
    let magic = &request[..4];
    if magic == b"RCK1" && request[4..].iter().all(|value| *value == 0) {
        return Some(PrivateRequest::Key);
    }
    if magic == b"RCSG" && request[4..].iter().all(|value| *value == 0) {
        return Some(PrivateRequest::Get);
    }
    if magic == b"RCSP" && request[8..].iter().all(|value| *value == 0) {
        let len = u32::from_le_bytes(request[4..8].try_into().ok()?) as usize;
        if len > 0 && len <= MAX_STATE { return Some(PrivateRequest::Put(len)); }
    }
    None
}

fn reply(key: &Key, output: &crate::protocol::OutputSink, kind: PrivateRequest, payload: Vec<u8>) -> Vec<u8> {
    match kind {
        PrivateRequest::Key => {
            let mut response = vec![0; 41];
            response[..4].copy_from_slice(b"RCK1");
            response[4..8].copy_from_slice(&std::process::id().to_le_bytes());
            response[9..].copy_from_slice(&key.bytes);
            response
        }
        PrivateRequest::Get => {
            let state = output.private_startup_get();
            let data = state.as_ref().map(|item| item.as_bytes()).unwrap_or(&[]);
            let mut response = Vec::with_capacity(12 + data.len());
            response.extend_from_slice(b"RCSR");
            response.extend_from_slice(&std::process::id().to_le_bytes());
            response.extend_from_slice(&(data.len() as u32).to_le_bytes());
            response.extend_from_slice(data);
            response
        }
        PrivateRequest::Put(_) => {
            let accepted = output.private_startup_put(crate::protocol::StartupState::new(payload));
            let mut response = Vec::with_capacity(13);
            response.extend_from_slice(b"RCSR");
            response.extend_from_slice(&std::process::id().to_le_bytes());
            response.extend_from_slice(&1_u32.to_le_bytes());
            response.push(if accepted { 0 } else { 1 });
            response
        }
    }
}

pub(crate) fn start(id: &str, output: crate::protocol::OutputSink) -> io::Result<Broker> {
    if !valid_session_id(id) { return Err(io::Error::other("invalid registry key session identifier")); }
    let key = Key { bytes: crate::protocol::secure_server_nonce()? };
    platform_start(id, key, output)
}

#[cfg(unix)]
fn platform_start(id: &str, key: Key, output: crate::protocol::OutputSink) -> io::Result<Broker> {
    use std::io::{Read, Write};
    use std::time::Instant;
    use std::os::unix::{fs::{DirBuilderExt, MetadataExt, PermissionsExt}, net::UnixListener};
    let uid = unsafe { libc::geteuid() };
    // A short local path also fits macOS's sockaddr_un limit.
    let directory = std::path::PathBuf::from(format!("/tmp/r-console-keys-{uid}"));
    match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {},
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
        Err(error) => return Err(error),
    }
    let metadata = std::fs::symlink_metadata(&directory)?;
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err(io::Error::other("registry key directory is not private to this user"));
    }
    let endpoint = directory.join(format!("{id}.sock"));
    let listener = UnixListener::bind(&endpoint)?;
    if let Err(error) = std::fs::set_permissions(&endpoint, std::fs::Permissions::from_mode(0o600))
        .and_then(|()| listener.set_nonblocking(true)) {
        let _ = std::fs::remove_file(&endpoint);
        return Err(error);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = Arc::clone(&stop);
    let thread = thread::spawn(move || {
        while !stopped.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    if stream.set_nonblocking(true).is_err() { continue; }
                    let deadline = Instant::now() + Duration::from_millis(500);
                    let mut request = [0; 37];
                    let mut count = 0;
                    while count < request.len() && Instant::now() < deadline && !stopped.load(Ordering::SeqCst) {
                        match stream.read(&mut request[count..]) {
                            Ok(0) => break,
                            Ok(read) => count += read,
                            Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(10)),
                            Err(_) => break,
                        }
                    }
                    if count != request.len() { continue; }
                    let Some(kind) = request_kind(&request) else { continue; };
                    if stream.set_nonblocking(false).is_err() { continue; }
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                    let payload = if let PrivateRequest::Put(len) = kind {
                        let mut bytes = vec![0; len];
                        if stream.read_exact(&mut bytes).is_err() { bytes.fill(0); continue; }
                        bytes
                    } else { Vec::new() };
                    let mut response = reply(&key, &output, kind, payload);
                    let _ = stream.write_all(&response);
                    response.fill(0);
                },
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(10)),
                Err(_) => break,
            }
        }
    });
    Ok(Broker { stop, thread: Some(thread), endpoint })
}

#[cfg(windows)]
fn platform_start(id: &str, key: Key, output: crate::protocol::OutputSink) -> io::Result<Broker> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::null_mut;
    use std::time::Instant;
    use windows_sys::Win32::{
        Foundation::{INVALID_HANDLE_VALUE, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, ERROR_NO_DATA},
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX, ReadFile, WriteFile},
        System::Pipes::{CreateNamedPipeW, ConnectNamedPipe, DisconnectNamedPipe,
            PIPE_TYPE_BYTE, PIPE_READMODE_BYTE, PIPE_NOWAIT, PIPE_REJECT_REMOTE_CLIENTS},
    };
    let descriptor = crate::windows_pipe_security::private_pipe_descriptor()?;
    let attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0, bInheritHandle: 0 };
    let name: Vec<u16> = format!(r"\\.\pipe\r-console-key-{id}").encode_utf16().chain(Some(0)).collect();
    let raw = unsafe { CreateNamedPipeW(name.as_ptr(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1, 4096, 4096, 0, &attributes) };
    if raw == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
    let pipe = unsafe { OwnedHandle::from_raw_handle(raw) };
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = Arc::clone(&stop);
    let thread = thread::spawn(move || {
        let raw = pipe.as_raw_handle();
        while !stopped.load(Ordering::SeqCst) {
            let connected = unsafe { ConnectNamedPipe(raw, null_mut()) } != 0;
            let error = io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32;
            // NOWAIT reports success when a disconnected instance starts
            // listening. Only ERROR_PIPE_CONNECTED identifies an actual client.
            if connected || error != ERROR_PIPE_CONNECTED {
                if connected { /* Newly listening. */ }
                else if error == ERROR_NO_DATA { unsafe { DisconnectNamedPipe(raw); } }
                else if error != ERROR_PIPE_LISTENING { break; }
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            let deadline = Instant::now() + Duration::from_millis(500);
            let mut request = [0; 37];
            let mut count = 0;
            while count < request.len() && Instant::now() < deadline && !stopped.load(Ordering::SeqCst) {
                let mut read = 0;
                unsafe { ReadFile(raw, request[count..].as_mut_ptr(), (request.len() - count) as u32, &mut read, null_mut()); }
                count += read as usize;
                if count < request.len() { thread::sleep(Duration::from_millis(10)); }
            }
            let kind = if count == request.len() { request_kind(&request) } else { None };
            let Some(kind) = kind else { unsafe { DisconnectNamedPipe(raw); } continue; };
            let payload = if let PrivateRequest::Put(len) = kind {
                let mut bytes = vec![0_u8; len];
                let deadline = Instant::now() + Duration::from_secs(10);
                let mut received = 0;
                while received < len && Instant::now() < deadline && !stopped.load(Ordering::SeqCst) {
                    let mut count = 0;
                    let size = (len - received).min(4096) as u32;
                    let _success = unsafe { ReadFile(raw, bytes[received..].as_mut_ptr(), size,
                        &mut count, null_mut()) } != 0;
                    received += count as usize;
                    if count == 0 { thread::sleep(Duration::from_millis(2)); }
                }
                if received != len { bytes.fill(0); unsafe { DisconnectNamedPipe(raw); } continue; }
                bytes
            } else { Vec::new() };
            let mut bytes = reply(&key, &output, kind, payload);
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut sent = 0;
            while sent < bytes.len() && Instant::now() < deadline && !stopped.load(Ordering::SeqCst) {
                let mut written = 0;
                let size = (bytes.len() - sent).min(4096) as u32;
                let _success = unsafe { WriteFile(raw, bytes[sent..].as_ptr(), size,
                    &mut written, null_mut()) } != 0;
                sent += written as usize;
                if written == 0 { thread::sleep(Duration::from_millis(2)); }
            }
            let delivered = sent == bytes.len();
            bytes.fill(0);
            // Keep the named-pipe instance until the client confirms all bytes
            // were received, otherwise DisconnectNamedPipe may discard them.
            if delivered {
                let deadline = Instant::now() + Duration::from_millis(1000);
                let mut ack = [0u8; 4];
                let mut count = 0;
                while count < ack.len() && Instant::now() < deadline && !stopped.load(Ordering::SeqCst) {
                    let mut read = 0;
                    unsafe { ReadFile(raw, ack[count..].as_mut_ptr(), (ack.len() - count) as u32, &mut read, null_mut()); }
                    count += read as usize;
                    if read == 0 { thread::sleep(Duration::from_millis(2)); }
                }
            }
            unsafe { DisconnectNamedPipe(raw); }
        }
        drop(pipe);
    });
    Ok(Broker { stop, thread: Some(thread) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_requests_are_bounded_and_do_not_enter_tcp_replay() {
        let sink = crate::protocol::OutputSink::new_with_capabilities("test", &[]);
        let key = Key { bytes: [42; 32] };
        let mut request = [0; 37];
        request[..4].copy_from_slice(b"RCK1");
        assert!(matches!(request_kind(&request), Some(PrivateRequest::Key)));
        let response = reply(&key, &sink, PrivateRequest::Key, vec![]);
        assert_eq!(&response[9..], &[42; 32]);
        request[..4].copy_from_slice(b"RCSP");
        request[4..8].copy_from_slice(&4_u32.to_le_bytes());
        assert!(matches!(request_kind(&request), Some(PrivateRequest::Put(4))));
        assert_eq!(reply(&key, &sink, PrivateRequest::Put(4), b"test".to_vec())[12], 0);
        assert_eq!(reply(&key, &sink, PrivateRequest::Put(4), b"fail".to_vec())[12], 1);
        let response = reply(&key, &sink, PrivateRequest::Get, vec![]);
        assert_eq!(&response[12..], b"test");
        assert_eq!(sink.private_startup_get().unwrap().as_bytes(), b"test");
        request[4..8].copy_from_slice(&((MAX_STATE + 1) as u32).to_le_bytes());
        assert!(request_kind(&request).is_none());
        request[..4].copy_from_slice(b"RCK1");
        assert!(request_kind(&request).is_none());
        request[4..8].fill(0);
        request[12] = 1;
        assert!(request_kind(&request).is_none());
    }
    #[test]
    fn endpoint_ids_cannot_select_paths_or_remote_hosts() {
        assert!(valid_session_id("01234567-89ab-cdef-0123-456789abcdef"));
        for id in ["../../other", r"\\server\share", "", "01234567-89ab-cdef-0123-456789abcdeg"] {
            assert!(!valid_session_id(id));
        }
    }
    #[cfg(unix)]
    #[test]
    fn private_endpoint_retains_one_key_and_removes_it_on_shutdown() {
        use std::io::{Read, Write};
        use std::os::unix::{fs::MetadataExt, net::UnixStream};
        let nonce = crate::protocol::secure_server_nonce().unwrap();
        let hex: String = nonce[..16].iter().map(|b| format!("{b:02x}")).collect();
        let id = format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]);
        let broker = start(&id, crate::protocol::OutputSink::new_with_capabilities("test", &[])).unwrap();
        assert_eq!(std::fs::metadata(&broker.endpoint).unwrap().mode() & 0o777, 0o600);
        let read = |endpoint: &std::path::Path| {
            let mut bytes = [0; 41];
            let mut stream = UnixStream::connect(endpoint).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
            let mut request = [0; 37];
            request[..4].copy_from_slice(b"RCK1");
            stream.write_all(&request).unwrap();
            stream.read_exact(&mut bytes).unwrap();
            bytes
        };
        let first = read(&broker.endpoint);
        assert_eq!(&first[..4], b"RCK1");
        assert_eq!(first, read(&broker.endpoint));
        let mut other_id = id.clone();
        other_id.replace_range(..1, if id.starts_with('a') { "b" } else { "a" });
        let other = start(&other_id, crate::protocol::OutputSink::new_with_capabilities("test", &[])).unwrap();
        assert_ne!(&first[9..], &read(&other.endpoint)[9..]);
        // A client which sends no request cannot hold the broker indefinitely.
        let _stalled = UnixStream::connect(&broker.endpoint).unwrap();
        assert_eq!(first, read(&broker.endpoint));
        let endpoint = broker.endpoint.clone();
        drop(broker);
        assert!(!endpoint.exists());
    }
}
