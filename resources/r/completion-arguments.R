# Console argument matching and literal-value fallbacks. Never evaluate user source.
console_call_identity <- function(source) {
    if (!is.character(source) || length(source) != 1L) return(NULL)
    parsed <- tryCatch(parse(text = source, keep.source = FALSE), error = function(e) NULL)
    if (length(parsed) != 1L) return(NULL)
    head <- parsed[[1L]]
    if (is.symbol(head)) return(list(token = as.character(head), package = NULL, accessor = ""))
    if (is.call(head) && length(head) == 3L &&
        (identical(head[[1L]], quote(`::`)) || identical(head[[1L]], quote(`:::`))) &&
        is.symbol(head[[2L]]) && is.symbol(head[[3L]])) {
        return(list(token = as.character(head[[3L]]), package = as.character(head[[2L]]),
                    accessor = as.character(head[[1L]])))
    }
    if (is.call(head) && length(head) == 3L &&
        (identical(head[[1L]], quote(`$`)) || identical(head[[1L]], quote(`@`))) && is.symbol(head[[3L]])) {
        return(list(token = as.character(head[[3L]]), package = NULL, accessor = as.character(head[[1L]])))
    }
    NULL
}

console_is_argument_item <- function(item) {
    !is.null(item$data$parameter) ||
        isTRUE(grepl("(parameter|argument_value)$", item$data$type)) ||
        identical(item$detail, "parameter") ||
        (is.character(item$detail) && startsWith(item$detail, "value for "))
}

console_argument_name <- function(item) {
    if (!is.null(item$data$uri)) {
        parsed <- tryCatch(parse(text = item$label)[[1L]], error = function(e) NULL)
        if (is.symbol(parsed)) return(as.character(parsed))
    }
    item$label
}

console_source_signature <- function(source, uri) {
    # A lexical binding can shadow a package function without revealing its
    # signature. NULL means unknown; list() means a known zero-argument function.
    if (isTRUE(source$unknown)) return(NULL)
    lapply(names(source$formals), function(name) {
        spelling <- paste(deparse(as.name(name), backtick = TRUE), collapse = "")
        list(label = spelling, kind = languageserver:::CompletionItemKind$Variable,
            detail = "parameter", insertText = if (name == "...") "..." else paste0(spelling, " = "),
            data = list(type = "parameter", uri = uri))
    })
}

# Read literal choices without inspecting a computed call head as a scalar
# name. Defaults such as c(pkg::fun()) and c((function() ...)()) are valid R
# syntax, but cannot supply known values and must never be evaluated.
console_default_values <- function(expression) {
    if (missing(expression)) return(NULL)
    if (is.character(expression)) return(expression)
    if (!is.call(expression) || !identical(expression[[1L]], quote(c))) return(NULL)
    unlist(lapply(as.list(expression)[-1L], function(value) {
        if (is.character(value)) return(value)
        if (is.call(value) && identical(value[[1L]], quote(I)) && length(value) > 1L &&
            is.character(value[[2L]])) return(value[[2L]])
        NULL
    }), use.names = FALSE)
}

# Use the whole call's tags so exact matches can disambiguate a partial tag.
# TRUE marks the cursor's argument; all other values are inert NULL syntax.
console_value_argument <- function(formal_names, tag, tags) {
    parsed <- tryCatch(parse(text = tag)[[1L]], error = function(e) NULL)
    name <- if (is.symbol(parsed) || is.character(parsed)) as.character(parsed) else ""
    if (is.null(tags)) return(if (name %in% formal_names) name else "")
    supplied <- vapply(tags, function(value) {
        if (is.null(value)) paste0(tag, " = TRUE") else if (nzchar(value)) paste0(value, " = NULL") else "NULL"
    }, character(1))
    definition <- function() NULL
    formals(definition) <- as.pairlist(setNames(rep(list(NULL), length(formal_names)), formal_names))
    matched <- tryCatch(suppressWarnings(match.call(definition,
        parse(text = paste0(".fn(", paste(supplied, collapse = ", "), ")"))[[1L]], expand.dots = FALSE)),
        error = function(e) NULL)
    args <- as.list(matched)[-1L]
    matched_name <- names(args)[vapply(args, identical, logical(1), TRUE)]
    if (length(matched_name) == 1L && matched_name %in% formal_names) matched_name else ""
}

