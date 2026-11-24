import type { CompletionCandidate, CompletionContext, CompletionResult, StaticCompletionCandidate, StaticCompletionResult } from "./types";
import { quoteCompletionValue } from "./rText";

/** Translate installed languageserver metadata at the native-provider boundary. */
export function adaptNativeCompletionResult(result: CompletionResult, context?: CompletionContext): StaticCompletionResult {
  const adapt = (item: CompletionCandidate): StaticCompletionCandidate => {
    const data = (item as CompletionCandidate & { data?: {
      type?: string; parameter?: string; package?: string; uri?: string; context_uri?: string;
    } }).data;
    const type = data?.type;
    const role = item.role ?? (type === "subscript_special" ? "scope"
      : type?.endsWith("argument_value") || item.detail?.startsWith("value for ") ? "value"
      : data?.parameter !== undefined || type?.endsWith("parameter") || item.detail === "parameter" ? "argument"
      : type === "member" || type === "scope" ? type : "symbol");
    const packageName = data?.package && /^[A-Za-z][A-Za-z0-9.]*$/.test(data.package) ? data.package
      : /^\{([A-Za-z][A-Za-z0-9.]*)\}$/.exec(item.detail ?? "")?.[1];
    return {
      ...item, role,
      // Native value labels describe literal strings. Normalize them before
      // presentation, preserving dollar signs and using the current R quote.
      ...(role === "value" && !item.range ? {
        insertText: quoteCompletionValue(typeof item.label === "string" ? item.label : item.label.label,
          context?.argumentValue?.quote ?? context?.bracketQuote),
        insertTextFormat: 1,
      } : {}),
      ...(type === "subscript_parameter" ? { subscriptParameter: true } : {}),
      ...(type === "subscript_special" ? { bracketSpecial: true } : {}),
      ...(packageName && /^[A-Za-z][A-Za-z0-9.]*$/.test(packageName) ? { packageName } : {}),
      ...(item.detail === "[workspace]" ? { workspaceOrigin: {
        definitionUri: data?.package === "_workspace_" ? data.context_uri : data?.uri,
        contextUri: data?.context_uri,
      } } : {}),
    };
  };
  const items = (Array.isArray(result) ? result : result.items).map(adapt);
  return Array.isArray(result) ? Object.assign([], result, items) : { ...result, items };
}
