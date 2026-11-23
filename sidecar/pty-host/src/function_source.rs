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
        self.push_char(quote)?;
        for ch in text.chars() {
            match ch {
                '\\' => self.push("\\\\")?,
                '\n' => self.push("\\n")?,
                '\r' => self.push("\\r")?,
                '\t' => self.push("\\t")?,
                ch if ch == quote => { self.push("\\")?; self.push_char(ch)?; }
                ch if ch < ' ' || ch == '\u{7f}' => self.push(&format!("\\{:03o}", ch as u32))?,
                ch => self.push_char(ch)?,
            }
        }
        self.push_char(quote)
    }

    fn push_char(&mut self, ch: char) -> Result<(), Suppression> {
        if self.text.len() + ch.len_utf8() > SOURCE_BYTES { return Err(Suppression::InspectionLimit); }
        self.text.push(ch);
        Ok(())
    }
}

impl Native {
    pub(super) unsafe fn inspect_function_source(&self, query: &MemberQuery) -> Result<Inspection, Suppression> {
        self.check_deadline()?;
        if !query.steps.is_empty() { return Err(Suppression::InspectionLimit); }
        let root = match self.root_binding(query)? {
            RootBinding::Missing => return Ok(Inspection::Available(Members::missing())),
            RootBinding::NotCallable => return Ok(Inspection::NotCallable),
            RootBinding::Package(_) => return Ok(Inspection::PackageBinding),
            RootBinding::Stored(value) => value,
        };
        let kind = (self.type_of)(root);
        // R's function lookup skips ordinary non-callable bindings. Callable
        // aliases and uninspectable values still require an opaque binding.
        if !matches!(kind, CLOSURE | SPECIAL | BUILTIN) { return Ok(Inspection::NotCallable); }
        if kind != CLOSURE { return Err(Suppression::InspectionLimit); }
        // Projection defines the closure in global scope. Only closures whose
        // enclosing environment is that same scope can retain their bindings.
        // Read the environment pointer through the C guard without traversing it.
        if self.closure_env.ok_or(Suppression::InspectionLimit)?(root) != self.global {
            return Err(Suppression::InspectionLimit);
        }
        let formals = self.formals.ok_or(Suppression::InspectionLimit)?;
        let body = self.body.ok_or(Suppression::InspectionLimit)?;
        (self.protect)(root);
        let mut source = Source { text: String::new(), remaining: MAX_SCANNED_ENTRIES };
        self.source_function(formals(root), body(root), 0, &mut source)?;
        (self.unprotect)(1);
        Ok(Inspection::FunctionSource(source.text))
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
            if args.is_null() { return Err(Suppression::InspectionLimit); }
            // R's parser can use language cons cells in call argument spines
            // (notably after native-pipe rewriting). They have the same stored
            // CAR/CDR/TAG representation. Formal lists still require LISTSXP.
            let kind = (self.type_of)(args);
            if kind != LIST && (formals || kind != LANGUAGE) { return Err(Suppression::InspectionLimit); }
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
            let head_name = if (self.type_of)(head) == SYMBOL { Some(self.source_symbol(head)?) } else { None };
            if head_name.as_deref() == Some("function") {
                if (self.type_of)(args) != LIST { return Err(Suppression::InspectionLimit); }
                let tail = (self.cdr)(args);
                if (self.type_of)(tail) != LIST { return Err(Suppression::InspectionLimit); }
                return self.source_function(car(args), car(tail), depth + 1, source);
            }
            // Prefix-call syntax preserves the AST of operators and control
            // structures as well as ordinary functions, including missing args.
            if let Some(name) = head_name {
                // Reuse the decoded head while retaining its node/depth budget.
                self.source_step(depth + 1, source)?;
                source.quote(&name, '`')?;
                source.push("(")?;
            } else {
                source.push("(")?;
                self.source_node(head, depth + 1, source)?;
                source.push(")(")?;
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_quotes_escape_names_and_enforce_utf8_byte_budget() {
        let mut source = Source { text: String::new(), remaining: 1 };
        source.quote("é`\\\n\u{7f}", '`').unwrap();
        assert_eq!(source.text, "`é\\`\\\\\\n\\177`");

        // The closing delimiter and every UTF-8 byte count toward the limit.
        source.text = "x".repeat(SOURCE_BYTES - 4);
        source.quote("é", '`').unwrap();
        assert_eq!(source.text.len(), SOURCE_BYTES);
        assert_eq!(source.push_char('x'), Err(Suppression::InspectionLimit));
        source.text.truncate(SOURCE_BYTES - 1);
        assert_eq!(source.push_char('é'), Err(Suppression::InspectionLimit));
        assert_eq!(source.text.len(), SOURCE_BYTES - 1);
    }
}
