const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const completion = loadSource("src/Language/completion.ts", {
  vscode: { CompletionItemKind: { Field: 4, Function: 2, Variable: 5, Property: 9, Module: 8 } },
});

test("completion recognizes member, namespace, argument, and bracket contexts", () => {
  for (const [input, kind, prefix] of [
    ["df$col", "member", "col"], ["obj@slot", "member", "slot"],
    ["stats::lm", "package", "lm"], ["stats:::lm", "package", "lm"],
    ["mean(na", "argument", "na"], ['df[["col', "bracket", "col"],
  ]) {
    const context = completion.getCompletionContext(input, input.length);
    assert.equal(context.kind, kind, input);
    assert.equal(context.prefix, prefix, input);
    assert.equal(input.slice(context.replaceStart), prefix, input);
  }
});

test("cached column completions work without LSP and quote non-syntactic names", async () => {
  const workspace = { search: [], loaded_namespaces: [], globalenv: { df: { names: ["a b", "alpha"] } } };
  for (const [input, expected] of [["df[", "`a b`"], ["df[[", '"a b"'], ['df[["', "a b"]]) {
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined, workspace, []);
    assert.equal(entries.find((entry) => entry.label === "a b").insertText, expected);
    assert.equal(entries.filter((entry) => entry.label === "alpha").length, 1);
  }
});
