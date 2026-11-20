const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { inspectSessionCompletion } = loadSource("src/Runtime/VSCR/sess/completionInspection.ts");
const completion = loadSource("src/Language/completion.ts", { vscode: {
  CompletionItemKind: { Field: 4, Variable: 5, Function: 2, Text: 0 }, SnippetString: class {},
} });

test("runtime function signatures use targeted hover and reject arbitrary expressions", async () => {
  const requests = [];
  const request = async (method, params) => {
    requests.push({ method, params });
    return { str: 'function(first, mode = c("auto", "manual"))' };
  };
  for (const expression of ["obj$fun", "slot_obj@fun", "obj$nested$fun"]) {
    assert.match((await inspectSessionCompletion(expression, "function", request)).signature, /^function/);
    assert.deepEqual(requests.at(-1), { method: "hover", params: { expr: expression } });
  }
  const count = requests.length;
  for (const expression of ["get('obj')$fun", "obj[[system('bad')]]", "obj[[index]]",
    "obj[1]", "obj[[1+1]]", "obj[[0]]", "obj[[1]];stop('bad')"]) {
    assert.equal(await inspectSessionCompletion(expression, "function", request), undefined);
  }
  assert.equal(requests.length, count);
});

test("nested member and column inspectors never invoke sess workspace_children", async () => {
  const request = async () => assert.fail("completion must not inspect user-defined R object methods");
  const workspace = { globalenv: { obj: {
    type: "list", class: ["tracked", "list"], names: ["inner"], length: 1,
  } } };
  for (const expression of ["obj", "obj$inner", 'obj[["inner"]]', "obj[[1]]", "obj@inner"]) {
    for (const kind of ["columns", "members", "slots"]) {
      assert.equal(await inspectSessionCompletion(expression, kind, request, workspace), undefined);
    }
  }
});

test("runtime signature lookup drops replies after sess reconnect", async () => {
  const { SessProxy } = loadSource("src/Runtime/VSCR/sess/sessProxy.ts");
  const proxy = new SessProxy({ upstreamPipePath: "unused" });
  proxy.rSocket = { destroyed: false };
  let calls = 0;
  proxy.request = async () => {
    calls++;
    proxy.rSocket = { destroyed: false };
    return { str: "function(old)" };
  };
  assert.equal(await proxy.inspectCompletion("obj$fun", "function"), undefined);
  assert.equal(calls, 1);
});

test("top-level cached names need no R introspection", async () => {
  const workspace = { globalenv: { obj: {
    type: "list", class: ["tracked", "list"], names: ["inner", "field"],
    slots: ["slot"], length: 2,
  } } };
  const reject = async () => assert.fail("automatic completion must not invoke sess");
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

test("nested runtime objects omit suggestions instead of executing methods", async () => {
  const workspace = { globalenv: { obj: {
    type: "list", class: ["tracked", "list"], names: ["inner"], length: 1,
  } } };
  const reject = async () => assert.fail("nested inspection must not execute R code");
  for (const input of ["obj$inner$", "obj$inner[[", 'obj[["inner"]]$',
    "obj[[1]][[", "obj$inner@"]) {
    const context = completion.getCompletionContext(input, input.length);
    assert.ok(context, input);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      workspace, [], [], undefined, reject, undefined, reject);
    assert.equal(entries.some(item => item.label === "alpha" || item.label === "beta"), false, input);
  }
});

test("LSP-inferred nested members remain available without inspecting the R object", async () => {
  const input = "obj$inner$";
  const entries = await completion.collectCompletionEntries(
    completion.getCompletionContext(input, input.length),
    { getText: () => input }, { line: 0, character: input.length },
    { globalenv: { obj: { type: "list", names: ["inner"] } } },
    [], [], { provideCompletionItems: async () => ({
      rConsoleMemberResolved: true,
      items: [{ label: "alpha", kind: 4, data: { type: "member" } }],
    }) }, async () => assert.fail("must not request live members"),
    undefined, async () => assert.fail("must not request child metadata"));
  assert.deepEqual(entries.map(item => item.label), ["alpha"]);
});

test("truncated workspace lists use cached names but never request child pages", async () => {
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

test("named S3 subscript methods continue to use class metadata and sess hover", async () => {
  const workspace = { globalenv: { obj: { class: ["myclass", "list"] } } };
  const requests = [];
  const signature = 'function(x, i, mode = c("safe", "fast"), ...)';
  const result = await inspectSessionCompletion("obj", "subscript", async (method, params) => {
    requests.push({ method, params });
    return params.expr === "\`[.myclass\`" ? { str: signature } : undefined;
  }, workspace);
  assert.deepEqual(result, { signature, classes: ["myclass", "list"] });
  assert.deepEqual(requests, [{ method: "hover", params: { expr: "\`[.myclass\`" } }]);
  assert.equal(await inspectSessionCompletion("obj$nested", "subscript",
    async () => assert.fail("nested subscript methods must not extract receiver"), workspace), undefined);
});
