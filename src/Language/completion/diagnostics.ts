export type CompletionDecision =
  | { kind: "Rejected"; reason: "executable-receiver" }
  | { kind: "Suppressed"; reason: "active-binding" | "deferred-binding" |
      "unsafe-dispatch" | "unsafe-altrep" | "unsafe-environment" }
  | { kind: "Unavailable"; reason: "runtime-unavailable" };

const descriptions = {
  "executable-receiver": "This expression includes code or operations that cannot be safely inspected",
  "active-binding": "Reading this value could run a function automatically",
  "deferred-binding": "This value has not been calculated yet",
  "unsafe-dispatch": "Reading this object could run a custom function",
  "unsafe-altrep": "Reading this data could trigger additional computation",
  "unsafe-environment": "This environment uses a custom data source",
  "runtime-unavailable": "The R session could not complete the inspection",
} as const;

const actions = {
  Rejected: "Runtime inspection was not attempted",
  Suppressed: "Inspection stopped without evaluating it",
  Unavailable: "No inspection result was used",
} as const;

export function formatCompletionDecision(decision: CompletionDecision): string {
  return `[Runtime Completion - ${decision.kind}]: ${descriptions[decision.reason]}. ${actions[decision.kind]}.`;
}

export function completionDecisionContext(text: string): string {
  return text.replace(/([$@])[^$@]*$/, "$1");
}
