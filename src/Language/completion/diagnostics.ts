import type { MemberInspectionResult } from "../../Runtime/backendProtocol";

export type CompletionSuppressionReason = Extract<MemberInspectionResult, { status: "suppressed" }>["reason"];

const staticDescriptions = {
  "provider-unavailable": "The language server is not available",
  "document-unavailable": "The console input is not available for analysis",
  "no-response": "The language server returned no completion result",
  "request-failed": "The completion request failed",
  "unsupported-context": "Completion is not supported at this position",
  "receiver-unresolved": "This object's members could not be inferred from source",
  "unresolved-dispatch": "Custom method results could not be inferred from source",
  "analysis-limit": "Static analysis reached its limit",
  "analysis-pending": "Source or package information is still loading",
  "inference-cycle": "Recursive definitions could not be resolved",
  "no-receiver-members": "No members could be inferred from source",
} as const;

export type StaticCompletionUnavailableReason = keyof typeof staticDescriptions;

// Never log arbitrary provider text, source code, names or error messages.
export function staticCompletionUnavailableReason(value: unknown): StaticCompletionUnavailableReason | undefined {
  return typeof value === "string" && Object.hasOwn(staticDescriptions, value)
    ? value as StaticCompletionUnavailableReason : undefined;
}

export type CompletionDecision =
  | { kind: "StaticInferred" }
  | { kind: "StaticUnavailable"; reason?: StaticCompletionUnavailableReason; runtimeReason?: CompletionSuppressionReason }
  | { kind: "Rejected"; reason: "executable-receiver" }
  | { kind: "Suppressed"; reason: CompletionSuppressionReason }
  | { kind: "Unavailable"; reason: "runtime-unavailable" };

const descriptions = {
  "executable-receiver": "Request completion includes an expression that cannot be inspected safely",
  "active-binding": "Request completion could run a function automatically linked to this variable",
  "deferred-binding": "Request completion could evaluate a deferred value",
  "unsafe-dispatch": "Request completion could run a custom method",
  "unsafe-altrep": "Request completion could run code to access this object's data",
  "unsafe-environment": "Request completion could run code supplied by a custom data source",
  "runtime-unavailable": "The R session could not complete the inspection",
} as const;

const actions = {
  Rejected: "Runtime inspection was not attempted",
  Suppressed: "Inspection stopped without evaluating it",
  Unavailable: "No inspection result was used",
} as const;

const runtimeRefusals: Record<CompletionSuppressionReason, string> = {
  "active-binding": descriptions["active-binding"],
  "deferred-binding": descriptions["deferred-binding"],
  "unsafe-dispatch": descriptions["unsafe-dispatch"],
  "unsafe-altrep": descriptions["unsafe-altrep"],
  "unsafe-environment": descriptions["unsafe-environment"],
};

export function formatCompletionDecision(decision: CompletionDecision): string {
  if (decision.kind === "StaticInferred") {
    return "[Static Completion - Inferred]: Members were inferred from source. The inferred result was used for completion.";
  }
  if (decision.kind === "StaticUnavailable") {
    const reason = staticCompletionUnavailableReason(decision.reason) ?? "no-receiver-members";
    // Reuse the established runtime safety reason when that refusal prompted
    // fallback. Otherwise report the native source-inference reason. Keep one
    // reason and one consistent outcome; completion never executes user code.
    const inferFailed = ["receiver-unresolved", "unresolved-dispatch", "no-receiver-members"].includes(reason);
    const description = inferFailed && decision.runtimeReason && Object.hasOwn(runtimeRefusals, decision.runtimeReason)
      ? runtimeRefusals[decision.runtimeReason] : staticDescriptions[reason];
    return `[Static Completion - Unavailable]: ${description}. No completion suggestions were returned.`;
  }
  return `[Runtime Completion - ${decision.kind}]: ${descriptions[decision.reason]}. ${actions[decision.kind]}.`;
}

export function completionDecisionContext(text: string): string {
  // Keep one identity while a rejected receiver's member or subscript prefix
  // grows. Prefer the final unfinished bracket over an earlier $/@ accessor.
  const bracket = /(\[\[?)[^\[\]]*$/.exec(text);
  const member = /([$@])[^$@]*$/.exec(text);
  if (bracket && (!member || bracket.index > member.index)) {
    return text.slice(0, bracket.index + bracket[1].length);
  }
  return member ? text.slice(0, member.index + 1) : text;
}
