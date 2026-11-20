# Native completion owns semantic inference; supplements cover console-specific gaps.
console_supplement_completion <- function(reply, self, params) {
    textDocument <- params$textDocument
    uri <- languageserver:::uri_escape_unicode(textDocument$uri)
    workspace <- self$get_workspace(uri)
    document <- workspace$documents$get(uri)
    if (is.null(document)) return(reply)
    if (is.null(reply$result)) reply$result <- list(items = list(), isIncomplete = FALSE)

    point <- document$from_lsp_position(params$position)
    static_analysis <- isTRUE(params$rConsoleStaticAnalysis)
    reply$result$rConsoleRuntimeOnly <- !static_analysis
    # Ask the native resolver whether an empty member list is authoritative.
    # This uses its cached receiver and avoids probing stale live objects when
    # the current source defines an empty list or the prefix has no matches.
    if (static_analysis && exists("member_cursor", asNamespace("languageserver"), inherits = FALSE)) {
        cursor <- languageserver:::member_cursor(document, point)
        if (!is.null(cursor)) {
            resolved <- languageserver:::member_resolve_cursor(uri, workspace, document, point, cursor)
            reply$result$rConsoleMemberResolved <- !is.null(resolved$value) &&
                (length(resolved$value$type) > 0L || identical(resolved$value$reason, "unresolved_dollar_dispatch"))
        }
    }

    if ((!is.null(params$rConsoleCall) || !is.null(params$rConsoleDataObject) || isTRUE(params$rConsolePipe)) &&
        is.character(params$rConsoleParseSuffix) && length(params$rConsoleParseSuffix) == 1L) {
        previous_parse <- document$parse_data
        on.exit(document$update_parse_data(previous_parse), add = TRUE)
        document$update_parse_data(console_completion_parse(uri, document, params$rConsoleParseSuffix, params$rConsoleParseInsertion))
    }

    if (static_analysis && is.character(params$rConsoleDataObject) && length(params$rConsoleDataObject) == 1L) {
        root <- tryCatch(str2lang(params$rConsoleDataObject), error = function(e) NULL)
        while (is.call(root) && is.symbol(root[[1L]]) && as.character(root[[1L]]) %in% c("$", "@", "[[")) root <- root[[2L]]
        # An unexecuted source binding is not the same object as a live namesake.
        if (is.symbol(root) && !is.null(console_source_function(document, point, as.character(root)))) {
            reply$result$rConsoleMemberResolved <- TRUE
        }
    }

    call <- console_call_identity(params$rConsoleCall)
    native_arguments <- any(vapply(reply$result$items, function(item)
        isTRUE(item$data$type %in% c("s3_parameter", "s3_argument_value")) ||
            (identical(item$data$type, "member") && !is.null(item$data$parameter)), logical(1)))
    member_call <- !is.null(call) && call$accessor %in% c("$", "@")
    # Static source inference is explicitly opt-in. Live sess signatures take
    # precedence in normal console mode regardless of native package inference.
    source <- if (is.null(call) || !is.null(call$package) || !static_analysis) NULL else if (member_call) {
        if (native_arguments) NULL else console_member_function(uri, workspace, document, point)
    } else console_source_function(document, point, call$token)
    source_is_static <- !is.null(source)
    runtime <- if (is.null(source) && !is.null(call) && is.null(call$package))
        console_parse_signature(params$rConsoleRuntimeSignature) else NULL
    if (!is.null(runtime)) {
        source <- list(formals = runtime[[2L]])
        reply$result$rConsoleWorkspaceFunction <- TRUE
    }
    # Live sess signatures override package inference; unsubmitted source
    # definitions have precedence only in the opt-in static analysis mode.
    native_arguments <- native_arguments && is.null(source)
    signature <- if (!is.null(source)) console_source_signature(source, uri) else NULL
    if (source_is_static) reply$result$rConsoleLocalFunction <- TRUE
    if (native_arguments) {
        reply$result$rConsoleNativeArguments <- TRUE
        for (item in reply$result$items) {
            native_formals <- item$data$s3$method$formals
            if (!is.null(native_formals)) {
                signature <- console_source_signature(list(formals = native_formals), uri)
                break
            }
        }
        if (is.null(signature)) {
            location <- languageserver:::member_call_location(document, point, symbols = TRUE)
            constructor <- languageserver:::member_constructor_symbol(uri, workspace, document, location)
            if (!is.null(constructor$value$function_expr)) {
                signature <- console_source_signature(list(formals = constructor$value$function_expr[[2L]]), uri)
            }
        }
    }
    if (is.null(call) && !is.null(params$rConsoleCall)) {
        # A name accepted by the frontend lexer may be invalid in R's locale
        # (notably unquoted supplementary Unicode characters on Windows).
        # Never retain arguments from a suffix detected as a different call.
        reply$result$items <- Filter(function(item) !console_is_argument_item(item), reply$result$items)
    } else if (!native_arguments && !is.null(call) && (!member_call || !is.null(source))) {
        detected <- document$detect_call(point)
        value_mode <- is.character(params$rConsoleArgument) && length(params$rConsoleArgument) == 1L
        if (!is.null(source) || value_mode || !identical(call$token, detected$token) ||
            !identical(call$package, detected$package) ||
            !identical(call$accessor, detected$accessor)) {
            # Resolve parameters with the same workspace/provider as ordinary
            # completion, using the lexer-selected head without rewriting code
            # or evaluating the user's function or argument expressions.
            token <- if (value_mode) params$rConsolePrefix else document$detect_token(point, forward = FALSE)$token
            arguments <- if (!is.null(source)) {
                parameters <- if (!value_mode) Filter(function(item) languageserver:::match_with(item$label, token), signature) else list()
                values <- unlist(lapply(names(source$formals), function(name) {
                    defaults <- console_default_values(source$formals[[name]])
                    if (is.null(defaults)) return(list())
                    lapply(defaults[languageserver:::match_with(defaults, token)], function(value) {
                        list(label = value, kind = languageserver:::CompletionItemKind$Value,
                            detail = paste0("value for ", name), insertText = encodeString(value, quote = '\"'))
                    })
                }), recursive = FALSE)
                c(parameters, values)
            } else c(
                if (!value_mode) languageserver:::arg_completion(uri, workspace, point, token, call$token,
                    call$package, exported_only = call$accessor != ":::"),
                languageserver:::arg_value_completion(uri, workspace, document, point, token,
                    call$token, call$package, exported_only = call$accessor != ":::")
            )
            if (value_mode) {
                value_signature <- if (!is.null(source)) signature else languageserver:::arg_completion(
                    uri, workspace, point, "", call$token, call$package, exported_only = call$accessor != ":::")
                name <- console_value_argument(vapply(value_signature, console_argument_name, character(1)),
                    params$rConsoleArgument, params$rConsoleValueTags)
                arguments <- Filter(function(item) nzchar(name) && identical(item$detail, paste0("value for ", name)), arguments)
            }
            other <- Filter(function(item) !console_is_argument_item(item), reply$result$items)
            items <- c(arguments, other)
            nmax <- languageserver:::lsp_settings$get("max_completions")
            reply$result$items <- head(items, nmax)
            reply$result$isIncomplete <- isTRUE(reply$result$isIncomplete) || length(items) > nmax
        }
    }
    # Validate each proposed name using R's matching rules. Positional values,
    # partial tags and pipe insertion can make an otherwise unused name invalid.
    if (!isTRUE(source$unknown) && ((!native_arguments && (!member_call || !is.null(source))) || !is.null(signature))) reply$result$items <- console_valid_argument_items(reply$result$items,
        params$rConsoleArgumentTags, call, uri, workspace, point, signature)
    if (isTRUE(attr(reply$result$items, "arguments_exhausted"))) {
        reply$result$rConsoleArgumentsExhausted <- TRUE
        reply$result$items <- list()
        reply$result$isIncomplete <- FALSE
    }
    if (isTRUE(params$rConsoleSubscript)) {
        # The receiver is the implicit first argument of a subscript method.
        # Session signatures come from named sess hover requests; registered
        # package methods can be read from the LSP's own loaded namespaces.
        parsed <- console_parse_signature(params$rConsoleRuntimeSignature)
        method_formals <- if (!is.null(parsed)) parsed[[2L]] else NULL
        if (is.null(method_formals)) {
            op <- if (identical(params$rConsoleSubscriptOperator, "[[")) "[[" else "["
            classes <- normalize_character(params$rConsoleSubscriptClasses)
            for (class_name in classes) {
                method <- tryCatch(utils::getS3method(op, class_name, optional = TRUE),
                    error = function(error) NULL)
                if (is.function(method)) {
                    method_formals <- formals(method)
                    break
                }
            }
        }
        tags <- params$rConsoleSubscriptTags
        if (!is.null(method_formals) && is.list(tags) &&
            sum(vapply(tags, is.null, logical(1))) == 1L) {
            source_signature <- console_source_signature(list(formals = method_formals), uri)
            token <- params$rConsoleSubscriptPrefix
            if (!is.character(token) || length(token) != 1L) token <- ""
            arguments <- Filter(function(item) languageserver:::match_with(item$label, token),
                source_signature)
            selected <- console_valid_argument_items(arguments, c(list(""), tags),
                list(token = "", package = NULL, accessor = ""), uri, workspace, point, source_signature)
            # Mark these separately: native arguments belonging to an enclosing
            # function must never appear inside a subscript.
            selected <- lapply(selected, function(item) {
                item$data$type <- "subscript_parameter"
                item
            })
            # Preserve native symbols and inferred fields. Only parameter names
            # are supplemented by the active receiver's method.
            others <- Filter(function(item) !console_is_argument_item(item), reply$result$items)
            reply$result$items <- c(selected, others)
            reply$result$rConsoleSubscriptArguments <- TRUE
        }
    }
    if (isTRUE(params$rConsolePipe)) {
        token <- params$rConsolePrefix
        nmax <- languageserver:::lsp_settings$get("max_completions")
        scope <- languageserver:::scope_completion(uri, workspace, token, point, TRUE, nmax)
        symbols <- languageserver:::workspace_completion(workspace, token, snippet_support = TRUE, limit = nmax, uri = uri)
        candidates <- c(scope, symbols)
        functions <- Filter(function(item) identical(item$kind, languageserver:::CompletionItemKind$Function), candidates)
        reply$result$items <- head(functions, nmax)
        reply$result$isIncomplete <- length(functions) > nmax || isTRUE(attr(scope, "truncated")) ||
            isTRUE(attr(symbols, "truncated")) ||
            isTRUE(reply$result$isIncomplete)
    }
    reply
}

# Keep languageserver's asynchronous parse/metadata scheduling. Pending requests
# re-enter this handler; the proxy changes only delivery of the final response.
console_native_completion <- server$request_handlers[["textDocument/completion"]]
server$request_handlers[["textDocument/completion"]] <- function(self, id, params) {
    proxy <- as.list(self)
    proxy$deliver <- function(reply) {
        if (inherits(reply, "Response")) {
            native_result <- reply$result
            reply <- tryCatch(console_supplement_completion(reply, self, params), error = function(error) {
                languageserver:::logger$info("console completion supplement:", error)
                reply$result <- native_result
                reply
            })
        }
        self$deliver(reply)
    }
    console_native_completion(proxy, id, params)
}
