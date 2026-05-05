# Source the original .Rprofile
local({
    try_source <- function(file) {
        if (file.exists(file)) {
            source(file)
            TRUE
        } else {
            FALSE
        }
    }

    r_profile <- Sys.getenv("R_PROFILE_USER_OLD")
    Sys.setenv(
        R_PROFILE_USER_OLD = "",
        R_PROFILE_USER = r_profile
    )

    if (nzchar(r_profile)) {
        try_source(r_profile)
    } else {
        try_source(".Rprofile") || try_source(file.path("~", ".Rprofile"))
    }

    invisible()
})

# Connect this R session to vscode-R through the active session integration.
session_mode <- Sys.getenv("R_CONSOLE_SESSION_MODE", "disabled")
if (identical(session_mode, "sess") && requireNamespace("sess", quietly = TRUE)) {
    sess::connect(
        use_rstudioapi = as.logical(Sys.getenv("SESS_RSTUDIOAPI", "TRUE")),
        use_httpgd = as.logical(Sys.getenv("SESS_USE_HTTPGD", "TRUE"))
    )
}

# Run the legacy vscode-R initializer only for pre-sess vscode-R builds.
if (identical(session_mode, "legacy")) {
    local({
        report_bootstrap_failure <- function(message_text) {
            message("R Console: vscode-R session bootstrap failed: ", message_text)
            message("R Console: continuing without vscode-R session bootstrap.")
        }

        get_global <- function(name) {
            if (exists(name, envir = globalenv(), inherits = FALSE)) {
                get(name, envir = globalenv(), inherits = FALSE)
            } else {
                NULL
            }
        }

        init_file <- Sys.getenv("VSCODE_INIT_R")
        if (nzchar(init_file) && !("tools:vscode" %in% search())) {
            first_sys_before <- get_global(".First.sys")
            tryCatch(
                {
                    source(init_file, chdir = TRUE, local = TRUE)
                    first_sys_after <- get_global(".First.sys")
                    if (!("tools:vscode" %in% search()) &&
                        is.function(first_sys_after) &&
                        !identical(first_sys_after, first_sys_before)) {
                        user_first_exists <- exists(".First", envir = globalenv(), inherits = FALSE)
                        user_first <- get_global(".First")
                        assign(".First", function() {
                            if (user_first_exists) {
                                assign(".First", user_first, envir = globalenv())
                            } else if (exists(".First", envir = globalenv(), inherits = FALSE)) {
                                rm(".First", envir = globalenv())
                            }
                            if (is.function(user_first)) {
                                user_first()
                            }
                            first_sys_after()
                            invisible()
                        }, envir = globalenv())
                    }
                },
                error = function(err) {
                    report_bootstrap_failure(conditionMessage(err))
                    invisible(NULL)
                }
            )
        }
    })
}
rm(session_mode)

# Keep file.show() inside the console instead of launching the external R pager.
local({
    normalize_pager_command <- function(command) {
        tolower(trimws(command))
    }

    get_pager_rows <- function() {
        rows <- suppressWarnings(as.integer(Sys.getenv("VSC_R_ROWS", "")))
        if (is.na(rows) || rows < 6L) {
            rows <- 24L
        }
        max(1L, rows - 1L)
    }

    build_pager_lines <- function(files, header, title) {
        lines <- character()

        if (nzchar(title)) {
            lines <- c(lines, title, strrep("=", nchar(title)), "")
        }

        for (index in seq_along(files)) {
            current_header <- if (length(header) >= index) header[[index]] else ""
            if (nzchar(current_header)) {
                lines <- c(lines, current_header, strrep("-", nchar(current_header)))
            }

            if (file.exists(files[[index]])) {
                lines <- c(lines, readLines(files[[index]], warn = FALSE))
            }

            if (index < length(files)) {
                lines <- c(lines, "")
            }
        }

        lines
    }

    console_pager <- function(files,
                              header = rep("", length(files)),
                              title = "R Information",
                              delete.file = FALSE) {
        files <- path.expand(files)
        on.exit({
            if (delete.file) {
                unlink(files, force = TRUE)
            }
        }, add = TRUE)

        lines <- build_pager_lines(files, header, title)
        if (!length(lines)) {
            return(invisible(NULL))
        }

        page_rows <- get_pager_rows()
        start <- 1L
        total <- length(lines)

        repeat {
            end <- min(total, start + page_rows - 1L)
            page <- lines[start:end]

            cat(paste(page, collapse = "\n"))
            if (end < total || length(page) > 0L) {
                cat("\n")
            }

            command <- normalize_pager_command(readline(":"))
            if (command %in% c("q", "quit", "exit")) {
                break
            }

            if (command %in% c("b", "back", "p", "prev", "previous")) {
                start <- max(1L, start - page_rows)
                next
            }

            if (command %in% c("", " ", "f", "forward", "n", "next")) {
                if (end >= total) {
                    break
                }
                start <- end + 1L
                next
            }

            if (grepl("^[0-9]+$", command)) {
                target <- as.integer(command)
                if (!is.na(target) && target >= 1L && target <= total) {
                    start <- target
                }
                next
            }
        }

        invisible(NULL)
    }

    options(pager = console_pager)
})

