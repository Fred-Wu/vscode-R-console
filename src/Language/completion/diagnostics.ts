export type CompletionDecision =
  | { kind: "Rejected"; reason: "executable-receiver" }
  | { kind: "Suppressed"; reason: "active-binding" | "deferred-binding" |
      "unsafe-dispatch" | "unsafe-altrep" | "unsafe-environment" };

const descriptions = {
  "executable-receiver": "function call may have side effects",
  "active-binding": "active binding may have side effects",
  "deferred-binding": "forcing a delayed value may have side effects",
  "unsafe-dispatch": "custom accessor may have side effects",
  "unsafe-altrep": "ALTREP inspection may have side effects",
  "unsafe-environment": "custom environment access may have side effects",
} as const;

export function formatCompletionDecision(decision: CompletionDecision): string {
  return `[Completion - ${decision.kind}]: ${descriptions[decision.reason]}`;
}

export function completionDecisionContext(text: string): string {
  return text.replace(/([$@])[^$@]*$/, "$1");
}
