use std::collections::HashSet;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::time::Instant;

type Sexp = *mut c_void;
const LIST: c_int = 2;
const CLOSURE: c_int = 3;
const SPECIAL: c_int = 7;
const BUILTIN: c_int = 8;
const ENV: c_int = 4;
const PROMISE: c_int = 5;
const CHAR: c_int = 9;
const LANGUAGE: c_int = 6;
const LOGICAL: c_int = 10;
const INTEGER: c_int = 13;
const REAL: c_int = 14;
const COMPLEX: c_int = 15;
const STRING: c_int = 16;
const DOTS: c_int = 17;
const VECTOR: c_int = 19;
const EXPRESSION: c_int = 20;
const RAW: c_int = 24;
const MAX_DEPTH: usize = 12;
const MAX_NAMES: usize = 1000;
const MAX_NAME_BYTES: usize = 4096;
// Cap native traversal before collecting names or walking indexed pairlists.
const MAX_SCANNED_ENTRIES: usize = 4096;
// Preflight at the same limit as the names we can return: never sort
// thousands of entries only to discard the result.
const MAX_ENV_BINDINGS: c_int = MAX_NAMES as c_int;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Dollar,
    Slot,
    Bracket,
    DoubleBracket,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Field(String),
    Slot(String),
    Index(u32),
    NamedIndex(String),
    SliceIndex(u32),
    SliceName(String),
    VariableIndex(String),
    VariableSlice(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MemberQuery {
    pub root: String,
    pub steps: Vec<Step>,
    pub target: Target,
}

impl MemberQuery {
    pub(crate) fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 6 { return None; }
        let target = match bytes[0] {
            0 => Target::Dollar,
            1 => Target::Slot,
            2 => Target::Bracket,
            3 => Target::DoubleBracket,
            _ => return None,
        };
        let depth = bytes[1] as usize;
        if depth > MAX_DEPTH { return None; }
        let mut at = 2;
        let root = read_name(bytes, &mut at)?;
        let mut steps = Vec::with_capacity(depth);
        for _ in 0..depth {
            let kind = *bytes.get(at)?;
            at += 1;
            let step = match kind {
                0 => Step::Field(read_name(bytes, &mut at)?),
                1 => Step::Slot(read_name(bytes, &mut at)?),
                2 => Step::Index(read_index(bytes, &mut at)?),
                3 => Step::NamedIndex(read_name(bytes, &mut at)?),
                4 => Step::SliceIndex(read_index(bytes, &mut at)?),
                5 => Step::SliceName(read_name(bytes, &mut at)?),
                6 => Step::VariableIndex(read_name(bytes, &mut at)?),
                7 => Step::VariableSlice(read_name(bytes, &mut at)?),
                _ => return None,
            };
            steps.push(step);
        }
        if at != bytes.len() { return None; }
        Some(Self { root, steps, target })
    }
}

fn read_index(bytes: &[u8], at: &mut usize) -> Option<u32> {
    let value = read_u32(bytes, at)?;
    if value == 0 || value > 100_000 { None } else { Some(value) }
}

fn read_u32(bytes: &[u8], at: &mut usize) -> Option<u32> {
    let end = at.checked_add(4)?;
    let value = u32::from_le_bytes(bytes.get(*at..end)?.try_into().ok()?);
    *at = end;
    Some(value)
}

