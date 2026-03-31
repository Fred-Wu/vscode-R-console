#[cfg(unix)]
use libloading::os::unix::Library as UnixLibrary;
#[cfg(windows)]
use libloading::os::windows::Library as WindowsLibrary;
use libloading::Library;
use std::error::Error;
#[cfg(unix)]
use std::ffi::c_void;
use std::ffi::{c_int, CString};
#[cfg(windows)]
use std::mem::MaybeUninit;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::OnceLock;

#[cfg(windows)]
use super::c_string;
#[cfg(windows)]
use super::callbacks::host_yes_no_cancel;
use super::callbacks::{
    host_busy, host_callback, host_cleanup, host_clearerr_console, host_flush_console,
    host_read_console, host_reset_console, host_show_message, host_suicide, host_write_console_ex,
};
use super::Sexp;
#[cfg(windows)]
use super::{GetRUserFn, Rstart, UImode, R_TRUE};

#[cfg(windows)]
pub(crate) struct WindowsApi {
    pub(crate) def_params_ex: super::DefParamsExFn,
    pub(crate) set_params: super::SetParamsFn,
    pub(crate) cmdlineoptions: super::CmdLineOptionsFn,
    pub(crate) common_command_line: super::CommonCommandLineFn,
    pub(crate) readconsolecfg: super::ReadConsoleCfgFn,
    pub(crate) ga_initapp: Option<super::GAInitAppFn>,
    pub(crate) get_r_user: Option<GetRUserFn>,
    pub(crate) user_break: Option<*mut c_int>,
    pub(crate) character_mode: Option<*mut c_int>,
}

#[cfg(unix)]
pub(crate) struct UnixApi {
    pub(crate) ptr_read_console: *mut *const c_void,
    pub(crate) ptr_write_console_ex: *mut *const c_void,
    pub(crate) ptr_busy: *mut *const c_void,
    pub(crate) ptr_write_console: Option<*mut *const c_void>,
    pub(crate) ptr_show_message: Option<*mut *const c_void>,
    pub(crate) ptr_flush_console: Option<*mut *const c_void>,
    pub(crate) ptr_reset_console: Option<*mut *const c_void>,
    pub(crate) ptr_clearerr_console: Option<*mut *const c_void>,
    pub(crate) ptr_clean_up: Option<*mut *const c_void>,
    pub(crate) ptr_suicide: Option<*mut *const c_void>,
    pub(crate) ptr_process_events: Option<*mut *const c_void>,
    pub(crate) polled_events: Option<*mut *const c_void>,
    pub(crate) input_handlers: Option<*mut *mut c_void>,
    pub(crate) output_file: Option<*mut *mut c_void>,
    pub(crate) console_file: Option<*mut *mut c_void>,
    pub(crate) check_activity: Option<super::CheckActivityFn>,
    pub(crate) run_handlers: Option<super::RunHandlersFn>,
    pub(crate) interrupts_pending: Option<*mut c_int>,
}

pub(crate) struct RApi {
    pub(crate) parse_vector: super::ParseVectorFn,
    pub(crate) mk_string: super::MkStringFn,
    pub(crate) protect: super::ProtectFn,
    pub(crate) unprotect: super::UnprotectFn,
    pub(crate) toplevel_exec: super::ToplevelExecFn,
    pub(crate) parse_eval_string: super::ParseEvalStringFn,
    #[allow(dead_code)]
    pub(crate) initialize_r: super::InitializeRFn,
    pub(crate) setup_rmainloop: super::SetupRMainloopFn,
    pub(crate) run_rmainloop: super::RunRMainloopFn,
    pub(crate) process_events: Option<super::ProcessEventsFn>,
    pub(crate) onintr: Option<super::OnIntrFn>,
    global_env: *mut Sexp,
    nil_value: *mut Sexp,
    pub(crate) signal_handlers: Option<*mut c_int>,
    pub(crate) r_interactive: Option<*mut c_int>,
    #[allow(dead_code)]
    pub(crate) r_running_as_main_program: Option<*mut c_int>,
    pub(crate) r_cstacklimit: Option<*mut usize>,
    #[cfg(windows)]
    pub(crate) windows: WindowsApi,
    #[cfg(unix)]
    pub(crate) unix: UnixApi,
}

impl RApi {
    pub(crate) fn global_env(&self) -> Sexp {
        unsafe { *self.global_env }
    }

