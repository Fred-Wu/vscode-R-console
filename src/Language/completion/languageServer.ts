import * as vscode from "vscode";
import type { CompletionAnalysisMode, CompletionContext, CompletionEntry, CompletionProvider, CompletionSourceDefinition } from "./types";
import { allowsSymbolCompletions } from "./policy";
import { completionMatch } from "../completionMatch";
import { staticCompletionUnavailableReason, type StaticCompletionUnavailableReason, type CompletionSuppressionReason } from "./diagnostics";
import { isCallableName } from "./contextParser";
import { backtickRName, escapeRControls, getFieldInsertText, quoteRNameIfNeeded, quoteCompletionValue, isCallableCompletionKind } from "./candidates";

export async function getLanguageServerCompletions(
  context: CompletionContext,
  doc: vscode.TextDocument,
  position: vscode.Position,
  multilineBuffer: string[],
  completionProvider?: CompletionProvider,
  runtimeBracketKind?: "data.frame" | "data.table" | null,
  analysisMode?: CompletionAnalysisMode,
  sourceDefinition?: CompletionSourceDefinition
): Promise<{ entries: CompletionEntry[]; isIncomplete: boolean; rConsoleLocalFunction?: boolean; runtimeOnly?: boolean; memberResolved?: boolean; staticUnavailableReason?: StaticCompletionUnavailableReason; workspaceFunction?: boolean; nativeArguments?: boolean; argumentsExhausted?: boolean; argumentsResolved?: boolean; argumentSuppressionReason?: CompletionSuppressionReason }> {
  if (!completionProvider) {
    return { entries: [], isIncomplete: false, staticUnavailableReason: "provider-unavailable" };
  }
  try {
    let result = await completionProvider.provideCompletionItems(
      doc,
      position,
      context.triggerCharacter, undefined, runtimeBracketKind, analysisMode, sourceDefinition
    );
    let runtimeOnly = result?.rConsoleRuntimeOnly === true;
    let localFunction = result?.rConsoleLocalFunction === true;
    let workspaceFunction = result?.rConsoleWorkspaceFunction === true;
    let memberResolved = result?.rConsoleMemberResolved === true;
    let staticReason = staticCompletionUnavailableReason(result?.rConsoleStaticUnavailableReason);
    let nativeArguments = result?.rConsoleNativeArguments === true;
    let argumentsExhausted = result?.rConsoleArgumentsExhausted === true;
    let argumentsResolved = result?.rConsoleArgumentsResolved;
    let argumentSuppressionReason = result?.rConsoleArgumentSuppressionReason;

    let items = Array.isArray(result) ? result : result?.items || [];
    const usable = (item: vscode.CompletionItem): boolean =>
      !(workspaceFunction && !context.argumentValue && getCompletionRole(item) === "value") &&
      isLanguageServerCompletionItem(context, item, doc.uri?.toString());
    // Some R language servers only return contiguous matches. If that lookup
    // has no usable candidates, request at the first prefix character and
    // apply our matcher to the returned candidates. Keep the real document and
    // its replacement start intact; never rewrite code to manufacture results.
    // Broadening a prefix cannot recover an unresolved method signature. It
    // would repeat both the native inspection and the same LSP lookup.
    const structuralFailure = (context.kind === "member" || context.kind === "bracket") &&
      staticReason !== undefined && [
      "receiver-unresolved", "unresolved-dispatch", "unsupported-context",
      "analysis-limit", "inference-cycle", "no-receiver-members",
    ].includes(staticReason);
    if (!structuralFailure && context.prefix.length > 1 && argumentsResolved !== false && !memberResolved && !argumentsExhausted && !restrictsBracketSymbols(context) &&
        !items.some(item => usable(item) &&
          completionMatch(getCompletionLabel(item), context.prefix))) {
      const firstCharacter = [...context.prefix][0];
      result = await completionProvider.provideCompletionItems(doc,
        new vscode.Position(position.line, context.replaceStart + firstCharacter.length),
        context.triggerCharacter, position, runtimeBracketKind, analysisMode, sourceDefinition);
      runtimeOnly ||= result?.rConsoleRuntimeOnly === true;
      localFunction ||= result?.rConsoleLocalFunction === true;
      workspaceFunction ||= result?.rConsoleWorkspaceFunction === true;
      memberResolved ||= result?.rConsoleMemberResolved === true;
      staticReason = staticCompletionUnavailableReason(result?.rConsoleStaticUnavailableReason);
      nativeArguments ||= result?.rConsoleNativeArguments === true;
      argumentsExhausted ||= result?.rConsoleArgumentsExhausted === true;
      argumentsResolved = result?.rConsoleArgumentsResolved ?? argumentsResolved;
      argumentSuppressionReason = result?.rConsoleArgumentSuppressionReason;
      items = Array.isArray(result) ? result : result?.items || [];
    }

    const filteredItems = items.filter((item) =>
      usable(item)
    );

    return {
      entries: filteredItems.map((item) => ({
        label: getCompletionLabel(item),
        insertText: getCompletionInsertText(item, context),
        kind: item.kind,
        detail: item.detail,
        role: getCompletionRole(item),
        ...(isSubscriptSpecial(item) ? { bracketSpecial: true } : {}),
        source: "lsp",
        replaceStart: getCompletionReplaceStart(item, context, multilineBuffer),
        ...getCompletionReplaceEnd(item, doc, position),
        packageName: getCompletionPackage(item),
      })),
      isIncomplete: !Array.isArray(result) && result?.isIncomplete === true,
      rConsoleLocalFunction: localFunction,
      runtimeOnly,
      memberResolved,
      staticUnavailableReason: result == null ? "no-response" : staticReason,
      workspaceFunction,
      nativeArguments,
      argumentsExhausted,
      argumentsResolved,
      argumentSuppressionReason,
    };
  } catch {
    return { entries: [], isIncomplete: false, staticUnavailableReason: "request-failed" };
  }
}

