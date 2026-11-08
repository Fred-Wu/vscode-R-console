use std::ffi::c_void;
use std::io;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::ptr::null_mut;
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0); }
    }
}

/// Restrict the console-owned pipe before its endpoint is published to R.
/// Windows shares the descriptor across all instances of the same named pipe.
pub(crate) fn secure_session_pipe(name: &str) -> io::Result<()> {
    let suffix = name.strip_prefix(r"\\.\pipe\vscode-r-console-")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not an R Console pipe"))?;
    if suffix.len() != 12 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid R Console pipe name"));
    }
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let _token = OwnedHandle::from_raw_handle(token);
        let mut bytes = 0;
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut bytes);
        if bytes == 0 { return Err(io::Error::last_os_error()); }
        // TOKEN_USER contains pointers and must be suitably aligned.
        let mut buffer = vec![0usize; (bytes as usize).div_ceil(std::mem::size_of::<usize>())];
        if GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), bytes, &mut bytes) == 0 {
            return Err(io::Error::last_os_error());
        }
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let mut sid_text = null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid_text) == 0 {
            return Err(io::Error::last_os_error());
        }
        let _sid_text = LocalAllocation(sid_text.cast());
        let mut len = 0;
        while *sid_text.add(len) != 0 { len += 1; }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_text, len));
        // Deny network logons even for the same account. Grant local access
        // only to this user, including the rights Node needs for new instances.
        let sddl: Vec<u16> = format!("D:P(D;;GA;;;NU)(A;;GA;;;{sid})\0").encode_utf16().collect();
        let mut descriptor = null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut(),
        ) == 0 {
            return Err(io::Error::last_os_error());
        }
        let _descriptor = LocalAllocation(descriptor);
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        if SetFileSecurityW(name.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, descriptor) == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}
