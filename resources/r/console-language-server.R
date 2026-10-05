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
languageserver:::lsp_settings$set("debug", isTRUE(debug))
if (isTRUE(debug)) {
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

package_fingerprints <- new.env(parent = emptyenv())

package_fingerprint <- function(pkgname) {
    package_path <- find.package(pkgname, quiet = TRUE)
    if (!length(package_path)) {
        return("<missing>")
    }

    package_path <- normalizePath(package_path[[1L]], winslash = "/", mustWork = FALSE)
    pkgbase <- basename(package_path)
    files <- c(
        package_path,
        file.path(package_path, "DESCRIPTION"),
        file.path(package_path, "NAMESPACE"),
        file.path(package_path, "Meta", "package.rds"),
        file.path(package_path, "R", paste0(pkgbase, ".rdb")),
        file.path(package_path, "R", paste0(pkgbase, ".rdx")),
        file.path(package_path, "help", paste0(pkgbase, ".rdb")),
        file.path(package_path, "help", paste0(pkgbase, ".rdx")),
        file.path(package_path, "libs"),
        list.files(file.path(package_path, "libs"), full.names = TRUE)
    )
    files <- unique(files[file.exists(files)])
    info <- file.info(files)

    paste(
        files,
        info$size,
        format(info$mtime, "%Y-%m-%dT%H:%M:%OS6", tz = "UTC"),
        format(info$ctime, "%Y-%m-%dT%H:%M:%OS6", tz = "UTC"),
        sep = ":",
        collapse = "|"
    )
}

check_package_changes <- function(workspace, packages = character()) {
    changed <- character()
    packages <- unique(c(
        "languageserver",
        normalize_character(packages),
        workspace$startup_packages,
        workspace$namespaces$keys()
    ))

    for (pkgname in packages) {
        fingerprint <- package_fingerprint(pkgname)
        if (exists(pkgname, envir = package_fingerprints, inherits = FALSE)) {
            if (!identical(get(pkgname, envir = package_fingerprints, inherits = FALSE), fingerprint)) {
                changed <- c(changed, pkgname)
            }
        } else {
            assign(pkgname, fingerprint, envir = package_fingerprints)
        }
    }

    changed
}

server <- languageserver:::LanguageServer$new(host, port)
server$request_handlers[["rConsole/syncSessionState"]] <- function(self, id, params) {
    attached_packages <- normalize_character(params$attachedPackages)
    workspace <- self$get_workspace(self$rootUri)

    # languageserver resolves package conflicts from the end of this list.
    workspace$startup_packages <- rev(attached_packages)
    workspace$update_loaded_packages()

    self$deliver(languageserver:::Response$new(id, result = TRUE))
}
server$request_handlers[["rConsole/checkPackageChanges"]] <- function(self, id, params) {
    workspace <- self$get_workspace(self$rootUri)
    packages <- normalize_character(params$packages)
    changed_packages <- check_package_changes(workspace, packages)
    self$deliver(languageserver:::Response$new(id, result = changed_packages))
}
server$notification_handlers[["textDocument/didClose"]] <- console_text_document_did_close

server$run()