function isSubscriptSpecial(item: vscode.CompletionItem): boolean {
  return (item as vscode.CompletionItem & { data?: { type?: string } }).data?.type === "subscript_special";
}

function getCompletionRole(item: vscode.CompletionItem): CompletionEntry["role"] {
  const data = (item as vscode.CompletionItem & { data?: { type?: string; parameter?: string } }).data;
  const type = data?.type;
  if (type === "subscript_special") return "scope";
  if (type?.endsWith("argument_value") || item.detail?.startsWith("value for ")) return "value";
  if (data?.parameter !== undefined || type?.endsWith("parameter") || item.detail === "parameter") return "argument";
  if (type === "member" || type === "scope") return type;
  return undefined;
}

function getCompletionPackage(item: vscode.CompletionItem): string | undefined {
  if (!isCallableCompletionKind(item.kind)) {
    return undefined;
  }
  const data = (item as vscode.CompletionItem & { data?: { package?: unknown } }).data;
  if (typeof data?.package === "string" && /^[A-Za-z][A-Za-z0-9.]*$/.test(data.package)) {
    return data.package;
  }
  return /^\{([A-Za-z][A-Za-z0-9.]*)\}$/.exec(item.detail ?? "")?.[1];
}

function restrictsBracketSymbols(context: CompletionContext): boolean {
  return context.kind === "bracket" &&
    (context.bracketOperator === "[[" || !!context.bracketQuote || !context.prefix);
}

function isLanguageServerCompletionItem(
  context: CompletionContext,
  item: vscode.CompletionItem,
  documentUri?: string
): boolean {
  const role = getCompletionRole(item);
  const subscriptParameter = context.kind === "bracket" &&
    (item as vscode.CompletionItem & { data?: { type?: string } }).data?.type === "subscript_parameter";
  if (context.suppressAutomatic) return false;
  if (context.kind !== "member" && context.kind !== "package" && !allowsSymbolCompletions(context) &&
      role !== "argument" && role !== "value" && role !== "member" &&
      !(role === "scope" && item.kind === vscode.CompletionItemKind.Field)) return false;
  if (role === "argument" && !context.argumentTags && !subscriptParameter) return false;
  if (role === "value" && !context.argumentTags && !context.argumentValue) return false;
  // Native call detection can still see an outer call while our cursor is in
  // its subscript or member expression. Its arguments do not belong there.
  if ((role === "argument" || role === "value") &&
      context.kind !== "argument" && !subscriptParameter) return false;
  if (context.pipe && !isCallableCompletionKind(item.kind)) return false;
  if (context.argumentValue?.quote && role !== "value") return false;
  if (context.kind === "member" && role !== "member") return false;
  // Double-bracket indices and empty/quoted subscript slots used to exclude
  // generic LSP symbols. Preserve that boundary while allowing native fields
  // and literal index values inferred from this receiver.
  if (restrictsBracketSymbols(context) &&
      !subscriptParameter && role !== "member" &&
      !(role === "scope" && item.kind === vscode.CompletionItemKind.Field)) return false;
  if (item.kind === vscode.CompletionItemKind.Text) {
    return false;
  }

  if (item.detail === "[workspace]") {
    const data = (item as vscode.CompletionItem & { data?: { package?: string; context_uri?: string; uri?: string } }).data;
    // Only definitions from this console's virtual document are authoritative.
    // Other workspace/editor symbols must not leak into the console session.
    return isCallableCompletionKind(item.kind) && (data?.package === "_workspace_" || data?.uri === documentUri) &&
      documentUri !== undefined && data?.context_uri === documentUri;
  }

  if (
    (context.kind === "argument" || context.kind === "package") &&
    item.kind === vscode.CompletionItemKind.Snippet
  ) {
    return false;
  }

  return true;
}

