# Native completion owns semantic inference; supplements cover console-specific gaps.
# Only inspect installed method metadata in the separate language-server process.
# A class hint comes from a stored global binding: never evaluate a draft
# receiver, an index expression, an extraction method, or a default value.
console_subscript_completion <- function(params, workspace, uri, point) {
    klass <- params$rConsoleSubscriptClass
    if (!identical(params$rConsoleSubscriptOperator, "[") ||
        !is.character(klass) || length(klass) != 1L || is.na(klass) ||
        !klass %in% c("data.table", "data.frame") ||
        !is.null(params$rConsoleSubscriptArgument)) return(list())
    tags <- params$rConsoleSubscriptTags
    if (!is.list(tags) || length(tags) == 0L || length(tags) > 32L ||
        sum(vapply(tags, is.null, logical(1L))) != 1L ||
        !all(vapply(tags, function(tag) is.null(tag) ||
            (is.character(tag) && length(tag) == 1L && !is.na(tag) &&
                nchar(tag, type = "bytes") <= 4096L), logical(1L)))) return(list())

    pkg <- if (identical(klass, "data.table")) "data.table" else "base"
    method <- paste0("[.", klass)
    installed_formals <- tryCatch(languageserver:::call_with_optional_uri(
        workspace$get_formals, method, pkg, exported_only = FALSE, uri = uri),
        error = function(e) NULL)
    parameters <- list()
    if (is.pairlist(installed_formals) && length(installed_formals) <= 128L) {
        signature <- console_source_signature(list(formals = installed_formals), uri)
        parameters <- lapply(signature, function(item) {
            item$data$type <- "subscript_parameter"
            item
        })
        # Receiver fills the method's x formal. Each bracket slot after it is
        # inert syntax, including positional slots left blank by the user.
        parameters <- console_valid_argument_items(parameters, c(list(""), tags),
            list(token = method, package = pkg, accessor = ":::"), uri, workspace, point,
            signature = signature)
    }

    specials <- list()
    if (identical(klass, "data.table")) {
        ns <- tryCatch(workspace$get_namespace(pkg, uri = uri), error = function(e) NULL)
        exports <- tryCatch(if (is.null(ns)) character() else
            ns$get_symbols(want_functs = FALSE, exported_only = TRUE),
            error = function(e) character())
        # Exported non-function uppercase dot names come from installed package
        # metadata, not a hardcoded list or source-only inferred variables.
        names <- head(grep("^\\.[A-Z][A-Z0-9]*$", exports, value = TRUE), 64L)
        specials <- lapply(names, function(name) list(
            label = name, kind = languageserver:::CompletionItemKind$Field,
            detail = "{data.table}", data = list(type = "subscript_special")))
    }
    c(parameters, specials)
}

