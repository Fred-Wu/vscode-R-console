import * as vscode from "vscode";
import type { CompletionAnalysisMode, CompletionContext, CompletionEntry, CompletionEntries, CompletionProvider, CompletionSourceDefinition, RuntimeMemberCompletionRequester, WorkspaceData } from "./types";
import { isSessionFunctionCall, getSessionCompletions, getDataColumnCompletions } from "./runtime";
import { getConsoleBufferCompletions } from "./buffer";
import { getLanguageServerCompletions } from "./languageServer";
import { parseRuntimeMemberQuery } from "./runtimeMembers";
import type { MemberInspectionResult } from "../../Runtime/backendProtocol";
import { workspaceStrings } from "../../Runtime/VSCR/workspaceMetadata";
import { bracketFieldMode, getFieldInsertText, filterCompletionEntries, filterShadowedBufferEntries, filterShadowedWorkspaceEntries, dedupeCompletionEntries, isGlobalSymbolContext, isArgumentCompletionEntry } from "./candidates";

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
  prefetchedBracketMembers?: Promise<MemberInspectionResult | undefined>,
  analysisMode?: CompletionAnalysisMode
): Promise<CompletionEntries> {
  if (context.rejectionReason || context.suppressAutomatic) return [];
  const sessionItems = getSessionCompletions(context, sessionData);
  const sessionArguments = context.kind === "argument" && isSessionFunctionCall(context, sessionData) &&
    !(doc && position && completionProvider?.getCallContext?.(doc, position)?.operator);
  const memberArguments = context.kind === "argument" &&
    (context.functionOperator === "$" || context.functionOperator === "@");
  const includeLspItems =
    !!doc && !!position;
  // The bracket inspector starts independently of LSP startup. Its confirmed
  // receiver class is authoritative when sess workspace metadata is missing;
  // only await the bounded prefetched result on the final LSP-enriched pass.
  const prefetchedResult = context.kind === "bracket" && prefetchedBracketMembers
    ? await Promise.resolve(prefetchedBracketMembers).catch(() => undefined)
    : undefined;
  const runtimeBracketKind = context.kind === "bracket" && context.bracketOperator === "[" &&
    prefetchedResult?.status === "available" ? prefetchedResult.bracketKind ?? null :
    prefetchedResult?.status === "suppressed" ? null : undefined;
  const rawLspItemsRequest =
    !includeLspItems
      ? Promise.resolve({ entries: [] as CompletionEntry[], isIncomplete: false, rConsoleLocalFunction: false, runtimeOnly: false, memberResolved: false, workspaceFunction: false, nativeArguments: false, argumentsExhausted: false })
      : getLanguageServerCompletions(
          context,
          doc,
          position,
          multilineBuffer,
          completionProvider,
          runtimeBracketKind,
          analysisMode
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
  const runtimeQuery = context.objectName ? parseRuntimeMemberQuery(context.objectName) : undefined;
  const runtimeReceiver = runtimeQuery !== undefined;
  const rawLspResult = await rawLspItemsRequest;
  const inferred = rawLspResult.memberResolved ||
    rawLspResult.entries.some(entry => entry.role === "member");
  // Bracket requests can start native inspection while the language server
  // starts. Keep its parameter candidates, and avoid a second native probe.
  const shouldInspectRuntime = runtimeReceiver &&
    (context.kind === "member" || context.kind === "bracket") &&
    (rawLspResult.runtimeOnly || !inferred);
  const runtimeRequested = prefetchedBracketMembers !== undefined ||
    (shouldInspectRuntime && requestRuntimeMemberCompletions !== undefined);
  const runtimeRequest = prefetchedBracketMembers ?? (shouldInspectRuntime
    ? requestRuntimeMemberCompletions?.(context.objectName!,
        context.kind === "bracket" ? context.bracketOperator ?? "[" : context.operator ?? "$")
    : undefined);
  const runtimeResult = await Promise.resolve(runtimeRequest).catch(() => undefined);
  // A definitive safety refusal must not be undone by cached receiver names
  // or package method suggestions. In particular, a masked accessor need not
  // accept the stored object's members or the installed method's arguments.
  // A confirmed absent root is authoritative for runtime candidates too.
  // Cached workspace names must not revive a binding missing from live R.
  if (runtimeResult?.status === "missing") return asCompletionEntries([], false);
  const runtimeSuppressed = runtimeResult?.status === "suppressed";
  if (runtimeSuppressed && context.kind === "member") return [];
  // An unavailable inspection is not a complete member list: later typing
  // must retry instead of refining a cached empty result forever.
  const retryableRuntime = runtimeRequested &&
    runtimeResult?.status !== "available" && !runtimeSuppressed;
  const runtimeNames = runtimeResult?.status === "available" ? runtimeResult.names : runtimeSuppressed ? [] : undefined;
  const runtimeKinds = runtimeResult?.status === "available" ? runtimeResult.kinds : undefined;
  const bracketKind = runtimeResult?.status === "available" ? runtimeResult.bracketKind : undefined;
  const fieldMode = bracketFieldMode(context, bracketKind);
  const runtimeMembers = runtimeNames === undefined ? undefined : fieldMode === undefined ? [] :
    runtimeNames.map((name, index) => {
    const kind = runtimeKinds?.[index] === 1 ? vscode.CompletionItemKind.Function
      : runtimeKinds?.[index] === 2 ? vscode.CompletionItemKind.Property
      : vscode.CompletionItemKind.Field;
    return {
      label: name,
      insertText: getFieldInsertText(name, context, fieldMode === "bare") +
        (kind === vscode.CompletionItemKind.Function && context.kind === "member" ? "()" : ""),
      kind,
      detail: context.objectName,
      source: "session" as const,
    };
  });
  const runtimeOnly = rawLspResult.runtimeOnly === true;
  const nativeMembers = !runtimeOnly &&
    (rawLspResult.memberResolved || rawLspResult.entries.some(entry => entry.role === "member"));
  // Package-specific symbols are not stored receiver columns, so their
  // presence must not suppress cached names when inspection is unavailable.
  const nativeFields = rawLspResult.entries.some(entry =>
    entry.role === "scope" && entry.kind === vscode.CompletionItemKind.Field && !entry.bracketSpecial);
  // A package-inferred exhaustion must not override an unresolved live member.
  if (context.argumentTags && rawLspResult.argumentsExhausted &&
      !(runtimeOnly && memberArguments && !rawLspResult.workspaceFunction)) return [];
  const dataItems = runtimeMembers !== undefined && context.kind === "bracket" ? runtimeMembers :
    !includeColumns || nativeFields ||
    (context.kind === "bracket" && rawLspResult.memberResolved) ? [] : cachedColumnItems;
  if (context.kind === "member") {
    // S4 slots and custom .DollarNames metadata can expose members absent
    // from storage. Retain the published schema without calling its methods.
    // Ordinary storage still uses fresh native names, including empty lists.
    const metadata = runtimeQuery?.steps.length === 0
      ? sessionData?.globalenv?.[runtimeQuery.root] : undefined;
    const classes = workspaceStrings(metadata?.class);
    const ordinaryClass = !classes?.length ||
      (classes.length === 1 && (classes[0] === metadata?.type || classes[0] === "data.frame")) ||
      (classes.length === 2 && classes[0] === "data.table" && classes[1] === "data.frame");
    const cachedSchema = runtimeRequested && sessionItems.length > 0 &&
      (context.operator === "@" || (context.operator === "$" && !ordinaryClass))
      ? sessionItems.map(item => runtimeMembers?.find(member => member.label === item.label) ?? item)
      : undefined;
    const entries = cachedSchema ?? (runtimeMembers !== undefined ? runtimeMembers : runtimeOnly ? sessionItems
      : nativeMembers ? rawLspResult.entries : sessionItems);
    return asCompletionEntries(dedupeCompletionEntries(filterCompletionEntries(entries, context.prefix)),
      rawLspResult.isIncomplete || retryableRuntime);
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
    // Guarded storage wins for receiver columns. Preserve unrelated installed
    // package symbols and indexing-method arguments, without resurrecting
    // fields inferred from unsubmitted source in runtime-only mode.
    const nativeLabels = new Set(runtimeMembers?.map(entry => entry.label) ?? []);
    const specialLabels = new Set(lspItems.filter(entry => entry.bracketSpecial).map(entry => entry.label));
    const bracketLspItems = lspItems.filter(entry =>
      // Independent index variables remain useful; method arguments and
      // package specials are tied to the unverified receiver/accessor.
      (!runtimeSuppressed || (!entry.bracketSpecial && !isArgumentCompletionEntry(entry))) &&
      (entry.bracketSpecial || !specialLabels.has(entry.label)) &&
      (runtimeMembers === undefined || (
        entry.role !== "member" &&
        !(entry.role === "scope" && entry.kind === vscode.CompletionItemKind.Field && !entry.bracketSpecial) &&
        (!nativeLabels.has(entry.label) || isArgumentCompletionEntry(entry))
      )));
    const lspFiltered = filterCompletionEntries(bracketLspItems, context.prefix);
    const sessionFiltered = filterCompletionEntries(sessionItems, context.prefix);
    const bufferFiltered = filterCompletionEntries(fallbackBufferItems, context.prefix);
    return asCompletionEntries(dedupeCompletionEntries([
      ...lspFiltered,
      ...columnFiltered,
      ...(!context.bracketQuote ? [...sessionFiltered, ...bufferFiltered] : []),
    ]), rawLspResult.isIncomplete || retryableRuntime);
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


// Static fallback is an isolated source of receiver members. Do not merge
// unverified session names, global symbols, or buffered text after a native
// safety refusal; those could masquerade as members of an unsafe receiver.
export async function collectStaticFallbackEntries(
  context: CompletionContext,
  doc: vscode.TextDocument,
  position: vscode.Position,
  multilineBuffer: string[],
  completionProvider: CompletionProvider,
  sourceDefinition?: CompletionSourceDefinition
): Promise<CompletionEntries> {
  if (context.suppressAutomatic || (context.kind !== "member" && context.kind !== "bracket")) {
    return [];
  }
  const result = await getLanguageServerCompletions(
    context, doc, position, multilineBuffer, completionProvider, undefined, "static", sourceDefinition
  );
  // Only a receiver-specific member has sufficiently strong provenance.
  // Lexical scope fields and indexing parameters are not verified receiver
  // members, even when they are labeled as fields by the language server.
  const memberItems = result.entries.filter(entry => entry.role === "member");
  const entries = asCompletionEntries(
    dedupeCompletionEntries(filterCompletionEntries(memberItems, context.prefix)),
    result.isIncomplete
  );
  // An authoritative empty receiver is still a successful resolution.
  entries.staticResolved = result.memberResolved || memberItems.length > 0;
  if (!entries.staticResolved) entries.isIncomplete = true;
  return entries;
}