function getCompletionLabel(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

/** Expand numeric LSP tab stops while preserving escaped R names and literals. */
function stripSnippetSyntax(text: string): string {
  let offset = 0;
  const expand = (nested = false): string => {
    let result = "";
    while (offset < text.length) {
      const char = text[offset++];
      if (char === "\\" && /[$}\\,|]/.test(text[offset] ?? "")) {
        result += text[offset++];
      } else if (char === "}" && nested) {
        break;
      } else if (char === "$" && /[0-9]/.test(text[offset] ?? "")) {
        while (/[0-9]/.test(text[offset] ?? "")) offset++;
      } else if (char === "$" && text[offset] === "{" && /[0-9]/.test(text[offset + 1] ?? "")) {
        offset++;
        while (/[0-9]/.test(text[offset] ?? "")) offset++;
        const delimiter = text[offset++];
        if (delimiter === ":") result += expand(true);
        else if (delimiter === "|") {
          let first = true;
          while (offset < text.length && !(text[offset] === "|" && text[offset + 1] === "}")) {
            const choice = text[offset++];
            if (choice === "\\" && offset < text.length) {
              const escaped = text[offset++];
              if (first) result += escaped;
            } else if (choice === ",") first = false;
            else if (first) result += choice;
          }
          offset += 2;
        }
      } else result += char;
    }
    return result;
  };
  return expand();
}

function getCompletionInsertText(item: vscode.CompletionItem, context: CompletionContext): string {
  if (getCompletionRole(item) === "argument" && getCompletionLabel(item) === "...") return "...";
  // Value labels are literal R strings, including dollar signs and braces.
  // Quote them for both named and positional insertion before snippet handling.
  if (getCompletionRole(item) === "value" && !item.range) {
    return quoteCompletionValue(getCompletionLabel(item), context.argumentValue?.quote ?? context.bracketQuote);
  }
  let text: string;

  if (typeof item.insertText === "string") {
    text = item.insertText;
  } else if ((typeof item.insertText === "object" && "value" in item.insertText)) {
    text = item.insertText.value;
  } else {
    text = getCompletionLabel(item);
  }

  // The R server builds callable snippets from literal symbol names. Protect
  // those names before expanding tab stops (foo$1 is an R name, not $1).
  const label = getCompletionLabel(item);
  if (isCallableCompletionKind(item.kind) &&
      (text === label || text === `${label}()` || text === `${label}($0)`)) {
    const name = label.startsWith("`") && isCallableName(label) ? escapeRControls(label) : quoteRNameIfNeeded(label);
    return name + (text !== label || context.kind === "package" ? "()" : "");
  }
  const protocolFormat = (item as vscode.CompletionItem & { insertTextFormat?: number }).insertTextFormat;
  const result = (typeof item.insertText === "object" && "value" in item.insertText) || protocolFormat === 2
    ? stripSnippetSyntax(text) : text;
  const role = getCompletionRole(item);
  // Inferred members may supply only a display label. A raw label is not
  // necessarily valid R code: quote $/@ names and escape quoted [[ keys.
  // Preserve explicitly formatted LSP insertion text.
  if (role === "member" && result === label) {
    return getFieldInsertText(label, context);
  }
  if (role === "member" || item.kind === vscode.CompletionItemKind.Field) {
    if (result === label && escapeRControls(label) !== label) {
      return getFieldInsertText(label, context, role === "scope");
    }
    // Some R locales encode even printable characters as Unicode escapes.
    // Build backticked member names from the label so R can parse them.
    if (!context.bracketQuote && result !== label && result.startsWith("`")) {
      if (result.endsWith("`")) return backtickRName(label);
      if (isCallableCompletionKind(item.kind) && result.endsWith("`()")) return backtickRName(label) + "()";
    }
    return escapeRControls(result);
  }
  if (context.kind === "package" && isCallableCompletionKind(item.kind) &&
      isCallableName(result)) return result + "()";
  return result;
}

function getCompletionReplaceStart(
  item: vscode.CompletionItem,
  context: CompletionContext,
  multilineBuffer: string[]
): number {
  const range = item.range;
  if (range) {
    const start = "start" in range ? range.start : range.replacing.start;
    if (start.line === multilineBuffer.length) {
      return start.character;
    }
  }
  return context.replaceStart;
}

function getCompletionReplaceEnd(
  item: vscode.CompletionItem, doc: vscode.TextDocument, position: vscode.Position
): { replaceEnd?: number } {
  if (!item.range) return {};
  const end = "end" in item.range ? item.range.end : item.range.replacing.end;
  if (end.line === position.line) return { replaceEnd: end.character };
  const lines = doc.getText().split("\n");
  if (end.line < position.line || end.line >= lines.length) return {};
  return { replaceEnd: lines.slice(position.line, end.line).reduce((sum, line) => sum + line.length + 1, 0) + end.character };
}
