//! Bounded, non-evaluating inspection for console completion.
//! Only R's interpreter thread may call inspect(). No R code is evaluated,
//! promises are never forced, and no S3/S4 extraction method is dispatched.
use std::ffi::{c_char, c_int, c_void, CStr, CString};

type Sexp = *mut c_void;
const VECSXP: c_int = 19;
const STRSXP: c_int = 16;
const PROMSXP: c_int = 5;
const MAX_DEPTH: usize = 12;
const MAX_NAMES: usize = 1000;
const MAX_NAME_BYTES: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Field(String),
    Slot(String),
    Index(u32), // one-based, as in R's [[
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MemberQuery {
    pub root: String,
    pub steps: Vec<Step>,
    pub slots: bool,
}

impl MemberQuery {
    pub(crate) fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 7 { return None; }
        let slots = match bytes[0] { 0 => false, 1 => true, _ => return None };
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
                2 => {
                    let value = read_u32(bytes, &mut at)?;
                    if value == 0 || value > 100_000 { return None; }
                    Step::Index(value)
                }
                _ => return None,
            };
            steps.push(step);
        }
        if at != bytes.len() { return None; }
        Some(Self { root, steps, slots })
    }
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

/// Dynamic R API addresses, loaded from the already embedded libR/R.dll.
/// Keeping this optional avoids changing startup on older R installations.
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
    top_level: usize,
    global_env: usize,
    unbound: usize,
    nil: usize,
    names: usize,
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
            printname: symbol(b"PRINTNAME\0")?,
            vector_elt: symbol(b"VECTOR_ELT\0")?,
            xlength: symbol(b"XLENGTH\0")?,
            string_elt: symbol(b"STRING_ELT\0")?,
            utf8: symbol(b"Rf_translateCharUTF8\0")?,
            is_s4: symbol(b"Rf_isS4\0")?,
            is_object: symbol(b"Rf_isObject\0")?,
            class_symbol: symbol(b"R_ClassSymbol\0")?,
            protect: symbol(b"Rf_protect\0")?,
            unprotect: symbol(b"Rf_unprotect\0")?,
            top_level: symbol(b"R_ToplevelExec\0")?,
            global_env: symbol(b"R_GlobalEnv\0")?,
            unbound: symbol(b"R_UnboundValue\0")?,
            nil: symbol(b"R_NilValue\0")?,
            names: symbol(b"R_NamesSymbol\0")?,
        })
    }
}

/// Return explicit safety decisions; never interpret missing data as rejection.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Inspection {
    Available(Vec<String>),
    Suppressed(Suppression),
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Suppression {
    ActiveBinding,
    DeferredBinding,
    UnsupportedAccessor,
    UnsupportedStructure,
}

pub(crate) fn inspect(api: InspectorApi, query: MemberQuery) -> Inspection {
    struct Context {
        api: InspectorApi,
        query: MemberQuery,
        result: Option<Result<Vec<String>, Suppression>>,
    }
    unsafe extern "C" fn invoke(data: *mut c_void) {
        let context = &mut *(data as *mut Context);
        context.result = inspect_inner(context.api, &context.query);
    }
    let mut context = Context { api, query, result: None };
    let top: unsafe extern "C" fn(unsafe extern "C" fn(*mut c_void), *mut c_void) -> c_int =
        unsafe { std::mem::transmute(api.top_level) };
    let ok = unsafe { top(invoke, &mut context as *mut Context as *mut c_void) };
    if ok == 0 { return Inspection::Unavailable; }
    match context.result {
        Some(Ok(names)) => Inspection::Available(names),
        Some(Err(reason)) => Inspection::Suppressed(reason),
        None => Inspection::Unavailable,
    }
}

