#[cfg(all(not(unix), not(windows)))]
use std::error::Error;

#[cfg(all(not(unix), not(windows)))]
pub(crate) fn run(_args: Vec<String>) -> Result<(), Box<dyn Error>> {
    Err("Embedded R host is not implemented for this platform yet".into())
}

#[cfg(unix)]
mod unix_host {
    use crate::protocol::{
        read_next_command, DialogRequest, DialogResult, IncomingCommand, OutputSink, OutputStream,
        PromptKind, SessionWaitState,
    };
    use libloading::os::unix::{Library, Symbol};
    use std::collections::VecDeque;
    use std::error::Error;
    use std::ffi::{c_char, c_int, c_uchar, c_void, CStr, CString};
    use std::fs;
    use std::io;
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
    use std::thread;
    use std::time::{Duration, Instant};

    const CONT_PROMPT: &str = "+ ";
    const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(50);
    const SESSION_ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(100);
    const MAX_ACTIVITY_HANDLER_DRAIN: usize = 64;

    const SUPPORTED_CAPABILITIES: &[&str] = &[
        "control-channel",
        "shutdown",
        "session-control",
        "top-level-submit",
        "nested-input",
        "parse-status",
        "set-width",
    ];

    const PARSE_STATUS_NULL: c_int = 0;
    const PARSE_STATUS_OK: c_int = 1;
    const PARSE_STATUS_INCOMPLETE: c_int = 2;
    const PARSE_STATUS_ERROR: c_int = 3;

    const R_PARSE_OK: c_int = 1;
    const R_PARSE_INCOMPLETE: c_int = 2;
    const R_PARSE_ERROR: c_int = 3;
    const R_PARSE_EOF: c_int = 4;

    type RfInitializeR = unsafe extern "C" fn(c_int, *mut *mut c_char) -> c_int;
    type SetupRMainloop = unsafe extern "C" fn();
    type RunRMainloop = unsafe extern "C" fn();
    type ReadConsoleFn =
        unsafe extern "C-unwind" fn(*const c_char, *mut c_uchar, c_int, c_int) -> c_int;
    type WriteConsoleFn = unsafe extern "C" fn(*const c_char, c_int);
    type WriteConsoleExFn = unsafe extern "C" fn(*const c_char, c_int, c_int);
    type ShowMessageFn = unsafe extern "C" fn(*const c_char);
    type BusyFn = unsafe extern "C" fn(c_int);
    type SuicideFn = unsafe extern "C" fn(*const c_char);
    type ChooseFileFn = unsafe extern "C" fn(c_int, *mut c_char, c_int) -> c_int;
    type EditFileFn = unsafe extern "C" fn(*const c_char) -> c_int;
    type EditFilesFn = unsafe extern "C" fn(
        c_int,
        *const *const c_char,
        *const *const c_char,
        *const c_char,
    ) -> c_int;
    type EventCallbackFn = unsafe extern "C-unwind" fn();
    type ExpandFileNameFn = unsafe extern "C" fn(*const c_char) -> *const c_char;
    type CheckUserInterruptFn = unsafe extern "C" fn();
    type ProcessEventsFn = unsafe extern "C" fn();
    type RunPendingFinalizersFn = unsafe extern "C" fn();
    type CheckActivityFn = unsafe extern "C" fn(c_int, c_int) -> *mut libc::fd_set;
    type RunHandlersFn = unsafe extern "C" fn(*mut c_void, *mut libc::fd_set);
    type Sexp = *mut c_void;
    type MkStringFn = unsafe extern "C" fn(*const c_char) -> Sexp;
    type InstallFn = unsafe extern "C" fn(*const c_char) -> Sexp;
    type FindVarInFrameFn = unsafe extern "C" fn(Sexp, Sexp) -> Sexp;
    type ScalarIntegerFn = unsafe extern "C" fn(c_int) -> Sexp;
    type ProtectFn = unsafe extern "C" fn(Sexp) -> Sexp;
    type UnprotectFn = unsafe extern "C" fn(c_int);
    type ParseVectorFn = unsafe extern "C" fn(Sexp, c_int, *mut c_int, Sexp) -> Sexp;
    type TopLevelExecFn =
        unsafe extern "C" fn(unsafe extern "C" fn(*mut c_void), *mut c_void) -> c_int;
    type TagFn = unsafe extern "C" fn(Sexp) -> Sexp;
    type CdrFn = unsafe extern "C" fn(Sexp) -> Sexp;
    type SetcarFn = unsafe extern "C" fn(Sexp, Sexp) -> Sexp;

    struct RApi {
        _library: Library,
        rf_initialize_r: RfInitializeR,
        setup_rmainloop: SetupRMainloop,
        run_rmainloop: RunRMainloop,
        r_expand_file_name: ExpandFileNameFn,
        ptr_r_write_console: Option<*mut Option<WriteConsoleFn>>,
        ptr_r_write_console_ex: *mut Option<WriteConsoleExFn>,
        ptr_r_read_console: *mut Option<ReadConsoleFn>,
        ptr_r_show_message: Option<*mut Option<ShowMessageFn>>,
        ptr_r_busy: Option<*mut Option<BusyFn>>,
        ptr_r_suicide: Option<*mut Option<SuicideFn>>,
        ptr_r_choose_file: Option<*mut Option<ChooseFileFn>>,
        ptr_r_edit_file: Option<*mut Option<EditFileFn>>,
        ptr_r_edit_files: Option<*mut Option<EditFilesFn>>,
        ptr_r_process_events: Option<*mut Option<EventCallbackFn>>,
        r_polled_events: Option<*mut Option<EventCallbackFn>>,
        r_outputfile: Option<*mut *mut c_void>,
        r_consolefile: Option<*mut *mut c_void>,
        r_interactive: Option<*mut c_int>,
        r_signal_handlers: Option<*mut c_int>,
        r_running_as_main_program: Option<*mut c_int>,
        r_interrupts_pending: Option<*mut c_int>,
        r_check_user_interrupt: Option<CheckUserInterruptFn>,
        r_process_events: Option<ProcessEventsFn>,
        r_run_pending_finalizers: Option<RunPendingFinalizersFn>,
        r_check_activity: CheckActivityFn,
        r_run_handlers: RunHandlersFn,
        r_input_handlers: *mut *mut c_void,
        rf_mk_string: MkStringFn,
        rf_install: InstallFn,
        rf_find_var_in_frame: FindVarInFrameFn,
        rf_scalar_integer: ScalarIntegerFn,
        rf_protect: ProtectFn,
        rf_unprotect: UnprotectFn,
        r_parse_vector: ParseVectorFn,
        r_toplevel_exec: TopLevelExecFn,
        tag: TagFn,
        cdr: CdrFn,
        setcar: SetcarFn,
        r_base_env_ptr: *mut Sexp,
        r_nil_value_ptr: *mut Sexp,
    }

    struct HostRuntime {
        output: OutputSink,
        state: Mutex<SharedState>,
        cv: Condvar,
    }

    #[derive(Default)]
    struct SharedState {
        pending_commands: VecDeque<PendingCommand>,
        active_submission_lines: VecDeque<Vec<u8>>,
        pending_fragment: Option<Vec<u8>>,
        pending_fragment_from_nested: bool,
        pending_dialog_result: Option<DialogResult>,
        pending_width: Option<u16>,
        current_width: Option<u16>,
        startup_input_pending: bool,
        busy: bool,
        interrupt_requested: bool,
        suppress_idle_event_pump: bool,
        top_level_recovery_pending: Option<TopLevelRecovery>,
        top_level_recovery_active: bool,
        shutdown_requested: bool,
        wait_state: Option<StoredWaitState>,
    }

    #[derive(Clone, Copy)]
    enum TopLevelRecovery {
        ParseNull,
        RecoverFromInterrupt,
    }

    #[derive(Clone)]
    enum StoredWaitState {
        TopLevel(PromptKind),
        Nested(String),
    }

    enum PendingCommand {
        Submit(VecDeque<Vec<u8>>),
        Reply(Vec<u8>),
        ParseStatus { request_id: u32, code: String },
    }

    enum WaitKind {
        TopLevel(PromptKind),
        Nested(String),
    }

    struct PendingLine {
        bytes: Vec<u8>,
        signal_input_end: bool,
    }

    static HOST_RUNTIME: OnceLock<HostRuntime> = OnceLock::new();
    static PARSE_API: OnceLock<ParseApi> = OnceLock::new();
    static EVENT_LOOP_API: OnceLock<EventLoopApi> = OnceLock::new();
    static R_INTERRUPTS_PENDING_PTR: AtomicUsize = AtomicUsize::new(0);
    static R_CHECK_USER_INTERRUPT: AtomicUsize = AtomicUsize::new(0);
    static READ_CONSOLE_INTERRUPTED: AtomicBool = AtomicBool::new(false);
    static R_EXPAND_FILE_NAME: AtomicUsize = AtomicUsize::new(0);

    #[derive(Clone, Copy)]
    struct ParseApi {
        rf_mk_string: MkStringFn,
        rf_install: InstallFn,
        rf_find_var_in_frame: FindVarInFrameFn,
        rf_scalar_integer: ScalarIntegerFn,
        rf_protect: ProtectFn,
        rf_unprotect: UnprotectFn,
        r_parse_vector: ParseVectorFn,
        r_toplevel_exec: TopLevelExecFn,
        tag: TagFn,
        cdr: CdrFn,
        setcar: SetcarFn,
        r_base_env: usize,
        r_nil_value: usize,
    }

    #[derive(Clone, Copy)]
    struct EventLoopApi {
        r_process_events: Option<ProcessEventsFn>,
        r_run_pending_finalizers: Option<RunPendingFinalizersFn>,
        r_check_activity: CheckActivityFn,
        r_run_handlers: RunHandlersFn,
        r_toplevel_exec: TopLevelExecFn,
        r_input_handlers: usize,
    }

    struct ParseStatusContext {
        api: ParseApi,
        code: CString,
        status: c_int,
    }

    struct ApplyWidthContext {
        api: ParseApi,
        width: c_int,
        success: bool,
    }

    const STARTUP_INTERRUPT_HANDLER_INPUT: &str = r#"base::local({ if (base::getRversion() >= "4.0.0") { handler <- function(e) { restart <- base::findRestart("abort"); if (!base::is.null(restart)) base::invokeRestart(restart) }; handlers <- base::globalCallingHandlers(); base::globalCallingHandlers(NULL); handlers <- c(handlers, list(interrupt = handler)); base::do.call(base::globalCallingHandlers, handlers) }; base::invisible(NULL) }, envir = base::new.env(parent = base::baseenv()))"#;

    struct PumpEventsContext {
        api: EventLoopApi,
    }

    pub(crate) fn run(args: Vec<String>) -> Result<(), Box<dyn Error>> {
        if args.is_empty() {
            return Err("missing R executable path".into());
        }

        let r_executable = PathBuf::from(&args[0]);
        let r_args = &args[1..];
        let library_path = resolve_r_library_path(&r_executable)?;
        let api = unsafe { RApi::load(&library_path)? };

        let output = OutputSink::new_with_capabilities("embedded-r-host", SUPPORTED_CAPABILITIES);
        let session_transport = session_transport_config().is_some();
        if let Err(error) = output.capture_process_stdout() {
            let _ =
                output.emit_host_error(&format!("backend stdout capture setup failed: {error}"));
        }
        if !session_transport {
            output.emit_backend_ready()?;
        }

        HOST_RUNTIME
            .set(HostRuntime {
                output: output.clone_handle(),
                state: Mutex::new(SharedState {
                    startup_input_pending: true,
                    ..SharedState::default()
                }),
                cv: Condvar::new(),
            })
            .map_err(|_| "host runtime already initialized")?;
        start_command_reader();

        unsafe {
            api.initialize(&r_executable, r_args)?;
        }
        PARSE_API
            .set(api.parse_api())
            .map_err(|_| "parse api already initialized")?;
        EVENT_LOOP_API
            .set(api.event_loop_api())
            .map_err(|_| "event loop api already initialized")?;

        if let Some(width) = initial_console_width_from_env() {
            if let Err(error) = apply_console_width(width) {
                emit_host_error(&format!(
                    "failed to apply initial console width {width}: {error}"
                ));
            } else if let Some(runtime) = host_runtime() {
                let mut state = runtime.state.lock().expect("host state lock poisoned");
                state.current_width = Some(width);
            }
        }

        if !session_transport {
            output.emit_host_connected()?;
            output.emit_session_state(std::process::id(), false, SessionWaitState::None)?;
        }

        unsafe {
            (api.run_rmainloop)();
        }

        Ok(())
    }

    fn start_command_reader() {
        if let Some((session_file, initial_connect_grace, reconnect_grace)) =
            session_transport_config()
        {
            start_session_command_reader(session_file, initial_connect_grace, reconnect_grace);
            return;
        }

        thread::spawn(move || {
            let stdin = io::stdin();
            let mut locked = stdin.lock();
            loop {
                match read_next_command(&mut locked) {
                    Ok(Some(command)) => handle_command(command),
                    Ok(None) => {
                        request_shutdown();
                        break;
                    }
                    Err(error) => {
                        emit_host_error(&format!("backend command read failed: {error}"));
                        request_shutdown();
                        break;
                    }
                }
            }
        });
    }

    fn start_session_command_reader(
        session_file: String,
        initial_connect_grace: Duration,
        reconnect_grace: Option<Duration>,
    ) {
        thread::spawn(move || {
            let listener = match TcpListener::bind(("127.0.0.1", 0)) {
                Ok(listener) => listener,
                Err(error) => {
                    emit_host_error(&format!("backend session server bind failed: {error}"));
                    request_shutdown();
                    return;
                }
            };
            if let Err(error) = listener.set_nonblocking(true) {
                emit_host_error(&format!("backend session server setup failed: {error}"));
                request_shutdown();
                return;
            }

            let port = match listener.local_addr() {
                Ok(addr) => addr.port(),
                Err(error) => {
                    emit_host_error(&format!("backend session server address failed: {error}"));
                    request_shutdown();
                    return;
                }
            };
            if let Err(error) = write_session_bootstrap(&session_file, port, std::process::id()) {
                emit_host_error(&format!("backend session bootstrap write failed: {error}"));
                request_shutdown();
                return;
            }

            let (disconnect_tx, disconnect_rx) = mpsc::channel::<usize>();
            let current_client = Arc::new(AtomicUsize::new(0));
            let client_connected = Arc::new(AtomicBool::new(false));
            let mut next_client_id = 0_usize;
            let mut disconnect_deadline = Some(Instant::now() + initial_connect_grace);

            loop {
                let mut should_break = false;
                while let Ok(client_id) = disconnect_rx.try_recv() {
                    if current_client.load(Ordering::SeqCst) != client_id {
                        continue;
                    }
                    if let Some(runtime) = host_runtime() {
                        runtime.output.detach_client();
                    }
                    client_connected.store(false, Ordering::SeqCst);
                    if is_shutdown_requested() {
                        should_break = true;
                        break;
                    }
                    disconnect_deadline = reconnect_grace.map(|grace| Instant::now() + grace);
                }
                if should_break {
                    break;
                }

                match listener.accept() {
                    Ok((mut stream, _addr)) => {
                        if let Err(error) = stream.set_nonblocking(false) {
                            emit_host_error(&format!(
                                "backend session stream setup failed: {error}"
                            ));
                            request_shutdown();
                            break;
                        }
                        let writer = match stream.try_clone() {
                            Ok(writer) => writer,
                            Err(error) => {
                                emit_host_error(&format!(
                                    "backend session stream clone failed: {error}"
                                ));
                                request_shutdown();
                                break;
                            }
                        };
                        next_client_id = next_client_id.wrapping_add(1).max(1);
                        let client_id = next_client_id;
                        current_client.store(client_id, Ordering::SeqCst);
                        client_connected.store(true, Ordering::SeqCst);
                        disconnect_deadline = None;
                        if let Err(error) = writer.set_nonblocking(false) {
                            emit_host_error(&format!(
                                "backend session writer setup failed: {error}"
                            ));
                            request_shutdown();
                            break;
                        }
                        if let Some(runtime) = host_runtime() {
                            runtime.output.attach_client(writer);
                            emit_attached_client_state(runtime);
                        }

                        let reader_current_client = Arc::clone(&current_client);
                        let reader_disconnect_tx = disconnect_tx.clone();
                        thread::spawn(move || {
                            loop {
                                match read_next_command(&mut stream) {
                                    Ok(Some(command)) => {
                                        if reader_current_client.load(Ordering::SeqCst) != client_id
                                        {
                                            break;
                                        }
                                        handle_command(command);
                                        if is_shutdown_requested() {
                                            break;
                                        }
                                    }
                                    Ok(None) => break,
                                    Err(error) => {
                                        if reader_current_client.load(Ordering::SeqCst) == client_id
                                            && !is_expected_session_disconnect_error(&error)
                                        {
                                            emit_host_error(&format!(
                                                "backend command read failed: {error}"
                                            ));
                                        }
                                        break;
                                    }
                                }
                            }
                            let _ = reader_disconnect_tx.send(client_id);
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        if is_shutdown_requested() {
                            break;
                        }
                        if !client_connected.load(Ordering::SeqCst) {
                            if let Some(deadline) = disconnect_deadline {
                                if Instant::now() >= deadline {
                                    request_shutdown();
                                    break;
                                }
                            }
                        }
                        thread::sleep(SESSION_ACCEPT_POLL_INTERVAL);
                    }
                    Err(error) => {
                        emit_host_error(&format!("backend session accept failed: {error}"));
                        request_shutdown();
                        break;
                    }
                }
            }
            let _ = fs::remove_file(&session_file);
        });
    }

    fn session_transport_config() -> Option<(String, Duration, Option<Duration>)> {
        let session_file = std::env::var("VSC_R_BACKEND_SESSION_FILE").ok()?;
        if session_file.trim().is_empty() {
            return None;
        }
        let initial_connect_grace_ms = std::env::var("VSC_R_BACKEND_INITIAL_CONNECT_GRACE_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(60_000);
        let reconnect_grace = std::env::var("VSC_R_BACKEND_RECONNECT_GRACE_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .and_then(|value| {
                if value == 0 {
                    None
                } else {
                    Some(Duration::from_millis(value))
                }
            });
        Some((
            session_file,
            Duration::from_millis(initial_connect_grace_ms),
            reconnect_grace,
        ))
    }

    fn write_session_bootstrap(session_file: &str, port: u16, pid: u32) -> io::Result<()> {
        let payload = format!("{{\"port\":{port},\"pid\":{pid}}}");
        fs::write(session_file, payload)
    }

    fn emit_attached_client_state(runtime: &HostRuntime) {
        let pid = std::process::id();
        let _ = runtime.output.flush_backlog();
        let _ = runtime.output.emit_backend_ready();
        let _ = runtime.output.emit_host_connected();

        let (busy, wait_state) = {
            let state = runtime.state.lock().expect("host state lock poisoned");
            (state.busy, state.wait_state.clone())
        };
        let wait = match wait_state {
            Some(StoredWaitState::TopLevel(kind)) => SessionWaitState::TopLevel(kind),
            Some(StoredWaitState::Nested(prompt)) => SessionWaitState::Nested(prompt),
            None => SessionWaitState::None,
        };
        let _ = runtime.output.emit_session_state(pid, busy, wait);
        let _ = runtime.output.emit_output_flush();
    }

    fn is_expected_session_disconnect_error(error: &io::Error) -> bool {
        matches!(
            error.kind(),
            io::ErrorKind::ConnectionReset
                | io::ErrorKind::ConnectionAborted
                | io::ErrorKind::BrokenPipe
                | io::ErrorKind::UnexpectedEof
        )
    }

    fn is_shutdown_requested() -> bool {
        host_runtime()
            .map(|runtime| {
                runtime
                    .state
                    .lock()
                    .expect("host state lock poisoned")
                    .shutdown_requested
            })
            .unwrap_or(false)
    }

    fn handle_command(command: IncomingCommand) {
        match command {
            IncomingCommand::Submit(code) => queue_submit(code),
            IncomingCommand::ReplyInput(text) => queue_reply(text),
            IncomingCommand::DialogResult(result) => queue_dialog_result(result),
            IncomingCommand::ParseStatus { request_id, code } => {
                queue_parse_status(request_id, code)
            }
            IncomingCommand::Interrupt => request_interrupt(),
            IncomingCommand::SetWidth { columns } => queue_set_width(columns),
            IncomingCommand::Shutdown => request_shutdown(),
        }
    }

    fn queue_submit(code: String) {
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.suppress_idle_event_pump = false;
            state
                .pending_commands
                .push_back(PendingCommand::Submit(split_submission_lines(&code)));
            runtime.cv.notify_all();
        }
    }

    fn queue_reply(text: String) {
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.suppress_idle_event_pump = false;
            state.pending_commands.push_back(PendingCommand::Reply(
                normalize_reply_text(&text).into_bytes(),
            ));
            runtime.cv.notify_all();
        }
    }

