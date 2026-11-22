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

test("rejected and suppressed completion messages are not repeated as a member prefix grows", t => {
  const lines = [];
  const { logConsoleCompletionDecision } = loadSource("src/Language/completion/outputChannel.ts", {
    vscode: { window: { createOutputChannel: () => ({
      appendLine: text => lines.push(text), dispose() {},
    }) } },
  });
  const { completionDecisionContext } = loadSource("src/Language/completion/diagnostics.ts");
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  const rejected = { kind: "Rejected", reason: "executable-receiver" };
  for (const input of ["task$data()$", "task$data()$a", "task$data()$ab", "task$data()$abc"]) {
    logConsoleCompletionDecision(rejected, completionDecisionContext(input));
    now += 2000;
  }
  assert.equal(lines.length, 1);
  logConsoleCompletionDecision(rejected, completionDecisionContext("other$"));
  assert.equal(lines.length, 2);
  const suppressed = { kind: "Suppressed", reason: "unsafe-dispatch" };
  for (const input of ["custom$inner$", "custom$inner$a", "custom$inner$alpha"]) {
    logConsoleCompletionDecision(suppressed, completionDecisionContext(input));
    now += 2000;
  }
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => !line.includes("custom$inner") && !line.includes("task$data")));
});
