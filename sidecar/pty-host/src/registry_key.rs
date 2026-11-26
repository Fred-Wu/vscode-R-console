//! A session-lifetime key, disclosed only through an OS-protected local endpoint.
//! The endpoint name is public; no authentication credential or key is written to disk.
use std::io::{self, Read, Write};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
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

const CLIENT_CONTEXT: &[u8] = b"rconsole-private-state-client-v1";
const SERVER_CONTEXT: &[u8] = b"rconsole-private-state-server-v1";

fn state_mac(token: &[u8], context: &[u8], nonce: &[u8; 32],
             request: &[u8; 37], payload: &[u8]) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(token).expect("HMAC accepts a session token");
    mac.update(context);
    mac.update(nonce);
    mac.update(request);
    mac.update(payload);
    mac
}

fn state_challenge(nonce: &[u8; 32]) -> [u8; 40] {
    let mut frame = [0u8; 40];
    frame[..4].copy_from_slice(b"RCSC");
    frame[4..8].copy_from_slice(&std::process::id().to_le_bytes());
    frame[8..].copy_from_slice(nonce);
    frame
}

fn state_reply(key: &Key, output: &crate::protocol::OutputSink, kind: PrivateRequest,
               payload: Vec<u8>, token: &[u8], nonce: &[u8; 32],
               request: &[u8; 37]) -> Vec<u8> {
    let mut response = reply(key, output, kind, payload);
    let proof = state_mac(token, SERVER_CONTEXT, nonce, request, &response)
        .finalize().into_bytes();
    response.extend_from_slice(&proof);
    response
}

fn read_state_proof<R: Read>(reader: &mut R, kind: PrivateRequest, request: &[u8; 37],
                             nonce: &[u8; 32], token: &[u8]) -> io::Result<Option<Vec<u8>>> {
    let mut proof = [0u8; 32];
    reader.read_exact(&mut proof)?;
    let mut payload = if let PrivateRequest::Put(size) = kind {
        let mut bytes = vec![0; size];
        reader.read_exact(&mut bytes)?;
        bytes
    } else { Vec::new() };
    let authenticated = state_mac(token, CLIENT_CONTEXT, nonce, request, &payload)
        .verify_slice(&proof).is_ok();
    proof.fill(0);
    if !authenticated { payload.fill(0); return Ok(None); }
    Ok(Some(payload))
}


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

pub(crate) fn start(id: &str, output: crate::protocol::OutputSink, token: String) -> io::Result<Broker> {
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(io::Error::other("invalid private startup session token"));
    }
    if !valid_session_id(id) { return Err(io::Error::other("invalid registry key session identifier")); }
    let key = Key { bytes: crate::protocol::secure_server_nonce()? };
    platform_start(id, key, output, token)
}

