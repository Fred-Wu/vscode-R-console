import type { CompletionContext } from "./types";

/** Read the receiver's actual method signature. The surrounding probe binds
 * .obj once. Only inert placeholders are matched: no index expression, method
 * body, or default is evaluated. Package semantics belong to the R provider.
 */
export function subscriptArgumentExpression(context: CompletionContext): string {
  if (context.bracketQuote || context.bracketArgumentName) return "base::character()";
  // Forwarded dots have unknown contents; never count them as one supplied index.
  const supplied = (context.bracketArgumentTags ?? [null]).filter(tag => tag !== "...").map(tag => tag === null
    ? "TRUE" : `${tag ? tag + " = " : ""}NULL`).join(", ");
  return `base::local({ .fn <- NULL; for (.class in base::class(.obj)) { ` +
    `.fn <- utils::getS3method("${context.bracketOperator ?? "["}", .class, optional = TRUE); ` +
    `if (base::is.function(.fn)) break }; ` +
    `if (base::isS4(.obj)) { .generic <- methods::getGeneric("${context.bracketOperator ?? "["}"); ` +
    `if (!base::is.null(.generic)) { .signature <- stats::setNames(base::rep("ANY", base::length(.generic@signature)), .generic@signature); ` +
    `.signature[[1L]] <- base::class(.obj)[[1L]]; .fn <- methods::selectMethod(.generic, .signature, optional = TRUE) } }; ` +
    `.matched <- if (base::is.function(.fn)) base::tryCatch(base::as.list(base::match.call(` +
    `definition = .fn, call = base::quote(.fn(NULL, ${supplied})), expand.dots = FALSE))[-1L], error = function(e) NULL) else NULL; ` +
    `.active <- base::vapply(.matched, base::identical, base::logical(1), TRUE); ` +
    `if (!base::is.null(.matched[["..."]]) && base::any(base::vapply(.matched[["..."]], base::identical, base::logical(1), TRUE))) ` +
    `.active <- .active | base::names(.matched) == "..."; ` +
    `if (base::sum(.active) == 1L) base::setdiff(base::names(base::formals(.fn)), ` +
    `base::c(base::setdiff(base::names(base::formals(.fn))[1L], "..."), base::setdiff(base::names(.matched)[!.active], "..."))) else base::character() })`;
}
