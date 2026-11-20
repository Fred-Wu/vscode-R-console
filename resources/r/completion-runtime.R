# Workspace signatures are source for languageserver, never evaluated in either R session.
console_parse_signature <- function(signature) {
    if (!is.character(signature) || length(signature) != 1L) return(NULL)
    parsed <- tryCatch(parse(text = paste0(signature, "\nNULL"), keep.source = FALSE),
        error = function(e) NULL)
    if (length(parsed) != 1L || !is.call(parsed[[1L]]) ||
        !identical(parsed[[1L]][[1L]], quote(`function`)) || !is.null(parsed[[1L]][[3L]])) return(NULL)
    parsed[[1L]]
}

console_workspace_functions <- character()
console_workspace_signatures <- NULL
console_sync_workspace_functions <- function(workspace, functions) {
    if (identical(functions, console_workspace_signatures)) return(invisible(NULL))
    uri <- "r-console://session/workspace.R"
    known <- character()
    definitions <- lapply(names(functions), function(name) {
        parsed <- console_parse_signature(functions[[name]])
        if (is.null(parsed)) return(NULL)
        known <<- c(known, name)
        paste(deparse(call("<-", as.name(name), parsed), backtick = TRUE), collapse = "\n")
    })
    console_workspace_functions <<- known
    content <- strsplit(paste(unlist(definitions, use.names = FALSE), collapse = "\n"), "\n", fixed = TRUE)[[1L]]
    document <- workspace$documents$get(uri, NULL)
    if (is.null(document) || !identical(document$content, content)) {
        document <- languageserver:::Document$new(uri, language = "r", version = 1L, content = content)
        document$did_open()
        workspace$documents$set(uri, document)
        workspace$update_parse_data(uri, languageserver:::parse_document(uri, content))
    }
    console_workspace_signatures <<- functions
    invisible(NULL)
}


# Actual function signatures come exclusively from synchronized sess workspace
# data. Unsubmitted source in the editable console is never inspected here.
console_runtime_function <- function(name) {
    if (!name %in% console_workspace_functions) return(NULL)
    parsed <- console_parse_signature(console_workspace_signatures[[name]])
    if (is.null(parsed)) return(NULL)
    list(formals = parsed[[2L]])
}
