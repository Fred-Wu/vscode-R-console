use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
#[cfg(any(unix, windows))]
use std::thread;
#[cfg(unix)]
use std::{fs::File, os::fd::FromRawFd};
#[cfg(windows)]
use std::{fs::File, os::windows::io::FromRawHandle};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, DuplicateHandle, SetHandleInformation, DUPLICATE_SAME_ACCESS, HANDLE,
        HANDLE_FLAG_INHERIT,
    },
    System::{
        Console::{GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_HANDLE, STD_OUTPUT_HANDLE},
        Pipes::CreatePipe,
        Threading::GetCurrentProcess,
    },
};

pub(crate) const FRAME_HEADER_LEN: usize = 12;
pub(crate) const PROTOCOL_VERSION: u32 = 1;

const FRAME_BACKEND_READY: u16 = 1;
const FRAME_HOST_CONNECTED: u16 = 2;
const FRAME_PROMPT: u16 = 4;
const FRAME_BUSY: u16 = 5;
const FRAME_INPUT_REQUEST: u16 = 6;
const FRAME_INPUT_END: u16 = 7;
const FRAME_OUTPUT: u16 = 8;
const FRAME_OUTPUT_FLUSH: u16 = 9;
const FRAME_PARSE_STATUS_REQUEST: u16 = 10;
const FRAME_PARSE_STATUS_RESULT: u16 = 11;
const FRAME_SUBMIT: u16 = 12;
const FRAME_REPLY_INPUT: u16 = 13;
const FRAME_INTERRUPT: u16 = 14;
const FRAME_SET_WIDTH: u16 = 15;
const FRAME_DIALOG_REQUEST: u16 = 16;
const FRAME_SHUTDOWN: u16 = 17;
const FRAME_DIALOG_RESULT: u16 = 18;
const FRAME_HOST_ERROR: u16 = 19;
const FRAME_SESSION_STATE: u16 = 20;
const MAX_BUFFERED_FRAMES: usize = 4096;
const MAX_BUFFERED_BYTES: usize = 1_000_000;

#[derive(Debug)]
pub(crate) enum DialogRequest {
    ChooseFile { new_file: bool },
    EditExpression { path: String },
    EditFiles { paths: Vec<String> },
}

#[derive(Debug)]
pub(crate) enum DialogResult {
    ChooseFile { path: Option<String> },
    EditExpression { completed: bool },
    EditFiles { completed: bool },
}

#[derive(Debug)]
pub(crate) enum IncomingCommand {
    Submit(String),
    ReplyInput(String),
    DialogResult(DialogResult),
    ParseStatus { request_id: u32, code: String },
    Interrupt,
    SetWidth { columns: u16 },
    Shutdown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OutputStream {
    Stdout,
    Stderr,
}

pub(crate) struct OutputSink {
    output_state: Arc<Mutex<OutputChannelState>>,
    host_name: Arc<String>,
    capabilities: Arc<Vec<String>>,
}

struct OutputChannelState {
    writer: Option<Box<dyn Write + Send>>,
    backlog: VecDeque<Vec<u8>>,
    backlog_bytes: usize,
}

pub(crate) enum SessionWaitState {
    None,
    TopLevel(PromptKind),
    Nested(String),
}

impl OutputSink {
    pub(crate) fn new_with_capabilities(host_name: &str, capabilities: &[&str]) -> Self {
        Self {
            output_state: Arc::new(Mutex::new(OutputChannelState {
                writer: if session_transport_enabled() {
                    None
                } else {
                    Some(create_protocol_writer())
                },
                backlog: VecDeque::new(),
                backlog_bytes: 0,
            })),
            host_name: Arc::new(host_name.to_string()),
            capabilities: Arc::new(
                capabilities
                    .iter()
                    .map(|value| (*value).to_string())
                    .collect(),
            ),
        }
    }

    pub(crate) fn clone_handle(&self) -> Self {
        Self {
            output_state: Arc::clone(&self.output_state),
            host_name: Arc::clone(&self.host_name),
            capabilities: Arc::clone(&self.capabilities),
        }
    }

    pub(crate) fn capture_process_stdout(&self) -> io::Result<()> {
        if !session_transport_enabled() {
            return Ok(());
        }
        capture_process_stdout_to_sink(self.clone_handle())
    }