    fn queue_dialog_result(result: DialogResult) {
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.suppress_idle_event_pump = false;
            state.pending_dialog_result = Some(result);
            runtime.cv.notify_all();
        }
    }

    fn queue_parse_status(request_id: u32, code: String) {
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.suppress_idle_event_pump = false;
            state
                .pending_commands
                .push_back(PendingCommand::ParseStatus { request_id, code });
            runtime.cv.notify_all();
        }
    }

    fn queue_set_width(columns: u16) {
        let width = normalize_console_width(columns);
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            if state.current_width == Some(width) || state.pending_width == Some(width) {
                return;
            }
            state.pending_width = Some(width);
            runtime.cv.notify_all();
        }
    }

    fn request_interrupt() {
        let mut should_signal = false;
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.interrupt_requested = true;
            state.top_level_recovery_pending = Some(TopLevelRecovery::RecoverFromInterrupt);
            should_signal = state.busy;
            runtime.cv.notify_all();
        }

        set_r_interrupts_pending(true);
        if should_signal {
            signal_r_interrupt();
        }
    }

    fn request_shutdown() {
        let mut should_interrupt = false;
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.shutdown_requested = true;
            should_interrupt = state.busy;
            runtime.cv.notify_all();
        }

        if should_interrupt {
            set_r_interrupts_pending(true);
        }
    }

    fn preserve_requested_interrupt() -> bool {
        let Some(runtime) = host_runtime() else {
            return false;
        };
        let state = runtime.state.lock().expect("host state lock poisoned");
        if !state.interrupt_requested {
            return false;
        }
        set_r_interrupts_pending(true);
        true
    }

    fn host_runtime() -> Option<&'static HostRuntime> {
        HOST_RUNTIME.get()
    }

    fn event_loop_api() -> Option<EventLoopApi> {
        EVENT_LOOP_API.get().copied()
    }

    fn emit_host_error(message: &str) {
        if let Some(runtime) = host_runtime() {
            let _ = runtime.output.emit_host_error(message);
        }
    }

    fn expand_r_file_name(path: &str) -> String {
        let function = R_EXPAND_FILE_NAME.load(Ordering::Relaxed);
        if function == 0 {
            return path.to_string();
        }
        let Ok(c_path) = CString::new(path) else {
            return path.to_string();
        };
        let function: ExpandFileNameFn = unsafe { std::mem::transmute(function) };
        let expanded = unsafe { function(c_path.as_ptr()) };
        if expanded.is_null() {
            return path.to_string();
        }
        unsafe { CStr::from_ptr(expanded) }
            .to_string_lossy()
            .into_owned()
    }

    fn set_r_interrupts_pending(pending: bool) {
        let ptr = R_INTERRUPTS_PENDING_PTR.load(Ordering::Relaxed) as *mut c_int;
        if ptr.is_null() {
            return;
        }
        unsafe {
            *ptr = if pending { 1 } else { 0 };
        }
    }

    fn trigger_r_user_interrupt() {
        let function = R_CHECK_USER_INTERRUPT.load(Ordering::Relaxed);
        if function == 0 {
            return;
        }

        let function: CheckUserInterruptFn = unsafe { std::mem::transmute(function) };
        unsafe {
            function();
        }
    }

    fn signal_r_interrupt() {
        unsafe {
            libc::kill(libc::getpid(), libc::SIGINT);
        }
    }

    fn normalize_console_width(columns: u16) -> u16 {
        columns.max(20)
    }

    fn initial_console_width_from_env() -> Option<u16> {
        let raw = std::env::var("VSC_R_COLS").ok()?;
        let parsed = raw.parse::<u16>().ok()?;
        Some(normalize_console_width(parsed))
    }

    fn request_choose_file(new_file: bool) -> Option<String> {
        match request_dialog(DialogRequest::ChooseFile { new_file })? {
            DialogResult::ChooseFile { path } => path,
            DialogResult::EditExpression { .. } | DialogResult::EditFiles { .. } => {
                emit_host_error("unexpected edit dialog result while waiting for choose-file");
                None
            }
        }
    }

    fn request_edit_file(path: &str) -> bool {
        match request_dialog(DialogRequest::EditExpression {
            path: path.to_string(),
        }) {
            Some(DialogResult::EditExpression { completed }) => completed,
            Some(DialogResult::ChooseFile { .. }) | Some(DialogResult::EditFiles { .. }) => {
                emit_host_error(
                    "unexpected dialog result while waiting for edit() expression session",
                );
                false
            }
            None => false,
        }
    }

    fn request_edit_files(paths: &[String]) -> bool {
        match request_dialog(DialogRequest::EditFiles {
            paths: paths.to_vec(),
        }) {
            Some(DialogResult::EditFiles { completed }) => completed,
            Some(DialogResult::ChooseFile { .. }) | Some(DialogResult::EditExpression { .. }) => {
                emit_host_error("unexpected dialog result while waiting for file.edit()");
                false
            }
            None => false,
        }
    }

    fn request_dialog(request: DialogRequest) -> Option<DialogResult> {
        let runtime = host_runtime()?;
        {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.pending_dialog_result = None;
        }
        if runtime.output.emit_dialog_request(&request).is_err() {
            return None;
        }

        let mut state = runtime.state.lock().expect("host state lock poisoned");
        loop {
            if let Some(result) = state.pending_dialog_result.take() {
                return Some(result);
            }

            if state.shutdown_requested || state.interrupt_requested {
                return None;
            }

            let (next_state, _) = runtime
                .cv
                .wait_timeout(state, EVENT_POLL_INTERVAL)
                .expect("host state lock poisoned");
            state = next_state;
        }
    }

    fn pump_r_events_once() {
        let Some(api) = event_loop_api() else {
            return;
        };

        let mut context = PumpEventsContext { api };
        unsafe {
            (api.r_toplevel_exec)(
                execute_pump_events,
                &mut context as *mut PumpEventsContext as *mut c_void,
            );
        }
    }

    unsafe fn run_process_events(api: EventLoopApi) {
        if let Some(process_events) = api.r_process_events {
            process_events();
            preserve_requested_interrupt();
        }
        run_activity_handlers(api);
        if let Some(run_pending_finalizers) = api.r_run_pending_finalizers {
            run_pending_finalizers();
            preserve_requested_interrupt();
        }
    }

    unsafe fn run_activity_handlers(api: EventLoopApi) {
        let handlers = *(api.r_input_handlers as *mut *mut c_void);
        if handlers.is_null() {
            return;
        }

        let mut handled = 0_usize;
        let mut mask = (api.r_check_activity)(0, 1);
        while !mask.is_null() && handled < MAX_ACTIVITY_HANDLER_DRAIN {
            (api.r_run_handlers)(handlers, mask);
            handled += 1;
            if preserve_requested_interrupt() {
                break;
            }
            mask = (api.r_check_activity)(0, 1);
        }
    }

    unsafe extern "C" fn execute_pump_events(data: *mut c_void) {
        if data.is_null() {
            return;
        }

        let context = &mut *(data as *mut PumpEventsContext);
        run_process_events(context.api);
    }

    unsafe extern "C-unwind" fn process_events_callback() {
        let Some(api) = event_loop_api() else {
            return;
        };

        run_activity_handlers(api);
        preserve_requested_interrupt();
    }

    unsafe extern "C-unwind" fn polled_events_callback() {
        let Some(api) = event_loop_api() else {
            return;
        };

        run_activity_handlers(api);
        preserve_requested_interrupt();
    }

    unsafe extern "C-unwind" fn read_console_callback(
        prompt: *const c_char,
        buffer: *mut c_uchar,
        buflen: c_int,
        add_history: c_int,
    ) -> c_int {
        READ_CONSOLE_INTERRUPTED.store(false, Ordering::Relaxed);

        let ret = read_console_callback_inner(prompt, buffer, buflen, add_history);

        if READ_CONSOLE_INTERRUPTED.swap(false, Ordering::Relaxed) {
            set_r_interrupts_pending(true);
            trigger_r_user_interrupt();
        }

        ret
    }

    unsafe extern "C-unwind" fn read_console_callback_inner(
        prompt: *const c_char,
        buffer: *mut c_uchar,
        buflen: c_int,
        add_history: c_int,
    ) -> c_int {
        let Some(runtime) = host_runtime() else {
            return 0;
        };

        let prompt_text = c_string_to_string(prompt);
        let wait_kind = classify_wait_kind(&prompt_text, add_history);
        let mut wait_event_emitted = false;
        set_r_interrupts_pending(false);
        let mut state = runtime.state.lock().expect("host state lock poisoned");

        loop {
            if matches!(wait_kind, WaitKind::TopLevel(_)) {
                set_r_interrupts_pending(false);
            }

            if let Some((request_id, code)) = take_next_parse_request(&mut state) {
                drop(state);
                let status = parse_status(code);
                let _ = runtime.output.emit_parse_status_result(request_id, status);
                state = runtime.state.lock().expect("host state lock poisoned");
                continue;
            }

            if let Some(width) = state.pending_width.take() {
                drop(state);
                if let Err(error) = apply_console_width(width) {
                    emit_host_error(&format!("failed to apply console width {width}: {error}"));
                } else {
                    let mut next_state = runtime.state.lock().expect("host state lock poisoned");
                    next_state.current_width = Some(width);
                    state = next_state;
                    continue;
                }
                state = runtime.state.lock().expect("host state lock poisoned");
                continue;
            }

            if let Some(fragment) = state.pending_fragment.take() {
                let signal_input_end = state.pending_fragment_from_nested;
                state.pending_fragment_from_nested = false;
                state.wait_state = None;
                return write_read_buffer(
                    buffer,
                    buflen,
                    fragment,
                    &mut state,
                    signal_input_end,
                    &runtime.output,
                );
            }

            if should_return_startup_input(&wait_kind, &mut state) {
                return write_read_buffer(
                    buffer,
                    buflen,
                    STARTUP_INTERRUPT_HANDLER_INPUT.as_bytes().to_vec(),
                    &mut state,
                    false,
                    &runtime.output,
                );
            }

            if should_return_top_level_recovery(&wait_kind, &mut state) {
                let recovery_input = take_top_level_recovery_input(&mut state);
                return write_read_buffer(
                    buffer,
                    buflen,
                    recovery_input,
                    &mut state,
                    false,
                    &runtime.output,
                );
            }

            if let Some(line) = take_next_line(&wait_kind, &mut state) {
                return write_read_buffer(
                    buffer,
                    buflen,
                    line.bytes,
                    &mut state,
                    line.signal_input_end,
                    &runtime.output,
                );
            }

            if state.shutdown_requested {
                state.wait_state = None;
                if matches!(wait_kind, WaitKind::Nested(_)) {
                    let _ = runtime.output.emit_input_end();
                    let _ = runtime.output.emit_output_flush();
                }
                return 0;
            }

            if state.interrupt_requested && matches!(wait_kind, WaitKind::Nested(_)) {
                state.interrupt_requested = false;
                state.top_level_recovery_pending = Some(TopLevelRecovery::RecoverFromInterrupt);
                state.wait_state = None;
                let _ = runtime.output.emit_input_end();
                let _ = runtime.output.emit_output_flush();
                READ_CONSOLE_INTERRUPTED.store(true, Ordering::Relaxed);
                return 0;
            }

            if !wait_event_emitted {
                match &wait_kind {
                    WaitKind::TopLevel(kind) => {
                        state.wait_state = Some(StoredWaitState::TopLevel(*kind));
                        let _ = runtime.output.emit_prompt(*kind);
                        let _ = runtime.output.emit_output_flush();
                    }
                    WaitKind::Nested(prompt) => {
                        state.wait_state = Some(StoredWaitState::Nested(prompt.clone()));
                        let _ = runtime.output.emit_input_request(prompt);
                        let _ = runtime.output.emit_output_flush();
                    }
                }
                wait_event_emitted = true;
            }

            let (next_state, timeout) = runtime
                .cv
                .wait_timeout(state, EVENT_POLL_INTERVAL)
                .expect("host state lock poisoned");
            state = next_state;
            if timeout.timed_out() {
                if matches!(wait_kind, WaitKind::TopLevel(_)) && state.suppress_idle_event_pump {
                    continue;
                }
                drop(state);
                pump_r_events_once();
                state = runtime.state.lock().expect("host state lock poisoned");
            }
        }
    }

    unsafe extern "C" fn write_console_ex_callback(
        text: *const c_char,
        _bufline: c_int,
        otype: c_int,
    ) {
        if let Some(runtime) = host_runtime() {
            let rendered = c_string_to_string(text);
            if rendered.is_empty() {
                return;
            }
            if otype == 0 {
                let _ = runtime
                    .output
                    .emit_output(OutputStream::Stdout, rendered.as_bytes());
            } else {
                let _ = runtime
                    .output
                    .emit_output(OutputStream::Stderr, rendered.as_bytes());
            }
            let _ = runtime.output.emit_output_flush();
        }
    }

    unsafe extern "C" fn show_message_callback(text: *const c_char) {
        emit_host_error(&c_string_to_string(text));
    }

    unsafe extern "C" fn busy_callback(value: c_int) {
        if let Some(runtime) = host_runtime() {
            let mut should_signal = false;
            {
                let mut state = runtime.state.lock().expect("host state lock poisoned");
                let was_busy = state.busy;
                state.busy = value != 0;
                if value != 0 {
                    state.wait_state = None;
                    should_signal = state.interrupt_requested;
                } else {
                    if state.top_level_recovery_active {
                        state.top_level_recovery_active = false;
                    } else if was_busy && state.top_level_recovery_pending.is_none() {
                        state.top_level_recovery_pending = Some(TopLevelRecovery::ParseNull);
                    }
                    state.suppress_idle_event_pump = state.interrupt_requested;
                    state.interrupt_requested = false;
                    set_r_interrupts_pending(false);
                }
            }
            if should_signal {
                signal_r_interrupt();
            }
            let _ = runtime.output.emit_busy(value != 0);
        }
    }

    unsafe extern "C" fn suicide_callback(text: *const c_char) {
        emit_host_error(&c_string_to_string(text));
        std::process::exit(1);
    }

    unsafe extern "C" fn choose_file_callback(
        new_file: c_int,
        buffer: *mut c_char,
        len: c_int,
    ) -> c_int {
        let Some(path) = request_choose_file(new_file != 0) else {
            if !buffer.is_null() && len > 0 {
                *buffer = 0;
            }
            return 0;
        };

        write_path_buffer(buffer, len, &path)
    }

    unsafe extern "C" fn edit_file_callback(path: *const c_char) -> c_int {
        let file_path = c_string_to_string(path);
        if file_path.is_empty() {
            return 1;
        }

        let expanded_path = expand_r_file_name(&file_path);

        if request_edit_file(&expanded_path) {
            0
        } else {
            1
        }
    }

    unsafe extern "C" fn edit_files_callback(
        count: c_int,
        paths: *const *const c_char,
        _titles: *const *const c_char,
        _editor: *const c_char,
    ) -> c_int {
        let expanded_paths = c_string_array_to_vec(paths, count)
            .into_iter()
            .map(|value| expand_r_file_name(&value))
            .collect::<Vec<_>>();
        if expanded_paths.is_empty() {
            return 1;
        }

        if request_edit_files(&expanded_paths) {
            0
        } else {
            1
        }
    }

    fn write_path_buffer(buffer: *mut c_char, len: c_int, path: &str) -> c_int {
        let bytes = path.as_bytes();
        if buffer.is_null() || len <= 0 {
            return bytes.len() as c_int;
        }

        let capacity = len as usize;
        let used = bytes.len().min(capacity.saturating_sub(1));
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), buffer as *mut u8, used);
            *(buffer.add(used)) = 0;
        }

        bytes.len() as c_int
    }

    fn take_next_line(wait_kind: &WaitKind, state: &mut SharedState) -> Option<PendingLine> {
        if let Some(line) = state.active_submission_lines.pop_front() {
            state.wait_state = None;
            return Some(PendingLine {
                bytes: line,
                signal_input_end: false,
            });
        }

        match wait_kind {
            WaitKind::TopLevel(_) => {
                let index = state
                    .pending_commands
                    .iter()
                    .position(|command| matches!(command, PendingCommand::Submit(_)))?;
                match state.pending_commands.remove(index) {
                    Some(PendingCommand::Submit(lines)) => {
                        state.active_submission_lines = lines;
                        state.wait_state = None;
                        state
                            .active_submission_lines
                            .pop_front()
                            .map(|line| PendingLine {
                                bytes: line,
                                signal_input_end: false,
                            })
                    }
                    _ => None,
                }
            }
            WaitKind::Nested(_) => {
                let index = state
                    .pending_commands
                    .iter()
                    .position(|command| matches!(command, PendingCommand::Reply(_)))?;
                match state.pending_commands.remove(index) {
                    Some(PendingCommand::Reply(bytes)) => {
                        state.wait_state = None;
                        Some(PendingLine {
                            bytes,
                            signal_input_end: true,
                        })
                    }
                    _ => None,
                }
            }
        }
    }

    fn should_return_top_level_recovery(wait_kind: &WaitKind, state: &mut SharedState) -> bool {
        if !matches!(wait_kind, WaitKind::TopLevel(PromptKind::Main)) {
            return false;
        }

        if state.top_level_recovery_active && !state.busy {
            state.top_level_recovery_active = false;
        }

        if state.top_level_recovery_pending.is_none() {
            return false;
        }
        if state.pending_fragment.is_some() || !state.active_submission_lines.is_empty() {
            return false;
        }

        state.top_level_recovery_active = true;
        true
    }

    fn should_return_startup_input(wait_kind: &WaitKind, state: &mut SharedState) -> bool {
        if !state.startup_input_pending {
            return false;
        }
        if !matches!(wait_kind, WaitKind::TopLevel(PromptKind::Main)) {
            return false;
        }
        if state.pending_fragment.is_some() || !state.active_submission_lines.is_empty() {
            return false;
        }

        state.startup_input_pending = false;
        true
    }

    fn take_top_level_recovery_input(state: &mut SharedState) -> Vec<u8> {
        match state
            .top_level_recovery_pending
            .take()
            .unwrap_or(TopLevelRecovery::ParseNull)
        {
            TopLevelRecovery::ParseNull => b" ".to_vec(),
            TopLevelRecovery::RecoverFromInterrupt => {
                b"base::invisible(base::.Last.value)".to_vec()
            }
        }
    }

    fn take_next_parse_request(state: &mut SharedState) -> Option<(u32, String)> {
        let index = state
            .pending_commands
            .iter()
            .position(|command| matches!(command, PendingCommand::ParseStatus { .. }))?;
        match state.pending_commands.remove(index) {
            Some(PendingCommand::ParseStatus { request_id, code }) => Some((request_id, code)),
            _ => None,
        }
    }

    fn write_read_buffer(
        buffer: *mut c_uchar,
        buflen: c_int,
        bytes: Vec<u8>,
        state: &mut SharedState,
        signal_input_end: bool,
        output: &OutputSink,
    ) -> c_int {
        if buffer.is_null() || buflen <= 1 {
            return 0;
        }

        let buffer_len = buflen as usize;
        let target = unsafe { std::slice::from_raw_parts_mut(buffer, buffer_len) };

        if bytes.len() < buffer_len.saturating_sub(1) {
            target[..bytes.len()].copy_from_slice(&bytes);
            target[bytes.len()] = b'\n';
            target[bytes.len() + 1] = 0;
            if signal_input_end {
                state.top_level_recovery_pending = Some(TopLevelRecovery::ParseNull);
                let _ = output.emit_input_end();
                let _ = output.emit_output_flush();
            }
            1
        } else {
            let used = buffer_len - 1;
            target[..used].copy_from_slice(&bytes[..used]);
            target[used] = 0;
            state.pending_fragment = Some(bytes[used..].to_vec());
            state.pending_fragment_from_nested = signal_input_end;
            1
        }
    }

    fn prompt_kind_from_prompt(prompt: &str) -> PromptKind {
        let trimmed = prompt.trim_end_matches(['\r', '\n']);
        if trimmed == CONT_PROMPT.trim_end() || trimmed.starts_with('+') {
            PromptKind::Cont
        } else {
            PromptKind::Main
        }
    }

    fn classify_wait_kind(prompt_text: &str, add_history: c_int) -> WaitKind {
        if add_history != 0 && is_top_level_prompt(prompt_text) {
            WaitKind::TopLevel(prompt_kind_from_prompt(prompt_text))
        } else {
            WaitKind::Nested(prompt_text.to_string())
        }
    }

    fn is_top_level_prompt(prompt: &str) -> bool {
        let trimmed = prompt.trim_end_matches(['\r', '\n']);
        trimmed == "> " || trimmed == ">" || trimmed == "+ " || trimmed == "+"
    }

    fn split_submission_lines(code: &str) -> VecDeque<Vec<u8>> {
        let normalized = normalize_newlines(code);
        let mut lines = VecDeque::new();
        for line in normalized.split('\n') {
            lines.push_back(line.as_bytes().to_vec());
        }
        if lines.is_empty() {
            lines.push_back(Vec::new());
        }
        lines
    }

    fn normalize_reply_text(text: &str) -> String {
        normalize_newlines(text)
            .split('\n')
            .next()
            .unwrap_or_default()
            .to_string()
    }

    fn normalize_newlines(text: &str) -> String {
        text.replace("\r\n", "\n").replace('\r', "\n")
    }

    fn c_string_to_string(text: *const c_char) -> String {
        if text.is_null() {
            return String::new();
        }
        unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned()
    }

    fn c_string_array_to_vec(values: *const *const c_char, count: c_int) -> Vec<String> {
        if values.is_null() || count <= 0 {
            return Vec::new();
        }

        let entries = unsafe { std::slice::from_raw_parts(values, count as usize) };
        entries
            .iter()
            .filter_map(|entry| {
                if entry.is_null() {
                    return None;
                }
                Some(c_string_to_string(*entry))
            })
            .collect()
    }

    fn parse_api() -> Option<ParseApi> {
        PARSE_API.get().copied()
    }

    fn parse_status(code: String) -> c_int {
        let trimmed = code.trim();
        if trimmed.is_empty() {
            return PARSE_STATUS_NULL;
        }

        let Some(api) = parse_api() else {
            return PARSE_STATUS_ERROR;
        };

        let Ok(code) = CString::new(code) else {
            return PARSE_STATUS_ERROR;
        };

        let mut context = ParseStatusContext {
            api,
            code,
            status: PARSE_STATUS_ERROR,
        };

        let executed = unsafe {
            (context.api.r_toplevel_exec)(
                execute_parse_status,
                &mut context as *mut ParseStatusContext as *mut c_void,
            )
        };
        if executed == 0 {
            return PARSE_STATUS_ERROR;
        }

        context.status
    }

    fn apply_console_width(width: u16) -> Result<(), Box<dyn Error>> {
        let Some(api) = parse_api() else {
            return Err("parse api not initialized".into());
        };

        let mut context = ApplyWidthContext {
            api,
            width: width as c_int,
            success: false,
        };

        let executed = unsafe {
            (context.api.r_toplevel_exec)(
                execute_apply_console_width,
                &mut context as *mut ApplyWidthContext as *mut c_void,
            )
        };
        if executed == 0 || !context.success {
            return Err("R rejected width update".into());
        }

        Ok(())
    }

    unsafe extern "C" fn execute_parse_status(data: *mut c_void) {
        if data.is_null() {
            return;
        }

        let context = &mut *(data as *mut ParseStatusContext);
        let mut parse_status = R_PARSE_OK;
        let text = (context.api.rf_protect)((context.api.rf_mk_string)(context.code.as_ptr()));
        let expressions = (context.api.rf_protect)((context.api.r_parse_vector)(
            text,
            -1,
            &mut parse_status,
            context.api.r_nil_value as Sexp,
        ));
        let _ = expressions;
        (context.api.rf_unprotect)(2);

        context.status = match parse_status {
            R_PARSE_OK => PARSE_STATUS_OK,
            R_PARSE_INCOMPLETE => PARSE_STATUS_INCOMPLETE,
            R_PARSE_ERROR | R_PARSE_EOF => PARSE_STATUS_ERROR,
            _ => PARSE_STATUS_ERROR,
        };
    }

    unsafe extern "C" fn execute_apply_console_width(data: *mut c_void) {
        if data.is_null() {
            return;
        }

        let context = &mut *(data as *mut ApplyWidthContext);
        let api = context.api;
        let options_symbol = (api.rf_install)(b".Options\0".as_ptr() as *const c_char);
        let width_symbol = (api.rf_install)(b"width\0".as_ptr() as *const c_char);
        let base_env = *(api.r_base_env as *mut Sexp);
        let mut node = (api.rf_find_var_in_frame)(base_env, options_symbol);

        while node != api.r_nil_value as Sexp {
            if (api.tag)(node) == width_symbol {
                let value = (api.rf_protect)((api.rf_scalar_integer)(context.width));
                let _ = (api.setcar)(node, value);
                (api.rf_unprotect)(1);
                context.success = true;
                return;
            }
            node = (api.cdr)(node);
        }
    }

    fn resolve_r_library_path(r_executable: &Path) -> Result<PathBuf, Box<dyn Error>> {
        let r_home = resolve_r_home(r_executable)?;
        let library_name = if cfg!(target_os = "macos") {
            "libR.dylib"
        } else {
            "libR.so"
        };
        let library_path = r_home.join("lib").join(library_name);
        if !library_path.is_file() {
            return Err(format!("R shared library not found at {}", library_path.display()).into());
        }
        Ok(library_path)
    }

    fn resolve_r_home(r_executable: &Path) -> Result<PathBuf, Box<dyn Error>> {
        if let Some(configured) = std::env::var_os("R_HOME") {
            let configured = PathBuf::from(configured);
            if configured.is_dir() {
                return Ok(configured);
            }
        }

        let normalized = r_executable
            .canonicalize()
            .unwrap_or_else(|_| r_executable.to_path_buf());
        let Some(bin_dir) = normalized.parent() else {
            return Err("R executable has no parent directory".into());
        };
        let Some(r_home) = bin_dir.parent() else {
            return Err("failed to derive R_HOME from executable path".into());
        };
        Ok(r_home.to_path_buf())
    }

    impl RApi {
        unsafe fn load(path: &Path) -> Result<Self, Box<dyn Error>> {
            let library = Library::open(Some(path), libc::RTLD_NOW | libc::RTLD_GLOBAL)?;

            Ok(Self {
                rf_initialize_r: load_function(&library, b"Rf_initialize_R\0")?,
                setup_rmainloop: load_function(&library, b"setup_Rmainloop\0")?,
                run_rmainloop: load_function(&library, b"run_Rmainloop\0")?,
                r_expand_file_name: load_function(&library, b"R_ExpandFileName\0")?,
                ptr_r_write_console: load_optional_global(&library, b"ptr_R_WriteConsole\0"),
                ptr_r_write_console_ex: load_global(&library, b"ptr_R_WriteConsoleEx\0")?,
                ptr_r_read_console: load_global(&library, b"ptr_R_ReadConsole\0")?,
                ptr_r_show_message: load_optional_global(&library, b"ptr_R_ShowMessage\0"),
                ptr_r_busy: load_optional_global(&library, b"ptr_R_Busy\0"),
                ptr_r_suicide: load_optional_global(&library, b"ptr_R_Suicide\0"),
                ptr_r_choose_file: load_optional_global(&library, b"ptr_R_ChooseFile\0"),
                ptr_r_edit_file: load_optional_global(&library, b"ptr_R_EditFile\0"),
                ptr_r_edit_files: load_optional_global(&library, b"ptr_R_EditFiles\0"),
                ptr_r_process_events: load_optional_global(&library, b"ptr_R_ProcessEvents\0"),
                r_polled_events: load_optional_global(&library, b"R_PolledEvents\0"),
                r_outputfile: load_optional_global(&library, b"R_Outputfile\0"),
                r_consolefile: load_optional_global(&library, b"R_Consolefile\0"),
                r_interactive: load_optional_global(&library, b"R_Interactive\0"),
                r_signal_handlers: load_optional_global(&library, b"R_SignalHandlers\0"),
                r_running_as_main_program: load_optional_global(
                    &library,
                    b"R_running_as_main_program\0",
                ),
                r_interrupts_pending: load_optional_global(&library, b"R_interrupts_pending\0"),
                r_check_user_interrupt: load_optional_function(&library, b"R_CheckUserInterrupt\0"),
                r_process_events: load_optional_function(&library, b"R_ProcessEvents\0"),
                r_run_pending_finalizers: load_optional_function(
                    &library,
                    b"R_RunPendingFinalizers\0",
                ),
                r_check_activity: load_function(&library, b"R_checkActivity\0")?,
                r_run_handlers: load_function(&library, b"R_runHandlers\0")?,
                r_input_handlers: load_global(&library, b"R_InputHandlers\0")?,
                rf_mk_string: load_function(&library, b"Rf_mkString\0")?,
                rf_install: load_function(&library, b"Rf_install\0")?,
                rf_find_var_in_frame: load_function(&library, b"Rf_findVarInFrame\0")?,
                rf_scalar_integer: load_function(&library, b"Rf_ScalarInteger\0")?,
                rf_protect: load_function(&library, b"Rf_protect\0")?,
                rf_unprotect: load_function(&library, b"Rf_unprotect\0")?,
                r_parse_vector: load_function(&library, b"R_ParseVector\0")?,
                r_toplevel_exec: load_function(&library, b"R_ToplevelExec\0")?,
                tag: load_function(&library, b"TAG\0")?,
                cdr: load_function(&library, b"CDR\0")?,
                setcar: load_function(&library, b"SETCAR\0")?,
                r_base_env_ptr: load_global(&library, b"R_BaseEnv\0")?,
                r_nil_value_ptr: load_global(&library, b"R_NilValue\0")?,
                _library: library,
            })
        }

        unsafe fn initialize(
            &self,
            r_executable: &Path,
            r_args: &[String],
        ) -> Result<(), Box<dyn Error>> {
            if let Some(value) = self.r_running_as_main_program {
                *value = 1;
            }
            if let Some(value) = self.r_signal_handlers {
                // Unix busy interrupts use SIGINT to wake R. Keep R's signal
                // handler installed so SIGINT is converted into a user
                // interrupt instead of terminating the host process.
                *value = 1;
            }

            let mut argv_storage = build_r_args(r_executable, r_args)?;
            let mut argv = argv_storage
                .iter_mut()
                .map(|value| value.as_ptr() as *mut c_char)
                .collect::<Vec<_>>();

            (self.rf_initialize_r)(argv.len() as c_int, argv.as_mut_ptr());

            if let Some(value) = self.r_interactive {
                *value = 1;
            }
            if let Some(value) = self.r_interrupts_pending {
                R_INTERRUPTS_PENDING_PTR.store(value as usize, Ordering::Relaxed);
            }
            if let Some(function) = self.r_check_user_interrupt {
                R_CHECK_USER_INTERRUPT.store(function as usize, Ordering::Relaxed);
            }
            R_EXPAND_FILE_NAME.store(self.r_expand_file_name as usize, Ordering::Relaxed);
            if let Some(value) = self.r_outputfile {
                *value = std::ptr::null_mut();
            }
            if let Some(value) = self.r_consolefile {
                *value = std::ptr::null_mut();
            }
            if let Some(value) = self.ptr_r_write_console {
                *value = None;
            }
            *self.ptr_r_write_console_ex = Some(write_console_ex_callback);
            *self.ptr_r_read_console = Some(read_console_callback);
            if let Some(value) = self.ptr_r_show_message {
                *value = Some(show_message_callback);
            }
            if let Some(value) = self.ptr_r_busy {
                *value = Some(busy_callback);
            }
            if let Some(value) = self.ptr_r_suicide {
                *value = Some(suicide_callback);
            }
            if let Some(value) = self.ptr_r_choose_file {
                *value = Some(choose_file_callback);
            }
            if let Some(value) = self.ptr_r_edit_file {
                *value = Some(edit_file_callback);
            }
            if let Some(value) = self.ptr_r_edit_files {
                *value = Some(edit_files_callback);
            }
            if let Some(value) = self.ptr_r_process_events {
                *value = Some(process_events_callback);
            }
            if let Some(value) = self.r_polled_events {
                *value = Some(polled_events_callback);
            }
            (self.setup_rmainloop)();
            Ok(())
        }

        fn parse_api(&self) -> ParseApi {
            let r_nil_value = unsafe { *self.r_nil_value_ptr as usize };
            ParseApi {
                rf_mk_string: self.rf_mk_string,
                rf_install: self.rf_install,
                rf_find_var_in_frame: self.rf_find_var_in_frame,
                rf_scalar_integer: self.rf_scalar_integer,
                rf_protect: self.rf_protect,
                rf_unprotect: self.rf_unprotect,
                r_parse_vector: self.r_parse_vector,
                r_toplevel_exec: self.r_toplevel_exec,
                tag: self.tag,
                cdr: self.cdr,
                setcar: self.setcar,
                r_base_env: self.r_base_env_ptr as usize,
                r_nil_value,
            }
        }

        fn event_loop_api(&self) -> EventLoopApi {
            EventLoopApi {
                r_process_events: self.r_process_events,
                r_run_pending_finalizers: self.r_run_pending_finalizers,
                r_check_activity: self.r_check_activity,
                r_run_handlers: self.r_run_handlers,
                r_toplevel_exec: self.r_toplevel_exec,
                r_input_handlers: self.r_input_handlers as usize,
            }
        }
    }

    unsafe fn load_function<T: Copy>(
        library: &Library,
        symbol: &[u8],
    ) -> Result<T, Box<dyn Error>> {
        let handle: Symbol<T> = library.get(symbol)?;
        Ok(*handle)
    }

    unsafe fn load_optional_function<T: Copy>(library: &Library, symbol: &[u8]) -> Option<T> {
        match library.get::<T>(symbol) {
            Ok(handle) => Some(*handle),
            Err(_) => None,
        }
    }

    unsafe fn load_global<T>(library: &Library, symbol: &[u8]) -> Result<*mut T, Box<dyn Error>> {
        let handle: Symbol<*mut T> = library.get(symbol)?;
        Ok(*handle)
    }

    unsafe fn load_optional_global<T>(library: &Library, symbol: &[u8]) -> Option<*mut T> {
        match library.get::<*mut T>(symbol) {
            Ok(handle) => Some(*handle),
            Err(_) => None,
        }
    }

    fn build_r_args(
        r_executable: &Path,
        r_args: &[String],
    ) -> Result<Vec<CString>, Box<dyn Error>> {
        let mut argv = Vec::with_capacity(r_args.len() + 2);
        let program_name = r_executable
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("R");
        argv.push(CString::new(program_name)?);

        if !r_args.iter().any(|arg| arg == "--interactive") {
            argv.push(CString::new("--interactive")?);
        }

        for arg in r_args {
            argv.push(CString::new(arg.as_str())?);
        }

        Ok(argv)
    }
}