    pub(crate) fn nil_value(&self) -> Sexp {
        unsafe { *self.nil_value }
    }
}

unsafe impl Send for RApi {}
unsafe impl Sync for RApi {}

static R_API: OnceLock<RApi> = OnceLock::new();

pub(crate) fn api() -> &'static RApi {
    R_API.get().expect("R API not initialized")
}

pub(crate) fn api_is_initialized() -> bool {
    R_API.get().is_some()
}

fn leak_library(library: Library) -> &'static Library {
    Box::leak(Box::new(library))
}

#[cfg(unix)]
fn open_library(path: &Path) -> Result<Library, Box<dyn Error>> {
    Ok(
        unsafe { UnixLibrary::open(Some(path.as_os_str()), libc::RTLD_NOW | libc::RTLD_GLOBAL)? }
            .into(),
    )
}

#[cfg(windows)]
fn open_library(path: &Path) -> Result<Library, Box<dyn Error>> {
    use libloading::os::windows::{LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32};

    let flags = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32;
    Ok(unsafe { WindowsLibrary::load_with_flags(path, flags)? }.into())
}

#[cfg(not(any(unix, windows)))]
fn open_library(path: &Path) -> Result<Library, Box<dyn Error>> {
    Ok(unsafe { Library::new(path)? })
}

#[cfg(windows)]
fn preload_windows_support_libraries(
    main_library_path: &Path,
) -> Result<Option<&'static Library>, Box<dyn Error>> {
    let library_dir = main_library_path
        .parent()
        .ok_or("failed to resolve R DLL directory")?;
    let mut graphapp = None;

    // Preloading Rlapack.dll can hang on some Windows/UCRT installs during embedded startup.
    // Keep the DLL search path configured via PATH/R_HOME and let R load it on demand instead.
    for dll_name in ["Rblas.dll", "Riconv.dll", "Rgraphapp.dll"] {
        let dll_path = library_dir.join(dll_name);
        if !dll_path.exists() {
            continue;
        }
        let library = leak_library(open_library(&dll_path)?);
        if dll_name == "Rgraphapp.dll" {
            graphapp = Some(library);
        }
    }

    Ok(graphapp)
}

