/** Code-free completion diagnostics. Never include source, names, paths or values. */
export type CompletionDecision =
  | { kind: "Rejected"; reason: "executable-receiver" }
  | { kind: "Suppressed"; reason: "active-binding" | "deferred-binding" |
      "unsupported-accessor" | "unsupported-structure" };

const descriptions = {
  "executable-receiver": "executable receiver at parser stage",
  "active-binding": "active binding at runtime",
  "deferred-binding": "unevaluated binding at runtime",
  "unsupported-accessor": "unsupported accessor at runtime",
  "unsupported-structure": "unsupported object structure at runtime",
} as const;

/** A fixed vocabulary ensures user input can never reach the output channel. */
export function formatCompletionDecision(decision: CompletionDecision): string {
  return `[Completion - ${decision.kind}]: ${descriptions[decision.reason]}`;
}
