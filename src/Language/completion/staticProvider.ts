import type { CompletionProvider, CompletionResult, StaticBindingQuery, StaticBindingResult, StaticCompletionOutcome, StaticCompletionRequest, StaticCompletionResult } from "./types";
import { getCompletionContext, getStaticFallbackContext } from "./syntax";
import { allowsSymbolCompletions } from "./policy";
import { storedCompletionReceiver } from "./sourceReceiver";
import { parseRuntimeMemberQuery } from "./runtimeMembers";
import { adaptNativeCompletionResult } from "./nativeMetadata";
import { isTransientCompletionFailure, staticCompletionUnavailableReason, type CompletionSuppressionReason } from "./diagnostics";

/** Native projection payload, confined to the installed-provider adapter. */
export type NativeSourceBinding = { name: string; body?: string; opaqueReceiver?: boolean };

/** Compatibility boundary for the installed languageserver's single-source projection. */
export async function provideNativeStaticCompletion(
  completeNative: (binding?: NativeSourceBinding) => Promise<CompletionResult | undefined>,
  request: StaticCompletionRequest
): Promise<StaticCompletionOutcome> {
  const { input, cursor, bindings } = request;
  if (!bindings.isCurrent()) return { status: "pending", reason: "analysis-pending" };
  const before = input.slice(0, cursor), line = before.split("\n").at(-1)!;
  const runtime = getCompletionContext(line, line.length, before, input.slice(cursor));
  const context = getStaticFallbackContext(line, line.length, before, input.slice(cursor), runtime) ?? runtime;
  if (context?.rejectionReason || context?.suppressAutomatic) {
    return { status: "unresolved", reason: "unsupported-context" };
  }
  let sourceBinding: NativeSourceBinding | undefined;
  let bindingSuppression: CompletionSuppressionReason | undefined;
  // Runtime refusal is evidence about this receiver. Keep it opaque even when
  // another binding lookup would return a callable source snapshot.
  const refusedRoot = request.runtimeRefusal && parseRuntimeMemberQuery(request.runtimeRefusal.expression)?.root;
  if (refusedRoot) sourceBinding = { name: refusedRoot, opaqueReceiver: true };
  else if (context && !(context.kind === "argument" && context.functionName &&
      parseRuntimeMemberQuery(context.functionName, "arguments"))) {
    const receiver = storedCompletionReceiver(context, input, cursor);
    if (receiver) {
      const result = await bindings.resolve({ name: receiver.name,
        lookup: receiver.target === "source" ? "function" : receiver.target === "source-value" ? "value" : "identity" });
      if (result.status === "suppressed") bindingSuppression = result.reason;
      if (result.status === "source" && receiver.target !== "binding") {
        sourceBinding = { name: receiver.name, body: result.source };
      } else if (result.status !== "missing" && result.status !== "package" &&
          !(result.status === "not-callable" && receiver.target === "source")) {
        sourceBinding = { name: receiver.name, ...(receiver.target === "binding" ? { opaqueReceiver: true } : {}) };
      }
    }
  }
  if (!bindings.isCurrent()) return { status: "pending", reason: "analysis-pending" };
  const nativeResult = await completeNative(sourceBinding);
  if (!bindings.isCurrent()) return { status: "pending", reason: "analysis-pending" };
  if (!nativeResult) return { status: "pending", reason: "no-response" };
  const result = adaptNativeCompletionResult(nativeResult, context);
  if (bindingSuppression) result.rConsoleBindingSuppressionReason = bindingSuppression;
  let items = result.items;
  // Parameter inference can fail inside a valid argument expression. Retain
  // independent symbols after the native supplement has validated the reply.
  const expressionContext = context?.kind === "argument" && allowsSymbolCompletions(context);
  if (result.rConsoleArgumentsResolved === false && expressionContext) {
    items = items.filter(item => item.role === "symbol" || item.role === "scope");
    result.items = items;
  }
  const reason = staticCompletionUnavailableReason(result.rConsoleStaticUnavailableReason);
  // Native member diagnostics describe the receiver query. Package symbols,
  // call parameters and literal values have their own validated evidence.
  const receiverContext = context?.kind === "member" || context?.kind === "bracket";
  // An empty symbol match can still be broadened independently of the
  // unavailable signature. Scheduling and resource failures retain their status.
  const canBroadenSymbols = expressionContext && result.rConsoleArgumentsResolved === false &&
    (reason === "receiver-unresolved" || reason === "method-arguments-unavailable");
  const failed = (result.rConsoleArgumentsResolved === false && !(canBroadenSymbols || (expressionContext && items.length))) ||
    reason === "request-failed" || reason === "document-unavailable" ||
    (receiverContext && !items.length);
  if (reason && failed) return {
    status: reason === "analysis-pending" ? "pending" : "unresolved",
    reason,
    completion: result,
  };
  if (!receiverContext && result.rConsoleArgumentsResolved !== false) delete result.rConsoleStaticUnavailableReason;
  const authoritativeEmpty = !canBroadenSymbols && !items.length && (result.rConsoleMemberResolved || result.rConsoleArgumentsExhausted);
  return { status: authoritativeEmpty ? "resolved-empty" : "resolved", completion: result };
}

