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
