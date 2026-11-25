import type { CompletionResult, StaticCompletionOutcome, StaticCompletionRequest } from "./types";
import { getCompletionSyntax } from "./contextParser";
import { getCompletionContext, getStaticFallbackContext } from "./syntax";
import { allowsSymbolCompletions } from "./policy";
import { storedCompletionReceiver } from "./sourceReceiver";
import { parseRuntimeMemberQuery } from "./runtimeMembers";
import { adaptNativeCompletionResult } from "./nativeMetadata";
import { staticCompletionUnavailableReason, type CompletionSuppressionReason } from "./diagnostics";

/** Native projection payload, confined to the installed-provider adapter. */
export type NativeSourceBinding = { name: string; body?: string; opaqueReceiver?: boolean };

type InputAnalysis = {
  input: string;
  cursor: number;
  context: ReturnType<typeof getCompletionContext>;
  getReceiver(): ReturnType<typeof storedCompletionReceiver>;
};
const inputAnalyses = new WeakMap<object, InputAnalysis>();

/** Fuzzy retries move the query position within the same input and actual cursor. */
function analyzeInput({ input, cursor, requestScope }: StaticCompletionRequest): InputAnalysis {
  const cached = requestScope && inputAnalyses.get(requestScope);
  if (cached?.input === input && cached.cursor === cursor) return cached;
  const before = input.slice(0, cursor), line = before.split("\n").at(-1)!;
  const syntax = getCompletionSyntax(input, cursor);
  const runtime = getCompletionContext(line, line.length, before, input.slice(cursor), syntax);
  const context = getStaticFallbackContext(line, line.length, before, input.slice(cursor), runtime, syntax) ?? runtime;
  let receiver: ReturnType<typeof storedCompletionReceiver>;
  let receiverReady = false;
  const analysis: InputAnalysis = {
    input, cursor, context,
    getReceiver() {
      if (!receiverReady) {
        receiverReady = true;
        if (context && !(context.kind === "argument" && context.functionName &&
            parseRuntimeMemberQuery(context.functionName, "arguments"))) {
          receiver = storedCompletionReceiver(context, input, cursor, syntax);
        }
      }
      return receiver;
    },
  };
  if (requestScope) inputAnalyses.set(requestScope, analysis);
  return analysis;
}

/** Compatibility boundary for the installed languageserver's single-source projection. */
export async function provideNativeStaticCompletion(
  completeNative: (binding?: NativeSourceBinding) => Promise<CompletionResult | undefined>,
  request: StaticCompletionRequest
): Promise<StaticCompletionOutcome> {
  const { bindings } = request;
  if (!bindings.isCurrent()) return { status: "pending", reason: "analysis-pending" };
  const analysis = analyzeInput(request);
  const { context } = analysis;
  if (context?.rejectionReason || context?.suppressAutomatic) {
    return { status: "unresolved", reason: "unsupported-context" };
  }
  let sourceBinding: NativeSourceBinding | undefined;
  let bindingSuppression: CompletionSuppressionReason | undefined;
  // Runtime refusal is evidence about this receiver. Keep it opaque even when
  // another binding lookup would return a callable source snapshot.
  const refusedRoot = request.runtimeRefusal && parseRuntimeMemberQuery(request.runtimeRefusal.expression)?.root;
  if (refusedRoot) sourceBinding = { name: refusedRoot, opaqueReceiver: true };
  else {
    const receiver = analysis.getReceiver();
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
