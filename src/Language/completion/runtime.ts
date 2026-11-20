import * as vscode from "vscode";
import type { CompletionContext, CompletionEntry, WorkspaceData, GlobalEnvItem } from "./types";
import { backtickRName, quoteRNameIfNeeded, getFieldInsertText } from "./candidates";
import { allowsSymbolCompletions } from "./policy";

function isSessionFunction(item: GlobalEnvItem): boolean {
  return item.type === "closure" || item.type === "builtin" || item.type === "special" ||
    /^\s*function\s*\(/.test(item.str || "");
}

export function isSessionFunctionCall(context: CompletionContext, data: WorkspaceData | undefined): boolean {
  if (context.functionOperator || !context.functionName) return false;
  const globals = data?.globalenv;
  if (!globals) return false;
  if (Object.hasOwn(globals, context.functionName)) return isSessionFunction(globals[context.functionName]);
  if (!context.functionName.startsWith("`")) return false;
  return Object.entries(globals).some(([name, item]) => isSessionFunction(item) &&
    (context.functionName === name ||
      context.functionName === backtickRName(name)));
}

const TOP_LEVEL_SYMBOL_PATTERN = /^[a-zA-Z._][a-zA-Z0-9._]*$/;
export function getSessionCompletions(
  context: CompletionContext,
  data: WorkspaceData | undefined
): CompletionEntry[] {
  if (!data || !data.globalenv) {
    return [];
  }

  if (context.kind === "member" && context.objectName) {
    if (!TOP_LEVEL_SYMBOL_PATTERN.test(context.objectName)) {
      return [];
    }
    const obj = data.globalenv[context.objectName];
    if (!obj) {
      return [];
    }
    const members = context.operator === "@"
      ? asStringArray(obj.slots)
      : asStringArray(obj.names);
    return members.map((name) => ({
      label: name,
      insertText: getFieldInsertText(name, context),
      kind: vscode.CompletionItemKind.Field,
      detail: context.objectName,
      source: "session",
    }));
  }

  if (!allowsSymbolCompletions(context)) {
    return [];
  }

  return Object.entries(data.globalenv).flatMap(([name, obj]) => {
    const isFunction = isSessionFunction(obj);
    if (context.pipe && !isFunction) return [];
    return [{
      label: name,
      insertText: quoteRNameIfNeeded(name) + (isFunction ? "()" : ""),
      kind: isFunction
        ? vscode.CompletionItemKind.Function
        : vscode.CompletionItemKind.Variable,
      detail: "session",
      source: "session" as const,
    }];
  });
}

export function getDataColumnCompletions(
  context: CompletionContext,
  data: WorkspaceData | undefined
): CompletionEntry[] {
  if (!context.dataObjectName || !data?.globalenv || context.bracketArgumentName) {
    return [];
  }

  const obj = data.globalenv[context.dataObjectName];
  const bare = obj?.class?.includes("data.table") === true;
  if (context.kind === "bracket" && !bare && (context.bracketDimensions ?? 1) > 1 &&
      context.bracketDimension !== 1) return [];
  const names = asStringArray(obj?.names);
  if (names.length === 0) {
    return [];
  }

  return names.map((name) => ({
    label: name,
    insertText: getFieldInsertText(name, context, bare),
    kind: vscode.CompletionItemKind.Field,
    detail: context.dataObjectName,
    source: "session" as const,
  }));
}

function asStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.filter((item) => item.length > 0);
  }
  return value ? [value] : [];
}