#[cfg(windows)]
mod windows_host {
    use crate::protocol::{
        read_next_command, DialogRequest, DialogResult, IncomingCommand, OutputSink, OutputStream,
        PromptKind, SessionWaitState,
    };
    use libloading::os::windows::{
        Library as WindowsLibrary, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };
    use libloading::{Library, Symbol};
    use std::collections::VecDeque;
    use std::error::Error;
    use std::ffi::{c_char, c_int, c_uchar, c_void, CStr, CString};
    use std::fs;
    use std::io;
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
    use std::thread;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::{
        Globalization::{MultiByteToWideChar, WideCharToMultiByte, CP_ACP, WC_NO_BEST_FIT_CHARS},
        UI::WindowsAndMessaging::{
            DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
        },
    };

    const CONT_PROMPT: &str = "+ ";
    const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(50);
    const SESSION_ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(100);
    const MAX_ACTIVITY_HANDLER_DRAIN: usize = 64;
    const EMBEDDED_UTF8_PREFIX: &[u8] = &[0x02, 0xff, 0xfe];
    const EMBEDDED_UTF8_SUFFIX: &[u8] = &[0x03, 0xff, 0xfe];

    const SUPPORTED_CAPABILITIES: &[&str] = &[
        "control-channel",
        "shutdown",
        "session-control",
        "top-level-submit",
        "nested-input",
        "parse-status",
        "set-width",
    ];

