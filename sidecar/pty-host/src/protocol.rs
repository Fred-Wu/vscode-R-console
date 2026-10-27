use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};
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
const MAX_INPUT_FRAME_BYTES: usize = 8 * 1024 * 1024;
const FRAME_SERVER_CHALLENGE: u16 = 22;
const FRAME_CLIENT_PROOF: u16 = 23;
const FRAME_SERVER_PROOF: u16 = 24;
const AUTH_NONCE_BYTES: usize = 32;
// Keep in sync with BACKEND_AUTH_TIMEOUT_MS in backendAuthentication.ts.
const BACKEND_AUTH_TIMEOUT: Duration = Duration::from_secs(3);
const AUTH_CLIENT_CONTEXT: &[u8] = b"rconsole-backend-client-v2";
const AUTH_SERVER_CONTEXT: &[u8] = b"rconsole-backend-server-v2";

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

fn secure_server_nonce() -> io::Result<[u8; AUTH_NONCE_BYTES]> {
    let mut nonce = [0_u8; AUTH_NONCE_BYTES];
    #[cfg(unix)]
    {
        let mut random = std::fs::File::open("/dev/urandom")?;
        random.read_exact(&mut nonce)?;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Cryptography::{
            BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        };
        let result = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                nonce.as_mut_ptr(),
                nonce.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if result != 0 {
            return Err(io::Error::other(format!("OS random generator returned {result}")));
        }
    }
    Ok(nonce)
}

fn auth_mac(
    secret: &[u8],
    context: &[u8],
    server_nonce: &[u8; AUTH_NONCE_BYTES],
    client_nonce: &[u8; AUTH_NONCE_BYTES],
) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC supports the session token");
    mac.update(context);
    mac.update(server_nonce);
    mac.update(client_nonce);
    mac
}

fn write_auth_frame<W: Write>(writer: &mut W, kind: u16, payload: &[u8]) -> io::Result<()> {
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(&kind.to_le_bytes())?;
    writer.write_all(&[0_u8; 6])?;
    writer.write_all(payload)?;
    writer.flush()
}

/// Never transmit the reusable session secret. Both sides prove knowledge of it
/// using independently domain-separated HMACs over a fresh server/client nonce pair.
fn authenticate_with_nonce<S: Read + Write>(
    stream: &mut S,
    secret: &[u8],
    server_nonce: [u8; AUTH_NONCE_BYTES],
) -> io::Result<bool> {
    write_auth_frame(stream, FRAME_SERVER_CHALLENGE, &server_nonce)?;
    let mut header = [0_u8; FRAME_HEADER_LEN];
    stream.read_exact(&mut header)?;
    let length = u32::from_le_bytes(header[0..4].try_into().unwrap());
    let kind = u16::from_le_bytes(header[4..6].try_into().unwrap());
    if kind != FRAME_CLIENT_PROOF || length != 64 || header[6..].iter().any(|b| *b != 0) {
        return Ok(false);
    }

    let mut payload = [0_u8; 64];
    stream.read_exact(&mut payload)?;
    let client_nonce: [u8; 32] = payload[..32].try_into().unwrap();
    if auth_mac(secret, AUTH_CLIENT_CONTEXT, &server_nonce, &client_nonce)
        .verify_slice(&payload[32..])
        .is_err()
    {
        return Ok(false);
    }

    let proof = auth_mac(secret, AUTH_SERVER_CONTEXT, &server_nonce, &client_nonce)
        .finalize().into_bytes();
    write_auth_frame(stream, FRAME_SERVER_PROOF, &proof)?;
    Ok(true)
}

pub(crate) fn authenticate_client<S: Read + Write>(
    stream: &mut S,
    secret: &[u8],
) -> io::Result<bool> {
    if secret.len() != 64 || !secret.iter().all(u8::is_ascii_hexdigit) {
        return Ok(false);
    }
    authenticate_with_nonce(stream, secret, secure_server_nonce()?)
}

