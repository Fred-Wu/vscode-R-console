const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { formatCompletionDecision } = loadSource("src/Language/completion/diagnostics.ts");

test("completion decisions identify potentially side-effecting operations without user input", () => {
  const reasons = [
    ["Rejected", "executable-receiver", "function call may have side effects"],
    ["Suppressed", "active-binding", "active binding may have side effects"],
    ["Suppressed", "deferred-binding", "forcing a delayed value may have side effects"],
    ["Suppressed", "unsafe-dispatch", "custom accessor may have side effects"],
    ["Suppressed", "unsafe-altrep", "ALTREP inspection may have side effects"],
    ["Suppressed", "unsafe-environment", "custom environment access may have side effects"],
  ];
  for (const [kind, reason, message] of reasons) {
    const output = formatCompletionDecision({ kind, reason });
    assert.equal(output, `[Completion - ${kind}]: ${message}`);
    assert.doesNotMatch(output, /eval\(|make_object|active_obj|\$inner|=\s*['"]/);
  }
});
