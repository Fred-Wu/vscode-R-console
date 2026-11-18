const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
class SnippetString { constructor(value) { this.value = value; } }
const completion = loadSource("src/Language/completion.ts", {
  vscode: {
    QuickPickItemKind: { Separator: -1 },
    Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
    CompletionItemKind: { Method: 1, Field: 4, Function: 2, Variable: 5, Property: 9, Module: 8, Text: 0, Snippet: 14 },
    SnippetString,
  },
});

test("runtime member completion adds calls only for callable members", async () => {
  for (const operator of ["$", "@"]) {
    const input = `obj${operator}`;
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined, undefined, [], [],
      undefined, async (expression, trigger) => {
        assert.equal(expression, "obj");
        assert.equal(trigger, operator);
        return [
          { name: "fun", type: "closure" }, { name: "primitive", type: "builtin" },
          { name: "special", type: "special" }, { name: "a b", str: "function (x)" },
          { name: "field", type: "double" }, { name: "unknown" },
        ];
      });
    assert.deepEqual(entries.map(entry => entry.insertText),
      ["fun()", "primitive()", "special()", "`a b`()", "field", "unknown"]);
  }
});

test("namespace completion normalizes bare callable names and preserves existing calls", async () => {
  for (const operator of ["::", ":::"]) {
    const input = `pkg${operator}`;
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, { getText: () => input },
      { line: 0, character: input.length }, undefined, [], [], {
        provideCompletionItems: async () => [
          { label: "bare", kind: 2 }, { label: "method", kind: 1 },
          { label: "call", kind: 2, insertText: "call()" },
          { label: "snippet", kind: 2, insertText: new SnippetString("snippet($0)") },
          { label: "defaults", kind: 2, insertText: new SnippetString("defaults(${1:x})") },
          { label: "a(b", kind: 2, insertText: "`a(b`" },
          { label: "field", kind: 4 }, { label: "variable", kind: 5 }, { label: "unknown" },
        ],
      });
    assert.deepEqual(entries.map(entry => entry.insertText),
      ["bare()", "method()", "call()", "snippet()", "defaults(x)", "`a(b`()", "field", "variable", "unknown"]);
  }
});

test("argument context preserves qualified calls across nested arguments and lines", () => {
  for (const [input, name, operator] of [
    ["library(", "library", undefined],
    ["stats::lm(", "stats::lm", "::"], ["stats:::lm(", "stats:::lm", ":::"],
    ["obj$lm(", "obj$lm", "$"], ["obj@lm(", "obj@lm", "@"],
    ["obj$nested@`a b` (", "obj$nested@`a b`", "@"],
    ["obj$`a\\`b`(", "obj$`a\\`b`", "$"],
    ['obj$fun(inner("("), # )\n  arg', "obj$fun", "$"],
    ["outer(obj$fun(", "obj$fun", "$"],
    ["obj$fun(inner(), ar", "obj$fun", "$"],
  ]) {
    const line = input.split("\n").at(-1);
    const context = completion.getCompletionContext(line, line.length, input);
    assert.equal(context.kind, "argument", input);
    assert.equal(context.functionName, name, input);
    assert.equal(context.functionOperator, operator, input);
  }
});

test("session member formals replace unrelated LSP arguments and remain in the Arguments group", async () => {
  for (const operator of ["$", "@"]) {
    const input = `obj${operator}lm(`;
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, { getText: () => input },
      { line: 0, character: input.length }, undefined, [], [], {
        provideCompletionItems: async () => [
          { label: "formula", insertText: "formula = ", kind: 5, detail: "parameter" },
          { label: "data", kind: 5 },
        ],
      }, async (expression, trigger) => {
        assert.ok(expression.includes(`.fn <- (obj${operator}lm);`));
        assert.equal(trigger, "$");
        return [{ name: "member_arg" }, { name: "a b" }, { name: "..." }];
      });
    assert.deepEqual(entries.map(entry => entry.insertText), ["member_arg = ", "`a b` = ", "data"]);
    const picks = completion.toCompletionQuickPickItems(entries, context);
    assert.equal(picks[0].label, "Arguments");
    assert.equal(picks[1].insertText, "member_arg = ");
  }
});

test("user-defined function completions insert callable names in ordinary and pipe contexts", async () => {
  const globalenv = {
    custom: { type: "closure" }, "a b": { type: "closure" }, "a`b": { type: "closure" },
    primitive: { type: "builtin" }, special: { type: "special" },
    legacy: { str: "function (x)" }, variable: { type: "double" },
  };
  for (const input of ["", "1 |> "]) {
    const context = completion.getCompletionContext(input, input.length) ?? {
      kind: "default", prefix: "", replaceStart: 0, snapshotInput: input, snapshotCursor: 0,
    };
    const entries = await completion.collectCompletionEntries(context, undefined, undefined, { globalenv }, []);
    assert.deepEqual(entries.filter(item => item.kind === 2).map(item => item.insertText),
      ["custom()", "`a b`()", "`a\\`b`()", "primitive()", "special()", "legacy()"]);
    assert.equal(entries.some(item => item.insertText === "variable"), !context.pipe);
  }
});

test("bare session functions supply their own arguments, including quoted callable names", async () => {
  for (const [name, source] of [["f", "f"], ["f", "`f`"], ["a b", "`a b`"],
    ["a`b", "`a\\`b`"], ["变量", "变量"], ["constructor", "constructor"]]) {
    const input = `${source}(`;
    const context = completion.getCompletionContext(input, input.length);
    let requests = 0;
    const entries = await completion.collectCompletionEntries(context, { getText: () => input },
      { line: 0, character: input.length }, { globalenv: { [name]: { type: "closure" } } }, [], [], {
        provideCompletionItems: async () => [
          { label: "wrong", detail: "parameter", kind: 5 },
          { label: "wrong value", detail: "value for wrong", kind: 5 },
        ],
      }, async expression => {
        requests++;
        assert.ok(expression.includes(`.fn <- (${source});`));
        return [{ name: "a b" }, { name: "normal" }];
      });
    assert.equal(requests, 1, source);
    assert.deepEqual(entries.filter(item => item.detail === "parameter").map(item => item.insertText),
      ["`a b` = ", "normal = "], source);
    assert.ok(!entries.some(item => item.label.startsWith("wrong")), source);
  }
});

test("local source completions publish without waiting for superseded runtime arguments", async () => {
  for (const [input, items] of [
    ["f(", [{ label: "new_arg", insertText: "new_arg = ", detail: "parameter", kind: 5 }]],
    ["f(", []],
    ['f(method = "', [{ label: "new_value", detail: "value for method", kind: 11 }]],
  ]) {
    let releaseRuntime;
    const runtime = new Promise(resolve => { releaseRuntime = resolve; });
    const pending = completion.collectCompletionEntries(completion.getCompletionContext(input, input.length),
      { getText: () => input }, { line: 0, character: input.length },
      { globalenv: { f: { type: "closure" } } }, [], [], {
        provideCompletionItems: async () => ({ items, rConsoleLocalFunction: true }),
      }, () => runtime);
    const published = await Promise.race([
      pending.then(entries => ({ entries })),
      new Promise(resolve => setImmediate(() => resolve(undefined))),
    ]);
    releaseRuntime([{ name: "old_arg" }]);
    await pending;
    assert.ok(published, "authoritative source results must not wait for the runtime");
    assert.deepEqual(published.entries.filter(item => item.detail === "parameter" ||
      item.detail?.startsWith("value for ")).map(item => item.label), items.map(item => item.label));
  }
});

