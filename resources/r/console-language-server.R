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
host <- Sys.getenv("VSCR_LSP_HOST")
port <- Sys.getenv("VSCR_LSP_PORT")

debug <- if (nzchar(debug)) as.logical(debug) else FALSE
host <- if (nzchar(host)) host else "127.0.0.1"
port <- if (nzchar(port)) as.integer(port) else NULL

tools::Rd2txt_options(underline_titles = FALSE)
tools::Rd2txt_options(itemBullet = "* ")
languageserver:::lsp_settings$update_from_options()
languageserver:::lsp_settings$set("diagnostics", FALSE)
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

console_text_document_did_close <- function(self, params) {
    textDocument <- params$textDocument
    uri <- languageserver:::uri_escape_unicode(textDocument$uri)
    path <- languageserver:::path_from_uri(uri)

    if (length(path) == 0 || !nzchar(path)) {
        workspace <- self$get_workspace(uri)
        if (workspace$documents$has(uri)) {
            doc <- workspace$documents$get(uri)
            doc$did_close()
            workspace$documents$remove(uri)
            workspace$update_loaded_packages()
        }
        self$pending_replies$remove(uri)
        return(invisible(NULL))
    }

    languageserver:::text_document_did_close(self, params)
}

server <- languageserver:::LanguageServer$new(host, port)
server$request_handlers[["rConsole/syncSessionState"]] <- function(self, id, params) {
    attached_packages <- normalize_character(params$attachedPackages)
    loaded_namespaces <- normalize_character(params$loadedNamespaces)
    workspace <- self$get_workspace(self$rootUri)

    workspace$startup_packages <- attached_packages
    workspace$update_loaded_packages()

    namespaces_to_load <- unique(c(attached_packages, loaded_namespaces))
    for (pkg in namespaces_to_load) {
        try(workspace$get_namespace(pkg), silent = TRUE)
    }

    self$deliver(languageserver:::Response$new(id, result = TRUE))
}
server$notification_handlers[["textDocument/didClose"]] <- console_text_document_did_close

server$run()