    pub(crate) fn emit_backend_ready(&self) -> io::Result<()> {
        let mut payload = Vec::new();
        payload.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
        encode_string_list(
            self.host_name.as_str(),
            self.capabilities.as_ref(),
            &mut payload,
        );
        self.emit_frame(FRAME_BACKEND_READY, 0, &payload)
    }

    pub(crate) fn emit_host_connected(&self) -> io::Result<()> {
        let mut payload = Vec::new();
        encode_string_list(
            self.host_name.as_str(),
            self.capabilities.as_ref(),
            &mut payload,
        );
        self.emit_frame(FRAME_HOST_CONNECTED, 0, &payload)
    }

    pub(crate) fn emit_prompt(&self, kind: PromptKind) -> io::Result<()> {
        let payload = [match kind {
            PromptKind::Main => 0,
            PromptKind::Cont => 1,
        }];
        self.emit_frame(FRAME_PROMPT, 0, &payload)
    }

    pub(crate) fn emit_busy(&self, value: bool) -> io::Result<()> {
        self.emit_frame(FRAME_BUSY, 0, &[if value { 1 } else { 0 }])
    }

    pub(crate) fn emit_input_request(&self, prompt: &str) -> io::Result<()> {
        self.emit_frame(FRAME_INPUT_REQUEST, 0, prompt.as_bytes())
    }

    pub(crate) fn emit_input_end(&self) -> io::Result<()> {
        self.emit_frame(FRAME_INPUT_END, 0, &[])
    }

    pub(crate) fn emit_dialog_request(&self, request: &DialogRequest) -> io::Result<()> {
        let mut payload = Vec::new();
        match request {
            DialogRequest::ChooseFile { new_file } => {
                payload.push(if *new_file { 1 } else { 0 });
            }
            DialogRequest::EditExpression { path } => {
                payload.push(2);
                encode_string(path, &mut payload);
            }
            DialogRequest::EditFiles { paths } => {
                payload.push(3);
                encode_string_array(paths, &mut payload);
            }
        }
        self.emit_frame(FRAME_DIALOG_REQUEST, 0, &payload)
    }

    pub(crate) fn emit_output(&self, stream: OutputStream, payload: &[u8]) -> io::Result<()> {
        let mut framed = Vec::with_capacity(payload.len() + 1);
        framed.push(match stream {
            OutputStream::Stdout => 0,
            OutputStream::Stderr => 1,
        });
        framed.extend_from_slice(payload);
        self.emit_frame(FRAME_OUTPUT, 0, &framed)
    }

    pub(crate) fn emit_output_flush(&self) -> io::Result<()> {
        self.emit_frame(FRAME_OUTPUT_FLUSH, 0, &[])
    }

    pub(crate) fn emit_parse_status_result(&self, request_id: u32, status: i32) -> io::Result<()> {
        self.emit_frame(FRAME_PARSE_STATUS_RESULT, request_id, &status.to_le_bytes())
    }

    pub(crate) fn emit_host_error(&self, message: &str) -> io::Result<()> {
        self.emit_frame(FRAME_HOST_ERROR, 0, message.as_bytes())
    }

    pub(crate) fn emit_session_state(
        &self,
        pid: u32,
        busy: bool,
        wait: SessionWaitState,
    ) -> io::Result<()> {
        let mut payload = Vec::new();
        payload.extend_from_slice(&pid.to_le_bytes());
        payload.push(if busy { 1 } else { 0 });
        match wait {
            SessionWaitState::None => payload.push(0),
            SessionWaitState::TopLevel(PromptKind::Main) => payload.push(1),
            SessionWaitState::TopLevel(PromptKind::Cont) => payload.push(2),
            SessionWaitState::Nested(prompt) => {
                payload.push(3);
                payload.extend_from_slice(prompt.as_bytes());
            }
        }
        self.emit_frame(FRAME_SESSION_STATE, 0, &payload)
    }

    pub(crate) fn attach_client<W: Write + Send + 'static>(&self, writer: W) {
        if let Ok(mut output_state) = self.output_state.lock() {
            output_state.writer = Some(Box::new(writer));
        }
    }

    pub(crate) fn detach_client(&self) {
        if let Ok(mut output_state) = self.output_state.lock() {
            output_state.writer = None;
        }
    }