# Diagnostic metadata only: preserve the native inference and candidate list.
# Reasons are a bounded vocabulary, never source text or exception messages.
console_static_unavailable_reason <- function(resolved) {
    if (isTRUE(resolved$budget$exhausted)) return("analysis-limit")
    if (isTRUE(resolved$budget$transient)) return("analysis-pending")
    reason <- resolved$value$reason
    if (isTRUE(reason %in% c("unresolved_dollar_dispatch", "unresolved_subset_dispatch")))
        return("unresolved-dispatch")
    if (isTRUE(reason %in% c("budget", "snapshot_budget", "snapshot_depth",
        "s4_slot_limit", "s7_property_limit"))) return("analysis-limit")
    if (isTRUE(reason %in% c("cycle", "alias_cycle", "recursion", "binding_cycle",
        "binding_recursion", "inheritance_cycle", "s4_cycle", "s7_recursion"))) return("inference-cycle")
    if (is.null(resolved$value) || !length(resolved$value$type)) return("receiver-unresolved")
    NULL
}

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
    if (static_analysis && !is.null(params$rConsoleOpaqueFunction) &&
        !isTRUE(tryCatch(console_source_overrides_opaque(params$rConsoleOpaqueFunction,
            uri, workspace, document, params$rConsoleOpaqueFunctionPosition), error = function(e) FALSE))) {
        reply$result$items <- list()
        reply$result$isIncomplete <- TRUE
        reply$result$rConsoleMemberResolved <- FALSE
        reply$result$rConsoleStaticUnavailableReason <- "receiver-unresolved"
        return(reply)
    }
    # Ask the native resolver whether an empty member list is authoritative.
    # This uses its cached receiver and avoids probing stale live objects when
    # the current source defines an empty list or the prefix has no matches.
    has_members <- any(vapply(reply$result$items, function(item)
        identical(item$data$type, "member") && is.null(item$data$parameter), logical(1)))
    if (static_analysis && has_members) {
        reply$result$rConsoleMemberResolved <- TRUE
    } else if (static_analysis) {
        cursor <- if (exists("member_cursor", asNamespace("languageserver"), inherits = FALSE) &&
            exists("member_resolve_cursor", asNamespace("languageserver"), inherits = FALSE))
            languageserver:::member_cursor(document, point) else NULL
        reason <- "unsupported-context"
        if (!is.null(cursor)) {
            resolved <- languageserver:::member_resolve_cursor(uri, workspace, document, point, cursor)
            reply$result$rConsoleMemberResolved <- !is.null(resolved$value) &&
                (length(resolved$value$type) > 0L || identical(resolved$value$reason, "unresolved_dollar_dispatch"))
            reason <- console_static_unavailable_reason(resolved)
        }
        # A known empty list or a prefix with no matches is still resolved.
        # Inferred candidates take precedence over an uncertain receiver shape.
        reply$result$rConsoleStaticUnavailableReason <- reason
    }

    if ((!is.null(params$rConsoleCall) || !is.null(params$rConsoleDataObject) || isTRUE(params$rConsolePipe)) &&
        is.character(params$rConsoleParseSuffix) && length(params$rConsoleParseSuffix) == 1L &&
        (nzchar(params$rConsoleParseSuffix) || !is.null(params$rConsoleParseInsertion))) {
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
    member_arguments <- any(vapply(reply$result$items, function(item)
        identical(item$data$type, "member") && !is.null(item$data$parameter), logical(1)))
    native_arguments <- member_arguments || any(vapply(reply$result$items, function(item)
        isTRUE(item$data$type %in% c("s3_parameter", "s3_argument_value")), logical(1)))
    member_call <- !is.null(call) && call$accessor %in% c("$", "@")
    method_root <- if (member_call) console_call_root(params$rConsoleCall, include_calls = TRUE) else NULL
    source_root <- if (static_analysis && member_call && !is.null(method_root))
        console_source_function(document, point, method_root) else NULL
    runtime_method <- if (member_call) console_runtime_arguments(params) else NULL
    runtime_method_evidence <- member_call && (!is.null(runtime_method) ||
        isTRUE(params$rConsoleRuntimeArgumentsRefused))
    native_signature <- if (native_arguments) console_native_signature(reply$result$items, uri) else NULL
    native_member <- static_analysis && member_call && member_arguments && !is.null(native_signature) &&
        is.null(source_root) && !runtime_method_evidence && !identical(method_root, "")
    member_source <- if (static_analysis && member_call && !native_member)
        console_member_function(uri, workspace, document, point, method_root, source_root) else NULL
    # Only an editable source binding can supersede a verified live signature
    # or refusal. A package catalog may describe a shadowed namesake.
    if (runtime_method_evidence && is.null(source_root) &&
        !isTRUE(member_source$source_binding) && !isTRUE(member_source$unknown)) {
        member_source <- NULL
        native_arguments <- FALSE
    }
    # A current source binding (including an unresolved factory or a formal)
    # must not borrow arguments from an older, same-named live object.
    source_method_root <- static_analysis && (native_member || !is.null(member_source) || !is.null(source_root))
    if (source_method_root) reply$result$rConsoleRuntimeArgumentsIgnored <- TRUE
    # Static source inference is explicitly opt-in. Live sess signatures take
    # precedence in normal console mode regardless of native package inference.
    source <- if (is.null(call) || !is.null(call$package) || !static_analysis) NULL else if (member_call) {
        if (native_arguments && !isTRUE(member_source$unknown)) NULL else member_source
    } else console_source_function(document, point, call$token)
    source_is_static <- !is.null(source)
    if (source_is_static) reply$result$rConsoleRuntimeArgumentsIgnored <- TRUE
    runtime <- if (is.null(source) && !is.null(call) && is.null(call$package)) {
        if (member_call) {
            if (!source_method_root) runtime_method else NULL
        } else {
            parsed <- console_parse_signature(params$rConsoleRuntimeSignature)
            if (!is.null(parsed)) list(formals = parsed[[2L]]) else console_runtime_arguments(params)
        }
    } else NULL
    if (is.null(source) && is.null(runtime) && !source_method_root &&
        isTRUE(params$rConsoleRuntimeArgumentsRefused)) runtime <- list(unknown = TRUE)
    if (!is.null(runtime)) {
        source <- runtime
        reply$result$rConsoleWorkspaceFunction <- TRUE
    }
    # Cached workspace signatures override package inference; unsubmitted source
    # definitions have precedence only in the opt-in static analysis mode.
    native_arguments <- native_arguments && is.null(source)
    signature <- if (!is.null(source)) console_source_signature(source, uri) else NULL
    if (source_is_static) reply$result$rConsoleLocalFunction <- TRUE
    if (native_arguments) {
        reply$result$rConsoleNativeArguments <- TRUE
        signature <- native_signature
    }
    # Prefix filtering, value matching and argument validation share one full
    # lookup from the native provider within this request. Never retain a live
    # receiver signature across requests or substitute a global for a method.
    argument_signature <- function() {
        if (is.null(signature) && !is.null(call) && !member_call && is.null(source)) {
            signature <<- languageserver:::arg_completion(uri, workspace, point, "", call$token,
                call$package, exported_only = call$accessor != ":::")
            attr(signature, "known_signature") <<- length(signature) > 0L
        }
        signature
    }
    if (member_call) {
        reply$result$rConsoleArgumentsResolved <- !is.null(signature)
        reply$result$rConsoleStaticUnavailableReason <- if (is.null(signature))
            "method-arguments-unavailable" else NULL
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
                if (!value_mode) Filter(function(item) languageserver:::match_with(item$label, token), argument_signature()),
                languageserver:::arg_value_completion(uri, workspace, document, point, token,
                    call$token, call$package, exported_only = call$accessor != ":::")
            )
            if (value_mode) {
                value_signature <- argument_signature()
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
        params$rConsoleArgumentTags, call, uri, workspace, point, argument_signature())
    if (isTRUE(attr(reply$result$items, "arguments_exhausted"))) {
        reply$result$rConsoleArgumentsExhausted <- TRUE
        reply$result$items <- list()
        reply$result$isIncomplete <- FALSE
    }
    if (!static_analysis && !is.null(params$rConsoleSubscriptClass)) {
        reply$result$items <- c(reply$result$items,
            console_subscript_completion(params, workspace, uri, point))
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