test("session argument fallbacks wait for LSP and then await the live signature", async () => {
  const input = "f(";
  let releaseLsp, releaseRuntime;
  const lsp = new Promise(resolve => { releaseLsp = resolve; });
  const runtime = new Promise(resolve => { releaseRuntime = resolve; });
  const started = [];
  let settled = false;
  const pending = completion.collectCompletionEntries(completion.getCompletionContext(input, input.length),
    { getText: () => input }, { line: 0, character: input.length },
    { globalenv: { f: { type: "closure" } } }, [], [], {
      provideCompletionItems: () => { started.push("lsp"); return lsp; },
    }, () => { started.push("runtime"); return runtime; }).then(entries => {
      settled = true;
      return entries;
    });
  assert.deepEqual(started, ["lsp"]);
  releaseLsp([{ label: "wrong_arg", detail: "parameter", kind: 5 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ["lsp", "runtime"]);
  assert.equal(settled, false, "a session function still needs its runtime signature");
  releaseRuntime([{ name: "live_arg" }]);
  const entries = await pending;
  assert.deepEqual(entries.filter(item => item.detail === "parameter").map(item => item.label), ["live_arg"]);
});

test("unavailable or empty session signatures never borrow same-name package arguments", async () => {
  for (const request of [undefined, async () => undefined, async () => [], async () => { throw Error("disconnected"); }]) {
    const input = "lm(";
    const entries = await completion.collectCompletionEntries(completion.getCompletionContext(input, input.length),
      { getText: () => input }, { line: 0, character: input.length },
      { globalenv: { lm: { type: "closure" } } }, [], [], {
        provideCompletionItems: async () => [{ label: "formula", detail: "parameter", kind: 5 }],
      }, request);
    assert.ok(!entries.some(item => item.detail === "parameter"));
  }
});

test("Unicode member and argument prefixes preserve the object and full replacement span", () => {
  for (const name of ["éobj", "变量", "𐐀obj"]) {
    const memberInput = `${name}$éfu`;
    const member = completion.getCompletionContext(memberInput, memberInput.length);
    assert.equal(member.objectName, name);
    assert.equal(member.prefix, "éfu");
    assert.equal(member.replaceStart, name.length + 1);
    const argumentInput = `${name}$éfun(𐐀ar`;
    const argument = completion.getCompletionContext(argumentInput, argumentInput.length);
    assert.equal(argument.functionName, `${name}$éfun`);
    assert.equal(argument.prefix, "𐐀ar");
    assert.equal(argument.replaceStart, argumentInput.indexOf("𐐀ar"));
    assert.deepEqual(argument.argumentTags, [null]);
  }
});

test("member completion sends token-derived objects and keeps line-relative replacement spans", async () => {
  for (const [input, objectName, prefix] of [
    ["obj $ nested @ sl", "obj$nested", "sl"],
    ["obj$ # comment\n nested$fi", "obj$nested", "fi"],
    ["outer(obj\n$nested$fi", "obj$nested", "fi"],
    ["𐐀obj$ # comment\n éfi", "𐐀obj", "éfi"],
    ["`a[b`$fi", "`a[b`", "fi"],
    ["df[obj$fi", "obj", "fi"],
    ["obj$`a\\`b`$fi", "obj$`a\\`b`", "fi"],
  ]) {
    const line = input.split("\n").at(-1);
    const context = completion.getCompletionContext(line, line.length, input);
    assert.equal(context.kind, "member", input);
    assert.equal(context.prefix, prefix, input);
    assert.equal(context.replaceStart, line.length - prefix.length, input);
    assert.equal(context.chainedBracket, false, input);
    let requests = 0;
    await completion.collectCompletionEntries(context, undefined, undefined, undefined, [], [], undefined,
      async expression => { requests++; assert.equal(expression, objectName, input); return []; });
    assert.equal(requests, 1, input);
  }
});

test("subscript member detection preserves base-object lookup without evaluating indices", async () => {
  const input = "obj[[stop('must not execute')]]$fi";
  const context = completion.getCompletionContext(input, input.length);
  assert.equal(context.kind, "member");
  assert.equal(context.chainedBracket, true);
  await completion.collectCompletionEntries(context, undefined, undefined, undefined, [], [], undefined,
    async expression => { assert.equal(expression, "obj"); return []; });
});

test("member-like text in literals and comments does not request runtime members", async () => {
  for (const input of ['"obj$fi', 'r"(obj$fi)', "# obj$fi", "obj$ # fi", "obj$`fi"]) {
    const context = completion.getCompletionContext(input, input.length);
    assert.notEqual(context?.kind, "member", input);
    if (!context) continue;
    await completion.collectCompletionEntries(context, undefined, undefined, undefined, [], [], undefined,
      async () => { assert.fail(`unexpected runtime lookup for ${input}`); });
  }
});

test("missing session formals never fall back to arguments of a same-name global function", async () => {
  const input = "obj@lm(";
  const context = completion.getCompletionContext(input, input.length);
  for (const request of [undefined, async () => undefined, async () => [], async () => { throw Error("disconnected"); }]) {
    const entries = await completion.collectCompletionEntries(context, { getText: () => input },
      { line: 0, character: input.length }, undefined, [], [], {
        provideCompletionItems: async () => [
          { label: "formula", insertText: "formula = ", kind: 5, detail: "parameter" },
          { label: "value", insertText: "value", kind: 5, detail: "value for formula" },
        ],
      }, request);
    assert.deepEqual(entries, []);
  }
});

test("member value completion keeps variables but never requests or inserts parameter names", async () => {
  for (const operator of ["$", "@"]) {
    for (const tail of ["first = fir", "1 + fir", '"fir', "# fir", "`fir", 'r"--(fir']) {
      const input = `obj${operator}fun(${tail}`;
      const context = completion.getCompletionContext(input, input.length);
      let requests = 0;
      const entries = await completion.collectCompletionEntries(context, { getText: () => input },
        { line: 0, character: input.length }, { globalenv: { first_value: {} } }, [], [], {
          provideCompletionItems: async () => [
            { label: "first", insertText: "first = ", kind: 5, detail: "parameter" },
          ],
        }, async () => { requests++; return [{ name: "first" }]; });
      assert.equal(requests, context.argumentValue ? 1 : 0, input);
      assert.ok(entries.some(entry => entry.insertText === "first_value"), input);
      assert.ok(entries.every(entry => entry.detail !== "parameter" && !entry.insertText.endsWith(" = ")), input);
    }
  }
});

test("completion passes supplied argument tags without copying user expressions into the runtime probe", async () => {
  const input = "obj$fun(first = stop('do not execute'), sec, third = system('do not execute'))";
  const cursor = input.indexOf("sec") + 3;
  const context = completion.getCompletionContext(input, cursor);
  await completion.collectCompletionEntries(context, undefined, undefined, undefined, [], [], undefined,
    async expression => {
      assert.ok(expression.includes("base::quote(.fn(first = NULL, TRUE, third = NULL))"));
      assert.ok(!expression.includes("do not execute"));
      return [];
    });
});

test("call detection stays responsive with long quoted member chains", { timeout: 3000 }, () => {
  // The former suffix regex takes several seconds at this size. Keep a generous
  // bound for loaded CI machines while catching its quadratic backtracking.
  const input = 'x <- "' + "a$".repeat(30000) + '"; obj$fun(';
  const start = performance.now();
  const context = completion.getCompletionContext(input, input.length);
  assert.equal(context.functionName, "obj$fun");
  assert.ok(performance.now() - start < 1500);
});

test("same-name functions keep their selected package through the picker without changing inserted text", async () => {
  const context = completion.getCompletionContext("filt", 4);
  const entries = await completion.collectCompletionEntries(
    context, { getText: () => "filt" }, { line: 0, character: 4 }, undefined, [], [],
    { provideCompletionItems: async () => [
      { label: "filter", insertText: "filter()", kind: 2, detail: "{stats}", data: { type: "function", package: "stats" } },
      { label: "filter", insertText: "filter()", kind: 2, detail: "{dplyr}", data: { type: "function", package: "dplyr" } },
    ] }
  );
  assert.equal(entries.length, 2);
  const picks = entries.map((entry) => completion.toCompletionPick(entry, context));
  assert.deepEqual(picks.map((pick) => pick.packageName), ["stats", "dplyr"]);
  assert.ok(picks.every((pick) => pick.insertText === "filter()"));
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
  for (const [input, expected] of [["df[", '"a b"'], ["df[[", '"a b"'], ['df[["', "a b"]]) {
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined, workspace, []);
    assert.equal(entries.find((entry) => entry.label === "a b").insertText, expected);
    assert.equal(entries.filter((entry) => entry.label === "alpha").length, 1);
  }
});

test("unquoted subscripts retain variable indices while quoted subscripts suggest only names", async () => {
  const workspace = { globalenv: { lst: { names: ["indigo", "beta"] }, index: { type: "integer" } } };
  for (const operator of ["[", "[["]) {
    for (const quote of ["", '"', "'"]) {
      const input = `lst${operator}${quote}ind`;
      const context = completion.getCompletionContext(input, input.length);
      const entries = await completion.collectCompletionEntries(
        context, undefined, undefined, workspace, [], ["index_from_history <- 1"]
      );
      assert.deepEqual(entries.map(entry => entry.insertText), quote
        ? ["indigo"]
        : ['"indigo"', "index", "index_from_history"], input);
    }
  }
});

class Position {
  constructor(line, character) { Object.assign(this, { line, character }); }
}
const { VirtualRDocument } = loadSource("src/Language/virtualRDocument.ts", {
  vscode: { Position, Uri: { parse: (value) => ({ toString: () => value }) } },
});

function select(document, input, start, text, packageName) {
  document.update(input);
  document.selectFunction(start, text, packageName);
}

test("selected packages qualify only virtual calls and map multiline UTF-16 positions", () => {
  const selections = new VirtualRDocument("test");
  const input = 'x <- "😀"; filter(\n  filter(x)\n)';
  select(selections, input, input.indexOf("filter"), "filter()", "stats");
  select(selections, input, input.lastIndexOf("filter"), "filter()", "dplyr");
  const projection = selections.project(input);
  assert.equal(projection.document.getText(), 'x <- "😀"; stats::filter(\n  dplyr::filter(x)\n)');
  for (const position of [new Position(0, 0), new Position(0, 18), new Position(1, 9), new Position(2, 1)]) {
    assert.deepEqual(projection.toConsolePosition(projection.toServerPosition(position)), position);
  }
  assert.deepEqual(projection.toServerPosition(new Position(1, 9)), new Position(1, 16));
  assert.deepEqual(projection.toConsolePosition(new Position(1, 4)), new Position(1, 2));
});

test("selections follow edits outside names and expire when names or qualification change", () => {
  const selections = new VirtualRDocument("test");
  select(selections, "filter()", 0, "filter()", "stats");
  selections.update("result <- filter()");
  selections.update("result <- filter(x, sides = 1)");
  assert.equal(selections.project("result <- filter(x, sides = 1)").document.getText(), "result <- stats::filter(x, sides = 1)");
  selections.update("result <- filte(x, sides = 1)");
  selections.update("result <- filter(x, sides = 1)");
  assert.equal(selections.project("result <- filter(x, sides = 1)").document.getText(), "result <- filter(x, sides = 1)");

  for (const input of ["dplyr::filter()", "obj$filter()", '"filter()"', 'r"---(filter())---"', "# filter()", "filtering()"]) {
    selections.update("");
    select(selections, "filter()", 0, "filter()", "stats");
    selections.update(input);
    assert.equal(selections.project(input).document.getText(), input);
  }
});

test("picker previews do not overwrite the actual input's package choices", () => {
  const selections = new VirtualRDocument("test");
  select(selections, "filter()", 0, "filter()", "stats");
  const first = selections.project("filter()");
  assert.equal(selections.project("filter(si)").document.getText(), "stats::filter(si)");
  assert.equal(selections.project("filter()").document.getText(), "stats::filter()");
  select(selections, "filter()", 0, "filter()", "dplyr");
  const next = selections.project("filter()");
  assert.equal(next.document.getText(), "dplyr::filter()");
  assert.ok(next.document.version > first.document.version);
  assert.equal(first.document.getText(), "stats::filter()");
  selections.update("");
  assert.equal(selections.project("filter()").document.getText(), "filter()");
});

test("a selected function without a call is qualified once its parentheses are typed", () => {
  const selections = new VirtualRDocument("test");
  select(selections, "filter", 0, "filter", "stats");
  assert.equal(selections.project("filter").document.getText(), "filter");
  selections.update("filter(");
  assert.equal(selections.project("filter(").document.getText(), "stats::filter(");
  select(selections, "stats::filter()", 7, "filter()", "stats");
  assert.equal(selections.project("stats::filter()").document.getText(), "stats::filter()");
});

test("package selections respect call continuations and qualification across comments", () => {
  for (const [input, expected] of [
    ["outer(filter # comment\n(1))", "outer(stats::filter # comment\n(1))"],
    ["x[filter\n(1)]", "x[stats::filter\n(1)]"],
    ["filter\n(1)", "filter\n(1)"],
    ["outer({ filter\n(1) })", "outer({ filter\n(1) })"],
    ["outer(obj$ # comment\nfilter(1))", "outer(obj$ # comment\nfilter(1))"],
    ["dplyr:: # comment\nfilter(1)", "dplyr:: # comment\nfilter(1)"],
  ]) {
    const selections = new VirtualRDocument("test");
    select(selections, input, input.indexOf("filter"), "filter", "stats");
    assert.equal(selections.project(input).document.getText(), expected, input);
  }
});

test("the LSP client sends qualified input and maps both completion range formats back", async (t) => {
  class Range {
    constructor(start, end) { Object.assign(this, { start, end }); }
  }
  const vscode = {
    Position, Range,
    Uri: { parse: (value) => ({ toString: () => value }) },
    window: { createOutputChannel: () => ({ dispose() {} }) },
    CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1 },
  };
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode,
    "vscode-languageclient/node": {
      LanguageClient: class {},
      CompletionRequest: { type: "completion" },
      DidOpenTextDocumentNotification: { type: "open" },
      DidChangeTextDocumentNotification: { type: "change" },
      DidCloseTextDocumentNotification: { type: "close" },
    },
  });
  const input = "filter() + filter(si)";
  const client = new ConsoleLspClient({ consoleId: "client-test", env: {} });
  t.after(() => client.dispose());
  client.recordCompletion(input, 0, { insertText: "filter()", packageName: "stats" });
  client.recordCompletion(input, 11, { insertText: "filter(si)", packageName: "dplyr" });
  const synced = [];
  client.client = {
    isRunning: () => true,
    code2ProtocolConverter: {
      asOpenTextDocumentParams: (doc) => ({ text: doc.getText(), version: doc.version }),
      asChangeTextDocumentParams: (doc) => ({ text: doc.getText(), version: doc.version }),
      asCloseTextDocumentParams: () => ({}),
      asCompletionParams: (doc, position) => ({ text: doc.getText(), position }),
    },
    protocol2CodeConverter: { asCompletionResult: async (result) => result },
    sendNotification: async (method, params) => { if (method !== "close") synced.push(params); },
    sendRequest: async (method, params) => {
      if (method === "rConsole/checkPackageChanges") {
        assert.deepEqual(params.packages, ["stats", "dplyr"]);
        return [];
      }
      assert.equal(method, "completion");
      assert.equal(params.text, "stats::filter() + dplyr::filter(si)");
      assert.deepEqual(params.rConsoleArgumentTags, [null], "the current argument stays eligible for completion");
      assert.deepEqual(params.position, new Position(0, 34));
      const range = new Range(new Position(0, 32), new Position(0, 34));
      return { isIncomplete: false, items: [
        { label: "first", range },
        { label: "second", range: { inserting: range, replacing: range } },
      ] };
    },
    stop: async () => {},
    dispose: async () => {},
  };
  const doc = { getText: () => input };
  await client.prepareDocument(doc);
  const result = await client.provideCompletionItems(doc, new Position(0, 20));
  assert.equal(synced.length, 1);
  const expected = new Range(new Position(0, 18), new Position(0, 20));
  assert.deepEqual(result.items[0].range, expected);
  assert.deepEqual(result.items[1].range, { inserting: expected, replacing: expected });

  client.recordCompletion(input, 0, { insertText: "filter()", packageName: "dplyr" });
  await client.prepareDocument(doc);
  assert.equal(synced[1].text, "dplyr::filter() + dplyr::filter(si)");
  assert.ok(synced[1].version > synced[0].version);
  assert.equal(doc.getText(), input);
});