#[cfg(unix)]
fn platform_start(id: &str, key: Key, output: crate::protocol::OutputSink, token: String) -> io::Result<Broker> {
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
                    let mut response = match kind {
                        PrivateRequest::Key => reply(&key, &output, kind, Vec::new()),
                        PrivateRequest::Get | PrivateRequest::Put(_) => {
                            let nonce = match crate::protocol::secure_server_nonce() {
                                Ok(nonce) => nonce,
                                Err(_) => continue,
                            };
                            if stream.write_all(&state_challenge(&nonce)).is_err() { continue; }
                            let payload = match read_state_proof(&mut stream, kind, &request, &nonce, token.as_bytes()) {
                                Ok(Some(payload)) => payload,
                                _ => continue,
                            };
                            state_reply(&key, &output, kind, payload, token.as_bytes(), &nonce, &request)
                        }
                    };
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
fn platform_start(id: &str, key: Key, output: crate::protocol::OutputSink, token: String) -> io::Result<Broker> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::null_mut;
    use std::time::Instant;
    use windows_sys::Win32::{
        Foundation::{INVALID_HANDLE_VALUE, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, ERROR_NO_DATA},
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX, ReadFile},
        System::Pipes::{CreateNamedPipeW, ConnectNamedPipe, DisconnectNamedPipe,
            PIPE_TYPE_BYTE, PIPE_READMODE_BYTE, PIPE_NOWAIT, PIPE_REJECT_REMOTE_CLIENTS},
    };
    fn read_exact_pipe(raw: windows_sys::Win32::Foundation::HANDLE, into: &mut [u8],
                       stopped: &AtomicBool, limit: Duration) -> bool {
        use windows_sys::Win32::Storage::FileSystem::ReadFile;
        use std::ptr::null_mut;
        let deadline = std::time::Instant::now() + limit;
        let mut read_total = 0;
        while read_total < into.len() && std::time::Instant::now() < deadline &&
              !stopped.load(Ordering::SeqCst) {
            let mut count = 0;
            unsafe { ReadFile(raw, into[read_total..].as_mut_ptr(),
                (into.len() - read_total).min(4096) as u32, &mut count, null_mut()); }
            read_total += count as usize;
            if count == 0 { thread::sleep(Duration::from_millis(2)); }
        }
        read_total == into.len()
    }
    fn write_all_pipe(raw: windows_sys::Win32::Foundation::HANDLE, bytes: &[u8],
                      stopped: &AtomicBool, limit: Duration) -> bool {
        use windows_sys::Win32::Storage::FileSystem::WriteFile;
        use std::ptr::null_mut;
        let deadline = std::time::Instant::now() + limit;
        let mut sent = 0;
        while sent < bytes.len() && std::time::Instant::now() < deadline &&
              !stopped.load(Ordering::SeqCst) {
            let mut written = 0;
            unsafe { WriteFile(raw, bytes[sent..].as_ptr(),
                (bytes.len() - sent).min(4096) as u32, &mut written, null_mut()); }
            sent += written as usize;
            if written == 0 { thread::sleep(Duration::from_millis(2)); }
        }
        sent == bytes.len()
    }
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
            let authenticated = !matches!(kind, PrivateRequest::Key);
            let nonce = if authenticated {
                let Ok(nonce) = crate::protocol::secure_server_nonce() else {
                    unsafe { DisconnectNamedPipe(raw); } continue;
                };
                if !write_all_pipe(raw, &state_challenge(&nonce), &stopped, Duration::from_secs(3)) {
                    unsafe { DisconnectNamedPipe(raw); } continue;
                }
                Some(nonce)
            } else { None };
            let mut proof = [0u8; 32];
            if authenticated && !read_exact_pipe(raw, &mut proof, &stopped, Duration::from_secs(3)) {
                unsafe { DisconnectNamedPipe(raw); } continue;
            }
            let mut payload = if let PrivateRequest::Put(len) = kind {
                let mut bytes = vec![0u8; len];
                if !read_exact_pipe(raw, &mut bytes, &stopped, Duration::from_secs(10)) {
                    bytes.fill(0);
                    unsafe { DisconnectNamedPipe(raw); } continue;
                }
                bytes
            } else { Vec::new() };
            if let Some(nonce) = &nonce {
                let valid = state_mac(token.as_bytes(), CLIENT_CONTEXT, nonce, &request, &payload)
                    .verify_slice(&proof).is_ok();
                proof.fill(0);
                if !valid {
                    payload.fill(0);
                    unsafe { DisconnectNamedPipe(raw); } continue;
                }
            }
            let mut bytes = match nonce {
                Some(nonce) => state_reply(&key, &output, kind, payload, token.as_bytes(), &nonce, &request),
                None => reply(&key, &output, kind, payload),
            };
            let delivered = write_all_pipe(raw, &bytes, &stopped, Duration::from_secs(10));
            bytes.fill(0);
            if delivered {
                let mut ack = [0u8; 4];
                let _ = read_exact_pipe(raw, &mut ack, &stopped, Duration::from_secs(1));
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
    fn private_startup_requires_fresh_session_hmac_before_disclosing_or_storing() {
        use std::io::Cursor;
        let sink = crate::protocol::OutputSink::new_with_capabilities("test", &[]);
        let key = Key { bytes: [42; 32] };
        let token = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let mut request = [0u8; 37];
        request[..4].copy_from_slice(b"RCSG");
        assert!(matches!(request_kind(&request), Some(PrivateRequest::Get)));
        let nonce_a = [5u8; 32];
        let nonce_b = [6u8; 32];
        let signed = state_mac(token, CLIENT_CONTEXT, &nonce_a, &request, &[])
            .finalize().into_bytes().to_vec();
        assert!(read_state_proof(&mut Cursor::new(signed.as_slice()),
            PrivateRequest::Get, &request, &nonce_a, token).unwrap().is_some());
        assert!(read_state_proof(&mut Cursor::new(signed.as_slice()),
            PrivateRequest::Get, &request, &nonce_b, token).unwrap().is_none(),
            "a replayed proof cannot authorize a fresh request");
        assert!(read_state_proof(&mut Cursor::new(signed.as_slice()),
            PrivateRequest::Get, &request, &nonce_a, b"different-token").unwrap().is_none());
        let mut put = request;
        put[..4].copy_from_slice(b"RCSP");
        put[4..8].copy_from_slice(&4u32.to_le_bytes());
        assert!(matches!(request_kind(&put), Some(PrivateRequest::Put(4))));
        let put_proof = state_mac(token, CLIENT_CONTEXT, &nonce_a, &put, b"test")
            .finalize().into_bytes();
        let mut put_frame = put_proof.to_vec();
        put_frame.extend_from_slice(b"test");
        assert!(read_state_proof(&mut Cursor::new(put_frame.as_slice()),
            PrivateRequest::Put(4), &put, &nonce_a, token).unwrap().is_some());
        *put_frame.last_mut().unwrap() = b'X';
        assert!(read_state_proof(&mut Cursor::new(put_frame.as_slice()),
            PrivateRequest::Put(4), &put, &nonce_a, token).unwrap().is_none(),
            "a modified payload invalidates the request");
        let response = state_reply(&key, &sink, PrivateRequest::Put(4),
            b"test".to_vec(), token, &nonce_a, &put);
        assert_eq!(response[12], 0);
        assert!(state_mac(token, SERVER_CONTEXT, &nonce_a, &put, &response[..13])
            .verify_slice(&response[13..]).is_ok());
        assert!(state_mac(token, SERVER_CONTEXT, &nonce_b, &put, &response[..13])
            .verify_slice(&response[13..]).is_err());
        let get = state_reply(&key, &sink, PrivateRequest::Get, Vec::new(), token, &nonce_b, &request);
        assert_eq!(&get[12..16], b"test");
        assert!(state_mac(token, SERVER_CONTEXT, &nonce_b, &request, &get[..16])
            .verify_slice(&get[16..]).is_ok());
        assert_eq!(reply(&key, &sink, PrivateRequest::Key, vec![])[9..], [42; 32]);
        put[4..8].copy_from_slice(&((MAX_STATE + 1) as u32).to_le_bytes());
        assert!(request_kind(&put).is_none());
        put[..4].copy_from_slice(b"RCK1");
        assert!(request_kind(&put).is_none());
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
        let broker = start(&id, crate::protocol::OutputSink::new_with_capabilities("test", &[]), "a".repeat(64)).unwrap();
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
        let other = start(&other_id, crate::protocol::OutputSink::new_with_capabilities("test", &[]), "b".repeat(64)).unwrap();
        assert_ne!(&first[9..], &read(&other.endpoint)[9..]);
        // A client which sends no request cannot hold the broker indefinitely.
        let _stalled = UnixStream::connect(&broker.endpoint).unwrap();
        assert_eq!(first, read(&broker.endpoint));
        let endpoint = broker.endpoint.clone();
        drop(broker);
        assert!(!endpoint.exists());
    }
}
