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

test("automatic member completion uses cached workspace names without calling sess", async () => {
  const workspace = { globalenv: { obj: { names: ["fun", "field"], slots: ["slot"] } } };
  for (const [input, expected] of [["obj$", ["fun", "field"]], ["obj@", ["slot"]]]) {
    const entries = await completion.collectCompletionEntries(
      completion.getCompletionContext(input, input.length),
      undefined, undefined, workspace, [], [], undefined,
      async () => assert.fail("automatic members must not call sess"));
    assert.deepEqual(entries.map(item => item.label), expected, input);
  }
});

test("cached S4 slot schemas survive incomplete native attributes and retain guarded kinds", async () => {
  const workspace = { globalenv: { obj: { slots: [".Data", "inner", "method"] } } };
  const context = completion.getCompletionContext("obj@", 4);
  const entries = await completion.collectCompletionEntries(context, undefined, undefined,
    workspace, [], [], undefined, async () => ({ status: "available",
      names: ["inner", "method", "dim"], kinds: [0, 1, 0] }));
  assert.deepEqual(entries.map(item => item.label), [".Data", "inner", "method"]);
  assert.equal(entries[0].insertText, ".Data");
  assert.equal(entries[2].insertText, "method()");
  const filtered = await completion.collectCompletionEntries(
    completion.getCompletionContext("obj@.D", 6), undefined, undefined,
    workspace, [], [], undefined, async () => ({ status: "available", names: ["inner"] }));
  assert.deepEqual(filtered.map(item => item.label), [".Data"]);
  const nested = await completion.collectCompletionEntries(
    completion.getCompletionContext("obj@inner@", 10), undefined, undefined,
    workspace, [], [], undefined, async () => ({ status: "available", names: ["child"] }));
  assert.deepEqual(nested.map(item => item.label), ["child"], "a nested object must not inherit its root's slots");
  for (const [root, receiver] of [["a b", "`a b`"], ["变量", "变量"], ["a\nb", "`a\\nb`"]]) {
    const input = receiver + "@";
    const entries = await completion.collectCompletionEntries(
      completion.getCompletionContext(input, input.length), undefined, undefined,
      { globalenv: { [root]: { slots: [".Data", "inner"] } } }, [], [], undefined,
      async () => ({ status: "unavailable" }));
    assert.deepEqual(entries.map(item => item.label), [".Data", "inner"], receiver);
  }
});

test("custom top-level member metadata survives storage inspection without leaking into nested objects", async () => {
  for (const [type, classes, expected] of [
    ["list", ["custom"], ["public"]],
    ["environment", ["R6Thing", "R6"], ["public"]],
    ["environment", ["python.builtin.object"], ["public"]],
    ["list", ["list"], ["storage"]],
    ["list", ["data.frame"], ["storage"]],
    ["list", ["data.table", "data.frame"], ["storage"]],
    ["list", ["custom", "data.frame"], ["public"]],
  ]) {
    const data = { globalenv: { obj: { type, class: classes, names: ["public"] } } };
    for (const [input, labels] of [["obj$", expected], ["obj$child$", ["storage"]]]) {
      const entries = await completion.collectCompletionEntries(
        completion.getCompletionContext(input, input.length), undefined, undefined,
        data, [], [], undefined, async () => ({ status: "available", names: ["storage"] }));
      assert.deepEqual(entries.map(entry => entry.label), labels, classes.join("/") + input);
    }
  }
  const cleared = await completion.collectCompletionEntries(
    completion.getCompletionContext("obj$", 4), undefined, undefined,
    { globalenv: { obj: { type: "list", class: ["list"], names: ["stale"] } } },
    [], [], undefined, async () => ({ status: "available", names: [] }));
  assert.deepEqual(cleared, [], "fresh empty storage still clears stale ordinary names");
});

