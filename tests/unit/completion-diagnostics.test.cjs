const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { formatCompletionDecision } = loadSource("src/Language/completion/diagnostics.ts");

test("runtime completion diagnostics consistently report reason and action without user input", () => {
  const reasons = [
    ["Rejected", "executable-receiver", "receiver contains unsupported or executable syntax",
      "runtime inspection was not attempted"],
    ["Suppressed", "active-binding", "active binding would invoke a getter",
      "inspection stopped without evaluating the receiver"],
    ["Suppressed", "deferred-binding", "deferred binding would require forcing a promise",
      "inspection stopped without evaluating the receiver"],
    ["Suppressed", "unsafe-dispatch", "unsupported or custom accessor dispatch is required",
      "inspection stopped without evaluating the receiver"],
    ["Suppressed", "unsafe-altrep", "ALTREP storage could require materialization",
      "inspection stopped without evaluating the receiver"],
    ["Suppressed", "unsafe-environment", "user-defined database environment could invoke custom access",
      "inspection stopped without evaluating the receiver"],
    ["Unavailable", "runtime-unavailable", "native inspector was unavailable, busy, or did not respond",
      "no native inspection result was used"],
  ];
  for (const [kind, reason, description, action] of reasons) {
    const output = formatCompletionDecision({ kind, reason });
    assert.equal(output, `[Runtime Completion - ${kind}]: Reason: ${description}. Action: ${action}.`);
    assert.doesNotMatch(output, /eval\(|make_object|active_obj|\$inner|=\s*['"]/);
  }
});

test("runtime completion logs deduplicate each reason and context across prefixes", t => {
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
  const unavailable = { kind: "Unavailable", reason: "runtime-unavailable" };
  logConsoleCompletionDecision(unavailable, completionDecisionContext("a$lazy$"));
  logConsoleCompletionDecision(unavailable, completionDecisionContext("a$lazy$a"));
  assert.equal(lines.length, 4, "unavailable diagnostics are not repeated for typed prefixes");
  assert.match(lines[3], /Reason: native inspector was unavailable/);
  assert.match(lines[3], /Action: no native inspection result was used/);
});
