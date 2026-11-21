const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const completion = loadSource("src/Language/completion.ts", { vscode: {
  CompletionItemKind: { Field: 4, Variable: 5, Function: 2, Text: 0 }, SnippetString: class {},
} });

test("workspace members and slots use cached metadata without any R inspection", async () => {
  const workspace = { globalenv: { obj: {
    type: "list", class: ["tracked", "list"], names: ["inner", "field"], slots: ["slot"], length: 2,
  } } };
  const reject = async () => assert.fail("completion must not invoke sess");
  for (const [input, expected] of [
    ["obj$", ["inner", "field"]],
    ["obj@", ["slot"]],
    ["obj[[", ["inner", "field"]],
  ]) {
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      workspace, [], [], undefined, reject, undefined, reject);
    assert.deepEqual(entries.filter(item => item.detail === "obj").map(item => item.label),
      expected, input);
  }
});

test("nested objects cannot trigger live extraction or hover", async () => {
  const workspace = { globalenv: { obj: { type: "list", names: ["inner"] } } };
  const reject = async () => assert.fail("nested completion must not invoke sess");
  for (const input of ["obj$inner$", "obj$inner[[", 'obj[["inner"]]$', "obj[[1]][[", "obj$inner@"]) {
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      workspace, [], [], undefined, reject, undefined, reject);
    assert.deepEqual(entries.filter(item => item.source === "session"), [], input);
  }
});

test("LSP source-inferred nested members remain available in opt-in static mode", async () => {
  const input = "obj$inner$";
  const entries = await completion.collectCompletionEntries(
    completion.getCompletionContext(input, input.length),
    { getText: () => input }, { line: 0, character: input.length },
    { globalenv: { obj: { type: "list", names: ["inner"] } } }, [], [],
    { provideCompletionItems: async () => ({
      rConsoleMemberResolved: true,
      items: [{ label: "alpha", kind: 4, data: { type: "member" } }],
    }) }, async () => assert.fail("must not request live members"));
  assert.deepEqual(entries.map(item => item.label), ["alpha"]);
});

test("truncated workspace names never cause child-page requests", async () => {
  const names = Array.from({ length: 1501 }, (_, i) => "field" + String(i).padStart(4, "0"));
  const workspace = { globalenv: { df: {
    class: ["data.frame"], type: "list", length: names.length, names: names.slice(0, 1000),
  } } };
  const reject = async () => assert.fail("child paging must not run");
  for (const [input, label, present] of [
    ["df[[field000", "field0000", true],
    ["df[[field1500", "field1500", false],
  ]) {
    const entries = await completion.collectCompletionEntries(
      completion.getCompletionContext(input, input.length), undefined, undefined,
      workspace, [], [], undefined, reject, undefined, reject);
    assert.equal(entries.some(item => item.label === label), present, input);
  }
});