test("safety refusals cannot fall back to cached receiver schemas or installed indexing methods", async () => {
  const workspace = { globalenv: { obj: {
    type: 'list', class: ['custom'], names: ['stale'], slots: ['stale'],
  }, index: { type: 'integer' } } };
  for (const reason of ['unsafe-dispatch', 'active-binding', 'deferred-binding', 'unsafe-altrep', 'unsafe-environment']) {
    for (const input of ['obj$', 'obj@', 'obj[', 'obj[[', 'obj[ind', 'obj[[ind', 'obj[["']) {
      const context = completion.getCompletionContext(input, input.length);
      const result = { status: 'suppressed', reason };
      const hints = [];
      const provider = { async provideCompletionItems(_doc, _position, _trigger, _context, bracketKind) {
        hints.push(bracketKind);
        return { rConsoleRuntimeOnly: true, items: [
          { label: 'stale', kind: 4, data: { type: 'scope' } },
          { label: 'drop', kind: 5, data: { type: 'subscript_parameter' } },
          { label: '.SD', kind: 4, data: { type: 'subscript_special' } },
        ] };
      } };
      const entries = await completion.collectCompletionEntries(context,
        { getText: () => input }, { line: 0, character: input.length },
        workspace, [], [], provider, async () => result, input,
        context.kind === 'bracket' ? Promise.resolve(result) : undefined);
      if (context.kind === 'member') assert.deepEqual(entries, [], input + ': ' + reason);
      else {
        if (context.prefix) assert.ok(entries.some(entry => entry.label === 'index'), 'independent index variables remain available');
        assert.ok(entries.every(entry => !['stale', 'drop', '.SD'].includes(entry.label)), input + ': ' + reason);
        assert.deepEqual(hints, hints.map(() => null), 'suppression blocks cached installed-method hints');
      }
    }
  }
});

test("native nested completion reaches Rust without awaiting the language server", async () => {
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {
      Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      CompletionItemKind: { Field: 4, Function: 2, Property: 9, Variable: 5, Text: 0 },
    },
    "../../Language/completion": completion,
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  for (const [outcome, expected] of [
    [{ status: "suppressed", reason: "deferred-binding" }, []],
    [{ status: "available", names: ["inner"] }, ["inner"]],
    [{ status: "unavailable" }, []],
  ]) {
    let requested = 0;
    const lang = new RTermLang({
      extensionPath: "", rPath: "R", env: {},
      getStaticAnalysisEnabled: () => false,
      requestRuntimeMemberCompletions: async (expression, operator) => {
        requested++;
        assert.equal(expression, "a$lazy");
        assert.equal(operator, "$");
        return outcome;
      },
    });
    lang.ensureConsoleLspStarted = () => { throw Error("runtime completion must not start LSP"); };
    lang.getOrOpenCompletionDocument = () => { throw Error("runtime completion must not open a virtual document"); };
    const text = "a$lazy$";
    const input = { text, currentLine: text, cursorCol: text.length,
      cursorRow: 0, lines: [text], textBeforeCursor: text };
    const published = [];
    await lang.handleAutocomplete({
      input, getCurrentInput: () => input, getWorkspaceData: () => undefined,
      onInlineEntries: items => published.push(items.filter(item => "insertText" in item).map(item => item.insertText)),
      applyCompletion() {},
    });
    assert.equal(requested, 1);
    assert.deepEqual(published.at(-1), expected);
  }
});

test("unavailable nested inspection retries after typing instead of caching empty members", async () => {
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {
      Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      CompletionItemKind: { Field: 4, Function: 2, Property: 9, Variable: 5, Text: 0 },
    },
    "../../Language/completion": completion,
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  let requests = 0;
  const lang = new RTermLang({
    extensionPath: "", rPath: "R", env: {},
    getStaticAnalysisEnabled: () => false,
    requestRuntimeMemberCompletions: async (expression, operator) => {
      assert.deepEqual([expression, operator], ["obj$inner", "$"]);
      return ++requests === 1
        ? { status: "unavailable" } : { status: "available", names: ["alpha"] };
    },
  });
  lang.ensureConsoleLspStarted = () => { throw Error("no LSP dependency for runtime members"); };
  const snapshot = text => ({ text, currentLine: text, cursorCol: text.length,
    cursorRow: 0, lines: [text], textBeforeCursor: text });
  let input = snapshot("obj$inner$");
  const published = [];
  const autocomplete = () => lang.handleAutocomplete({
    input, getCurrentInput: () => input, getWorkspaceData: () => undefined,
    onInlineEntries: entries => published.push(entries.filter(item => "insertText" in item)
      .map(item => item.insertText)),
    applyCompletion() {},
  });
  await autocomplete();
  assert.equal(lang.hasCompleteInlineMemberCache(), false,
    "timeout or disconnect is not an authoritative empty member list");
  input = snapshot("obj$inner$a");
  const refined = lang.refineInlineCompletion(input);
  assert.deepEqual(refined.filter(item => "insertText" in item), []);
  assert.equal(lang.hasCompleteInlineMemberCache(), false,
    "refining an incomplete result must still schedule a lookup");
  await autocomplete();
  assert.deepEqual(published.at(-1), ["alpha"]);
  assert.equal(requests, 2);
  assert.equal(lang.hasCompleteInlineMemberCache(), true,
    "successful native inspection may now be filtered locally");
});

