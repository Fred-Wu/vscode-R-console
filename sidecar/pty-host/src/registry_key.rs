//! A session-lifetime key, disclosed only through an OS-protected local endpoint.
//! The endpoint name is public; no authentication credential or key is written to disk.
use std::io;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::thread::{self, JoinHandle};
use std::time::Duration;

struct Key { bytes: [u8; 32], migration: Option<[u8; 32]>, encrypted: bool }
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

fn reply(key: &mut Key, request: &[u8; 37]) -> Option<[u8; 41]> {
    if &request[..4] != b"RCK1" || request[4] > 1 { return None; }
    let mut bytes = [0; 41];
    bytes[..4].copy_from_slice(b"RCK1");
    bytes[4..8].copy_from_slice(&std::process::id().to_le_bytes());
    if request[4] == 1 {
        let digest: [u8; 32] = request[5..].try_into().ok()?;
        if key.encrypted || key.migration.is_some_and(|previous| previous != digest) {
            bytes[8] = 1;
            return Some(bytes);
        }
        key.migration = Some(digest);
    } else {
        key.encrypted = true;
        key.migration = None;
    }
    bytes[9..].copy_from_slice(&key.bytes);
    Some(bytes)
}

pub(crate) fn start(id: &str) -> io::Result<Broker> {
    if !valid_session_id(id) { return Err(io::Error::other("invalid registry key session identifier")); }
    let key = Key { bytes: crate::protocol::secure_server_nonce()?, migration: None, encrypted: false };
    platform_start(id, key)
}

#[cfg(unix)]
fn platform_start(id: &str, mut key: Key) -> io::Result<Broker> {
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
                    if let Some(mut bytes) = reply(&mut key, &request) {
                        let _ = stream.write_all(&bytes);
                        bytes.fill(0);
                    }
                },
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(10)),
                Err(_) => break,
            }
        }
    });
    Ok(Broker { stop, thread: Some(thread), endpoint })
}

#[cfg(windows)]
fn platform_start(id: &str, mut key: Key) -> io::Result<Broker> {
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
        1, 128, 128, 0, &attributes) };
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
            let response = if count == request.len() { reply(&mut key, &request) } else { None };
            let Some(mut bytes) = response else { unsafe { DisconnectNamedPipe(raw); } continue; };
            let mut written = 0;
            let sent = unsafe { WriteFile(raw, bytes.as_ptr(), bytes.len() as u32, &mut written, null_mut()) } != 0;
            bytes.fill(0);
            // Disconnecting a Windows pipe discards unread bytes. A bounded
            // acknowledgement preserves delivery without blocking on a client.
            if sent && written == 41 {
                let deadline = Instant::now() + Duration::from_millis(500);
                let mut ack = [0u8; 4];
                let mut count = 0;
                while count < ack.len() && Instant::now() < deadline && !stopped.load(Ordering::SeqCst) {
                    let mut read = 0;
                    unsafe { ReadFile(raw, ack[count..].as_mut_ptr(), (ack.len() - count) as u32, &mut read, null_mut()); }
                    count += read as usize;
                    if count < ack.len() { thread::sleep(Duration::from_millis(10)); }
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
    fn migration_is_pinned_until_encryption_and_cannot_be_reopened() {
        let mut key = Key { bytes: [42; 32], migration: None, encrypted: false };
        let mut request = [0; 37];
        request[..4].copy_from_slice(b"RCK1");
        request[4] = 1;
        request[5..].fill(7);
        let accepted = reply(&mut key, &request).unwrap();
        assert_eq!(accepted[8], 0);
        assert_eq!(&accepted[9..], &[42; 32]);
        assert_eq!(reply(&mut key, &request).unwrap(), accepted);
        request[5] = 9;
        let rejected = reply(&mut key, &request).unwrap();
        assert_eq!(rejected[8], 1);
        assert_eq!(&rejected[9..], &[0; 32]);
        request[4] = 0;
        assert_eq!(reply(&mut key, &request).unwrap()[8], 0);
        request[4] = 1;
        request[5] = 7;
        assert_eq!(reply(&mut key, &request).unwrap()[8], 1);
        request[4] = 2;
        assert!(reply(&mut key, &request).is_none());
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
        let broker = start(&id).unwrap();
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
        let other = start(&other_id).unwrap();
        assert_ne!(&first[9..], &read(&other.endpoint)[9..]);
        // A client which sends no request cannot hold the broker indefinitely.
        let _stalled = UnixStream::connect(&broker.endpoint).unwrap();
        assert_eq!(first, read(&broker.endpoint));
        let endpoint = broker.endpoint.clone();
        drop(broker);
        assert!(!endpoint.exists());
    }
}