console_valid_argument_items <- function(items, tags, call, uri, workspace, point, signature = NULL) {
    is_value <- function(item) is.character(item$detail) && startsWith(item$detail, "value for ")
    is_parameter <- function(item) identical(item$detail, "parameter") ||
        (!is.null(item$data$parameter) && identical(item$kind, languageserver:::CompletionItemKind$Variable))
    if (is.null(call) || is.null(tags)) return(items)
    # Ask the same provider for the complete signature, including local source
    # definitions and dots. Defaults and function bodies are never evaluated.
    forwarded_dots <- "..." %in% unlist(tags, use.names = FALSE)
    known_signature <- !is.null(signature)
    if (is.null(signature)) signature <- languageserver:::arg_completion(uri, workspace, point, "", call$token,
        call$package, exported_only = call$accessor != ":::")
    formal_names <- unique(vapply(signature, console_argument_name, character(1)))
    if (!known_signature && !length(formal_names) && !call$accessor %in% c("$", "@")) {
        # No parameter items can mean either an unknown callable or a known
        # zero-argument package function. Consult cached signature metadata.
        declaration <- languageserver:::call_with_optional_uri(workspace$get_signature,
            call$token, call$package, exported_only = call$accessor != ":::", uri = uri)
        known_signature <- is.character(declaration) && length(declaration) == 1L &&
            grepl("\\(\\s*\\)$", trimws(declaration))
    }
    # An empty filtered parameter list is not evidence of exhaustion. Use the
    # full signature and count supplied slots (including implicit pipe input).
    # Unknown signatures and dots must retain ordinary expression completion.
    supplied_count <- sum(vapply(tags, function(tag) !is.null(tag) && !identical(tag, "..."), logical(1)))
    if ((known_signature || length(formal_names) > 0L) && !"..." %in% formal_names &&
        sum(vapply(tags, is.null, logical(1))) == 1L && supplied_count >= length(formal_names)) {
        return(structure(list(), arguments_exhausted = TRUE))
    }
    if (!length(formal_names)) return(items)
    definition <- function() NULL
    formals(definition) <- as.pairlist(setNames(rep(list(NULL), length(formal_names)), formal_names))
    cursor_slot <- which(vapply(tags, is.null, logical(1))) + 1L
    if (length(cursor_slot) != 1L) return(items)
    supplied <- vapply(tags, function(tag) {
        if (is.null(tag)) "TRUE" else if (nzchar(tag)) paste0(tag, " = NULL") else "NULL"
    }, character(1))
    syntax <- tryCatch(as.list(parse(text = paste0(".fn(", paste(supplied, collapse = ", "), ")"))[[1L]]),
        error = function(e) NULL)
    if (is.null(syntax)) return(items)
    if (is.null(names(syntax))) names(syntax) <- rep("", length(syntax))
    # Values insert an unnamed argument. Match its actual destination once,
    # rather than offering defaults from already-bound or later parameters.
    positional <- tryCatch(suppressWarnings(match.call(definition = definition,
        call = as.call(syntax), expand.dots = FALSE)), error = function(e) NULL)
    positional <- as.list(positional)[-1L]
    value_name <- names(positional)[vapply(positional, identical, logical(1), TRUE)]
    # Treat supplied positional values as filled arguments for completion.
    # R permits named insertion to rematch them, but that is not a useful
    # default suggestion. Forwarded dots have unknown contents and bindings.
    supplied_names <- if (forwarded_dots) character() else
        setdiff(names(positional)[!vapply(positional, identical, logical(1), TRUE)], "...")
    Filter(function(item) {
        if (is_value(item)) return(length(value_name) == 1L &&
            identical(item$detail, paste0("value for ", value_name)))
        if (!is_parameter(item)) return(TRUE)
        name <- console_argument_name(item)
        if (name == "...") return(TRUE)
        if (name %in% c(names(syntax), supplied_names)) return(FALSE)
        if (forwarded_dots) return(TRUE)
        candidate <- syntax
        names(candidate)[cursor_slot] <- name
        tryCatch({
            suppressWarnings(match.call(definition = definition, call = as.call(candidate), expand.dots = FALSE))
            TRUE
        }, error = function(e) FALSE)
    }, items)
}

# Keep one parse of the current completion input. An unfinished enclosing block
# otherwise makes languageserver discard every local definition. Parsing a
# delimiter-completed copy does not run definitions, defaults, or user code.
console_completion_parse <- local({
    cache <- NULL
    function(uri, document, suffix, insertion = NULL) {
        content <- document$content
        if (is.list(insertion) && insertion$text %in% c("()", "identity()")) {
            at <- document$from_lsp_position(insertion$position)
            line <- content[[at$row + 1L]]
            content[[at$row + 1L]] <- paste0(substr(line, 1L, at$col), insertion$text,
                substring(line, at$col + 1L))
        }
        content <- strsplit(paste0(paste(content, collapse = "\n"), suffix), "\n", fixed = TRUE)[[1L]]
        if (is.null(cache) || !identical(cache$uri, uri) || !identical(cache$content, content)) {
            parsed <- languageserver:::parse_document(uri, content)
            parsed$xml_doc <- tryCatch(xml2::read_xml(parsed$xml_data), error = function(e) NULL)
            cache <<- list(uri = uri, content = content, parsed = parsed)
        }
        cache$parsed$version <- document$version
        cache$parsed
    }
})

