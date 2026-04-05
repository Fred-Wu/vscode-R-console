use crate::protocol::{read_next_command, IncomingCommand, OutputSink, PromptKind};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::VecDeque;
use std::error::Error;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MARKER_PREFIX: &[u8] = b"\x1b]633;vsc-r-console;";
const MARKER_SUFFIX: u8 = 0x07;
const MARKER_PROMPT_MAIN: &[u8] = b"\x1b]633;vsc-r-console;prompt;main\x07";
const MARKER_PROMPT_CONT: &[u8] = b"\x1b]633;vsc-r-console;prompt;cont\x07";
const MARKER_INPUT_END: &[u8] = b"\x1b]633;vsc-r-console;input-end\x07";
const MARKER_INPUT_PREFIX: &[u8] = b"\x1b]633;vsc-r-console;input;";
const PARSE_STATUS_NULL: i32 = 0;
const PARSE_STATUS_OK: i32 = 1;
const PARSE_STATUS_INCOMPLETE: i32 = 2;
const PARSE_STATUS_ERROR: i32 = 3;
const PARSE_STATUS_SCRIPT: &str = r#"stdin_conn <- file("stdin", open = "rb"); stdout_conn <- stdout(); parse_status <- function(code) { if (!nzchar(trimws(code))) { return(0L) }; tryCatch({ parse(text = code, keep.source = FALSE); 1L }, error = function(err) { text <- conditionMessage(err); if (grepl("unexpected end of input", text, fixed = TRUE) || grepl("unexpected end of line", text, fixed = TRUE) || grepl("unexpected EOF", text, fixed = TRUE)) 2L else 3L }) }; repeat { header <- readLines(stdin_conn, n = 1L, warn = FALSE); if (length(header) == 0L) break; size <- suppressWarnings(as.integer(header)); if (!is.finite(size) || size < 0L) { cat(3L, '\n', sep = ''); flush(stdout_conn); next }; payload <- if (size == 0L) raw(0) else readBin(stdin_conn, what = 'raw', n = size); if (length(payload) < size) break; readBin(stdin_conn, what = 'raw', n = 1L); code <- if (length(payload) == 0L) '' else rawToChar(payload); cat(parse_status(code), '\n', sep = ''); flush(stdout_conn) }"#;

#[derive(Clone)]
struct ParseProgram {
    executable: String,
    use_rscript: bool,
}

struct ParseWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

