//! The OS owns lock lifetime, including abrupt extension-host/helper exit.
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;

fn acquire(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() { return Err(io::Error::other("registry lock is not a regular file")); }
    file.try_lock().map_err(io::Error::other)?;
    Ok(file)
}

pub(crate) fn hold(path: &Path) -> io::Result<()> {
    let _lock = acquire(path)?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(b"locked\n")?;
    stdout.flush()?;
    // The parent closes this pipe after its synchronous verification/write.
    // Parent termination also closes it, allowing the OS to release the lock.
    let mut byte = [0u8];
    io::stdin().read(&mut byte)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exclusive_lock_is_released_with_its_handle() {
        let name: String = crate::protocol::secure_server_nonce().unwrap()[..16]
            .iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("r-console-registry-{name}.lock"));
        let first = acquire(&path).unwrap();
        assert!(acquire(&path).is_err());
        drop(first);
        drop(acquire(&path).unwrap());
        std::fs::remove_file(path).unwrap();
    }
}