test("package change restarts the console language server before completion", async (t) => {
  class TestPosition {
    constructor(line, character) {
      Object.assign(this, { line, character });
    }
  }
  class TestVirtualRDocument {
    project() {
      return {
        document: { getText: () => "foo::bar", version: 1 },
        toServerPosition: (position) => position,
        toConsolePosition: (position) => position,
      };
    }
    update() {}
    selectFunction() {}
  }
  const vscode = {
    Position: TestPosition,
    Range: class Range {},
    Uri: { parse: (value) => ({ toString: () => value }) },
    window: { createOutputChannel: () => ({ dispose() {} }) },
    CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1 },
  };
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode,
    "./virtualRDocument": { VirtualRDocument: TestVirtualRDocument },
    "vscode-languageclient/node": {
      LanguageClient: class {},
      CompletionRequest: { type: "completion" },
      DidOpenTextDocumentNotification: { type: "open" },
      DidChangeTextDocumentNotification: { type: "change" },
      DidCloseTextDocumentNotification: { type: "close" },
    },
  });
  const client = new ConsoleLspClient({
    consoleId: "package-refresh-test",
    extensionPath: "",
    rPath: "R",
    env: {},
  });
  t.after(() => client.dispose());

  const firstClient = {
    isRunning: () => true,
    sendRequest: async (method, params) => {
      assert.equal(method, "rConsole/checkPackageChanges");
      assert.deepEqual(params.packages, ["foo"]);
      return ["foo"];
    },
    stop: async () => {},
    dispose: async () => {},
  };
  const secondClient = {
    isRunning: () => true,
    code2ProtocolConverter: { asCompletionParams: () => ({}) },
    protocol2CodeConverter: { asCompletionResult: async (result) => result },
    sendRequest: async (method) => {
      if (method === "rConsole/checkPackageChanges") {
        return [];
      }
      assert.equal(method, "completion");
      return [{ label: "new" }];
    },
    stop: async () => {},
    dispose: async () => {},
  };
  client.client = firstClient;
  client.syncDocument = async () => {};
  client.applySessionState = async () => {};

  let stops = 0;
  let starts = 0;
  client.stop = async () => {
    stops += 1;
    client.client = undefined;
    return true;
  };
  client.startClient = async () => {
    starts += 1;
    client.client = secondClient;
    client.lastPackageCheckAt = 0;
  };

  const result = await client.provideCompletionItems(
    { getText: () => "foo::bar" },
    new TestPosition(0, 8)
  );
  assert.deepEqual(result, [{ label: "new" }]);
  assert.equal(stops, 1);
  assert.equal(starts, 1);
});