test("bracket names publish before LSP startup and then merge its parameters", async () => {
  const published = [];
  let releaseServer;
  const startup = new Promise(resolve => { releaseServer = resolve; });
  let nativeRequests = 0;
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {
      Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      CompletionItemKind: { Field: 4, Function: 2, Property: 9, Variable: 5, Text: 0 },
    },
    "../../Language/completion": completion,
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({
    extensionPath: "", rPath: "R", env: {},
    getStaticAnalysisEnabled: () => false,
    requestRuntimeMemberCompletions: async (expression, operator) => {
      assert.deepEqual([expression, operator], ["DT", "["]);
      nativeRequests++;
      return { status: "available", names: ["keyboard"], bracketKind: "data.table" };
    },
  });
  lang.ensureConsoleLspStarted = () => startup;
  lang.getOrOpenCompletionDocument = async text => ({
    getText: () => text, uri: { toString: () => "r-console:/completion" },
  });
  const input = { text: "DT[, keyb", currentLine: "DT[, keyb", cursorCol: 9,
    cursorRow: 0, lines: ["DT[, keyb"], textBeforeCursor: "DT[, keyb" };
  const labels = items => items.filter(item => "insertText" in item).map(item => item.insertText);
  await lang.handleAutocomplete({
    input, getCurrentInput: () => input, getWorkspaceData: () => undefined,
    onInlineEntries: items => published.push(labels(items)), applyCompletion() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(published, [["keyboard"]],
    "live columns appear even if the language server has not started");
  releaseServer({ provideCompletionItems: async () => ({ items: [
    { label: "keyby", insertText: "keyby = ", kind: 5,
      detail: "parameter", data: { type: "subscript_parameter" } },
    { label: "keybird", kind: 4, data: { type: "scope" } },
  ] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...published.at(-1)].sort(), ["keyboard", "keyby = "].sort(),
    "native names and LSP parameters both survive enrichment");
  assert.equal(nativeRequests, 1, "no duplicate inspection during LSP enrichment");
});

test("default bracket completion preserves method parameters alongside prefetched live names", async () => {
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {
      Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      CompletionItemKind: { Field: 4, Function: 2, Property: 9, Variable: 5, Text: 0 },
    },
    "../../Language/completion": completion,
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  let nativeRequests = 0;
  let lspRequests = 0;
  const lang = new RTermLang({
    extensionPath: "", rPath: "R", env: {},
    getStaticAnalysisEnabled: () => false,
    requestRuntimeMemberCompletions: async (expression, operator) => {
      nativeRequests++;
      assert.deepEqual([expression, operator], ["DT", "["]);
      return { status: "available", names: ["keyboard"], bracketKind: "data.table" };
    },
  });
  lang.ensureConsoleLspStarted = async () => {
    assert.equal(nativeRequests, 1, "guarded inspection must start before LSP startup");
    return { provideCompletionItems: async () => {
      lspRequests++;
      return { items: [
        { label: "keyby", insertText: "keyby = ", kind: 5,
          detail: "parameter", data: { type: "subscript_parameter" } },
        { label: "keybird", kind: 4, data: { type: "scope" } },
      ] };
    } };
  };
  lang.getOrOpenCompletionDocument = async text => ({
    getText: () => text, uri: { toString: () => "r-console:/completion" },
  });
  const text = "DT[, keyb";
  const input = { text, currentLine: text, cursorCol: text.length,
    cursorRow: 0, lines: [text], textBeforeCursor: text };
  let published;
  await lang.handleAutocomplete({
    input, getCurrentInput: () => input, getWorkspaceData: () => undefined,
    onInlineEntries: items => { published = items.filter(item => "insertText" in item); },
    applyCompletion() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nativeRequests, 1, "prefetched inspection must not be repeated");
  assert.equal(lspRequests, 1, "bracket-method parameters still come from languageserver");
  assert.deepEqual(published.map(item => item.insertText).sort(), ["keyboard", "keyby = "]);
  assert.ok(!published.some(item => item.label === "keybird"),
    "stale inferred field names must not override the live result");
});

test("runtime-only member lookup uses cached names, never live completion", async () => {
  const input = "obj$";
  const entries = await completion.collectCompletionEntries(
    completion.getCompletionContext(input, input.length),
    { getText: () => input }, { line: 0, character: input.length },
    { globalenv: { obj: { names: ["cached"] } } }, [], [],
    { provideCompletionItems: async () => ({
      rConsoleRuntimeOnly: true, rConsoleMemberResolved: true,
      items: [{ label: "source_only", kind: 4, data: { type: "member" } }],
    }) },
    async () => assert.fail("must not request live members"));
  assert.deepEqual(entries.map(item => item.label), ["cached"]);
});

test("runtime-only unresolved member signatures do not borrow native arguments or exhaustion", async () => {
  const input = "obj$fun(";
  const context = completion.getCompletionContext(input, input.length);
  const native = { label: "stale", kind: 5, detail: "parameter" };
  const provider = result => ({ provideCompletionItems: async () => ({
    rConsoleRuntimeOnly: true, rConsoleNativeArguments: true, rConsoleArgumentsExhausted: true,
    items: [native], ...result,
  }) });
  const stale = await completion.collectCompletionEntries(context, { getText: () => input },
    { line: 0, character: input.length }, undefined, [], [], provider({}));
  assert.deepEqual(stale.filter(item => item.detail === "parameter"), []);
  const live = await completion.collectCompletionEntries(context, { getText: () => input },
    { line: 0, character: input.length }, undefined, [], [],
    provider({ rConsoleWorkspaceFunction: true, rConsoleArgumentsExhausted: false, items: [{ label: "new_arg",
      kind: 5, detail: "parameter" }] }));
  assert.deepEqual(live.filter(item => item.detail === "parameter").map(item => item.label), ["new_arg"]);
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

test("native member formals supply arguments and remain in the Arguments group", async () => {
  for (const operator of ["$", "@"]) {
    const input = `obj${operator}lm(`;
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, { getText: () => input },
      { line: 0, character: input.length }, undefined, [], [], {
        provideCompletionItems: async () => ({ rConsoleNativeArguments: true, items: [
          { label: "member_arg", insertText: "member_arg = ", kind: 5, detail: "parameter" },
          { label: "a b", insertText: "`a b` = ", kind: 5, detail: "parameter" },
          { label: "...", insertText: "...", kind: 5, detail: "parameter" },
        ] }),
      }, async () => { assert.fail("member arguments must use languageserver"); });
    assert.deepEqual(entries.map(entry => entry.insertText), ["member_arg = ", "`a b` = ", "..."]);
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
        provideCompletionItems: async () => ({ rConsoleWorkspaceFunction: true, items: [
          { label: "a b", insertText: "`a b` = ", detail: "parameter", kind: 5 },
          { label: "normal", insertText: "normal = ", detail: "parameter", kind: 5 },
        ] }),
      }, async expression => {
        requests++;
        assert.fail("workspace arguments must not query sess");
      });
    assert.equal(requests, 0, source);
    assert.deepEqual(entries.filter(item => item.detail === "parameter").map(item => item.insertText),
      ["`a b` = ", "normal = "], source);
    assert.ok(!entries.some(item => item.label.startsWith("wrong")), source);
  }
});

test("unknown session signatures never borrow inferred package arguments", async () => {
  const input = "print(df, ";
  const methodArgument = { label: "digits", insertText: "digits = ", kind: 5,
    detail: "print(x, ..., digits = NULL)", data: { type: "s3_parameter" } };
  for (const result of [
    { rConsoleNativeArguments: true, items: [methodArgument] },
    { items: [methodArgument] },
    { rConsoleNativeArguments: true, rConsoleArgumentsExhausted: true, items: [] },
  ]) {
    let probes = 0;
    const entries = await completion.collectCompletionEntries(
      completion.getCompletionContext(input, input.length), { getText: () => input },
      { line: 0, character: input.length }, { globalenv: { print: { type: "closure" } } },
      [], [], { provideCompletionItems: async () => result }, async expression => {
        probes++;
        assert.fail("unknown signatures must not query sess");
        return [{ name: "custom_arg" }];
      });
    assert.equal(probes, 0);
    assert.deepEqual(entries.map(entry => entry.insertText), []);
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

test("workspace arguments wait only for languageserver", async () => {
  const input = "f(";
  let release;
  const lsp = new Promise(resolve => { release = resolve; });
  const pending = completion.collectCompletionEntries(completion.getCompletionContext(input, input.length),
    { getText: () => input }, { line: 0, character: input.length },
    { globalenv: { f: { type: "closure" } } }, [], [], { provideCompletionItems: () => lsp },
    async () => { assert.fail("no expression-based signature request"); });
  release({ rConsoleWorkspaceFunction: true, items: [
    { label: "live_arg", insertText: "live_arg = ", detail: "parameter", kind: 5 },
  ] });
  assert.deepEqual((await pending).map(entry => entry.insertText), ["live_arg = "]);
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

test("member completion parses token-derived objects without evaluating draft code", async () => {
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
    await completion.collectCompletionEntries(context, undefined, undefined, undefined, [], [], undefined,
      async () => undefined /* Optional guarded native completion, never sess evaluation */);
  }
});

test("subscript member detection preserves the receiver without evaluating indices or suggesting parent fields", async () => {
  const input = "obj[[stop('must not execute')]]$fi";
  const context = completion.getCompletionContext(input, input.length);
  assert.equal(context.kind, "member");
  assert.equal(context.objectName, "obj[[stop('must not execute')]]");
  const entries = await completion.collectCompletionEntries(context, undefined, undefined,
    { globalenv: { obj: { names: ["fieldOnParent"] } } }, [], [], undefined,
    async () => assert.fail("indexed receivers must not use expression-based completion"));
  assert.deepEqual(entries, []);
});

test("computed subscript receiver is rejected before LSP or native inspection", async () => {
  const input = "objects[[choose_index()]]@sl";
  const context = completion.getCompletionContext(input, input.length);
  assert.equal(context?.kind, "member");
  assert.equal(context?.rejectionReason, "executable-receiver");
  const entries = await completion.collectCompletionEntries(context, { getText: () => input },
    { line: 0, character: input.length }, { globalenv: { objects: { slots: ["slotOnContainer"] } } },
    [], [], { provideCompletionItems: async () => assert.fail("no LSP evaluation or inference") },
    async () => assert.fail("no native inspection"));
  assert.deepEqual(entries, []);
});

test("member-like text in literals and comments does not request runtime members", async () => {
  for (const input of ['"obj$fi', 'r"(obj$fi)', "# obj$fi", "obj$ # fi"]) {
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
      assert.equal(requests, 0, input);
      assert.equal(entries.some(entry => entry.insertText === "first_value"),
        !context.suppressAutomatic && !context.argumentValue?.quote, input);
      assert.ok(entries.every(entry => entry.detail !== "parameter" && !entry.insertText.endsWith(" = ")), input);
    }
  }
});

test("argument completion never sends expressions to sess", async () => {
  const input = "obj$fun(first = stop('do not execute'), sec, third = system('do not execute'))";
  const cursor = input.indexOf("sec") + 3;
  const context = completion.getCompletionContext(input, cursor);
  await completion.collectCompletionEntries(context, undefined, undefined, undefined, [], [], undefined,
    async () => { assert.fail("no expression-based argument requests"); });
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


test("background package replacement shares startup and preserves the newer library inventory", async t => {
  const logs = [];
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode: {
      Uri: { parse: value => ({ toString: () => value }) },
      window: { createOutputChannel: () => ({ appendLine: line => logs.push(line), dispose() {} }) },
    },
    "vscode-languageclient/node": { LanguageClient: class {} },
  });
  const lsp = new ConsoleLspClient({ consoleId: "background-replacement", env: {} });
  t.after(() => lsp.dispose());
  let current = true;
  let releaseStart;
  const gate = new Promise(resolve => { releaseStart = resolve; });
  const requests = [];
  const first = { isRunning: () => true, sendRequest: async method => {
    assert.equal(method, "rConsole/refreshPackages");
    return { restart: ["example"] };
  } };
  const second = {
    isRunning: () => true,
    sendRequest: async (method, params) => {
      requests.push({ method, params });
      if (method === "rConsole/refreshPackages") return { restart: [] };
      return { libraryPaths: ["/latest"] };
    },
  };
  lsp.packageInventory.setLibraryPaths = () => { current = false; };
  lsp.client = first;
  let starts = 0;
  lsp.stop = async () => { lsp.client = undefined; return true; };
  lsp.startClient = async () => {
    starts++;
    await gate;
    lsp.client = second;
  };
  const refresh = lsp.refreshPackages({
    changed: ["example"], libraries: [{ path: "/old", packages: new Map() }],
    packages: new Map(), isCurrent: () => current,
  });
  await new Promise(resolve => setImmediate(resolve));
  const start = lsp.start();
  const sync = lsp.syncSessionState({ attachedPackages: [] });
  releaseStart();
  await Promise.all([refresh, start, sync]);
  assert.equal(starts, 1);
  assert.deepEqual(requests, [{ method: "rConsole/syncSessionState", params: {
    attachedPackages: [],
  } }], "do not replay the older inventory after the server reports newer libraries");
  assert.ok(logs.some(line => line.includes("Restarting language server: example (removed); clearing packages loaded in the server.")));
  await lsp.refreshPackages({
    changed: [], libraries: [{ path: "/latest", packages: new Map() }],
    packages: new Map(), isCurrent: () => true,
  });
  assert.deepEqual(requests.slice(1).map(request => request.method),
    ["rConsole/refreshPackages"],
    "apply only the latest library inventory to the new server");
  assert.deepEqual(requests[1].params.libraryPaths, ["/latest"]);
});

test("completion requests do not perform package inventory checks", async (t) => {
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
    consoleId: "package-refresh-background-test",
    extensionPath: "",
    rPath: "R",
    env: {},
  });
  t.after(() => client.dispose());
  client.syncDocument = async () => {};
  client.applySessionState = async () => {};

  let completions = 0;
  client.client = {
    isRunning: () => true,
    code2ProtocolConverter: { asCompletionParams: () => ({}) },
    protocol2CodeConverter: { asCompletionResult: async (result) => result },
    sendRequest: async (method) => {
      assert.equal(method, "completion");
      completions += 1;
      return [];
    },
    stop: async () => {},
    dispose: async () => {},
  };

  const doc = { getText: () => "foo::bar" };
  await client.provideCompletionItems(doc, new TestPosition(0, 8));
  await client.provideCompletionItems(doc, new TestPosition(0, 8));

  assert.equal(completions, 2);
});


test("language-server completion does not request a workspace refresh", async () => {
  let workspaceRequests = 0;
  let lspCompletionStarted = false;
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
    requestWorkspaceData: () => { workspaceRequests++; throw Error("no live completion probe"); },
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

  assert.equal(workspaceRequests, 0);
});


test("namespace completion does not wait for library or workspace probes", async () => {
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
      isCompletionPickItem: () => false,
      rankCompletionEntries: completion.rankCompletionEntries,
      toCompletionQuickPickItems: () => [],
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const events = [];
  const lang = new RTermLang({
    extensionPath: "",
    rPath: "R",
    env: {},
    requestWorkspaceData: async () => {
      throw new Error("workspace request should not run");
    },
    requestMemberCompletions: async () => [],
  });
  lang.ensureConsoleLspStarted = async () => {
    events.push("lookup");
    return { provideCompletionItems: async () => [] };
  };
  lang.getOrOpenCompletionDocument = async () => ({});

  for (const text of contexts.keys()) {
    events.length = 0;
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
    assert.deepEqual(events, ["lookup"]);
  }
});


test("F7 refinement does not request a workspace refresh", async () => {
  let workspaceRequests = 0;
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
    requestWorkspaceData: () => { workspaceRequests++; throw Error("no live completion probe"); },
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
  assert.equal(workspaceRequests, 0);
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


test("runtime column inspection is omitted when cached names are unavailable", async () => {
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
  assert.equal(runtimeStarted, false);
  assert.ok(!entries.some((entry) => entry.label === "alpha"));
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
    assert.equal(picks[0].label, "Functions");
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

test("dollar and slot members retain cached workspace order without R extraction", async () => {
  for (const operator of ["$", "@"]) {
    const input = `obj${operator}`;
    const context = completion.getCompletionContext(input, input.length);
    const names = ["zebra", "alpha", "beta"];
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      { globalenv: { obj: { names, slots: names } } }, [], [],
      undefined, async () => assert.fail("must not execute custom R accessors"));
    for (const query of ["", "a", "b"]) {
      assert.deepEqual(completion.rankCompletionEntries(entries, query, context).map(e => e.label),
        query === "b" ? ["beta", "zebra"] : query === "a" ? ["alpha", "zebra", "beta"] : names);
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
  assert.equal(lang.hasCompleteInlineMemberCache(), true, "complete member suggestions can be filtered locally");
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
    const refinedOrder = ["df$", "obj@"].includes(text) ? ["beta", "zebra"]
      : ordered.filter(label => label.includes("b"));
    let published;
    await lang.handleAutocomplete({ ...request, onInlineEntries: items => { published = items; } });
    assert.deepEqual(labels(published), ordered, `inline: ${text}`);
    const refined = lang.refineInlineCompletion(snapshot(text + "b"));
    if (["df$", "obj@", "pkg::", "pkg:::"].includes(text)) {
      assert.deepEqual(labels(refined), refinedOrder, `cache: ${text}`);
    } else {
      assert.equal(refined, undefined, `first typed token must fetch newly eligible symbols: ${text}`);
    }
    const showing = lang.handleAutocomplete(request);
    await new Promise(resolve => setImmediate(resolve));
    try {
      assert.equal(pick.sortByLabel, false);
      assert.deepEqual(labels(pick.items), ordered, `Quick Pick: ${text}`);
      pick.value = "b";
      changeValue("b");
      // Check both the immediate local filter and any asynchronous refresh.
      assert.deepEqual(labels(pick.items), refinedOrder, text);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(labels(pick.items), refinedOrder, text);
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

test("session updates synchronize attached packages without supplying library paths", async () => {
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {}, "../../Language/completion": {},
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({ extensionPath: "", rPath: "R", env: {}, requestMemberCompletions: async () => [] });
  const states = [];
  lang.consoleLsp = { syncSessionState: async state => { states.push(state); } };
  const data = { search: ["package:stats"], loaded_namespaces: [], globalenv: {} };
  assert.equal(lang.updateSessionData(data), true);
  assert.deepEqual(states, [{ attachedPackages: ["stats"] }]);
  assert.equal(lang.updateSessionData({ ...data }), false);
  assert.equal(lang.updateSessionData({ ...data, search: ["package:utils"] }), true);
  assert.deepEqual(states.at(-1), { attachedPackages: ["utils"] });
});

test("console LSP ignores vscode-R library settings and forwards only runtime library paths", async (t) => {
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
  const config = { get: (key) => {
    if (key === "libPaths" || key === "useRenvLibPath") {
      throw new Error("R Console must not read vscode-R's library settings");
    }
    return undefined;
  } };
  const startupEnv = lsp.buildServerEnv(config);
  assert.equal(startupEnv.VSCR_LIB_PATHS, undefined);
  assert.equal(startupEnv.VSCR_USE_RENV_LIB_PATH, undefined);
  assert.equal(startupEnv.VSCR_RUNTIME_LIB_PATHS, "");
  lsp.updateRuntimeLibraryPaths(["/project/library", "/R/library"]);
  assert.equal(lsp.buildServerEnv(config).VSCR_RUNTIME_LIB_PATHS,
    "/project/library\n/R/library");
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
    search: [], loaded_namespaces: [], globalenv: {},
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

test("namespace groups retain symbol kinds and alphabetical ordering within equal matches", () => {
  const entries = [
    ['setZ', 5], ['setDT', 2], ['setattr', 2], ['setAlpha', 5],
    ['setField', 4], ['setOther', 7], ['set', 2], ['xset', 2],
  ].map(([label, kind]) => Object.freeze({ label, kind, insertText: label, source: 'lsp' }));
  for (const operator of ['::', ':::']) {
    for (const candidates of [entries, [...entries].reverse()]) {
      const input = `pkg${operator}set`, context = completion.getCompletionContext(input, input.length);
      const picks = completion.toCompletionQuickPickItems(
        completion.rankCompletionEntries(Object.freeze(candidates), context.prefix, context), context);
      assert.deepEqual(picks.map(item => item.insertText ?? item.label), [
        'Functions', 'set', 'setattr', 'setDT', 'xset',
        'Variables', 'setAlpha', 'setZ', 'Fields', 'setField', 'Other', 'setOther',
      ]);
    }
  }
});

test("equally strong typed symbol matches sort alphabetically instead of by length", () => {
  for (const [input, source, kind] of [['set', 'session', 5], ['set', 'lsp', 2], ['pkg::set', 'lsp', 2]]) {
    const context = completion.getCompletionContext(input, input.length);
    const entries = ['setZ', 'setattr', 'setDT', 'set'].map(label => ({ label, source, kind, insertText: label }));
    assert.deepEqual(completion.rankCompletionEntries(entries, 'set', context).map(entry => entry.label),
      ['set', 'setattr', 'setDT', 'setZ'], input);
  }
});

test("dots remain a variadic argument indicator and never insert an equals sign", async () => {
  for (const input of ['data.frame(', 'data.frame(row.names = NULL, ', 'data.frame(xxxx, ']) {
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, { getText: () => input },
      { line: 0, character: input.length }, undefined, [], [], {
        provideCompletionItems: async () => [{ label: '...', kind: 5, detail: 'parameter', insertText: '... = ' }],
      });
    assert.deepEqual(entries.map(item => item.insertText), ['...']);
  }
});

test("bracket methods preserve native parameter suggestions and column fields", async () => {
  const input = "DT[, keyb";
  const context = completion.getCompletionContext(input, input.length);
  const entries = await completion.collectCompletionEntries(context, { getText: () => input },
    { line: 0, character: input.length }, { globalenv: { DT: { names: ["keyboard"], class: ["data.table"] } } }, [], [], {
      provideCompletionItems: async () => ({ items: [
        { label: "keyby", insertText: "keyby = ", detail: "parameter",
          data: { type: "subscript_parameter" }, kind: 5 },
        { label: "keyboard", insertText: "keyboard", data: { type: "scope" }, kind: 4 },
      ] }),
    });
  assert.ok(entries.some(item => item.insertText === "keyby = "), "bracket context must accept method parameters");
  assert.ok(entries.some(item => item.label === "keyboard"), "ordinary native fields remain available");
});

test("accessor completion ranks exact and prefix matches before fuzzy members", () => {
  const context = completion.getCompletionContext("task$data", "task$data".length);
  const entries = [
    { label: "add_strata", insertText: "add_strata()", kind: 2, source: "session" },
    { label: "dataset", insertText: "dataset", kind: 4, source: "session" },
    { label: "data", insertText: "data()", kind: 2, source: "session" },
  ];
  const ranked = completion.rankCompletionEntries(entries, "data", context);
  assert.deepEqual(ranked.map(entry => entry.label), ["data", "dataset", "add_strata"]);
  const picker = completion.toCompletionQuickPickItems(ranked, context);
  assert.equal(picker.find(item => "insertText" in item).insertText, "data()");
  assert.deepEqual(entries.map(entry => entry.label), ["add_strata", "dataset", "data"]);
  const prefix = completion.rankCompletionEntries(entries, "da", { ...context, prefix: "da" });
  assert.deepEqual(prefix.map(entry => entry.label), ["dataset", "data", "add_strata"]);
});

test("nested bracket completion accepts safe scalar index names but rejects calls", () => {
  const valid = completion.getCompletionContext("obj[[i]][[", "obj[[i]][[".length);
  assert.equal(valid?.kind, "bracket");
  assert.equal(valid?.objectName, "obj[[i]]");
  assert.equal(valid?.bracketOperator, "[[");
  assert.equal(valid?.rejectionReason, undefined);
  const invalid = completion.getCompletionContext("obj[[f()]][[", "obj[[f()]][[".length);
  assert.ok(!invalid || invalid.rejectionReason || invalid.kind !== "bracket");
});
