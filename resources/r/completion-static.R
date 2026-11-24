# Static semantics belong to languageserver. This adapter reads its recovered
# scope and inferred values; it never walks assignment syntax or evaluates code.
# Unknown source bindings remain opaque, including when native analysis is absent.
console_native_formals <- function(symbol, index) {
    if ("formals" %in% names(symbol))
        return(list(formals = symbol$formals, unknown = is.null(symbol$signature)))
    # Released providers expose the same inert definition through their index
    # instead of a formals field. Reuse native metadata helpers, not source or
    # display-signature parsing. This is an API adapter, not syntax inference.
    value <- symbol$value
    if (!is.null(value$metadata)) {
        metadata <- languageserver:::member_namespace_index(index, value$metadata)
        if (!is.null(metadata)) index <- metadata
    }
    definition <- value$function_expr
    if (is.null(definition)) definition <- languageserver:::member_definition(index$definitions, value$function_key)
    if (isTRUE(value$function_key %in% index$native_factories))
        definition <- languageserver:::member_returned_function(definition)$fn
    known <- languageserver:::member_head(definition, "function")
    list(formals = if (known) definition[[2L]], unknown = !known)
}

# Navigation describes declarations throughout the document. Its function
# ranges provide an additional identity check while editing a definition;
# declarations elsewhere do not describe the binding visible at this cursor.
console_enclosing_source_function <- function(document, point, name) {
    declarations <- languageserver:::navigation_definitions(document$parse_data,
        point$row + 1L, point$col + 1L, name, "signature")
    enclosing <- Filter(function(row) languageserver:::position_is_in_lsp_range(
        document, point$row, point$col, languageserver:::navigation_range(
            document, document$parse_data$syntax_data, row)), declarations)
    tail(enclosing, 1L)
}

console_source_binding <- function(name, uri, workspace, document, point, location = NULL) {
    if (!is.character(name) || length(name) != 1L || is.na(name) || !nzchar(name) ||
        !exists("member_resolve_cursor", asNamespace("languageserver"), inherits = FALSE) ||
        !exists("member_infer", asNamespace("languageserver"), inherits = FALSE))
        return(list(unknown = TRUE))
    # A symbol cursor asks the native recovery engine for the lexical scope at
    # this position. The same engine owns unfinished syntax, shadowing and budgets.
    if (!is.null(location)) {
        point <- location$point
        cursor <- location$cursor
        cursor$accessor <- NULL
    } else {
        # Use the native token range so a partial name is replaced as a token,
        # rather than concatenating a scope sentinel onto its spelling.
        token <- document$detect_token(point)
        start <- token$range$start$col
        end <- token$range$end$col
        cursor <- list(operator = start + 1L, operator_row = point$row,
            start = start, end = end, accessor = NULL,
            before = substr(document$line0(point$row), 1L, start))
    }
    resolved <- languageserver:::member_resolve_cursor(uri, workspace, document, point, cursor)
    if (is.null(resolved)) {
        # Recovery can decline a literal cursor even though native navigation
        # still knows the receiver's declaration. Only trust a current outline.
        current <- identical(document$version, document$parse_data$version)
        declaration <- if (current) languageserver:::navigation_definitions(document$parse_data,
            point$row + 1L, point$col + 1L, name, last = TRUE)
        return(list(unknown = TRUE, source_binding = length(declaration) > 0L))
    }
    fields <- resolved$value$fields
    history <- resolved$index$document_bindings[[name]]
    at <- resolved$bindings$.__member_position__
    has_binding <- name %in% names(fields) || name %in% names(resolved$bindings) ||
        (length(history) && (is.null(at) || languageserver:::member_history_position(history, at) > 0L))
    declaration <- console_enclosing_source_function(document, point, name)
    # A declaration currently being edited can be indexed before its binding
    # takes effect. Preserve that uncertainty using the provider's ranges.
    # Entries wholly after the cursor cannot establish a current source binding.
    editing_binding <- any(vapply(history, function(entry)
        languageserver:::member_before(entry$start, c(point$row, point$col)) &&
        languageserver:::member_before(c(point$row, point$col), entry$end), logical(1)))
    # Pending inference does not erase source identity already in the index.
    # Keep blocking a stale live namesake while native metadata is loading.
    if (isTRUE(resolved$budget$exhausted) || isTRUE(resolved$budget$transient))
        return(list(unknown = TRUE,
            source_binding = isTRUE(has_binding) || editing_binding || length(declaration) > 0L))
    if (!has_binding) {
        # Native navigation can know a source declaration that inference has
        # not resolved yet (for example while editing its body). Preserve that
        # identity without substituting an older runtime/package signature.
        return(if (length(declaration) || editing_binding)
            list(unknown = TRUE, source_binding = TRUE) else NULL)
    }
    bindings <- resolved$bindings
    bindings[names(fields)] <- fields
    value <- languageserver:::member_infer(as.name(name), resolved$index,
        bindings, budget = resolved$budget)
    # Native navigation and inference must agree before we use a callable.
    # A conflict is opaque; resolving it belongs upstream, not in a second
    # console scope walker (notably while editing a recursive redefinition).
    # A partial navigation outline omits unfinished scopes; only compare a
    # complete parse with the recovered inference context.
    if (length(declaration) && !isTRUE(document$parse_data$parse_error)) {
        symbol <- languageserver:::member_symbol_info(name, value, value$function_key, resolved$index)
        signature <- languageserver:::navigation_signature(document, document$parse_data, declaration, name)
        if (!is.null(symbol$signature) && !identical(symbol$signature, signature))
            return(list(unknown = TRUE, source_binding = TRUE))
    }
    list(value = value, index = resolved$index, source_binding = TRUE,
        unknown = isTRUE(resolved$budget$exhausted) || isTRUE(resolved$budget$transient) ||
            (!length(value$type) && is.null(value$function_expr) && is.null(value$function_key)))
}

