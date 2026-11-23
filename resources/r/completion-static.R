# Optional static analysis of unsubmitted console source. This file is only consulted when enabled.
# Syntax-only fallback for lexical bindings in unfinished console input.
console_source_expression <- function(node) {
    leaves <- xml2::xml_find_all(node, ".//*[not(*) and not(self::COMMENT)]")
    lines <- as.integer(xml2::xml_attr(leaves, "line1"))
    ends <- as.integer(xml2::xml_attr(leaves, "line2"))
    separators <- c("", ifelse(lines[-1L] > head(ends, -1L), "\n", " "))
    tryCatch(parse(text = paste0(separators, xml2::xml_text(leaves), collapse = ""))[[1L]],
        error = function(e) NULL)
}

console_source_definition <- function(expression) {
    if (missing(expression)) return(NULL)
    # R normalizes rightward assignments and lambdas in the parsed AST.
    while (is.call(expression) && is.symbol(expression[[1L]]) &&
        as.character(expression[[1L]]) %in% c("(", "<-", "<<-", "=")) {
        expression <- expression[[if (identical(expression[[1L]], quote(`(`))) 2L else 3L]]
    }
    if (is.call(expression) && identical(expression[[1L]], quote(`function`))) expression else NULL
}

console_source_name <- function(node) {
    spelling <- xml2::xml_text(node)
    symbol <- if (startsWith(spelling, "`")) tryCatch(parse(text = spelling)[[1L]], error = function(e) NULL) else as.name(spelling)
    if (is.symbol(symbol)) as.character(symbol) else NULL
}

# Inspect bindings in the cursor's lexical scope. Parse syntax only: neither
# defaults nor function bodies are evaluated, including wrapped/chained RHSs.
console_source_function <- function(document, point, name) {
    xdoc <- languageserver:::parse_data_xml(document$parse_data)
    if (is.null(xdoc)) return(NULL)
    row <- point$row + 1L
    col <- point$col + 1L
    before <- function(node) {
        line <- as.integer(xml2::xml_attr(node, "line1"))
        line < row || (line == row && as.integer(xml2::xml_attr(node, "col1")) <= col)
    }
    contains <- function(node) {
        line <- as.integer(xml2::xml_attr(node, "line2"))
        before(node) && (line > row || (line == row && as.integer(xml2::xml_attr(node, "col2")) >= col - 1L))
    }
    selected <- NULL
    depth <- -1L
    # A formal shadows outer bindings even when it has no known function
    # default. Assignments later in the same scope may supersede that default.
    for (scope in xml2::xml_find_all(xdoc, "//expr[FUNCTION or OP-LAMBDA]")) {
        if (!contains(scope)) next
        scope_depth <- length(xml2::xml_find_all(scope, "ancestor::expr[FUNCTION or OP-LAMBDA]")) + 1L
        if (scope_depth < depth) next
        formal <- Filter(function(node) identical(console_source_name(node), name),
            as.list(xml2::xml_find_all(scope, "SYMBOL_FORMALS")))
        if (!length(formal)) next
        # Parse only this default, not the enclosing body or other defaults.
        default <- xml2::xml_find_first(formal[[1L]],
            "following-sibling::*[1][self::EQ_FORMALS]/following-sibling::expr[1]")
        definition <- if (inherits(default, "xml_missing")) NULL else
            console_source_definition(console_source_expression(default))
        selected <- list(formals = definition[[2L]], unknown = is.null(definition))
        depth <- scope_depth
    }
    assignments <- xml2::xml_find_all(xdoc, "//*[LEFT_ASSIGN or EQ_ASSIGN or RIGHT_ASSIGN]")
    for (node in assignments) {
        rightward <- length(xml2::xml_find_all(node, "RIGHT_ASSIGN")) > 0L
        target <- xml2::xml_find_first(node, if (rightward) "expr[last()]/SYMBOL" else "expr[1]/SYMBOL")
        if (inherits(target, "xml_missing") || !before(node)) next
        if (!identical(console_source_name(target), name)) next
        scopes <- xml2::xml_find_all(node, "ancestor::expr[FUNCTION or OP-LAMBDA]")
        assignment <- xml2::xml_text(xml2::xml_find_first(node, "LEFT_ASSIGN | EQ_ASSIGN | RIGHT_ASSIGN"))
        # Superassignment skips the current frame. In particular it cannot
        # replace a same-name formal or local assignment in that frame.
        binding_depth <- max(0L, length(scopes) - as.integer(assignment %in% c("<<-", "->>")))
        if (binding_depth < depth || !all(vapply(scopes, contains, logical(1)))) next
        # Defaults and call arguments are lazy. Do not assume an assignment
        # establishes a binding outside one: quote() never runs it, and local()
        # runs it in another frame. Within that same expression, retain normal
        # source completion without evaluating or guessing the called function.
        delayed <- xml2::xml_find_all(node, paste0(
            "ancestor-or-self::expr[preceding-sibling::*[1][self::EQ_FORMALS] or ",
            "(preceding-sibling::OP-LEFT-PAREN and parent::expr[*[1][self::expr]])]"))
        if (!all(vapply(delayed, contains, logical(1)))) next
        definition <- console_source_definition(console_source_expression(node))
        # An assignment takes effect after its RHS finishes. Inside a function
        # literal, however, defaults and the body run after the binding exists,
        # so recursive calls use the new signature (also for rightward binds).
        if (contains(node) && is.null(definition)) next
        selected <- list(formals = definition[[2L]], unknown = is.null(definition))
        depth <- binding_depth
    }
    selected
}


