import * as vscode from "vscode";
import type { CompletionContext, CompletionEntry } from "./types";
import { completionMatch } from "../completionMatch";
import { decodeRArgumentName } from "./runtimeMembers";
import { quoteCompletionValue, quoteRNameIfNeeded } from "./rText";

export function getFieldInsertText(name: string, context: CompletionContext, bare = false): string {
  if (context.kind === "bracket" && (context.bracketQuote || context.bracketOperator === "[[" || !bare)) {
    return quoteCompletionValue(name, context.bracketQuote);
  }
  return quoteRNameIfNeeded(name);
}

/** Stored columns are valid only in index/column arguments, not every option
 * of an indexing method. Unknown named arguments conservatively get no fields.
 * Keep this policy shared by fresh inspection and cached workspace metadata. */
export function bracketFieldMode(
  context: CompletionContext, kind?: "data.frame" | "data.table"
): "bare" | "quoted" | undefined {
  if (context.kind !== "bracket") return "quoted";
  const spelling = context.bracketArgumentName;
  const name = spelling === undefined ? undefined : decodeRArgumentName(spelling);
  if (spelling !== undefined) {
    if (context.bracketOperator !== "[") return undefined;
    if (kind === "data.table") {
      if (name === "i" || name === "j" || name === "by" || name === "keyby") return "bare";
      if (name === ".SDcols" || name === "on") return "quoted";
      return undefined;
    }
    // [.data.frame uses i for one-index column selection. In two-index
    // selection i names rows and j names columns, even when tags are reordered.
    const twoDimensions = (context.bracketDimensions ?? 1) > 1;
    return kind === "data.frame" && name === (twoDimensions ? "j" : "i") ? "quoted" : undefined;
  }
  if (context.bracketOperator === "[" && kind !== "data.table" &&
      (context.bracketDimensions ?? 1) > 1 && context.bracketDimension !== 1) return undefined;
  return context.bracketOperator === "[" && kind === "data.table" ? "bare" : "quoted";
}

export function isCallableCompletionKind(kind: vscode.CompletionItemKind | undefined): boolean {
  return kind !== undefined && (
    kind === vscode.CompletionItemKind.Function ||
    kind === vscode.CompletionItemKind.Method ||
    kind === vscode.CompletionItemKind.Constructor
  );
}

export function isArgumentCompletionEntry(entry: CompletionEntry): boolean {
  if (entry.role !== undefined) return entry.role === "argument" || entry.role === "value";
  return (
    entry.detail === "parameter" || entry.detail?.startsWith("value for ") === true
  );
}

export function isGlobalSymbolContext(context: CompletionContext): boolean {
  return context.kind === "default" || context.kind === "argument";
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
  const workspaceNames = new Set(workspaceEntries.map(entry => entry.label));

  return entries.filter((entry) => {
    if (preserveEntry?.(entry)) {
      return true;
    }
    if (entry.detail === "[workspace]" && workspaceNames.has(entry.label)) return false;
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

