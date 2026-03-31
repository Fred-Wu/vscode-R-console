use std::io::{self, Read, Write};
use std::sync::{Mutex, OnceLock};
use std::thread;

use super::api::{api_is_initialized, set_interrupt_pending};
use super::state::{
    host_state, request_interrupt, set_shutdown_requested, AuxCommand, PendingInputRequest,
};

const FRAME_HEADER_LEN: usize = 12;

const KIND_BACKEND_READY: u16 = 1;
const KIND_HOST_CONNECTED: u16 = 2;
const KIND_CHILD_SPAWNED: u16 = 3;
const KIND_PROMPT: u16 = 4;
const KIND_BUSY: u16 = 5;
const KIND_INPUT_REQUEST: u16 = 6;
const KIND_INPUT_END: u16 = 7;
const KIND_OUTPUT: u16 = 8;
const KIND_OUTPUT_FLUSH: u16 = 9;
const KIND_PARSE_STATUS_REQUEST: u16 = 10;
const KIND_PARSE_STATUS_RESULT: u16 = 11;
const KIND_SUBMIT: u16 = 12;
const KIND_REPLY_INPUT: u16 = 13;
const KIND_INTERRUPT: u16 = 14;
const KIND_SET_WIDTH: u16 = 15;
const KIND_INPUT_BYTES: u16 = 16;
const KIND_SHUTDOWN: u16 = 17;
const KIND_HOST_ERROR: u16 = 19;

const PROTOCOL_VERSION: u32 = 2;

const BACKEND_CAPABILITIES: &[&str] = &[
    "control-channel",
    "raw-write",
    "shutdown",
    "session-control",
    "top-level-submit",
    "nested-input",
    "parse-status",
    "set-width",
];

const HOST_CAPABILITIES: &[&str] = &[
    "session-control",
    "top-level-submit",
    "nested-input",
    "parse-status",
    "set-width",
];

static PROTOCOL_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn protocol_write_lock() -> &'static Mutex<()> {
    PROTOCOL_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

fn push_u32(buffer: &mut Vec<u8>, value: u32) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn push_i32(buffer: &mut Vec<u8>, value: i32) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn push_string(buffer: &mut Vec<u8>, value: &str) {
    push_u32(buffer, value.len() as u32);
    buffer.extend_from_slice(value.as_bytes());
}

fn encode_string_list_payload(label: &str, capabilities: &[&str]) -> Vec<u8> {
    let mut payload = Vec::new();
    push_string(&mut payload, label);
    push_u32(&mut payload, capabilities.len() as u32);
    for capability in capabilities {
        push_string(&mut payload, capability);
    }
    payload
}

fn emit_frame(kind: u16, request_id: u32, payload: &[u8]) {
    let Ok(_guard) = protocol_write_lock().lock() else {
        return;
    };

    let mut stdout = io::stdout().lock();
    let mut header = [0_u8; FRAME_HEADER_LEN];
    header[..4].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    header[4..6].copy_from_slice(&kind.to_le_bytes());
    header[6..8].copy_from_slice(&0_u16.to_le_bytes());
    header[8..12].copy_from_slice(&request_id.to_le_bytes());

    let _ = stdout.write_all(&header);
    if !payload.is_empty() {
        let _ = stdout.write_all(payload);
    }
    let _ = stdout.flush();
}

fn decode_frame_header(header: [u8; FRAME_HEADER_LEN]) -> (usize, u16, u16, u32) {
    (
        u32::from_le_bytes(header[..4].try_into().unwrap_or_default()) as usize,
        u16::from_le_bytes(header[4..6].try_into().unwrap_or_default()),
        u16::from_le_bytes(header[6..8].try_into().unwrap_or_default()),
        u32::from_le_bytes(header[8..12].try_into().unwrap_or_default()),
    )
}

fn read_exact_or_eof(reader: &mut dyn Read, buffer: &mut [u8]) -> io::Result<bool> {
    let mut read = 0;
    while read < buffer.len() {
        match reader.read(&mut buffer[read..]) {
            Ok(0) if read == 0 => return Ok(false),
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "truncated protocol frame",
                ));
            }
            Ok(count) => read += count,
            Err(err) => return Err(err),
        }
    }
    Ok(true)
}

fn decode_string(payload: &[u8]) -> io::Result<String> {
    String::from_utf8(payload.to_vec())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid UTF-8 payload"))
}

fn normalize_newlines(text: &str, ensure_trailing_newline: bool) -> Vec<u8> {
    let mut normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    if ensure_trailing_newline && !normalized.ends_with('\n') {
        normalized.push('\n');
    }
    normalized.into_bytes()
}

fn normalize_input_bytes(payload: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(payload);
    normalize_newlines(&text, false)
}

fn store_submit_buffer(payload: &[u8]) -> io::Result<()> {
    let code = decode_string(payload)?;
    let normalized = normalize_newlines(&code, true);
    let (lock, cvar) = host_state();
    let mut state = lock
        .lock()
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "host state poisoned"))?;
    state.submit_buffer = Some(normalized);
    state.submit_offset = 0;
    state.pending_input_request = None;
    cvar.notify_all();
    Ok(())
}

fn store_reply_buffer(payload: &[u8]) -> io::Result<()> {
    let text = decode_string(payload)?;
    let normalized = normalize_newlines(&text, true);
    let (lock, cvar) = host_state();
    let mut state = lock
        .lock()
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "host state poisoned"))?;
    state.reply_buffer = Some(normalized);
    state.reply_offset = 0;
    state.pending_input_request = None;
    cvar.notify_all();
    Ok(())
}

