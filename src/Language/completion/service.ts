import * as vscode from "vscode";
import type { SessionCompletionInspector } from "../../Runtime/VSCR/types";
import type { CompletionContext, CompletionEntry, CompletionEntries, CompletionProvider, RuntimeMemberCompletionRequester, WorkspaceData } from "./types";
import { isSessionFunctionCall, getSessionCompletions, getRuntimeMemberCompletions, getDataColumnCompletions, getRuntimeDataCompletions, hasTruncatedColumnNames } from "./runtime";
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
  consoleInputText?: string,
  inspectRuntimeCompletion?: SessionCompletionInspector
): Promise<CompletionEntries> {
  if (context.suppressAutomatic) return [];
  const sessionItems = getSessionCompletions(context, sessionData);
  const sessionArguments = context.kind === "argument" && isSessionFunctionCall(context, sessionData) &&
    !(doc && position && completionProvider?.getCallContext?.(doc, position)?.operator);
  const memberArguments = context.kind === "argument" &&
    (context.functionOperator === "$" || context.functionOperator === "@");
  const includeLspItems =
    !!doc && !!position;
  const rawLspItemsRequest =
    !includeLspItems
      ? Promise.resolve({ entries: [] as CompletionEntry[], isIncomplete: false, rConsoleLocalFunction: false, memberResolved: false, workspaceFunction: false, nativeArguments: false, argumentsExhausted: false })
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
  const truncatedColumnNames = cachedColumnItems.length > 0 && hasTruncatedColumnNames(context, sessionData);
  const rawLspResult = await rawLspItemsRequest;
  const runtimeOnly = rawLspResult.runtimeOnly === true;
  const nativeMembers = !runtimeOnly &&
    (rawLspResult.memberResolved || rawLspResult.entries.some(entry => entry.role === "member"));
  const nativeFields = rawLspResult.entries.some(entry => entry.role === "scope" && entry.kind === vscode.CompletionItemKind.Field);
  // A package-inferred exhaustion must not override an unresolved live member.
  if (context.argumentTags && rawLspResult.argumentsExhausted &&
      !(runtimeOnly && memberArguments && !rawLspResult.workspaceFunction)) return [];
  const [runtimeMemberItems, dataItems] = await Promise.all([
    context.kind === "member" && !nativeMembers
      ? getRuntimeMemberCompletions(context, requestRuntimeMemberCompletions, inspectRuntimeCompletion) : Promise.resolve(undefined),
    !includeColumns || nativeFields || (context.kind === "bracket" && rawLspResult.memberResolved) ? Promise.resolve([]) :
      cachedColumnItems.length > 0 && !truncatedColumnNames ? Promise.resolve(cachedColumnItems) :
      getRuntimeDataCompletions(context, requestRuntimeMemberCompletions,
        inspectRuntimeCompletion, truncatedColumnNames).then(items =>
        items.columnsResolved || !cachedColumnItems.length ? items : cachedColumnItems),
  ]);
  const columnsIncomplete = (dataItems as CompletionEntries).isIncomplete === true;
  if (context.kind === "member") {
    // A successful live lookup is authoritative even when it is empty or no
    // name matches. Cached fields are only a fallback for an unavailable probe.
    const entries = runtimeOnly
      ? runtimeMemberItems ?? (sessionItems.length ? sessionItems : rawLspResult.entries)
      : nativeMembers ? rawLspResult.entries : runtimeMemberItems ?? sessionItems;
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
    ]), rawLspResult.isIncomplete || columnsIncomplete);
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
    ]), rawLspResult.isIncomplete || columnsIncomplete);
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
  )), rawLspResult.isIncomplete || columnsIncomplete);
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

