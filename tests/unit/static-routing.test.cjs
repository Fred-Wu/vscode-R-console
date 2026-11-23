const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

class Position {
  constructor(line, character) { Object.assign(this, { line, character }); }
}
const vscode = {
  Position,
  CompletionItemKind: {
    Method: 1, Function: 2, Field: 4, Variable: 5, Property: 9, Text: 0, Snippet: 14,
  },
  QuickPickItemKind: { Separator: -1 },
  SnippetString: class { constructor(value) { this.value = value; } },
};
const completion = loadSource("src/Language/completion.ts", { vscode });
const snapshot = (text, cursor = text.length) => {
  const before = text.slice(0, cursor);
  const lines = text.split("\n");
  const cursorRow = before.split("\n").length - 1;
  return { text, lines, currentLine: lines[cursorRow], cursorRow,
    cursorCol: before.split("\n").at(-1).length, textBeforeCursor: before };
};
const labels = entries => entries.filter(entry => "insertText" in entry).map(entry => entry.insertText);

function harness({ staticAnalysis = true, inspected, lspItems, sessionData, storedSources } = {}) {
  const logs = [], native = [], requests = [], sourceRequests = [];
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: { ...vscode, window: { createOutputChannel: () => ({
      appendLine: line => logs.push(line), dispose() {},
    }) } },
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({
    extensionPath: "", rPath: "R", env: {},
    getStaticAnalysisEnabled: () => typeof staticAnalysis === "function" ? staticAnalysis() : staticAnalysis,
    requestRuntimeFunctionSource: storedSources === undefined ? undefined : name => {
      sourceRequests.push(name);
      return Promise.resolve(typeof storedSources === "function" ? storedSources(name) : storedSources[name]);
    },
    requestRuntimeMemberCompletions: (receiver, operator) => {
      native.push([receiver, operator]);
      return Promise.resolve(typeof inspected === "function" ? inspected(receiver, operator) :
        inspected ?? { status: "available", names: [] });
    },
  });
  const provider = { provideCompletionItems: async (doc, position, trigger, contextPosition, bracket, mode, sourceDefinition) => {
    requests.push({ text: doc.getText(), position, mode, sourceDefinition });
    return typeof lspItems === "function" ? lspItems(mode, sourceDefinition) : lspItems ?? {
      rConsoleMemberResolved: true,
      items: [
        { label: "alpha", kind: 4, data: { type: "member" } },
        { label: "ambient", kind: 5 },
      ],
    };
  } };
  lang.ensureConsoleLspStarted = async () => provider;
  lang.getOrOpenCompletionDocument = async text => ({
    getText: () => text,
    uri: { toString: () => "r-console://test/console.R" },
  });
  const complete = async (text, cursor = text.length) => {
    const input = snapshot(text, cursor);
    let entries;
    await lang.handleAutocomplete({ input, getCurrentInput: () => input,
      getWorkspaceData: () => sessionData, applyCompletion() {},
      onInlineEntries: value => { entries = value; } });
    // A bracket request can publish staged native data asynchronously.
    await new Promise(resolve => setImmediate(resolve));
    return entries ?? [];
  };
  return { lang, complete, logs, native, requests, sourceRequests };
}

test("source-only context retains the correct prefix and replacement location for unsafe receivers", () => {
  for (const [text, expectedKind, prefix, start] of [
    ["make_data()$", "member", "", 12],
    ["make_data()$alp", "member", "alp", 12],
    ["make_data()[[al", "bracket", "al", 13],
    ["obj[[side_effect()]]$", "member", "", 21],
    ["obj[[side_effect()]]$al", "member", "al", 21],
  ]) {
    const context = completion.getStaticFallbackContext(text, text.length);
    assert.equal(context?.kind, expectedKind, text);
    assert.equal(context?.prefix, prefix, text);
    assert.equal(context?.replaceStart, start, text);
    assert.equal(context?.staticFallback, true, text);
    assert.equal(context?.rejectionReason, undefined, text);
  }
  const middle = "make_data()$alpha";
  const memberMiddle = completion.getStaticFallbackContext(middle, 14,
    middle.slice(0, 14), middle.slice(14));
  assert.equal(memberMiddle?.replaceStart, 12);
  assert.equal(memberMiddle?.replaceEnd, middle.length);
  const quoted = 'make_data()[["alpha"]]';
  const caret = quoted.indexOf("alpha") + 2;
  const quotedContext = completion.getStaticFallbackContext(quoted, caret,
    quoted.slice(0, caret), quoted.slice(caret));
  assert.equal(quotedContext?.kind, "bracket");
  assert.equal(quotedContext?.prefix, "al");
  assert.equal(quotedContext?.bracketQuote, '"');
  assert.equal(quotedContext?.replaceStart, quoted.indexOf("alpha"));
  assert.equal(quotedContext?.replaceEnd, quoted.indexOf("alpha") + 5);
  assert.equal(completion.getStaticFallbackContext("obj$al", 6), undefined);
});