test("concurrent package change checks share the in-flight request", async (t) => {
  const vscode = {
    Position,
    Uri: { parse: (value) => ({ toString: () => value }) },
    window: { createOutputChannel: () => ({ dispose() {} }) },
  };
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode,
    "vscode-languageclient/node": {
      LanguageClient: class {},
      CompletionRequest: { type: "completion" },
      DidOpenTextDocumentNotification: { type: "open" },
      DidChangeTextDocumentNotification: { type: "change" },
      DidCloseTextDocumentNotification: { type: "close" },
    },
  });
  const client = new ConsoleLspClient({
    consoleId: "package-refresh-concurrency-test",
    extensionPath: "",
    rPath: "R",
    env: {},
  });
  t.after(() => client.dispose());

  let checks = 0;
  let resolveCheck;
  const languageClient = {
    isRunning: () => true,
    sendRequest: (method, params) => {
      assert.equal(method, "rConsole/checkPackageChanges");
      assert.deepEqual(params.packages, ["foo"]);
      checks += 1;
      return new Promise((resolve) => {
        resolveCheck = resolve;
      });
    },
    stop: async () => {},
    dispose: async () => {},
  };
  client.client = languageClient;

  const first = client.packageChangesDetected(languageClient, "foo::bar");
  await new Promise((resolve) => setImmediate(resolve));
  const second = client.packageChangesDetected(languageClient, "foo::bar");

  assert.equal(checks, 1);
  resolveCheck(["foo"]);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});


test("package change checks are throttled across rapid completions", async (t) => {
  class TestPosition {
    constructor(line, character) {
      Object.assign(this, { line, character });
    }
  }
  class TestVirtualRDocument {
    project() {
      return {
        document: { getText: () => "foo::bar", version: 1 },
        toServerPosition: (position) => position,
        toConsolePosition: (position) => position,
      };
    }
    update() {}
    selectFunction() {}
  }
  const vscode = {
    Position: TestPosition,
    Range: class Range {},
    Uri: { parse: (value) => ({ toString: () => value }) },
    window: { createOutputChannel: () => ({ dispose() {} }) },
    CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1 },
  };
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode,
    "./virtualRDocument": { VirtualRDocument: TestVirtualRDocument },
    "vscode-languageclient/node": {
      LanguageClient: class {},
      CompletionRequest: { type: "completion" },
      DidOpenTextDocumentNotification: { type: "open" },
      DidChangeTextDocumentNotification: { type: "change" },
      DidCloseTextDocumentNotification: { type: "close" },
    },
  });
  const client = new ConsoleLspClient({
    consoleId: "package-refresh-throttle-test",
    extensionPath: "",
    rPath: "R",
    env: {},
  });
  t.after(() => client.dispose());
  client.syncDocument = async () => {};
  client.applySessionState = async () => {};

  let checks = 0;
  let completions = 0;
  client.client = {
    isRunning: () => true,
    code2ProtocolConverter: { asCompletionParams: () => ({}) },
    protocol2CodeConverter: { asCompletionResult: async (result) => result },
    sendRequest: async (method) => {
      if (method === "rConsole/checkPackageChanges") {
        checks += 1;
        return [];
      }
      completions += 1;
      return [];
    },
    stop: async () => {},
    dispose: async () => {},
  };

  const doc = { getText: () => "foo::bar" };
  await client.provideCompletionItems(doc, new TestPosition(0, 8));
  await client.provideCompletionItems(doc, new TestPosition(0, 8));

  assert.equal(checks, 1);
  assert.equal(completions, 2);
});


