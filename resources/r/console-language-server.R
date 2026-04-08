.paths <- .libPaths()

add_lib_paths <- Sys.getenv("VSCR_LIB_PATHS")
if (nzchar(add_lib_paths)) {
    add_lib_paths <- strsplit(add_lib_paths, "\n", fixed = TRUE)[[1L]]
    .paths <- c(.paths, add_lib_paths)
}

use_renv_lib_path <- Sys.getenv("VSCR_USE_RENV_LIB_PATH")
use_renv_lib_path <- if (nzchar(use_renv_lib_path)) as.logical(use_renv_lib_path) else FALSE
if (use_renv_lib_path) {
    if (requireNamespace("renv", quietly = TRUE)) {
        .paths <- c(.paths, renv::paths$cache())
    } else {
        warning("renv package is not installed. Please install renv to use renv library path.")
    }
}

.libPaths(.paths)
message("R library paths: ", paste(.libPaths(), collapse = "\n"))

if (!requireNamespace("languageserver", quietly = TRUE)) {
    q(save = "no", status = 10)
}

debug <- Sys.getenv("VSCR_LSP_DEBUG")
port <- Sys.getenv("VSCR_LSP_PORT")

debug <- if (nzchar(debug)) as.logical(debug) else FALSE
port <- if (nzchar(port)) as.integer(port) else NULL

tools::Rd2txt_options(underline_titles = FALSE)
tools::Rd2txt_options(itemBullet = "* ")
languageserver:::lsp_settings$update_from_options()
if (isTRUE(debug)) {
    languageserver:::lsp_settings$set("debug", TRUE)
    languageserver:::lsp_settings$set("log_file", NULL)
}

normalize_character <- function(value) {
    if (is.list(value)) {
        value <- unlist(value, use.names = FALSE)
    }
    if (!is.character(value)) {
        return(character())
    }
    value <- value[nzchar(value)]
    unique(value)
}

semantic_tokens_full_sync <- function(self, id, params) {
    textDocument <- params$textDocument
    uri <- languageserver:::uri_escape_unicode(textDocument$uri)
    if (!self$workspace$documents$has(uri)) {
        self$deliver(languageserver:::Response$new(
            id,
            result = languageserver:::encode_semantic_tokens(list())
        ))
        return(invisible(NULL))
    }

    document <- self$workspace$documents$get(uri)
    parse_data <- tryCatch(
        languageserver:::parse_document(
            uri,
            languageserver:::normalize_parse_content(document$content, document$is_rmarkdown)
        ),
        error = function(e) NULL
    )
    if (!is.null(parse_data)) {
        languageserver:::parse_callback(self, uri, document$version, parse_data)
    }

    reply <- languageserver:::semantic_tokens_full_reply(id, uri, self$workspace, document)
    if (is.null(reply)) {
        reply <- languageserver:::Response$new(
            id,
            result = languageserver:::encode_semantic_tokens(list())
        )
    }
    self$deliver(reply)
}

server <- languageserver:::LanguageServer$new("localhost", port)
server$request_handlers[["rConsole/syncSessionState"]] <- function(self, id, params) {
    attached_packages <- normalize_character(params$attachedPackages)
    loaded_namespaces <- normalize_character(params$loadedNamespaces)

    self$workspace$startup_packages <- attached_packages
    self$workspace$update_loaded_packages()

    namespaces_to_load <- unique(c(attached_packages, loaded_namespaces))
    for (pkg in namespaces_to_load) {
        try(self$workspace$get_namespace(pkg), silent = TRUE)
    }

    self$deliver(languageserver:::Response$new(id, result = TRUE))
}
server$request_handlers[["textDocument/semanticTokens/full"]] <- semantic_tokens_full_sync

server$run()
