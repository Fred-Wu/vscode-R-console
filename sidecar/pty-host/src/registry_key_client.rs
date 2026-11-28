//! Authenticate the connected Windows pipe using kernel process and token data.
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, ERROR_NO_DATA,
        GENERIC_READ, GENERIC_WRITE},
    Security::{EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER},
    Storage::FileSystem::{CreateFileW, ReadFile, WriteFile, OPEN_EXISTING,
        SECURITY_SQOS_PRESENT, SECURITY_IDENTIFICATION},
    System::{
        Pipes::{GetNamedPipeServerProcessId, SetNamedPipeHandleState, PIPE_READMODE_BYTE, PIPE_NOWAIT},
        Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION},
    },
};

fn token_user(process: HANDLE) -> io::Result<Vec<usize>> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut bytes = 0;
    unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut bytes); }
    if bytes == 0 { return Err(io::Error::last_os_error()); }
    let mut buffer = vec![0usize; (bytes as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser,
        buffer.as_mut_ptr().cast(), bytes, &mut bytes) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(buffer)
}

fn verify_server(pipe: HANDLE, expected_pid: u32) -> io::Result<OwnedHandle> {
    let mut actual_pid = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe, &mut actual_pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if actual_pid != expected_pid || actual_pid == 0 {
        return Err(io::Error::other("session key pipe belongs to a different process"));
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, actual_pid) };
    if process.is_null() { return Err(io::Error::last_os_error()); }
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let server = token_user(process.as_raw_handle())?;
    let client = token_user(unsafe { GetCurrentProcess() })?;
    verify_user(&server, &client)?;
    // Hold the process object while reading the key, preventing PID reuse.
    Ok(process)
}

fn verify_user(server: &[usize], client: &[usize]) -> io::Result<()> {
    let same_user = unsafe {
        EqualSid((*server.as_ptr().cast::<TOKEN_USER>()).User.Sid,
            (*client.as_ptr().cast::<TOKEN_USER>()).User.Sid) != 0
    };
    if !same_user { return Err(io::Error::other("session key pipe belongs to a different user")); }
    Ok(())
}

fn transfer(pipe: HANDLE, bytes: &mut [u8], read: bool, deadline: Instant) -> io::Result<()> {
    let mut count = 0;
    while count < bytes.len() {
        if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "session key transfer timed out")); }
        let mut completed = 0;
        let ok = unsafe {
            if read { ReadFile(pipe, bytes[count..].as_mut_ptr(), (bytes.len() - count) as u32, &mut completed, null_mut()) }
            else { WriteFile(pipe, bytes[count..].as_ptr(), (bytes.len() - count) as u32, &mut completed, null_mut()) }
        };
        if ok == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_DATA as i32) { return Err(error); }
        }
        count += completed as usize;
        if completed == 0 { std::thread::sleep(Duration::from_millis(2)); }
    }
    Ok(())
}

pub(crate) fn read(id: &str, pid: u32) -> io::Result<crate::registry_key::Key> {
    if !crate::registry_key::valid_session_id(id) || pid == 0 {
        return Err(io::Error::other("invalid session key identity"));
    }
    let name: Vec<u16> = format!(r"\\.\pipe\r-console-key-{id}").encode_utf16().chain(Some(0)).collect();
    let deadline = Instant::now() + Duration::from_secs(3);
    let pipe = loop {
        // Identification lets the server inspect our identity without impersonating us.
        let raw = unsafe { CreateFileW(name.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, null(), OPEN_EXISTING,
            SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, null_mut()) };
        if raw != INVALID_HANDLE_VALUE { break unsafe { OwnedHandle::from_raw_handle(raw) }; }
        let error = io::Error::last_os_error();
        if Instant::now() >= deadline || ![ERROR_FILE_NOT_FOUND as i32, ERROR_PIPE_BUSY as i32]
            .contains(&error.raw_os_error().unwrap_or(0)) { return Err(error); }
        std::thread::sleep(Duration::from_millis(20));
    };
    let raw = pipe.as_raw_handle();
    let _server = verify_server(raw, pid)?;
    let mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
    if unsafe { SetNamedPipeHandleState(raw, &mode, null(), null()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut request = [0u8; 37];
    request[..4].copy_from_slice(b"RCK1");
    transfer(raw, &mut request, false, deadline)?;
    let mut header = [0u8; 9];
    transfer(raw, &mut header, true, deadline)?;
    if &header[..4] != b"RCK1" || u32::from_le_bytes(header[4..8].try_into().unwrap()) != pid || header[8] != 0 {
        return Err(io::Error::other("invalid session key response"));
    }
    let mut key = crate::registry_key::Key { bytes: [0; 32] };
    transfer(raw, &mut key.bytes, true, deadline)?;
    let mut ack = *b"RCK1";
    transfer(raw, &mut ack, false, deadline)?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_different_sid_is_rejected_even_when_the_pid_matches() {
        use windows_sys::Win32::Security::{CreateWellKnownSid, WinWorldSid, SECURITY_MAX_SID_SIZE};
        let current = token_user(unsafe { GetCurrentProcess() }).unwrap();
        verify_user(&current, &current).unwrap();
        let mut sid = vec![0usize; (SECURITY_MAX_SID_SIZE as usize).div_ceil(std::mem::size_of::<usize>())];
        let mut size = SECURITY_MAX_SID_SIZE;
        assert_ne!(unsafe { CreateWellKnownSid(WinWorldSid, null_mut(), sid.as_mut_ptr().cast(), &mut size) }, 0);
        let mut other = vec![0usize; std::mem::size_of::<TOKEN_USER>().div_ceil(std::mem::size_of::<usize>())];
        unsafe { (*other.as_mut_ptr().cast::<TOKEN_USER>()).User.Sid = sid.as_mut_ptr().cast(); }
        assert!(verify_user(&other, &current).is_err());
    }

    #[test]
    fn verifies_real_broker_and_rejects_a_forged_process_identity() {
        let bytes = crate::protocol::secure_server_nonce().unwrap();
        let hex: String = bytes[..16].iter().map(|b| format!("{b:02x}")).collect();
        let id = format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]);
        let _broker = crate::registry_key::start(&id).unwrap();
        assert!(read(&id, std::process::id().wrapping_add(1)).is_err());
        let key = read(&id, std::process::id()).unwrap();
        assert_eq!(key.bytes, read(&id, std::process::id()).unwrap().bytes);
    }
}
