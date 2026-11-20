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
      return { children: [{ selector, class: "data.table, data.frame" }], next_start: null };
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

test("real sess nested class strings preserve bare data.table column insertion", async () => {
  const completion = loadSource("src/Language/completion.ts", { vscode: {
    CompletionItemKind: { Field: 4, Variable: 5, Function: 2, Text: 0 }, SnippetString: class {},
  } });
  const input = "obj$data[, ";
  const context = completion.getCompletionContext(input, input.length);
  const data = await inspectSessionCompletion("obj$data", "columns", async (_, params) => ({
    children: params.path.length
      ? [{ selector: { kind: "index", value: 1, name: "a b" } },
         { selector: { kind: "index", value: 2, name: "alpha" } }]
      : [{ selector: { kind: "index", value: 1, name: "data" }, class: "data.table, data.frame" }],
    next_start: null,
  }));
  assert.deepEqual(data.class, ["data.table", "data.frame"]);
  const entries = await completion.collectCompletionEntries(context, undefined, undefined,
    undefined, [], [], undefined, async () => assert.fail("no code-based runtime probes"),
    undefined, async () => data);
  assert.deepEqual(entries.map(item => item.insertText), ["`a b`", "alpha"]);
});

test("truncated workspace names request additional safe sess pages", async () => {
  const completion = loadSource("src/Language/completion.ts", { vscode: {
    CompletionItemKind: { Field: 4, Variable: 5, Function: 2, Text: 0 }, SnippetString: class {},
  } });
  const names = Array.from({ length: 1501 }, (_, i) => "field" + String(i).padStart(4, "0"));
  const workspace = { globalenv: { df: {
    class: ["data.frame"], type: "list", length: names.length, names: names.slice(0, 1000),
  } } };
  let pages = 0;
  const inspect = (expression, kind) => inspectSessionCompletion(expression, kind, async (method, params) => {
    assert.equal(method, "workspace_children");
    assert.equal(params.name, "df");
    pages++;
    const start = params.start;
    const slice = names.slice(start - 1, start + 499);
    return {
      children: slice.map((name, i) => ({ selector: { kind: "index", value: start + i, name } })),
      next_start: start + 500 <= names.length ? start + 500 : null,
    };
  }, workspace);
  const input = "df[[field15";
  const context = completion.getCompletionContext(input, input.length);
  const entries = await completion.collectCompletionEntries(context, undefined, undefined,
    workspace, [], [], undefined, undefined, undefined, inspect);
  assert.ok(pages >= 4, "completion must inspect beyond the first 1000 cached names");
  assert.ok(entries.some(item => item.insertText === '"field1500"'));
  assert.equal(entries.isIncomplete, undefined);
});

test("sess child paging is bounded and reports partial results", async () => {
  let requests = 0;
  const result = await inspectSessionCompletion("wide", "columns", async () => {
    requests++;
    return { children: [{ selector: { kind: "index", value: requests, name: "column" + requests } }],
      next_start: requests + 1 };
  });
  assert.ok(requests <= 64);
  assert.equal(result.incomplete, true);
  assert.equal(result.names.length, requests);
  const blocked = await inspectSessionCompletion("obj" + "$item".repeat(17), "columns",
    async () => assert.fail("excessively deep inspection must not make requests"));
  assert.equal(blocked, undefined);
});
