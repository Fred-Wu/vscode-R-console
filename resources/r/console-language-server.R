# Each process uses normal R startup and the active console library order.
runtime_lib_count <- Sys.getenv("VSCR_LSP_LIBRARY_COUNT")
if (nzchar(runtime_lib_count)) {
    if (!grepl("^(0|[1-9][0-9]*)$", runtime_lib_count)) stop("Invalid library path count")
    count <- suppressWarnings(as.integer(runtime_lib_count))
    if (is.na(count)) stop("Invalid library path count")
    runtime_lib_paths <- if (count) Sys.getenv(paste0("VSCR_LSP_LIBRARY_", seq_len(count) - 1L), unset = NA_character_) else character()
    if (anyNA(runtime_lib_paths)) stop("Missing library path")
    .libPaths(runtime_lib_paths, include.site = FALSE)
}

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
        # Virtual documents have no filesystem path. Preserve the native close
        # handler's task and reply cancellation before removing their state.
        for (manager in list(self$parse_task_manager, self$resolve_task_manager, self$member_task_manager)) {
            if (!is.null(manager) && is.function(manager$cancel)) manager$cancel(uri)
        }
        workspace <- self$get_workspace(uri)
        if (workspace$documents$has(uri)) {
            doc <- workspace$documents$get(uri)
            doc$did_close()
            workspace$documents$remove(uri)
            workspace$update_loaded_packages()
        }
        for (queue in self$pending_replies$get(uri, NULL)) {
            while (queue$size()) {
                item <- queue$pop()
                self$deliver(languageserver:::ResponseErrorMessage$new(item$id, "RequestCancelled",
                    "Request cancelled because the document was closed"))
            }
        }
        self$pending_replies$remove(uri)
        return(invisible(NULL))
    }

    languageserver:::text_document_did_close(self, params)
}

server <- languageserver:::LanguageServer$new(host, NULL)
if (!is.null(port)) {
    token <- Sys.getenv("VSCR_LSP_AUTH_TOKEN")
    if (!grepl("^[0-9a-f]{64}$", token)) stop("Missing console language server token")

    # VS Code generated this fresh process-specific nonce using the OS CSPRNG.
    # It is independent from the shared secret and never reused on a restart.
    nonce_hex <- Sys.getenv("VSCR_LSP_CLIENT_NONCE")
    if (!grepl("^[0-9a-f]{64}$", nonce_hex)) stop("Missing language server client nonce")
    nonce <- as.raw(strtoi(substring(nonce_hex, seq.int(1L, 64L, 2L),
                              seq.int(2L, 64L, 2L)), 16L))

    auth_timeout <- suppressWarnings(as.integer(Sys.getenv("VSCR_LSP_AUTH_TIMEOUT_SECONDS")))
    if (is.na(auth_timeout) || auth_timeout <= 0L) {
        stop("Missing or invalid language server authentication timeout")
    }

    # Initialize the server before connecting: the TCP constructor connects
    # before its task managers and workspaces are initialized.
    # Switch the initialized server from stdio to TCP before authenticating.
    stdio_input <- server$inputcon
    server$inputcon <- socketConnection(host = host, port = port, open = "r+b", blocking = FALSE)
    server$outputcon <- server$inputcon
    server$tcp <- TRUE
    close(stdio_input)

    # The languageserver TCP input is nonblocking. Enforce one deadline across
    # fragmented reads, and bound any underlying socket operation.
    previous_socket_timeout <- socketTimeout(server$inputcon, auth_timeout)
    deadline <- proc.time()[["elapsed"]] + auth_timeout
    read_auth <- function(count) {
        received <- raw()
        while (length(received) < count) {
            remaining <- deadline - proc.time()[["elapsed"]]
            if (remaining <= 0 ||
                !isTRUE(socketSelect(list(server$inputcon), timeout = remaining)[[1L]])) {
                stop("Language server authentication timed out")
            }
            part <- readBin(server$inputcon, "raw", n = count - length(received))
            if (!length(part)) stop("Language server authentication socket closed")
            received <- c(received, part)
        }
        if (proc.time()[["elapsed"]] > deadline) stop("Language server authentication timed out")
        received
    }
    auth_mac <- function(context, peer_nonce) {
        digest::hmac(
            key = charToRaw(token),
            object = c(charToRaw(context), nonce, peer_nonce),
            algo = "sha256",
            serialize = FALSE,
            raw = TRUE
        )
    }
    writeBin(nonce, server$outputcon)
    flush(server$outputcon)
    response <- read_auth(64L)
    peer_nonce <- response[seq_len(32L)]
    server_mac <- response[33:64]
    expected <- auth_mac("rconsole-lsp-server-v2", peer_nonce)
    # Compare all bytes, without an early exit on a mismatch.
    if (sum(bitwXor(as.integer(server_mac), as.integer(expected))) != 0L) {
        stop("Invalid language server authentication proof")
    }
    writeBin(auth_mac("rconsole-lsp-client-v2", peer_nonce), server$outputcon)
    flush(server$outputcon)
    socketTimeout(server$inputcon, previous_socket_timeout)
}
# Source dedicated completion adapters beside this entry point.
console_script <- if (sys.nframe() > 0L) sys.frame(1)$ofile else NULL
if (is.null(console_script)) {
    console_script <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[[1L]])
}
console_resource_dir <- dirname(console_script)
for (resource in c("completion-runtime.R", "completion-static.R", "completion-arguments.R", "completion-provider.R")) {
    source(file.path(console_resource_dir, resource), local = TRUE)
}