/// Bound every read/write by the same deadline. A per-read timeout alone lets
/// a peer keep read_exact alive by sending one byte before each timeout.
struct AuthenticationStream<'a> {
    stream: &'a mut TcpStream,
    deadline: Instant,
}

impl AuthenticationStream<'_> {
    fn remaining(&self) -> io::Result<Duration> {
        self.deadline.checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "backend authentication timed out"))
    }
}

impl Read for AuthenticationStream<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.stream.set_read_timeout(Some(self.remaining()?))?;
        let read = self.stream.read(bytes)?;
        self.remaining()?;
        Ok(read)
    }
}

impl Write for AuthenticationStream<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        let written = self.stream.write(bytes)?;
        self.remaining()?;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.remaining()?;
        self.stream.flush()
    }
}

/// The listener is nonblocking, but authentication uses blocking I/O with a
/// total deadline. Remove both timeouts before handing off an accepted client.
pub(crate) fn authenticate_session_stream(stream: &mut TcpStream, secret: &[u8]) -> io::Result<bool> {
    stream.set_nonblocking(false)?;
    let result = authenticate_client(&mut AuthenticationStream {
        stream,
        deadline: Instant::now() + BACKEND_AUTH_TIMEOUT,
    }, secret);
    let reset_read = stream.set_read_timeout(None);
    let reset_write = stream.set_write_timeout(None);
    reset_read?;
    reset_write?;
    result
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

    if payload_len > MAX_INPUT_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "backend frame exceeds size limit"));
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn frame(kind: u16, request_id: u32, payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&kind.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&request_id.to_le_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn reads_consecutive_commands_with_utf8_and_request_ids() {
        let mut bytes = frame(FRAME_SUBMIT, 0, "日本語".as_bytes());
        bytes.extend(frame(FRAME_PARSE_STATUS_REQUEST, 42, b"x["));
        bytes.extend(frame(FRAME_REPLY_INPUT, 0, b"yes"));
        bytes.extend(frame(FRAME_INTERRUPT, 0, &[]));
        bytes.extend(frame(FRAME_SHUTDOWN, 0, &[]));
        let mut reader = Cursor::new(bytes);
        assert!(
            matches!(read_next_command(&mut reader).unwrap(), Some(IncomingCommand::Submit(code)) if code == "日本語")
        );
        assert!(
            matches!(read_next_command(&mut reader).unwrap(), Some(IncomingCommand::ParseStatus { request_id: 42, code }) if code == "x[")
        );
        assert!(
            matches!(read_next_command(&mut reader).unwrap(), Some(IncomingCommand::ReplyInput(text)) if text == "yes")
        );
        assert!(matches!(
            read_next_command(&mut reader).unwrap(),
            Some(IncomingCommand::Interrupt)
        ));
        assert!(matches!(
            read_next_command(&mut reader).unwrap(),
            Some(IncomingCommand::Shutdown)
        ));
        assert!(read_next_command(&mut reader).unwrap().is_none());
    }

    struct Duplex {
        input: Cursor<Vec<u8>>,
        output: Vec<u8>,
    }

    impl Read for Duplex {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            self.input.read(bytes)
        }
    }
    impl Write for Duplex {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.output.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }

    #[test]
    fn mutual_authentication_uses_distinct_proofs_and_never_sends_token() {
        let secret = b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let server_nonce = [7_u8; 32];
        let client_nonce = [9_u8; 32];
        let client_proof = auth_mac(secret, AUTH_CLIENT_CONTEXT, &server_nonce, &client_nonce)
            .finalize().into_bytes();
        let mut payload = Vec::from(client_nonce);
        payload.extend_from_slice(&client_proof);
        let mut stream = Duplex {
            input: Cursor::new(frame(FRAME_CLIENT_PROOF, 0, &payload)),
            output: Vec::new(),
        };
        assert!(authenticate_with_nonce(&mut stream, secret, server_nonce).unwrap());
        let server_proof = auth_mac(secret, AUTH_SERVER_CONTEXT, &server_nonce, &client_nonce)
            .finalize().into_bytes();
        let mut expected = frame(FRAME_SERVER_CHALLENGE, 0, &server_nonce);
        expected.extend(frame(FRAME_SERVER_PROOF, 0, &server_proof));
        assert_eq!(stream.output, expected);
        assert_ne!(client_proof.as_slice(), server_proof.as_slice());
        assert!(!stream.output.windows(secret.len()).any(|part| part == secret));
    }

    #[test]
    fn every_backend_connection_gets_a_fresh_os_nonce() {
        assert_ne!(secure_server_nonce().unwrap(), secure_server_nonce().unwrap());
    }

    #[test]
    fn malformed_and_replayed_authentication_cannot_attach() {
        let secret = b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let previous_nonce = [3_u8; 32];
        let current_nonce = [4_u8; 32];
        let client_nonce = [8_u8; 32];
        let old_proof = auth_mac(secret, AUTH_CLIENT_CONTEXT, &previous_nonce, &client_nonce)
            .finalize().into_bytes();
        let mut payload = Vec::from(client_nonce);
        payload.extend_from_slice(&old_proof);
        for kind in [FRAME_CLIENT_PROOF, FRAME_SUBMIT, 21] {
            let mut stream = Duplex {
                input: Cursor::new(frame(kind, 0, &payload)),
                output: Vec::new(),
            };
            assert!(!authenticate_with_nonce(&mut stream, secret, current_nonce).unwrap());
            assert_eq!(stream.output, frame(FRAME_SERVER_CHALLENGE, 0, &current_nonce));
        }
        let correct_proof = auth_mac(secret, AUTH_CLIENT_CONTEXT, &current_nonce, &client_nonce)
            .finalize().into_bytes();
        payload[32..].copy_from_slice(&correct_proof);
        let mut stream = Duplex {
            input: Cursor::new(frame(FRAME_CLIENT_PROOF, 0, &payload)),
            output: Vec::new(),
        };
        assert!(authenticate_with_nonce(&mut stream, secret, current_nonce).unwrap());
    }

    #[test]
    fn authenticates_an_accepted_socket_with_nonblocking_mode_set() {
        use std::net::TcpListener;
        let secret = b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.set_read_timeout(Some(BACKEND_AUTH_TIMEOUT)).unwrap();
            let mut challenge = [0_u8; FRAME_HEADER_LEN + 32];
            stream.read_exact(&mut challenge).unwrap();
            assert_eq!(u32::from_le_bytes(challenge[0..4].try_into().unwrap()), 32);
            assert_eq!(u16::from_le_bytes(challenge[4..6].try_into().unwrap()), FRAME_SERVER_CHALLENGE);
            let server_nonce: [u8; 32] = challenge[12..44].try_into().unwrap();
            let client_nonce = [9_u8; 32];
            let proof = auth_mac(secret, AUTH_CLIENT_CONTEXT, &server_nonce, &client_nonce)
                .finalize().into_bytes();
            let mut payload = Vec::from(client_nonce);
            payload.extend_from_slice(&proof);
            stream.write_all(&frame(FRAME_CLIENT_PROOF, 0, &payload)).unwrap();
            let mut reply = [0_u8; FRAME_HEADER_LEN + 32];
            stream.read_exact(&mut reply).unwrap();
            assert_eq!(u16::from_le_bytes(reply[4..6].try_into().unwrap()), FRAME_SERVER_PROOF);
            let expected = auth_mac(secret, AUTH_SERVER_CONTEXT, &server_nonce, &client_nonce)
                .finalize().into_bytes();
            assert_eq!(&reply[12..], expected.as_slice());
        });
        let mut accepted = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(1)),
                Err(e) => panic!("accept failed: {e}"),
            }
        };
        accepted.set_nonblocking(true).unwrap();
        assert!(authenticate_session_stream(&mut accepted, secret).unwrap());
        assert_eq!(accepted.read_timeout().unwrap(), None);
        assert_eq!(accepted.write_timeout().unwrap(), None);
        client.join().unwrap();
    }

    fn reject_slow_authentication(drip_header: bool) {
        use std::net::{Shutdown, TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.set_nodelay(true).unwrap();
            stream.set_read_timeout(Some(BACKEND_AUTH_TIMEOUT * 2)).unwrap();
            let mut challenge = [0_u8; FRAME_HEADER_LEN + 32];
            stream.read_exact(&mut challenge).unwrap();
            let bytes = frame(FRAME_CLIENT_PROOF, 0, &[0; 64]);
            let slow_bytes = if drip_header {
                &bytes[..]
            } else {
                stream.write_all(&bytes[..FRAME_HEADER_LEN]).unwrap();
                &bytes[FRAME_HEADER_LEN..]
            };
            // Every individual read can succeed within its timeout, but the
            // complete header/payload cannot finish before the total deadline.
            for byte in slow_bytes.iter().take(16) {
                if stream.write_all(&[*byte]).is_err() { break; }
                std::thread::sleep(BACKEND_AUTH_TIMEOUT / 8);
            }
        });
        let (mut stream, _) = listener.accept().unwrap();
        let started = Instant::now();
        let result = authenticate_session_stream(&mut stream, &[b'a'; 64]);
        let elapsed = started.elapsed();
        // Close before assertions/join so a failing regression never leaves
        // a drip-feeding client running for the whole frame.
        stream.shutdown(Shutdown::Both).unwrap();
        client.join().unwrap();
        let error = result.unwrap_err();
        assert!(matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock));
        assert!(elapsed < BACKEND_AUTH_TIMEOUT * 2, "handshake lasted {elapsed:?}");
        assert_eq!(stream.read_timeout().unwrap(), None);
        assert_eq!(stream.write_timeout().unwrap(), None);
    }

    #[test]
    fn authentication_deadline_bounds_a_drip_fed_header() {
        reject_slow_authentication(true);
    }

    #[test]
    fn authentication_deadline_bounds_a_drip_fed_payload() {
        reject_slow_authentication(false);
    }

    #[test]
    fn rejects_excessive_input_before_allocating() {
        let mut header = [0_u8; FRAME_HEADER_LEN];
        header[..4].copy_from_slice(&((MAX_INPUT_FRAME_BYTES + 1) as u32).to_le_bytes());
        header[4..6].copy_from_slice(&FRAME_SUBMIT.to_le_bytes());
        let error = read_next_command(&mut Cursor::new(header)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn rejects_truncated_and_unknown_frames() {
        let bytes = frame(FRAME_SUBMIT, 0, b"hello");
        for length in 1..bytes.len() {
            let error = read_next_command(&mut Cursor::new(&bytes[..length])).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        }
        let error = read_next_command(&mut Cursor::new(frame(65535, 0, &[]))).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn clamps_width_and_decodes_cancelled_dialogs() {
        for (input, expected) in [(0_u32, 1_u16), (80, 80), (u32::MAX, u16::MAX)] {
            let command = read_next_command(&mut Cursor::new(frame(
                FRAME_SET_WIDTH,
                0,
                &input.to_le_bytes(),
            )))
            .unwrap();
            assert!(
                matches!(command, Some(IncomingCommand::SetWidth { columns }) if columns == expected)
            );
        }
        let command =
            read_next_command(&mut Cursor::new(frame(FRAME_DIALOG_RESULT, 0, &[0, 0]))).unwrap();
        assert!(matches!(
            command,
            Some(IncomingCommand::DialogResult(DialogResult::ChooseFile {
                path: None
            }))
        ));
        assert!(decode_dialog_result(&[2]).is_err());
        assert!(decode_dialog_result(&[0, 1, 10, 0, 0, 0]).is_err());
    }
}
