import type { GuardedBindingResolver, RuntimeFunctionSourceRequester, StaticBindingQuery, StaticBindingResult } from "./types";

const STATIC_BINDING_LIMITS = { lookups: 16, sourceBytes: 64 * 1024, totalBytes: 256 * 1024, depth: 8, timeoutMs: 1500 };

/** Supplies inert native snapshots; scope discovery and dependency traversal belong to providers. */
export function createGuardedBindingResolver(
  requester?: RuntimeFunctionSourceRequester,
  options: { isCurrent?: () => boolean; signal?: AbortSignal; limits?: Partial<typeof STATIC_BINDING_LIMITS> } = {}
): GuardedBindingResolver {
  const limits = { ...STATIC_BINDING_LIMITS, ...options.limits };
  const cache = new Map<string, Promise<StaticBindingResult>>();
  let bytes = 0;
  let deadline: number | undefined;
  const isCurrent = () => !options.signal?.aborted && (options.isCurrent?.() ?? true);
  const unavailable = (reason: Extract<StaticBindingResult, { status: "unavailable" }>["reason"]): StaticBindingResult =>
    ({ status: "unavailable", reason });
  return {
    signal: options.signal, isCurrent,
    async resolve(query: StaticBindingQuery): Promise<StaticBindingResult> {
      if (!isCurrent()) return unavailable("cancelled");
      if (!query || typeof query.name !== "string" || !query.name || query.name.includes("\0") ||
          Buffer.byteLength(query.name, "utf8") > 4096 ||
          !["function", "value", "identity"].includes(query.lookup) ||
          !Number.isInteger(query.depth ?? 0) || (query.depth ?? 0) < 0) return unavailable("invalid-request");
      // Native source extraction verifies a global enclosing environment. Other
      // closure identities cannot authorize lookup in a same-named global binding.
      if (query.scope?.kind !== "search-path") return unavailable("unsupported-scope");
      const { name, lookup } = query;
      deadline ??= Date.now() + limits.timeoutMs;
      if ((query.depth ?? 0) > limits.depth) return unavailable("analysis-limit");
      const key = JSON.stringify([lookup, name]);
      const previous = cache.get(key);
      if (previous) return previous.then(result => isCurrent() ? result : unavailable("cancelled"));
      // Settled snapshots remain valid for prefix retries in the same request.
      // Pending reads retain their original deadline and cancellation handler.
      if (Date.now() >= deadline || cache.size >= limits.lookups) return unavailable("analysis-limit");
      const bindingId = `binding-${cache.size}`;
      const pending = new Promise<StaticBindingResult>(resolve => {
        let settled = false;
        const finish = (result: StaticBindingResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", cancel);
          resolve(isCurrent() ? result : unavailable("cancelled"));
        };
        const cancel = () => finish(unavailable("cancelled"));
        const timer = setTimeout(() => finish(unavailable("analysis-limit")), Math.max(0, deadline! - Date.now()));
        options.signal?.addEventListener("abort", cancel, { once: true });
        // Defer invocation until the promise has been cached, including reentrant callers.
        void Promise.resolve().then(() => {
          if (!isCurrent() || settled) return undefined;
          return requester?.(name, lookup === "function" ? "source" : lookup === "value" ? "source-value" : "binding");
        }).then(result => {
          if (settled) return;
          if (result?.status === "source") {
            if (typeof result.text !== "string") return finish(unavailable("runtime-unavailable"));
            const size = Buffer.byteLength(result.text, "utf8");
            if (!size || size > limits.sourceBytes || bytes + size > limits.totalBytes) return finish(unavailable("analysis-limit"));
            bytes += size;
            finish({ status: "source", source: result.text, bindingId, closureScope: { kind: "search-path" } });
          } else if (result && ["package", "missing", "not-callable", "opaque", "suppressed"].includes(result.status)) {
            finish(result as StaticBindingResult);
          } else finish(unavailable("runtime-unavailable"));
        }, () => finish(unavailable("runtime-unavailable")));
      });
      cache.set(key, pending);
      return pending;
    },
  };
}