server$request_handlers[["rConsole/syncSessionState"]] <- function(self, id, params) {
    attached_packages <- normalize_character(params$attachedPackages)
    workspace <- self$get_workspace(self$rootUri)

    # Session attachment is dynamic in the console. Retained member catalogs
    # can otherwise resolve a bare name from a package that was detached.
    # Retire only those in-memory catalogs; native disk metadata stays reusable.
    for (package in setdiff(workspace$startup_packages, attached_packages)) {
        if (is.function(workspace$member_metadata$has) && workspace$member_metadata$has(package)) {
            workspace$member_metadata$remove(package)
        }
    }

    # languageserver resolves package conflicts from the end of this list.
    workspace$startup_packages <- rev(attached_packages)
    workspace$update_loaded_packages()

    self$deliver(languageserver:::Response$new(id, result = list(libraryPaths = as.list(.libPaths()),
        startupPackages = as.list(languageserver:::startup_packages))))
}
server$request_handlers[["rConsole/libraryPaths"]] <- function(self, id, params) {
    self$deliver(languageserver:::Response$new(id, result = as.list(.libPaths())))
}
library_paths_changed <- FALSE
server$request_handlers[["rConsole/syncLibraryPaths"]] <- function(self, id, params) {
    previous <- .libPaths()
    .libPaths(normalize_character(params$libraryPaths), include.site = FALSE)
    # The client replaces this process when the effective order changes. The
    # latest paths initialize fresh namespace caches.
    # Keep the replacement requirement across retries if a reply is lost.
    library_paths_changed <<- library_paths_changed || !identical(previous, .libPaths())
    self$deliver(languageserver:::Response$new(id,
        result = list(changed = library_paths_changed)))
}
pending_package_changes <- character()
server$request_handlers[["rConsole/refreshPackages"]] <- function(self, id, params) {
    changed <- normalize_character(params$changed)
    loaded <- loadedNamespaces()
    unmonitored <- normalize_character(params$unmonitored)
    unmonitored_roots <- chartr("\\", "/", normalize_character(params$unmonitoredRoots))
    unmonitored_installations <- chartr("\\", "/", normalize_character(params$unmonitoredInstallationPaths))
    deferred <- chartr("\\", "/", normalize_character(params$deferred))
    pending_package_changes <<- union(pending_package_changes,
        chartr("\\", "/", normalize_character(params$changedInstallationPaths)))
    changed_paths <- pending_package_changes
    excluded <- union(unmonitored, basename(deferred))
    excluded <- union(excluded, Filter(function(pkgname) {
        dirname(chartr("\\", "/", getNamespaceInfo(pkgname, "path"))) %in% unmonitored_roots
    }, setdiff(loaded, "base")))
    selected_installations <- new.env(parent = emptyenv())
    selected_installation <- function(pkgname) {
        if (exists(pkgname, selected_installations, inherits = FALSE)) {
            return(get(pkgname, selected_installations, inherits = FALSE))
        }
        candidates <- chartr("\\", "/", normalize_character(params$installations[[pkgname]]))
        barriers <- which(candidates %in% unmonitored_installations |
            dirname(candidates) %in% unmonitored_roots)
        if (length(barriers)) candidates <- head(candidates, barriers[[1]] - 1L)
        # The monitor observes entries only. R validates package metadata and
        # chooses among the observed copies, including links to missing folders.
        selected <- if (length(candidates)) {
            find.package(pkgname, lib.loc = unique(dirname(candidates)), quiet = TRUE, verbose = FALSE)
        } else character()
        if (length(selected)) {
            # R can return .Library using an alias. Canonicalize its parent
            # while retaining a package link's own entry for change matching.
            selected <- file.path(normalizePath(dirname(selected), winslash = "/", mustWork = FALSE), basename(selected))
        }
        # NULL means selection is unknown beyond an excluded copy. Preserve
        # that boundary without opening or resolving its metadata or links.
        if (!length(selected) && length(barriers)) {
            selected <- NULL
            excluded <<- union(excluded, pkgname)
        }
        assign(pkgname, selected, selected_installations)
        selected
    }
    changed_loaded <- character()
    switched <- Filter(function(pkgname) {
        # Excluded installations remain outside automatic reconciliation. Check
        # names before resolving paths, which could traverse a package link.
        if (pkgname %in% excluded) return(FALSE)
        # Initial discovery can encounter a package that was already loaded
        # while its installation is locked. Reconcile it after the lock clears.
        current <- chartr("\\", "/", getNamespaceInfo(pkgname, "path"))
        if (current %in% deferred) return(FALSE)
        installation <- selected_installation(pkgname)
        if (is.null(installation)) return(FALSE)
        if (!length(installation)) return(TRUE)
        if (installation %in% changed_paths) changed_loaded <<- union(changed_loaded, pkgname)
        current <- normalizePath(getNamespaceInfo(pkgname, "path"), winslash = "/", mustWork = FALSE)
        selected <- normalizePath(installation, winslash = "/", mustWork = FALSE)
        !identical(selected, current)
    }, setdiff(loaded, "base"))
    restart <- union(changed_loaded, switched)
    if (length(restart)) {
        # Removing metadata cannot replace functions or DLLs already loaded in R.
        return(self$deliver(languageserver:::Response$new(id, result = list(restart = as.list(restart)))))
    }
    # A valid later copy can change while the first observed link stays fixed.
    changed <- union(changed, Filter(function(pkgname) {
        if (pkgname %in% excluded) return(FALSE)
        selected <- selected_installation(pkgname)
        if (is.null(selected)) return(FALSE)
        !length(selected) || selected %in% changed_paths
    }, unique(basename(changed_paths))))
    changed <- setdiff(changed, excluded)
    changed <- Filter(function(pkgname) !is.null(selected_installation(pkgname)), changed)
    for (workspace in self$workspaces$values()) {
        affected <- changed
        if (length(changed) && is.function(workspace$s3_metadata$keys)) {
            repeat {
                dependents <- Filter(function(pkgname) {
                    dependencies <- workspace$s3_metadata$catalog(pkgname)$dependencies
                    any(normalize_character(dependencies) %in% affected)
                }, workspace$s3_metadata$keys())
                expanded <- union(affected, dependents)
                if (identical(expanded, affected)) break
                affected <- expanded
            }
        }
        for (pkgname in affected) {
            if (workspace$namespaces$has(pkgname)) workspace$namespaces$remove(pkgname)
            if (is.function(workspace$member_metadata$has) && workspace$member_metadata$has(pkgname)) {
                workspace$member_metadata$remove(pkgname)
            }
            if (is.function(workspace$s3_metadata$has) && workspace$s3_metadata$has(pkgname)) {
                workspace$s3_metadata$set(pkgname, list(schema = 1L, package = pkgname,
                    generation = paste0("invalidated-", Sys.time()), dependencies = character(),
                    functions = list(), objects = list(), methods = list(), error = "Package installation changed"))
            }
        }
        if (length(affected)) {
            workspace$update_loaded_packages()
            for (document in workspace$documents$values()) {
                requested <- normalize_character(c(document$loaded_packages,
                    unlist(document$requested_packages, use.names = FALSE)))
                if (!any(requested %in% affected)) next
                uri <- document$uri
                self$resolve_task_manager$cancel(uri)
                if (!is.null(self$member_task_manager)) self$member_task_manager$cancel(uri)
                if ("requested_packages" %in% names(document)) document$requested_packages <- NULL
                if ("member_refresh" %in% names(document)) document$member_refresh <- TRUE
                self$text_sync(uri, document, parse = TRUE)
            }
        }
    }
    # Keep changes to excluded names until reconciliation resumes. A healthy
    # later copy can change while an earlier library is suspended or unreadable.
    pending_package_changes <<- changed_paths[basename(changed_paths) %in% excluded]
    self$deliver(languageserver:::Response$new(id, result = list(restart = list(), changed = as.list(changed))))
}
server$notification_handlers[["textDocument/didClose"]] <- console_text_document_did_close

server$run()