pub(crate) fn run(args: Vec<String>) -> Result<(), Box<dyn Error>> {
    if args.is_empty() {
        return Err("missing R console executable path".into());
    }

    let cols = std::env::var("VSC_R_COLS")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value >= 20)
        .unwrap_or(80);
    let rows = std::env::var("VSC_R_ROWS")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value >= 5)
        .unwrap_or(24);

    let output = OutputSink::new();
    output.emit_backend_ready()?;

    let pty_system = NativePtySystem::default();
    let pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut command = CommandBuilder::new(&args[0]);
    for arg in args.iter().skip(1) {
        command.arg(arg);
    }
    if let Ok(current_dir) = std::env::current_dir() {
        command.cwd(current_dir);
    }

    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);
    let parser_program = resolve_parser_program(&args[0]);
    let mut parse_worker = ParseWorker::spawn(&parser_program).ok();

    let child_pid = child
        .process_id()
        .ok_or("spawned R process did not report a pid")?;
    output.emit_child_spawned(child_pid as u32)?;
    output.emit_host_connected()?;

    let mut reader = pair.master.try_clone_reader()?;
    let writer = Arc::new(Mutex::new(pair.master.take_writer()?));

    let suppressor = Arc::new(Mutex::new(EchoSuppressor::default()));
    let output_thread = {
        let thread_output = output.clone_handle();
        let thread_suppressor = Arc::clone(&suppressor);
        let thread_writer = Arc::clone(&writer);
        std::thread::spawn(move || {
            let mut processor = StreamProcessor::new(thread_output, thread_suppressor, thread_writer);
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let _ = processor.finish();
                        break;
                    }
                    Ok(count) => {
                        if processor.push(&buffer[..count]).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = processor.output.emit_host_error(&format!("pty read failed: {error}"));
                        let _ = processor.finish();
                        break;
                    }
                }
            }
        })
    };

    let (command_tx, command_rx) = mpsc::channel::<Result<IncomingCommand, String>>();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut locked = stdin.lock();
        loop {
            match read_next_command(&mut locked) {
                Ok(Some(command)) => {
                    if command_tx.send(Ok(command)).is_err() {
                        break;
                    }
                }
                Ok(None) => {
                    let _ = command_tx.send(Ok(IncomingCommand::Shutdown));
                    break;
                }
                Err(error) => {
                    let _ = command_tx.send(Err(error.to_string()));
                    break;
                }
            }
        }
    });

    loop {
        match child.try_wait()? {
            Some(status) => {
                drop(writer);
                drop(pair.master);
                let _ = output_thread.join();
                let exit_code = status.exit_code();
                std::process::exit(exit_code as i32);
            }
            None => {}
        }

        match command_rx.recv_timeout(Duration::from_millis(25)) {
            Ok(Ok(command)) => match command {
                IncomingCommand::Submit(code) => {
                    output.emit_busy(true)?;
                    if let Ok(mut state) = suppressor.lock() {
                        state.expect_submission_prompt();
                        state.push_logical_echo(&(normalize_logical_newlines(&code) + "\n"));
                    }
                    write_terminal_submission(&writer, &code)?;
                }
                IncomingCommand::ReplyInput(text) => {
                    if let Ok(mut state) = suppressor.lock() {
                        state.push_logical_echo(&(normalize_logical_newlines(&text) + "\n"));
                    }
                    write_terminal_submission(&writer, &text)?;
                }
                IncomingCommand::ParseStatus { request_id, code } => {
                    let status = query_parse_status(&parser_program, &mut parse_worker, &code);
                    output.emit_parse_status_result(request_id, status)?;
                }
                IncomingCommand::Interrupt => {
                    if let Ok(mut writer) = writer.lock() {
                        writer.write_all(&[0x03])?;
                        writer.flush()?;
                    }
                }
                IncomingCommand::SetWidth(columns) => {
                    pair.master.resize(PtySize {
                        rows,
                        cols: columns.max(1),
                        pixel_width: 0,
                        pixel_height: 0,
                    })?;
                }
                IncomingCommand::InputBytes(bytes) => {
                    if let Ok(mut writer) = writer.lock() {
                        writer.write_all(&bytes)?;
                        writer.flush()?;
                    }
                }
                IncomingCommand::Shutdown => {
                    break;
                }
            },
            Ok(Err(message)) => {
                output.emit_host_error(&message)?;
                break;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                break;
            }
        }
    }

    let _ = child.kill();

    drop(writer);
    drop(pair.master);
    let _ = output_thread.join();

    match child.wait() {
        Ok(status) => std::process::exit(status.exit_code() as i32),
        Err(error) => Err(format!("failed waiting for child exit: {error}").into()),
    }
}

fn write_terminal_submission(
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    text: &str,
) -> io::Result<()> {
    let line_break = if cfg!(windows) { "\r" } else { "\n" };
    let normalized = normalize_logical_newlines(text).replace('\n', line_break);
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "pty writer lock poisoned"))?;
    writer.write_all(normalized.as_bytes())?;
    writer.write_all(line_break.as_bytes())?;
    writer.flush()
}

fn normalize_logical_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn resolve_parser_program(console_path: &str) -> ParseProgram {
    let executable = std::env::var("VSC_R_EXECUTABLE")
        .ok()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| console_path.to_string());

    if let Some(rscript) = resolve_rscript_path(&executable).or_else(|| resolve_rscript_path(console_path)) {
        return ParseProgram {
            executable: rscript,
            use_rscript: true,
        };
    }

    ParseProgram {
        executable,
        use_rscript: false,
    }
}

