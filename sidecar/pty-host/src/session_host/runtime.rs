use std::ffi::{c_char, c_void, CString};

use super::api::api;
use super::control::emit_parse_status_result;
use super::state::{host_state, AuxCommand};
use super::{Sexp, PARSE_ERROR, PARSE_NULL, PROMPT_CONT_MARKER, PROMPT_MAIN_MARKER};

struct ParseExecData {
    text: Sexp,
    status: i32,
}

unsafe extern "C" fn parse_exec_callback(data: *mut c_void) {
    let data = unsafe { &mut *(data.cast::<ParseExecData>()) };
    let parsed =
        unsafe { (api().parse_vector)(data.text, -1, &mut data.status, api().nil_value()) };
    let _ = parsed;
}

struct EvalExecData {
    code_ptr: *const c_char,
}

unsafe extern "C" fn eval_exec_callback(data: *mut c_void) {
    let data = unsafe { &*(data.cast::<EvalExecData>()) };
    let _ = unsafe { (api().parse_eval_string)(data.code_ptr, api().global_env()) };
}

fn silent_parse_status(code: &str) -> i32 {
    let c_code = match CString::new(code) {
        Ok(value) => value,
        Err(_) => return PARSE_ERROR,
    };

    let text = unsafe { (api().mk_string)(c_code.as_ptr()) };
    let protected = unsafe { (api().protect)(text) };
    let mut data = ParseExecData {
        text: protected,
        status: PARSE_NULL,
    };
    let ok = unsafe {
        (api().toplevel_exec)(
            parse_exec_callback,
            (&mut data as *mut ParseExecData).cast(),
        )
    };
    unsafe { (api().unprotect)(1) };
    if ok == 0 {
        PARSE_ERROR
    } else {
        data.status
    }
}

pub(crate) fn eval_code_safely(code: &str) {
    let c_code = match CString::new(code) {
        Ok(value) => value,
        Err(_) => return,
    };
    let mut data = EvalExecData {
        code_ptr: c_code.as_ptr(),
    };
    let _ = unsafe {
        (api().toplevel_exec)(eval_exec_callback, (&mut data as *mut EvalExecData).cast())
    };
}

pub(crate) fn apply_runtime_options() {
    let cols = std::env::var("VSC_R_COLS")
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(80);
    let code = format!(
        r#"local({{
  .vsc_prompt_main <- {main_prompt:?}
  .vsc_prompt_cont <- {cont_prompt:?}
  .vsc_base_options <- get("options", envir = baseenv(), inherits = FALSE)
  .vsc_base_warning <- get("warning", envir = baseenv(), inherits = FALSE)
  .vsc_locked_options <- function(...) {{
    dots <- list(...)
    .vsc_warn_prompt_change <- FALSE
    if (length(dots) == 1L && is.list(dots[[1L]]) && !is.object(dots[[1L]])) {{
      opts <- dots[[1L]]
      if (!is.null(names(opts))) {{
        if ("prompt" %in% names(opts)) {{
          .vsc_warn_prompt_change <- !identical(opts[["prompt"]], .vsc_prompt_main)
          opts[["prompt"]] <- .vsc_prompt_main
        }}
        if ("continue" %in% names(opts)) {{
          .vsc_warn_prompt_change <- .vsc_warn_prompt_change ||
            !identical(opts[["continue"]], .vsc_prompt_cont)
          opts[["continue"]] <- .vsc_prompt_cont
        }}
      }}
      if (.vsc_warn_prompt_change) {{
        .vsc_base_warning(
          "R Console locks options(prompt=...) and options(continue=...) while the embedded session host is active.",
          call. = FALSE,
          immediate. = TRUE
        )
      }}
      return(do.call(.vsc_base_options, list(opts)))
    }}
    if (!is.null(names(dots))) {{
      if ("prompt" %in% names(dots)) {{
        .vsc_warn_prompt_change <- !identical(dots[["prompt"]], .vsc_prompt_main)
        dots[["prompt"]] <- .vsc_prompt_main
      }}
      if ("continue" %in% names(dots)) {{
        .vsc_warn_prompt_change <- .vsc_warn_prompt_change ||
          !identical(dots[["continue"]], .vsc_prompt_cont)
        dots[["continue"]] <- .vsc_prompt_cont
      }}
    }}
    if (.vsc_warn_prompt_change) {{
      .vsc_base_warning(
        "R Console locks options(prompt=...) and options(continue=...) while the embedded session host is active.",
        call. = FALSE,
        immediate. = TRUE
      )
    }}
    do.call(.vsc_base_options, dots)
  }}
  if (bindingIsLocked("options", baseenv())) {{
    unlockBinding("options", baseenv())
  }}
  assign("options", .vsc_locked_options, envir = baseenv())
  lockBinding("options", baseenv())
  .vsc_base_options(prompt = .vsc_prompt_main, continue = .vsc_prompt_cont, width = {cols})
}})"#,
        main_prompt = PROMPT_MAIN_MARKER,
        cont_prompt = PROMPT_CONT_MARKER,
        cols = cols
    );
    eval_code_safely(&code);
}

fn apply_width_option(cols: i32) {
    let code = format!("options(width={})", cols.max(1));
    eval_code_safely(&code);
}

pub(crate) fn process_aux_command(command: AuxCommand) {
    match command {
        AuxCommand::ParseStatus { request_id, code } => {
            let status = silent_parse_status(&code);
            emit_parse_status_result(request_id, status);
        }
        AuxCommand::SetWidth(cols) => {
            apply_width_option(cols);
        }
    }
}

pub(crate) fn drain_aux_commands() {
    loop {
        let command = {
            let (lock, _) = host_state();
            match lock.lock() {
                Ok(mut state) => state.aux_commands.pop_front(),
                Err(_) => None,
            }
        };
        let Some(command) = command else {
            break;
        };
        process_aux_command(command);
    }
}
