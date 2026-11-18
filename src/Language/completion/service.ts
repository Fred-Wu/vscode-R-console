import * as vscode from "vscode";
import type { CompletionContext, CompletionEntry, CompletionEntries, CompletionProvider, RuntimeMemberCompletionRequester, WorkspaceData } from "./types";
import { isSessionFunctionCall, getSessionCompletions, getRuntimeMemberCompletions, getRuntimeArgumentCompletions, getDataColumnCompletions, getRuntimeDataColumnCompletions } from "./runtime";
import { getConsoleBufferCompletions } from "./buffer";
import { getLanguageServerCompletions } from "./languageServer";
import { filterCompletionEntries, filterShadowedBufferEntries, filterShadowedWorkspaceEntries, dedupeCompletionEntries, isGlobalSymbolContext, isArgumentCompletionEntry, isCallableCompletionKind } from "./candidates";

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
  const sessionItems = getSessionCompletions(context, sessionData);
  const runtimeArguments = context.kind === "argument" &&
    (context.functionOperator === "$" || context.functionOperator === "@" ||
      (isSessionFunctionCall(context, sessionData) &&
        !(doc && position && completionProvider?.getCallContext?.(doc, position)?.operator)));
  const includeLspItems =
    !!doc && !!position;
  const rawLspItemsRequest =
    !includeLspItems
      ? Promise.resolve({ entries: [] as CompletionEntry[], isIncomplete: false, rConsoleLocalFunction: false, memberResolved: false, nativeArguments: false })
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
  const rawLspResult = await rawLspItemsRequest;
  const nativeMembers = rawLspResult.memberResolved || rawLspResult.entries.some(entry => entry.role === "member");
  const nativeFields = rawLspResult.entries.some(entry => entry.role === "scope" && entry.kind === vscode.CompletionItemKind.Field);
  const useRuntimeArguments = runtimeArguments && !rawLspResult.rConsoleLocalFunction && !rawLspResult.nativeArguments &&
    !rawLspResult.entries.some(entry => entry.role === "argument" && entry.detail !== "parameter");
  // Native results take precedence. Only probe the live session for facts the
  // language server could not infer; a busy R session cannot delay native members.
  const [runtimeMemberItems, columnItems, runtimeArgumentItems] = await Promise.all([
    context.kind === "member" && !nativeMembers
      ? getRuntimeMemberCompletions(context, requestRuntimeMemberCompletions) : Promise.resolve([]),
    !includeColumns || nativeFields ? Promise.resolve([]) : cachedColumnItems.length > 0
      ? Promise.resolve(cachedColumnItems) : getRuntimeDataColumnCompletions(context, requestRuntimeMemberCompletions),
    useRuntimeArguments ? getRuntimeArgumentCompletions(context, requestRuntimeMemberCompletions) : Promise.resolve([]),
  ]);
  // Otherwise, member and user-defined signatures belong to the active session.
  // A same-name package function must not supply unrelated arguments, even
  // when the session cannot currently reply or the function has no formals.
  const rawLspItems = rawLspResult.entries.filter(entry => {
    if (useRuntimeArguments && isArgumentCompletionEntry(entry)) return false;
    if (context.kind === "argument" && !context.argumentTags &&
        (entry.role === "argument" || entry.detail === "parameter")) return false;
    return !context.pipe || isCallableCompletionKind(entry.kind);
  });
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
    ...runtimeMemberItems,
    ...columnItems,
    ...runtimeArgumentItems,
  ]);

  if (context.kind === "bracket") {
    const columnFiltered = filterCompletionEntries(columnItems, context.prefix);
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
    const columnFiltered = filterCompletionEntries(columnItems, context.prefix);
    const bufferFiltered = filterCompletionEntries(fallbackBufferItems, context.prefix);

    return asCompletionEntries(dedupeCompletionEntries([
      ...filterCompletionEntries(runtimeArgumentItems, context.prefix),
      ...(!context.argumentValue?.quote ? columnFiltered : []),
      ...lspFiltered,
      ...(!context.argumentValue?.quote ? [...sessionFiltered, ...bufferFiltered] : []),
    ]), rawLspResult.isIncomplete);
  }

  if (context.kind === "member") {
    if (nativeMembers) return asCompletionEntries(filterCompletionEntries(lspItems, context.prefix), rawLspResult.isIncomplete);
    const runtimeFiltered = filterCompletionEntries(runtimeMemberItems, context.prefix);
    const sessionFiltered = filterCompletionEntries(sessionItems, context.prefix);
    const bufferFiltered = filterCompletionEntries(fallbackBufferItems, context.prefix);
    if (context.chainedBracket && bufferFiltered.length > 0) {
      return asCompletionEntries(
        dedupeCompletionEntries([...runtimeFiltered, ...sessionFiltered, ...bufferFiltered]),
        rawLspResult.isIncomplete
      );
    }
    if (runtimeFiltered.length > 0) {
      return asCompletionEntries(
        dedupeCompletionEntries(runtimeFiltered),
        rawLspResult.isIncomplete
      );
    }
    return asCompletionEntries(
      dedupeCompletionEntries([...sessionFiltered, ...bufferFiltered]),
      rawLspResult.isIncomplete
    );
  }

  const defaultColumnFiltered = filterCompletionEntries(columnItems, context.prefix);

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