    const PARSE_STATUS_NULL: c_int = 0;
    const PARSE_STATUS_OK: c_int = 1;
    const PARSE_STATUS_INCOMPLETE: c_int = 2;
    const PARSE_STATUS_ERROR: c_int = 3;

    const R_PARSE_OK: c_int = 1;
    const R_PARSE_INCOMPLETE: c_int = 2;
    const R_PARSE_ERROR: c_int = 3;
    const R_PARSE_EOF: c_int = 4;

    type SetupRMainloop = unsafe extern "C" fn();
    type RunRMainloop = unsafe extern "C" fn();
    type ReadConsoleFn =
        unsafe extern "C-unwind" fn(*const c_char, *mut c_uchar, c_int, c_int) -> c_int;
    type WriteConsoleFn = unsafe extern "C" fn(*const c_char, c_int);
    type WriteConsoleExFn = unsafe extern "C" fn(*const c_char, c_int, c_int);
    type ShowMessageFn = unsafe extern "C" fn(*const c_char);
    type BusyFn = unsafe extern "C" fn(c_int);
    type SuicideFn = unsafe extern "C" fn(*const c_char);
    type ChooseFileFn = unsafe extern "C" fn(c_int, *mut c_char, c_int) -> c_int;
    type EditFileFn = unsafe extern "C" fn(*const c_char) -> c_int;
    type EditFilesFn = unsafe extern "C" fn(
        c_int,
        *const *const c_char,
        *const *const c_char,
        *const c_char,
    ) -> c_int;
    type EventCallbackFn = unsafe extern "C-unwind" fn();
    type YesNoCancelFn = unsafe extern "C" fn(*const c_char) -> c_int;
    type ExpandFileNameFn = unsafe extern "C" fn(*const c_char) -> *const c_char;
    type CheckUserInterruptFn = unsafe extern "C" fn();
    type ProcessEventsFn = unsafe extern "C" fn();
    type RunPendingFinalizersFn = unsafe extern "C" fn();
    type CheckActivityFn = unsafe extern "C" fn(c_int, c_int) -> *mut c_void;
    type RunHandlersFn = unsafe extern "C" fn(*mut c_void, *mut c_void);
    type Sexp = *mut c_void;
    type MkStringFn = unsafe extern "C" fn(*const c_char) -> Sexp;
    type InstallFn = unsafe extern "C" fn(*const c_char) -> Sexp;
    type FindVarInFrameFn = unsafe extern "C" fn(Sexp, Sexp) -> Sexp;
    type ScalarIntegerFn = unsafe extern "C" fn(c_int) -> Sexp;
    type ProtectFn = unsafe extern "C" fn(Sexp) -> Sexp;
    type UnprotectFn = unsafe extern "C" fn(c_int);
    type ParseVectorFn = unsafe extern "C" fn(Sexp, c_int, *mut c_int, Sexp) -> Sexp;
    type TopLevelExecFn =
        unsafe extern "C" fn(unsafe extern "C" fn(*mut c_void), *mut c_void) -> c_int;
    type TagFn = unsafe extern "C" fn(Sexp) -> Sexp;
    type CdrFn = unsafe extern "C" fn(Sexp) -> Sexp;
    type SetcarFn = unsafe extern "C" fn(Sexp, Sexp) -> Sexp;
    type DefParamsFn = unsafe extern "C" fn(*mut RStart);
    type DefParamsExFn = unsafe extern "C" fn(*mut RStart, c_int);
    type SetParamsFn = unsafe extern "C" fn(*mut RStart);
    type CmdLineOptionsFn = unsafe extern "C" fn(c_int, *mut *mut c_char);
    type CommonCommandLineFn = unsafe extern "C" fn(*mut c_int, *mut *mut c_char, *mut RStart);
    type ReadConsoleCfgFn = unsafe extern "C" fn();
    type GetRUserFn = unsafe extern "C" fn() -> *const c_char;
    type GAInitAppFn = unsafe extern "C" fn(c_int, *mut *mut c_char) -> c_int;
    type GAPeekEventFn = unsafe extern "C" fn() -> c_int;
    type RBoolean = c_int;

    const R_TRUE: RBoolean = 1;
    const R_FALSE: RBoolean = 0;

    #[allow(dead_code)]
    #[repr(i32)]
    #[derive(Clone, Copy)]
    enum UIMode {
        RGui = 0,
        RTerm = 1,
        LinkDLL = 2,
    }

    #[allow(dead_code)]
    #[repr(i32)]
    #[derive(Clone, Copy)]
    enum StartupAction {
        NoRestore = 0,
        Restore = 1,
        Default = 2,
        NoSave = 3,
        Save = 4,
        SaveAsk = 5,
        Suicide = 6,
    }

    #[repr(C)]
    struct RStart {
        r_quiet: RBoolean,
        r_no_echo: RBoolean,
        r_interactive: RBoolean,
        r_verbose: RBoolean,
        load_site_file: RBoolean,
        load_init_file: RBoolean,
        debug_init_file: RBoolean,
        restore_action: StartupAction,
        save_action: StartupAction,
        vsize: usize,
        nsize: usize,
        max_vsize: usize,
        max_nsize: usize,
        ppsize: usize,
        bitfield: u32,
        rhome: *mut c_char,
        home: *mut c_char,
        read_console: Option<ReadConsoleFn>,
        write_console: Option<WriteConsoleFn>,
        callback: Option<EventCallbackFn>,
        show_message: Option<ShowMessageFn>,
        yes_no_cancel: Option<YesNoCancelFn>,
        busy: Option<BusyFn>,
        character_mode: UIMode,
        write_console_ex: Option<WriteConsoleExFn>,
        emit_embedded_utf8: RBoolean,
        cleanup: Option<unsafe extern "C" fn(StartupAction, c_int, c_int)>,
        clearerr_console: Option<unsafe extern "C" fn()>,
        flush_console: Option<unsafe extern "C" fn()>,
        reset_console: Option<unsafe extern "C" fn()>,
        suicide: Option<SuicideFn>,
    }

    struct RLayout {
        dll_dir: PathBuf,
        library_path: PathBuf,
    }

    struct RApi {
        _library: Library,
        _support_libraries: Vec<Library>,
        setup_rmainloop: SetupRMainloop,
        run_rmainloop: RunRMainloop,
        r_expand_file_name: ExpandFileNameFn,
        r_def_params: Option<DefParamsFn>,
        r_def_params_ex: Option<DefParamsExFn>,
        r_set_params: SetParamsFn,
        cmdlineoptions: Option<CmdLineOptionsFn>,
        r_common_command_line: Option<CommonCommandLineFn>,
        readconsolecfg: Option<ReadConsoleCfgFn>,
        get_r_user: Option<GetRUserFn>,
        ga_initapp: Option<GAInitAppFn>,
        ga_peekevent: Option<GAPeekEventFn>,
        r_process_events: Option<ProcessEventsFn>,
        r_run_pending_finalizers: Option<RunPendingFinalizersFn>,
        ptr_r_process_events: Option<*mut Option<EventCallbackFn>>,
        r_polled_events: Option<*mut Option<EventCallbackFn>>,
        r_check_activity: Option<CheckActivityFn>,
        r_run_handlers: Option<RunHandlersFn>,
        r_input_handlers: Option<*mut *mut c_void>,
        r_interactive: Option<*mut c_int>,
        r_signal_handlers: Option<*mut c_int>,
        r_running_as_main_program: Option<*mut c_int>,
        locale_cp: Option<*mut c_int>,
        r_interrupts_pending: Option<*mut c_int>,
        r_check_user_interrupt: Option<CheckUserInterruptFn>,
        r_cstack_limit: Option<*mut usize>,
        character_mode: Option<*mut c_int>,
        ptr_r_choose_file: Option<*mut Option<ChooseFileFn>>,
        ptr_r_edit_file: Option<*mut Option<EditFileFn>>,
        ptr_r_edit_files: Option<*mut Option<EditFilesFn>>,
        rf_mk_string: MkStringFn,
        rf_install: InstallFn,
        rf_find_var_in_frame: FindVarInFrameFn,
        rf_scalar_integer: ScalarIntegerFn,
        rf_protect: ProtectFn,
        rf_unprotect: UnprotectFn,
        r_parse_vector: ParseVectorFn,
        r_toplevel_exec: TopLevelExecFn,
        tag: TagFn,
        cdr: CdrFn,
        setcar: SetcarFn,
        r_base_env_ptr: *mut Sexp,
        r_nil_value_ptr: *mut Sexp,
        _r_start_storage: Option<Box<RStart>>,
        _r_home_storage: Option<CString>,
        _user_home_storage: Option<CString>,
        _argv_storage: Vec<CString>,
    }

    struct HostRuntime {
        output: OutputSink,
        state: Mutex<SharedState>,
        cv: Condvar,
    }

    #[derive(Default)]
    struct SharedState {
        pending_commands: VecDeque<PendingCommand>,
        active_submission_lines: VecDeque<Vec<u8>>,
        pending_fragment: Option<Vec<u8>>,
        pending_fragment_from_nested: bool,
        pending_dialog_result: Option<DialogResult>,
        pending_width: Option<u16>,
        current_width: Option<u16>,
        startup_input_pending: bool,
        busy: bool,
        interrupt_requested: bool,
        suppress_idle_event_pump: bool,
        top_level_recovery_pending: Option<TopLevelRecovery>,
        top_level_recovery_active: bool,
        shutdown_requested: bool,
        wait_state: Option<StoredWaitState>,
    }

    #[derive(Clone, Copy)]
    enum TopLevelRecovery {
        ParseNull,
        RecoverFromInterrupt,
    }

    #[derive(Clone)]
    enum StoredWaitState {
        TopLevel(PromptKind),
        Nested(String),
    }

    enum PendingCommand {
        Submit(VecDeque<Vec<u8>>),
        Reply(Vec<u8>),
        ParseStatus { request_id: u32, code: String },
    }

    enum WaitKind {
        TopLevel(PromptKind),
        Nested(String),
    }

    struct PendingLine {
        bytes: Vec<u8>,
        signal_input_end: bool,
    }

    static HOST_RUNTIME: OnceLock<HostRuntime> = OnceLock::new();
    static PARSE_API: OnceLock<ParseApi> = OnceLock::new();
    static EVENT_LOOP_API: OnceLock<EventLoopApi> = OnceLock::new();
    static R_LOCALE_CP_PTR: AtomicUsize = AtomicUsize::new(0);
    static R_INTERRUPTS_PENDING_PTR: AtomicUsize = AtomicUsize::new(0);
    static R_CHECK_USER_INTERRUPT: AtomicUsize = AtomicUsize::new(0);
    static READ_CONSOLE_INTERRUPTED: AtomicBool = AtomicBool::new(false);
    static PROCESS_EVENTS_CALLBACK_ACTIVE: AtomicBool = AtomicBool::new(false);
    static R_EXPAND_FILE_NAME: AtomicUsize = AtomicUsize::new(0);

    #[derive(Clone, Copy)]
    struct ParseApi {
        rf_mk_string: MkStringFn,
        rf_install: InstallFn,
        rf_find_var_in_frame: FindVarInFrameFn,
        rf_scalar_integer: ScalarIntegerFn,
        rf_protect: ProtectFn,
        rf_unprotect: UnprotectFn,
        r_parse_vector: ParseVectorFn,
        r_toplevel_exec: TopLevelExecFn,
        tag: TagFn,
        cdr: CdrFn,
        setcar: SetcarFn,
        r_base_env: usize,
        r_nil_value: usize,
    }

