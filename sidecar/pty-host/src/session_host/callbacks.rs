use std::ffi::{c_char, c_int, c_uchar};
use std::time::Duration;

#[cfg(unix)]
use super::api::{api, raise_interrupt_in_read_console};
#[cfg(windows)]
use super::api::{api, raise_interrupt_in_read_console};
use super::control::{
    emit_busy, emit_host_error, emit_input_end, emit_output, emit_output_flush,
    emit_pending_request, pending_request_for_submit,
};
use super::runtime::{drain_aux_commands, process_aux_command};
use super::state::{host_state, set_shutdown_requested, HostState, PendingInputRequest};
use super::{c_string, PROMPT_CONT_MARKER, PROMPT_MAIN_MARKER};

const INPUT_POLL_INTERVAL: Duration = Duration::from_millis(50);

fn top_level_prompt_kind(prompt_text: &str) -> Option<&'static str> {
    match prompt_text {
        PROMPT_MAIN_MARKER => Some("main"),
        PROMPT_CONT_MARKER => Some("cont"),
        _ => None,
    }
}

fn raw_input_line_ready(state: &HostState) -> bool {
    state
        .raw_input_buffer
        .as_ref()
        .is_some_and(|buffer| buffer[state.raw_input_offset..].contains(&b'\n'))
}

fn with_pending_buffer(
    is_submit: bool,
    prompt_message: &str,
    prompt_kind: Option<&str>,
) -> Option<WaitOutcome> {
    loop {
        let action = {
            let (lock, cvar) = host_state();
            let mut state = lock.lock().ok()?;

            loop {
                if state.shutdown_requested {
                    return None;
                }
                if state.interrupt_requested {
                    state.interrupt_requested = false;
                    state.pending_input_request = None;
                    break Some(WaitAction::Interrupt);
                }

                let ready = if is_submit {
                    state.submit_buffer.is_some()
                } else {
                    state.reply_buffer.is_some() || raw_input_line_ready(&state)
                };
                if ready {
                    state.pending_input_request = None;
                    break Some(WaitAction::Ready);
                }

                let request = if is_submit {
                    pending_request_for_submit(prompt_kind.unwrap_or("main"))
                } else {
                    PendingInputRequest::Reply(prompt_message.to_string())
                };
                if state.pending_input_request.as_ref() != Some(&request) {
                    emit_pending_request(&request);
                    state.pending_input_request = Some(request);
                }
                if let Some(command) = state.aux_commands.pop_front() {
                    break Some(WaitAction::Aux(command));
                }

                let wait_result = cvar.wait_timeout(state, INPUT_POLL_INTERVAL).ok()?;
                state = wait_result.0;
                if wait_result.1.timed_out() {
                    break Some(WaitAction::Pump);
                }
            }
        };

        match action? {
            WaitAction::Aux(command) => process_aux_command(command),
            WaitAction::Ready => return Some(WaitOutcome::Ready),
            WaitAction::Interrupt => return Some(WaitOutcome::Interrupt),
            WaitAction::Pump => pump_r_events_during_wait(),
        }
    }
}

enum WaitAction {
    Aux(super::state::AuxCommand),
    Interrupt,
    Pump,
    Ready,
}

enum WaitOutcome {
    Interrupt,
    Ready,
}

#[cfg(unix)]
fn pump_r_events_during_wait() {
    drain_aux_commands();
    unsafe {
        if let Some(slot) = api().unix.polled_events {
            let callback = *slot;
            if !callback.is_null() {
                let callback: unsafe extern "C" fn() = std::mem::transmute(callback);
                callback();
            }
        }
        if let Some(check_activity) = api().unix.check_activity {
            let mask = check_activity(0, 1);
            if let (Some(run_handlers), Some(input_handlers)) =
                (api().unix.run_handlers, api().unix.input_handlers)
            {
                let handlers = *input_handlers;
                if !handlers.is_null() && !mask.is_null() {
                    run_handlers(handlers, mask);
                }
            }
        }
    }
    drain_aux_commands();
}

#[cfg(not(unix))]
fn pump_r_events_during_wait() {
    drain_aux_commands();
    let mut pumped = false;
    unsafe {
        if let Some(process_events) = api().process_events {
            process_events();
            pumped = true;
        }
    }
    if !pumped {
        std::thread::sleep(INPUT_POLL_INTERVAL);
    }
    drain_aux_commands();
}

fn fill_buffer_from_pending(
    buffer_ref: &mut Option<Vec<u8>>,
    offset_ref: &mut usize,
    target: *mut c_uchar,
    length: c_int,
    emit_input_end_when_complete: bool,
) -> c_int {
    let Some(buffer_len) = buffer_ref.as_ref().map(|buffer| buffer.len()) else {
        return 0;
    };

    let mut written = 0;
    while *offset_ref < buffer_len && written < (length - 1) as usize {
        let ch = buffer_ref
            .as_ref()
            .and_then(|buffer| buffer.get(*offset_ref))
            .copied()
            .unwrap_or_default();
        unsafe { *target.add(written) = ch };
        *offset_ref += 1;
        written += 1;
        if ch == b'\n' {
            break;
        }
    }
    unsafe { *target.add(written) = 0 };

    if *offset_ref >= buffer_len {
        *buffer_ref = None;
        *offset_ref = 0;
        if emit_input_end_when_complete {
            emit_input_end();
        }
    }

    if written > 0 {
        1
    } else {
        0
    }
}