fn resolve_rscript_path(executable_path: &str) -> Option<String> {
    let executable = Path::new(executable_path);
    let name = executable.file_name()?.to_str()?;
    if name.eq_ignore_ascii_case("Rscript.exe") || name == "Rscript" {
        return Some(executable_path.to_string());
    }

    let rscript_name = if cfg!(windows) { "Rscript.exe" } else { "Rscript" };
    let mut candidates = Vec::new();
    candidates.push(executable.with_file_name(rscript_name));
    if let Some(parent) = executable.parent().and_then(|value| value.parent()) {
        candidates.push(parent.join(rscript_name));
    }

    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().into_owned())
}

impl ParseWorker {
    fn spawn(parser_program: &ParseProgram) -> io::Result<Self> {
        let mut command = Command::new(&parser_program.executable);
        command.arg("--vanilla");
        if !parser_program.use_rscript {
            command.arg("--slave");
        }
        command
            .arg("-e")
            .arg(PARSE_STATUS_SCRIPT)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command.env("LC_ALL", "C");
        command.env("LANGUAGE", "en");
        command.env_remove("R_PROFILE_USER");
        command.env_remove("R_PROFILE_USER_OLD");
        command.env_remove("VSCODE_INIT_R");
        command.env_remove("VSCODE_WATCHER_DIR");

        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "parse worker stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "parse worker stdout unavailable"))?;

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    fn query(&mut self, code: &str) -> io::Result<i32> {
        let payload = code.as_bytes();
        write!(self.stdin, "{}\n", payload.len())?;
        self.stdin.write_all(payload)?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;

        let mut line = String::new();
        if self.stdout.read_line(&mut line)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "parse worker closed stdout",
            ));
        }

        let status = line.trim().parse::<i32>().unwrap_or(PARSE_STATUS_ERROR);
        Ok(match status {
            PARSE_STATUS_NULL
            | PARSE_STATUS_OK
            | PARSE_STATUS_INCOMPLETE
            | PARSE_STATUS_ERROR => status,
            _ => PARSE_STATUS_ERROR,
        })
    }
}