fn load_r_api() -> Result<RApi, Box<dyn Error>> {
    let path = resolve_r_library_path()?;
    #[cfg(windows)]
    let graphapp_library = preload_windows_support_libraries(&path)?;
    let library = leak_library(open_library(&path)?);

    let parse_vector = unsafe { load_fn::<super::ParseVectorFn>(library, b"R_ParseVector\0")? };
    let mk_string = unsafe { load_fn::<super::MkStringFn>(library, b"Rf_mkString\0")? };
    let protect = unsafe { load_fn::<super::ProtectFn>(library, b"Rf_protect\0")? };
    let unprotect = unsafe { load_fn::<super::UnprotectFn>(library, b"Rf_unprotect\0")? };
    let toplevel_exec = unsafe { load_fn::<super::ToplevelExecFn>(library, b"R_ToplevelExec\0")? };
    let parse_eval_string =
        unsafe { load_fn::<super::ParseEvalStringFn>(library, b"R_ParseEvalString\0")? };
    let initialize_r = unsafe { load_fn::<super::InitializeRFn>(library, b"Rf_initialize_R\0")? };
    let setup_rmainloop =
        unsafe { load_fn::<super::SetupRMainloopFn>(library, b"setup_Rmainloop\0")? };
    let run_rmainloop = unsafe { load_fn::<super::RunRMainloopFn>(library, b"run_Rmainloop\0")? };
    let process_events =
        unsafe { try_load_fn::<super::ProcessEventsFn>(library, b"R_ProcessEvents\0") };
    let onintr = unsafe { try_load_fn::<super::OnIntrFn>(library, b"Rf_onintr\0") };
    let global_env = unsafe { load_var::<Sexp>(library, b"R_GlobalEnv\0")? };
    let nil_value = unsafe { load_var::<Sexp>(library, b"R_NilValue\0")? };
    let signal_handlers = try_load_signal_handlers(library);
    let r_interactive = unsafe { try_load_var::<c_int>(library, b"R_Interactive\0") };
    let r_running_as_main_program =
        unsafe { try_load_var::<c_int>(library, b"R_running_as_main_program\0") };
    let r_cstacklimit = unsafe { try_load_var::<usize>(library, b"R_CStackLimit\0") };

    #[cfg(windows)]
    let windows = WindowsApi {
        def_params_ex: unsafe { load_fn::<super::DefParamsExFn>(library, b"R_DefParamsEx\0")? },
        set_params: unsafe { load_fn::<super::SetParamsFn>(library, b"R_SetParams\0")? },
        cmdlineoptions: unsafe {
            load_fn::<super::CmdLineOptionsFn>(library, b"cmdlineoptions\0")?
        },
        common_command_line: unsafe {
            load_fn::<super::CommonCommandLineFn>(library, b"R_common_command_line\0")?
        },
        readconsolecfg: unsafe {
            load_fn::<super::ReadConsoleCfgFn>(library, b"readconsolecfg\0")?
        },
        ga_initapp: graphapp_library.and_then(|graphapp| unsafe {
            try_load_fn::<super::GAInitAppFn>(graphapp, b"GA_initapp\0")
        }),
        get_r_user: unsafe { try_load_fn::<GetRUserFn>(library, b"getRUser\0") },
        user_break: unsafe { try_load_var::<c_int>(library, b"UserBreak\0") },
        character_mode: unsafe { try_load_var::<c_int>(library, b"CharacterMode\0") },
    };

    #[cfg(unix)]
    let unix = UnixApi {
        ptr_read_console: unsafe { load_var::<*const c_void>(library, b"ptr_R_ReadConsole\0")? },
        ptr_write_console_ex: unsafe {
            load_var::<*const c_void>(library, b"ptr_R_WriteConsoleEx\0")?
        },
        ptr_busy: unsafe { load_var::<*const c_void>(library, b"ptr_R_Busy\0")? },
        ptr_write_console: unsafe {
            try_load_var::<*const c_void>(library, b"ptr_R_WriteConsole\0")
        },
        ptr_show_message: unsafe { try_load_var::<*const c_void>(library, b"ptr_R_ShowMessage\0") },
        ptr_flush_console: unsafe {
            try_load_var::<*const c_void>(library, b"ptr_R_FlushConsole\0")
        },
        ptr_reset_console: unsafe {
            try_load_var::<*const c_void>(library, b"ptr_R_ResetConsole\0")
        },
        ptr_clearerr_console: unsafe {
            try_load_var::<*const c_void>(library, b"ptr_R_ClearerrConsole\0")
        },
        ptr_clean_up: unsafe { try_load_var::<*const c_void>(library, b"ptr_R_CleanUp\0") },
        ptr_suicide: unsafe { try_load_var::<*const c_void>(library, b"ptr_R_Suicide\0") },
        ptr_process_events: unsafe {
            try_load_var::<*const c_void>(library, b"ptr_R_ProcessEvents\0")
        },
        polled_events: unsafe { try_load_var::<*const c_void>(library, b"R_PolledEvents\0") },
        input_handlers: unsafe { try_load_var::<*mut c_void>(library, b"R_InputHandlers\0") },
        output_file: unsafe { try_load_var::<*mut c_void>(library, b"R_Outputfile\0") },
        console_file: unsafe { try_load_var::<*mut c_void>(library, b"R_Consolefile\0") },
        check_activity: unsafe {
            try_load_fn::<super::CheckActivityFn>(library, b"R_checkActivity\0")
        },
        run_handlers: unsafe { try_load_fn::<super::RunHandlersFn>(library, b"R_runHandlers\0") },
        interrupts_pending: unsafe { try_load_var::<c_int>(library, b"R_interrupts_pending\0") },
    };

    Ok(RApi {
        parse_vector,
        mk_string,
        protect,
        unprotect,
        toplevel_exec,
        parse_eval_string,
        initialize_r,
        setup_rmainloop,
        run_rmainloop,
        process_events,
        onintr,
        global_env,
        nil_value,
        signal_handlers,
        r_interactive,
        r_running_as_main_program,
        r_cstacklimit,
        #[cfg(windows)]
        windows,
        #[cfg(unix)]
        unix,
    })
}