    pub(crate) fn flush_backlog(&self) -> io::Result<()> {
        let mut output_state = self
            .output_state
            .lock()
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "stdout lock poisoned"))?;
        let Some(mut writer) = output_state.writer.take() else {
            return Ok(());
        };
        let mut backlog = std::mem::take(&mut output_state.backlog);
        output_state.backlog_bytes = 0;

        while let Some(frame) = backlog.pop_front() {
            if let Err(err) = writer.write_all(&frame) {
                queue_backlog_frame(&mut output_state, frame);
                while let Some(remaining) = backlog.pop_front() {
                    queue_backlog_frame(&mut output_state, remaining);
                }
                return Err(err);
            }
        }
        if let Err(err) = writer.flush() {
            while let Some(remaining) = backlog.pop_front() {
                queue_backlog_frame(&mut output_state, remaining);
            }
            return Err(err);
        }

        output_state.writer = Some(writer);
        Ok(())
    }

    fn emit_frame(&self, kind: u16, request_id: u32, payload: &[u8]) -> io::Result<()> {
        let mut frame = Vec::with_capacity(FRAME_HEADER_LEN + payload.len());
        frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        frame.extend_from_slice(&kind.to_le_bytes());
        frame.extend_from_slice(&0_u16.to_le_bytes());
        frame.extend_from_slice(&request_id.to_le_bytes());
        frame.extend_from_slice(payload);

        let mut output_state = self
            .output_state
            .lock()
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "stdout lock poisoned"))?;
        if let Some(writer) = output_state.writer.as_mut() {
            match writer.write_all(&frame).and_then(|_| writer.flush()) {
                Ok(()) => return Ok(()),
                Err(_) => {
                    output_state.writer = None;
                }
            }
        }

        queue_backlog_frame(&mut output_state, frame);
        Ok(())
    }
}

fn queue_backlog_frame(output_state: &mut OutputChannelState, frame: Vec<u8>) {
    output_state.backlog_bytes += frame.len();
    output_state.backlog.push_back(frame);
    while output_state.backlog.len() > MAX_BUFFERED_FRAMES
        || output_state.backlog_bytes > MAX_BUFFERED_BYTES
    {
        if let Some(removed) = output_state.backlog.pop_front() {
            output_state.backlog_bytes = output_state.backlog_bytes.saturating_sub(removed.len());
        } else {
            break;
        }
    }
}

fn session_transport_enabled() -> bool {
    matches!(
        std::env::var("VSC_R_BACKEND_SESSION_FILE"),
        Ok(value) if !value.trim().is_empty()
    )
}

#[cfg(unix)]
fn create_protocol_writer() -> Box<dyn Write + Send> {
    unsafe {
        let protocol_fd = libc::dup(libc::STDOUT_FILENO);
        if protocol_fd >= 0 {
            let current_flags = libc::fcntl(protocol_fd, libc::F_GETFD);
            if current_flags >= 0 {
                let _ = libc::fcntl(protocol_fd, libc::F_SETFD, current_flags | libc::FD_CLOEXEC);
            }

            let stdin_flags = libc::fcntl(libc::STDIN_FILENO, libc::F_GETFD);
            if stdin_flags >= 0 {
                let _ = libc::fcntl(
                    libc::STDIN_FILENO,
                    libc::F_SETFD,
                    stdin_flags | libc::FD_CLOEXEC,
                );
            }

            if libc::dup2(libc::STDERR_FILENO, libc::STDOUT_FILENO) >= 0 {
                return Box::new(File::from_raw_fd(protocol_fd));
            }

            let _ = libc::close(protocol_fd);
        }
    }

    Box::new(io::stdout())
}

#[cfg(unix)]
fn capture_process_stdout_to_sink(output: OutputSink) -> io::Result<()> {
    capture_unix_fd_to_sink(
        output.clone_handle(),
        libc::STDOUT_FILENO,
        OutputStream::Stdout,
    )?;
    capture_unix_fd_to_sink(output, libc::STDERR_FILENO, OutputStream::Stderr)?;
    Ok(())
}