unsafe fn inspect_inner(api: InspectorApi, query: &MemberQuery) -> Option<Result<Vec<String>, Suppression>> {
    type Unary = unsafe extern "C" fn(Sexp) -> Sexp;
    type Test = unsafe extern "C" fn(Sexp) -> c_int;
    type TypeOf = unsafe extern "C" fn(Sexp) -> c_int;
    type Install = unsafe extern "C" fn(*const c_char) -> Sexp;
    type Find = unsafe extern "C" fn(Sexp, Sexp) -> Sexp;
    type Active = unsafe extern "C" fn(Sexp, Sexp) -> c_int;
    type Attrib = unsafe extern "C" fn(Sexp, Sexp) -> Sexp;
    type Element = unsafe extern "C" fn(Sexp, isize) -> Sexp;
    type Size = unsafe extern "C" fn(Sexp) -> isize;
    type Utf8 = unsafe extern "C" fn(Sexp) -> *const c_char;
    type Unprotect = unsafe extern "C" fn(c_int);

    let install: Install = std::mem::transmute(api.install);
    let find_var: Find = std::mem::transmute(api.find_var);
    let binding_active: Active = std::mem::transmute(api.active);
    let binding_exists: Active = std::mem::transmute(api.exists);
    let typeof_: TypeOf = std::mem::transmute(api.typeof_);
    let altrep: Test = std::mem::transmute(api.altrep);
    let get_attrib: Attrib = std::mem::transmute(api.get_attrib);
    let attrib: Unary = std::mem::transmute(api.attrib);
    let tag: Unary = std::mem::transmute(api.tag);
    let cdr: Unary = std::mem::transmute(api.cdr);
    let printname: Unary = std::mem::transmute(api.printname);
    let vector_elt: Element = std::mem::transmute(api.vector_elt);
    let xlength: Size = std::mem::transmute(api.xlength);
    let string_elt: Element = std::mem::transmute(api.string_elt);
    let utf8: Utf8 = std::mem::transmute(api.utf8);
    let is_s4: Test = std::mem::transmute(api.is_s4);
    let is_object: Test = std::mem::transmute(api.is_object);
    let protect: Unary = std::mem::transmute(api.protect);
    let unprotect: Unprotect = std::mem::transmute(api.unprotect);
    let global = *(api.global_env as *const Sexp);
    let unbound = *(api.unbound as *const Sexp);
    let nil = *(api.nil as *const Sexp);
    let names_symbol = *(api.names as *const Sexp);
    let class_symbol = *(api.class_symbol as *const Sexp);
    if global.is_null() || nil.is_null() { return None; }

    // On a missing binding R_BindingIsActive may signal an error, caught by
    // R_ToplevelExec. It never reads or evaluates the binding's value.
    let root = install(CString::new(query.root.as_str()).ok()?.as_ptr());
    if binding_exists(global, root) == 0 { return None; }
    if binding_active(root, global) != 0 { return Some(Err(Suppression::ActiveBinding)); }
    let mut value = find_var(global, root);
    if value.is_null() || value == unbound || value == nil { return None; }
    if typeof_(value) == PROMSXP { return Some(Err(Suppression::DeferredBinding)); }
    protect(value);
    let mut protected = 1;
    let outcome = (|| -> Result<Vec<String>, Suppression> {
        unsafe {
        // Raw list extraction is equivalent to console access only for plain
        // lists and unmodified data.frames. Other S3 classes may define $ or [[
        // and must not be guessed from their storage.
        let container_is_safe = |obj: Sexp| -> bool {
            if typeof_(obj) != VECSXP || is_s4(obj) != 0 { return false; }
            if is_object(obj) == 0 { return true; }
            let class = get_attrib(obj, class_symbol);
            class != nil && altrep(class) == 0 && typeof_(class) == STRSXP &&
                xlength(class) == 1 && {
                    let cls = utf8(string_elt(class, 0));
                    !cls.is_null() && CStr::from_ptr(cls).to_bytes() == b"data.frame"
                }
        };
        for step in &query.steps {
            if altrep(value) != 0 { return Err(Suppression::UnsupportedStructure); }
            let next = match step {
                Step::Slot(name) => {
                    if is_s4(value) == 0 || name.starts_with('.') { return Err(Suppression::UnsupportedAccessor); }
                    get_attrib(value, install(CString::new(name.as_str()).map_err(|_| Suppression::UnsupportedAccessor)?.as_ptr()))
                }
                Step::Field(name) => {
                    if !container_is_safe(value) { return Err(Suppression::UnsupportedAccessor); }
                    let names = get_attrib(value, names_symbol);
                    if names == nil || typeof_(names) != STRSXP || altrep(names) != 0 { return Err(Suppression::UnsupportedStructure); }
                    let len = xlength(names);
                    if len < 0 || len as usize > MAX_NAMES { return Err(Suppression::UnsupportedStructure); }
                    let index = (0..len).find(|&i| {
                        let raw = utf8(string_elt(names, i));
                        !raw.is_null() && CStr::from_ptr(raw).to_bytes() == name.as_bytes()
                    }).ok_or(Suppression::UnsupportedStructure)?;
                    vector_elt(value, index)
                }
                Step::Index(index) => {
                    if !container_is_safe(value) { return Err(Suppression::UnsupportedAccessor); }
                    let len = xlength(value);
                    if *index as isize > len { return Err(Suppression::UnsupportedStructure); }
                    vector_elt(value, (*index - 1) as isize)
                }
            };
            if next.is_null() || next == nil { return Err(Suppression::UnsupportedStructure); }
            if typeof_(next) == PROMSXP { return Err(Suppression::DeferredBinding); }
            protect(next);
            protected += 1;
            value = next;
        }
        if altrep(value) != 0 { return Err(Suppression::UnsupportedStructure); }
        if query.slots {
            if is_s4(value) == 0 { return Err(Suppression::UnsupportedAccessor); }
            let mut node = attrib(value);
            let mut members = Vec::new();
            while node != nil {
                if members.len() >= MAX_NAMES { return Err(Suppression::UnsupportedStructure); }
                let sym = tag(node);
                let text = utf8(printname(sym));
                if !text.is_null() {
                    let name = CStr::from_ptr(text).to_string_lossy();
                    if name != "class" && !name.starts_with('.') && name.len() <= MAX_NAME_BYTES {
                        members.push(name.into_owned());
                    }
                }
                node = cdr(node);
            }
            return Ok(members);
        }
        if !container_is_safe(value) { return Err(Suppression::UnsupportedAccessor); }
        let names = get_attrib(value, names_symbol);
        if names == nil { return Ok(Vec::new()); }
        if typeof_(names) != STRSXP || altrep(names) != 0 { return Err(Suppression::UnsupportedStructure); }
        let len = xlength(names);
        if len < 0 || len as usize > MAX_NAMES { return Err(Suppression::UnsupportedStructure); }
        let mut members = Vec::new();
        for i in 0..len {
            let ptr = utf8(string_elt(names, i));
            if ptr.is_null() { continue; }
            let name = CStr::from_ptr(ptr).to_string_lossy();
            if !name.is_empty() && name.len() <= MAX_NAME_BYTES && !members.contains(&name.to_string()) {
                members.push(name.into_owned());
            }
        }
        Ok(members)
        }
    })();
    unprotect(protected);
    Some(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn name(s: &str, out: &mut Vec<u8>) {
        out.extend_from_slice(&(s.len() as u32).to_le_bytes());
        out.extend_from_slice(s.as_bytes());
    }
    #[test]
    fn only_structured_paths_are_accepted() {
        let mut bytes = vec![0, 2];
        name("obj", &mut bytes);
        bytes.push(0); name("inner", &mut bytes);
        bytes.push(2); bytes.extend_from_slice(&1u32.to_le_bytes());
        assert_eq!(MemberQuery::decode(&bytes), Some(MemberQuery {
            root: "obj".to_owned(), steps: vec![Step::Field("inner".to_owned()), Step::Index(1)], slots: false
        }));
        assert_eq!(MemberQuery::decode(&bytes[..bytes.len() - 1]), None);
        bytes[1] = 13;
        assert_eq!(MemberQuery::decode(&bytes), None);
    }
}
