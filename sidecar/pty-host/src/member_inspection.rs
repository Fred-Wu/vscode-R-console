use std::ffi::{c_char, c_int, c_void, CStr, CString};

type Sexp = *mut c_void;
const NIL: c_int = 0;
const LIST: c_int = 2;
const CLOSURE: c_int = 3;
const ENV: c_int = 4;
const PROMISE: c_int = 5;
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
    top_level: usize,
    global_env: usize,
    unbound: usize,
    nil: usize,
    names: usize,
    ls3: Option<usize>,
    ls2: Option<usize>,
    integer_elt: Option<usize>,
    real_elt: Option<usize>,
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
            protect: symbol(b"Rf_protect\0")?,
            unprotect: symbol(b"Rf_unprotect\0")?,
            top_level: symbol(b"R_ToplevelExec\0")?,
            global_env: symbol(b"R_GlobalEnv\0")?,
            unbound: symbol(b"R_UnboundValue\0")?,
            nil: symbol(b"R_NilValue\0")?,
            names: symbol(b"R_NamesSymbol\0")?,
            ls3: symbol(b"R_lsInternal3\0"),
            ls2: symbol(b"R_lsInternal\0"),
            integer_elt: symbol(b"INTEGER_ELT\0"),
            real_elt: symbol(b"REAL_ELT\0"),
        })
    }
}

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
    UnsafeDispatch,
    UnsafeAltRep,
    UnsafeEnvironment,
}

#[derive(Clone, Copy)]
enum View {
    Object(Sexp),
    Slice { source: Sexp, index: usize },
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
    global: Sexp,
    nil: Sexp,
    unbound: Sexp,
    names: Sexp,
    class: Sexp,
}

impl Native {
    unsafe fn new(api: InspectorApi) -> Option<Self> {
        let global = *(api.global_env as *const Sexp);
        let nil = *(api.nil as *const Sexp);
        if global.is_null() || nil.is_null() { return None; }
        Some(Self {
            install: std::mem::transmute(api.install),
            find: std::mem::transmute(api.find_var),
            exists: std::mem::transmute(api.exists),
            active: std::mem::transmute(api.active),
            type_of: std::mem::transmute(api.typeof_),
            altrep: std::mem::transmute(api.altrep),
            attrib: std::mem::transmute(api.attrib),
            get_attrib: std::mem::transmute(api.get_attrib),
            tag: std::mem::transmute(api.tag),
            car: api.car.map(|p| std::mem::transmute(p)),
            cdr: std::mem::transmute(api.cdr),
            printname: std::mem::transmute(api.printname),
            vector_elt: std::mem::transmute(api.vector_elt),
            xlength: std::mem::transmute(api.xlength),
            string_elt: std::mem::transmute(api.string_elt),
            utf8: std::mem::transmute(api.utf8),
            is_s4: std::mem::transmute(api.is_s4),
            is_object: std::mem::transmute(api.is_object),
            protect: std::mem::transmute(api.protect),
            unprotect: std::mem::transmute(api.unprotect),
            ls3: api.ls3.map(|p| std::mem::transmute(p)),
            ls2: api.ls2.map(|p| std::mem::transmute(p)),
            integer_elt: api.integer_elt.map(|p| std::mem::transmute(p)),
            real_elt: api.real_elt.map(|p| std::mem::transmute(p)),
            global,
            nil,
            unbound: *(api.unbound as *const Sexp),
            names: *(api.names as *const Sexp),
            class: *(api.class_symbol as *const Sexp),
        })
    }

    unsafe fn symbol(&self, name: &str) -> Option<Sexp> {
        let name = CString::new(name).ok()?;
        Some((self.install)(name.as_ptr()))
    }

    unsafe fn text(&self, value: Sexp) -> Option<String> {
        if value.is_null() || value == self.nil { return None; }
        let pointer = (self.utf8)(value);
        if pointer.is_null() { return None; }
        Some(CStr::from_ptr(pointer).to_string_lossy().into_owned())
    }