test("escaped quoted [[ prefixes decode without evaluation and keep mid-key edit bounds", () => {
  for (const [marked, expected, quote] of [
    [String.raw`make_data()[["line\n│old"]]`, "line\n", '"'],
    [String.raw`make_data()[['tab\t│old']]`, "tab\t", "'"],
    [String.raw`make_data()[["na\x6d│e"]]`, "nam", '"'],
    [String.raw`make_data()[["a\"│rest"]]`, 'a"', '"'],
    [String.raw`make_data()[["back\\│rest"]]`, "back\\", '"'],
    [String.raw`make_data()[["A\u0042│rest"]]`, "AB", '"'],
  ]) {
    const caret = marked.indexOf("│");
    const text = marked.replace("│", "");
    const context = completion.getStaticFallbackContext(text, caret,
      text.slice(0, caret), text.slice(caret));
    assert.equal(context?.kind, "bracket", marked);
    assert.equal(context?.prefix, expected, marked);
    assert.equal(context?.bracketQuote, quote, marked);
    assert.equal(context?.replaceStart, text.indexOf("[[") + 3, marked);
    assert.equal(context?.replaceEnd, text.lastIndexOf(quote + "]]"), marked);
  }
});

test("decoded quoted fallback prefixes select escaped source member labels", async () => {
  for (const [marked, label] of [
    [String.raw`make_data()[["line\n│old"]]`, "line\nitem"],
    [String.raw`make_data()[["na\x6d│old"]]`, "name"],
  ]) {
    const caret = marked.indexOf("│");
    const input = marked.replace("│", "");
    const context = completion.getStaticFallbackContext(input, caret,
      input.slice(0, caret), input.slice(caret));
    assert.equal(context?.kind, "bracket", marked);
    const entries = await completion.collectStaticFallbackEntries(context, {
      getText: () => input, uri: { toString: () => "r-console://test/console.R" },
    }, new Position(0, caret), [], {
      provideCompletionItems: async () => ({ rConsoleMemberResolved: true, items: [
        { label, kind: 4, data: { type: "member" } },
        { label: "ambient", kind: 5, data: { type: "scope" } },
      ] }),
    });
    assert.deepEqual(entries.map(entry => entry.label), [label], marked);
    assert.equal(entries.staticResolved, true, marked);
  }
});


test("source-only completion remains retryable until the language server recovers", async () => {
  for (const missing of ["server", "document"]) {
    const h = harness();
    const server = await h.lang.ensureConsoleLspStarted();
    const getDocument = h.lang.getOrOpenCompletionDocument.bind(h.lang);
    if (missing === "server") h.lang.ensureConsoleLspStarted = async () => undefined;
    else h.lang.getOrOpenCompletionDocument = async () => undefined;
    assert.deepEqual(labels(await h.complete("make_data()$")), []);
    assert.equal(h.lang.inlineCache?.entries.isIncomplete, true, missing);
    assert.equal(h.lang.hasCompleteInlineMemberCache(), false, missing);
    h.lang.ensureConsoleLspStarted = async () => server;
    h.lang.getOrOpenCompletionDocument = getDocument;
    assert.deepEqual(labels(await h.complete("make_data()$al")), ["alpha"]);
    assert.deepEqual(h.requests.map(request => request.mode), ["static"]);
  }
});