test("language-server completion starts before a fresh workspace request finishes", async () => {
  let resolveWorkspace;
  let lspCompletionStarted = false;
  const workspaceRequest = new Promise((resolve) => {
    resolveWorkspace = resolve;
  });
  class TestPosition {
    constructor(line, character) {
      Object.assign(this, { line, character });
    }
  }
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: { Position: TestPosition },
    "../../Language/completion": {
      getCompletionContext: (input, cursor) => ({
        kind: "default",
        prefix: input.slice(0, cursor),
        replaceStart: 0,
        snapshotInput: input,
        snapshotCursor: cursor,
      }),
      collectCompletionEntries: async (
        _context,
        _document,
        _position,
        _sessionData,
        _linesBefore,
        _recentEntries,
        completionProvider
      ) => {
        if (completionProvider) {
          await completionProvider.provideCompletionItems();
        }
        return [];
      },
      getCompletionIdentityKey: () => "",
      isCompletionPickItem: () => false,
      rankCompletionEntries: completion.rankCompletionEntries,
      toCompletionQuickPickItems: () => [],
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({
    extensionPath: "",
    rPath: "R",
    env: {},
    requestWorkspaceData: () => workspaceRequest,
    requestMemberCompletions: async () => [],
  });
  lang.ensureConsoleLspStarted = async () => ({
    provideCompletionItems: async () => {
      lspCompletionStarted = true;
      return [];
    },
  });
  lang.getOrOpenCompletionDocument = async () => ({});
  const input = {
    text: "mea",
    currentLine: "mea",
    cursorCol: 3,
    cursorRow: 0,
    lines: ["mea"],
    textBeforeCursor: "mea",
  };
  const request = lang.handleAutocomplete({
    input,
    getCurrentInput: () => input,
    getWorkspaceData: () => undefined,
    applyCompletion: () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lspCompletionStarted, true);
  await request;

  resolveWorkspace({ search: [], loaded_namespaces: [], globalenv: {} });
});


test("member and package completions do not refresh workspace data", async () => {
  class TestPosition {
    constructor(line, character) {
      Object.assign(this, { line, character });
    }
  }
  const contexts = new Map([
    ["obj$", {
      kind: "member", prefix: "", replaceStart: 4, operator: "$", objectName: "obj",
      snapshotInput: "obj$", snapshotCursor: 4,
    }],
    ["obj@", {
      kind: "member", prefix: "", replaceStart: 4, operator: "@", objectName: "obj",
      snapshotInput: "obj@", snapshotCursor: 4,
    }],
    ["stats::", {
      kind: "package", prefix: "", replaceStart: 7, triggerCharacter: ":",
      snapshotInput: "stats::", snapshotCursor: 7,
    }],
  ]);
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: { Position: TestPosition },
    "../../Language/completion": {
      getCompletionContext: (input) => contexts.get(input),
      collectCompletionEntries: async () => [],
      getCompletionIdentityKey: () => "",
      isCompletionPickItem: () => false,
      rankCompletionEntries: completion.rankCompletionEntries,
      toCompletionQuickPickItems: () => [],
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({
    extensionPath: "",
    rPath: "R",
    env: {},
    requestWorkspaceData: async () => {
      throw new Error("workspace request should not run");
    },
    requestMemberCompletions: async () => [],
  });
  lang.ensureConsoleLspStarted = async () => ({
    provideCompletionItems: async () => [],
  });
  lang.getOrOpenCompletionDocument = async () => ({});

  for (const text of contexts.keys()) {
    const input = {
      text,
      currentLine: text,
      cursorCol: text.length,
      cursorRow: 0,
      lines: [text],
      textBeforeCursor: text,
    };
    await lang.handleAutocomplete({
      input,
      getCurrentInput: () => input,
      getWorkspaceData: () => undefined,
      applyCompletion: () => {},
    });
  }
});


test("F7 refinement starts language-server completion before workspace refresh finishes", async () => {
  let resolveWorkspace;
  const workspaceRequest = new Promise((resolve) => {
    resolveWorkspace = resolve;
  });
  let refinedCompletionStarted = false;
  let changeValue;
  let hide;
  class TestPosition {
    constructor(line, character) {
      Object.assign(this, { line, character });
    }
  }
  const quickPick = {
    items: [],
    activeItems: [],
    value: "",
    onDidChangeValue: (listener) => {
      changeValue = listener;
    },
    onDidAccept: () => {},
    onDidHide: (listener) => {
      hide = listener;
    },
    show: () => {},
    hide: () => {
      hide?.();
    },
    dispose: () => {},
  };
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {
      Position: TestPosition,
      QuickPickItemKind: { Separator: -1 },
      window: { createQuickPick: () => quickPick },
    },
    "../../Language/completion": {
      getCompletionContext: (input, cursor) => input.length === 0
        ? undefined
        : {
            kind: "default",
            prefix: input.slice(0, cursor),
            replaceStart: 0,
            snapshotInput: input,
            snapshotCursor: cursor,
          },
      collectCompletionEntries: async (context) => {
        if (context.prefix === "f") {
          refinedCompletionStarted = true;
        }
        return [];
      },
      getCompletionIdentityKey: () => "",
      isCompletionPickItem: () => false,
      rankCompletionEntries: completion.rankCompletionEntries,
      toCompletionQuickPickItems: () => [],
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({
    extensionPath: "",
    rPath: "R",
    env: {},
    requestWorkspaceData: () => workspaceRequest,
    requestMemberCompletions: async () => [],
  });
  lang.ensureConsoleLspStarted = async () => ({
    provideCompletionItems: async () => [],
  });
  lang.getOrOpenCompletionDocument = async () => ({});

  const input = {
    text: "",
    currentLine: "",
    cursorCol: 0,
    cursorRow: 0,
    lines: [""],
    textBeforeCursor: "",
  };
  const request = lang.handleAutocomplete({
    input,
    getCurrentInput: () => input,
    getWorkspaceData: () => undefined,
    force: true,
    applyCompletion: () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  changeValue("f");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refinedCompletionStarted, true);

  quickPick.hide();
  await request;
  resolveWorkspace({ search: [], loaded_namespaces: [], globalenv: {} });
});


test("package completion filters locally without repeated language-server requests", async () => {
  let completionCalls = 0;
  let changeValue;
  let hide;
  class TestPosition {
    constructor(line, character) {
      Object.assign(this, { line, character });
    }
  }
  const quickPick = {
    items: [],
    activeItems: [],
    value: "",
    onDidChangeValue: (listener) => {
      changeValue = listener;
    },
    onDidAccept: () => {},
    onDidHide: (listener) => {
      hide = listener;
    },
    show: () => {},
    hide: () => {
      hide?.();
    },
    dispose: () => {},
  };
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {
      Position: TestPosition,
      QuickPickItemKind: { Separator: -1 },
      window: { createQuickPick: () => quickPick },
    },
    "../../Language/completion": {
      getCompletionContext: () => ({
        kind: "package",
        prefix: "",
        replaceStart: 7,
        triggerCharacter: ":",
        snapshotInput: "stats::",
        snapshotCursor: 7,
      }),
      collectCompletionEntries: async () => {
        completionCalls += 1;
        return [{
          label: "filter",
          insertText: "filter",
          source: "lsp",
        }];
      },
      getCompletionIdentityKey: (entry) => entry.label,
      isCompletionPickItem: () => false,
      rankCompletionEntries: completion.rankCompletionEntries,
      toCompletionQuickPickItems: (entries) => entries,
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({
    extensionPath: "",
    rPath: "R",
    env: {},
    requestWorkspaceData: async () => {
      throw new Error("workspace request should not run");
    },
    requestMemberCompletions: async () => [],
  });
  lang.ensureConsoleLspStarted = async () => ({
    provideCompletionItems: async () => [],
  });
  lang.getOrOpenCompletionDocument = async () => ({});

  const input = {
    text: "stats::",
    currentLine: "stats::",
    cursorCol: 7,
    cursorRow: 0,
    lines: ["stats::"],
    textBeforeCursor: "stats::",
  };
  const request = lang.handleAutocomplete({
    input,
    getCurrentInput: () => input,
    getWorkspaceData: () => undefined,
    applyCompletion: () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completionCalls, 1);
  for (const value of ["f", "fi", "fil", "filt"]) {
    changeValue(value);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completionCalls, 1);

  quickPick.hide();
  await request;
});


test("runtime column completion runs only after the language server cannot supply fields", async () => {
  let resolveLsp;
  const lspResult = new Promise((resolve) => {
    resolveLsp = resolve;
  });
  let runtimeStarted = false;
  const context = {
    kind: "argument",
    prefix: "",
    replaceStart: 7,
    functionName: "filter",
    dataObjectName: "df",
    snapshotInput: "filter(",
    snapshotCursor: 7,
  };
  const workspace = {
    search: [],
    loaded_namespaces: [],
    globalenv: { df: { names: [] } },
  };
  const request = completion.collectCompletionEntries(
    context,
    { getText: () => "filter(" },
    { line: 0, character: 7 },
    workspace,
    [],
    [],
    { provideCompletionItems: () => lspResult },
    async (expression, operator) => {
      assert.equal(expression, "df");
      assert.equal(operator, "$");
      runtimeStarted = true;
      return [{ name: "alpha" }];
    }
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeStarted, false);

  resolveLsp([]);
  const entries = await request;
  assert.equal(runtimeStarted, true);
  assert.ok(entries.some((entry) => entry.label === "alpha"));
});


test("session state sync deduplicates concurrent requests and applies newer state once", async (t) => {
  const vscode = {
    Position,
    Uri: { parse: (value) => ({ toString: () => value }) },
    window: { createOutputChannel: () => ({ dispose() {} }) },
  };
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode,
    "vscode-languageclient/node": {
      LanguageClient: class {},
      CompletionRequest: { type: "completion" },
      DidOpenTextDocumentNotification: { type: "open" },
      DidChangeTextDocumentNotification: { type: "change" },
      DidCloseTextDocumentNotification: { type: "close" },
    },
  });
  const client = new ConsoleLspClient({ consoleId: "session-sync-test", env: {} });
  t.after(() => client.dispose());

  const requests = [];
  const resolvers = [];
  client.client = {
    isRunning: () => true,
    sendRequest: (method, params) => {
      assert.equal(method, "rConsole/syncSessionState");
      requests.push(params);
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    },
    stop: async () => {},
    dispose: async () => {},
  };

  const firstState = {
    attachedPackages: ["package:stats"],
  };
  const nextState = {
    attachedPackages: ["package:dplyr", "package:stats"],
  };

  const first = client.syncSessionState(firstState);
  const duplicate = client.syncSessionState(firstState);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], firstState);

  const newer = client.syncSessionState(nextState);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);

  resolvers.shift()(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], nextState);

  resolvers.shift()(true);
  await Promise.all([first, duplicate, newer]);
  assert.equal(requests.length, 2);

  await client.syncSessionState(nextState);
  assert.equal(requests.length, 2);
});


test("failed session state sync still applies a newer pending state", async (t) => {
  const vscode = {
    Position,
    Uri: { parse: (value) => ({ toString: () => value }) },
    window: { createOutputChannel: () => ({ dispose() {} }) },
  };
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode,
    "vscode-languageclient/node": {
      LanguageClient: class {},
      CompletionRequest: { type: "completion" },
      DidOpenTextDocumentNotification: { type: "open" },
      DidChangeTextDocumentNotification: { type: "change" },
      DidCloseTextDocumentNotification: { type: "close" },
    },
  });
  const client = new ConsoleLspClient({ consoleId: "session-sync-failure-test", env: {} });
  t.after(() => client.dispose());

  const requests = [];
  const pending = [];
  client.client = {
    isRunning: () => true,
    sendRequest: (method, params) => {
      assert.equal(method, "rConsole/syncSessionState");
      requests.push(params);
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    stop: async () => {},
    dispose: async () => {},
  };

  const firstState = {
    attachedPackages: ["stats"],
  };
  const nextState = {
    attachedPackages: ["dplyr", "stats"],
  };

  const first = client.syncSessionState(firstState);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);

  const newer = client.syncSessionState(nextState);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);

  pending.shift().reject(new Error("sync failed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], nextState);

  pending.shift().resolve(true);
  await Promise.all([first, newer]);

  await client.syncSessionState(nextState);
  assert.equal(requests.length, 2);
});


test("failed session state sync does not immediately retry the same state", async (t) => {
  const vscode = {
    Position,
    Uri: { parse: (value) => ({ toString: () => value }) },
    window: { createOutputChannel: () => ({ dispose() {} }) },
  };
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode,
    "vscode-languageclient/node": {
      LanguageClient: class {},
      CompletionRequest: { type: "completion" },
      DidOpenTextDocumentNotification: { type: "open" },
      DidChangeTextDocumentNotification: { type: "change" },
      DidCloseTextDocumentNotification: { type: "close" },
    },
  });
  const client = new ConsoleLspClient({ consoleId: "session-sync-same-failure-test", env: {} });
  t.after(() => client.dispose());

  let requests = 0;
  client.client = {
    isRunning: () => true,
    sendRequest: async () => {
      requests += 1;
      throw new Error("sync failed");
    },
    stop: async () => {},
    dispose: async () => {},
  };

  await client.syncSessionState({
    attachedPackages: ["stats"],
  });
  assert.equal(requests, 1);
});


