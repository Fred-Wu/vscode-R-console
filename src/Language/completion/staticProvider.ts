import type { CompletionProvider, StaticBindingQuery, StaticBindingResult, StaticCompletionOutcome, StaticCompletionRequest, StaticCompletionResult } from "./types";
import { isTransientCompletionFailure } from "./diagnostics";

/** Keep hung providers and obsolete requests out of presentation and follow-up lookups. */
// Shared across macOS, Linux and Windows. Covers cold provider startup as well
// as the completion request; aborted requests still settle immediately.
export const STATIC_COMPLETION_REQUEST_TIMEOUT_MS = 20_000;
export async function requestStaticCompletion(
  provider: CompletionProvider, request: StaticCompletionRequest,
  timeoutMs = STATIC_COMPLETION_REQUEST_TIMEOUT_MS
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
    const timer = setTimeout(() => finish({ status: "pending", reason: "analysis-limit" }), timeoutMs);
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
