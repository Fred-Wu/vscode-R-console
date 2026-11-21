// Read the effective R library search order only at a completed main prompt.
// This fixed base-environment call never evaluates user-supplied console text.
use crate::protocol::OutputSink;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::{Mutex, OnceLock};

type Sexp = *mut c_void;

#[derive(Clone, Copy)]
pub(crate) struct LibraryPathsApi {
    pub install: unsafe extern "C" fn(*const c_char) -> Sexp,
    pub lang1: unsafe extern "C" fn(Sexp) -> Sexp,
    pub try_eval: unsafe extern "C" fn(Sexp, Sexp, *mut c_int) -> Sexp,
    pub protect: unsafe extern "C" fn(Sexp) -> Sexp,
    pub unprotect: unsafe extern "C" fn(c_int),
    pub length: unsafe extern "C" fn(Sexp) -> c_int,
    pub is_string: unsafe extern "C" fn(Sexp) -> c_int,
    pub string_elt: unsafe extern "C" fn(Sexp, isize) -> Sexp,
    pub translate_utf8: unsafe extern "C" fn(Sexp) -> *const c_char,
    pub top_level_exec: unsafe extern "C" fn(unsafe extern "C" fn(*mut c_void), *mut c_void) -> c_int,
    pub base_env: usize,
}

struct ReadContext {
    api: LibraryPathsApi,
    paths: Vec<String>,
    success: bool,
}

const MAX_PATHS: usize = 256;
// Leave room for the count and every length prefix in the 128 KiB control frame.
const MAX_PATH_BYTES: usize = 128 * 1024 - 4 * (MAX_PATHS + 1);

impl LibraryPathsApi {
    // Must run on R's main thread, never while R is evaluating a submission.
    fn read(self) -> Option<Vec<String>> {
        let mut context = ReadContext { api: self, paths: Vec::new(), success: false };
        let ok = unsafe {
            (self.top_level_exec)(read_paths, (&mut context as *mut ReadContext).cast())
        };
        (ok != 0 && context.success).then_some(context.paths)
    }
}

unsafe extern "C" fn read_paths(data: *mut c_void) {
    let context = &mut *(data as *mut ReadContext);
    let api = context.api;
    let call = (api.protect)((api.lang1)((api.install)(b".libPaths\0".as_ptr().cast())));
    let mut error = 0;
    let paths = (api.protect)((api.try_eval)(call, *(api.base_env as *mut Sexp), &mut error));
    if error == 0 && (api.is_string)(paths) != 0 {
        let length = (api.length)(paths);
        if length >= 0 && (length as usize) <= MAX_PATHS {
            let mut bytes = 0;
            let mut valid = true;
            for index in 0..length {
                let ptr = (api.translate_utf8)((api.string_elt)(paths, index as isize));
                if ptr.is_null() {
                    valid = false;
                    break;
                }
                let value = CStr::from_ptr(ptr).to_string_lossy().into_owned();
                bytes += value.len();
                if bytes > MAX_PATH_BYTES {
                    valid = false;
                    break;
                }
                context.paths.push(value);
            }
            context.success = valid;
        }
    }
    (api.unprotect)(2);
}

#[derive(Default)]
struct Snapshot {
    paths: Option<Vec<String>>,
}

impl Snapshot {
    fn update(&mut self, paths: Vec<String>) -> bool {
        if self.paths.as_ref() == Some(&paths) {
            return false;
        }
        self.paths = Some(paths);
        true
    }
}

static SNAPSHOT: OnceLock<Mutex<Snapshot>> = OnceLock::new();

fn snapshot() -> &'static Mutex<Snapshot> {
    SNAPSHOT.get_or_init(|| Mutex::new(Snapshot::default()))
}

pub(crate) fn publish_if_changed(api: LibraryPathsApi, output: &OutputSink) {
    let Some(paths) = api.read() else { return };
    let changed = snapshot().lock().map(|mut current| current.update(paths.clone())).unwrap_or(false);
    if changed {
        let _ = output.emit_library_paths(&paths);
    }
}

// The R reader cannot run from the socket thread. Replay the last completed
// main-prompt snapshot to reconnecting clients, including during a busy session.
pub(crate) fn publish_latest(output: &OutputSink) {
    let paths = snapshot().lock().ok().and_then(|current| current.paths.clone());
    if let Some(paths) = paths {
        let _ = output.emit_library_paths(&paths);
    }
}

#[cfg(test)]
mod tests {
    use super::Snapshot;

    #[test]
    fn tracks_add_remove_reorder_and_unchanged_paths() {
        let mut snapshot = Snapshot::default();
        let base = vec!["/base".to_string(), "/site".to_string()];
        assert!(snapshot.update(base.clone()));
        assert!(!snapshot.update(base.clone()));
        assert!(snapshot.update(vec!["/extra".into(), "/base".into(), "/site".into()]));
        assert!(snapshot.update(vec!["/base".into(), "/extra".into(), "/site".into()]));
        assert!(snapshot.update(base.clone()));
        assert!(!snapshot.update(base));
    }
}