    #[derive(Clone, Copy)]
    struct EventLoopApi {
        r_process_events: Option<ProcessEventsFn>,
        ga_peekevent: Option<GAPeekEventFn>,
        r_check_activity: Option<CheckActivityFn>,
        r_run_handlers: Option<RunHandlersFn>,
        r_input_handlers: Option<usize>,
        r_run_pending_finalizers: Option<RunPendingFinalizersFn>,
        r_toplevel_exec: TopLevelExecFn,
    }

    struct ParseStatusContext {
        api: ParseApi,
        code: CString,
        status: c_int,
    }

    struct ApplyWidthContext {
        api: ParseApi,
        width: c_int,
        success: bool,
    }

    struct PumpEventsContext {
        api: EventLoopApi,
    }

    const STARTUP_INTERRUPT_HANDLER_INPUT: &str = r#"base::local({ if (base::getRversion() >= "4.0.0") { handler <- function(e) { restart <- base::findRestart("abort"); if (!base::is.null(restart)) base::invokeRestart(restart) }; handlers <- base::globalCallingHandlers(); base::globalCallingHandlers(NULL); handlers <- c(handlers, list(interrupt = handler)); base::do.call(base::globalCallingHandlers, handlers) }; base::invisible(NULL) }, envir = base::new.env(parent = base::baseenv()))"#;

    pub(crate) fn run(args: Vec<String>) -> Result<(), Box<dyn Error>> {
        if args.is_empty() {
            return Err("missing R executable path".into());
        }

        let r_executable = PathBuf::from(&args[0]);
        let r_args = &args[1..];
        let layout = resolve_r_layout(&r_executable)?;
        let mut api = unsafe { RApi::load(&layout)? };

        let output = OutputSink::new_with_capabilities("embedded-r-host", SUPPORTED_CAPABILITIES);
        let session_transport = session_transport_config().is_some();
        if let Err(error) = output.capture_process_stdout() {
            let _ =
                output.emit_host_error(&format!("backend stdout capture setup failed: {error}"));
        }
        if !session_transport {
            output.emit_backend_ready()?;
        }

        HOST_RUNTIME
            .set(HostRuntime {
                output: output.clone_handle(),
                state: Mutex::new(SharedState {
                    startup_input_pending: true,
                    ..SharedState::default()
                }),
                cv: Condvar::new(),
            })
            .map_err(|_| "host runtime already initialized")?;
        start_command_reader();

        unsafe {
            api.initialize(&r_executable, r_args)?;
        }
        PARSE_API
            .set(api.parse_api())
            .map_err(|_| "parse api already initialized")?;
        EVENT_LOOP_API
            .set(api.event_loop_api())
            .map_err(|_| "event loop api already initialized")?;

        if let Some(width) = initial_console_width_from_env() {
            if let Err(error) = apply_console_width(width) {
                emit_host_error(&format!(
                    "failed to apply initial console width {width}: {error}"
                ));
            } else if let Some(runtime) = host_runtime() {
                let mut state = runtime.state.lock().expect("host state lock poisoned");
                state.current_width = Some(width);
            }
        }

        if !session_transport {
            output.emit_host_connected()?;
            output.emit_session_state(std::process::id(), false, SessionWaitState::None)?;
        }

        unsafe {
            (api.run_rmainloop)();
        }

        Ok(())
    }

    fn start_command_reader() {
        if let Some((session_file, initial_connect_grace, reconnect_grace)) =
            session_transport_config()
        {
            start_session_command_reader(session_file, initial_connect_grace, reconnect_grace);
            return;
        }

        thread::spawn(move || {
            let stdin = io::stdin();
            let mut locked = stdin.lock();
            loop {
                match read_next_command(&mut locked) {
                    Ok(Some(command)) => handle_command(command),
                    Ok(None) => {
                        request_shutdown();
                        break;
                    }
                    Err(error) => {
                        emit_host_error(&format!("backend command read failed: {error}"));
                        request_shutdown();
                        break;
                    }
                }
            }
        });
    }

    fn start_session_command_reader(
        session_file: String,
        initial_connect_grace: Duration,
        reconnect_grace: Option<Duration>,
    ) {
        thread::spawn(move || {
            let listener = match TcpListener::bind(("127.0.0.1", 0)) {
                Ok(listener) => listener,
                Err(error) => {
                    emit_host_error(&format!("backend session server bind failed: {error}"));
                    request_shutdown();
                    return;
                }
            };
            if let Err(error) = listener.set_nonblocking(true) {
                emit_host_error(&format!("backend session server setup failed: {error}"));
                request_shutdown();
                return;
            }

            let port = match listener.local_addr() {
                Ok(addr) => addr.port(),
                Err(error) => {
                    emit_host_error(&format!("backend session server address failed: {error}"));
                    request_shutdown();
                    return;
                }
            };
            if let Err(error) = write_session_bootstrap(&session_file, port, std::process::id()) {
                emit_host_error(&format!("backend session bootstrap write failed: {error}"));
                request_shutdown();
                return;
            }

            let (disconnect_tx, disconnect_rx) = mpsc::channel::<usize>();
            let current_client = Arc::new(AtomicUsize::new(0));
            let client_connected = Arc::new(AtomicBool::new(false));
            let mut next_client_id = 0_usize;
            let mut disconnect_deadline = Some(Instant::now() + initial_connect_grace);

            loop {
                let mut should_break = false;
                while let Ok(client_id) = disconnect_rx.try_recv() {
                    if current_client.load(Ordering::SeqCst) != client_id {
                        continue;
                    }
                    if let Some(runtime) = host_runtime() {
                        runtime.output.detach_client();
                    }
                    client_connected.store(false, Ordering::SeqCst);
                    if is_shutdown_requested() {
                        should_break = true;
                        break;
                    }
                    disconnect_deadline = reconnect_grace.map(|grace| Instant::now() + grace);
                }
                if should_break {
                    break;
                }

                match listener.accept() {
                    Ok((mut stream, _addr)) => {
                        if let Err(error) = stream.set_nonblocking(false) {
                            emit_host_error(&format!(
                                "backend session stream setup failed: {error}"
                            ));
                            request_shutdown();
                            break;
                        }
                        let writer = match stream.try_clone() {
                            Ok(writer) => writer,
                            Err(error) => {
                                emit_host_error(&format!(
                                    "backend session stream clone failed: {error}"
                                ));
                                request_shutdown();
                                break;
                            }
                        };
                        next_client_id = next_client_id.wrapping_add(1).max(1);
                        let client_id = next_client_id;
                        current_client.store(client_id, Ordering::SeqCst);
                        client_connected.store(true, Ordering::SeqCst);
                        disconnect_deadline = None;
                        if let Err(error) = writer.set_nonblocking(false) {
                            emit_host_error(&format!(
                                "backend session writer setup failed: {error}"
                            ));
                            request_shutdown();
                            break;
                        }
                        if let Some(runtime) = host_runtime() {
                            runtime.output.attach_client(writer);
                            emit_attached_client_state(runtime);
                        }

                        let reader_current_client = Arc::clone(&current_client);
                        let reader_disconnect_tx = disconnect_tx.clone();
                        thread::spawn(move || {
                            loop {
                                match read_next_command(&mut stream) {
                                    Ok(Some(command)) => {
                                        if reader_current_client.load(Ordering::SeqCst) != client_id
                                        {
                                            break;
                                        }
                                        handle_command(command);
                                        if is_shutdown_requested() {
                                            break;
                                        }
                                    }
                                    Ok(None) => break,
                                    Err(error) => {
                                        if reader_current_client.load(Ordering::SeqCst) == client_id
                                            && !is_expected_session_disconnect_error(&error)
                                        {
                                            emit_host_error(&format!(
                                                "backend command read failed: {error}"
                                            ));
                                        }
                                        break;
                                    }
                                }
                            }
                            let _ = reader_disconnect_tx.send(client_id);
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        if is_shutdown_requested() {
                            break;
                        }
                        if !client_connected.load(Ordering::SeqCst) {
                            if let Some(deadline) = disconnect_deadline {
                                if Instant::now() >= deadline {
                                    request_shutdown();
                                    break;
                                }
                            }
                        }
                        thread::sleep(SESSION_ACCEPT_POLL_INTERVAL);
                    }
                    Err(error) => {
                        emit_host_error(&format!("backend session accept failed: {error}"));
                        request_shutdown();
                        break;
                    }
                }
            }
            let _ = fs::remove_file(&session_file);
        });
    }

    fn session_transport_config() -> Option<(String, Duration, Option<Duration>)> {
        let session_file = std::env::var("VSC_R_BACKEND_SESSION_FILE").ok()?;
        if session_file.trim().is_empty() {
            return None;
        }
        let initial_connect_grace_ms = std::env::var("VSC_R_BACKEND_INITIAL_CONNECT_GRACE_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(60_000);
        let reconnect_grace = std::env::var("VSC_R_BACKEND_RECONNECT_GRACE_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .and_then(|value| {
                if value == 0 {
                    None
                } else {
                    Some(Duration::from_millis(value))
                }
            });
        Some((
            session_file,
            Duration::from_millis(initial_connect_grace_ms),
            reconnect_grace,
        ))
    }

    fn write_session_bootstrap(session_file: &str, port: u16, pid: u32) -> io::Result<()> {
        let payload = format!("{{\"port\":{port},\"pid\":{pid}}}");
        fs::write(session_file, payload)
    }

    fn emit_attached_client_state(runtime: &HostRuntime) {
        let pid = std::process::id();
        let _ = runtime.output.flush_backlog();
        let _ = runtime.output.emit_backend_ready();
        let _ = runtime.output.emit_host_connected();

        let (busy, wait_state) = {
            let state = runtime.state.lock().expect("host state lock poisoned");
            (state.busy, state.wait_state.clone())
        };
        let wait = match wait_state {
            Some(StoredWaitState::TopLevel(kind)) => SessionWaitState::TopLevel(kind),
            Some(StoredWaitState::Nested(prompt)) => SessionWaitState::Nested(prompt),
            None => SessionWaitState::None,
        };
        let _ = runtime.output.emit_session_state(pid, busy, wait);
        let _ = runtime.output.emit_output_flush();
    }

    fn is_expected_session_disconnect_error(error: &io::Error) -> bool {
        matches!(
            error.kind(),
            io::ErrorKind::ConnectionReset
                | io::ErrorKind::ConnectionAborted
                | io::ErrorKind::BrokenPipe
                | io::ErrorKind::UnexpectedEof
        )
    }

    fn is_shutdown_requested() -> bool {
        host_runtime()
            .map(|runtime| {
                runtime
                    .state
                    .lock()
                    .expect("host state lock poisoned")
                    .shutdown_requested
            })
            .unwrap_or(false)
    }

    fn handle_command(command: IncomingCommand) {
        match command {
            IncomingCommand::Submit(code) => queue_submit(code),
            IncomingCommand::ReplyInput(text) => queue_reply(text),
            IncomingCommand::DialogResult(result) => queue_dialog_result(result),
            IncomingCommand::ParseStatus { request_id, code } => {
                queue_parse_status(request_id, code)
            }
            IncomingCommand::Interrupt => request_interrupt(),
            IncomingCommand::SetWidth { columns } => queue_set_width(columns),
            IncomingCommand::Shutdown => request_shutdown(),
        }
    }

    fn queue_submit(code: String) {
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.suppress_idle_event_pump = false;
            state
                .pending_commands
                .push_back(PendingCommand::Submit(split_submission_lines(&code)));
            runtime.cv.notify_all();
        }
    }

    fn queue_reply(text: String) {
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.suppress_idle_event_pump = false;
            state
                .pending_commands
                .push_back(PendingCommand::Reply(encode_windows_native_text(
                    &normalize_reply_text(&text),
                )));
            runtime.cv.notify_all();
        }
    }