impl Drop for ParseWorker {
    fn drop(&mut self) {
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn query_parse_status(
    parser_program: &ParseProgram,
    parse_worker: &mut Option<ParseWorker>,
    code: &str,
) -> i32 {
    if code.trim().is_empty() {
        return PARSE_STATUS_NULL;
    }

    if let Some(worker) = parse_worker.as_mut() {
        if let Ok(status) = worker.query(code) {
            return status;
        }
    }

    *parse_worker = ParseWorker::spawn(parser_program).ok();
    if let Some(worker) = parse_worker.as_mut() {
        if let Ok(status) = worker.query(code) {
            return status;
        }
    }

    PARSE_STATUS_ERROR
}

#[derive(Default)]
struct EchoSuppressor {
    pending_echoes: VecDeque<Vec<u8>>,
    suppress_submission_prompts: bool,
}

impl EchoSuppressor {
    fn expect_submission_prompt(&mut self) {
        self.suppress_submission_prompts = true;
    }

    fn finish_submission_prompt(&mut self) {
        self.suppress_submission_prompts = false;
    }

    fn should_suppress_submission_prompts(&self) -> bool {
        self.suppress_submission_prompts
    }

    fn push_logical_echo(&mut self, text: &str) {
        self.pending_echoes.push_back(text.as_bytes().to_vec());
    }

    fn strip_expected_echoes(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut cursor = 0_usize;
        while cursor < bytes.len() {
            let Some(expected) = self.pending_echoes.front_mut() else {
                break;
            };
            let (consumed_output, consumed_expected, mismatched) =
                consume_echo_prefix(&bytes[cursor..], expected);
            if consumed_output == 0 && consumed_expected == 0 {
                break;
            }
            cursor += consumed_output;
            if consumed_expected > 0 {
                expected.drain(0..consumed_expected);
            }
            if expected.is_empty() {
                self.pending_echoes.pop_front();
            }
            if mismatched || cursor >= bytes.len() {
                break;
            }
        }
        bytes[cursor..].to_vec()
    }
}

fn consume_echo_prefix(output: &[u8], expected: &[u8]) -> (usize, usize, bool) {
    let mut output_index = 0_usize;
    let mut expected_index = 0_usize;
    let mut mismatched = false;

    while output_index < output.len() && expected_index < expected.len() {
        if let Some(sequence_len) = parse_escape_sequence_len(&output[output_index..]) {
            output_index += sequence_len;
            continue;
        }

        let output_byte = output[output_index];
        let expected_byte = expected[expected_index];

        if expected_byte == b'\n' {
            if output_byte == b'\r' {
                if output_index + 1 < output.len() && output[output_index + 1] == b'\n' {
                    output_index += 2;
                    expected_index += 1;
                    continue;
                }
                output_index += 1;
                continue;
            }
            if output_byte == b'\n' {
                output_index += 1;
                expected_index += 1;
                continue;
            }
            mismatched = true;
            break;
        }

        if output_byte == expected_byte {
            output_index += 1;
            expected_index += 1;
            continue;
        }

        mismatched = true;
        break;
    }

    if expected_index == 0 {
        return (0, 0, false);
    }

    (output_index, expected_index, mismatched)
}

fn parse_escape_sequence_len(bytes: &[u8]) -> Option<usize> {
    if bytes.first().copied() != Some(0x1b) || bytes.len() < 2 {
        return None;
    }

    match bytes[1] {
        b'[' => {
            for index in 2..bytes.len() {
                let byte = bytes[index];
                if (0x40..=0x7e).contains(&byte) {
                    return Some(index + 1);
                }
            }
            None
        }
        b']' => {
            let mut index = 2_usize;
            while index < bytes.len() {
                match bytes[index] {
                    0x07 => return Some(index + 1),
                    0x1b if index + 1 < bytes.len() && bytes[index + 1] == b'\\' => {
                        return Some(index + 2);
                    }
                    _ => {
                        index += 1;
                    }
                }
            }
            None
        }
        _ => Some(2),
    }
}

struct StreamProcessor {
    output: OutputSink,
    suppressor: Arc<Mutex<EchoSuppressor>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    input_buffer: Vec<u8>,
    pending_plain: Vec<u8>,
}

impl StreamProcessor {
    fn new(
        output: OutputSink,
        suppressor: Arc<Mutex<EchoSuppressor>>,
        writer: Arc<Mutex<Box<dyn Write + Send>>>,
    ) -> Self {
        Self {
            output,
            suppressor,
            writer,
            input_buffer: Vec::new(),
            pending_plain: Vec::new(),
        }
    }

    fn push(&mut self, chunk: &[u8]) -> io::Result<()> {
        self.input_buffer.extend_from_slice(chunk);

        loop {
            let marker_start = find_subslice(&self.input_buffer, MARKER_PREFIX);
            let Some(marker_start) = marker_start else {
                if !self.input_buffer.is_empty() {
                    let plain = std::mem::take(&mut self.input_buffer);
                    self.push_plain(&plain)?;
                }
                break;
            };

            if marker_start > 0 {
                let plain = self.input_buffer.drain(0..marker_start).collect::<Vec<u8>>();
                self.push_plain(&plain)?;
            }

            let Some(marker_end_start) = self.input_buffer.iter().position(|byte| *byte == MARKER_SUFFIX) else {
                break;
            };
            let marker_end = marker_end_start + 1;

            let marker = self.input_buffer[0..marker_end].to_vec();
            self.input_buffer.drain(0..marker_end);
            self.flush_pending_plain(false)?;
            self.handle_marker(&marker)?;
        }

        self.flush_pending_plain(false)
    }

    fn finish(&mut self) -> io::Result<()> {
        if !self.input_buffer.is_empty() {
            let remaining = std::mem::take(&mut self.input_buffer);
            self.push_plain(&remaining)?;
        }
        self.flush_pending_plain(true)
    }

    fn handle_marker(&mut self, marker: &[u8]) -> io::Result<()> {
        if marker == MARKER_PROMPT_MAIN {
            if let Ok(mut state) = self.suppressor.lock() {
                state.finish_submission_prompt();
            }
            self.output.emit_busy(false)?;
            self.output.emit_prompt(PromptKind::Main)?;
            return Ok(());
        }

        if marker == MARKER_PROMPT_CONT {
            let suppress_prompt = if let Ok(state) = self.suppressor.lock() {
                state.should_suppress_submission_prompts()
            } else {
                false
            };
            if !suppress_prompt {
                self.output.emit_prompt(PromptKind::Cont)?;
            }
            return Ok(());
        }

        if marker == MARKER_INPUT_END {
            self.output.emit_input_end()?;
            self.output.emit_busy(true)?;
            return Ok(());
        }

        if let Some(payload) = marker.strip_prefix(MARKER_INPUT_PREFIX) {
            let payload = payload.strip_suffix(&[MARKER_SUFFIX]).unwrap_or(payload);
            let prompt = decode_marker_payload(payload);
            self.output.emit_busy(false)?;
            self.output.emit_input_request(&prompt)?;
            return Ok(());
        }

        let mut passthrough = Vec::with_capacity(marker.len());
        passthrough.extend_from_slice(marker);
        self.push_plain(&passthrough)
    }

    fn push_plain(&mut self, plain: &[u8]) -> io::Result<()> {
        let plain = self.strip_terminal_queries(plain)?;
        let stripped = if let Ok(mut state) = self.suppressor.lock() {
            state.strip_expected_echoes(&plain)
        } else {
            plain
        };
        if !stripped.is_empty() {
            self.pending_plain.extend_from_slice(&stripped);
        }
        self.flush_pending_plain(false)
    }

    fn strip_terminal_queries(&self, plain: &[u8]) -> io::Result<Vec<u8>> {
        let mut filtered = Vec::with_capacity(plain.len());
        let mut index = 0_usize;
        while index < plain.len() {
            if plain[index..].starts_with(b"\x1b[6n") {
                if let Ok(mut writer) = self.writer.lock() {
                    writer.write_all(b"\x1b[1;1R")?;
                    writer.flush()?;
                }
                index += 4;
                continue;
            }
            filtered.push(plain[index]);
            index += 1;
        }
        Ok(filtered)
    }

    fn flush_pending_plain(&mut self, flush_all: bool) -> io::Result<()> {
        loop {
            if self.pending_plain.is_empty() {
                return Ok(());
            }

            match std::str::from_utf8(&self.pending_plain) {
                Ok(_) => {
                    self.output.emit_output(&self.pending_plain)?;
                    self.output.emit_output_flush()?;
                    self.pending_plain.clear();
                    return Ok(());
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        let valid = self.pending_plain.drain(0..valid_up_to).collect::<Vec<u8>>();
                        self.output.emit_output(&valid)?;
                        self.output.emit_output_flush()?;
                        continue;
                    }

                    if error.error_len().is_none() && !flush_all {
                        return Ok(());
                    }

                    let invalid_len = error.error_len().unwrap_or(self.pending_plain.len()).max(1);
                    let invalid = self.pending_plain.drain(0..invalid_len).collect::<Vec<u8>>();
                    let lossy = String::from_utf8_lossy(&invalid).into_owned();
                    self.output.emit_output(lossy.as_bytes())?;
                    self.output.emit_output_flush()?;
                }
            }
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn decode_marker_payload(payload: &[u8]) -> String {
    let mut output = Vec::with_capacity(payload.len());
    let mut index = 0_usize;

    while index < payload.len() {
        match payload[index] {
            b'\\' if index + 1 < payload.len() && payload[index + 1] == b'\\' => {
                output.push(b'\\');
                index += 2;
            }
            b'\\' if index + 3 < payload.len() && payload[index + 1] == b'x' => {
                let hex = &payload[index + 2..index + 4];
                if let Ok(text) = std::str::from_utf8(hex) {
                    if let Ok(value) = u8::from_str_radix(text, 16) {
                        output.push(value);
                        index += 4;
                        continue;
                    }
                }
                output.push(payload[index]);
                index += 1;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&output).into_owned()
}