/** Keep hung providers and obsolete requests out of presentation and follow-up lookups. */
export async function requestStaticCompletion(
  provider: CompletionProvider, request: StaticCompletionRequest
): Promise<StaticCompletionResult> {
  const inputVersion = request.document.version;
  const current = () => request.bindings.isCurrent() && request.document.version === inputVersion &&
    request.document.getText() === request.input;
  const pending = { status: "pending" as const, reason: "analysis-pending" as const };
  let finished = false;
  const lifetime = new AbortController();
  const cancelledBinding = () => ({ status: "unavailable" as const, reason: "cancelled" as const });
  // Release this invocation's readers immediately while retaining the shared
  // resolver snapshot for a subsequent prefix retry in the same request.
  const cancelledReads = new Promise<StaticBindingResult>(resolve => {
    lifetime.signal.addEventListener("abort", () => resolve(cancelledBinding()), { once: true });
  });
  const bindings = { ...request.bindings, signal: lifetime.signal, isCurrent: () => !finished && current(),
    resolve: (query: StaticBindingQuery) => !finished && current()
      ? Promise.race([cancelledReads,
          request.bindings.resolve(query).then(result => !finished && current() ? result : cancelledBinding())])
      : Promise.resolve(cancelledBinding()) };
  const outcome = await new Promise<StaticCompletionOutcome>(resolve => {
    const finish = (result: StaticCompletionOutcome) => {
      if (finished) return;
      const valid = current();
      finished = true;
      clearTimeout(timer);
      request.bindings.signal?.removeEventListener("abort", cancel);
      lifetime.abort();
      resolve(!valid ? pending : result.status === "unresolved" && isTransientCompletionFailure(result.reason)
        ? { ...result, status: "pending" } : result);
    };
    const cancel = () => finish(pending);
    const timer = setTimeout(() => finish({ status: "pending", reason: "analysis-limit" }), 10000);
    request.bindings.signal?.addEventListener("abort", cancel, { once: true });
    if (!current()) return finish(pending);
    void Promise.resolve().then(() => finished || !current() ? pending : provider.provideStaticCompletion
      ? provider.provideStaticCompletion({ ...request, bindings })
      : { status: "unresolved" as const, reason: "provider-unavailable" as const })
      .then(finish, () => finish({ status: "unresolved", reason: "request-failed" }));
  });
  const completion = outcome.completion;
  return {
    ...completion,
    items: outcome.status === "resolved" ? [...outcome.completion.items] : [],
    isIncomplete: outcome.status === "pending" || (outcome.status !== "resolved-empty" &&
      completion?.isIncomplete === true),
    staticStatus: outcome.status,
    ...((outcome.status === "unresolved" || outcome.status === "pending")
      ? { rConsoleStaticUnavailableReason: outcome.reason } : {}),
  };
}