test("unformatted inferred member names are escaped for R accessors and quoted indices", async () => {
  const infer = async (source, cursor, items) => {
    const context = completion.getStaticFallbackContext(source, cursor,
      source.slice(0, cursor), source.slice(cursor));
    assert.ok(context?.staticFallback, source);
    const entries = await completion.collectStaticFallbackEntries(context, {
      getText: () => source, uri: { toString: () => "r-console://test/console.R" },
    }, new Position(0, cursor), [], {
      provideCompletionItems: async () => ({ rConsoleMemberResolved: true, items }),
    });
    return entries.map(entry => completion.toCompletionPick(entry, context));
  };
  const memberItems = [
    ["simple", "simple"],
    ["a b", "`a b`"],
    ["a`b", "`a\\`b`"],
    ["a\\b", "`a\\\\b`"],
    ["line\nitem", "`line\\nitem`"],
  ];
  const memberPicks = await infer("make_data()$", "make_data()$".length,
    memberItems.map(([label]) => ({ label, kind: 4, data: { type: "member" } })));
  assert.deepEqual(memberPicks.map(item => item.insertText), memberItems.map(([, text]) => text));
  for (const [source, label, expected] of [
    ['make_data()[["old"]]', 'a"b', 'make_data()[["a\\"b"]]'],
    ['make_data()[["old"]]', 'a\\b', 'make_data()[["a\\\\b"]]'],
    ["make_data()[['old']]", "a'b", "make_data()[['a\\'b']]"],
  ]) {
    const cursor = source.indexOf("old");
    const picks = await infer(source, cursor, [
      { label, kind: 4, data: { type: "member" } },
    ]);
    assert.equal(picks.length, 1, source);
    const pick = picks[0];
    assert.equal(source.slice(0, pick.replaceStart) + pick.insertText +
      source.slice(pick.replaceEnd ?? cursor), expected, source);
  }
  // Provider-supplied R insertion edits must not be double-quoted.
  const explicit = await infer("make_data()$", "make_data()$".length, [
    { label: "a b", kind: 4, data: { type: "member" }, insertText: "`a b`" },
  ]);
  assert.equal(explicit[0].insertText, "`a b`");
});

test("static fallback uses only inferred member results and the requested analysis mode", async () => {
  const input = "make_data()$al";
  const context = completion.getStaticFallbackContext(input, input.length);
  const calls = [];
  const items = await completion.collectStaticFallbackEntries(context, {
    getText: () => input, uri: { toString: () => "r-console://test/console.R" },
  }, new Position(0, input.length), [], {
    provideCompletionItems: async (...args) => {
      calls.push(args);
      return { rConsoleMemberResolved: true, items: [
        { label: "alpha", kind: 4, data: { type: "member" } },
        { label: "ambient", kind: 5 },
        { label: "argument", kind: 5, detail: "parameter" },
      ] };
    },
  });
  assert.deepEqual(items.map(item => item.label), ["alpha"]);
  assert.equal(items[0].replaceStart, context.replaceStart);
  assert.equal(items.staticResolved, true);
  assert.equal(calls[0][5], "static");
});

test("safe live members take precedence without any language-server request", async () => {
  const h = harness({ inspected: { status: "available", names: ["alpha", "beta"] },
    sessionData: { globalenv: { obj: { type: "list", names: ["alpha", "beta"] } } } });
  assert.deepEqual(labels(await h.complete("obj$")), ["alpha", "beta"]);
  assert.deepEqual(h.native, [["obj", "$"]]);
  assert.equal(h.requests.length, 0);
});

test("empty live members stay authoritative even when workspace metadata is missing or stale", async () => {
  for (const sessionData of [
    { globalenv: { obj: { type: "list", names: [] } } },
    { globalenv: {} },
    undefined,
  ]) {
    const h = harness({ inspected: { status: "available", names: [] }, sessionData });
    const input = "obj <- list(alpha = 1)\nobj$";
    assert.deepEqual(labels(await h.complete(input)), [],
      "an unsubmitted reassignment cannot replace confirmed empty live storage");
    assert.deepEqual(h.native, [["obj", "$"]]);
    assert.equal(h.requests.length, 0, "native available([]) is authoritative without cached evidence");
  }
});