test("namespace-only session changes do not resync the language server", () => {
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {},
    "../../Language/completion": {
      getCompletionContext: () => undefined,
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({
    extensionPath: "",
    rPath: "R",
    env: {},
    requestMemberCompletions: async () => [],
  });
  const states = [];
  lang.consoleLsp = {
    syncSessionState: (state) => {
      states.push(state);
      return Promise.resolve();
    },
  };

  assert.equal(lang.updateSessionData({
    search: [".GlobalEnv", "package:stats", "package:base"],
    loaded_namespaces: ["base", "stats"],
    globalenv: {},
  }), true);
  assert.deepEqual(states, [{
    attachedPackages: ["stats", "base"],
  }]);

  assert.equal(lang.updateSessionData({
    search: [".GlobalEnv", "package:stats", "package:base"],
    loaded_namespaces: ["base", "stats", "methods"],
    globalenv: {},
  }), false);
  assert.equal(states.length, 1);

  assert.equal(lang.updateSessionData({
    search: [".GlobalEnv", "package:dplyr", "package:stats", "package:base"],
    loaded_namespaces: ["base", "stats", "methods", "dplyr"],
    globalenv: {},
  }), true);
  assert.deepEqual(states[1], {
    attachedPackages: ["dplyr", "stats", "base"],
  });
});


test("completion entries preserve incomplete language-server results", async () => {
  const context = completion.getCompletionContext("stats::", 7);
  const entries = await completion.collectCompletionEntries(
    context,
    { getText: () => "stats::" },
    { line: 0, character: 7 },
    undefined,
    [],
    [],
    {
      provideCompletionItems: async () => ({
        isIncomplete: true,
        items: [{
          label: "filter",
          insertText: "filter",
          kind: 2,
          detail: "{stats}",
        }],
      }),
    }
  );

  assert.equal(entries.isIncomplete, true);
  assert.ok(entries.some((entry) => entry.label === "filter"));
});

test("incomplete package completion re-queries until a complete result arrives", async () => {
  let completionCalls = 0;
  let changeValue;
  let hide;
  class TestPosition {
    constructor(line, character) {
      Object.assign(this, { line, character });
    }
  }
  const quickPick = {
    items: [],
    activeItems: [],
    value: "",
    onDidChangeValue: (listener) => {
      changeValue = listener;
    },
    onDidAccept: () => {},
    onDidHide: (listener) => {
      hide = listener;
    },
    show: () => {},
    hide: () => {
      hide?.();
    },
    dispose: () => {},
  };
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {
      Position: TestPosition,
      QuickPickItemKind: { Separator: -1 },
      window: { createQuickPick: () => quickPick },
    },
    "../../Language/completion": {
      getCompletionContext: () => ({
        kind: "package",
        prefix: "",
        replaceStart: 7,
        triggerCharacter: ":",
        snapshotInput: "stats::",
        snapshotCursor: 7,
      }),
      collectCompletionEntries: async (context) => {
        completionCalls += 1;
        const entries = [{
          label: context.prefix ? "filter" : "median",
          insertText: context.prefix ? "filter" : "median",
          source: "lsp",
        }];
        if (!context.prefix) {
          entries.isIncomplete = true;
        }
        return entries;
      },
      getCompletionIdentityKey: (entry) => entry.label,
      isCompletionPickItem: () => false,
      rankCompletionEntries: completion.rankCompletionEntries,
      toCompletionQuickPickItems: (entries) => entries,
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({
    extensionPath: "",
    rPath: "R",
    env: {},
    requestWorkspaceData: async () => {
      throw new Error("workspace request should not run");
    },
    requestMemberCompletions: async () => [],
  });
  lang.ensureConsoleLspStarted = async () => ({
    provideCompletionItems: async () => [],
  });
  lang.getOrOpenCompletionDocument = async () => ({});

  const input = {
    text: "stats::",
    currentLine: "stats::",
    cursorCol: 7,
    cursorRow: 0,
    lines: ["stats::"],
    textBeforeCursor: "stats::",
  };
  const request = lang.handleAutocomplete({
    input,
    getCurrentInput: () => input,
    getWorkspaceData: () => undefined,
    applyCompletion: () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completionCalls, 1);

  changeValue("f");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completionCalls, 2);

  for (const value of ["fi", "fil", "filt"]) {
    changeValue(value);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completionCalls, 2);

  changeValue("");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completionCalls, 2);

  quickPick.hide();
  await request;
});

test("empty namespace suggestions are alphabetical instead of following provider order", async () => {
  const labels = ["setorderv", "set", "rowwiseDT", "fdroplevels", "frankv", "as.IDate"];
  for (const operator of ["::", ":::"]) {
    const input = `data.table${operator}`;
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, { getText: () => input },
      { line: 0, character: input.length }, undefined, [], [], {
        provideCompletionItems: async () => labels.map(label => ({ label, kind: 2, sortText: `4-${label}` })),
      });
    const picks = completion.toCompletionQuickPickItems(completion.rankCompletionEntries(entries, ""), context);
    assert.equal(picks[0].label, "Package Members");
    assert.deepEqual(picks.slice(1).map(item => item.insertText),
      ["as.IDate()", "fdroplevels()", "frankv()", "rowwiseDT()", "set()", "setorderv()"]);
    assert.deepEqual(entries.map(entry => entry.label), labels, "sorting must not mutate cached candidates");
  }
});

test("symbol groups are alphabetical while arguments retain signature order and group priority", () => {
  const context = completion.getCompletionContext("fun(", 4);
  const entries = [
    { label: "zeta", detail: "parameter", source: "lsp", kind: 5 },
    { label: "zvar", source: "session", kind: 5 },
    { label: "zfun", source: "lsp", kind: 2 },
    { label: "afun", source: "lsp", kind: 2 },
    { label: "alpha", detail: "parameter", source: "lsp", kind: 5 },
    { label: "avar", source: "session", kind: 5 },
  ].map(entry => Object.freeze({ ...entry, insertText: entry.label }));
  const picks = completion.toCompletionQuickPickItems(
    completion.rankCompletionEntries(Object.freeze(entries), "", context), context);
  assert.deepEqual(picks.map(item => item.insertText ?? item.label), [
    "Arguments", "zeta", "alpha", "Runtime Variables", "avar", "zvar", "Functions", "afun", "zfun",
  ]);
});

test("argument and known-value filtering preserves declaration order", () => {
  for (const detail of ["parameter", "value for method"]) {
    const entries = ["zebra", "alpha", "beta"].map(label =>
      Object.freeze({ label, insertText: label, source: "lsp", detail }));
    const context = completion.getCompletionContext("fun(", 4);
    for (const query of ["", "a", "b"]) {
      assert.deepEqual(completion.rankCompletionEntries(Object.freeze(entries), query, context).map(e => e.label),
        query === "b" ? ["zebra", "beta"] : ["zebra", "alpha", "beta"]);
    }
  }
});

test("data contexts retain column order while ordinary symbols remain alphabetical", async () => {
  const names = ["zebra", "alpha", "beta"];
  for (const input of ["df[", "df[[", "df[, ", "subset(df, ", "df |> subset("]) {
    const context = completion.getCompletionContext(input, input.length, input);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      { globalenv: { df: { names }, zvar: {}, avar: {} } }, []);
    for (const query of ["", "a", "b"]) {
      const ranked = completion.rankCompletionEntries(entries, query, context);
      assert.deepEqual(ranked.filter(e => e.kind === 4).map(e => e.label),
        query === "b" ? ["zebra", "beta"] : names, input);
      const variables = ranked.filter(e => e.detail === "session").map(e => e.label);
      assert.deepEqual(variables, [...variables].sort(), input);
    }
    assert.deepEqual(entries.filter(e => e.kind === 4).map(e => e.label), names);
  }
});

test("dollar and slot members retain source order including callable members", async () => {
  for (const operator of ["$", "@"]) {
    const input = `obj${operator}`;
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined, undefined, [], [],
      undefined, async () => [
        { name: "zebra", type: "closure" }, { name: "alpha", type: "double" }, { name: "beta", type: "closure" },
      ]);
    for (const query of ["", "a", "b"]) {
      assert.deepEqual(completion.rankCompletionEntries(entries, query, context).map(e => e.label),
        query === "b" ? ["zebra", "beta"] : ["zebra", "alpha", "beta"]);
    }
  }
});

test("equal-quality matches use alphabetical order independently of provider order", () => {
  const entries = ["set", "fob", "Foa", "fo", "xfo"].map(label => ({ label, insertText: label, source: "lsp" }));
  for (const candidates of [entries, [...entries].reverse()]) {
    assert.deepEqual(completion.rankCompletionEntries(candidates, "fo").map(entry => entry.label),
      ["fo", "Foa", "fob", "xfo"]);
  }
});

