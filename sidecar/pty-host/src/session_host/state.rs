use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, OnceLock};

pub(crate) enum AuxCommand {
    ParseStatus { request_id: u32, code: String },
    SetWidth(i32),
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum PendingInputRequest {
    SubmitMain,
    SubmitCont,
    Reply(String),
}

pub(crate) struct HostState {
    pub(crate) submit_buffer: Option<Vec<u8>>,
    pub(crate) submit_offset: usize,
    pub(crate) reply_buffer: Option<Vec<u8>>,
    pub(crate) reply_offset: usize,
    pub(crate) raw_input_buffer: Option<Vec<u8>>,
    pub(crate) raw_input_offset: usize,
    pub(crate) interrupt_requested: bool,
    pub(crate) shutdown_requested: bool,
    pub(crate) busy_state: Option<bool>,
    pub(crate) aux_commands: VecDeque<AuxCommand>,
    pub(crate) pending_input_request: Option<PendingInputRequest>,
}

impl HostState {
    fn new() -> Self {
        Self {
            submit_buffer: None,
            submit_offset: 0,
            reply_buffer: None,
            reply_offset: 0,
            raw_input_buffer: None,
            raw_input_offset: 0,
            interrupt_requested: false,
            shutdown_requested: false,
            busy_state: None,
            aux_commands: VecDeque::new(),
            pending_input_request: None,
        }
    }
}

static HOST_STATE: OnceLock<(Mutex<HostState>, Condvar)> = OnceLock::new();

pub(crate) fn host_state() -> &'static (Mutex<HostState>, Condvar) {
    HOST_STATE.get_or_init(|| (Mutex::new(HostState::new()), Condvar::new()))
}

pub(crate) fn set_shutdown_requested() {
    let (lock, cvar) = host_state();
    if let Ok(mut state) = lock.lock() {
        state.shutdown_requested = true;
        cvar.notify_all();
    }
}

pub(crate) fn request_interrupt() {
    let (lock, cvar) = host_state();
    if let Ok(mut state) = lock.lock() {
        state.interrupt_requested = true;
        state.pending_input_request = None;
        cvar.notify_all();
    }
}
