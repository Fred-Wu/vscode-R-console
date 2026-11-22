const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { formatCompletionDecision } = loadSource("src/Language/completion/diagnostics.ts");

test("runtime completion diagnostics use a plain-language reason followed by the same action for each decision", () => {
  const reasons = [
    ["Rejected", "executable-receiver", "Request completion includes an expression that cannot be inspected safely", "Runtime inspection was not attempted"],
    ["Suppressed", "active-binding", "Request completion could run a function automatically linked to this variable", "Inspection stopped without evaluating it"],
    ["Suppressed", "deferred-binding", "Request completion could run R code delayed until this value is first used", "Inspection stopped without evaluating it"],
    ["Suppressed", "unsafe-dispatch", "Request completion could run a custom method used to access this object's members", "Inspection stopped without evaluating it"],
    ["Suppressed", "unsafe-altrep", "Request completion could run code to access this object's data", "Inspection stopped without evaluating it"],
    ["Suppressed", "unsafe-environment", "Request completion could run code supplied by a custom data source", "Inspection stopped without evaluating it"],
    ["Unavailable", "runtime-unavailable", "The R session could not complete the inspection", "No inspection result was used"],
  ];
  for (const [kind, reason, description, action] of reasons) {
    const output = formatCompletionDecision({ kind, reason });
    assert.equal(output, `[Runtime Completion - ${kind}]: ${description}. ${action}.`);
    if (kind === "Suppressed") {
      assert.match(description, /^Request completion could run /);
      assert.equal(action, "Inspection stopped without evaluating it");
    }
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

test("unsupported subscript diagnostics remain deduplicated while typing", () => {
  const lines = [];
  const { logConsoleCompletionDecision } = loadSource("src/Language/completion/outputChannel.ts", {
    vscode: { window: { createOutputChannel: () => ({
      appendLine: text => lines.push(text), dispose() {},
    }) } },
  });
  const { completionDecisionContext } = loadSource("src/Language/completion/diagnostics.ts");
  const rejected = { kind: "Rejected", reason: "executable-receiver" };
  const scope = "subscript-regression";
  for (const input of ["make_object()[[", "make_object()[[a", "make_object()[[al", "make_object()[[alp"]) {
    assert.equal(completionDecisionContext(input), "make_object()[[");
    logConsoleCompletionDecision(rejected, completionDecisionContext(input), scope);
  }
  assert.equal(lines.length, 1);
  assert.equal(completionDecisionContext("make_object()$inner[[al"), "make_object()$inner[[");
  assert.equal(completionDecisionContext("task$data()$abc"), "task$data()$");
  logConsoleCompletionDecision(rejected, completionDecisionContext("other()[[al"), scope);
  assert.equal(lines.length, 2, "a different rejected receiver gets its own diagnostic");
});

test("runtime completion decisions are deduplicated separately for each console", () => {
  const lines = [];
  const { logConsoleCompletionDecision, noteConsoleCompletionContext, clearCompletionDiagnosticsScope } =
    loadSource("src/Language/completion/outputChannel.ts", {
      vscode: { window: { createOutputChannel: () => ({
        appendLine: text => lines.push(text), dispose() {},
      }) } },
    });
  const decision = { kind: "Suppressed", reason: "unsafe-dispatch" };
  for (const scope of ["console-A", "console-B"]) {
    noteConsoleCompletionContext("obj$", scope);
    logConsoleCompletionDecision(decision, "obj$", scope);
    logConsoleCompletionDecision(decision, "obj$", scope);
  }
  assert.equal(lines.length, 2);
  noteConsoleCompletionContext("next$", "console-A");
  logConsoleCompletionDecision(decision, "next$", "console-A");
  assert.equal(lines.length, 3);
  clearCompletionDiagnosticsScope("console-A");
  logConsoleCompletionDecision(decision, "obj$", "console-A");
  assert.equal(lines.length, 4);
});
