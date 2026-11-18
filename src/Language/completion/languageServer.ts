import * as vscode from "vscode";
import type { CompletionContext, CompletionEntry, CompletionProvider } from "./types";
import { completionMatch } from "../completionMatch";
import { isCallableName } from "./contextParser";
import { quoteRNameIfNeeded, quoteCompletionValue, isCallableCompletionKind } from "./candidates";

export async function getLanguageServerCompletions(
  context: CompletionContext,
  doc: vscode.TextDocument,
  position: vscode.Position,
  multilineBuffer: string[],
  completionProvider?: CompletionProvider
): Promise<{ entries: CompletionEntry[]; isIncomplete: boolean; rConsoleLocalFunction?: boolean; memberResolved?: boolean; nativeArguments?: boolean }> {
  if (!completionProvider) {
    return { entries: [], isIncomplete: false };
  }
  try {
    let result = await completionProvider.provideCompletionItems(
      doc,
      position,
      context.triggerCharacter
    );
    let localFunction = result?.rConsoleLocalFunction === true;
    let memberResolved = result?.rConsoleMemberResolved === true;
    let nativeArguments = result?.rConsoleNativeArguments === true;

    let items = Array.isArray(result) ? result : result?.items || [];
    const usable = (item: vscode.CompletionItem): boolean => isLanguageServerCompletionItem(context, item, doc.uri?.toString());
    // Some R language servers only return contiguous matches. If that lookup
    // has no usable candidates, request at the first prefix character and
    // apply our matcher to the returned candidates. Keep the real document and
    // its replacement start intact; never rewrite code to manufacture results.
    if (context.prefix.length > 1 && !memberResolved &&
        !items.some(item => usable(item) &&
          completionMatch(getCompletionLabel(item), context.prefix))) {
      const firstCharacter = [...context.prefix][0];
      result = await completionProvider.provideCompletionItems(doc,
        new vscode.Position(position.line, context.replaceStart + firstCharacter.length),
        context.triggerCharacter, position);
      localFunction ||= result?.rConsoleLocalFunction === true;
      memberResolved ||= result?.rConsoleMemberResolved === true;
      nativeArguments ||= result?.rConsoleNativeArguments === true;
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
        source: "lsp",
        replaceStart: getCompletionReplaceStart(item, context, multilineBuffer),
        ...getCompletionReplaceEnd(item, doc, position),
        packageName: getCompletionPackage(item),
      })),
      isIncomplete: !Array.isArray(result) && result?.isIncomplete === true,
      rConsoleLocalFunction: localFunction,
      memberResolved,
      nativeArguments,
    };
  } catch {
    return { entries: [], isIncomplete: false };
  }
}

function getCompletionRole(item: vscode.CompletionItem): CompletionEntry["role"] {
  const data = (item as vscode.CompletionItem & { data?: { type?: string; parameter?: string } }).data;
  const type = data?.type;
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

function isLanguageServerCompletionItem(
  context: CompletionContext,
  item: vscode.CompletionItem,
  documentUri?: string
): boolean {
  if (context.pipe && !isCallableCompletionKind(item.kind)) return false;
  if (context.argumentValue?.quote && getCompletionRole(item) !== "value") return false;
  if (context.kind === "member" && getCompletionRole(item) !== "member") return false;
  if (context.bracketQuote && getCompletionRole(item) !== "member" && getCompletionRole(item) !== "value") return false;
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
    const name = label.startsWith("`") && isCallableName(label) ? label : quoteRNameIfNeeded(label);
    return name + (text !== label || context.kind === "package" ? "()" : "");
  }
  const protocolFormat = (item as vscode.CompletionItem & { insertTextFormat?: number }).insertTextFormat;
  const result = (typeof item.insertText === "object" && "value" in item.insertText) || protocolFormat === 2
    ? stripSnippetSyntax(text) : text;
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

