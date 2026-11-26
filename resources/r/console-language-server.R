# The first process discovers project configuration through normal R startup.
# Replacements restore the startup environment and completion options with the
# console's library order. Profiles and automatic package loading are disabled.
runtime_lib_paths <- Sys.getenv("VSCR_RUNTIME_LIB_PATHS")
restore_startup <- identical(Sys.getenv("VSCR_LSP_RESTORE_STARTUP"), "TRUE")
# Keep this limit in sync with lspStartupState.ts. The envelope travels only
# through the authenticated LSP transport and the spawned child's private stdin.
startup_state_limit <- 16L * 1024L * 1024L
startup_payload <- NULL
startup_environment <- function() {
    values <- Sys.getenv()
    # Transport credentials and R's temporary directory belong to this process.
    keys <- toupper(names(values))
    values[!startsWith(keys, "VSCR_") & keys != "R_SESSION_TMPDIR"]
}
if (restore_startup) {
    # Options remain serialized inside this namespace-free envelope: reading a
    # function's namespace reference can load its package during deserialization.
    startup <- local({
        input <- file("stdin", open = "rb")
        on.exit(close(input))
        read_exact <- function(size) {
            value <- raw(size)
            offset <- 0L
            while (offset < size) {
                part <- readBin(input, "raw", n = min(65536L, size - offset))
                if (!length(part)) stop("Incomplete language server startup state")
                value[seq.int(offset + 1L, offset + length(part))] <- part
                offset <- offset + length(part)
            }
            value
        }
        size <- readBin(read_exact(4L), "integer", n = 1L, size = 4L, endian = "big")
        if (is.na(size) || size <= 0L || size > startup_state_limit) {
            stop("Invalid language server startup state size")
        }
        # The parent supplies this pipe at process creation; no pathname or
        # network peer can substitute the serialized configuration.
        unserialize(read_exact(size))
    })
    if (!identical(startup$format_version, 1L) ||
        !identical(startup$r_version, as.character(getRversion()))) {
        stop("Incompatible language server startup state; start a new R console")
    }
    if (!nzchar(Sys.getenv("VSCR_LSP_PORT"))) {
        # Let the parent send stdio LSP bytes only after closing the bootstrap
        # reader, whose C buffer could otherwise read ahead into those messages.
        cat("RCS1")
        flush(stdout())
    }
    # Include profile-created values, empty values and explicit unsets before
    # loading any packages that depend on the startup configuration.
    Sys.unsetenv(setdiff(names(startup_environment()), names(startup$environment)))
    do.call(Sys.setenv, as.list(startup$environment))
    # .libPaths() always appends .Library, even with include.site = FALSE.
    # Restore the effective profile-defined roots before selecting libraries or
    # deserializing options. Preserve the base bindings' original lock state.
    local({
        roots <- startup$library_roots
        for (name in c(".Library", ".Library.site")) {
            if (!name %in% names(roots)) stop("Missing startup library root: ", name)
            locked <- bindingIsLocked(name, baseenv())
            if (locked) unlockBinding(name, baseenv())
            tryCatch(assign(name, roots[[name]], envir = baseenv()),
                finally = if (locked) lockBinding(name, baseenv()))
        }
    })
}
if (nzchar(runtime_lib_paths)) {
    .libPaths(strsplit(runtime_lib_paths, "\n", fixed = TRUE)[[1L]], include.site = FALSE)
} else if (restore_startup) {
    .libPaths(startup$library_paths, include.site = FALSE)
}

if (restore_startup) {
    # Namespace load hooks may need ordinary profile settings while the
    # remaining option values are being deserialized.
    options(startup$plain_options)
    options(unserialize(startup$options))
    for (package in rev(setdiff(startup$packages, "base"))) {
        require(package, character.only = TRUE, quietly = TRUE, warn.conflicts = FALSE)
    }
    rm(startup)
} else {
    # Profile-defined options may be required by packages before they load.
    # Capture before loading the language server and keep the bytes in memory.
    startup_payload <- local({
        # Only reference-free values can be read before library selection.
        # Inspect attributes too: even an atomic option can carry a closure.
        plain_option <- function(value) {
            if (isS4(value)) return(FALSE)
            type <- typeof(value)
            if (!type %in% c("NULL", "logical", "integer", "double", "complex",
                "character", "raw", "list")) return(FALSE)
            if (type == "list" && !all(vapply(unclass(value), plain_option, logical(1)))) return(FALSE)
            all(vapply(attributes(value), plain_option, logical(1)))
        }
        startup_options <- options()
        payload <- serialize(list(format_version = 1L, r_version = as.character(getRversion()),
            library_paths = .libPaths(), options = serialize(startup_options, NULL),
            plain_options = Filter(plain_option, startup_options), packages = .packages(),
            environment = startup_environment(),
            library_roots = mget(c(".Library", ".Library.site"), envir = baseenv(),
                inherits = FALSE)), NULL)
        if (length(payload) > startup_state_limit) stop("Language server startup state exceeds 16 MiB")
        payload
    })
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

# The client takes ownership once, after mutual socket authentication (or over
# inherited stdio). Never include this payload in lifecycle or completion logs.
server$request_handlers[["rConsole/takeStartupState"]] <- function(self, id, params) {
    payload <- startup_payload
    startup_payload <<- NULL
    self$deliver(languageserver:::Response$new(id, result =
        if (is.null(payload)) NULL else gsub("\n", "", jsonlite::base64_enc(payload), fixed = TRUE)))
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
    # The client replaces this process when the effective order changes. Its
    # retained startup state and latest paths initialize fresh namespace caches.
    # Keep the replacement requirement across retries if a reply is lost.
    library_paths_changed <<- library_paths_changed || !identical(previous, .libPaths())
    self$deliver(languageserver:::Response$new(id,
        result = list(changed = library_paths_changed)))
}
server$request_handlers[["rConsole/refreshPackages"]] <- function(self, id, params) {
    changed <- normalize_character(params$changed)
    loaded <- loadedNamespaces()
    unmonitored <- normalize_character(params$unmonitored)
    unmonitored_roots <- chartr("\\", "/", normalize_character(params$unmonitoredRoots))
    deferred <- chartr("\\", "/", normalize_character(params$deferred))
    switched <- Filter(function(pkgname) {
        # Excluded installations remain outside automatic reconciliation. Check
        # names before resolving paths, which could traverse a package link.
        if (pkgname %in% unmonitored) return(FALSE)
        # Initial discovery can encounter a package that was already loaded
        # while its installation is locked. Reconcile it after the lock clears.
        current <- chartr("\\", "/", getNamespaceInfo(pkgname, "path"))
        if (dirname(current) %in% unmonitored_roots) return(FALSE)
        if (current %in% deferred) return(FALSE)
        installation <- params$installations[[pkgname]]
        if (is.null(installation)) return(TRUE)
        current <- normalizePath(getNamespaceInfo(pkgname, "path"), winslash = "/", mustWork = FALSE)
        selected <- normalizePath(installation, winslash = "/", mustWork = FALSE)
        !identical(selected, current)
    }, setdiff(loaded, "base"))
    restart <- union(intersect(setdiff(normalize_character(params$changedInstallations),
        unmonitored), loaded), switched)
    if (length(restart)) {
        # Removing metadata cannot replace functions or DLLs already loaded in R.
        return(self$deliver(languageserver:::Response$new(id, result = list(restart = as.list(restart)))))
    }
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
    self$deliver(languageserver:::Response$new(id, result = list(restart = list())))
}
server$notification_handlers[["textDocument/didClose"]] <- console_text_document_did_close

server$run()
