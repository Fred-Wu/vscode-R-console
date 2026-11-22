const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { formatCompletionDecision } = loadSource("src/Language/completion/diagnostics.ts");

test("runtime completion refusal logs explain the inspection decision without user input", () => {
  const reasons = [
    ["Rejected", "executable-receiver", "Receiver contains unsupported or executable syntax; runtime inspection was not attempted."],
    ["Suppressed", "active-binding", "Active binding would invoke a getter; inspection stopped without reading it."],
    ["Suppressed", "deferred-binding", "Deferred binding would be forced; inspection stopped without evaluating it."],
    ["Suppressed", "unsafe-dispatch", "Object requires unsupported or custom accessor dispatch; inspection was stopped."],
    ["Suppressed", "unsafe-altrep", "ALTREP data could require materialization; inspection was stopped."],
    ["Suppressed", "unsafe-environment", "User-defined database environment cannot be inspected safely."],
  ];
  for (const [kind, reason, message] of reasons) {
    const output = formatCompletionDecision({ kind, reason });
    assert.equal(output, `[Runtime Completion - ${kind}]: ${message}`);
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