test("rejected calls route directly to static LSP without executing or probing the receiver", async () => {
  const h = harness();
  assert.deepEqual(labels(await h.complete("make_data()$al")), ["alpha"]);
  assert.equal(h.native.length, 0);
  assert.deepEqual(h.requests.map(r => r.mode), ["static"]);
  assert.ok(h.logs.some(line => line.includes("[Static Completion - Inferred]")));
  assert.ok(h.logs.every(line => !line.includes("Rejected") && !line.includes("Suppressed")));
});

test("native suppression routes to static LSP and never publishes cached unsafe members", async () => {
  const h = harness({
    inspected: { status: "suppressed", reason: "unsafe-dispatch" },
    sessionData: { globalenv: { obj: { names: ["secret"] } } },
  });
  assert.deepEqual(labels(await h.complete("obj$")), ["alpha"]);
  assert.deepEqual(h.native, [["obj", "$"]]);
  assert.deepEqual(h.requests.map(r => r.mode), ["static"]);
  assert.ok(h.logs.some(line => line.includes("[Static Completion - Inferred]")));
  assert.ok(h.logs.every(line => !line.includes("secret")));
});

test("suppressed bracket completion keeps only receiver-specific source members", async () => {
  const h = harness({ inspected: { status: "suppressed", reason: "unsafe-dispatch" },
    lspItems: { rConsoleMemberResolved: true, items: [
      { label: "alpha", kind: 4, data: { type: "member" } },
      { label: "unrelated", kind: 5 },
      { label: "scope_field", kind: 4, data: { type: "scope" } },
      { label: "index_argument", kind: 5, data: { type: "subscript_parameter" } },
    ] } });
  assert.deepEqual(labels(await h.complete('obj[["al')), ["alpha"]);
  assert.deepEqual(h.native, [["obj", "[["]]);
  assert.deepEqual(h.requests.map(r => r.mode), ["static"]);
});

test("unsupported unquoted bracket positions do not borrow method arguments or lexical fields", async () => {
  const h = harness({ lspItems: { items: [
    { label: "drop", kind: 5, data: { type: "subscript_parameter" } },
    { label: "scope_field", kind: 4, data: { type: "scope" } },
  ] } });
  for (const expression of ["make_data()[", "make_data()[al", "make_data()[[al"]) {
    assert.deepEqual(labels(await h.complete(expression)), [], expression);
  }
  assert.deepEqual(h.native, [], "executable receivers never reach the inspector");
  // An unresolved unquoted prefix can trigger the normal first-character
  // LSP retry. Every request must still remain source-only, not native.
  assert.ok(h.requests.length >= 3 && h.requests.length <= 6);
  assert.ok(h.requests.every(request => request.mode === "static"));
});

test("native-confirmed missing roots retain opt-in source completions from the current input", async () => {
  const h = harness({ inspected: { status: "missing" },
    sessionData: { globalenv: { new_obj: { type: "list", names: ["stale"] } } } });
  const input = "new_obj <- list(alpha = 1)\nnew_obj$";
  assert.deepEqual(labels(await h.complete(input)), ["alpha"]);
  assert.deepEqual(h.native, [["new_obj", "$"]]);
  assert.deepEqual(h.requests.map(r => r.mode), ["static"]);
});

test("missing live roots cannot resurrect stale cached session names", async () => {
  for (const staticAnalysis of [false, true]) {
    const h = harness({ staticAnalysis, inspected: { status: "missing" },
      sessionData: { globalenv: { obj: { type: "list", names: ["stale"] } } },
      lspItems: { items: [{ label: "ambient", kind: 5 }] } });
    assert.deepEqual(labels(await h.complete("obj$")), []);
    assert.deepEqual(h.native, [["obj", "$"]]);
    assert.equal(h.requests.length, staticAnalysis ? 1 : 0);
  }
});

test("disabled static analysis keeps the existing rejected path without LSP requests", async () => {
  const h = harness({ staticAnalysis: false });
  assert.deepEqual(labels(await h.complete("make_data()$")), []);
  assert.equal(h.native.length, 0);
  assert.equal(h.requests.length, 0);
  assert.ok(h.logs.some(line => line.includes("[Runtime Completion - Rejected]")));
});

