use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use std::{fs::File, os::fd::FromRawFd};

pub(crate) const FRAME_HEADER_LEN: usize = 12;
pub(crate) const PROTOCOL_VERSION: u32 = 1;

const FRAME_BACKEND_READY: u16 = 1;
const FRAME_HOST_CONNECTED: u16 = 2;
const FRAME_CHILD_SPAWNED: u16 = 3;
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

pub(crate) struct OutputSink {
    stdout: Arc<Mutex<Box<dyn Write + Send>>>,
    host_name: Arc<String>,
    capabilities: Arc<Vec<String>>,
}

impl OutputSink {
    pub(crate) fn new_with_capabilities(host_name: &str, capabilities: &[&str]) -> Self {
        Self {
            stdout: Arc::new(Mutex::new(create_protocol_writer())),
            host_name: Arc::new(host_name.to_string()),
            capabilities: Arc::new(capabilities.iter().map(|value| (*value).to_string()).collect()),
        }
    }

    pub(crate) fn clone_handle(&self) -> Self {
        Self {
            stdout: Arc::clone(&self.stdout),
            host_name: Arc::clone(&self.host_name),
            capabilities: Arc::clone(&self.capabilities),
        }
    }

    pub(crate) fn emit_backend_ready(&self) -> io::Result<()> {
        let mut payload = Vec::new();
        payload.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
        encode_string_list(self.host_name.as_str(), self.capabilities.as_ref(), &mut payload);
        self.emit_frame(FRAME_BACKEND_READY, 0, &payload)
    }

    pub(crate) fn emit_host_connected(&self) -> io::Result<()> {
        let mut payload = Vec::new();
        encode_string_list(self.host_name.as_str(), self.capabilities.as_ref(), &mut payload);
        self.emit_frame(FRAME_HOST_CONNECTED, 0, &payload)
    }

    pub(crate) fn emit_child_spawned(&self, pid: u32) -> io::Result<()> {
        self.emit_frame(FRAME_CHILD_SPAWNED, 0, &pid.to_le_bytes())
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

    pub(crate) fn emit_output(&self, payload: &[u8]) -> io::Result<()> {
        self.emit_frame(FRAME_OUTPUT, 0, payload)
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

    fn emit_frame(&self, kind: u16, request_id: u32, payload: &[u8]) -> io::Result<()> {
        let mut header = [0_u8; FRAME_HEADER_LEN];
        header[0..4].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        header[4..6].copy_from_slice(&kind.to_le_bytes());
        header[6..8].copy_from_slice(&0_u16.to_le_bytes());
        header[8..12].copy_from_slice(&request_id.to_le_bytes());

        let mut stdout = self
            .stdout
            .lock()
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "stdout lock poisoned"))?;
        stdout.write_all(&header)?;
        if !payload.is_empty() {
            stdout.write_all(payload)?;
        }
        stdout.flush()
    }
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
                let _ = libc::fcntl(libc::STDIN_FILENO, libc::F_SETFD, stdin_flags | libc::FD_CLOEXEC);
            }

            if libc::dup2(libc::STDERR_FILENO, libc::STDOUT_FILENO) >= 0 {
                return Box::new(File::from_raw_fd(protocol_fd));
            }

            let _ = libc::close(protocol_fd);
        }
    }

    Box::new(io::stdout())
}

#[cfg(not(unix))]
fn create_protocol_writer() -> Box<dyn Write + Send> {
    Box::new(io::stdout())
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
        FRAME_PARSE_STATUS_REQUEST => {
            IncomingCommand::ParseStatus {
                request_id,
                code: String::from_utf8_lossy(&payload).into_owned(),
            }
        }
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
