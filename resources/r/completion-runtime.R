# Parse printed function signatures returned by sess hover; never evaluate source.
console_parse_signature <- function(signature) {
    if (!is.character(signature) || length(signature) != 1L) return(NULL)
    parsed <- tryCatch(parse(text = paste0(signature, "\nNULL"), keep.source = FALSE),
        error = function(e) NULL)
    if (length(parsed) != 1L || !is.call(parsed[[1L]]) ||
        !identical(parsed[[1L]][[1L]], quote(`function`)) || !is.null(parsed[[1L]][[3L]])) return(NULL)
    parsed[[1L]]
}