#[cfg(unix)]
fn capture_unix_fd_to_sink(
    output: OutputSink,
    fd: libc::c_int,
    stream: OutputStream,
) -> io::Result<()> {
    unsafe {
        let mut fds = [0; 2];
        if libc::pipe(fds.as_mut_ptr()) != 0 {
            return Err(io::Error::last_os_error());
        }

        let read_fd = fds[0];
        let write_fd = fds[1];

        let read_flags = libc::fcntl(read_fd, libc::F_GETFD);
        if read_flags >= 0 {
            let _ = libc::fcntl(read_fd, libc::F_SETFD, read_flags | libc::FD_CLOEXEC);
        }

        if libc::dup2(write_fd, fd) < 0 {
            let error = io::Error::last_os_error();
            let _ = libc::close(read_fd);
            let _ = libc::close(write_fd);
            return Err(error);
        }
        let _ = libc::close(write_fd);

        thread::spawn(move || {
            let mut reader = File::from_raw_fd(read_fd);
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let _ = output.emit_output(stream, &buffer[..count]);
                        let _ = output.emit_output_flush();
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
    }

    Ok(())
}

#[cfg(not(unix))]
fn create_protocol_writer() -> Box<dyn Write + Send> {
    #[cfg(windows)]
    unsafe {
        let stdout_handle = GetStdHandle(STD_OUTPUT_HANDLE);
        let stderr_handle = GetStdHandle(STD_ERROR_HANDLE);

        if !stdout_handle.is_null() && stdout_handle != (-1isize) as HANDLE {
            let mut protocol_handle: HANDLE = std::ptr::null_mut();
            let process = GetCurrentProcess();
            if DuplicateHandle(
                process,
                stdout_handle,
                process,
                &mut protocol_handle,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            ) != 0
            {
                // `DuplicateHandle(..., bInheritHandle = FALSE, ...)` only
                // affects the duplicate. Child processes can still inherit the
                // original stdout pipe unless we clear that handle too.
                let _ = SetHandleInformation(stdout_handle, HANDLE_FLAG_INHERIT, 0);
                let _ = SetHandleInformation(protocol_handle, HANDLE_FLAG_INHERIT, 0);
                if !stderr_handle.is_null() && stderr_handle != (-1isize) as HANDLE {
                    let _ = SetStdHandle(STD_OUTPUT_HANDLE, stderr_handle);
                    let _ = libc::dup2(2, 1);
                }
                return Box::new(File::from_raw_handle(protocol_handle as _));
            }
        }
    }

    Box::new(io::stdout())
}

#[cfg(windows)]
fn capture_process_stdout_to_sink(output: OutputSink) -> io::Result<()> {
    capture_windows_fd_to_sink(
        output.clone_handle(),
        1,
        STD_OUTPUT_HANDLE,
        OutputStream::Stdout,
    )?;
    capture_windows_fd_to_sink(output, 2, STD_ERROR_HANDLE, OutputStream::Stderr)?;
    Ok(())
}

#[cfg(windows)]
fn capture_windows_fd_to_sink(
    output: OutputSink,
    fd: libc::c_int,
    std_handle: STD_HANDLE,
    stream: OutputStream,
) -> io::Result<()> {
    unsafe {
        let mut read_handle: HANDLE = std::ptr::null_mut();
        let mut write_handle: HANDLE = std::ptr::null_mut();
        if CreatePipe(&mut read_handle, &mut write_handle, std::ptr::null(), 0) == 0 {
            return Err(io::Error::last_os_error());
        }

        let _ = SetHandleInformation(read_handle, HANDLE_FLAG_INHERIT, 0);
        let _ = SetHandleInformation(write_handle, HANDLE_FLAG_INHERIT, 0);

        let write_fd = libc::open_osfhandle(write_handle as libc::intptr_t, libc::O_BINARY);
        if write_fd < 0 {
            let error = io::Error::last_os_error();
            let _ = CloseHandle(read_handle);
            let _ = CloseHandle(write_handle);
            return Err(error);
        }

        if libc::dup2(write_fd, fd) < 0 {
            let error = io::Error::last_os_error();
            let _ = libc::close(write_fd);
            let _ = CloseHandle(read_handle);
            return Err(error);
        }
        let _ = libc::close(write_fd);

        let redirected_handle = libc::get_osfhandle(fd);
        if redirected_handle >= 0 {
            let _ = SetStdHandle(std_handle, redirected_handle as HANDLE);
        }

        let read_handle_value = read_handle as isize;
        thread::spawn(move || {
            let mut reader = File::from_raw_handle(read_handle_value as _);
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let _ = output.emit_output(stream, &buffer[..count]);
                        let _ = output.emit_output_flush();
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
    }

    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn capture_process_stdout_to_sink(_output: OutputSink) -> io::Result<()> {
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PromptKind {
    Main,
    Cont,
}

pub(crate) fn read_next_command<R: Read>(reader: &mut R) -> io::Result<Option<IncomingCommand>> {
    let mut header = [0_u8; FRAME_HEADER_LEN];
    let mut read = 0_usize;
    while read < header.len() {
        let count = reader.read(&mut header[read..])?;
        if count == 0 {
            if read == 0 {
                return Ok(None);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated backend frame header",
            ));
        }
        read += count;
    }

    let payload_len =
        u32::from_le_bytes(header[0..4].try_into().expect("payload length slice")) as usize;
    let kind = u16::from_le_bytes(header[4..6].try_into().expect("kind slice"));
    let request_id = u32::from_le_bytes(header[8..12].try_into().expect("request id slice"));

    let mut payload = vec![0_u8; payload_len];
    if payload_len > 0 {
        reader.read_exact(&mut payload)?;
    }

    let command = match kind {
        FRAME_SUBMIT => IncomingCommand::Submit(String::from_utf8_lossy(&payload).into_owned()),
        FRAME_REPLY_INPUT => {
            IncomingCommand::ReplyInput(String::from_utf8_lossy(&payload).into_owned())
        }
        FRAME_DIALOG_RESULT => IncomingCommand::DialogResult(decode_dialog_result(&payload)?),
        FRAME_PARSE_STATUS_REQUEST => IncomingCommand::ParseStatus {
            request_id,
            code: String::from_utf8_lossy(&payload).into_owned(),
        },
        FRAME_INTERRUPT => IncomingCommand::Interrupt,
        FRAME_SET_WIDTH => {
            if payload.len() != 4 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid set-width payload",
                ));
            }
            let width = u32::from_le_bytes(payload.try_into().expect("set-width payload"));
            IncomingCommand::SetWidth {
                columns: width.clamp(1, u16::MAX as u32) as u16,
            }
        }
        FRAME_SHUTDOWN => IncomingCommand::Shutdown,
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unknown backend frame {kind} request_id={request_id}"),
            ))
        }
    };

    Ok(Some(command))
}