fn read_name(bytes: &[u8], at: &mut usize) -> Option<String> {
    let n = read_u32(bytes, at)? as usize;
    if n == 0 || n > MAX_NAME_BYTES { return None; }
    let end = at.checked_add(n)?;
    let text = std::str::from_utf8(bytes.get(*at..end)?).ok()?;
    if text.contains('\0') { return None; }
    *at = end;
    Some(text.to_owned())
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct InspectorApi {
    install: usize,
    find_var: usize,
    active: usize,
    exists: usize,
    typeof_: usize,
    altrep: usize,
    get_attrib: usize,
    attrib: usize,
    tag: usize,
    cdr: usize,
    car: Option<usize>,
    printname: usize,
    vector_elt: usize,
    xlength: usize,
    string_elt: usize,
    utf8: usize,
    is_s4: usize,
    is_object: usize,
    class_symbol: usize,
    protect: usize,
    unprotect: usize,
    raw_protect: usize,
    raw_unprotect: usize,
    top_level: usize,
    global_env: usize,
    unbound: usize,
    nil: usize,
    names: usize,
    ls3: Option<usize>,
    ls2: Option<usize>,
    integer_elt: Option<usize>,
    real_elt: Option<usize>,
    envlength: Option<usize>,
}

impl InspectorApi {
    pub(crate) unsafe fn load(mut symbol: impl FnMut(&[u8]) -> Option<usize>) -> Option<Self> {
        Some(Self {
            install: symbol(b"Rf_install\0")?,
            find_var: symbol(b"Rf_findVarInFrame\0")?,
            active: symbol(b"R_BindingIsActive\0")?,
            exists: symbol(b"R_existsVarInFrame\0")?,
            typeof_: symbol(b"TYPEOF\0")?,
            altrep: symbol(b"ALTREP\0")?,
            get_attrib: symbol(b"Rf_getAttrib\0")?,
            attrib: symbol(b"ATTRIB\0")?,
            tag: symbol(b"TAG\0")?,
            cdr: symbol(b"CDR\0")?,
            car: symbol(b"CAR\0"),
            printname: symbol(b"PRINTNAME\0")?,
            vector_elt: symbol(b"VECTOR_ELT\0")?,
            xlength: symbol(b"XLENGTH\0")?,
            string_elt: symbol(b"STRING_ELT\0")?,
            utf8: symbol(b"Rf_translateCharUTF8\0")?,
            is_s4: symbol(b"Rf_isS4\0")?,
            is_object: symbol(b"Rf_isObject\0")?,
            class_symbol: symbol(b"R_ClassSymbol\0")?,
            // The C guard retains objects across R_ToplevelExec callbacks
            // with R_PreserveObject, not a cross-callback PROTECT stack entry.
            protect: symbol(b"R_PreserveObject\0")?,
            unprotect: symbol(b"R_ReleaseObject\0")?,
            raw_protect: symbol(b"Rf_protect\0")?,
            raw_unprotect: symbol(b"Rf_unprotect\0")?,
            top_level: symbol(b"R_ToplevelExec\0")?,
            global_env: symbol(b"R_GlobalEnv\0")?,
            unbound: symbol(b"R_UnboundValue\0")?,
            nil: symbol(b"R_NilValue\0")?,
            names: symbol(b"R_NamesSymbol\0")?,
            ls3: symbol(b"R_lsInternal3\0"),
            ls2: symbol(b"R_lsInternal\0"),
            integer_elt: symbol(b"INTEGER_ELT\0"),
            real_elt: symbol(b"REAL_ELT\0"),
            envlength: symbol(b"Rf_envlength\0"),
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Inspection {
    Available(Members),
    Suppressed(Suppression),
    Unavailable,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Members {
    pub(crate) names: Vec<String>,
    pub(crate) kinds: Vec<u8>,
    // 0 = ordinary, 1 = data.frame, 2 = data.table; only used for [ insertion.
    pub(crate) bracket_kind: u8,
}

impl Members {
    fn empty() -> Self {
        Self { names: Vec::new(), kinds: Vec::new(), bracket_kind: 0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Suppression {
    ActiveBinding,
    DeferredBinding,
    UnsafeDispatch,
    UnsafeAltRep,
    UnsafeEnvironment,
    InspectionLimit,
}

#[derive(Clone, Copy)]
enum View {
    Object(Sexp),
    Slice { source: Sexp, index: usize },
}

// R API calls are guarded by a C-only callback. R errors/interrupts use
// non-local jumps and must never cross Rust frames.
const RMG_INSTALL: c_int = 0;
const RMG_FIND: c_int = 1;
const RMG_EXISTS: c_int = 2;
const RMG_ACTIVE: c_int = 3;
const RMG_TYPEOF: c_int = 4;
const RMG_ALTREP: c_int = 5;
const RMG_ATTRIB: c_int = 6;
const RMG_GET_ATTRIB: c_int = 7;
const RMG_TAG: c_int = 8;
const RMG_CAR: c_int = 9;
const RMG_CDR: c_int = 10;
const RMG_PRINTNAME: c_int = 11;
const RMG_VECTOR_ELT: c_int = 12;
const RMG_XLENGTH: c_int = 13;
const RMG_STRING_ELT: c_int = 14;
const RMG_UTF8: c_int = 15;
const RMG_IS_S4: c_int = 16;
const RMG_IS_OBJECT: c_int = 17;
const RMG_PROTECT: c_int = 18;
const RMG_UNPROTECT: c_int = 19;
const RMG_LS3: c_int = 20;
const RMG_LS2: c_int = 21;
const RMG_INTEGER_ELT: c_int = 22;
const RMG_REAL_ELT: c_int = 23;
const RMG_ENVLENGTH: c_int = 24;

unsafe extern "C" {
    fn rmg_begin(toplevel: usize, funcs: *const usize, count: usize,
        raw_protect: usize, raw_unprotect: usize);
    fn rmg_call(method: c_int, a: usize, b: usize, c: usize, out: *mut u64) -> c_int;
    fn rmg_end() -> c_int;
    #[cfg(test)]
    fn rmg_test_error_and_recovery() -> c_int;
    #[cfg(test)]
    fn rmg_test_enumeration_protection() -> c_int;
}

unsafe fn guarded(method: c_int, a: usize, b: usize, c: usize) -> u64 {
    let mut result = 0_u64;
    let _ = rmg_call(method, a, b, c, &mut result);
    result
}

unsafe extern "C" fn guard_install(s: *const c_char) -> Sexp {
    guarded(RMG_INSTALL, s as usize, 0, 0) as usize as Sexp
}
unsafe extern "C" fn guard_find(a: Sexp, b: Sexp) -> Sexp {
    guarded(RMG_FIND, a as usize, b as usize, 0) as usize as Sexp
}
unsafe extern "C" fn guard_exists(a: Sexp, b: Sexp) -> c_int {
    guarded(RMG_EXISTS, a as usize, b as usize, 0) as u32 as c_int
}
unsafe extern "C" fn guard_active(a: Sexp, b: Sexp) -> c_int {
    guarded(RMG_ACTIVE, a as usize, b as usize, 0) as u32 as c_int
}
unsafe extern "C" fn guard_typeof(a: Sexp) -> c_int {
    guarded(RMG_TYPEOF, a as usize, 0, 0) as u32 as c_int
}
unsafe extern "C" fn guard_altrep(a: Sexp) -> c_int {
    guarded(RMG_ALTREP, a as usize, 0, 0) as u32 as c_int
}
unsafe extern "C" fn guard_attrib(a: Sexp) -> Sexp {
    guarded(RMG_ATTRIB, a as usize, 0, 0) as usize as Sexp
}
unsafe extern "C" fn guard_get_attrib(a: Sexp, b: Sexp) -> Sexp {
    guarded(RMG_GET_ATTRIB, a as usize, b as usize, 0) as usize as Sexp
}
unsafe extern "C" fn guard_tag(a: Sexp) -> Sexp {
    guarded(RMG_TAG, a as usize, 0, 0) as usize as Sexp
}
unsafe extern "C" fn guard_car(a: Sexp) -> Sexp {
    guarded(RMG_CAR, a as usize, 0, 0) as usize as Sexp
}
unsafe extern "C" fn guard_cdr(a: Sexp) -> Sexp {
    guarded(RMG_CDR, a as usize, 0, 0) as usize as Sexp
}
unsafe extern "C" fn guard_printname(a: Sexp) -> Sexp {
    guarded(RMG_PRINTNAME, a as usize, 0, 0) as usize as Sexp
}
unsafe extern "C" fn guard_vector_elt(a: Sexp, i: isize) -> Sexp {
    guarded(RMG_VECTOR_ELT, a as usize, i as usize, 0) as usize as Sexp
}
unsafe extern "C" fn guard_xlength(a: Sexp) -> isize {
    guarded(RMG_XLENGTH, a as usize, 0, 0) as usize as isize
}
unsafe extern "C" fn guard_string_elt(a: Sexp, i: isize) -> Sexp {
    guarded(RMG_STRING_ELT, a as usize, i as usize, 0) as usize as Sexp
}
unsafe extern "C" fn guard_utf8(a: Sexp) -> *const c_char {
    guarded(RMG_UTF8, a as usize, 0, 0) as usize as *const c_char
}
unsafe extern "C" fn guard_is_s4(a: Sexp) -> c_int {
    guarded(RMG_IS_S4, a as usize, 0, 0) as u32 as c_int
}
unsafe extern "C" fn guard_is_object(a: Sexp) -> c_int {
    guarded(RMG_IS_OBJECT, a as usize, 0, 0) as u32 as c_int
}
unsafe extern "C" fn guard_protect(a: Sexp) -> Sexp {
    guarded(RMG_PROTECT, a as usize, 0, 0) as usize as Sexp
}
unsafe extern "C" fn guard_unprotect(count: c_int) {
    let _ = guarded(RMG_UNPROTECT, count as usize, 0, 0);
}
unsafe extern "C" fn guard_ls3(a: Sexp, b: c_int, c: c_int) -> Sexp {
    guarded(RMG_LS3, a as usize, b as usize, c as usize) as usize as Sexp
}
unsafe extern "C" fn guard_ls2(a: Sexp, b: c_int) -> Sexp {
    guarded(RMG_LS2, a as usize, b as usize, 0) as usize as Sexp
}
unsafe extern "C" fn guard_integer_elt(a: Sexp, i: isize) -> c_int {
    guarded(RMG_INTEGER_ELT, a as usize, i as usize, 0) as u32 as c_int
}
unsafe extern "C" fn guard_real_elt(a: Sexp, i: isize) -> f64 {
    f64::from_bits(guarded(RMG_REAL_ELT, a as usize, i as usize, 0))
}
unsafe extern "C" fn guard_envlength(a: Sexp) -> c_int {
    guarded(RMG_ENVLENGTH, a as usize, 0, 0) as u32 as c_int
}

unsafe fn begin_inspection_guard(api: InspectorApi) {
    let funcs: [usize; 25] = [
        api.install, api.find_var, api.exists, api.active, api.typeof_,
        api.altrep, api.attrib, api.get_attrib, api.tag,
        api.car.unwrap_or(0), api.cdr, api.printname, api.vector_elt,
        api.xlength, api.string_elt, api.utf8, api.is_s4, api.is_object,
        api.protect, api.unprotect, api.ls3.unwrap_or(0), api.ls2.unwrap_or(0),
        api.integer_elt.unwrap_or(0), api.real_elt.unwrap_or(0),
        api.envlength.unwrap_or(0),
    ];
    rmg_begin(api.top_level, funcs.as_ptr(), funcs.len(),
        api.raw_protect, api.raw_unprotect);
}

type Unary = unsafe extern "C" fn(Sexp) -> Sexp;
type Test = unsafe extern "C" fn(Sexp) -> c_int;
type Find = unsafe extern "C" fn(Sexp, Sexp) -> Sexp;
type Install = unsafe extern "C" fn(*const c_char) -> Sexp;
type Attrib = unsafe extern "C" fn(Sexp, Sexp) -> Sexp;
type Element = unsafe extern "C" fn(Sexp, isize) -> Sexp;
type Size = unsafe extern "C" fn(Sexp) -> isize;
type Utf8 = unsafe extern "C" fn(Sexp) -> *const c_char;
type Unprotect = unsafe extern "C" fn(c_int);

struct Native {
    install: Install,
    find: Find,
    exists: unsafe extern "C" fn(Sexp, Sexp) -> c_int,
    active: unsafe extern "C" fn(Sexp, Sexp) -> c_int,
    type_of: Test,
    altrep: Test,
    attrib: Unary,
    get_attrib: Attrib,
    tag: Unary,
    car: Option<Unary>,
    cdr: Unary,
    printname: Unary,
    vector_elt: Element,
    xlength: Size,
    string_elt: Element,
    utf8: Utf8,
    is_s4: Test,
    is_object: Test,
    protect: Unary,
    unprotect: Unprotect,
    ls3: Option<unsafe extern "C" fn(Sexp, c_int, c_int) -> Sexp>,
    ls2: Option<unsafe extern "C" fn(Sexp, c_int) -> Sexp>,
    integer_elt: Option<unsafe extern "C" fn(Sexp, isize) -> c_int>,
    real_elt: Option<unsafe extern "C" fn(Sexp, isize) -> f64>,
    envlength: Option<unsafe extern "C" fn(Sexp) -> c_int>,
    global: Sexp,
    nil: Sexp,
    unbound: Sexp,
    names: Sexp,
    class: Sexp,
    deadline: Instant,
}

impl Native {
    // The request carries the host's existing TTL. Check it during bounded
    // traversal, without timers, extra R calls or interrupting submitted code.
    fn check_deadline(&self) -> Result<(), Suppression> {
        if Instant::now() >= self.deadline {
            Err(Suppression::InspectionLimit)
        } else {
            Ok(())
        }
    }

    unsafe fn new(api: InspectorApi, deadline: Instant) -> Option<Self> {
        let global = *(api.global_env as *const Sexp);
        let nil = *(api.nil as *const Sexp);
        if global.is_null() || nil.is_null() { return None; }
        Some(Self {
            install: guard_install,
            find: guard_find,
            exists: guard_exists,
            active: guard_active,
            type_of: guard_typeof,
            altrep: guard_altrep,
            attrib: guard_attrib,
            get_attrib: guard_get_attrib,
            tag: guard_tag,
            car: api.car.map(|_| guard_car as _),
            cdr: guard_cdr,
            printname: guard_printname,
            vector_elt: guard_vector_elt,
            xlength: guard_xlength,
            string_elt: guard_string_elt,
            utf8: guard_utf8,
            is_s4: guard_is_s4,
            is_object: guard_is_object,
            protect: guard_protect,
            unprotect: guard_unprotect,
            ls3: api.ls3.map(|_| guard_ls3 as _),
            ls2: api.ls2.map(|_| guard_ls2 as _),
            integer_elt: api.integer_elt.map(|_| guard_integer_elt as _),
            real_elt: api.real_elt.map(|_| guard_real_elt as _),
            envlength: api.envlength.map(|_| guard_envlength as _),
            global,
            nil,
            unbound: *(api.unbound as *const Sexp),
            names: *(api.names as *const Sexp),
            class: *(api.class_symbol as *const Sexp),
            deadline,
        })
    }

    unsafe fn symbol(&self, name: &str) -> Option<Sexp> {
        let name = CString::new(name).ok()?;
        Some((self.install)(name.as_ptr()))
    }

    unsafe fn text(&self, value: Sexp) -> Option<String> {
        if value.is_null() || value == self.nil || (self.type_of)(value) != CHAR {
            return None;
        }
        // XLENGTH on CHARSXP gives its stored byte length. Check before UTF-8
        // translation, which otherwise allocates for arbitrarily long names
        // on the R thread even if the name is discarded afterwards.
        let stored_bytes = (self.xlength)(value);
        if stored_bytes < 0 || stored_bytes as usize > MAX_NAME_BYTES {
            return None;
        }
        let pointer = (self.utf8)(value);
        if pointer.is_null() { return None; }
        let bytes = CStr::from_ptr(pointer).to_bytes();
        if bytes.len() > MAX_NAME_BYTES { return None; }
        Some(String::from_utf8_lossy(bytes).into_owned())
    }

    unsafe fn classes(&self, value: Sexp) -> Result<Vec<String>, Suppression> {
        self.check_deadline()?;
        let class = (self.get_attrib)(value, self.class);
        if class == self.nil { return Ok(Vec::new()); }
        if (self.type_of)(class) != STRING { return Ok(Vec::new()); }
        if (self.altrep)(class) != 0 { return Err(Suppression::UnsafeAltRep); }
        let size = (self.xlength)(class);
        if size < 0 || size > 128 { return Err(Suppression::UnsafeDispatch); }
        let mut names = Vec::new();
        for index in 0..size {
            if index % 32 == 0 { self.check_deadline()?; }
            if let Some(name) = self.text((self.string_elt)(class, index)) {
                names.push(name);
            }
        }
        Ok(names)
    }

    unsafe fn custom_database(&self, env: Sexp) -> Result<bool, Suppression> {
        Ok(self.classes(env)?.iter().any(|class| class == "UserDefinedDatabase"))
    }

    unsafe fn is_s7(&self, value: Sexp) -> Result<bool, Suppression> {
        Ok(self.classes(value)?.iter().any(|class| class == "S7_object") ||
            (self.get_attrib)(value, self.symbol("_S7_class").ok_or(Suppression::UnsafeDispatch)?) != self.nil)
    }

    unsafe fn ordinary_dispatch(&self, value: Sexp) -> Result<bool, Suppression> {
        if (self.is_s4)(value) != 0 { return Ok(false); }
        if (self.is_object)(value) == 0 { return Ok(true); }
        let classes = self.classes(value)?;
        Ok(classes.len() == 1 && classes[0] == "data.frame")
    }

    unsafe fn binding(&self, env: Sexp, name: &str) -> Result<Option<Sexp>, Suppression> {
        self.check_deadline()?;
        if self.custom_database(env)? { return Err(Suppression::UnsafeEnvironment); }
        let Some(sym) = self.symbol(name) else { return Ok(None); };
        if (self.exists)(env, sym) == 0 { return Ok(None); }
        if (self.active)(sym, env) != 0 { return Err(Suppression::ActiveBinding); }
        let value = (self.find)(env, sym);
        if value.is_null() || value == self.unbound { return Ok(None); }
        if (self.type_of)(value) == PROMISE { return Err(Suppression::DeferredBinding); }
        Ok(Some(value))
    }

    // Collect names and stored-member kinds in the same linear pass. Looking
    // each name up again would rescan all preceding names on wide data frames.
    unsafe fn stored_kind(&self, value: Sexp) -> u8 {
        if value.is_null() || value == self.nil || value == self.unbound { return 0; }
        match (self.type_of)(value) {
            CLOSURE | SPECIAL | BUILTIN => 1,
            PROMISE => 3,
            _ => 0,
        }
    }

    unsafe fn vector_members(&self, value: Sexp) -> Result<Members, Suppression> {
        self.check_deadline()?;
        if value == self.nil || (self.type_of)(value) == 9 { return Ok(Members::empty()); }
        let names = (self.get_attrib)(value, self.names);
        if names == self.nil || (self.type_of)(names) != STRING { return Ok(Members::empty()); }
        if (self.altrep)(names) != 0 { return Err(Suppression::UnsafeAltRep); }
        let length = (self.xlength)(names);
        if length < 0 { return Ok(Members::empty()); }
        if length as usize > MAX_NAMES { return Err(Suppression::InspectionLimit); }
        let type_ = (self.type_of)(value);
        let direct = matches!(type_, VECTOR | EXPRESSION) && self.ordinary_dispatch(value)?;
        let mut members = Members::empty();
        let mut seen = HashSet::new();
        for index in 0..length.min(MAX_NAMES as isize) {
            if index % 32 == 0 { self.check_deadline()?; }
            let Some(name) = self.text((self.string_elt)(names, index)) else { continue; };
            if name.is_empty() || name.len() > MAX_NAME_BYTES || !seen.insert(name.clone()) { continue; }
            let kind = if direct {
                self.item(value, index as usize)?
                    .map(|stored| self.stored_kind(stored)).unwrap_or(0)
            } else { 0 };
            members.names.push(name);
            members.kinds.push(kind);
        }
        Ok(members)
    }

    unsafe fn name_at(&self, value: Sexp, index: usize) -> Result<Option<String>, Suppression> {
        self.check_deadline()?;
        let names = (self.get_attrib)(value, self.names);
        if names == self.nil || (self.type_of)(names) != STRING { return Ok(None); }
        if (self.altrep)(names) != 0 { return Err(Suppression::UnsafeAltRep); }
        let len = (self.xlength)(names);
        if len < 0 || index >= len as usize { return Ok(None); }
        Ok(self.text((self.string_elt)(names, index as isize)))
    }

    unsafe fn pair_members(&self, value: Sexp) -> Result<Members, Suppression> {
        let mut cursor = value;
        let mut members = Members::empty();
        let mut seen = HashSet::new();
        let mut scanned = 0;
        let type_ = (self.type_of)(value);
        let direct = matches!(type_, LIST | LANGUAGE) && self.ordinary_dispatch(value)?;
        while cursor != self.nil && members.names.len() < MAX_NAMES && scanned < MAX_SCANNED_ENTRIES {
            if scanned % 32 == 0 { self.check_deadline()?; }
            scanned += 1;
            let tag = (self.tag)(cursor);
            if tag != self.nil {
                if let Some(name) = self.text((self.printname)(tag)) {
                    if !name.is_empty() && name.len() <= MAX_NAME_BYTES && seen.insert(name.clone()) {
                        let kind = if direct {
                            self.car.map(|car| self.stored_kind(car(cursor))).unwrap_or(0)
                        } else { 0 };
                        members.names.push(name);
                        members.kinds.push(kind);
                    }
                }
            }
            cursor = (self.cdr)(cursor);
        }
        if cursor != self.nil { return Err(Suppression::InspectionLimit); }
        Ok(members)
    }

    unsafe fn slot_names(&self, value: Sexp) -> Result<Vec<String>, Suppression> {
        let mut cursor = (self.attrib)(value);
        let mut names = Vec::new();
        let mut scanned = 0;
        while cursor != self.nil && names.len() < MAX_NAMES && scanned < MAX_SCANNED_ENTRIES {
            if scanned % 32 == 0 { self.check_deadline()?; }
            scanned += 1;
            let tag = (self.tag)(cursor);
            if tag != self.nil {
                if let Some(name) = self.text((self.printname)(tag)) {
                    if name != "class" && name != "_S7_class" &&
                        !name.is_empty() && name.len() <= MAX_NAME_BYTES {
                        names.push(name);
                    }
                }
            }
            cursor = (self.cdr)(cursor);
        }
        if cursor != self.nil { return Err(Suppression::InspectionLimit); }
        Ok(names)
    }

    unsafe fn environment_names(&self, value: Sexp) -> Result<Vec<String>, Suppression> {
        self.check_deadline()?;
        if self.custom_database(value)? { return Err(Suppression::UnsafeEnvironment); }
        // R_lsInternal allocates and sorts every binding before returning.
        // Refuse large environments first; when the preflight API is unavailable,
        // avoid full enumeration rather than guessing about its cost.
        let Some(envlength) = self.envlength else { return Err(Suppression::InspectionLimit); };
        let bindings = envlength(value);
        if bindings < 0 || bindings > MAX_ENV_BINDINGS { return Err(Suppression::InspectionLimit); }
        self.check_deadline()?;
        // The C callback temporarily PROTECTs the allocation while adding
        // it to R's precious list; release it after converting the names.
        let names = if let Some(ls) = self.ls3 { ls(value, 1, 1) }
            else if let Some(ls) = self.ls2 { ls(value, 1) }
            else { return Err(Suppression::InspectionLimit); };
        if names.is_null() { return Ok(Vec::new()); }
        if names == self.nil {
            (self.unprotect)(1); // The C guard also preserves a non-null R_NilValue.
            return Ok(Vec::new());
        }
        let result = (|| -> Result<Vec<String>, Suppression> {
            unsafe {
                if (self.altrep)(names) != 0 { return Err(Suppression::UnsafeAltRep); }
                let count = (self.xlength)(names);
                if count < 0 { return Ok(Vec::new()); }
                if count as usize > MAX_NAMES { return Err(Suppression::InspectionLimit); }
                let mut members = Vec::new();
                for index in 0..count.min(MAX_NAMES as isize) {
                    if index % 32 == 0 { self.check_deadline()?; }
                    let Some(name) = self.text((self.string_elt)(names, index)) else { continue; };
                    if !name.is_empty() && name.len() <= MAX_NAME_BYTES { members.push(name); }
                }
                Ok(members)
            }
        })();
        (self.unprotect)(1);
        result
    }

    unsafe fn classify_unindexed(&self, value: Sexp, target: Target, names: Vec<String>)
        -> Result<Members, Suppression> {
        let mut kinds = Vec::with_capacity(names.len());
        for (index, name) in names.iter().enumerate() {
            if index % 32 == 0 { self.check_deadline()?; }
            kinds.push(self.member_kind(value, target, name)?);
        }
        Ok(Members { names, kinds, bracket_kind: 0 })
    }

    unsafe fn names_for(&self, value: Sexp, target: Target) -> Result<Members, Suppression> {
        self.check_deadline()?;
        if value == self.nil { return Ok(Members::empty()); }
        let kind = (self.type_of)(value);
        if target == Target::Slot {
            return if (self.is_s4)(value) != 0 || self.is_s7(value)? {
                self.classify_unindexed(value, target, self.slot_names(value)?)
            } else { Ok(Members::empty()) };
        }
        if kind == ENV {
            return if target == Target::Dollar {
                self.classify_unindexed(value, target, self.environment_names(value)?)
            } else { Ok(Members::empty()) };
        }
        if target == Target::Dollar && !matches!(kind, VECTOR | EXPRESSION | LIST | LANGUAGE) {
            return Ok(Members::empty());
        }
        let mut members = if matches!(kind, LIST | LANGUAGE | DOTS) {
            self.pair_members(value)?
        } else if matches!(kind, VECTOR | EXPRESSION | LOGICAL | INTEGER | REAL | COMPLEX | STRING | RAW) {
            self.vector_members(value)?
        } else {
            Members::empty()
        };
        if target == Target::Bracket {
            let classes = self.classes(value)?;
            members.bracket_kind = if classes.iter().any(|name| name == "data.table") {
                2
            } else if classes.iter().any(|name| name == "data.frame") {
                1
            } else {
                0
            };
        }
        Ok(members)
    }

    unsafe fn index_of(&self, value: Sexp, name: &str) -> Result<Option<usize>, Suppression> {
        let kind = (self.type_of)(value);
        if matches!(kind, LIST | LANGUAGE | DOTS) {
            let mut cursor = value;
            let mut index = 0;
            while cursor != self.nil && index < MAX_SCANNED_ENTRIES {
                if index % 32 == 0 { self.check_deadline()?; }
                let tag = (self.tag)(cursor);
                if tag != self.nil && self.text((self.printname)(tag)).as_deref() == Some(name) {
                    return Ok(Some(index));
                }
                cursor = (self.cdr)(cursor);
                index += 1;
            }
            return Ok(None);
        }
        let names = (self.get_attrib)(value, self.names);
        if names == self.nil || (self.type_of)(names) != STRING {
            return Ok(None);
        }
        if (self.altrep)(names) != 0 { return Err(Suppression::UnsafeAltRep); }
        let len = (self.xlength)(names);
        if len < 0 { return Ok(None); }
        for index in 0..len.min(MAX_SCANNED_ENTRIES as isize) {
            if index % 32 == 0 { self.check_deadline()?; }
            if self.text((self.string_elt)(names, index)).as_deref() == Some(name) {
                return Ok(Some(index as usize));
            }
        }
        Ok(None)
    }

    unsafe fn item(&self, value: Sexp, index: usize) -> Result<Option<Sexp>, Suppression> {
        let kind = (self.type_of)(value);
        if matches!(kind, VECTOR | EXPRESSION) {
            if (self.altrep)(value) != 0 { return Err(Suppression::UnsafeAltRep); }
            let len = (self.xlength)(value);
            if len < 0 || index >= len as usize { return Ok(None); }
            return Ok(Some((self.vector_elt)(value, index as isize)));
        }
        if matches!(kind, LIST | LANGUAGE | DOTS) {
            if index >= MAX_SCANNED_ENTRIES { return Ok(None); }
            let mut cursor = value;
            for offset in 0..index {
                if offset % 32 == 0 { self.check_deadline()?; }
                if cursor == self.nil { return Ok(None); }
                cursor = (self.cdr)(cursor);
            }
            return if cursor == self.nil { Ok(None) } else {
                Ok(self.car.map(|car| car(cursor)))
            };
        }
        Ok(None)
    }

    unsafe fn scalar_index(&self, name: &str) -> Result<Option<Step>, Suppression> {
        self.check_deadline()?;
        let Some(value) = self.binding(self.global, name)? else { return Ok(None); };
        if (self.altrep)(value) != 0 { return Err(Suppression::UnsafeAltRep); }
        if (self.is_object)(value) != 0 { return Err(Suppression::UnsafeDispatch); }
        if (self.xlength)(value) != 1 { return Ok(None); }
        match (self.type_of)(value) {
            INTEGER if self.integer_elt.is_some() => {
                let number = self.integer_elt.unwrap()(value, 0);
                if number > 0 && number <= 100_000 { Ok(Some(Step::Index(number as u32))) }
                else { Ok(None) }
            }
            REAL if self.real_elt.is_some() => {
                let number = self.real_elt.unwrap()(value, 0);
                if number.is_finite() && number.fract() == 0.0 &&
                   (1.0..=100_000.0).contains(&number) {
                    Ok(Some(Step::Index(number as u32)))
                } else { Ok(None) }
            }
            STRING => {
                let text = self.text((self.string_elt)(value, 0));
                Ok(text.map(Step::NamedIndex))
            }
            _ => Ok(None),
        }
    }

    unsafe fn step(&self, view: View, step: &Step) -> Result<Option<View>, Suppression> {
        self.check_deadline()?;
        let checked = match step {
            Step::VariableIndex(name) => self.scalar_index(name)?,
            Step::VariableSlice(name) => self.scalar_index(name)?.map(|index| match index {
                Step::Index(value) => Step::SliceIndex(value),
                Step::NamedIndex(value) => Step::SliceName(value),
                other => other,
            }),
            other => Some(other.clone()),
        };
        let Some(step) = checked else { return Ok(None); };
        match view {
            View::Slice { source, index } => {
                let selected_name = self.name_at(source, index)?;
                match &step {
                    Step::Index(1) | Step::SliceIndex(1) => {
                        if matches!(step, Step::SliceIndex(_)) {
                            Ok(Some(View::Slice { source, index }))
                        } else {
                            Ok(self.item(source, index)?.map(View::Object))
                        }
                    }
                    Step::NamedIndex(name) | Step::Field(name) | Step::SliceName(name)
                        if selected_name.as_deref() == Some(name.as_str()) => {
                        if matches!(step, Step::SliceName(_)) {
                            Ok(Some(View::Slice { source, index }))
                        } else {
                            Ok(self.item(source, index)?.map(View::Object))
                        }
                    }
                    _ => Ok(None),
                }
            }
            View::Object(value) => {
                if value == self.nil { return Ok(None); }
                let kind = (self.type_of)(value);
                if matches!(step, Step::Slot(_)) {
                    if self.is_s7(value)? { return Err(Suppression::UnsafeDispatch); }
                    if (self.is_s4)(value) == 0 { return Ok(None); }
                    if let Step::Slot(name) = step {
                        if !self.slot_names(value)?.iter().any(|part| part == &name) {
                            return Ok(None);
                        }
                        let Some(symbol) = self.symbol(&name) else { return Ok(None); };
                        let next = (self.get_attrib)(value, symbol);
                        return Ok(Some(View::Object(next)));
                    }
                }
                if kind == ENV {
                    return match step {
                        Step::Field(name) | Step::NamedIndex(name) =>
                            Ok(self.binding(value, &name)?.map(View::Object)),
                        _ => Ok(None),
                    };
                }
                if !matches!(kind, VECTOR | EXPRESSION | LIST | LANGUAGE) {
                    return Ok(None);
                }
                if !self.ordinary_dispatch(value)? {
                    return Err(Suppression::UnsafeDispatch);
                }
                match step {
                    Step::Field(name) | Step::NamedIndex(name) => {
                        let Some(index) = self.index_of(value, &name)? else { return Ok(None); };
                        Ok(self.item(value, index)?.map(View::Object))
                    }
                    Step::Index(index) => {
                        Ok(self.item(value, index as usize - 1)?.map(View::Object))
                    }
                    Step::SliceIndex(index) if matches!(kind, VECTOR | EXPRESSION) => {
                        if self.item(value, index as usize - 1)?.is_some() {
                            Ok(Some(View::Slice { source: value, index: index as usize - 1 }))
                        } else { Ok(None) }
                    }
                    Step::SliceName(name) if matches!(kind, VECTOR | EXPRESSION) => {
                        Ok(self.index_of(value, &name)?.map(|index| View::Slice { source: value, index }))
                    }
                    _ => Ok(None),
                }
            }
        }
    }

    unsafe fn member_kind(&self, value: Sexp, target: Target, name: &str) -> Result<u8, Suppression> {
        let kind = (self.type_of)(value);
        let stored = if kind == ENV && matches!(target, Target::Dollar | Target::DoubleBracket) {
            if self.custom_database(value)? { return Err(Suppression::UnsafeEnvironment); }
            let Some(symbol) = self.symbol(name) else { return Ok(0); };
            if (self.exists)(value, symbol) == 0 { return Ok(0); }
            if (self.active)(symbol, value) != 0 { return Ok(2); }
            (self.find)(value, symbol)
        } else if target == Target::Slot {
            if self.is_s7(value)? { return Ok(2); }
            if (self.is_s4)(value) == 0 { return Ok(0); }
            let Some(symbol) = self.symbol(name) else { return Ok(0); };
            (self.get_attrib)(value, symbol)
        } else {
            return Ok(0);
        };
        Ok(self.stored_kind(stored))
    }

    unsafe fn inspect(&self, query: &MemberQuery) -> Result<Members, Suppression> {
        self.check_deadline()?;
        let Some(root) = self.binding(self.global, &query.root)? else { return Ok(Members::empty()); };
        (self.protect)(root);
        let mut protected = 1;
        let outcome = (|| -> Result<Members, Suppression> {
            unsafe {
                let mut current = View::Object(root);
                for step in &query.steps {
                    self.check_deadline()?;
                    let Some(next) = self.step(current, step)? else { return Ok(Members::empty()); };
                    if let View::Object(value) = next {
                        if (self.type_of)(value) == PROMISE { return Err(Suppression::DeferredBinding); }
                        if value.is_null() { return Ok(Members::empty()); }
                        (self.protect)(value);
                        protected += 1;
                    }
                    current = next;
                }
                match current {
                    View::Object(value) => {
                        if (self.type_of)(value) == PROMISE { return Err(Suppression::DeferredBinding); }
                        self.names_for(value, query.target)
                    }
                    View::Slice { source, index } => {
                        if query.target == Target::Slot { return Ok(Members::empty()); }
                        if query.target == Target::Dollar && (self.type_of)(source) != VECTOR {
                            return Ok(Members::empty());
                        }
                        let names: Vec<String> = self.name_at(source, index)?.into_iter().collect();
                        let kind = if (self.type_of)(source) == VECTOR && self.ordinary_dispatch(source)? {
                            self.item(source, index)?.map(|stored| match (self.type_of)(stored) {
                                CLOSURE | SPECIAL | BUILTIN => 1,
                                PROMISE => 3,
                                _ => 0,
                            }).unwrap_or(0)
                        } else { 0 };
                        let kinds = names.iter().map(|_| kind).collect();
                        Ok(Members { names, kinds, bracket_kind: 0 })
                    }
                }
            }
        })();
        (self.unprotect)(protected);
        outcome
    }
}

pub(crate) fn inspect(api: InspectorApi, query: MemberQuery, deadline: Instant) -> Inspection {
    // Every R API call is made in the C guard. In particular, do not execute
    // Rust code as an R_ToplevelExec callback: R errors/interrupts use longjmp.
    if Instant::now() >= deadline { return Inspection::Unavailable; }
    unsafe {
        begin_inspection_guard(api);
        let result = Native::new(api, deadline).map(|native| native.inspect(&query));
        if rmg_end() != 0 {
            return Inspection::Unavailable;
        }
        match result {
            Some(Ok(names)) => Inspection::Available(names),
            Some(Err(Suppression::InspectionLimit)) => Inspection::Unavailable,
            Some(Err(reason)) => Inspection::Suppressed(reason),
            None => Inspection::Unavailable,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(s: &str, out: &mut Vec<u8>) {
        out.extend_from_slice(&(s.len() as u32).to_le_bytes());
        out.extend_from_slice(s.as_bytes());
    }

    #[test]
    fn r_error_and_interrupt_jumps_are_caught_without_crossing_rust() {
        assert_eq!(unsafe { rmg_test_error_and_recovery() }, 1);
    }

    #[test]
    fn enumeration_is_protected_before_returning_to_rust() {
        assert_eq!(unsafe { rmg_test_enumeration_protection() }, 1);
    }

    #[test]
    fn structured_paths_and_targets() {
        let mut bytes = vec![3, 3];
        name("obj", &mut bytes);
        bytes.push(0); name("inner", &mut bytes);
        bytes.push(3); name("a b", &mut bytes);
        bytes.push(2); bytes.extend_from_slice(&1u32.to_le_bytes());
        assert_eq!(MemberQuery::decode(&bytes), Some(MemberQuery {
            root: "obj".to_owned(),
            steps: vec![Step::Field("inner".to_owned()),
                Step::NamedIndex("a b".to_owned()), Step::Index(1)],
            target: Target::DoubleBracket,
        }));
        assert_eq!(MemberQuery::decode(&bytes[..bytes.len()-1]), None);
        bytes[1] = 13;
        assert_eq!(MemberQuery::decode(&bytes), None);
        let mut root = vec![0, 0];
        name("task", &mut root);
        assert_eq!(MemberQuery::decode(&root), Some(MemberQuery {
            root: "task".to_owned(), steps: Vec::new(), target: Target::Dollar,
        }));
    }
}
