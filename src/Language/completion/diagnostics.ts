export type CompletionDecision =
  | { kind: "Rejected"; reason: "executable-receiver" }
  | { kind: "Suppressed"; reason: "active-binding" | "deferred-binding" |
      "unsafe-dispatch" | "unsafe-altrep" | "unsafe-environment" }
  | { kind: "Unavailable"; reason: "runtime-unavailable" };

const descriptions = {
  "executable-receiver": "Request completion includes an expression that cannot be inspected safely",
  "active-binding": "Request completion could run a function automatically linked to this variable",
  "deferred-binding": "Request completion could run R code delayed until this value is first used",
  "unsafe-dispatch": "Request completion could run a custom method used to access this object's members",
  "unsafe-altrep": "Request completion could run code to access this object's data",
  "unsafe-environment": "Request completion could run code supplied by a custom data source",
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