fn encode_string_list<T: AsRef<str>>(label: &str, capabilities: &[T], payload: &mut Vec<u8>) {
    encode_string(label, payload);
    payload.extend_from_slice(&(capabilities.len() as u32).to_le_bytes());
    for capability in capabilities {
        encode_string(capability.as_ref(), payload);
    }
}

fn encode_string_array<T: AsRef<str>>(values: &[T], payload: &mut Vec<u8>) {
    payload.extend_from_slice(&(values.len() as u32).to_le_bytes());
    for value in values {
        encode_string(value.as_ref(), payload);
    }
}

fn encode_string(value: &str, payload: &mut Vec<u8>) {
    payload.extend_from_slice(&(value.len() as u32).to_le_bytes());
    payload.extend_from_slice(value.as_bytes());
}

fn decode_dialog_result(payload: &[u8]) -> io::Result<DialogResult> {
    let Some(kind) = payload.first().copied() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "missing dialog-result kind",
        ));
    };

    match kind {
        0 => {
            if payload.len() < 2 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "truncated choose-file dialog result",
                ));
            }
            if payload[1] == 0 {
                Ok(DialogResult::ChooseFile { path: None })
            } else {
                let (path, offset) = decode_string(payload, 2)?;
                if offset != payload.len() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "trailing bytes in choose-file dialog result",
                    ));
                }
                Ok(DialogResult::ChooseFile { path: Some(path) })
            }
        }
        1 => {
            if payload.len() != 2 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid edit-expression dialog result payload",
                ));
            }
            Ok(DialogResult::EditExpression {
                completed: payload[1] != 0,
            })
        }
        2 => {
            if payload.len() != 2 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid edit-files dialog result payload",
                ));
            }
            Ok(DialogResult::EditFiles {
                completed: payload[1] != 0,
            })
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown dialog-result kind {kind}"),
        )),
    }
}

fn decode_string(payload: &[u8], offset: usize) -> io::Result<(String, usize)> {
    let Some(length_slice) = payload.get(offset..offset + 4) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "truncated string length",
        ));
    };
    let length = u32::from_le_bytes(length_slice.try_into().expect("string length slice")) as usize;
    let start = offset + 4;
    let end = start + length;
    let Some(value_slice) = payload.get(start..end) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "truncated string payload",
        ));
    };
    Ok((String::from_utf8_lossy(value_slice).into_owned(), end))
}
