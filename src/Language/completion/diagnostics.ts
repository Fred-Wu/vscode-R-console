export type CompletionDecision =
  | { kind: "Rejected"; reason: "executable-receiver" }
  | { kind: "Suppressed"; reason: "active-binding" | "deferred-binding" |
      "unsafe-dispatch" | "unsafe-altrep" | "unsafe-environment" }
  | { kind: "Unavailable"; reason: "runtime-unavailable" };

const descriptions = {
  "executable-receiver": "receiver contains unsupported or executable syntax",
  "active-binding": "active binding would invoke a getter",
  "deferred-binding": "deferred binding would require forcing a promise",
  "unsafe-dispatch": "unsupported or custom accessor dispatch is required",
  "unsafe-altrep": "ALTREP storage could require materialization",
  "unsafe-environment": "user-defined database environment could invoke custom access",
  "runtime-unavailable": "native inspector was unavailable, busy, or did not respond",
} as const;

const actions = {
  Rejected: "runtime inspection was not attempted",
  Suppressed: "inspection stopped without evaluating the receiver",
  Unavailable: "no native inspection result was used",
} as const;

export function formatCompletionDecision(decision: CompletionDecision): string {
  return `[Runtime Completion - ${decision.kind}]: Reason: ${descriptions[decision.reason]}. Action: ${actions[decision.kind]}.`;
}

export function completionDecisionContext(text: string): string {
  return text.replace(/([$@])[^$@]*$/, "$1");
}
