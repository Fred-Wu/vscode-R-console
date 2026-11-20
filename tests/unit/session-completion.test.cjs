const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { inspectSessionCompletion } = loadSource("src/Runtime/VSCR/sess/completionInspection.ts");

test("runtime signatures use hover and reject executable receivers before sending requests", async () => {
  const requests = [];
  const request = async (method, params) => {
    requests.push({ method, params });
    return { str: 'function(first, mode = c("auto", "manual"))' };
  };
  for (const expression of ["obj$fun", "slot_obj@fun", "obj$`a b`", "obj$nested$fun"]) {
    assert.match((await inspectSessionCompletion(expression, "function", request)).signature, /^function/);
    assert.deepEqual(requests.at(-1), { method: "hover", params: { expr: expression } });
  }
  const count = requests.length;
  for (const expression of ["get('obj')$fun", "obj[[system('bad')]]", "obj[[index]]", "obj[[`index`]]",
    "obj[1]", "obj[[1+1]]", "obj[[0]]", "obj[[1]];stop('bad')", "base::local({stop('bad')})"]) {
    assert.equal(await inspectSessionCompletion(expression, "columns", request), undefined, expression);
  }
  assert.equal(requests.length, count);
});

test("nested column lookup uses sess selectors and follows pages without guessing object kinds", async () => {
  const requests = [];
  const selector = { kind: "index", value: 2, name: "data" };
  const request = async (method, params) => {
    requests.push({ method, params });
    if (!params.path.length) {
      if (params.start === 1) return { children: [], next_start: 2 };
      return { children: [{ selector, class: ["data.table", "data.frame"] }], next_start: null };
    }
    assert.deepEqual(params.path, [selector]);
    return { children: [
      { selector: { kind: "index", value: 1, name: "a b" } },
      { selector: { kind: "index", value: 2, name: "alpha" } },
    ], next_start: null };
  };
  for (const expression of ['obj$data', 'obj[[2]]', 'obj[[2L]]', 'obj[[2e0]]', 'obj[["data"]]', "obj[['data']]", 'obj[[r"(data)"]]']) {
    assert.deepEqual(await inspectSessionCompletion(expression, "columns", request),
      { names: ["a b", "alpha"], class: ["data.table", "data.frame"] });
  }
  assert.ok(requests.every(request => request.method === "workspace_children" && !Object.hasOwn(request.params, "expr")));
  assert.deepEqual(requests.slice(0, 3).map(request => request.params.start), [1, 2, 1]);
  let decoded;
  await inspectSessionCompletion('`a\\`b`[["c\\u0064"]]', "columns", async (_, params) => {
    decoded = params.name;
    return { children: [], next_start: null };
  });
  assert.equal(decoded, "a`b");
  assert.equal(await inspectSessionCompletion("obj", "columns", async () => ({ children: [], next_start: 1 })), undefined);
});

test("runtime inspection drops replies after sess reconnect and never continues on the new session", async () => {
  const { SessProxy } = loadSource("src/Runtime/VSCR/sess/sessProxy.ts");
  const proxy = new SessProxy({ upstreamPipePath: "unused" });
  for (const [expression, kind] of [["obj$fun", "function"], ["nested[[1]]", "columns"]]) {
    proxy.rSocket = { destroyed: false };
    let calls = 0;
    proxy.request = async () => {
      calls++;
      proxy.rSocket = { destroyed: false };
      return { str: "function(old)", children: [{ selector: { kind: "index", value: 1 } }], next_start: null };
    };
    assert.equal(await proxy.inspectCompletion(expression, kind), undefined);
    assert.equal(calls, 1);
  }
});

test("indexed members use the selected object and never fall back to parent fields", async () => {
  const completion = loadSource("src/Language/completion.ts", { vscode: {
    CompletionItemKind: { Field: 4, Variable: 5, Function: 2, Text: 0 }, SnippetString: class {},
  } });
  for (const [input, type, children, expected] of [
    ['test[["xtest"]]$', 'integer', [], []],
    ['test[[1]]$', 'list', [
      { selector: { kind: 'index', value: 1, name: 'child' }, type: 'integer' },
      { selector: { kind: 'index', value: 2, name: 'fun' }, type: 'closure' },
    ], ['child', 'fun()']],
    ['test[[1]]@', 'S4', [{ selector: { kind: 'slot', value: 'slot' }, type: 'integer' }], ['slot']],
    ['test[[1]]$', 'S4', [], []],
    ["test[[stop('bad')]]$", 'list', [], []],
  ]) {
    const context = completion.getCompletionContext(input, input.length);
    const requests = [];
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      { globalenv: { test: { names: ['xtest'], slots: ['parentSlot'] } } }, [], [], undefined,
      async () => assert.fail('indexed receivers must not use expression-based completion'), undefined,
      (expression, kind) => inspectSessionCompletion(expression, kind, async (method, params) => {
        requests.push(params);
        assert.equal(method, 'workspace_children');
        assert.equal(params.name, 'test');
        return { children: params.path.length ? children : [
          { selector: { kind: 'index', value: 1, name: 'xtest' }, type },
        ] };
      }));
    assert.deepEqual(entries.map(item => item.insertText), expected, input);
    assert.equal(requests.length, input.includes('stop') ? 0 : expected.length ? 2 : 1, input);
  }
  const input = 'test %>% .[[1]]$';
  assert.equal(completion.getCompletionContext(input, input.length).objectName, 'test[[1]]');
});

test("nested data columns retain quoting, dimensions and native completion priority", async () => {
  const completion = loadSource("src/Language/completion.ts", { vscode: {
    CompletionItemKind: { Field: 4, Variable: 5, Function: 2, Text: 0 }, SnippetString: class {},
  } });
  for (const [marked, classes, expected] of [
    ['nested[[1]][[|]]', ['data.frame'], ['"a b"', '"alpha"']],
    ['obj$data[, |]', ['data.frame'], ['"a b"', '"alpha"']],
    ['obj$data[|, ]', ['data.frame'], []],
    ['obj$data[, |]', ['data.table', 'data.frame'], ['`a b`', 'alpha']],
    ['nested[[1]][["|"]]', ['data.frame'], ['a b', 'alpha']],
  ]) {
    const cursor = marked.indexOf('|'), text = marked.replace('|', '');
    const context = completion.getCompletionContext(text, cursor);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined, undefined, [], [], undefined,
      async () => assert.fail("bracket completion must not evaluate an expression"), undefined,
      async (expression, kind) => { assert.equal(kind, 'columns'); return { names: ['a b', 'alpha'], class: classes }; });
    assert.deepEqual(entries.map(item => item.insertText), expected, marked);
  }
  const text = 'obj$data[[', context = completion.getCompletionContext(text, text.length);
  const entries = await completion.collectCompletionEntries(context, { getText: () => text }, { line: 0, character: text.length },
    undefined, [], [], { provideCompletionItems: async () => [{ label: 'native', kind: 4, data: { type: 'scope' } }] },
    undefined, undefined, async () => assert.fail("known native fields must not wait for sess"));
  assert.equal(entries[0].label, 'native');
});
