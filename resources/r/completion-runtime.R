# Parse cached workspace function signatures; never evaluate source.
console_parse_signature <- function(signature) {
    if (!is.character(signature) || length(signature) != 1L) return(NULL)
    parsed <- tryCatch(parse(text = paste0(signature, "\nNULL"), keep.source = FALSE),
        error = function(e) NULL)
    if (length(parsed) != 1L || !is.call(parsed[[1L]]) ||
        !identical(parsed[[1L]][[1L]], quote(`function`)) || !is.null(parsed[[1L]][[3L]])) return(NULL)
    parsed[[1L]]
}

# Only a guarded native argument-name snapshot may describe a stored method.
# Reconstruct inert formals for matching; never copy or evaluate defaults/body.
console_method_root <- function(source) {
    if (!is.character(source) || length(source) != 1L || is.na(source) ||
        nchar(source, type = "bytes") > 4096L) return(NULL)
    root <- tryCatch(str2lang(source), error = function(e) NULL)
    for (i in seq_len(13L)) {
        if (is.symbol(root)) return(as.character(root))
        if (!is.call(root) || !is.symbol(root[[1L]]) || length(root) < 2L ||
            !as.character(root[[1L]]) %in% c("$", "@", "[[", "[")) return(NULL)
        root <- root[[2L]]
    }
    NULL
}

console_runtime_method_arguments <- function(params) {
    argument_names <- params$rConsoleRuntimeArgumentNames
    if (!is.list(argument_names) || length(argument_names) > 128L ||
        !all(vapply(argument_names, function(name) is.character(name) &&
            length(name) == 1L && !is.na(name) && nzchar(name) &&
            nchar(name, type = "bytes") <= 4096L, logical(1)))) return(NULL)
    root <- console_method_root(params$rConsoleCall)
    if (is.null(root) || !identical(root, params$rConsoleRuntimeArgumentRoot)) return(NULL)
    argument_names <- vapply(argument_names, identity, character(1))
    if (anyDuplicated(argument_names)) return(NULL)
    list(formals = as.pairlist(setNames(rep(list(NULL), length(argument_names)), argument_names)))
}