# The native resolver already knows source-defined member functions. Reuse its
# function syntax to expose formals without evaluating the receiver or its body.
console_member_function <- function(uri, workspace, document, point, root = NULL,
    source_root = if (!is.null(root)) console_source_function(document, point, root)) {
    if (identical(root, "")) return(list(unknown = TRUE))
    if (!exists("member_call_location", asNamespace("languageserver"), inherits = FALSE)) return(NULL)
    location <- languageserver:::member_call_location(document, point)
    if (is.null(location)) return(NULL)
    resolved <- languageserver:::member_resolve_cursor(uri, workspace, document,
        location$point, location$cursor, location$cursor$token)
    if (!is.null(source_root)) {
        # A draft assignment or formal may shadow an attached package object.
        # Verify that binding independently before following a catalog method;
        # an unresolved source root is not the same as its package namesake.
        if (!exists("member_infer", asNamespace("languageserver"), inherits = FALSE))
            return(list(unknown = TRUE))
        binding <- languageserver:::member_infer(as.name(root), resolved$index,
            resolved$bindings, budget = resolved$budget)
        if (!length(binding$type) && is.null(binding$function_expr) && is.null(binding$function_key))
            return(list(unknown = TRUE))
    }
    definition <- resolved$value$function_expr
    if (is.null(definition) && !is.null(resolved$value) &&
        exists("member_symbol_info", asNamespace("languageserver"), inherits = FALSE)) {
        # Package methods can refer to a catalog definition instead of carrying
        # inline function syntax. Reuse the receiver-specific signature that
        # supplies the member popup, including its package/alias resolution.
        # A fixed display name makes the declaration parseable as function
        # syntax; neither the receiver nor its defaults/body is evaluated.
        label <- ".r_console_callable"
        symbol <- languageserver:::member_symbol_info(label, resolved$value,
            resolved$value$function_key, resolved$index)
        signature <- symbol$signature
        if (is.character(signature) && length(signature) == 1L && !is.na(signature) &&
            nchar(signature, type = "bytes") <= 65536L && startsWith(signature, paste0(label, "("))) {
            definition <- console_parse_signature(paste0("function", substring(signature, nchar(label) + 1L)))
        }
    }
    if (is.null(definition)) {
        # A source-defined factory can have an unknown result while still
        # shadowing a live object. Reuse native binding history even when the
        # recovery XML contains only the unfinished call at the cursor.
        if (!is.null(root)) {
            history <- resolved$index$document_bindings[[root]]
            at <- resolved$bindings$.__member_position__
            if (root %in% names(resolved$bindings) || (length(history) &&
                (is.null(at) || languageserver:::member_history_position(history, at) > 0L))) {
                return(list(unknown = TRUE))
            }
        }
        return(NULL)
    }
    list(formals = definition[[2L]])
}
