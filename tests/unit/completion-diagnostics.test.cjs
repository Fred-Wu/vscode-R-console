const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { formatCompletionDecision } = loadSource("src/Language/completion/diagnostics.ts");

test("runtime completion diagnostics use a plain-language reason followed by the same action for each decision", () => {
  const reasons = [
    ["Rejected", "executable-receiver", "This expression includes code or operations that cannot be safely inspected", "Runtime inspection was not attempted"],
    ["Suppressed", "active-binding", "Reading this value could run a function automatically", "Inspection stopped without evaluating it"],
    ["Suppressed", "deferred-binding", "This value has not been calculated yet", "Inspection stopped without evaluating it"],
    ["Suppressed", "unsafe-dispatch", "Reading this object could run a custom function", "Inspection stopped without evaluating it"],
    ["Suppressed", "unsafe-altrep", "Reading this data could trigger additional computation", "Inspection stopped without evaluating it"],
    ["Suppressed", "unsafe-environment", "This environment uses a custom data source", "Inspection stopped without evaluating it"],
    ["Unavailable", "runtime-unavailable", "The R session could not complete the inspection", "No inspection result was used"],
  ];
  for (const [kind, reason, description, action] of reasons) {
    const output = formatCompletionDecision({ kind, reason });
    assert.equal(output, `[Runtime Completion - ${kind}]: ${description}. ${action}.`);
    assert.doesNotMatch(output, /(?:Reason:|Action:|promise|ALTREP|dispatch|binding|receiver|syntax|inspector)/i);
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
  assert.match(lines[3], /The R session could not complete the inspection/);
  assert.match(lines[3], /No inspection result was used/);
});