test("shared typed ranking places exact matches before longer prefix matches", () => {
  const entries = [
    { label: "library.extra", insertText: "library.extra", source: "lsp" },
    { label: "library", insertText: "library()", source: "lsp" },
    { label: "librarySuffix", insertText: "librarySuffix", source: "session" },
    { label: "otherlibrary", insertText: "otherlibrary", source: "buffer" },
  ];
  assert.deepEqual(completion.rankCompletionEntries(entries, "library").map(e => e.label),
    ["library", "library.extra", "librarySuffix", "otherlibrary"]);
});

test("fuzzy ranking keeps exact, prefix, and contiguous matches ahead of abbreviations", async () => {
  const entries = ["read.csv", "other_rdcsv", "rdcsvLong", "rdcsv", "reversed"].map(label => ({
    label, insertText: label, source: "session",
  }));
  assert.deepEqual(completion.rankCompletionEntries(entries, "rdcsv").map(entry => entry.label),
    ["rdcsv", "rdcsvLong", "other_rdcsv", "read.csv"]);
  const context = completion.getCompletionContext("df$rdcsv", 8, "df$rdcsv");
  const result = await completion.collectCompletionEntries(context, undefined, undefined,
    { globalenv: { df: { names: ["read.csv", "wrong"] } } }, []);
  assert.deepEqual(result.map(entry => entry.label), ["read.csv"], "candidate collection must retain fuzzy matches");
});

test("match highlighting uses original UTF-16 offsets after case conversion", () => {
  const { completionMatch } = loadSource("src/Language/completionMatch.ts");
  assert.deepEqual(completionMatch("İx", "x"), [1]);
  assert.deepEqual(completionMatch("İx", "i\u0307"), [0]);
  assert.deepEqual(completionMatch("read.csv", "rdcsv"), [0, 3, 5, 6, 7]);
  assert.deepEqual(completionMatch("a😀value", "😀v"), [1, 2, 3]);
  assert.equal(completionMatch("read.csv", "csvread"), undefined);
});

test("inline cache rebases safe prefix refinements and refuses changed replacement contexts", async () => {
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: { Position },
    "../../Language/completion": { ...completion,
      collectCompletionEntries: async () => [
        { label: "alpha", insertText: "alpha", source: "session" },
        { label: "apricot", insertText: "apricot", source: "session" },
        { label: "alternate", insertText: "alternate", source: "lsp", replaceStart: 0 },
      ],
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const snapshot = (text, cursor = text.length) => {
    const before = text.slice(0, cursor);
    const lines = text.split("\n");
    const cursorRow = before.split("\n").length - 1;
    return { text, lines, cursorRow, cursorCol: before.split("\n").at(-1).length,
      currentLine: lines[cursorRow], textBeforeCursor: before };
  };
  const lang = new RTermLang({ extensionPath: "", rPath: "R", env: {}, requestMemberCompletions: async () => [] });
  const input = snapshot("x <- df$a");
  await lang.handleAutocomplete({ input, getCurrentInput: () => input, getWorkspaceData: () => undefined,
    applyCompletion() {}, onInlineEntries() {} });
  const refined = lang.refineInlineCompletion(snapshot("x <- df$al"));
  const choices = refined.filter(entry => "insertText" in entry);
  assert.deepEqual(choices.map(entry => entry.insertText), ["alpha"]);
  assert.equal(choices[0].snapshotInput, "x <- df$al");
  assert.equal(choices[0].snapshotCursor, 10);
  assert.equal(choices[0].replaceStart, 8);
  assert.equal(lang.refineInlineCompletion(snapshot("x <- xx$al")), undefined);
  assert.equal(lang.refineInlineCompletion(snapshot("x <- df$")), undefined);
  assert.equal(lang.refineInlineCompletion(snapshot("x <- df$al + 1", 10)), undefined);
  assert.equal(lang.refineInlineCompletion(snapshot("other\nx <- df$al")), undefined);
  lang.cancelCompletion();
  assert.equal(lang.refineInlineCompletion(snapshot("x <- df$al")), undefined);

  const argumentInput = snapshot("obj$fun(TRU");
  await lang.handleAutocomplete({ input: argumentInput, getCurrentInput: () => argumentInput,
    getWorkspaceData: () => undefined, applyCompletion() {}, onInlineEntries() {} });
  assert.equal(lang.refineInlineCompletion(snapshot("obj$fun(TRUE")), undefined,
    "a literal cannot reuse cached argument-name candidates");

  for (const text of ['df[["aold"]]', 'fun(method = "aold")']) {
    const cursor = text.indexOf("aold") + 1;
    const quotedInput = snapshot(text, cursor);
    await lang.handleAutocomplete({ input: quotedInput, getCurrentInput: () => quotedInput,
      getWorkspaceData: () => undefined, applyCompletion() {}, onInlineEntries() {} });
    const nextText = text.replace("aold", "alold");
    const next = lang.refineInlineCompletion(snapshot(nextText, cursor + 1))
      .filter(entry => "insertText" in entry);
    assert.deepEqual(next.map(entry => entry.insertText), ["alpha"]);
    assert.equal(next[0].replaceEnd, nextText.lastIndexOf('"'), "cached replacement ends move with typing");
    assert.equal(lang.refineInlineCompletion(snapshot(nextText.replace("old", "changed"), cursor + 1)), undefined);
  }
});

test("inline refresh, cached filtering and Quick Pick preserve semantic order", async () => {
  for (const text of ["df$", "obj@", "df[[", "df[, ", "subset(df, ", "df |> subset(",
    "fun(", "fun(method = ", "pkg::", "pkg:::"]) {
    let changeValue, hide;
    const pick = { items: [], value: "", onDidChangeValue: listener => { changeValue = listener; },
      onDidAccept() {}, onDidHide: listener => { hide = listener; },
      show() {}, hide() { hide?.(); }, dispose() {} };
    const entries = ["zebra", "alpha", "beta"].map(label => ({ label, insertText: label,
      source: "session", kind: 4,
      detail: text === "fun(" ? "parameter" : text === "fun(method = " ? "value for method" : "df" }));
    const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
      vscode: { Position, window: { createQuickPick: () => pick } },
      "../../Language/completion": { ...completion,
        collectCompletionEntries: async () => entries },
      "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
      "../../Language/virtualRDocument": { VirtualRDocument: class {} },
    });
    const lang = new RTermLang({ extensionPath: "", rPath: "R", env: {}, requestMemberCompletions: async () => [] });
    const snapshot = value => ({ text: value, currentLine: value, lines: [value], cursorRow: 0,
      cursorCol: value.length, textBeforeCursor: value });
    const input = snapshot(text);
    const request = { input, getCurrentInput: () => input, getWorkspaceData: () => undefined, applyCompletion() {} };
    const labels = items => items.filter(item => "insertText" in item).map(item => item.insertText);
    const ordered = text.startsWith("pkg:") ? ["alpha", "beta", "zebra"] : ["zebra", "alpha", "beta"];
    let published;
    await lang.handleAutocomplete({ ...request, onInlineEntries: items => { published = items; } });
    assert.deepEqual(labels(published), ordered, `inline: ${text}`);
    assert.deepEqual(labels(lang.refineInlineCompletion(snapshot(text + "b"))), ordered.filter(label => label.includes("b")),
      `cache: ${text}`);
    const showing = lang.handleAutocomplete(request);
    await new Promise(resolve => setImmediate(resolve));
    try {
      assert.equal(pick.sortByLabel, false);
      assert.deepEqual(labels(pick.items), ordered, `Quick Pick: ${text}`);
      pick.value = "b";
      changeValue("b");
      // Check both the immediate local filter and any asynchronous refresh.
      assert.deepEqual(labels(pick.items), ordered.filter(label => label.includes("b")), text);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(labels(pick.items), ordered.filter(label => label.includes("b")), text);
    } finally {
      pick.hide();
      await showing;
    }
  }
});

test("function argument completion awaits parameters before offering runtime variables", async () => {
  let finishLsp;
  const fullResult = new Promise(resolve => { finishLsp = resolve; });
  let stagedCalls = 0;
  const published = [];
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: { Position },
    "../../Language/completion": {
      getCompletionContext: () => ({
        kind: "argument", prefix: "na", replaceStart: 5,
        snapshotInput: "mean(na", snapshotCursor: 7,
      }),
      collectCompletionEntries: async (_context, document) => {
        if (!document) {
          stagedCalls++;
          return [{ label: "naive", insertText: "naive", source: "session" }];
        }
        return fullResult;
      },
      rankCompletionEntries: entries => entries,
      toCompletionQuickPickItems: entries => entries,
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({
    extensionPath: "", rPath: "R", env: {},
    requestWorkspaceData: async () => ({ globalenv: { naive: {} } }),
    requestMemberCompletions: async () => [],
  });
  lang.ensureConsoleLspStarted = async () => ({ provideCompletionItems: () => [] });
  lang.getOrOpenCompletionDocument = async () => ({});
  const input = {
    text: "mean(na", currentLine: "mean(na", cursorCol: 7,
    cursorRow: 0, lines: ["mean(na"], textBeforeCursor: "mean(na",
  };
  let completed = false;
  const request = lang.handleAutocomplete({
    input,
    getCurrentInput: () => input,
    getWorkspaceData: () => ({ globalenv: { naive: {} } }),
    applyCompletion: () => {},
    onInlineEntries: entries => published.push(entries),
  }).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, "wait for complete argument information");
  assert.equal(stagedCalls, 0, "runtime candidates must not be published before arguments");
  assert.deepEqual(published, []);
  finishLsp([{ label: "na.rm", insertText: "na.rm = ", detail: "parameter", source: "lsp" }]);
  await request;
  assert.equal(published.length, 1);
  assert.equal(published[0][0].label, "na.rm");
});

