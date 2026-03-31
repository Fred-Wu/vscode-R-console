use std::error::Error;
#[cfg(windows)]
use std::ffi::c_uchar;
use std::ffi::{c_char, c_int, c_void, CStr, CString};

#[path = "session_host/api.rs"]
mod api;
#[path = "session_host/callbacks.rs"]
mod callbacks;
#[path = "session_host/control.rs"]
mod control;
#[path = "session_host/runtime.rs"]
mod runtime;
#[path = "session_host/state.rs"]
mod state;

const PROMPT_MAIN_MARKER: &str = "\u{2}P";
const PROMPT_CONT_MARKER: &str = "\u{2}C";

const PARSE_NULL: i32 = 0;
const PARSE_ERROR: i32 = 3;

type Sexp = *mut c_void;

#[cfg(windows)]
type ReadConsoleFn = unsafe extern "C" fn(*const c_char, *mut c_uchar, c_int, c_int) -> c_int;
#[cfg(windows)]
type WriteConsoleExFn = unsafe extern "C" fn(*const c_char, c_int, c_int);
#[cfg(windows)]
type BusyFn = unsafe extern "C" fn(c_int);
#[cfg(windows)]
type ShowMessageFn = unsafe extern "C" fn(*const c_char);
#[cfg(windows)]
type FlushConsoleFn = unsafe extern "C" fn();
#[cfg(windows)]
type ResetConsoleFn = unsafe extern "C" fn();
#[cfg(windows)]
type ClearerrConsoleFn = unsafe extern "C" fn();
#[cfg(windows)]
type CallBackFn = unsafe extern "C" fn();
#[cfg(windows)]
type CleanUpFn = unsafe extern "C" fn(c_int, c_int, c_int);
#[cfg(windows)]
type SuicideFn = unsafe extern "C" fn(*const c_char);
#[cfg(windows)]
type YesNoCancelFn = unsafe extern "C" fn(*const c_char) -> c_int;
type ToplevelExecFn = unsafe extern "C" fn(unsafe extern "C" fn(*mut c_void), *mut c_void) -> c_int;
type ParseVectorFn = unsafe extern "C" fn(Sexp, c_int, *mut i32, Sexp) -> Sexp;
type MkStringFn = unsafe extern "C" fn(*const c_char) -> Sexp;
type ProtectFn = unsafe extern "C" fn(Sexp) -> Sexp;
type UnprotectFn = unsafe extern "C" fn(c_int);
type ParseEvalStringFn = unsafe extern "C" fn(*const c_char, Sexp) -> Sexp;
type InitializeRFn = unsafe extern "C" fn(c_int, *const *const c_char) -> c_int;
type SetupRMainloopFn = unsafe extern "C" fn();
type RunRMainloopFn = unsafe extern "C" fn();
type ProcessEventsFn = unsafe extern "C" fn();
type OnIntrFn = unsafe extern "C" fn();
#[cfg(unix)]
type CheckActivityFn = unsafe extern "C" fn(c_int, c_int) -> *mut c_void;
#[cfg(unix)]
type RunHandlersFn = unsafe extern "C" fn(*mut c_void, *mut c_void);
#[cfg(windows)]
type GetRUserFn = unsafe extern "C" fn() -> *const c_char;

#[cfg(windows)]
type Rboolean = c_int;
#[cfg(windows)]
const R_TRUE: Rboolean = 1;
#[cfg(windows)]
type DefParamsExFn = unsafe extern "C" fn(*mut Rstart, c_int);
#[cfg(windows)]
type SetParamsFn = unsafe extern "C" fn(*mut Rstart);
#[cfg(windows)]
type CmdLineOptionsFn = unsafe extern "C" fn(c_int, *mut *mut c_char);
#[cfg(windows)]
type CommonCommandLineFn = unsafe extern "C" fn(*mut c_int, *mut *mut c_char, *mut Rstart);
#[cfg(windows)]
type ReadConsoleCfgFn = unsafe extern "C" fn();
#[cfg(windows)]
type GAInitAppFn = unsafe extern "C" fn(c_int, *mut *mut c_char) -> c_int;

#[cfg(windows)]
#[repr(u32)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
enum UImode {
    RGui = 0,
    RTerm = 1,
    LinkDLL = 2,
}

#[cfg(windows)]
#[repr(u32)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
enum SaType {
    NoRestore = 0,
    Restore = 1,
    Default = 2,
    NoSave = 3,
    Save = 4,
    SaveAsk = 5,
    Suicide = 6,
}