    fn queue_dialog_result(result: DialogResult) {
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.suppress_idle_event_pump = false;
            state.pending_dialog_result = Some(result);
            runtime.cv.notify_all();
        }
    }

    fn queue_parse_status(request_id: u32, code: String) {
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.suppress_idle_event_pump = false;
            state
                .pending_commands
                .push_back(PendingCommand::ParseStatus { request_id, code });
            runtime.cv.notify_all();
        }
    }

    fn queue_set_width(columns: u16) {
        let width = normalize_console_width(columns);
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            if state.current_width == Some(width) || state.pending_width == Some(width) {
                return;
            }
            state.pending_width = Some(width);
            runtime.cv.notify_all();
        }
    }

    fn request_interrupt() {
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.interrupt_requested = true;
            state.top_level_recovery_pending = Some(TopLevelRecovery::RecoverFromInterrupt);
            runtime.cv.notify_all();
        }

        set_r_interrupts_pending(true);
    }

    fn request_shutdown() {
        let mut should_interrupt = false;
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.shutdown_requested = true;
            should_interrupt = state.busy;
            runtime.cv.notify_all();
        }

        if should_interrupt {
            set_r_interrupts_pending(true);
        }
    }

    fn preserve_requested_interrupt() -> bool {
        let Some(runtime) = host_runtime() else {
            return false;
        };
        let state = runtime.state.lock().expect("host state lock poisoned");
        if !state.interrupt_requested {
            return false;
        }
        set_r_interrupts_pending(true);
        true
    }

    fn host_runtime() -> Option<&'static HostRuntime> {
        HOST_RUNTIME.get()
    }

    fn event_loop_api() -> Option<EventLoopApi> {
        EVENT_LOOP_API.get().copied()
    }

    fn emit_host_error(message: &str) {
        if let Some(runtime) = host_runtime() {
            let _ = runtime.output.emit_host_error(message);
        }
    }

    fn expand_r_file_name(path: &str) -> String {
        let function = R_EXPAND_FILE_NAME.load(Ordering::Relaxed);
        if function == 0 {
            return path.to_string();
        }
        let Ok(c_path) = CString::new(encode_windows_native_text(path)) else {
            return path.to_string();
        };
        let function: ExpandFileNameFn = unsafe { std::mem::transmute(function) };
        let expanded = unsafe { function(c_path.as_ptr()) };
        if expanded.is_null() {
            return path.to_string();
        }
        c_string_to_string(expanded)
    }

    fn set_r_interrupts_pending(pending: bool) {
        let ptr = R_INTERRUPTS_PENDING_PTR.load(Ordering::Relaxed) as *mut c_int;
        if ptr.is_null() {
            return;
        }
        unsafe {
            *ptr = if pending { 1 } else { 0 };
        }
    }

    fn trigger_r_user_interrupt() {
        let function = R_CHECK_USER_INTERRUPT.load(Ordering::Relaxed);
        if function == 0 {
            return;
        }

        let function: CheckUserInterruptFn = unsafe { std::mem::transmute(function) };
        unsafe {
            function();
        }
    }

    fn normalize_console_width(columns: u16) -> u16 {
        columns.max(20)
    }

    fn initial_console_width_from_env() -> Option<u16> {
        let raw = std::env::var("VSC_R_COLS").ok()?;
        let parsed = raw.parse::<u16>().ok()?;
        Some(normalize_console_width(parsed))
    }

    fn request_choose_file(new_file: bool) -> Option<String> {
        match request_dialog(DialogRequest::ChooseFile { new_file })? {
            DialogResult::ChooseFile { path } => path,
            DialogResult::EditExpression { .. } | DialogResult::EditFiles { .. } => {
                emit_host_error("unexpected edit dialog result while waiting for choose-file");
                None
            }
        }
    }

    fn request_edit_file(path: &str) -> bool {
        match request_dialog(DialogRequest::EditExpression {
            path: path.to_string(),
        }) {
            Some(DialogResult::EditExpression { completed }) => completed,
            Some(DialogResult::ChooseFile { .. }) | Some(DialogResult::EditFiles { .. }) => {
                emit_host_error(
                    "unexpected dialog result while waiting for edit() expression session",
                );
                false
            }
            None => false,
        }
    }

    fn request_edit_files(paths: &[String]) -> bool {
        match request_dialog(DialogRequest::EditFiles {
            paths: paths.to_vec(),
        }) {
            Some(DialogResult::EditFiles { completed }) => completed,
            Some(DialogResult::ChooseFile { .. }) | Some(DialogResult::EditExpression { .. }) => {
                emit_host_error("unexpected dialog result while waiting for file.edit()");
                false
            }
            None => false,
        }
    }

    fn request_dialog(request: DialogRequest) -> Option<DialogResult> {
        let runtime = host_runtime()?;
        {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.pending_dialog_result = None;
        }
        if runtime.output.emit_dialog_request(&request).is_err() {
            return None;
        }

        let mut state = runtime.state.lock().expect("host state lock poisoned");
        loop {
            if let Some(result) = state.pending_dialog_result.take() {
                return Some(result);
            }

            if state.shutdown_requested || state.interrupt_requested {
                return None;
            }

            let (next_state, _) = runtime
                .cv
                .wait_timeout(state, EVENT_POLL_INTERVAL)
                .expect("host state lock poisoned");
            state = next_state;
        }
    }

    fn pump_r_events_once() {
        let Some(api) = event_loop_api() else {
            return;
        };

        let mut context = PumpEventsContext { api };
        unsafe {
            (api.r_toplevel_exec)(
                execute_pump_events,
                &mut context as *mut PumpEventsContext as *mut c_void,
            );
        }
    }

    unsafe extern "C" fn execute_pump_events(data: *mut c_void) {
        if data.is_null() {
            return;
        }

        let context = &mut *(data as *mut PumpEventsContext);
        run_process_events(context.api);
    }

    unsafe fn run_activity_handlers(api: EventLoopApi) {
        let Some(check_activity) = api.r_check_activity else {
            return;
        };
        let Some(run_handlers) = api.r_run_handlers else {
            return;
        };
        let Some(input_handlers) = api.r_input_handlers else {
            return;
        };

        let handlers = *(input_handlers as *mut *mut c_void);
        if handlers.is_null() {
            return;
        }

        let mut handled = 0_usize;
        let mut mask = check_activity(0, 1);
        while !mask.is_null() && handled < MAX_ACTIVITY_HANDLER_DRAIN {
            run_handlers(handlers, mask);
            handled += 1;
            if preserve_requested_interrupt() {
                break;
            }
            mask = check_activity(0, 1);
        }
    }

    unsafe fn run_process_events(api: EventLoopApi) {
        // Keep the prompt-idle pump nonblocking. `GA_peekevent()` is still
        // handled by R's native callback path below, but calling it here can
        // stall the wait loop before the session webserver is serviced.
        pump_windows_messages();
        if let Some(process_events) = api.r_process_events {
            process_events();
            preserve_requested_interrupt();
        }
        run_activity_handlers(api);
        if let Some(run_pending_finalizers) = api.r_run_pending_finalizers {
            run_pending_finalizers();
            preserve_requested_interrupt();
        }
    }

    unsafe fn pump_windows_messages() {
        let mut message: MSG = std::mem::zeroed();
        while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }

    unsafe extern "C-unwind" fn process_events_callback() {
        if let Some(api) = event_loop_api() {
            if !PROCESS_EVENTS_CALLBACK_ACTIVE.swap(true, Ordering::AcqRel) {
                if let Some(peek_event) = api.ga_peekevent {
                    let mut handled = 0_usize;
                    while handled < MAX_ACTIVITY_HANDLER_DRAIN && peek_event() != 0 {
                        handled += 1;
                        if preserve_requested_interrupt() {
                            break;
                        }
                    }
                }
                pump_windows_messages();
                run_activity_handlers(api);
                PROCESS_EVENTS_CALLBACK_ACTIVE.store(false, Ordering::Release);
            }
        }
        preserve_requested_interrupt();
    }

    unsafe extern "C-unwind" fn polled_events_callback() {
        if let Some(api) = event_loop_api() {
            if !PROCESS_EVENTS_CALLBACK_ACTIVE.swap(true, Ordering::AcqRel) {
                pump_windows_messages();
                run_activity_handlers(api);
                PROCESS_EVENTS_CALLBACK_ACTIVE.store(false, Ordering::Release);
            }
        }
        preserve_requested_interrupt();
    }

    unsafe extern "C-unwind" fn read_console_callback(
        prompt: *const c_char,
        buffer: *mut c_uchar,
        buflen: c_int,
        add_history: c_int,
    ) -> c_int {
        READ_CONSOLE_INTERRUPTED.store(false, Ordering::Relaxed);

        let ret = read_console_callback_inner(prompt, buffer, buflen, add_history);

        if READ_CONSOLE_INTERRUPTED.swap(false, Ordering::Relaxed) {
            set_r_interrupts_pending(true);
            trigger_r_user_interrupt();
        }

        ret
    }

    unsafe extern "C-unwind" fn read_console_callback_inner(
        prompt: *const c_char,
        buffer: *mut c_uchar,
        buflen: c_int,
        add_history: c_int,
    ) -> c_int {
        let Some(runtime) = host_runtime() else {
            return 0;
        };

        let prompt_text = c_string_to_string(prompt);
        let wait_kind = classify_wait_kind(&prompt_text, add_history);
        let mut wait_event_emitted = false;
        set_r_interrupts_pending(false);
        let mut state = runtime.state.lock().expect("host state lock poisoned");

        loop {
            if matches!(wait_kind, WaitKind::TopLevel(_)) {
                set_r_interrupts_pending(false);
            }

            if let Some((request_id, code)) = take_next_parse_request(&mut state) {
                drop(state);
                let status = parse_status(code);
                let _ = runtime.output.emit_parse_status_result(request_id, status);
                state = runtime.state.lock().expect("host state lock poisoned");
                continue;
            }

            if let Some(width) = state.pending_width.take() {
                drop(state);
                if let Err(error) = apply_console_width(width) {
                    emit_host_error(&format!("failed to apply console width {width}: {error}"));
                } else {
                    let mut next_state = runtime.state.lock().expect("host state lock poisoned");
                    next_state.current_width = Some(width);
                    state = next_state;
                    continue;
                }
                state = runtime.state.lock().expect("host state lock poisoned");
                continue;
            }

            if let Some(fragment) = state.pending_fragment.take() {
                let signal_input_end = state.pending_fragment_from_nested;
                state.pending_fragment_from_nested = false;
                state.wait_state = None;
                return write_read_buffer(
                    buffer,
                    buflen,
                    fragment,
                    &mut state,
                    signal_input_end,
                    &runtime.output,
                );
            }

            if should_return_startup_input(&wait_kind, &mut state) {
                return write_read_buffer(
                    buffer,
                    buflen,
                    encode_windows_r_source_text(STARTUP_INTERRUPT_HANDLER_INPUT),
                    &mut state,
                    false,
                    &runtime.output,
                );
            }

            if should_return_top_level_recovery(&wait_kind, &mut state) {
                let recovery_input = take_top_level_recovery_input(&mut state);
                return write_read_buffer(
                    buffer,
                    buflen,
                    recovery_input,
                    &mut state,
                    false,
                    &runtime.output,
                );
            }

            if let Some(line) = take_next_line(&wait_kind, &mut state) {
                return write_read_buffer(
                    buffer,
                    buflen,
                    line.bytes,
                    &mut state,
                    line.signal_input_end,
                    &runtime.output,
                );
            }

            if state.shutdown_requested {
                state.wait_state = None;
                if matches!(wait_kind, WaitKind::Nested(_)) {
                    let _ = runtime.output.emit_input_end();
                    let _ = runtime.output.emit_output_flush();
                }
                return 0;
            }

            if state.interrupt_requested && matches!(wait_kind, WaitKind::Nested(_)) {
                state.interrupt_requested = false;
                state.top_level_recovery_pending = Some(TopLevelRecovery::RecoverFromInterrupt);
                state.wait_state = None;
                let _ = runtime.output.emit_input_end();
                let _ = runtime.output.emit_output_flush();
                READ_CONSOLE_INTERRUPTED.store(true, Ordering::Relaxed);
                return 0;
            }

            if !wait_event_emitted {
                match &wait_kind {
                    WaitKind::TopLevel(kind) => {
                        state.wait_state = Some(StoredWaitState::TopLevel(*kind));
                        let _ = runtime.output.emit_prompt(*kind);
                        let _ = runtime.output.emit_output_flush();
                    }
                    WaitKind::Nested(prompt) => {
                        state.wait_state = Some(StoredWaitState::Nested(prompt.clone()));
                        let _ = runtime.output.emit_input_request(prompt);
                        let _ = runtime.output.emit_output_flush();
                    }
                }
                wait_event_emitted = true;
            }

            let (next_state, timeout) = runtime
                .cv
                .wait_timeout(state, EVENT_POLL_INTERVAL)
                .expect("host state lock poisoned");
            state = next_state;
            if timeout.timed_out() {
                if matches!(wait_kind, WaitKind::TopLevel(_)) && state.suppress_idle_event_pump {
                    continue;
                }
                drop(state);
                pump_r_events_once();
                state = runtime.state.lock().expect("host state lock poisoned");
            }
        }
    }

    unsafe extern "C" fn write_console_ex_callback(
        text: *const c_char,
        buflen: c_int,
        otype: c_int,
    ) {
        if let Some(runtime) = host_runtime() {
            let rendered = decode_windows_console_buffer(text, buflen);
            if rendered.is_empty() {
                return;
            }
            if otype == 0 {
                let _ = runtime
                    .output
                    .emit_output(OutputStream::Stdout, rendered.as_bytes());
            } else {
                let _ = runtime
                    .output
                    .emit_output(OutputStream::Stderr, rendered.as_bytes());
            }
            let _ = runtime.output.emit_output_flush();
        }
    }

    unsafe extern "C" fn show_message_callback(text: *const c_char) {
        emit_host_error(&c_string_to_string(text));
    }

    unsafe extern "C" fn yes_no_cancel_callback(text: *const c_char) -> c_int {
        let question = c_string_to_string(text);
        if !question.is_empty() {
            emit_host_error(&format!(
                "R requested unsupported yes/no/cancel prompt, defaulting to No: {question}"
            ));
        }
        -1
    }

    unsafe extern "C" fn busy_callback(value: c_int) {
        if let Some(runtime) = host_runtime() {
            let should_preserve_interrupt;
            {
                let mut state = runtime.state.lock().expect("host state lock poisoned");
                let was_busy = state.busy;
                state.busy = value != 0;
                if value == 0 {
                    if state.top_level_recovery_active {
                        state.top_level_recovery_active = false;
                    } else if was_busy && state.top_level_recovery_pending.is_none() {
                        state.top_level_recovery_pending = Some(TopLevelRecovery::ParseNull);
                    }
                    state.suppress_idle_event_pump = state.interrupt_requested;
                    state.interrupt_requested = false;
                    set_r_interrupts_pending(false);
                } else {
                    state.wait_state = None;
                }
                should_preserve_interrupt = value != 0 && state.interrupt_requested;
            }
            if should_preserve_interrupt {
                set_r_interrupts_pending(true);
            }
            let _ = runtime.output.emit_busy(value != 0);
        }
    }

    unsafe extern "C" fn suicide_callback(text: *const c_char) {
        emit_host_error(&c_string_to_string(text));
        std::process::exit(1);
    }

    unsafe extern "C" fn choose_file_callback(
        new_file: c_int,
        buffer: *mut c_char,
        len: c_int,
    ) -> c_int {
        let Some(path) = request_choose_file(new_file != 0) else {
            if !buffer.is_null() && len > 0 {
                *buffer = 0;
            }
            return 0;
        };

        write_path_buffer(buffer, len, &path)
    }

    unsafe extern "C" fn edit_file_callback(path: *const c_char) -> c_int {
        let file_path = c_string_to_string(path);
        if file_path.is_empty() {
            return 1;
        }

        let expanded_path = expand_r_file_name(&file_path);

        if request_edit_file(&expanded_path) {
            0
        } else {
            1
        }
    }

    unsafe extern "C" fn edit_files_callback(
        count: c_int,
        paths: *const *const c_char,
        _titles: *const *const c_char,
        _editor: *const c_char,
    ) -> c_int {
        let expanded_paths = c_string_array_to_vec(paths, count)
            .into_iter()
            .map(|value| expand_r_file_name(&value))
            .collect::<Vec<_>>();
        if expanded_paths.is_empty() {
            return 1;
        }

        if request_edit_files(&expanded_paths) {
            0
        } else {
            1
        }
    }

    fn write_path_buffer(buffer: *mut c_char, len: c_int, path: &str) -> c_int {
        let bytes = encode_windows_native_text(path);
        if buffer.is_null() || len <= 0 {
            return bytes.len() as c_int;
        }

        let capacity = len as usize;
        let used = bytes.len().min(capacity.saturating_sub(1));
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), buffer as *mut u8, used);
            *(buffer.add(used)) = 0;
        }

        bytes.len() as c_int
    }

    fn take_next_line(wait_kind: &WaitKind, state: &mut SharedState) -> Option<PendingLine> {
        if let Some(line) = state.active_submission_lines.pop_front() {
            state.wait_state = None;
            return Some(PendingLine {
                bytes: line,
                signal_input_end: false,
            });
        }

        match wait_kind {
            WaitKind::TopLevel(_) => {
                let index = state
                    .pending_commands
                    .iter()
                    .position(|command| matches!(command, PendingCommand::Submit(_)))?;
                match state.pending_commands.remove(index) {
                    Some(PendingCommand::Submit(lines)) => {
                        state.active_submission_lines = lines;
                        state.wait_state = None;
                        state
                            .active_submission_lines
                            .pop_front()
                            .map(|line| PendingLine {
                                bytes: line,
                                signal_input_end: false,
                            })
                    }
                    _ => None,
                }
            }
            WaitKind::Nested(_) => {
                let index = state
                    .pending_commands
                    .iter()
                    .position(|command| matches!(command, PendingCommand::Reply(_)))?;
                match state.pending_commands.remove(index) {
                    Some(PendingCommand::Reply(bytes)) => {
                        state.wait_state = None;
                        Some(PendingLine {
                            bytes,
                            signal_input_end: true,
                        })
                    }
                    _ => None,
                }
            }
        }
    }

    fn should_return_top_level_recovery(wait_kind: &WaitKind, state: &mut SharedState) -> bool {
        if !matches!(wait_kind, WaitKind::TopLevel(PromptKind::Main)) {
            return false;
        }

        if state.top_level_recovery_active && !state.busy {
            state.top_level_recovery_active = false;
        }

        if state.top_level_recovery_pending.is_none() {
            return false;
        }
        if state.pending_fragment.is_some() || !state.active_submission_lines.is_empty() {
            return false;
        }

        state.top_level_recovery_active = true;
        true
    }

    fn should_return_startup_input(wait_kind: &WaitKind, state: &mut SharedState) -> bool {
        if !state.startup_input_pending {
            return false;
        }
        if !matches!(wait_kind, WaitKind::TopLevel(PromptKind::Main)) {
            return false;
        }
        if state.pending_fragment.is_some() || !state.active_submission_lines.is_empty() {
            return false;
        }

        state.startup_input_pending = false;
        true
    }

    fn take_top_level_recovery_input(state: &mut SharedState) -> Vec<u8> {
        match state
            .top_level_recovery_pending
            .take()
            .unwrap_or(TopLevelRecovery::ParseNull)
        {
            TopLevelRecovery::ParseNull => b" ".to_vec(),
            TopLevelRecovery::RecoverFromInterrupt => {
                b"base::invisible(base::.Last.value)".to_vec()
            }
        }
    }

    fn take_next_parse_request(state: &mut SharedState) -> Option<(u32, String)> {
        let index = state
            .pending_commands
            .iter()
            .position(|command| matches!(command, PendingCommand::ParseStatus { .. }))?;
        match state.pending_commands.remove(index) {
            Some(PendingCommand::ParseStatus { request_id, code }) => Some((request_id, code)),
            _ => None,
        }
    }

    fn write_read_buffer(
        buffer: *mut c_uchar,
        buflen: c_int,
        bytes: Vec<u8>,
        state: &mut SharedState,
        signal_input_end: bool,
        output: &OutputSink,
    ) -> c_int {
        if buffer.is_null() || buflen <= 1 {
            return 0;
        }

        let buffer_len = buflen as usize;
        let target = unsafe { std::slice::from_raw_parts_mut(buffer, buffer_len) };

        if bytes.len() < buffer_len.saturating_sub(1) {
            target[..bytes.len()].copy_from_slice(&bytes);
            target[bytes.len()] = b'\n';
            target[bytes.len() + 1] = 0;
            if signal_input_end {
                state.top_level_recovery_pending = Some(TopLevelRecovery::ParseNull);
                let _ = output.emit_input_end();
                let _ = output.emit_output_flush();
            }
            1
        } else {
            let used = buffer_len - 1;
            target[..used].copy_from_slice(&bytes[..used]);
            target[used] = 0;
            state.pending_fragment = Some(bytes[used..].to_vec());
            state.pending_fragment_from_nested = signal_input_end;
            1
        }
    }

    fn prompt_kind_from_prompt(prompt: &str) -> PromptKind {
        let trimmed = prompt.trim_end_matches(['\r', '\n']);
        if trimmed == CONT_PROMPT.trim_end() || trimmed.starts_with('+') {
            PromptKind::Cont
        } else {
            PromptKind::Main
        }
    }

    fn classify_wait_kind(prompt_text: &str, add_history: c_int) -> WaitKind {
        if add_history != 0 && is_top_level_prompt(prompt_text) {
            WaitKind::TopLevel(prompt_kind_from_prompt(prompt_text))
        } else {
            WaitKind::Nested(prompt_text.to_string())
        }
    }

    fn is_top_level_prompt(prompt: &str) -> bool {
        let trimmed = prompt.trim_end_matches(['\r', '\n']);
        trimmed == "> " || trimmed == ">" || trimmed == "+ " || trimmed == "+"
    }

    fn split_submission_lines(code: &str) -> VecDeque<Vec<u8>> {
        let normalized = normalize_newlines(code);
        let mut lines = VecDeque::new();
        for line in normalized.split('\n') {
            lines.push_back(encode_windows_r_source_text(line));
        }
        if lines.is_empty() {
            lines.push_back(Vec::new());
        }
        lines
    }

    fn decode_windows_console_buffer(text: *const c_char, buflen: c_int) -> String {
        if text.is_null() {
            return String::new();
        }

        let bytes = if buflen > 0 {
            unsafe { std::slice::from_raw_parts(text as *const u8, buflen as usize) }
        } else {
            unsafe { CStr::from_ptr(text) }.to_bytes()
        };

        decode_windows_console_text(bytes)
    }

    fn normalize_reply_text(text: &str) -> String {
        normalize_newlines(text)
            .split('\n')
            .next()
            .unwrap_or_default()
            .to_string()
    }

    fn normalize_newlines(text: &str) -> String {
        text.replace("\r\n", "\n").replace('\r', "\n")
    }

    fn c_string_to_string(text: *const c_char) -> String {
        if text.is_null() {
            return String::new();
        }
        let bytes = unsafe { CStr::from_ptr(text) }.to_bytes();
        decode_windows_console_text(bytes)
    }

    fn c_string_array_to_vec(values: *const *const c_char, count: c_int) -> Vec<String> {
        if values.is_null() || count <= 0 {
            return Vec::new();
        }

        let entries = unsafe { std::slice::from_raw_parts(values, count as usize) };
        entries
            .iter()
            .filter_map(|entry| {
                if entry.is_null() {
                    return None;
                }
                Some(c_string_to_string(*entry))
            })
            .collect()
    }

    fn parse_api() -> Option<ParseApi> {
        PARSE_API.get().copied()
    }

    fn parse_status(code: String) -> c_int {
        let trimmed = code.trim();
        if trimmed.is_empty() {
            return PARSE_STATUS_NULL;
        }

        let Some(api) = parse_api() else {
            return PARSE_STATUS_ERROR;
        };

        let Ok(code) = CString::new(encode_windows_r_source_text(&code)) else {
            return PARSE_STATUS_ERROR;
        };

        let mut context = ParseStatusContext {
            api,
            code,
            status: PARSE_STATUS_ERROR,
        };

        let executed = unsafe {
            (context.api.r_toplevel_exec)(
                execute_parse_status,
                &mut context as *mut ParseStatusContext as *mut c_void,
            )
        };
        if executed == 0 {
            return PARSE_STATUS_ERROR;
        }

        context.status
    }

    fn apply_console_width(width: u16) -> Result<(), Box<dyn Error>> {
        let Some(api) = parse_api() else {
            return Err("parse api not initialized".into());
        };

        let mut context = ApplyWidthContext {
            api,
            width: width as c_int,
            success: false,
        };

        let executed = unsafe {
            (context.api.r_toplevel_exec)(
                execute_apply_console_width,
                &mut context as *mut ApplyWidthContext as *mut c_void,
            )
        };
        if executed == 0 || !context.success {
            return Err("R rejected width update".into());
        }

        Ok(())
    }

    unsafe extern "C" fn execute_parse_status(data: *mut c_void) {
        if data.is_null() {
            return;
        }

        let context = &mut *(data as *mut ParseStatusContext);
        let mut parse_status = R_PARSE_OK;
        let text = (context.api.rf_protect)((context.api.rf_mk_string)(context.code.as_ptr()));
        let expressions = (context.api.rf_protect)((context.api.r_parse_vector)(
            text,
            -1,
            &mut parse_status,
            context.api.r_nil_value as Sexp,
        ));
        let _ = expressions;
        (context.api.rf_unprotect)(2);

        context.status = match parse_status {
            R_PARSE_OK => PARSE_STATUS_OK,
            R_PARSE_INCOMPLETE => PARSE_STATUS_INCOMPLETE,
            R_PARSE_ERROR | R_PARSE_EOF => PARSE_STATUS_ERROR,
            _ => PARSE_STATUS_ERROR,
        };
    }

    unsafe extern "C" fn execute_apply_console_width(data: *mut c_void) {
        if data.is_null() {
            return;
        }

        let context = &mut *(data as *mut ApplyWidthContext);
        let api = context.api;
        let options_symbol = (api.rf_install)(b".Options\0".as_ptr() as *const c_char);
        let width_symbol = (api.rf_install)(b"width\0".as_ptr() as *const c_char);
        let base_env = *(api.r_base_env as *mut Sexp);
        let mut node = (api.rf_find_var_in_frame)(base_env, options_symbol);

        while node != api.r_nil_value as Sexp {
            if (api.tag)(node) == width_symbol {
                let value = (api.rf_protect)((api.rf_scalar_integer)(context.width));
                let _ = (api.setcar)(node, value);
                (api.rf_unprotect)(1);
                context.success = true;
                return;
            }
            node = (api.cdr)(node);
        }
    }

    fn resolve_r_layout(r_executable: &Path) -> Result<RLayout, Box<dyn Error>> {
        let r_home = resolve_r_home(r_executable)?;
        let mut candidates = Vec::new();

        if let Some(arch) = normalize_r_arch(std::env::var("R_ARCH").ok().as_deref()) {
            candidates.push(r_home.join("bin").join(&arch));
        }

        let normalized = r_executable
            .canonicalize()
            .unwrap_or_else(|_| r_executable.to_path_buf());
        if let Some(parent) = normalized.parent() {
            candidates.push(parent.to_path_buf());
        }

        #[cfg(target_arch = "x86_64")]
        candidates.push(r_home.join("bin").join("x64"));
        #[cfg(target_arch = "aarch64")]
        candidates.push(r_home.join("bin").join("arm64"));
        candidates.push(r_home.join("bin"));

        let mut seen = Vec::<PathBuf>::new();
        for dll_dir in candidates {
            if !dll_dir.is_dir() || seen.iter().any(|existing| existing == &dll_dir) {
                continue;
            }
            seen.push(dll_dir.clone());

            let library_path = dll_dir.join("R.dll");
            if library_path.is_file() {
                return Ok(RLayout {
                    dll_dir,
                    library_path,
                });
            }
        }

        Err(format!(
            "R shared library not found under {}",
            r_home.join("bin").display()
        )
        .into())
    }

    fn normalize_r_arch(value: Option<&str>) -> Option<String> {
        let trimmed = value?.trim().trim_start_matches('/');
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    fn resolve_r_home(r_executable: &Path) -> Result<PathBuf, Box<dyn Error>> {
        if let Some(configured) = std::env::var_os("R_HOME") {
            let configured = PathBuf::from(configured);
            if configured.is_dir() {
                return Ok(configured);
            }
        }

        let normalized = r_executable
            .canonicalize()
            .unwrap_or_else(|_| r_executable.to_path_buf());
        let Some(parent) = normalized.parent() else {
            return Err("R executable has no parent directory".into());
        };

        let parent_name = parent
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(parent_name.as_str(), "x64" | "arm64" | "i386") {
            let Some(bin_dir) = parent.parent() else {
                return Err("failed to derive R_HOME from executable path".into());
            };
            if bin_dir
                .file_name()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("bin"))
                == Some(true)
            {
                let Some(r_home) = bin_dir.parent() else {
                    return Err("failed to derive R_HOME from executable path".into());
                };
                return Ok(r_home.to_path_buf());
            }
        }

        if parent
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("bin"))
            == Some(true)
        {
            let Some(r_home) = parent.parent() else {
                return Err("failed to derive R_HOME from executable path".into());
            };
            return Ok(r_home.to_path_buf());
        }

        Err("failed to derive R_HOME from executable path".into())
    }

    fn decode_windows_code_page(bytes: &[u8]) -> String {
        decode_windows_code_page_with(bytes, current_windows_code_page())
    }

    fn decode_windows_code_page_with(bytes: &[u8], code_page: u32) -> String {
        if bytes.is_empty() {
            return String::new();
        }

        unsafe {
            let wide_len = MultiByteToWideChar(
                code_page,
                0,
                bytes.as_ptr(),
                bytes.len() as c_int,
                std::ptr::null_mut(),
                0,
            );
            if wide_len <= 0 {
                return String::from_utf8_lossy(bytes).into_owned();
            }

            let mut wide = vec![0_u16; wide_len as usize];
            let written = MultiByteToWideChar(
                code_page,
                0,
                bytes.as_ptr(),
                bytes.len() as c_int,
                wide.as_mut_ptr(),
                wide_len,
            );
            if written <= 0 {
                return String::from_utf8_lossy(bytes).into_owned();
            }

            String::from_utf16_lossy(&wide[..written as usize])
        }
    }

    fn current_windows_code_page() -> u32 {
        let ptr = R_LOCALE_CP_PTR.load(Ordering::Relaxed) as *const c_int;
        if !ptr.is_null() {
            let code_page = unsafe { *ptr };
            if code_page > 0 {
                return code_page as u32;
            }
        }
        CP_ACP as u32
    }

    fn decode_windows_console_text(bytes: &[u8]) -> String {
        decode_windows_console_text_with_code_page(bytes, current_windows_code_page())
    }

    fn decode_windows_console_text_with_code_page(bytes: &[u8], code_page: u32) -> String {
        if bytes.is_empty() {
            return String::new();
        }

        if find_subslice(bytes, EMBEDDED_UTF8_PREFIX).is_none() {
            if let Ok(text) = std::str::from_utf8(bytes) {
                return text.to_string();
            }
            return decode_windows_code_page_with(bytes, code_page);
        }

        let mut rendered = String::new();
        let mut remaining = bytes;

        while let Some(prefix_start) = find_subslice(remaining, EMBEDDED_UTF8_PREFIX) {
            let text_start = prefix_start + EMBEDDED_UTF8_PREFIX.len();
            let Some(suffix_offset) = find_subslice(&remaining[text_start..], EMBEDDED_UTF8_SUFFIX)
            else {
                rendered.push_str(&decode_windows_code_page_with(remaining, code_page));
                return rendered;
            };
            let text_end = text_start + suffix_offset;

            if prefix_start > 0 {
                rendered.push_str(&decode_windows_code_page_with(
                    &remaining[..prefix_start],
                    code_page,
                ));
            }

            rendered.push_str(&String::from_utf8_lossy(&remaining[text_start..text_end]));
            remaining = &remaining[text_end + EMBEDDED_UTF8_SUFFIX.len()..];
        }

        if !remaining.is_empty() {
            rendered.push_str(&decode_windows_code_page_with(remaining, code_page));
        }

        rendered
    }

    fn encode_windows_native_text(text: &str) -> Vec<u8> {
        if text.is_empty() {
            return Vec::new();
        }

        let wide: Vec<u16> = text.encode_utf16().collect();
        unsafe {
            let code_page = current_windows_code_page();
            let encoded_len = WideCharToMultiByte(
                code_page,
                0,
                wide.as_ptr(),
                wide.len() as c_int,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
                std::ptr::null_mut(),
            );
            if encoded_len <= 0 {
                return text.as_bytes().to_vec();
            }

            let mut encoded = vec![0_u8; encoded_len as usize];
            let written = WideCharToMultiByte(
                code_page,
                0,
                wide.as_ptr(),
                wide.len() as c_int,
                encoded.as_mut_ptr(),
                encoded_len,
                std::ptr::null(),
                std::ptr::null_mut(),
            );
            if written <= 0 {
                return text.as_bytes().to_vec();
            }

            encoded.truncate(written as usize);
            encoded
        }
    }

    fn encode_windows_r_source_text(text: &str) -> Vec<u8> {
        encode_windows_r_source_text_with_code_page(text, current_windows_code_page())
    }

    fn encode_windows_r_source_text_with_code_page(text: &str, code_page: u32) -> Vec<u8> {
        if text.is_empty() {
            return Vec::new();
        }

        if code_page == 65001 {
            return text.as_bytes().to_vec();
        }

        let mut encoded = Vec::with_capacity(text.len());
        for ch in text.chars() {
            if let Some(bytes) = encode_windows_scalar_with_code_page(ch, code_page) {
                encoded.extend_from_slice(&bytes);
            } else if (ch as u32) <= 0xffff {
                encoded.extend_from_slice(format!("\\u{:04x}", ch as u32).as_bytes());
            } else {
                encoded.extend_from_slice(format!("\\U{:08x}", ch as u32).as_bytes());
            }
        }

        encoded
    }

    fn encode_windows_scalar_with_code_page(ch: char, code_page: u32) -> Option<Vec<u8>> {
        let mut wide = [0_u16; 2];
        let wide = ch.encode_utf16(&mut wide);
        let flags = WC_NO_BEST_FIT_CHARS;
        let mut used_default = 0;

        unsafe {
            let encoded_len = WideCharToMultiByte(
                code_page,
                flags,
                wide.as_ptr(),
                wide.len() as c_int,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
                &mut used_default,
            );
            if encoded_len <= 0 || used_default != 0 {
                return None;
            }

            let mut encoded = vec![0_u8; encoded_len as usize];
            let written = WideCharToMultiByte(
                code_page,
                flags,
                wide.as_ptr(),
                wide.len() as c_int,
                encoded.as_mut_ptr(),
                encoded_len,
                std::ptr::null(),
                &mut used_default,
            );
            if written <= 0 || used_default != 0 {
                return None;
            }

            let wide_len = MultiByteToWideChar(
                code_page,
                0,
                encoded.as_ptr(),
                written,
                std::ptr::null_mut(),
                0,
            );
            if wide_len != wide.len() as c_int {
                return None;
            }

            let mut round_trip = vec![0_u16; wide_len as usize];
            let converted = MultiByteToWideChar(
                code_page,
                0,
                encoded.as_ptr(),
                written,
                round_trip.as_mut_ptr(),
                wide_len,
            );
            if converted != wide_len || round_trip.as_slice() != wide {
                return None;
            }

            encoded.truncate(written as usize);
            Some(encoded)
        }
    }

    fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        if needle.is_empty() || haystack.len() < needle.len() {
            return None;
        }

        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    fn get_r_user_home(get_r_user: Option<GetRUserFn>) -> String {
        if let Some(function) = get_r_user {
            let result = unsafe { function() };
            if !result.is_null() {
                let bytes = unsafe { CStr::from_ptr(result) }.to_bytes();
                if let Ok(path) = std::str::from_utf8(bytes) {
                    return path.to_string();
                }
                return decode_windows_code_page(bytes);
            }
        }

        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string())
    }

    fn configure_r_start_defaults(r_start: &mut RStart, r_args: &[String]) {
        r_start.r_quiet = if r_args.iter().any(|arg| arg == "--quiet") {
            R_TRUE
        } else {
            R_FALSE
        };
        r_start.r_no_echo = if r_args
            .iter()
            .any(|arg| arg == "--no-echo" || arg == "--slave")
        {
            R_TRUE
        } else {
            R_FALSE
        };
        r_start.r_interactive = R_TRUE;
        r_start.r_verbose = if r_args.iter().any(|arg| arg == "--verbose") {
            R_TRUE
        } else {
            R_FALSE
        };
        r_start.load_site_file = if r_args.iter().any(|arg| arg == "--no-site-file") {
            R_FALSE
        } else {
            R_TRUE
        };
        r_start.load_init_file = if r_args.iter().any(|arg| arg == "--no-init-file") {
            R_FALSE
        } else {
            R_TRUE
        };
        r_start.restore_action = if r_args.iter().any(|arg| arg == "--no-restore") {
            StartupAction::NoRestore
        } else {
            StartupAction::Restore
        };
        r_start.save_action = if r_args.iter().any(|arg| arg == "--no-save") {
            StartupAction::NoSave
        } else if r_args.iter().any(|arg| arg == "--save") {
            StartupAction::Save
        } else {
            StartupAction::SaveAsk
        };
    }

    impl RApi {
        unsafe fn load(layout: &RLayout) -> Result<Self, Box<dyn Error>> {
            let mut support_libraries = Vec::new();
            let rgraphapp_path = layout.dll_dir.join("Rgraphapp.dll");
            let rgraphapp_library = load_windows_library(&rgraphapp_path)?;
            let ga_initapp = load_optional_function(&rgraphapp_library, b"GA_initapp\0");
            let ga_peekevent = load_optional_function(&rgraphapp_library, b"GA_peekevent\0");
            support_libraries.push(rgraphapp_library);

            for support_name in ["Rblas.dll", "Riconv.dll", "Rlapack.dll"] {
                let support_path = layout.dll_dir.join(support_name);
                support_libraries.push(load_windows_library(&support_path)?);
            }

            let library = load_windows_library(&layout.library_path)?;

            Ok(Self {
                setup_rmainloop: load_function(&library, b"setup_Rmainloop\0")?,
                run_rmainloop: load_function(&library, b"run_Rmainloop\0")?,
                r_expand_file_name: load_function(&library, b"R_ExpandFileName\0")?,
                r_def_params: load_optional_function(&library, b"R_DefParams\0"),
                r_def_params_ex: load_optional_function(&library, b"R_DefParamsEx\0"),
                r_set_params: load_function(&library, b"R_SetParams\0")?,
                cmdlineoptions: load_optional_function(&library, b"cmdlineoptions\0"),
                r_common_command_line: load_optional_function(&library, b"R_common_command_line\0"),
                readconsolecfg: load_optional_function(&library, b"readconsolecfg\0"),
                get_r_user: load_optional_function(&library, b"getRUser\0"),
                ga_initapp,
                ga_peekevent,
                r_process_events: load_optional_function(&library, b"R_ProcessEvents\0"),
                r_run_pending_finalizers: load_optional_function(
                    &library,
                    b"R_RunPendingFinalizers\0",
                ),
                ptr_r_process_events: load_optional_global(&library, b"ptr_R_ProcessEvents\0"),
                r_polled_events: load_optional_global(&library, b"R_PolledEvents\0"),
                r_check_activity: load_optional_function(&library, b"R_checkActivity\0"),
                r_run_handlers: load_optional_function(&library, b"R_runHandlers\0"),
                r_input_handlers: load_optional_global(&library, b"R_InputHandlers\0"),
                r_interactive: load_optional_global(&library, b"R_Interactive\0"),
                r_signal_handlers: load_optional_global(&library, b"R_SignalHandlers\0"),
                r_running_as_main_program: load_optional_global(
                    &library,
                    b"R_running_as_main_program\0",
                ),
                locale_cp: load_optional_global(&library, b"localeCP\0"),
                r_interrupts_pending: load_optional_global(&library, b"UserBreak\0")
                    .or_else(|| load_optional_global(&library, b"R_interrupts_pending\0")),
                r_check_user_interrupt: load_optional_function(&library, b"R_CheckUserInterrupt\0"),
                r_cstack_limit: load_optional_global(&library, b"R_CStackLimit\0"),
                character_mode: load_optional_global(&library, b"CharacterMode\0"),
                ptr_r_choose_file: load_optional_global(&library, b"ptr_R_ChooseFile\0"),
                ptr_r_edit_file: load_optional_global(&library, b"ptr_R_EditFile\0"),
                ptr_r_edit_files: load_optional_global(&library, b"ptr_R_EditFiles\0"),
                rf_mk_string: load_function(&library, b"Rf_mkString\0")?,
                rf_install: load_function(&library, b"Rf_install\0")?,
                rf_find_var_in_frame: load_function(&library, b"Rf_findVarInFrame\0")?,
                rf_scalar_integer: load_function(&library, b"Rf_ScalarInteger\0")?,
                rf_protect: load_function(&library, b"Rf_protect\0")?,
                rf_unprotect: load_function(&library, b"Rf_unprotect\0")?,
                r_parse_vector: load_function(&library, b"R_ParseVector\0")?,
                r_toplevel_exec: load_function(&library, b"R_ToplevelExec\0")?,
                tag: load_function(&library, b"TAG\0")?,
                cdr: load_function(&library, b"CDR\0")?,
                setcar: load_function(&library, b"SETCAR\0")?,
                r_base_env_ptr: load_global(&library, b"R_BaseEnv\0")?,
                r_nil_value_ptr: load_global(&library, b"R_NilValue\0")?,
                _library: library,
                _support_libraries: support_libraries,
                _r_start_storage: None,
                _r_home_storage: None,
                _user_home_storage: None,
                _argv_storage: Vec::new(),
            })
        }

        unsafe fn initialize(
            &mut self,
            r_executable: &Path,
            r_args: &[String],
        ) -> Result<(), Box<dyn Error>> {
            if let Some(value) = self.r_running_as_main_program {
                *value = 1;
            }
            if let Some(value) = self.r_signal_handlers {
                *value = 0;
            }
            if let Some(value) = self.r_interactive {
                *value = 1;
            }
            if let Some(value) = self.locale_cp {
                R_LOCALE_CP_PTR.store(value as usize, Ordering::Relaxed);
            }
            if let Some(value) = self.r_interrupts_pending {
                R_INTERRUPTS_PENDING_PTR.store(value as usize, Ordering::Relaxed);
                *value = 0;
            }
            if let Some(function) = self.r_check_user_interrupt {
                R_CHECK_USER_INTERRUPT.store(function as usize, Ordering::Relaxed);
            }
            if let Some(value) = self.r_cstack_limit {
                *value = usize::MAX;
            }
            R_EXPAND_FILE_NAME.store(self.r_expand_file_name as usize, Ordering::Relaxed);

            let r_home = resolve_r_home(r_executable)?;
            let user_home = get_r_user_home(self.get_r_user);
            let r_home_storage = CString::new(encode_windows_native_text(
                r_home.to_string_lossy().as_ref(),
            ))?;
            let user_home_storage = CString::new(encode_windows_native_text(&user_home))?;
            let mut r_start = Box::<RStart>::new(std::mem::zeroed());

            if let Some(def_params_ex) = self.r_def_params_ex {
                def_params_ex(r_start.as_mut(), 0);
            } else if let Some(def_params) = self.r_def_params {
                def_params(r_start.as_mut());
            } else {
                return Err("R.dll does not export R_DefParams or R_DefParamsEx".into());
            }

            if let Some(cmdlineoptions) = self.cmdlineoptions {
                let program_name = CString::new(encode_windows_native_text(
                    r_executable
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("R"),
                ))?;
                let mut empty_args = vec![program_name.as_ptr() as *mut c_char];
                cmdlineoptions(empty_args.len() as c_int, empty_args.as_mut_ptr());
            }

            let mut argv_storage = build_r_args(r_executable, r_args)?;
            let mut argv = argv_storage
                .iter_mut()
                .map(|value| value.as_ptr() as *mut c_char)
                .collect::<Vec<_>>();

            if let Some(common_command_line) = self.r_common_command_line {
                let mut argc = argv.len() as c_int;
                common_command_line(&mut argc, argv.as_mut_ptr(), r_start.as_mut());
            } else {
                configure_r_start_defaults(r_start.as_mut(), r_args);
            }

            r_start.r_interactive = R_TRUE;
            r_start.character_mode = UIMode::RGui;
            r_start.read_console = Some(read_console_callback);
            r_start.write_console = None;
            r_start.write_console_ex = Some(write_console_ex_callback);
            r_start.callback = Some(process_events_callback);
            r_start.show_message = Some(show_message_callback);
            r_start.yes_no_cancel = Some(yes_no_cancel_callback);
            r_start.busy = Some(busy_callback);
            r_start.suicide = Some(suicide_callback);
            r_start.emit_embedded_utf8 = R_TRUE;
            r_start.rhome = r_home_storage.as_ptr() as *mut c_char;
            r_start.home = user_home_storage.as_ptr() as *mut c_char;

            (self.r_set_params)(r_start.as_mut());

            if let Some(value) = self.ptr_r_choose_file {
                *value = Some(choose_file_callback);
            }
            if let Some(value) = self.ptr_r_edit_file {
                *value = Some(edit_file_callback);
            }
            if let Some(value) = self.ptr_r_edit_files {
                *value = Some(edit_files_callback);
            }
            if let Some(value) = self.ptr_r_process_events {
                *value = Some(process_events_callback);
            }
            if let Some(value) = self.r_polled_events {
                *value = Some(polled_events_callback);
            }

            if let Some(ga_initapp) = self.ga_initapp {
                ga_initapp(0, std::ptr::null_mut());
            }
            if let Some(readconsolecfg) = self.readconsolecfg {
                readconsolecfg();
            }
            if let Some(value) = self.character_mode {
                *value = UIMode::LinkDLL as c_int;
            }

            self._argv_storage = argv_storage;
            self._r_home_storage = Some(r_home_storage);
            self._user_home_storage = Some(user_home_storage);
            self._r_start_storage = Some(r_start);

            (self.setup_rmainloop)();
            Ok(())
        }

        fn parse_api(&self) -> ParseApi {
            let r_nil_value = unsafe { *self.r_nil_value_ptr as usize };
            ParseApi {
                rf_mk_string: self.rf_mk_string,
                rf_install: self.rf_install,
                rf_find_var_in_frame: self.rf_find_var_in_frame,
                rf_scalar_integer: self.rf_scalar_integer,
                rf_protect: self.rf_protect,
                rf_unprotect: self.rf_unprotect,
                r_parse_vector: self.r_parse_vector,
                r_toplevel_exec: self.r_toplevel_exec,
                tag: self.tag,
                cdr: self.cdr,
                setcar: self.setcar,
                r_base_env: self.r_base_env_ptr as usize,
                r_nil_value,
            }
        }

        fn event_loop_api(&self) -> EventLoopApi {
            EventLoopApi {
                r_process_events: self.r_process_events,
                ga_peekevent: self.ga_peekevent,
                r_check_activity: self.r_check_activity,
                r_run_handlers: self.r_run_handlers,
                r_input_handlers: self.r_input_handlers.map(|value| value as usize),
                r_run_pending_finalizers: self.r_run_pending_finalizers,
                r_toplevel_exec: self.r_toplevel_exec,
            }
        }
    }

    unsafe fn load_windows_library(path: &Path) -> Result<Library, Box<dyn Error>> {
        let flags = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32;
        let library = WindowsLibrary::load_with_flags(path, flags)
            .or_else(|_| WindowsLibrary::load_with_flags(path, 0))?;
        Ok(Library::from(library))
    }

    unsafe fn load_function<T: Copy>(
        library: &Library,
        symbol: &[u8],
    ) -> Result<T, Box<dyn Error>> {
        let handle: Symbol<T> = library.get(symbol)?;
        Ok(*handle)
    }

    unsafe fn load_optional_function<T: Copy>(library: &Library, symbol: &[u8]) -> Option<T> {
        match library.get::<T>(symbol) {
            Ok(handle) => Some(*handle),
            Err(_) => None,
        }
    }

    unsafe fn load_global<T>(library: &Library, symbol: &[u8]) -> Result<*mut T, Box<dyn Error>> {
        let handle: Symbol<*mut T> = library.get(symbol)?;
        Ok(*handle)
    }

    unsafe fn load_optional_global<T>(library: &Library, symbol: &[u8]) -> Option<*mut T> {
        match library.get::<*mut T>(symbol) {
            Ok(handle) => Some(*handle),
            Err(_) => None,
        }
    }

    fn build_r_args(
        r_executable: &Path,
        r_args: &[String],
    ) -> Result<Vec<CString>, Box<dyn Error>> {
        let mut argv = Vec::with_capacity(r_args.len() + 2);
        let program_name = r_executable
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("R");
        argv.push(CString::new(encode_windows_native_text(program_name))?);

        if !r_args.iter().any(|arg| arg == "--interactive") {
            argv.push(CString::new(encode_windows_native_text("--interactive"))?);
        }

        for arg in r_args {
            argv.push(CString::new(encode_windows_native_text(arg.as_str()))?);
        }

        Ok(argv)
    }

    #[cfg(test)]
    mod tests {
        use super::{
            decode_windows_console_text_with_code_page,
            encode_windows_r_source_text_with_code_page, should_return_top_level_recovery,
            take_top_level_recovery_input, SharedState, TopLevelRecovery, WaitKind,
        };
        use crate::protocol::PromptKind;

        #[test]
        fn decodes_embedded_utf8_console_segments() {
            let bytes = b"[1] \"\x02\xff\xfehi\x03\xff\xfe\"";
            assert_eq!(
                decode_windows_console_text_with_code_page(bytes, 1252),
                "[1] \"hi\""
            );
        }

        #[test]
        fn decodes_plain_ascii_console_text() {
            let bytes = b"Packages in library C:/Program Files/R/library:";
            assert_eq!(
                decode_windows_console_text_with_code_page(bytes, 1252),
                "Packages in library C:/Program Files/R/library:"
            );
        }

        #[test]
        #[ignore = "replaced by unicode-safe regression tests below"]
        fn decodes_plain_utf8_console_text_without_markers() {
            let bytes = "[1] \"日本語\" \"🙂 emoji\"".as_bytes();
            assert_eq!(
                decode_windows_console_text_with_code_page(bytes, 1252),
                "[1] \"日本語\" \"🙂 emoji\""
            );
        }

        #[test]
        #[ignore = "replaced by unicode-safe regression tests below"]
        fn decodes_utf8_latin_text_without_markers() {
            let bytes = b"caf\xc3\xa9";
            assert_eq!(
                decode_windows_console_text_with_code_page(bytes, 1252),
                "café"
            );
        }

        #[test]
        #[ignore = "replaced by unicode-safe regression tests below"]
        fn preserves_legacy_code_page_text_when_not_utf8() {
            let bytes = b"caf\xe9";
            assert_eq!(
                decode_windows_console_text_with_code_page(bytes, 1252),
                "café"
            );
        }

        #[test]
        #[ignore = "replaced by unicode-safe regression tests below"]
        fn preserves_shift_jis_console_text() {
            let bytes = &[0x93, 0xFA, 0x96, 0x7B, 0x8C, 0xEA];
            assert_eq!(
                decode_windows_console_text_with_code_page(bytes, 932),
                "日本語"
            );
        }

        #[test]
        fn decodes_utf8_console_text_without_markers_unicode_safe() {
            let bytes = "[1] \"\u{65e5}\u{672c}\u{8a9e}\" \"\u{1f642} emoji\"".as_bytes();
            assert_eq!(
                decode_windows_console_text_with_code_page(bytes, 1252),
                "[1] \"\u{65e5}\u{672c}\u{8a9e}\" \"\u{1f642} emoji\""
            );
        }

        #[test]
        fn decodes_utf8_latin_text_without_markers_unicode_safe() {
            let bytes = b"caf\xc3\xa9";
            assert_eq!(
                decode_windows_console_text_with_code_page(bytes, 1252),
                "caf\u{e9}"
            );
        }

        #[test]
        fn preserves_legacy_code_page_text_unicode_safe() {
            let bytes = b"caf\xe9";
            assert_eq!(
                decode_windows_console_text_with_code_page(bytes, 1252),
                "caf\u{e9}"
            );
        }

        #[test]
        fn preserves_shift_jis_console_text_unicode_safe() {
            let bytes = &[0x93, 0xFA, 0x96, 0x7B, 0x8C, 0xEA];
            assert_eq!(
                decode_windows_console_text_with_code_page(bytes, 932),
                "\u{65e5}\u{672c}\u{8a9e}"
            );
        }

        #[test]
        fn decodes_mixed_code_page_and_embedded_utf8_console_text() {
            let bytes = b"caf\xe9 \x02\xff\xfe\xe6\x97\xa5\xe6\x9c\xac\xe8\xaa\x9e\x03\xff\xfe";
            assert_eq!(
                decode_windows_console_text_with_code_page(bytes, 1252),
                "caf\u{e9} \u{65e5}\u{672c}\u{8a9e}"
            );
        }

        #[test]
        fn encodes_r_source_text_with_unicode_escapes_when_code_page_cannot_represent_it() {
            assert_eq!(
                encode_windows_r_source_text_with_code_page(
                    "\u{65e5}\u{672c}\u{8a9e} \u{1f642}",
                    1252,
                ),
                b"\\u65e5\\u672c\\u8a9e \\U0001f642"
            );
        }

        #[test]
        fn top_level_recovery_runs_once_at_main_prompt() {
            let mut state = SharedState {
                top_level_recovery_pending: Some(TopLevelRecovery::ParseNull),
                ..SharedState::default()
            };
            let prompt = WaitKind::TopLevel(PromptKind::Main);

            assert!(should_return_top_level_recovery(&prompt, &mut state));
            assert_eq!(take_top_level_recovery_input(&mut state), b" ".to_vec());
            assert!(state.top_level_recovery_pending.is_none());
            assert!(state.top_level_recovery_active);

            assert!(!should_return_top_level_recovery(&prompt, &mut state));
            assert!(!state.top_level_recovery_active);
        }

        #[test]
        fn top_level_recovery_waits_for_main_prompt_without_active_input() {
            let mut state = SharedState {
                top_level_recovery_pending: Some(TopLevelRecovery::ParseNull),
                ..SharedState::default()
            };

            assert!(!should_return_top_level_recovery(
                &WaitKind::TopLevel(PromptKind::Cont),
                &mut state
            ));
            assert!(state.top_level_recovery_pending.is_some());

            assert!(!should_return_top_level_recovery(
                &WaitKind::Nested("readline> ".to_string()),
                &mut state
            ));
            assert!(state.top_level_recovery_pending.is_some());

            state.active_submission_lines.push_back(b"next".to_vec());
            assert!(!should_return_top_level_recovery(
                &WaitKind::TopLevel(PromptKind::Main),
                &mut state
            ));
            assert!(state.top_level_recovery_pending.is_some());

            state.active_submission_lines.clear();
            assert!(should_return_top_level_recovery(
                &WaitKind::TopLevel(PromptKind::Main),
                &mut state
            ));
        }

        #[test]
        fn top_level_recovery_uses_last_value_for_interrupted_evaluation() {
            let mut state = SharedState {
                top_level_recovery_pending: Some(TopLevelRecovery::RecoverFromInterrupt),
                ..SharedState::default()
            };

            assert!(should_return_top_level_recovery(
                &WaitKind::TopLevel(PromptKind::Main),
                &mut state
            ));
            assert_eq!(
                take_top_level_recovery_input(&mut state),
                b"base::invisible(base::.Last.value)".to_vec()
            );
        }

        #[test]
        fn preserves_r_source_text_bytes_when_code_page_can_represent_it() {
            assert_eq!(
                encode_windows_r_source_text_with_code_page("caf\u{e9}", 1252),
                b"caf\xe9"
            );
        }

        #[test]
        fn preserves_r_source_text_as_utf8_under_utf8_locale() {
            assert_eq!(
                encode_windows_r_source_text_with_code_page(
                    "\u{65e5}\u{672c}\u{8a9e} \u{1f642}",
                    65001,
                ),
                "\u{65e5}\u{672c}\u{8a9e} \u{1f642}".as_bytes()
            );
        }
    }
}

#[cfg(unix)]
pub(crate) use unix_host::run;
#[cfg(windows)]
pub(crate) use windows_host::run;