fn append_raw_input_buffer(payload: &[u8]) -> io::Result<()> {
    if payload.is_empty() {
        return Ok(());
    }
    let normalized = normalize_input_bytes(payload);
    let (lock, cvar) = host_state();
    let mut state = lock
        .lock()
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "host state poisoned"))?;
    match state.raw_input_buffer.as_mut() {
        Some(buffer) => buffer.extend_from_slice(&normalized),
        None => state.raw_input_buffer = Some(normalized),
    }
    cvar.notify_all();
    Ok(())
}

fn queue_aux_command(command: AuxCommand) -> io::Result<()> {
    let (lock, cvar) = host_state();
    let mut state = lock
        .lock()
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "host state poisoned"))?;
    state.aux_commands.push_back(command);
    cvar.notify_all();
    Ok(())
}

fn handle_interrupt() {
    request_interrupt();
    if api_is_initialized() {
        set_interrupt_pending();
    }
}

fn handle_shutdown() {
    request_interrupt();
    if api_is_initialized() {
        set_interrupt_pending();
    }
    set_shutdown_requested();
}

fn handle_frame(kind: u16, request_id: u32, payload: &[u8]) -> io::Result<()> {
    match kind {
        KIND_SUBMIT => store_submit_buffer(payload),
        KIND_REPLY_INPUT => store_reply_buffer(payload),
        KIND_INTERRUPT => {
            handle_interrupt();
            Ok(())
        }
        KIND_SET_WIDTH => {
            if payload.len() != 4 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "set-width payload must be 4 bytes",
                ));
            }
            let cols = u32::from_le_bytes(payload.try_into().unwrap_or_default()) as i32;
            queue_aux_command(AuxCommand::SetWidth(cols.max(1)))
        }
        KIND_PARSE_STATUS_REQUEST => {
            let code = decode_string(payload)?;
            queue_aux_command(AuxCommand::ParseStatus { request_id, code })
        }
        KIND_INPUT_BYTES => append_raw_input_buffer(payload),
        KIND_SHUTDOWN => {
            handle_shutdown();
            Ok(())
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown protocol frame kind {kind}"),
        )),
    }
}

fn protocol_reader_main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut reader = stdin.lock();

    loop {
        let mut header = [0_u8; FRAME_HEADER_LEN];
        if !read_exact_or_eof(&mut reader, &mut header)? {
            handle_shutdown();
            return Ok(());
        }

        let (payload_len, kind, _flags, request_id) = decode_frame_header(header);
        let mut payload = vec![0_u8; payload_len];
        if payload_len > 0 {
            read_exact_or_eof(&mut reader, &mut payload)?;
        }
        handle_frame(kind, request_id, &payload)?;
    }
}

pub(crate) fn start_protocol_reader() -> io::Result<()> {
    thread::Builder::new()
        .name("r-console-protocol-reader".to_string())
        .spawn(|| {
            if let Err(err) = protocol_reader_main() {
                eprintln!("R_CONSOLE_HOST protocol reader error: {err}");
                handle_shutdown();
            }
        })
        .map(|_| ())
}

pub(crate) fn emit_backend_ready() {
    let mut payload = Vec::new();
    push_u32(&mut payload, PROTOCOL_VERSION);
    payload.extend_from_slice(&encode_string_list_payload(
        "session-host-stdio",
        BACKEND_CAPABILITIES,
    ));
    emit_frame(KIND_BACKEND_READY, 0, &payload);
}

pub(crate) fn emit_host_connected() {
    let payload = encode_string_list_payload("r-session-host", HOST_CAPABILITIES);
    emit_frame(KIND_HOST_CONNECTED, 0, &payload);
}

pub(crate) fn emit_child_spawned(pid: u32) {
    emit_frame(KIND_CHILD_SPAWNED, 0, &pid.to_le_bytes());
}

pub(crate) fn emit_prompt(kind: &str) {
    let payload = match kind {
        "cont" => [1_u8],
        _ => [0_u8],
    };
    emit_frame(KIND_PROMPT, 0, &payload);
}

pub(crate) fn emit_busy(value: bool) {
    emit_frame(KIND_BUSY, 0, &[u8::from(value)]);
}

pub(crate) fn emit_input_request(prompt: &str) {
    emit_frame(KIND_INPUT_REQUEST, 0, prompt.as_bytes());
}

pub(crate) fn emit_input_end() {
    emit_frame(KIND_INPUT_END, 0, &[]);
}

pub(crate) fn emit_output(bytes: &[u8]) {
    emit_frame(KIND_OUTPUT, 0, bytes);
}

pub(crate) fn emit_output_flush() {
    emit_frame(KIND_OUTPUT_FLUSH, 0, &[]);
}

pub(crate) fn emit_parse_status_result(request_id: u32, status: i32) {
    let mut payload = Vec::new();
    push_i32(&mut payload, status);
    emit_frame(KIND_PARSE_STATUS_RESULT, request_id, &payload);
}

pub(crate) fn emit_host_error(message: &str) {
    emit_frame(KIND_HOST_ERROR, 0, message.as_bytes());
}

pub(crate) fn pending_request_for_submit(prompt_kind: &str) -> PendingInputRequest {
    match prompt_kind {
        "cont" => PendingInputRequest::SubmitCont,
        _ => PendingInputRequest::SubmitMain,
    }
}

pub(crate) fn emit_pending_request(request: &PendingInputRequest) {
    match request {
        PendingInputRequest::SubmitMain => emit_prompt("main"),
        PendingInputRequest::SubmitCont => emit_prompt("cont"),
        PendingInputRequest::Reply(prompt) => emit_input_request(prompt),
    }
}
