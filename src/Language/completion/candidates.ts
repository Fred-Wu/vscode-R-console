import * as vscode from "vscode";
import type { CompletionContext, CompletionEntry } from "./types";
import { completionMatch } from "../completionMatch";

const R_SYNTACTIC_NAME_PATTERN = /^(?:[a-zA-Z]|\.(?![0-9]))[a-zA-Z0-9._]*$/;
export const R_RESERVED_WORDS = new Set([
  "if",
  "else",
  "repeat",
  "while",
  "function",
  "for",
  "in",
  "next",
  "break",
  "TRUE",
  "FALSE",
  "NULL",
  "Inf",
  "NaN",
  "NA",
  "NA_integer_",
  "NA_real_",
  "NA_complex_",
  "NA_character_",
]);

// R backticked names accept byte escapes but reject Unicode escapes.
export function escapeRControls(text: string): string {
  return text.replace(/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu, char => {
    if (char === "\r") return "\\r";
    if (char === "\n") return "\\n";
    if (char === "\t") return "\\t";
    return Array.from(Buffer.from(char, "utf8"), byte =>
      "\\x" + byte.toString(16).padStart(2, "0")).join("");
  });
}

function escapeRLiteral(value: string, quote: string): string {
  return escapeRControls(value.replaceAll("\\", "\\\\").replaceAll(quote, "\\" + quote));
}

export function backtickRName(name: string): string {
  return "`" + escapeRLiteral(name, "`") + "`";
}

export function quoteRNameIfNeeded(name: string): string {
  if (R_SYNTACTIC_NAME_PATTERN.test(name) && !R_RESERVED_WORDS.has(name)) {
    return name;
  }
  return backtickRName(name);
}

export function getFieldInsertText(name: string, context: CompletionContext, bare = false): string {
  if (context.kind === "bracket" && (context.bracketQuote || context.bracketOperator === "[[" || !bare)) {
    return quoteCompletionValue(name, context.bracketQuote);
  }
  return quoteRNameIfNeeded(name);
}

export function isCallableCompletionKind(kind: vscode.CompletionItemKind | undefined): boolean {
  return kind !== undefined && (
    kind === vscode.CompletionItemKind.Function ||
    kind === vscode.CompletionItemKind.Method ||
    kind === vscode.CompletionItemKind.Constructor
  );
}

export function isArgumentCompletionEntry(entry: CompletionEntry): boolean {
  return (
    entry.role === "argument" || entry.role === "value" || entry.detail === "parameter" ||
    entry.detail?.startsWith("value for ") === true
  );
}

export function isGlobalSymbolContext(context: CompletionContext): boolean {
  return context.kind === "default" || context.kind === "argument";
}

export function quoteCompletionValue(value: string, existingQuote?: "\"" | "'"): string {
  const quote = existingQuote ?? '"';
  const escaped = escapeRLiteral(value, quote);
  return existingQuote ? escaped : quote + escaped + quote;
}

export function filterCompletionEntries(
  entries: CompletionEntry[],
  prefix: string
): CompletionEntry[] {
  const normalizedPrefix = prefix.toLowerCase();
  const result: CompletionEntry[] = [];
  for (const entry of entries) {
    const label = entry.label;
    if (normalizedPrefix && !completionMatch(label, normalizedPrefix)) {
      continue;
    }
    result.push(entry);
  }
  return result;
}

export function filterShadowedBufferEntries(
  bufferEntries: CompletionEntry[],
  preferredEntries: CompletionEntry[]
): CompletionEntry[] {
  if (bufferEntries.length === 0 || preferredEntries.length === 0) {
    return bufferEntries;
  }

  const preferredKeys = new Set(
    preferredEntries
      .filter((entry) => entry.source !== "buffer")
      .map(entry => entry.label)
  );

  return bufferEntries.filter(
    (entry) => !preferredKeys.has(entry.label)
  );
}

export function filterShadowedWorkspaceEntries(
  entries: CompletionEntry[],
  workspaceEntries: CompletionEntry[],
  preserveEntry?: (entry: CompletionEntry) => boolean
): CompletionEntry[] {
  if (entries.length === 0 || workspaceEntries.length === 0) {
    return entries;
  }

  const workspaceLabels = new Set(
    workspaceEntries.map(getCompletionIdentityKey)
  );

  return entries.filter((entry) => {
    if (preserveEntry?.(entry)) {
      return true;
    }
    return !workspaceLabels.has(getCompletionIdentityKey(entry));
  });
}

export function dedupeCompletionEntries(
  entries: CompletionEntry[]
): CompletionEntry[] {
  const seen = new Set<string>();
  const result: CompletionEntry[] = [];
  for (const entry of entries) {
    const key = getCompletionIdentityKey(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function getCompletionIdentityKey(entry: CompletionEntry): string {
  return [
    entry.label,
    entry.detail ?? "",
    getCompletionDescription(entry),
  ].join("\u0000");
}

export function getCompletionDescription(entry: CompletionEntry): string {
  if (entry.source === "buffer") {
    return "";
  }
  const kindName = getCompletionKindName(entry.kind);
  return kindName || "";
}

function getCompletionKindName(kind?: vscode.CompletionItemKind): string {
  switch (kind) {
    case vscode.CompletionItemKind.Function:
      return "function";
    case vscode.CompletionItemKind.Method:
      return "method";
    case vscode.CompletionItemKind.Variable:
      return "variable";
    case vscode.CompletionItemKind.Field:
      return "field";
    case vscode.CompletionItemKind.Property:
      return "property";
    case vscode.CompletionItemKind.Module:
      return "module";
    case vscode.CompletionItemKind.Class:
      return "class";
    case vscode.CompletionItemKind.Interface:
      return "interface";
    case vscode.CompletionItemKind.Enum:
      return "enum";
    case vscode.CompletionItemKind.Constant:
      return "constant";
    case vscode.CompletionItemKind.Keyword:
      return "keyword";
    case vscode.CompletionItemKind.Operator:
      return "operator";
    case vscode.CompletionItemKind.Snippet:
      return "snippet";
    case vscode.CompletionItemKind.Value:
      return "value";
    case vscode.CompletionItemKind.Unit:
      return "unit";
    case vscode.CompletionItemKind.Text:
      return "text";
    default:
      return "";
  }
}

