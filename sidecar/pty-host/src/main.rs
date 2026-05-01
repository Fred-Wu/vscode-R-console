mod host;
mod protocol;

fn main() {
    #[cfg(windows)]
    if let Err(error) = windows_launch_or_run_real_host() {
        eprintln!("R_CONSOLE_HOST error: {error}");
        std::process::exit(1);
    }

    #[cfg(windows)]
    return;

    #[cfg(not(windows))]
    run_host(std::env::args().skip(1).collect());
}

fn run_host(args: Vec<String>) {
    if let Err(error) = host::run(args) {
        eprintln!("R_CONSOLE_HOST error: {error}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
fn windows_launch_or_run_real_host() -> Result<(), Box<dyn std::error::Error>> {
    const REAL_HOST_ENV: &str = "VSC_R_CONSOLE_REAL_HOST";

    let args: Vec<String> = std::env::args().skip(1).collect();
    if std::env::var_os(REAL_HOST_ENV).is_some() {
        unsafe {
            // The real sidecar owns the embedded R session and TCP server. It
            // must not remain attached to VS Code's console-control group.
            let _ = windows_sys::Win32::System::Console::FreeConsole();
        }
        run_host(args);
        return Ok(());
    }

    use windows_sys::Win32::System::Threading::{
        CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS,
    };

    let exe = std::env::current_exe()?;
    let base_flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
    let breakaway_flags = base_flags | CREATE_BREAKAWAY_FROM_JOB;

    let mut child = spawn_windows_real_host(&exe, &args, REAL_HOST_ENV, breakaway_flags)
        .or_else(|_| spawn_windows_real_host(&exe, &args, REAL_HOST_ENV, base_flags))?;
    wait_for_windows_real_host_bootstrap(&mut child)?;
    Ok(())
}

#[cfg(windows)]
fn spawn_windows_real_host(
    exe: &std::path::Path,
    args: &[String],
    real_host_env: &str,
    creation_flags: u32,
) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut command = Command::new(exe);
    command
        .args(args)
        .env(real_host_env, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(creation_flags);
    command.spawn()
}

#[cfg(windows)]
fn wait_for_windows_real_host_bootstrap(
    child: &mut std::process::Child,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::fs;
    use std::thread;
    use std::time::{Duration, Instant};

    let session_file = std::env::var("VSC_R_BACKEND_SESSION_FILE")?;
    let initial_connect_grace_ms = std::env::var("VSC_R_BACKEND_INITIAL_CONNECT_GRACE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(60_000);
    let deadline = Instant::now() + Duration::from_millis(initial_connect_grace_ms);

    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Err(format!("real R console host exited before bootstrap: {status}").into());
        }

        if let Ok(payload) = fs::read_to_string(&session_file) {
            if payload.contains("\"port\":") && payload.contains("\"pid\":") {
                return Ok(());
            }
        }

        thread::sleep(Duration::from_millis(25));
    }

    Err(format!("timed out waiting for real R console host bootstrap at {session_file}").into())
}
