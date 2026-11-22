export type CompletionDecision =
  | { kind: "Rejected"; reason: "executable-receiver" }
  | { kind: "Suppressed"; reason: "active-binding" | "deferred-binding" |
      "unsafe-dispatch" | "unsafe-altrep" | "unsafe-environment" };

const descriptions = {
  "executable-receiver": "Receiver contains unsupported or executable syntax; runtime inspection was not attempted.",
  "active-binding": "Active binding would invoke a getter; inspection stopped without reading it.",
  "deferred-binding": "Deferred binding would be forced; inspection stopped without evaluating it.",
  "unsafe-dispatch": "Object requires unsupported or custom accessor dispatch; inspection was stopped.",
  "unsafe-altrep": "ALTREP data could require materialization; inspection was stopped.",
  "unsafe-environment": "User-defined database environment cannot be inspected safely.",
} as const;

export function formatCompletionDecision(decision: CompletionDecision): string {
  return `[Runtime Completion - ${decision.kind}]: ${descriptions[decision.reason]}`;
}

export function completionDecisionContext(text: string): string {
  return text.replace(/([$@])[^$@]*$/, "$1");
}
