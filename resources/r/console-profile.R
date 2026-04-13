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

# Run vscode initializer
local({
    report_bootstrap_failure <- function(message_text) {
        message("R Console: vscode-R session bootstrap failed: ", message_text)
        message("R Console: continuing without vscode-R session bootstrap.")
    }

    init_file <- Sys.getenv("VSCODE_INIT_R")
    if (nzchar(init_file)) {
        tryCatch(
            source(init_file, chdir = TRUE, local = TRUE),
            error = function(err) {
                report_bootstrap_failure(conditionMessage(err))
                invisible(NULL)
            }
        )
    }
})

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