test("an unresolved static receiver never becomes a global symbol completion", async () => {
  const h = harness({ lspItems: { items: [
    { label: "ambient", kind: 5 },
  ] } });
  assert.deepEqual(labels(await h.complete("make_data()$")), []);
  assert.ok(h.logs.some(line => line.includes("[Static Completion - Unavailable]")));
  assert.ok(h.logs.every(line => !line.includes("[Runtime Completion - Rejected]")));
});

test("cancelled or superseded static responses cannot publish or log inferred candidates", async () => {
  for (const cancelMode of ["cancel", "setting"]) {
    let release;
    let staticEnabled = true;
    const h = harness({
      staticAnalysis: () => staticEnabled,
      lspItems: () => new Promise(resolve => { release = resolve; }),
    });
    const input = snapshot("make_data()$");
    const published = [];
    const request = h.lang.handleAutocomplete({
      input, getCurrentInput: () => input, getWorkspaceData: () => undefined,
      applyCompletion() {}, onInlineEntries: items => published.push(items),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, "function", cancelMode);
    if (cancelMode === "cancel") h.lang.cancelCompletion();
    else staticEnabled = false;
    release({ rConsoleMemberResolved: true, items: [
      { label: "alpha", kind: 4, data: { type: "member" } },
    ] });
    await request;
    assert.deepEqual(published, []);
    assert.equal(h.logs.filter(line => line.includes("[Static Completion - Inferred]")).length, 0);
  }
});

test("source receiver selection targets only a direct global closure, not nested calls or methods", () => {
  const sourceNames = [
    ["make_data()$", "make_data"],
    ["make_data()$al", "make_data"],
    ["make_data()$nested$", "make_data"],
    ['make_data()[["inner"]]$', "make_data"],
    ['make_data()[["al', "make_data"],
    ["wrapper(make_data())$", "wrapper"],
    ["obj[[side_effect()]]$", undefined],
    ["obj$make_data()$", undefined],
    ["pkg::make_data()$", undefined],
    ["obj$", undefined],
  ];
  for (const [text, expected] of sourceNames) {
    const context = completion.getStaticFallbackContext(text, text.length);
    assert.equal(completion.storedFunctionReceiver(context ?? { kind: "default" }, text, text.length),
      expected, text);
  }
});

test("stored function source is requested on demand for earlier submissions and redefinitions", async () => {
  const definitions = {
    make_data: "function() list(alpha = 1)",
    wrapper: "function(x) list(outer = 1)",
  };
  const h = harness({
    storedSources: definitions,
    lspItems: (_mode, definition) => ({
      rConsoleMemberResolved: true,
      items: definition?.body.includes("alpha") ? [
        { label: "alpha", kind: 4, data: { type: "member" } },
      ] : definition?.body.includes("beta") ? [
        { label: "beta", kind: 4, data: { type: "member" } },
      ] : [{ label: "outer", kind: 4, data: { type: "member" } }],
    }),
  });
  assert.deepEqual(labels(await h.complete("make_data()$")), ["alpha"]);
  assert.deepEqual(h.sourceRequests, ["make_data"]);
  assert.deepEqual(h.requests[0].sourceDefinition, { name: "make_data", body: definitions.make_data });
  // An unrelated submission cannot remove the stored definition.
  assert.deepEqual(labels(await h.complete("make_data()$al")), ["alpha"]);
  definitions.make_data = "function() list(beta = 2)";
  assert.deepEqual(labels(await h.complete("make_data()$")), ["beta"]);
  assert.deepEqual(h.requests.at(-1).sourceDefinition.body, definitions.make_data);
  assert.deepEqual(labels(await h.complete("wrapper(make_data())$")), ["outer"]);
  const before = h.sourceRequests.length;
  assert.deepEqual(labels(await h.complete("obj[[side_effect()]]$")), ["outer"]);
  assert.equal(h.sourceRequests.length, before, "computed indices cannot borrow their inner call's source");
});

test("unsafe or unavailable source retrieval never prevents static fallback", async () => {
  for (const storedSources of [() => undefined, () => Promise.reject(new Error("unsafe binding"))]) {
    const h = harness({ storedSources, lspItems: { items: [{ label: "global", kind: 5 }] } });
    assert.deepEqual(labels(await h.complete("make_data()$")), []);
    assert.deepEqual(h.sourceRequests, ["make_data"]);
    assert.deepEqual(h.requests[0].sourceDefinition, undefined);
  }
});

test("cancelled source retrieval cannot publish a late completion", async () => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const pendingSource = new Promise(resolve => { release = resolve; });
  const h = harness({ storedSources: () => { entered(); return pendingSource; } });
  const pending = h.complete("make_data()$");
  await waiting;
  h.lang.cancelCompletion();
  release("function() list(alpha = 1)");
  assert.deepEqual(labels(await pending), []);
  assert.deepEqual(h.requests, [], "cancel before the stale source reaches the language server");
});

