import * as vscode from "vscode";
import type { CompletionContext, CompletionEntry, WorkspaceData, GlobalEnvItem } from "./types";
import { backtickRName, quoteRNameIfNeeded, getFieldInsertText, bracketFieldMode } from "./candidates";
import { allowsSymbolCompletions } from "./policy";
import { parseRuntimeMemberQuery } from "./runtimeMembers";
import { workspaceStrings } from "../../Runtime/VSCR/workspaceMetadata";

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

export function getSessionCompletions(
  context: CompletionContext,
  data: WorkspaceData | undefined
): CompletionEntry[] {
  if (!data || !data.globalenv) {
    return [];
  }

  if (context.kind === "member" && context.objectName) {
    const receiver = parseRuntimeMemberQuery(context.objectName);
    // Workspace snapshots cannot establish R's current locale for byte escapes.
    if (!receiver || receiver.utf8ByteEscapes || receiver.steps.length || !Object.hasOwn(data.globalenv, receiver.root)) {
      return [];
    }
    const obj = data.globalenv[receiver.root];
    if (!obj) {
      return [];
    }
    const members = context.operator === "@"
      ? workspaceStrings(obj.slots)
      : workspaceStrings(obj.names);
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
  if (!context.dataObjectName || !data?.globalenv) {
    return [];
  }

  const obj = data.globalenv[context.dataObjectName];
  const classes = workspaceStrings(obj?.class);
  const kind = classes?.length === 2 && classes[0] === "data.table" && classes[1] === "data.frame"
    ? "data.table" : classes?.length === 1 && classes[0] === "data.frame" ? "data.frame" : undefined;
  const mode = bracketFieldMode(context, kind);
  if (mode === undefined) return [];
  const bare = context.kind === "bracket" ? mode === "bare" : classes.includes("data.table");
  const names = workspaceStrings(obj?.names);
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
