const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { formatCompletionDecision } = loadSource("src/Language/completion/diagnostics.ts");

test("completion decisions use human-readable, source-free fixed messages", () => {
  assert.equal(formatCompletionDecision({ kind: "Rejected", reason: "executable-receiver" }),
    "[Completion - Rejected]: executable receiver at parser stage");
  assert.equal(formatCompletionDecision({ kind: "Suppressed", reason: "active-binding" }),
    "[Completion - Suppressed]: active binding at runtime");
  for (const reason of ["deferred-binding", "unsupported-accessor", "unsupported-structure"]) {
    const output = formatCompletionDecision({ kind: "Suppressed", reason });
    assert.match(output, /^\[Completion - Suppressed\]: [a-z ]+ at runtime$/);
    assert.doesNotMatch(output, /eval\(|make_object|active_obj|\$inner|=\s*['"]/);
  }
});