console_source_function <- function(document, point, name, uri, workspace) {
    # Look up the callable in its own scope, including while editing a quoted
    # argument. Native call detection owns the position and token boundaries.
    location <- if (exists("member_call_location", asNamespace("languageserver"), inherits = FALSE))
        languageserver:::member_call_location(document, point, symbols = TRUE)
    binding <- console_source_binding(name, uri, workspace, document, point, location)
    if (is.null(binding) || isTRUE(binding$unknown)) return(binding)
    # The provider owns aliases, closures, return shapes and catalog signatures.
    # A non-callable draft binding still shadows an older live/package function.
    symbol <- languageserver:::member_symbol_info(name, binding$value,
        binding$value$function_key, binding$index)
    c(console_native_formals(symbol, binding$index), list(source_binding = TRUE))
}

console_source_overrides_opaque <- function(name, uri, workspace, document, position) {
    if (!is.list(position)) return(FALSE)
    binding <- console_source_binding(name, uri, workspace, document,
        document$from_lsp_position(position))
    isTRUE(binding$source_binding) && !isTRUE(binding$unknown)
}

# The native resolver already knows source-defined member functions. Reuse its
# function syntax to expose formals without evaluating the receiver or its body.
console_member_function <- function(uri, workspace, document, point, root = NULL,
    source_root = if (!is.null(root)) console_source_function(document, point, root, uri, workspace)) {
    if (identical(root, "")) return(list(unknown = TRUE))
    if (!exists("member_call_location", asNamespace("languageserver"), inherits = FALSE)) return(NULL)
    location <- languageserver:::member_call_location(document, point)
    if (is.null(location)) return(NULL)
    resolved <- languageserver:::member_resolve_cursor(uri, workspace, document,
        location$point, location$cursor, location$cursor$token)
    if (is.null(resolved) || isTRUE(resolved$budget$exhausted) || isTRUE(resolved$budget$transient))
        return(list(unknown = TRUE))
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
    history <- if (!is.null(root)) resolved$index$document_bindings[[root]] else NULL
    at <- resolved$bindings$.__member_position__
    source_binding <- !is.null(source_root) || (!is.null(root) &&
        (root %in% names(resolved$bindings) || (length(history) &&
            (is.null(at) || languageserver:::member_history_position(history, at) > 0L))))
    # Reuse native callable metadata directly. Do not deparse/reparse a
    # display signature or maintain a separate method/constructor resolver.
    symbol <- languageserver:::member_symbol_info(".r_console_callable", resolved$value,
        resolved$value$function_key, resolved$index)
    signature <- symbol$signature
    if (!is.character(signature) || length(signature) != 1L || is.na(signature) ||
        nchar(signature, type = "bytes") > 65536L) {
        # A source-defined factory can have an unknown result while still
        # shadowing a live object. Reuse native binding history even when the
        # recovered syntax contains only the unfinished call at the cursor.
        if (source_binding) return(list(unknown = TRUE, source_binding = TRUE))
        return(NULL)
    }
    c(console_native_formals(symbol, resolved$index), list(source_binding = source_binding))
}
