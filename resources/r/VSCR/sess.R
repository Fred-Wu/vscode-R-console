local({
    report_bootstrap_failure <- function(message_text) {
        message("R Console: vscode-R sess bootstrap failed: ", message_text)
        message("R Console: continuing without vscode-R session bootstrap.")
    }

    get_endpoint_sess_connect <- function() {
        if (!requireNamespace("sess", quietly = TRUE)) {
            return(NULL)
        }
        connect <- get("connect", envir = asNamespace("sess"))
        if (!("endpoint" %in% names(formals(connect)))) {
            return(NULL)
        }
        connect
    }

    tryCatch(
        {
            connect <- get_endpoint_sess_connect()
            endpoint <- Sys.getenv("SESS_ENDPOINT")
            if (is.null(connect) || !nzchar(endpoint)) {
                return(invisible(NULL))
            }
            connect(
                endpoint = endpoint,
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
