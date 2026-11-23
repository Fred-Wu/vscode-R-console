// Serialize stored syntax directly. R's general deparser may inspect embedded
// ALTREP values, promises and global print options. Never hand it user objects.
// All R reads below use the existing C error boundary; no evaluator is called.
use super::*;

const SYMBOL: c_int = 1;
const SOURCE_BYTES: usize = 64 * 1024;

struct Source {
    text: String,
    remaining: usize,
}

impl Source {
    fn push(&mut self, text: &str) -> Result<(), Suppression> {
        if self.text.len() + text.len() > SOURCE_BYTES { return Err(Suppression::InspectionLimit); }
        self.text.push_str(text);
        Ok(())
    }

    fn quote(&mut self, text: &str, quote: char) -> Result<(), Suppression> {
        self.push(&quote.to_string())?;
        for ch in text.chars() {
            match ch {
                '\\' => self.push("\\\\")?,
                '\n' => self.push("\\n")?,
                '\r' => self.push("\\r")?,
                '\t' => self.push("\\t")?,
                ch if ch == quote => self.push(&format!("\\{ch}"))?,
                ch if ch < ' ' || ch == '\u{7f}' => self.push(&format!("\\{:03o}", ch as u32))?,
                ch => self.push(&ch.to_string())?,
            }
        }
        self.push(&quote.to_string())
    }
}

impl Native {
    pub(super) unsafe fn inspect_function_source(&self, query: &MemberQuery) -> Result<String, Suppression> {
        self.check_deadline()?;
        if !query.steps.is_empty() { return Err(Suppression::InspectionLimit); }
        let Some(root) = self.binding(self.global, &query.root)? else { return Err(Suppression::InspectionLimit); };
        if (self.type_of)(root) != CLOSURE { return Err(Suppression::InspectionLimit); }
        let formals = self.formals.ok_or(Suppression::InspectionLimit)?;
        let body = self.body.ok_or(Suppression::InspectionLimit)?;
        (self.protect)(root);
        let mut source = Source { text: String::new(), remaining: MAX_SCANNED_ENTRIES };
        self.source_function(formals(root), body(root), 0, &mut source)?;
        (self.unprotect)(1);
        Ok(source.text)
    }

    unsafe fn source_step(&self, depth: usize, source: &mut Source) -> Result<(), Suppression> {
        self.check_deadline()?;
        if depth > 64 || source.remaining == 0 { return Err(Suppression::InspectionLimit); }
        source.remaining -= 1;
        Ok(())
    }

    unsafe fn source_symbol(&self, value: Sexp) -> Result<String, Suppression> {
        if value.is_null() || (self.type_of)(value) != SYMBOL { return Err(Suppression::InspectionLimit); }
        self.text((self.printname)(value)).ok_or(Suppression::InspectionLimit)
    }

    unsafe fn source_function(&self, formals: Sexp, body: Sexp, depth: usize, source: &mut Source)
        -> Result<(), Suppression> {
        source.push("function(")?;
        self.source_arguments(formals, true, depth + 1, source)?;
        source.push(") ")?;
        self.source_node(body, depth + 1, source)
    }

    unsafe fn source_arguments(&self, mut args: Sexp, formals: bool, depth: usize, source: &mut Source)
        -> Result<(), Suppression> {
        let car = self.car.ok_or(Suppression::InspectionLimit)?;
        let mut first = true;
        while args != self.nil {
            self.source_step(depth, source)?;
            if args.is_null() || (self.type_of)(args) != LIST { return Err(Suppression::InspectionLimit); }
            if !first { source.push(", ")?; }
            first = false;
            let tag = (self.tag)(args);
            let value = car(args);
            let missing = (self.type_of)(value) == SYMBOL && self.source_symbol(value)?.is_empty();
            if tag != self.nil {
                source.quote(&self.source_symbol(tag)?, '`')?;
                if !formals || !missing { source.push(" = ")?; }
            } else if formals { return Err(Suppression::InspectionLimit); }
            if !missing { self.source_node(value, depth + 1, source)?; }
            args = (self.cdr)(args);
        }
        Ok(())
    }

    unsafe fn source_node(&self, value: Sexp, depth: usize, source: &mut Source) -> Result<(), Suppression> {
        self.source_step(depth, source)?;
        if value.is_null() { return Err(Suppression::InspectionLimit); }
        if value == self.nil { return source.push("NULL"); }
        let kind = (self.type_of)(value);
        if kind == PROMISE { return Err(Suppression::DeferredBinding); }
        if kind == SYMBOL { return source.quote(&self.source_symbol(value)?, '`'); }
        if kind == LANGUAGE {
            let car = self.car.ok_or(Suppression::InspectionLimit)?;
            let head = car(value);
            let args = (self.cdr)(value);
            if (self.type_of)(head) == SYMBOL && self.source_symbol(head)? == "function" {
                if (self.type_of)(args) != LIST { return Err(Suppression::InspectionLimit); }
                let tail = (self.cdr)(args);
                if (self.type_of)(tail) != LIST { return Err(Suppression::InspectionLimit); }
                return self.source_function(car(args), car(tail), depth + 1, source);
            }
            // Prefix-call syntax preserves the AST of operators and control
            // structures as well as ordinary functions, including missing args.
            let named_head = (self.type_of)(head) == SYMBOL;
            if !named_head { source.push("(")?; }
            self.source_node(head, depth + 1, source)?;
            source.push(if named_head { "(" } else { ")(" })?;
            self.source_arguments(args, false, depth + 1, source)?;
            return source.push(")");
        }
        // Embedded constants can be constructed by body<-/substitute/C code.
        // Reject callback-bearing and attributed data before length/element
        // reads. Do not reinterpret environments, closures or vector constants
        // as calls whose meaning might differ from the original stored value.
        if !matches!(kind, LOGICAL | INTEGER | REAL | STRING) { return Err(Suppression::InspectionLimit); }
        if (self.altrep)(value) != 0 { return Err(Suppression::UnsafeAltRep); }
        if (self.attrib)(value) != self.nil { return Err(Suppression::UnsafeDispatch); }
        if (self.xlength)(value) != 1 { return Err(Suppression::InspectionLimit); }
        match kind {
            LOGICAL => source.push(match self.logical_elt.ok_or(Suppression::InspectionLimit)?(value, 0) {
                0 => "FALSE", 1 => "TRUE", _ => "NA",
            }),
            INTEGER => {
                let value = self.integer_elt.ok_or(Suppression::InspectionLimit)?(value, 0);
                source.push(&if value == c_int::MIN { "NA_integer_".into() } else { format!("{value}L") })
            }
            REAL => {
                let value = self.real_elt.ok_or(Suppression::InspectionLimit)?(value, 0);
                let literal = if self.is_na.ok_or(Suppression::InspectionLimit)?(value) { "NA_real_".into() }
                    else if value.is_nan() { "NaN".into() }
                    else if value == f64::INFINITY { "Inf".into() }
                    else if value == f64::NEG_INFINITY { "-Inf".into() }
                    else { format!("{value:?}") };
                source.push(&literal)
            }
            STRING => {
                let value = (self.string_elt)(value, 0);
                if value == self.na_string { source.push("NA_character_") }
                else { source.quote(&self.text(value).ok_or(Suppression::InspectionLimit)?, '"') }
            }
            _ => Err(Suppression::InspectionLimit),
        }
    }
}
