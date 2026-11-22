import * as vscode from "vscode";
import type { CompletionContext, CompletionEntry, CompletionEntries, CompletionProvider, RuntimeMemberCompletionRequester, WorkspaceData } from "./types";
import { isSessionFunctionCall, getSessionCompletions, getDataColumnCompletions } from "./runtime";
import { getConsoleBufferCompletions } from "./buffer";
import { getLanguageServerCompletions } from "./languageServer";
import { parseRuntimeMemberQuery } from "./runtimeMembers";
import { getFieldInsertText, filterCompletionEntries, filterShadowedBufferEntries, filterShadowedWorkspaceEntries, dedupeCompletionEntries, isGlobalSymbolContext, isArgumentCompletionEntry } from "./candidates";

export async function collectCompletionEntries(
  context: CompletionContext,
  doc: vscode.TextDocument | undefined,
  position: vscode.Position | undefined,
  sessionData: WorkspaceData | undefined,
  multilineBuffer: string[],
  recentConsoleEntries: string[] = [],
  completionProvider?: CompletionProvider,
  requestRuntimeMemberCompletions?: RuntimeMemberCompletionRequester,
  consoleInputText?: string
): Promise<CompletionEntries> {
  if (context.rejectionReason || context.suppressAutomatic) return [];
  const sessionItems = getSessionCompletions(context, sessionData);
  const sessionArguments = context.kind === "argument" && isSessionFunctionCall(context, sessionData) &&
    !(doc && position && completionProvider?.getCallContext?.(doc, position)?.operator);
  const memberArguments = context.kind === "argument" &&
    (context.functionOperator === "$" || context.functionOperator === "@");
  const includeLspItems =
    !!doc && !!position;
  const rawLspItemsRequest =
    !includeLspItems
      ? Promise.resolve({ entries: [] as CompletionEntry[], isIncomplete: false, rConsoleLocalFunction: false, runtimeOnly: false, memberResolved: false, workspaceFunction: false, nativeArguments: false, argumentsExhausted: false })
      : getLanguageServerCompletions(
          context,
          doc,
          position,
          multilineBuffer,
          completionProvider
        );
  const bufferItems = getConsoleBufferCompletions(
    context,
    consoleInputText ?? doc?.getText() ?? "",
    recentConsoleEntries
  );
  // Quoted argument values accept only declared values. A live column probe
  // cannot contribute here and may wait on an unrelated busy R session.
  const includeColumns = context.kind !== "member" && !context.argumentValue?.quote;
  const cachedColumnItems = includeColumns ? getDataColumnCompletions(context, sessionData) : [];
  const runtimeReceiver = !!context.objectName && parseRuntimeMemberQuery(context.objectName) !== undefined;
  const rawLspResult = await rawLspItemsRequest;
  const inferred = rawLspResult.memberResolved ||
    rawLspResult.entries.some(entry => entry.role === "member");
  const runtimeRequest = runtimeReceiver &&
    (context.kind === "member" || (context.kind === "bracket" && context.bracketOperator === "[[")) &&
    (rawLspResult.runtimeOnly || !inferred)
    ? requestRuntimeMemberCompletions?.(context.objectName!,
        context.kind === "bracket" ? context.bracketOperator ?? "[" : context.operator ?? "$")
    : undefined;
  const runtimeResult = await Promise.resolve(runtimeRequest).catch(() => undefined);
  const runtimeNames = runtimeResult?.status === "available" ? runtimeResult.names : undefined;
  const runtimeKinds = runtimeResult?.status === "available" ? runtimeResult.kinds : undefined;
  const runtimeMembers = runtimeNames?.map((name, index) => {
    const kind = runtimeKinds?.[index] === 1 ? vscode.CompletionItemKind.Function
      : runtimeKinds?.[index] === 2 ? vscode.CompletionItemKind.Property
      : vscode.CompletionItemKind.Field;
    return {
      label: name,
      insertText: getFieldInsertText(name, context) +
        (kind === vscode.CompletionItemKind.Function && context.kind === "member" ? "()" : ""),
      kind,
      detail: context.objectName,
      source: "session" as const,
    };
  });
  const runtimeOnly = rawLspResult.runtimeOnly === true;
  const nativeMembers = !runtimeOnly &&
    (rawLspResult.memberResolved || rawLspResult.entries.some(entry => entry.role === "member"));
  const nativeFields = rawLspResult.entries.some(entry => entry.role === "scope" && entry.kind === vscode.CompletionItemKind.Field);
  // A package-inferred exhaustion must not override an unresolved live member.
  if (context.argumentTags && rawLspResult.argumentsExhausted &&
      !(runtimeOnly && memberArguments && !rawLspResult.workspaceFunction)) return [];
  const dataItems = runtimeMembers !== undefined && context.kind === "bracket" ? runtimeMembers :
    !includeColumns || nativeFields ||
    (context.kind === "bracket" && rawLspResult.memberResolved) ? [] : cachedColumnItems;
  if (context.kind === "member") {
    const entries = runtimeMembers !== undefined ? runtimeMembers : runtimeOnly ? sessionItems
      : nativeMembers ? rawLspResult.entries : sessionItems;
    return asCompletionEntries(dedupeCompletionEntries(filterCompletionEntries(entries, context.prefix)),
      rawLspResult.isIncomplete);
  }
  const unavailableSignature = (runtimeOnly && memberArguments && !rawLspResult.workspaceFunction) ||
    (!rawLspResult.rConsoleLocalFunction && !rawLspResult.workspaceFunction &&
    (sessionArguments || (memberArguments && !rawLspResult.nativeArguments &&
      !rawLspResult.entries.some(entry => entry.role === "argument" && entry.detail !== "parameter"))));
  const rawLspItems = unavailableSignature
    ? rawLspResult.entries.filter(entry => !isArgumentCompletionEntry(entry))
    : rawLspResult.entries;
  const lspItems =
    isGlobalSymbolContext(context)
      ? filterShadowedWorkspaceEntries(
          rawLspItems,
          sessionItems,
          context.kind === "argument" ? isArgumentCompletionEntry : undefined
        )
      : rawLspItems;
  const fallbackBufferItems = filterShadowedBufferEntries(bufferItems, [
    ...lspItems,
    ...sessionItems,
    ...dataItems,
  ]);

  if (context.kind === "bracket") {
    const columnFiltered = filterCompletionEntries(dataItems, context.prefix);
    const lspFiltered = filterCompletionEntries(lspItems, context.prefix);
    const sessionFiltered = filterCompletionEntries(sessionItems, context.prefix);
    const bufferFiltered = filterCompletionEntries(fallbackBufferItems, context.prefix);
    return asCompletionEntries(dedupeCompletionEntries([
      ...lspFiltered,
      ...columnFiltered,
      ...(!context.bracketQuote ? [...sessionFiltered, ...bufferFiltered] : []),
    ]), rawLspResult.isIncomplete);
  }

  if (context.kind === "argument") {
    const lspFiltered = filterCompletionEntries(lspItems, context.prefix);
    const sessionFiltered = filterCompletionEntries(sessionItems, context.prefix);
    const columnFiltered = filterCompletionEntries(dataItems, context.prefix);
    const bufferFiltered = filterCompletionEntries(fallbackBufferItems, context.prefix);

    return asCompletionEntries(dedupeCompletionEntries([
      ...(!context.argumentValue?.quote ? columnFiltered : []),
      ...lspFiltered,
      ...(!context.argumentValue?.quote ? [...sessionFiltered, ...bufferFiltered] : []),
    ]), rawLspResult.isIncomplete);
  }

  const defaultColumnFiltered = filterCompletionEntries(dataItems, context.prefix);

  return asCompletionEntries(dedupeCompletionEntries(filterCompletionEntries(
    [
      ...defaultColumnFiltered,
      ...lspItems,
      ...sessionItems,
      ...(!context.pipe ? fallbackBufferItems : []),
    ],
    context.prefix
  )), rawLspResult.isIncomplete);
}

function asCompletionEntries(
  entries: CompletionEntry[],
  isIncomplete: boolean
): CompletionEntries {
  const result = entries as CompletionEntries;
  if (isIncomplete) {
    result.isIncomplete = true;
  }
  return result;
}

