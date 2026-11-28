//! A session-lifetime key, disclosed only through an OS-protected local endpoint.
//! The endpoint name is public; no authentication credential or key is written to disk.
use std::io;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub(crate) struct Key { pub(crate) bytes: [u8; 32] }
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

pub(crate) fn valid_session_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) { b == b'-' }
        else { b.is_ascii_digit() || (b'a'..=b'f').contains(&b) }
    })
}

fn valid_request(request: &[u8; 37]) -> bool {
    &request[..4] == b"RCK1" && request[4..].iter().all(|value| *value == 0)
}

fn reply(key: &Key) -> [u8; 41] {
    let mut response = [0; 41];
    response[..4].copy_from_slice(b"RCK1");
    response[4..8].copy_from_slice(&std::process::id().to_le_bytes());
    response[9..].copy_from_slice(&key.bytes);
    response
}

pub(crate) fn start(id: &str) -> io::Result<Broker> {
    if !valid_session_id(id) { return Err(io::Error::other("invalid registry key session identifier")); }
    let key = Key { bytes: crate::protocol::secure_server_nonce()? };
    platform_start(id, key)
}

#[cfg(target_os = "macos")]
fn account_key_base() -> io::Result<std::path::PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let size = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, std::ptr::null_mut(), 0) };
    if size == 0 { return Err(io::Error::last_os_error()); }
    let mut bytes = vec![0u8; size];
    let written = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, bytes.as_mut_ptr().cast(), size) };
    if written == 0 || written > size { return Err(io::Error::other("per-user temporary directory unavailable")); }
    Ok(std::path::PathBuf::from(std::ffi::OsStr::from_bytes(&bytes[..written - 1])))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn account_key_base() -> io::Result<std::path::PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    let mut capacity = 1024;
    loop {
        let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut bytes = vec![0u8; capacity];
        let mut found = std::ptr::null_mut();
        let error = unsafe { libc::getpwuid_r(libc::geteuid(), entry.as_mut_ptr(),
            bytes.as_mut_ptr().cast(), bytes.len(), &mut found) };
        if error == libc::ERANGE && capacity < 1024 * 1024 { capacity *= 2; continue; }
        if error != 0 { return Err(io::Error::from_raw_os_error(error)); }
        if found.is_null() { return Err(io::Error::other("current account has no home directory")); }
        let entry = unsafe { entry.assume_init() };
        if entry.pw_dir.is_null() { return Err(io::Error::other("current account has no home directory")); }
        let home = unsafe { CStr::from_ptr(entry.pw_dir) };
        return Ok(std::path::PathBuf::from(std::ffi::OsStr::from_bytes(home.to_bytes())));
    }
}

#[cfg(unix)]
fn private_directory(home: &std::path::Path) -> io::Result<std::path::PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let uid = unsafe { libc::geteuid() };
    let home = std::fs::canonicalize(home)?;
    for directory in home.ancestors() {
        let stat = std::fs::symlink_metadata(directory)?;
        let owner = if directory == home { stat.uid() == uid } else { stat.uid() == uid || stat.uid() == 0 };
        let protected = stat.mode() & 0o022 == 0 ||
            (directory != home && stat.uid() == 0 && stat.mode() & 0o1000 != 0);
        if !stat.is_dir() || !owner || !protected {
            return Err(io::Error::other("session key home is not protected from other users"));
        }
    }
    let directory = home.join(".r-console");
    match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {},
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
        Err(error) => return Err(error),
    }
    let metadata = std::fs::symlink_metadata(&directory)?;
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err(io::Error::other("registry key directory is not private to this user"));
    }
    Ok(directory)
}

#[cfg(unix)]
fn platform_start(id: &str, key: Key) -> io::Result<Broker> {
    use std::io::{Read, Write};
    use std::time::Instant;
    use std::os::unix::{fs::PermissionsExt, net::UnixListener};
    let directory = private_directory(&account_key_base()?)?;
    let endpoint = directory.join(id.replace('-', ""));
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
                    if !valid_request(&request) { continue; }
                    if stream.set_nonblocking(false).is_err() { continue; }
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                    let mut response = reply(&key);
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
fn platform_start(id: &str, key: Key) -> io::Result<Broker> {
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
            if count != request.len() || !valid_request(&request) {
                unsafe { DisconnectNamedPipe(raw); } continue;
            }
            let mut bytes = reply(&key);
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
    fn only_key_requests_are_accepted() {
        let mut request = [0; 37];
        request[..4].copy_from_slice(b"RCK1");
        assert!(valid_request(&request));
        request[4] = 1;
        assert!(!valid_request(&request));
        for magic in [b"RCG2", b"RCP2", b"RCG1", b"RCP1"] {
            let mut request = [0; 37];
            request[..4].copy_from_slice(magic);
            assert!(!valid_request(&request));
        }
        let response = reply(&Key { bytes: [42; 32] });
        assert_eq!(&response[..4], b"RCK1");
        assert_eq!(&response[9..], &[42; 32]);
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
    fn key_directory_requires_a_protected_account_location() {
        use std::os::unix::fs::PermissionsExt;
        let nonce = crate::protocol::secure_server_nonce().unwrap();
        let name: String = nonce[..16].iter().map(|b| format!("{b:02x}")).collect();
        let home = std::env::temp_dir().join(format!("key-home-{name}"));
        std::fs::create_dir(&home).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let directory = private_directory(&home).unwrap();
        assert_eq!(directory.parent().unwrap(), std::fs::canonicalize(&home).unwrap());
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(private_directory(&home).is_err());
        assert_eq!(std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777, 0o755);
        std::fs::remove_dir(&directory).unwrap();
        std::os::unix::fs::symlink(&home, &directory).unwrap();
        assert!(private_directory(&home).is_err());
        std::fs::remove_file(&directory).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(private_directory(&home).is_err());
        assert!(!directory.exists());
        std::fs::remove_dir(home).unwrap();
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