#[cfg(windows)]
#[repr(C)]
struct Rstart {
    r_quiet: Rboolean,
    r_no_echo: Rboolean,
    r_interactive: Rboolean,
    r_verbose: Rboolean,
    load_site_file: Rboolean,
    load_init_file: Rboolean,
    debug_init_file: Rboolean,
    restore_action: SaType,
    save_action: SaType,
    vsize: usize,
    nsize: usize,
    max_vsize: usize,
    max_nsize: usize,
    ppsize: usize,
    bitfield: u32,
    rhome: *mut c_char,
    home: *mut c_char,
    read_console: Option<ReadConsoleFn>,
    write_console: Option<unsafe extern "C" fn(*const c_char, c_int)>,
    callback: Option<CallBackFn>,
    show_message: Option<ShowMessageFn>,
    yes_no_cancel: Option<YesNoCancelFn>,
    busy: Option<BusyFn>,
    character_mode: UImode,
    write_console_ex: Option<WriteConsoleExFn>,
    emit_embedded_utf8: Rboolean,
    cleanup: Option<CleanUpFn>,
    clearerr_console: Option<ClearerrConsoleFn>,
    flush_console: Option<FlushConsoleFn>,
    reset_console: Option<ResetConsoleFn>,
    suicide: Option<SuicideFn>,
}

fn c_string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let bytes = unsafe { CStr::from_ptr(ptr) }.to_bytes();
    #[cfg(windows)]
    {
        return match std::str::from_utf8(bytes) {
            Ok(value) => value.to_string(),
            Err(_) => decode_windows_native(bytes).into_owned(),
        };
    }
    #[cfg(not(windows))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(windows)]
fn normalize_console_output(bytes: &[u8]) -> Vec<u8> {
    let processed = if bytes
        .windows(3)
        .any(|window| (window[0] == 0x02 || window[0] == 0x03) && window[1] == 0xFF && window[2] == 0xFE)
    {
        std::borrow::Cow::Owned(strip_r_format_escapes(bytes))
    } else {
        std::borrow::Cow::Borrowed(bytes)
    };

    match std::str::from_utf8(&processed) {
        Ok(value) => value.as_bytes().to_vec(),
        Err(_) => decode_windows_native(&processed).into_owned().into_bytes(),
    }
}

#[cfg(windows)]
fn strip_r_format_escapes(input: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if index + 2 < input.len()
            && (input[index] == 0x02 || input[index] == 0x03)
            && input[index + 1] == 0xFF
            && input[index + 2] == 0xFE
        {
            index += 3;
            continue;
        }
        output.push(input[index]);
        index += 1;
    }
    output
}

#[cfg(windows)]
fn decode_windows_native(bytes: &[u8]) -> std::borrow::Cow<'_, str> {
    if bytes.is_empty() {
        return std::borrow::Cow::Borrowed("");
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetACP() -> u32;
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            multi_byte: *const u8,
            multi_byte_len: i32,
            wide_char: *mut u16,
            wide_char_len: i32,
        ) -> i32;
    }

    let code_page = unsafe { GetACP() };
    let wide_len = unsafe {
        MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            std::ptr::null_mut(),
            0,
        )
    };
    if wide_len <= 0 {
        return String::from_utf8_lossy(bytes);
    }

    let mut wide = vec![0_u16; wide_len as usize];
    let converted = unsafe {
        MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            wide.as_mut_ptr(),
            wide_len,
        )
    };
    if converted <= 0 {
        return String::from_utf8_lossy(bytes);
    }

    std::borrow::Cow::Owned(String::from_utf16_lossy(&wide[..converted as usize]))
}

fn build_r_argv(args: Vec<String>) -> Result<Vec<CString>, Box<dyn Error>> {
    let mut r_args = Vec::with_capacity(args.len() + 1);
    r_args.push(CString::new("R")?);
    #[cfg(unix)]
    let force_interactive = !args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--interactive" | "--no-echo" | "--slave" | "--ess"
        )
    });
    #[cfg(not(unix))]
    let force_interactive = false;
    if force_interactive {
        r_args.push(CString::new("--interactive")?);
    }
    for arg in args {
        r_args.push(CString::new(arg)?);
    }
    Ok(r_args)
}

pub(crate) fn run_process_main(args: Vec<String>) {
    if let Err(err) = run(args) {
        control::emit_host_error(&err.to_string());
        eprintln!("R_CONSOLE_HOST error: {err}");
        std::process::exit(1);
    }
}

fn run(args: Vec<String>) -> Result<(), Box<dyn Error>> {
    if std::env::var_os("R_HOME").is_none() {
        if let Some(value) = std::env::var_os("VSC_R_HOME") {
            std::env::set_var("R_HOME", value);
        }
    }

    control::start_protocol_reader()?;
    control::emit_backend_ready();
    control::emit_child_spawned(std::process::id());

    let _ = api::initialize_r_api()?;
    let mut r_argv = build_r_argv(args.clone())?;
    api::initialize_runtime(&args, &mut r_argv)?;
    runtime::apply_runtime_options();
    control::emit_host_connected();
    unsafe { (api::api().run_rmainloop)() };
    Ok(())
}