# Lock prompt and GUI-selection options while the console is active.
local({
    base_env <- baseenv()
    current_options <- get("options", envir = base_env, inherits = FALSE)
    current_env <- environment(current_options)

    if (!is.null(current_env) &&
        isTRUE(get0("r_console_locked_options_wrapper", envir = current_env, inherits = FALSE))) {
        lock_env <- current_env
    } else {
        lock_env <- new.env(parent = baseenv())
        lock_env$r_console_locked_options_wrapper <- TRUE
        lock_env$base_options <- current_options
        lock_env$base_warning <- get("warning", envir = base_env, inherits = FALSE)
        lock_env$locked_message <- paste(
            "R Console locks options(prompt=...),",
            "options(continue=...), and options(menu.graphics=...)",
            "while the console is active."
        )

        lock_env$locked_options <- evalq(function(...) {
            dots <- list(...)
            blocked <- character()

            if (length(dots) == 1L && is.list(dots[[1L]]) && !is.object(dots[[1L]])) {
                opts <- dots[[1L]]
                if (!is.null(names(opts))) {
                    blocked <- intersect(names(opts), c("prompt", "continue", "menu.graphics"))
                    if ("prompt" %in% blocked) {
                        opts[["prompt"]] <- prompt_main
                    }
                    if ("continue" %in% blocked) {
                        opts[["continue"]] <- prompt_cont
                    }
                    if ("menu.graphics" %in% blocked) {
                        opts[["menu.graphics"]] <- menu_graphics
                    }
                }

                result <- do.call(base_options, list(opts))
                if (length(blocked)) {
                    base_warning(locked_message, call. = FALSE, immediate. = TRUE)
                    return(invisible(result))
                }
                return(result)
            }

            if (!is.null(names(dots))) {
                blocked <- intersect(names(dots), c("prompt", "continue", "menu.graphics"))
                if ("prompt" %in% blocked) {
                    dots[["prompt"]] <- prompt_main
                }
                if ("continue" %in% blocked) {
                    dots[["continue"]] <- prompt_cont
                }
                if ("menu.graphics" %in% blocked) {
                    dots[["menu.graphics"]] <- menu_graphics
                }
            }

            result <- do.call(base_options, dots)
            if (length(blocked)) {
                base_warning(locked_message, call. = FALSE, immediate. = TRUE)
                return(invisible(result))
            }
            result
        }, envir = lock_env)

        if (bindingIsLocked("options", base_env)) {
            unlockBinding("options", base_env)
        }
        assign("options", lock_env$locked_options, envir = base_env)
        lockBinding("options", base_env)
    }

    lock_env$prompt_main <- "> "
    lock_env$prompt_cont <- "+ "
    lock_env$menu_graphics <- FALSE
    lock_env$base_options(
        prompt = lock_env$prompt_main,
        continue = lock_env$prompt_cont,
        menu.graphics = lock_env$menu_graphics
    )
})