test("library path changes trigger console LSP state synchronization", () => {
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {},
    "../../Language/completion": {},
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({
    extensionPath: "", rPath: "R", env: {},
    requestMemberCompletions: async () => [],
  });
  const states = [];
  lang.consoleLsp = { syncSessionState: (state) => {
    states.push(state);
    return Promise.resolve();
  } };
  const data = { search: [".GlobalEnv", "package:stats"], loaded_namespaces: [],
    globalenv: {}, libraryPaths: ["/project/.uvr/library", "/base/library"] };
  assert.equal(lang.updateSessionData(data), true);
  assert.deepEqual(states[0], {
    attachedPackages: ["stats"],
    libraryPaths: data.libraryPaths,
  });
  assert.equal(lang.updateSessionData({ ...data }), false);
  assert.equal(lang.updateSessionData({
    ...data, libraryPaths: ["/another/library", "/base/library"],
  }), true);
  assert.equal(states.length, 2);
});

test("console LSP keeps configured libraries after live session libraries", async (t) => {
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode: {
      Uri: { parse: (value) => ({ toString: () => value }) },
      window: { createOutputChannel: () => ({ dispose() {} }) },
    },
    "vscode-languageclient/node": { LanguageClient: class {} },
  });
  const lsp = new ConsoleLspClient({
    consoleId: "library-env-test", env: {}, rPath: "R",
  });
  t.after(() => lsp.dispose());
  const config = { get: (key) => key === "libPaths" ? ["/fallback"] : false };
  assert.equal(lsp.buildServerEnv(config).VSCR_LIB_PATHS, "/fallback");
  lsp.sessionState = { attachedPackages: [], libraryPaths: ["/project/.uvr/library"] };
  const env = lsp.buildServerEnv(config);
  assert.equal(env.VSCR_LIB_PATHS, "/project/.uvr/library\n/fallback");
});

test("library-path restart serializes concurrent starts and applies the latest paths", async (t) => {
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode: {
      Uri: { parse: (value) => ({ toString: () => value }) },
      window: { createOutputChannel: () => ({ dispose() {} }) },
    },
    "vscode-languageclient/node": { LanguageClient: class {} },
  });
  const lsp = new ConsoleLspClient({ consoleId: "restart-order", env: {} });
  t.after(() => lsp.dispose());
  const requests = [];
  const fakeClient = (paths) => ({
    isRunning: () => true,
    sendRequest: async (_method, state) => {
      requests.push(state);
      return JSON.stringify(state.libraryPaths) === paths ? true : { restartRequired: true };
    },
  });
  lsp.client = fakeClient(JSON.stringify(["/original"]));
  let runningPaths;
  let stopCount = 0;
  let startCount = 0;
  let releaseStart;
  const firstStartGate = new Promise((resolve) => { releaseStart = resolve; });
  lsp.stop = async () => {
    stopCount++;
    lsp.client = undefined;
    return true;
  };
  lsp.startClient = async () => {
    const startupPaths = JSON.stringify(lsp.sessionState?.libraryPaths);
    startCount++;
    if (startCount === 1) await firstStartGate;
    runningPaths = startupPaths;
    lsp.client = fakeClient(startupPaths);
  };
  const first = lsp.syncSessionState({
    attachedPackages: ["stats"], libraryPaths: ["/first"],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopCount, 1);

  // A completion-triggered start must join the restart rather than start
  // another server; a new session snapshot must win over the old one.
  const concurrentStart = lsp.start();
  const latest = lsp.syncSessionState({
    attachedPackages: ["stats"], libraryPaths: ["/latest"],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(startCount, 1);
  releaseStart();
  await Promise.all([first, latest, concurrentStart]);
  assert.equal(stopCount, 2);
  assert.equal(startCount, 2);
  assert.equal(runningPaths, JSON.stringify(["/latest"]));
  assert.deepEqual(requests.at(-1), {
    attachedPackages: ["stats"], libraryPaths: ["/latest"],
  });
  const previousStops = stopCount;
  await lsp.syncSessionState({ attachedPackages: ["stats"], libraryPaths: ["/latest"] });
  assert.equal(stopCount, previousStops, "unchanged paths do not restart");
});

test("language-server state sync failures do not reject terminal workspace updates", async () => {
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {},
    "../../Language/completion": {},
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({
    extensionPath: "", rPath: "R", env: {},
    requestMemberCompletions: async () => [],
  });
  lang.consoleLsp = { syncSessionState: async () => { throw Error("restart failed"); } };
  assert.equal(lang.updateSessionData({
    search: [], loaded_namespaces: [], globalenv: {}, libraryPaths: ["/new"],
  }), true);
  await new Promise((resolve) => setImmediate(resolve));
});

test("native scope fields suppress data-mask runtime probes", async () => {
  const input = 'with(df, al';
  let probes = 0;
  const context = completion.getCompletionContext(input, input.length);
  const entries = await completion.collectCompletionEntries(context, { getText: () => input },
    { line: 0, character: input.length }, undefined, [], [], {
      provideCompletionItems: async () => [{ label: 'alpha', kind: 4, detail: '[scope]', data: { type: 'scope' } }],
    }, async () => { probes++; return [{ name: 'also_stale' }]; });
  assert.deepEqual(entries.map(item => item.label), ['alpha']);
  assert.equal(probes, 0);
});

test("native member snippets preserve escaped dollars, braces and backslashes", async () => {
  const input = 'obj$';
  const names = ['fun$1', 'fun${2:text}', 'fun\\path', 'fun}name'];
  const entries = await completion.collectCompletionEntries(completion.getCompletionContext(input, input.length),
    { getText: () => input }, { line: 0, character: input.length }, undefined, [], [], {
      provideCompletionItems: async () => names.map(label => {
        const literal = '`' + label.replace(/\\/g, '\\\\') + '`';
        return { label, kind: 1, data: { type: 'member' },
          insertText: new SnippetString(literal.replace(/[\\$}]/g, '\\$&') + '($0)') };
      }),
    });
  assert.deepEqual(entries.map(item => item.insertText), names.map(name => '`' + name.replace(/\\/g, '\\\\') + '`()'));
});

test("cached native replacement ends move with the typed prefix", () => {
  const { refineCompletionEntries, rebaseCompletionEnds } = loadSource('src/Language/completion/refinement.ts');
  const before = 'obj$alpha';
  const after = 'obj$allpha';
  const context = completion.getCompletionContext(before, 5);
  const refinedContext = completion.getCompletionContext(after, 6);
  const entries = [{ label: 'alpha', insertText: 'alpha', source: 'lsp', replaceStart: 4, replaceEnd: 9 }];
  const refined = refineCompletionEntries({ context, entries,
    input: { text: before, textBeforeCursor: before.slice(0, 5), cursorRow: 0 } },
    { text: after, textBeforeCursor: after.slice(0, 6), cursorRow: 0 }, refinedContext);
  const pick = completion.toCompletionPick(refined[0], refinedContext);
  assert.equal(after.slice(0, pick.replaceStart) + pick.insertText + after.slice(pick.replaceEnd), 'obj$alpha');
  const preview = rebaseCompletionEnds(refined, -1);
  assert.equal(preview[0].replaceEnd, 9, 'picker preview edits must map back to the actual input');
  assert.equal(entries[0].replaceEnd, 9, 'cache entries stay immutable');
});

test("native method parameters never appear inside an argument value", async () => {
  const input = 'obj$new(value = va';
  const entries = await completion.collectCompletionEntries(completion.getCompletionContext(input, input.length),
    { getText: () => input }, { line: 0, character: input.length }, undefined, [], [], {
      provideCompletionItems: async () => ({ rConsoleNativeArguments: true, items: [
        { label: 'value', kind: 5, detail: 'new(value)', insertText: 'value = ', data: { type: 'member', parameter: 'value' } },
      ] }),
    });
  assert.ok(!entries.some(item => item.insertText === 'value = '));
});
