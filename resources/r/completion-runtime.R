# Parse cached workspace function signatures; never evaluate source.
console_parse_signature <- function(signature) {
    if (!is.character(signature) || length(signature) != 1L) return(NULL)
    parsed <- tryCatch(parse(text = paste0(signature, "\nNULL"), keep.source = FALSE),
        error = function(e) NULL)
    if (length(parsed) != 1L || !is.call(parsed[[1L]]) ||
        !identical(parsed[[1L]][[1L]], quote(`function`)) || !is.null(parsed[[1L]][[3L]])) return(NULL)
    parsed[[1L]]
}

# A guarded native argument-name snapshot describes any stored closure.
# Reconstruct inert formals for matching; never copy or evaluate defaults/body.
console_call_root <- function(source, include_calls = FALSE) {
    # NULL denotes a namespace-qualified root; an empty static root means
    # analysis could not verify its scope and must not borrow package metadata.
    unknown <- if (include_calls) "" else NULL
    max_bytes <- if (include_calls) 65536L else 4096L
    if (!is.character(source) || length(source) != 1L || is.na(source) ||
        nchar(source, type = "bytes") > max_bytes) return(unknown)
    root <- tryCatch(str2lang(source), error = function(e) NULL)
    for (i in seq_len(if (include_calls) 64L else 13L)) {
        if (is.symbol(root)) return(as.character(root))
        if (!is.call(root)) return(unknown)
        head <- root[[1L]]
        if (is.symbol(head) && as.character(head) %in% c("$", "@", "[[", "[", "(")) {
            if (length(root) < 2L) return(unknown)
            root <- root[[2L]]
        } else if (is.symbol(head) && as.character(head) %in% c("::", ":::")) return(NULL)
        else if (include_calls) {
            root <- head
        } else return(unknown)
    }
    unknown
}

console_runtime_arguments <- function(params) {
    argument_names <- params$rConsoleRuntimeArgumentNames
    if (!is.list(argument_names) || length(argument_names) > 128L ||
        !all(vapply(argument_names, function(name) is.character(name) &&
            length(name) == 1L && !is.na(name) && nzchar(name) &&
            nchar(name, type = "bytes") <= 4096L, logical(1)))) return(NULL)
    root <- console_call_root(params$rConsoleCall)
    if (is.null(root) || !identical(root, params$rConsoleRuntimeArgumentRoot)) return(NULL)
    argument_names <- vapply(argument_names, identity, character(1))
    if (anyDuplicated(argument_names)) return(NULL)
    list(formals = as.pairlist(setNames(rep(list(NULL), length(argument_names)), argument_names)))
}