fn resolve_r_library_path() -> Result<PathBuf, Box<dyn Error>> {
    let r_home = std::env::var("VSC_R_HOME")
        .ok()
        .or_else(|| std::env::var("R_HOME").ok())
        .ok_or("R_HOME not set")?;
    let mut candidates = Vec::new();
    if cfg!(windows) {
        candidates.push(Path::new(&r_home).join("bin").join("x64").join("R.dll"));
        candidates.push(Path::new(&r_home).join("bin").join("R.dll"));
    } else if cfg!(target_os = "macos") {
        candidates.push(Path::new(&r_home).join("lib").join("libR.dylib"));
    } else {
        candidates.push(Path::new(&r_home).join("lib").join("libR.so"));
    }
    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| "failed to locate libR".into())
}

fn try_load_signal_handlers(library: &'static Library) -> Option<*mut c_int> {
    unsafe {
        try_load_var::<c_int>(library, b"R_SignalHandlers_t\0")
            .or_else(|| try_load_var::<c_int>(library, b"R_SignalHandlers\0"))
    }
}

unsafe fn load_fn<T: Copy>(library: &'static Library, name: &[u8]) -> Result<T, Box<dyn Error>> {
    Ok(*unsafe { library.get::<T>(name)? })
}

unsafe fn try_load_fn<T: Copy>(library: &'static Library, name: &[u8]) -> Option<T> {
    unsafe { library.get::<T>(name).ok().map(|symbol| *symbol) }
}

unsafe fn load_var<T>(library: &'static Library, name: &[u8]) -> Result<*mut T, Box<dyn Error>> {
    Ok(*unsafe { library.get::<*mut T>(name)? })
}

unsafe fn try_load_var<T>(library: &'static Library, name: &[u8]) -> Option<*mut T> {
    unsafe { library.get::<*mut T>(name).ok().map(|symbol| *symbol) }
}

pub(crate) fn initialize_r_api() -> Result<&'static RApi, Box<dyn Error>> {
    if let Some(api) = R_API.get() {
        return Ok(api);
    }

    let api = load_r_api()?;
    let _ = R_API.set(api);
    Ok(R_API.get().expect("R API not initialized"))
}

pub(crate) fn set_interrupt_pending() {
    unsafe {
        #[cfg(unix)]
        if let Some(slot) = api().unix.interrupts_pending {
            *slot = 1;
        }

        #[cfg(windows)]
        if let Some(slot) = api().windows.user_break {
            *slot = R_TRUE;
        }
    }
}

pub(crate) unsafe fn raise_interrupt_in_read_console() -> c_int {
    set_interrupt_pending();
    if let Some(onintr) = api().onintr {
        onintr();
    }
    0
}

#[cfg(unix)]
unsafe fn install_unix_callbacks() {
    if let Some(slot) = api().unix.output_file {
        *slot = ptr::null_mut();
    }
    if let Some(slot) = api().unix.console_file {
        *slot = ptr::null_mut();
    }

    *api().unix.ptr_read_console = host_read_console as *const c_void;
    if let Some(slot) = api().unix.ptr_write_console {
        *slot = ptr::null();
    }
    *api().unix.ptr_write_console_ex = host_write_console_ex as *const c_void;
    *api().unix.ptr_busy = host_busy as *const c_void;

    if let Some(slot) = api().unix.ptr_suicide {
        *slot = host_suicide as *const c_void;
    }
    if let Some(slot) = api().unix.ptr_show_message {
        *slot = host_show_message as *const c_void;
    }
    if let Some(slot) = api().unix.ptr_flush_console {
        *slot = host_flush_console as *const c_void;
    }
    if let Some(slot) = api().unix.ptr_reset_console {
        *slot = host_reset_console as *const c_void;
    }
    if let Some(slot) = api().unix.ptr_clearerr_console {
        *slot = host_clearerr_console as *const c_void;
    }
    if let Some(slot) = api().unix.ptr_clean_up {
        *slot = host_cleanup as *const c_void;
    }
    if let Some(slot) = api().unix.ptr_process_events {
        *slot = host_callback as *const c_void;
    }
}

#[cfg(unix)]
pub(crate) fn initialize_runtime(
    _args: &[String],
    argv: &mut [CString],
) -> Result<(), Box<dyn Error>> {
    if let Some(running_as_main_program) = api().r_running_as_main_program {
        unsafe { *running_as_main_program = 1 };
    }
    if let Some(signal_handlers) = api().signal_handlers {
        unsafe { *signal_handlers = 0 };
    }

    let raw_argv = argv.iter().map(|value| value.as_ptr()).collect::<Vec<_>>();
    let status = unsafe { (api().initialize_r)(raw_argv.len() as c_int, raw_argv.as_ptr()) };
    if status < 0 {
        return Err("Rf_initialize_R failed".into());
    }

    if let Some(r_interactive) = api().r_interactive {
        unsafe { *r_interactive = 1 };
    }
    if let Some(r_cstacklimit) = api().r_cstacklimit {
        unsafe { *r_cstacklimit = usize::MAX };
    }

    unsafe { install_unix_callbacks() };
    unsafe { (api().setup_rmainloop)() };
    Ok(())
}