fn fill_buffer_from_raw_input(state: &mut HostState, target: *mut c_uchar, length: c_int) -> c_int {
    let Some(buffer) = state.raw_input_buffer.take() else {
        return 0;
    };

    let mut written = 0;
    let mut saw_newline = false;
    while state.raw_input_offset < buffer.len() && written < (length - 1) as usize {
        let ch = buffer[state.raw_input_offset];
        unsafe { *target.add(written) = ch };
        state.raw_input_offset += 1;
        written += 1;
        if ch == b'\n' {
            saw_newline = true;
            break;
        }
    }
    unsafe { *target.add(written) = 0 };

    if state.raw_input_offset >= buffer.len() {
        state.raw_input_offset = 0;
    } else {
        state.raw_input_buffer = Some(buffer);
    }

    if saw_newline {
        emit_input_end();
    }

    if written > 0 {
        1
    } else {
        0
    }
}

fn fill_buffer_from_state(
    is_submit: bool,
    target: *mut c_uchar,
    length: c_int,
    emit_input_end_when_complete: bool,
) -> c_int {
    if target.is_null() || length <= 1 {
        return 0;
    }

    let (lock, _) = host_state();
    let mut state = match lock.lock() {
        Ok(value) => value,
        Err(_) => return 0,
    };

    if is_submit {
        let mut buffer = state.submit_buffer.take();
        let mut offset = state.submit_offset;
        let result = fill_buffer_from_pending(
            &mut buffer,
            &mut offset,
            target,
            length,
            emit_input_end_when_complete,
        );
        state.submit_buffer = buffer;
        state.submit_offset = offset;
        return result;
    }

    let mut reply_buffer = state.reply_buffer.take();
    let mut reply_offset = state.reply_offset;
    let reply_result = fill_buffer_from_pending(
        &mut reply_buffer,
        &mut reply_offset,
        target,
        length,
        emit_input_end_when_complete,
    );
    state.reply_buffer = reply_buffer;
    state.reply_offset = reply_offset;
    if reply_result != 0 {
        return reply_result;
    }

    fill_buffer_from_raw_input(&mut state, target, length)
}

pub(crate) unsafe extern "C" fn host_read_console(
    prompt: *const c_char,
    buffer: *mut c_uchar,
    length: c_int,
    _add_to_history: c_int,
) -> c_int {
    let prompt_text = c_string(prompt);
    if let Some(prompt_kind) = top_level_prompt_kind(&prompt_text) {
        match with_pending_buffer(true, "", Some(prompt_kind)) {
            Some(WaitOutcome::Ready) => fill_buffer_from_state(true, buffer, length, false),
            Some(WaitOutcome::Interrupt) => unsafe { raise_interrupt_in_read_console() },
            None => 0,
        }
    } else {
        match with_pending_buffer(false, &prompt_text, None) {
            Some(WaitOutcome::Ready) => fill_buffer_from_state(false, buffer, length, true),
            Some(WaitOutcome::Interrupt) => unsafe { raise_interrupt_in_read_console() },
            None => 0,
        }
    }
}

pub(crate) unsafe extern "C" fn host_write_console_ex(
    buffer: *const c_char,
    length: c_int,
    _output_type: c_int,
) {
    if buffer.is_null() || length <= 0 {
        return;
    }
    let bytes = unsafe { std::slice::from_raw_parts(buffer.cast::<u8>(), length as usize) };
    #[cfg(windows)]
    let normalized = super::normalize_console_output(bytes);
    #[cfg(windows)]
    emit_output(&normalized);
    #[cfg(not(windows))]
    emit_output(bytes);
}

pub(crate) unsafe extern "C" fn host_busy(which: c_int) {
    let value = which != 0;
    let (lock, _) = host_state();
    if let Ok(mut state) = lock.lock() {
        if state.busy_state == Some(value) {
            return;
        }
        state.busy_state = Some(value);
    }
    emit_busy(value);
}

pub(crate) unsafe extern "C" fn host_show_message(message: *const c_char) {
    if message.is_null() {
        return;
    }
    emit_host_error(&c_string(message));
}

pub(crate) unsafe extern "C" fn host_flush_console() {
    emit_output_flush();
}

pub(crate) unsafe extern "C" fn host_reset_console() {}

pub(crate) unsafe extern "C" fn host_clearerr_console() {}

pub(crate) unsafe extern "C" fn host_callback() {
    drain_aux_commands();
}

pub(crate) unsafe extern "C" fn host_cleanup(
    _save_action: c_int,
    _status: c_int,
    _run_last: c_int,
) {
    set_shutdown_requested();
}

pub(crate) unsafe extern "C" fn host_suicide(message: *const c_char) {
    if !message.is_null() {
        emit_host_error(&c_string(message));
    }
    set_shutdown_requested();
}

#[cfg(windows)]
pub(crate) unsafe extern "C" fn host_yes_no_cancel(_message: *const c_char) -> c_int {
    0
}
