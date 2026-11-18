import type { CompletionContext } from "./types";

/** Ambient names require a typed token inside contextual expressions.
 * R utils::rcompgen suppresses basic name completion for an empty token.
 * Explicit top-level browsing and pipe callable discovery remain supported.
 */
export function allowsSymbolCompletions(context: CompletionContext): boolean {
  if (context.suppressAutomatic || context.bracketQuote || context.argumentValue?.quote ||
      context.kind === "member" || context.kind === "package") return false;
  return context.prefix.length > 0 || !!context.pipe ||
    (context.kind === "default" && !context.dataObjectName);
}
