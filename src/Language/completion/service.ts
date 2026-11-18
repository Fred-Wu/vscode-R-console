import * as vscode from "vscode";
import type { CompletionContext, CompletionEntry, CompletionEntries, CompletionProvider, RuntimeMemberCompletionRequester, WorkspaceData } from "./types";
import { isSessionFunctionCall, getSessionCompletions, getRuntimeMemberCompletions, getRuntimeArgumentCompletions, getDataColumnCompletions, getRuntimeDataCompletions } from "./runtime";
import { getConsoleBufferCompletions } from "./buffer";
import { getLanguageServerCompletions } from "./languageServer";
import { filterCompletionEntries, filterShadowedBufferEntries, filterShadowedWorkspaceEntries, dedupeCompletionEntries, isGlobalSymbolContext, isArgumentCompletionEntry } from "./candidates";

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
  if (context.suppressAutomatic) return [];
  const sessionItems = getSessionCompletions(context, sessionData);
  const runtimeArguments = context.kind === "argument" &&
    (context.functionOperator === "$" || context.functionOperator === "@" ||
      (isSessionFunctionCall(context, sessionData) &&
        !(doc && position && completionProvider?.getCallContext?.(doc, position)?.operator)));
  const includeLspItems =
    !!doc && !!position;
  const rawLspItemsRequest =
    !includeLspItems
      ? Promise.resolve({ entries: [] as CompletionEntry[], isIncomplete: false, rConsoleLocalFunction: false, memberResolved: false, nativeArguments: false, argumentsExhausted: false })
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
  if (context.argumentTags && rawLspResult.argumentsExhausted && !useRuntimeArguments) return [];
  // Native results take precedence. Only probe the live session for facts the
  // language server could not infer; a busy R session cannot delay native members.
  const probeSubscript = context.kind === "bracket" && !context.bracketQuote &&
    !context.bracketArgumentName && !!requestRuntimeMemberCompletions;
  const [runtimeMemberItems, runtimeDataItems, runtimeArgumentItems] = await Promise.all([
    context.kind === "member" && !nativeMembers
      ? getRuntimeMemberCompletions(context, requestRuntimeMemberCompletions) : Promise.resolve(undefined),
    probeSubscript ? getRuntimeDataCompletions(context, requestRuntimeMemberCompletions) :
    !includeColumns || nativeFields ? Promise.resolve([]) : cachedColumnItems.length > 0
      ? Promise.resolve(cachedColumnItems) : getRuntimeDataCompletions(context, requestRuntimeMemberCompletions),
    useRuntimeArguments ? getRuntimeArgumentCompletions(context, requestRuntimeMemberCompletions) : Promise.resolve([] as CompletionEntries),
  ]);
  if (context.kind === "member") {
    // A successful live lookup is authoritative even when it is empty or no
    // name matches. Cached fields are only a fallback for an unavailable probe.
    const entries = nativeMembers ? rawLspResult.entries : runtimeMemberItems ?? sessionItems;
    return asCompletionEntries(dedupeCompletionEntries(filterCompletionEntries(entries, context.prefix)),
      rawLspResult.isIncomplete);
  }
  const resolvedDataItems = probeSubscript && !(runtimeDataItems as CompletionEntries).subscriptResolved
    ? cachedColumnItems : runtimeDataItems;
  const dataItems = nativeFields ? resolvedDataItems.filter(entry => entry.kind !== vscode.CompletionItemKind.Field) : resolvedDataItems;
  if (runtimeArgumentItems.argumentsExhausted) return [];
  // Otherwise, member and user-defined signatures belong to the active session.
  // A same-name package function must not supply unrelated arguments, even
  // when the session cannot currently reply or the function has no formals.
  const rawLspItems = useRuntimeArguments
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
    ...runtimeArgumentItems,
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
      ...filterCompletionEntries(runtimeArgumentItems, context.prefix),
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

