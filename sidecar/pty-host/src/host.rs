#[cfg(not(unix))]
use std::error::Error;

#[cfg(not(unix))]
pub(crate) fn run(_args: Vec<String>) -> Result<(), Box<dyn Error>> {
    Err("Embedded R host is not implemented for this platform yet".into())
}

#[cfg(unix)]
mod unix_host {
    use crate::protocol::{read_next_command, IncomingCommand, OutputSink, PromptKind};
    use libloading::os::unix::{Library, Symbol};
    use std::collections::VecDeque;
    use std::error::Error;
    use std::ffi::{c_char, c_int, c_uchar, c_void, CStr, CString};
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Condvar, Mutex, OnceLock};
    use std::time::Duration;

    const CONT_PROMPT: &str = "+ ";
    const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(50);

    const SUPPORTED_CAPABILITIES: &[&str] = &[
        "control-channel",
        "shutdown",
        "session-control",
        "top-level-submit",
        "nested-input",
        "parse-status",
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
    type ReadConsoleFn = unsafe extern "C" fn(*const c_char, *mut c_uchar, c_int, c_int) -> c_int;
    type WriteConsoleFn = unsafe extern "C" fn(*const c_char, c_int);
    type WriteConsoleExFn = unsafe extern "C" fn(*const c_char, c_int, c_int);
    type ShowMessageFn = unsafe extern "C" fn(*const c_char);
    type BusyFn = unsafe extern "C" fn(c_int);
    type SuicideFn = unsafe extern "C" fn(*const c_char);
    type CheckUserInterruptFn = unsafe extern "C" fn();
    type CheckActivityFn = unsafe extern "C" fn(c_int, c_int) -> *mut libc::fd_set;
    type RunHandlersFn = unsafe extern "C" fn(*mut c_void, *mut libc::fd_set);
    type Sexp = *mut c_void;
    type MkStringFn = unsafe extern "C" fn(*const c_char) -> Sexp;
    type ProtectFn = unsafe extern "C" fn(Sexp) -> Sexp;
    type UnprotectFn = unsafe extern "C" fn(c_int);
    type ParseVectorFn = unsafe extern "C" fn(Sexp, c_int, *mut c_int, Sexp) -> Sexp;
    type TopLevelExecFn =
        unsafe extern "C" fn(unsafe extern "C" fn(*mut c_void), *mut c_void) -> c_int;

    struct RApi {
        _library: Library,
        rf_initialize_r: RfInitializeR,
        setup_rmainloop: SetupRMainloop,
        run_rmainloop: RunRMainloop,
        ptr_r_write_console: Option<*mut Option<WriteConsoleFn>>,
        ptr_r_write_console_ex: *mut Option<WriteConsoleExFn>,
        ptr_r_read_console: *mut Option<ReadConsoleFn>,
        ptr_r_show_message: Option<*mut Option<ShowMessageFn>>,
        ptr_r_busy: Option<*mut Option<BusyFn>>,
        ptr_r_suicide: Option<*mut Option<SuicideFn>>,
        r_outputfile: Option<*mut *mut c_void>,
        r_consolefile: Option<*mut *mut c_void>,
        r_interactive: Option<*mut c_int>,
        r_signal_handlers: Option<*mut c_int>,
        r_running_as_main_program: Option<*mut c_int>,
        r_interrupts_pending: Option<*mut c_int>,
        r_check_user_interrupt: Option<CheckUserInterruptFn>,
        r_check_activity: CheckActivityFn,
        r_run_handlers: RunHandlersFn,
        r_input_handlers: *mut *mut c_void,
        rf_mk_string: MkStringFn,
        rf_protect: ProtectFn,
        rf_unprotect: UnprotectFn,
        r_parse_vector: ParseVectorFn,
        r_toplevel_exec: TopLevelExecFn,
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
        busy: bool,
        interrupt_requested: bool,
        suppress_idle_event_pump: bool,
        shutdown_requested: bool,
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

    #[derive(Clone, Copy)]
    struct ParseApi {
        rf_mk_string: MkStringFn,
        rf_protect: ProtectFn,
        rf_unprotect: UnprotectFn,
        r_parse_vector: ParseVectorFn,
        r_toplevel_exec: TopLevelExecFn,
        r_nil_value: usize,
    }

    #[derive(Clone, Copy)]
    struct EventLoopApi {
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
        output.emit_backend_ready()?;

        HOST_RUNTIME
            .set(HostRuntime {
                output: output.clone_handle(),
                state: Mutex::new(SharedState::default()),
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

        output.emit_child_spawned(std::process::id())?;
        output.emit_host_connected()?;

        unsafe {
            (api.run_rmainloop)();
        }

        Ok(())
    }

    fn start_command_reader() {
        std::thread::spawn(move || {
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

    fn handle_command(command: IncomingCommand) {
        match command {
            IncomingCommand::Submit(code) => queue_submit(code),
            IncomingCommand::ReplyInput(text) => queue_reply(text),
            IncomingCommand::ParseStatus { request_id, code } => queue_parse_status(request_id, code),
            IncomingCommand::Interrupt => request_interrupt(),
            IncomingCommand::SetWidth { columns } => {
                let _ = columns;
            }
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
                .push_back(PendingCommand::Reply(normalize_reply_text(&text).into_bytes()));
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

    fn request_interrupt() {
        if let Some(runtime) = host_runtime() {
            let mut state = runtime.state.lock().expect("host state lock poisoned");
            state.interrupt_requested = true;
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

    fn pump_r_events_once() {
        let Some(api) = event_loop_api() else {
            return;
        };

        set_r_interrupts_pending(false);

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
        let api = context.api;
        unsafe {
            let handlers = *(api.r_input_handlers as *mut *mut c_void);
            if handlers.is_null() {
                return;
            }

            let mask = (api.r_check_activity)(0, 1);

            #[cfg(target_os = "macos")]
            if !mask.is_null() {
                (api.r_run_handlers)(handlers, mask);
            }

            #[cfg(not(target_os = "macos"))]
            (api.r_run_handlers)(handlers, mask);
        }
    }

    unsafe extern "C" fn read_console_callback(
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

    unsafe extern "C" fn read_console_callback_inner(
        prompt: *const c_char,
        buffer: *mut c_uchar,
        buflen: c_int,
        add_history: c_int,
    ) -> c_int {
        let Some(runtime) = host_runtime() else {
            return 0;
        };

        let prompt_text = c_string_to_string(prompt);
        let wait_kind = if add_history != 0 {
            WaitKind::TopLevel(prompt_kind_from_prompt(&prompt_text))
        } else {
            WaitKind::Nested(prompt_text)
        };
        let mut wait_event_emitted = false;
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

            if let Some(fragment) = state.pending_fragment.take() {
                let signal_input_end = state.pending_fragment_from_nested;
                state.pending_fragment_from_nested = false;
                return write_read_buffer(
                    buffer,
                    buflen,
                    fragment,
                    &mut state,
                    signal_input_end,
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
                if matches!(wait_kind, WaitKind::Nested(_)) {
                    let _ = runtime.output.emit_input_end();
                    let _ = runtime.output.emit_output_flush();
                }
                return 0;
            }

            if state.interrupt_requested && matches!(wait_kind, WaitKind::Nested(_)) {
                state.interrupt_requested = false;
                let _ = runtime.output.emit_input_end();
                let _ = runtime.output.emit_output_flush();
                READ_CONSOLE_INTERRUPTED.store(true, Ordering::Relaxed);
                return 0;
            }

            if !wait_event_emitted {
                match &wait_kind {
                    WaitKind::TopLevel(kind) => {
                        let _ = runtime.output.emit_prompt(*kind);
                        let _ = runtime.output.emit_output_flush();
                    }
                    WaitKind::Nested(prompt) => {
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

    unsafe extern "C" fn write_console_ex_callback(text: *const c_char, _bufline: c_int, otype: c_int) {
        if let Some(runtime) = host_runtime() {
            let rendered = c_string_to_string(text);
            if rendered.is_empty() {
                return;
            }
            if otype == 0 {
                let _ = runtime.output.emit_output(rendered.as_bytes());
            } else {
                let _ = runtime.output.emit_host_error(&rendered);
            }
            let _ = runtime.output.emit_output_flush();
        }
    }

    unsafe extern "C" fn show_message_callback(text: *const c_char) {
        emit_host_error(&c_string_to_string(text));
    }

    unsafe extern "C" fn busy_callback(value: c_int) {
        if let Some(runtime) = host_runtime() {
            {
                let mut state = runtime.state.lock().expect("host state lock poisoned");
                state.busy = value != 0;
                if value == 0 {
                    state.suppress_idle_event_pump = state.interrupt_requested;
                    state.interrupt_requested = false;
                    set_r_interrupts_pending(false);
                }
            }
            let _ = runtime.output.emit_busy(value != 0);
        }
    }

    unsafe extern "C" fn suicide_callback(text: *const c_char) {
        emit_host_error(&c_string_to_string(text));
        std::process::exit(1);
    }

    fn take_next_line(wait_kind: &WaitKind, state: &mut SharedState) -> Option<PendingLine> {
        if let Some(line) = state.active_submission_lines.pop_front() {
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
                        state.active_submission_lines.pop_front().map(|line| PendingLine {
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
                    Some(PendingCommand::Reply(bytes)) => Some(PendingLine {
                        bytes,
                        signal_input_end: true,
                    }),
                    _ => None,
                }
            }
        }
    }

    fn take_next_parse_request(state: &mut SharedState) -> Option<(u32, String)> {
        let index = state.pending_commands.iter().position(|command| {
            matches!(command, PendingCommand::ParseStatus { .. })
        })?;
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

    unsafe extern "C" fn execute_parse_status(data: *mut c_void) {
        if data.is_null() {
            return;
        }

        let context = &mut *(data as *mut ParseStatusContext);
        let mut parse_status = R_PARSE_OK;
        let text = (context.api.rf_protect)((context.api.rf_mk_string)(context.code.as_ptr()));
        let expressions =
            (context.api.rf_protect)(
                (context.api.r_parse_vector)(
                    text,
                    -1,
                    &mut parse_status,
                    context.api.r_nil_value as Sexp,
                ),
            );
        let _ = expressions;
        (context.api.rf_unprotect)(2);

        context.status = match parse_status {
            R_PARSE_OK => PARSE_STATUS_OK,
            R_PARSE_INCOMPLETE => PARSE_STATUS_INCOMPLETE,
            R_PARSE_ERROR | R_PARSE_EOF => PARSE_STATUS_ERROR,
            _ => PARSE_STATUS_ERROR,
        };
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
            return Err(format!(
                "R shared library not found at {}",
                library_path.display()
            )
            .into());
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
                ptr_r_write_console: load_optional_global(&library, b"ptr_R_WriteConsole\0"),
                ptr_r_write_console_ex: load_global(&library, b"ptr_R_WriteConsoleEx\0")?,
                ptr_r_read_console: load_global(&library, b"ptr_R_ReadConsole\0")?,
                ptr_r_show_message: load_optional_global(&library, b"ptr_R_ShowMessage\0"),
                ptr_r_busy: load_optional_global(&library, b"ptr_R_Busy\0"),
                ptr_r_suicide: load_optional_global(&library, b"ptr_R_Suicide\0"),
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
                r_check_activity: load_function(&library, b"R_checkActivity\0")?,
                r_run_handlers: load_function(&library, b"R_runHandlers\0")?,
                r_input_handlers: load_global(&library, b"R_InputHandlers\0")?,
                rf_mk_string: load_function(&library, b"Rf_mkString\0")?,
                rf_protect: load_function(&library, b"Rf_protect\0")?,
                rf_unprotect: load_function(&library, b"Rf_unprotect\0")?,
                r_parse_vector: load_function(&library, b"R_ParseVector\0")?,
                r_toplevel_exec: load_function(&library, b"R_ToplevelExec\0")?,
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
                *value = 0;
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
            (self.setup_rmainloop)();
            Ok(())
        }

        fn parse_api(&self) -> ParseApi {
            let r_nil_value = unsafe { *self.r_nil_value_ptr as usize };
            ParseApi {
                rf_mk_string: self.rf_mk_string,
                rf_protect: self.rf_protect,
                rf_unprotect: self.rf_unprotect,
                r_parse_vector: self.r_parse_vector,
                r_toplevel_exec: self.r_toplevel_exec,
                r_nil_value,
            }
        }

        fn event_loop_api(&self) -> EventLoopApi {
            EventLoopApi {
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

    fn build_r_args(r_executable: &Path, r_args: &[String]) -> Result<Vec<CString>, Box<dyn Error>> {
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

#[cfg(unix)]
pub(crate) use unix_host::run;
