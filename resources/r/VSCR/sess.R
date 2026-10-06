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

            plot_backend <- Sys.getenv("SESS_PLOT_BACKEND", "auto")
            connect_args <- list(
                endpoint = endpoint,
                use_rstudioapi = as.logical(Sys.getenv("SESS_RSTUDIOAPI", "TRUE"))
            )
            if ("plot_backend" %in% names(formals(connect))) {
                connect_args$plot_backend <- plot_backend
            } else {
                connect_args$use_httpgd <- plot_backend %in% c("auto", "httpgd")
                connect_args$use_jgd <- plot_backend %in% c("auto", "jgd")
            }
            do.call(connect, connect_args)
        },
        error = function(err) {
            report_bootstrap_failure(conditionMessage(err))
            invisible(NULL)
        }
    )
})
