local({
    report_bootstrap_failure <- function(message_text) {
        message("R Console: vscode-R sess bootstrap failed: ", message_text)
        message("R Console: continuing without vscode-R session bootstrap.")
    }

    get_pipe_sess_connect <- function() {
        if (!requireNamespace("sess", quietly = TRUE)) {
            return(NULL)
        }
        connect <- get("connect", envir = asNamespace("sess"))
        if (!("pipe_path" %in% names(formals(connect)))) {
            return(NULL)
        }
        connect
    }

    tryCatch(
        {
            connect <- get_pipe_sess_connect()
            pipe_path <- Sys.getenv("SESS_PIPE")
            if (is.null(connect) || !nzchar(pipe_path)) {
                return(invisible(NULL))
            }
            connect(
                pipe_path = pipe_path,
                use_rstudioapi = as.logical(Sys.getenv("SESS_RSTUDIOAPI", "TRUE")),
                use_httpgd = as.logical(Sys.getenv("SESS_USE_HTTPGD", "TRUE")),
                use_jgd = as.logical(Sys.getenv("SESS_USE_JGD", "FALSE"))
            )
        },
        error = function(err) {
            report_bootstrap_failure(conditionMessage(err))
            invisible(NULL)
        }
    )
})