    unsafe fn classes(&self, value: Sexp) -> Result<Vec<String>, Suppression> {
        let class = (self.get_attrib)(value, self.class);
        if class == self.nil { return Ok(Vec::new()); }
        if (self.type_of)(class) != STRING { return Ok(Vec::new()); }
        if (self.altrep)(class) != 0 { return Err(Suppression::UnsafeAltRep); }
        let size = (self.xlength)(class);
        if size < 0 || size > 128 { return Err(Suppression::UnsafeDispatch); }
        let mut names = Vec::new();
        for index in 0..size {
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
        if self.custom_database(env)? { return Err(Suppression::UnsafeEnvironment); }
        let Some(sym) = self.symbol(name) else { return Ok(None); };
        if (self.exists)(env, sym) == 0 { return Ok(None); }
        if (self.active)(sym, env) != 0 { return Err(Suppression::ActiveBinding); }
        let value = (self.find)(env, sym);
        if value.is_null() || value == self.unbound { return Ok(None); }
        if (self.type_of)(value) == PROMISE { return Err(Suppression::DeferredBinding); }
        Ok(Some(value))
    }

    unsafe fn vector_names(&self, value: Sexp) -> Result<Vec<String>, Suppression> {
        if value == self.nil { return Ok(Vec::new()); }
        if (self.type_of)(value) == 9 { return Ok(Vec::new()); }
        let names = (self.get_attrib)(value, self.names);
        if names == self.nil { return Ok(Vec::new()); }
        if (self.type_of)(names) != STRING { return Ok(Vec::new()); }
        if (self.altrep)(names) != 0 { return Err(Suppression::UnsafeAltRep); }
        let length = (self.xlength)(names);
        if length < 0 { return Ok(Vec::new()); }
        let mut result = Vec::new();
        for index in 0..length.min(MAX_NAMES as isize) {
            let Some(name) = self.text((self.string_elt)(names, index)) else { continue; };
            if !name.is_empty() && name.len() <= MAX_NAME_BYTES && !result.contains(&name) {
                result.push(name);
            }
        }
        Ok(result)
    }

    unsafe fn pair_names(&self, value: Sexp) -> Vec<String> {
        let mut cursor = value;
        let mut names = Vec::new();
        while cursor != self.nil && names.len() < MAX_NAMES {
            let tag = (self.tag)(cursor);
            if tag != self.nil {
                if let Some(name) = self.text((self.printname)(tag)) {
                    if !name.is_empty() && name.len() <= MAX_NAME_BYTES && !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
            cursor = (self.cdr)(cursor);
        }
        names
    }

    unsafe fn slot_names(&self, value: Sexp) -> Vec<String> {
        let mut cursor = (self.attrib)(value);
        let mut names = Vec::new();
        while cursor != self.nil && names.len() < MAX_NAMES {
            let tag = (self.tag)(cursor);
            if tag != self.nil {
                if let Some(name) = self.text((self.printname)(tag)) {
                    if name != "class" && name != "_S7_class" && !name.starts_with('.') &&
                        !name.is_empty() && name.len() <= MAX_NAME_BYTES {
                        names.push(name);
                    }
                }
            }
            cursor = (self.cdr)(cursor);
        }
        names
    }

    unsafe fn environment_names(&self, value: Sexp) -> Result<Vec<String>, Suppression> {
        if self.custom_database(value)? { return Err(Suppression::UnsafeEnvironment); }
        let names = if let Some(ls) = self.ls3 { ls(value, 1, 1) }
            else if let Some(ls) = self.ls2 { ls(value, 1) }
            else { return Ok(Vec::new()); };
        if names.is_null() || names == self.nil { return Ok(Vec::new()); }
        (self.protect)(names);
        let result = (|| -> Result<Vec<String>, Suppression> {
            unsafe {
                if (self.altrep)(names) != 0 { return Err(Suppression::UnsafeAltRep); }
                let count = (self.xlength)(names);
                if count < 0 { return Ok(Vec::new()); }
                let mut members = Vec::new();
                for index in 0..count.min(MAX_NAMES as isize) {
                    let Some(name) = self.text((self.string_elt)(names, index)) else { continue; };
                    if !name.is_empty() && name.len() <= MAX_NAME_BYTES { members.push(name); }
                }
                Ok(members)
            }
        })();
        (self.unprotect)(1);
        result
    }

    unsafe fn names_for(&self, value: Sexp, target: Target) -> Result<Vec<String>, Suppression> {
        if value == self.nil { return Ok(Vec::new()); }
        let kind = (self.type_of)(value);
        if target == Target::Slot {
            if (self.is_s4)(value) != 0 || self.is_s7(value)? {
                return Ok(self.slot_names(value));
            }
            return Ok(Vec::new());
        }
        if kind == ENV {
            if target == Target::Dollar {
                return self.environment_names(value);
            }
            return Ok(Vec::new());
        }
        if target == Target::Dollar && !matches!(kind, VECTOR | EXPRESSION | LIST | LANGUAGE) {
            return Ok(Vec::new());
        }
        if matches!(kind, LIST | LANGUAGE | DOTS) {
            return Ok(self.pair_names(value));
        }
        if matches!(kind, VECTOR | EXPRESSION | LOGICAL | INTEGER | REAL | COMPLEX | STRING | RAW) {
            return self.vector_names(value);
        }
        Ok(Vec::new())
    }

    unsafe fn index_of(&self, value: Sexp, name: &str) -> Result<Option<usize>, Suppression> {
        let kind = (self.type_of)(value);
        if matches!(kind, LIST | LANGUAGE | DOTS) {
            let mut cursor = value;
            let mut index = 0;
            while cursor != self.nil && index < 100_000 {
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
        for index in 0..len.min(100_000) {
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
            let mut cursor = value;
            for _ in 0..index {
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
                let selected_name = self.vector_names(source)?.get(index).cloned();
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
                        if !self.slot_names(value).iter().any(|part| part == &name) {
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
                        if (self.item(value, index as usize - 1)?.is_some()) {
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

    unsafe fn inspect(&self, query: &MemberQuery) -> Result<Vec<String>, Suppression> {
        let Some(root) = self.binding(self.global, &query.root)? else { return Ok(Vec::new()); };
        (self.protect)(root);
        let mut protected = 1;
        let outcome = (|| -> Result<Vec<String>, Suppression> {
            unsafe {
                let mut current = View::Object(root);
                for step in &query.steps {
                    let Some(next) = self.step(current, step)? else { return Ok(Vec::new()); };
                    if let View::Object(value) = next {
                        if (self.type_of)(value) == PROMISE { return Err(Suppression::DeferredBinding); }
                        if value.is_null() { return Ok(Vec::new()); }
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
                        if query.target == Target::Slot { return Ok(Vec::new()); }
                        Ok(self.vector_names(source)?.get(index).cloned().into_iter().collect())
                    }
                }
            }
        })();
        (self.unprotect)(protected);
        outcome
    }
}

pub(crate) fn inspect(api: InspectorApi, query: MemberQuery) -> Inspection {
    struct Context {
        api: InspectorApi,
        query: MemberQuery,
        result: Option<Result<Vec<String>, Suppression>>,
    }
    unsafe extern "C" fn invoke(data: *mut c_void) {
        let context = &mut *(data as *mut Context);
        context.result = Native::new(context.api).map(|native| native.inspect(&context.query));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn name(s: &str, out: &mut Vec<u8>) {
        out.extend_from_slice(&(s.len() as u32).to_le_bytes());
        out.extend_from_slice(s.as_bytes());
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