#[cfg(windows)]
pub(crate) fn initialize_runtime(
    args: &[String],
    _argv: &mut [CString],
) -> Result<(), Box<dyn Error>> {
    let r_home = std::env::var("VSC_R_HOME")
        .ok()
        .or_else(|| std::env::var("R_HOME").ok())
        .ok_or("R_HOME not set")?;

    if let Some(signal_handlers) = api().signal_handlers {
        unsafe { *signal_handlers = 0 };
    }

    let home = api()
        .windows
        .get_r_user
        .map(|get_r_user| unsafe { c_string(get_r_user()) })
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .unwrap_or_else(|| r_home.clone());

    let empty_arg = CString::new("R_CONSOLE_HOST")?;
    let mut empty_args = vec![empty_arg.as_ptr().cast_mut()];
    unsafe { (api().windows.cmdlineoptions)(1, empty_args.as_mut_ptr()) };

    let mut params = MaybeUninit::<Rstart>::uninit();
    let params_ptr = params.as_mut_ptr();
    unsafe { (api().windows.def_params_ex)(params_ptr, 0) };

    let mut command_args = Vec::with_capacity(args.len() + 1);
    command_args.push(CString::new("R_CONSOLE_HOST")?);
    for arg in args {
        command_args.push(CString::new(arg.as_str())?);
    }
    let mut arg_ptrs = command_args
        .iter_mut()
        .map(|value| value.as_ptr().cast_mut())
        .collect::<Vec<_>>();
    let mut argc = arg_ptrs.len() as c_int;
    unsafe { (api().windows.common_command_line)(&mut argc, arg_ptrs.as_mut_ptr(), params_ptr) };

    let r_home_ptr = CString::new(r_home)?.into_raw();
    let home_ptr = CString::new(home)?.into_raw();

    unsafe {
        (*params_ptr).r_interactive = R_TRUE;
        // Match the Windows embedded-R pattern used by ARF/Ark:
        // let R_SetParams configure the console as RGui first, then switch
        // the global CharacterMode back to LinkDLL before setup_Rmainloop().
        (*params_ptr).character_mode = UImode::RGui;
        (*params_ptr).write_console = None;
        (*params_ptr).write_console_ex = Some(host_write_console_ex);
        (*params_ptr).read_console = Some(host_read_console);
        (*params_ptr).show_message = Some(host_show_message);
        (*params_ptr).yes_no_cancel = Some(host_yes_no_cancel);
        (*params_ptr).callback = Some(host_callback);
        (*params_ptr).busy = Some(host_busy);
        // VS Code consumes UTF-8 over the sidecar protocol; preserve localized output correctly.
        (*params_ptr).emit_embedded_utf8 = R_TRUE;
        (*params_ptr).cleanup = Some(host_cleanup);
        (*params_ptr).clearerr_console = Some(host_clearerr_console);
        (*params_ptr).flush_console = Some(host_flush_console);
        (*params_ptr).reset_console = Some(host_reset_console);
        (*params_ptr).suicide = Some(host_suicide);
        (*params_ptr).rhome = r_home_ptr;
        (*params_ptr).home = home_ptr;
    }

    unsafe { (api().windows.set_params)(params_ptr) };

    if let Some(r_cstacklimit) = api().r_cstacklimit {
        unsafe { *r_cstacklimit = usize::MAX };
    }
    if let Some(r_interactive) = api().r_interactive {
        unsafe { *r_interactive = R_TRUE };
    }
    if let Some(ga_initapp) = api().windows.ga_initapp {
        unsafe { ga_initapp(0, ptr::null_mut()) };
    }
    unsafe { (api().windows.readconsolecfg)() };
    if let Some(character_mode) = api().windows.character_mode {
        unsafe { *character_mode = UImode::LinkDLL as c_int };
    }
    unsafe { (api().setup_rmainloop)() };
    Ok(())
}