test("runtime-only completion never requests a live function definition", async () => {
  const h = harness({ staticAnalysis: false, storedSources: { make_data: "function() list(alpha = 1)" } });
  assert.deepEqual(labels(await h.complete("make_data()$")), []);
  assert.deepEqual(h.sourceRequests, []);
});


test("continued and quoted executable members keep static routing and exclude ambient names", async () => {
  for (const [marked, prefix] of [
    ["make_data()$\n  al│", "al"],
    ["make_data()$ # continuation\n  al│old", "al"],
    ["make_data()$\n# comment\nal│", "al"],
    ["make_data()$\n  │", ""],
    ["make_data()$`al│", "al"],
    ["make_data()$`al│old`", "al"],
    [String.raw`make_data()$` + '`a\\x6c│old`', "al"],
  ]) {
    const cursor = marked.indexOf("│"), text = marked.replace("│", "");
    const input = snapshot(text, cursor);
    const context = completion.getStaticFallbackContext(input.currentLine, input.cursorCol,
      input.textBeforeCursor, text.slice(cursor));
    assert.equal(context?.prefix, prefix, marked);
    assert.equal(context?.kind, "member", marked);
    const h = harness({ storedSources: { make_data: "function() list(alpha = 1)" },
      sessionData: { globalenv: { al_unrelated: { type: "double" } } } });
    const items = await h.complete(text, cursor);
    assert.deepEqual(labels(items), ["alpha"], marked);
    assert.deepEqual(h.sourceRequests, ["make_data"], marked);
    assert.deepEqual(h.native, [], marked);
    assert.equal(h.requests[0].mode, "static", marked);
    const pick = items.find(item => "insertText" in item);
    assert.equal(input.currentLine.slice(0, pick.replaceStart) + pick.insertText +
      input.currentLine.slice(pick.replaceEnd ?? input.cursorCol),
      input.currentLine.slice(0, context.replaceStart) + "alpha", marked);
    const disabled = harness({ staticAnalysis: false });
    assert.deepEqual(labels(await disabled.complete(text, cursor)), [], marked);
    assert.deepEqual(disabled.requests, [], marked);
    assert.deepEqual(disabled.native, [], marked);
  }
});

test("backticked safe receivers retain live authority and decoded prefixes", async () => {
  for (const staticAnalysis of [false, true]) {
    const h = harness({ staticAnalysis, inspected: { status: "available", names: ["odd field"] } });
    const text = "obj$`oddold`", cursor = "obj$`odd".length;
    const items = await h.complete(text, cursor);
    const pick = items.find(item => "insertText" in item);
    assert.equal(text.slice(0, pick.replaceStart) + pick.insertText + text.slice(pick.replaceEnd ?? cursor),
      "obj$`odd field`");
    assert.deepEqual(h.native, [["obj", "$"]]);
    assert.deepEqual(h.requests, []);
  }
});

test("multiline quoted brackets reach source inference without live evaluation", async () => {
  const text = 'make_data()[[\n  "al';
  const h = harness();
  assert.deepEqual(labels(await h.complete(text)), ["alpha"]);
  assert.deepEqual(h.native, []);
  assert.equal(h.requests[0].mode, "static");
});
