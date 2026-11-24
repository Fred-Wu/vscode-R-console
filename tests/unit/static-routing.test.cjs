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

function harness({ staticAnalysis = true, inspected, lspItems, sessionData, storedSources, staticProvider } = {}) {
  const logs = [], native = [], requests = [], sourceRequests = [], sourceTargets = [];
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
    requestRuntimeFunctionSource: storedSources === undefined ? undefined : async (name, target) => {
      sourceRequests.push(name);
      sourceTargets.push(target);
      const result = await (typeof storedSources === "function" ? storedSources(name, target) : storedSources[name]);
      return typeof result === "string" ? { status: "source", text: result } : result;
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
  if (staticProvider) provider.provideStaticCompletion = staticProvider;
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
  return { lang, complete, logs, native, requests, sourceRequests, sourceTargets };
}

test("unavailable stored method arguments log the reason and remain retryable", async () => {
  for (const staticAnalysis of [true, false]) {
    const h = harness({ staticAnalysis, lspItems: { items: [], rConsoleArgumentsResolved: false,
      rConsoleStaticUnavailableReason: 'method-arguments-unavailable' } });
    await h.complete('task$levels(');
    await h.complete('task$levels(co');
    assert.equal(h.logs.length, 1, 'typing a prefix does not repeat the diagnostic');
    assert.match(h.logs[0], /Request completion could not determine this method's arguments\. No completion suggestions were returned\./);
    assert.ok(h.requests.length >= 2, 'unavailable signatures are retried');
    const refused = harness({ staticAnalysis, lspItems: { items: [], rConsoleArgumentsResolved: false,
      rConsoleStaticUnavailableReason: 'method-arguments-unavailable', rConsoleArgumentSuppressionReason: 'unsafe-dispatch' } });
    await refused.complete('task$levels(');
    assert.match(refused.logs[0], /Request completion could run a custom method\./);
    const known = harness({ staticAnalysis, lspItems: { items: [], rConsoleArgumentsResolved: true,
      rConsoleWorkspaceFunction: true, rConsoleArgumentsExhausted: true } });
    await known.complete('task$levels(cols = NULL, ');
    assert.deepEqual(known.logs, [], 'a fully supplied or zero-argument signature is a successful result');
  }
});

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

test("static fallback explains unresolved methods without calling an empty result inferred", async () => {
  for (const reason of ["receiver-unresolved", "unresolved-dispatch"]) {
    const h = harness({ inspected: { status: "suppressed", reason: "unsafe-dispatch" },
      sessionData: { globalenv: { custom_obj: { names: ["stale_secret"] } } },
      lspItems: { rConsoleMemberResolved: true, rConsoleStaticUnavailableReason: reason, items: [] } });
    assert.deepEqual(labels(await h.complete("custom_obj$inner$")), []);
    const log = h.logs.find(line => line.includes("[Static Completion - Unavailable]"));
    assert.match(log, /Request completion could run a custom method/);
    assert.match(log, /No completion suggestions were returned\.$/);
    assert.ok(h.logs.every(line => !line.includes("Inferred") && !line.includes("stale_secret")));
  }
  const empty = harness({ lspItems: { rConsoleMemberResolved: true, items: [] } });
  assert.deepEqual(labels(await empty.complete("make_data()$")), []);
  assert.ok(empty.logs.some(line => line.includes("[Static Completion - Inferred]")),
    "a known empty receiver remains an authoritative successful inference");
});

test("static fallback distinguishes missing services, failed requests and absent inference evidence", async () => {
  for (const [setup, expected] of [
    [h => { h.lang.ensureConsoleLspStarted = async () => undefined; }, /language server is not available/],
    [h => { h.lang.getOrOpenCompletionDocument = async () => undefined; }, /console input is not available/],
    [() => {}, /returned no completion result/],
  ]) {
    const h = harness({ lspItems: () => undefined });
    setup(h);
    assert.deepEqual(labels(await h.complete("make_data()$")), []);
    assert.ok(h.logs.some(line => expected.test(line)), h.logs.join("\n"));
  }
  const failed = harness({ lspItems: () => { throw Error("private source\nINJECTED"); } });
  await failed.complete("make_data()$");
  assert.ok(failed.logs.some(line => /completion request failed/.test(line)));
  assert.ok(failed.logs.every(line => !/private source|INJECTED/.test(line)));
});

test("static fallback retains only validated diagnostic metadata across later requests", async () => {
  let requests = 0;
  const h = harness({ lspItems: () => ++requests === 1
    ? { items: [], rConsoleStaticUnavailableReason: "analysis-pending" }
    : { items: [], rConsoleMemberResolved: true } });
  await h.complete("make_data()$al");
  assert.equal(requests, 1, 'pending analysis does not trigger an immediate prefix retry');
  await h.complete("make_data()$al");
  assert.equal(requests, 2);
  assert.ok(h.logs.some(line => line.includes("[Static Completion - Inferred]")),
    "a successful retry must clear the earlier failure reason");

  const unknown = harness({ lspItems: { items: [], rConsoleStaticUnavailableReason: "private_name\nINJECTED" } });
  await unknown.complete("make_data()$");
  assert.ok(unknown.logs.some(line => /No members could be inferred from source/.test(line)));
  assert.ok(unknown.logs.every(line => !/private_name|INJECTED/.test(line)));
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

test("source receiver selection targets the root named call, not downstream call heads", () => {
  const sourceNames = [
    ["make_data()$", "make_data"],
    ["make_data()$al", "make_data"],
    ["make_data()$nested$", "make_data"],
    ['make_data()[["inner"]]$', "make_data"],
    ['make_data()[["al', "make_data"],
    ["(make_data())$", "make_data"],
    ["((make_data()))$al", "make_data"],
    ["(make_data())$nested$", "make_data"],
    ["((make_data())$nested)$", "make_data"],
    ['((make_data())[["inner"]])$', "make_data"],
    ['((make_data()))[["al', "make_data"],
    ['(make_data()[[x[1]]])$', "make_data"],
    ["other <- ((make_data()))$", "make_data"],
    ["print((make_data())$", "make_data"],
    ["( # group\n  `make data`()\n)$", "make data"],
    ["other\n(make_data())$", "make_data"],
    ["if (TRUE) (make_data())$", "make_data"],
    ["function(x) (make_data())$", "make_data"],
    ["wrapper(make_data())$", "wrapper"],
    ["(wrapper((make_data())))$", "wrapper"],
    ["obj[[side_effect()]]$", undefined],
    ["obj$make_data()$", undefined],
    ["pkg::make_data()$", undefined],
    ["(obj$make_data())$", undefined],
    ["((pkg::make_data()))$", undefined],
    ["(make_data())()$", "make_data"],
    ["(make_data)()$", "make_data"],
    ["((make_data))()$", "make_data"],
    ['"make_data"()$', "make_data"],
    ['("make_data")()$', undefined],
    ["(obj[[make_data()]])$", undefined],
    ["(other + make_data())$", undefined],
    ["((make_data() + other))$", undefined],
    ["(-make_data())$", undefined],
    ["(if (TRUE) make_data())$", undefined],
    ["(1(make_data()))$", undefined],
    ["obj$", undefined],
  ];
  for (const [text, expected] of sourceNames) {
    const context = completion.getStaticFallbackContext(text, text.length);
    assert.equal(completion.storedFunctionReceiver(context ?? { kind: "default" }, text, text.length),
      expected, text);
  }
});

test("deep receiver grouping uses an iterative walk without borrowing a compound expression's call", () => {
  const context = { kind: "member", staticFallback: true };
  for (const [body, expected] of [["make_data()", "make_data"], ["other + make_data()", undefined]]) {
    const input = "(".repeat(5000) + body + ")".repeat(5000) + "$";
    assert.equal(completion.storedFunctionReceiver(context, input, input.length), expected);
  }
});

test("computed receiver identity follows only its outer named root", () => {
  for (const [text, expected] of [
    ['iris[1,,drop=FALSE]$', 'iris'],
    ['(iris[side_effect(),,drop=FALSE])$', 'iris'],
    ['obj[[side_effect()]]$method(', 'obj'],
    ['obj$method()$child$', 'obj'],
    ['obj$"method"()$child$', 'obj'],
    ['(obj$method)()$', 'obj'],
    ['obj[[side_effect()]]()$', 'obj'],
    ['(obj[side_effect()])[["na', 'obj'],
    ['`odd root`[f()]$', 'odd root'],
    ['other\n(iris[1,,drop=FALSE])$', 'iris'],
    ['if (TRUE) (iris[1,,drop=FALSE])$', 'iris'],
    ['pkg::iris[1,,drop=FALSE]$', undefined],
    ['(pkg::obj$method())$', undefined],
    ['(other + iris[1,,drop=FALSE])$', undefined],
    ['(-iris[1,,drop=FALSE])$', undefined],
  ]) {
    const line = text.split('\n').at(-1);
    const context = completion.getStaticFallbackContext(line, line.length, text) ??
      completion.getCompletionContext(line, line.length, text);
    const root = completion.storedReceiverRoot(context, text, text.length);
    assert.equal(root?.name, expected, text);
    if (root) assert.ok(text.slice(root.start).startsWith(expected === 'odd root' ? '`odd root`' : expected));
  }
});

test("one receiver classification preserves source eligibility and root identity", () => {
  // Mark the complete source token, not the first occurrence of its decoded
  // name (which may exclude quotes or appear earlier in the input).
  for (const [marked, name, target] of [
    ['((│make_data()))$inner$', 'make_data', 'source'],
    ['│make_data()[["inner"]]$', 'make_data', 'source'],
    ['│make_data()$"inner"$', 'make_data', 'source'],
    ['│make_data()$method()$', 'make_data', 'source'],
    ['(│make_data())()$', 'make_data', 'source'],
    ['│make_data()[[side_effect()]]()$', 'make_data', 'source'],
    ['│make_data()$"method"()$child$', 'make_data', 'source'],
    ['(│make_data)$method()$', 'make_data', 'binding'],
    ['(│make_data)()$', 'make_data', 'source-value'],
    ['((│make_data))()$', 'make_data', 'source-value'],
    ['((│make_data)())()$', 'make_data', 'source-value'],
    ['((│make_data))()$method()$', 'make_data', 'source-value'],
    ['((│make_data)$method)()$', 'make_data', 'binding'],
    ['(│make_data[[1]])()$', 'make_data', 'binding'],
    ['(other + make_data)()$', undefined, undefined],
    ['│"make_data"()$', 'make_data', 'source'],
    ["│'make_data'()$", 'make_data', 'source'],
    ['│"make\\x5fdata"()$', 'make_data', 'source'],
    ['make_data <- 1; │"make_data"()$', 'make_data', 'source'],
    ['make_data <- 1; (│make_data)()$', 'make_data', 'source-value'],
    ['("make_data")()$', undefined, undefined],
    ['(NULL)()$', undefined, undefined],
    ['(...)()$', undefined, undefined],
    ['(..1)()$', undefined, undefined],
    ['('.repeat(5000) + '│make_data' + ')'.repeat(5000) + '()$', 'make_data', 'source-value'],
    ['│obj[[side_effect()]]$method(', 'obj', 'binding'],
    ['│obj$"method"()$', 'obj', 'binding'],
    ['│`odd root`[f()]$', 'odd root', 'binding'],
    ['if (TRUE) (│make_data())$', 'make_data', 'source'],
    ['pkg::make_data()$', undefined, undefined],
    ['(other + make_data())$', undefined, undefined],
  ]) {
    const expectedStart = marked.indexOf("│");
    const text = marked.replace("│", "");
    const context = completion.getStaticFallbackContext(text, text.length) ??
      completion.getCompletionContext(text, text.length);
    const receiver = completion.storedCompletionReceiver(context, text, text.length);
    assert.equal(receiver?.name, name, text);
    assert.equal(receiver?.target, target, text);
    assert.equal(receiver?.start, expectedStart === -1 ? undefined : expectedStart, text);
  }
});

test("downstream receiver operations preserve guarded root source for the provider", async () => {
  const body = "function() list(inner = list(alpha = 1), method = function() list(beta = 2))";
  for (const text of [
    'make_data()$"inner"$',
    'make_data()$method()$',
    '(make_data())()$',
    'make_data()[[side_effect()]]()$',
    'make_data()$"method"()$child$',
  ]) {
    const h = harness({ storedSources: { make_data: body },
      lspItems: (_mode, definition) => ({
        items: definition?.body === body ? [{ label: "inferred", kind: 4, data: { type: "member" } }] : [],
      }),
    });
    assert.deepEqual(labels(await h.complete(text)), ["inferred"], text);
    assert.deepEqual(h.sourceRequests, ["make_data"], text);
    assert.deepEqual(h.requests.at(-1).sourceDefinition, { name: "make_data", body }, text);
    assert.equal(h.requests.at(-1).mode, "static", text);
    assert.deepEqual(h.native, [], "never inspect the computed receiver");
    const disabled = harness({ staticAnalysis: false, storedSources: { make_data: body } });
    assert.deepEqual(labels(await disabled.complete(text)), [], text);
    assert.deepEqual(disabled.sourceRequests, [], text);
    assert.deepEqual(disabled.native, [], text);
  }
});

test("named call heads preserve lookup semantics without evaluating receiver operations", async () => {
  const body = "function() list(alpha = 1)";
  for (const [text, target] of [
    ['make_data()$', 'source'],
    ['"make_data"()$', 'source'],
    ['(make_data)()$', 'source-value'],
    ['((make_data))()$al', 'source-value'],
    ['((make_data))()$child()$', 'source-value'],
    ['(make_data)()$method(', 'source-value'],
    ['(make_data)[[1]]()$', 'binding'],
    ['(make_data$method)()$', 'binding'],
  ]) {
    const h = harness({ storedSources: (_name, mode) => mode === 'binding' ? { status: 'opaque' } : body,
      lspItems: (_mode, definition) => ({
        items: definition?.body === body ? [{ label: "alpha", kind: 4, data: { type: "member" } }] : [],
      }),
    });
    await h.complete(text);
    assert.deepEqual(h.sourceRequests, ["make_data"], text);
    assert.deepEqual(h.sourceTargets, [target], text);
    assert.deepEqual(h.requests.at(-1).sourceDefinition, target === 'binding'
      ? { name: "make_data", opaqueReceiver: true } : { name: "make_data", body }, text);
    assert.deepEqual(h.native, [], text);
    const disabled = harness({ staticAnalysis: false, storedSources: { make_data: body } });
    await disabled.complete(text);
    assert.deepEqual(disabled.sourceRequests, [], text);
  }
  for (const result of [{ status: 'opaque' }, { status: 'unavailable' },
    { status: 'suppressed', reason: 'active-binding' }]) {
    const h = harness({ storedSources: { make_data: result }, lspItems: { items: [] } });
    await h.complete('(make_data)()$');
    assert.deepEqual(h.requests.at(-1).sourceDefinition, { name: 'make_data' }, result.status);
  }
});

test("binding-only refusal preserves computed identity and stored methods avoid redundant inspection", async () => {
  for (const status of ['opaque', 'unavailable', 'package', 'missing']) {
    const h = harness({ storedSources: { iris: { status } } });
    await h.complete('iris[1,,drop=FALSE]$');
    assert.deepEqual(h.sourceRequests, ['iris']);
    assert.deepEqual(h.requests.at(-1).sourceDefinition,
      ['package', 'missing'].includes(status) ? undefined : { name: 'iris', opaqueReceiver: true });
  }
  const h = harness({ storedSources: {} });
  await h.complete('obj$method(');
  assert.deepEqual(h.sourceRequests, [], 'stored argument inspection owns this receiver');
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
      items: definition?.body?.includes("alpha") ? [
        { label: "alpha", kind: 4, data: { type: "member" } },
      ] : definition?.body?.includes("beta") ? [
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
  assert.deepEqual(h.sourceRequests.slice(before), ['obj'], "computed indices inspect only their root binding");
  assert.deepEqual(h.requests.at(-1).sourceDefinition, { name: 'obj', opaqueReceiver: true });
});

test("unsafe or unavailable source retrieval preserves an opaque binding for static fallback", async () => {
  for (const storedSources of [() => undefined, () => ({ status: 'unavailable' }),
    () => ({ status: 'suppressed', reason: 'active-binding' }),
    () => ({ status: 'suppressed', reason: 'deferred-binding' }),
    () => Promise.reject(new Error("unsafe binding"))]) {
    const h = harness({ storedSources, lspItems: { items: [{ label: "global", kind: 5 }] } });
    assert.deepEqual(labels(await h.complete("make_data()$")), []);
    assert.deepEqual(h.sourceRequests, ["make_data"]);
    assert.deepEqual(h.requests[0].sourceDefinition, { name: "make_data" });
  }
  for (const status of ['missing', 'not-callable']) {
    const h = harness({ storedSources: () => ({ status }) });
    await h.complete('make_data()$');
    assert.equal(h.requests[0].sourceDefinition, undefined, status);
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

test("literal names begun on earlier lines never expose unrepresentable edits", async () => {
  for (const text of [
    "make_data()$`odd\nfi", "obj$`odd\nfi", "outer(make_data()$`odd\nfi",
    'make_data()[["odd\nfi', 'outer(make_data()[["odd\nfi', 'obj[["odd\nfi',
  ]) {
    const input = snapshot(text);
    assert.equal(completion.getStaticFallbackContext(input.currentLine, input.cursorCol, text), undefined, text);
    for (const staticAnalysis of [false, true]) {
      const h = harness({ staticAnalysis, storedSources: { make_data: 'function() list("odd\\nfield" = 1)' },
        inspected: { status: "available", names: ["odd\nfield"] },
        lspItems: { items: [{ label: "odd\nfield", kind: 4, data: { type: "member" } }] } });
      assert.deepEqual(labels(await h.complete(text)), [], text);
      assert.deepEqual(h.native, [], text);
      assert.deepEqual(h.requests, [], text);
      assert.deepEqual(h.sourceRequests, [], text);
    }
  }
});

test("source bracket routing counts individual nested delimiters", async () => {
  for (const text of [
    'wrapper(make_data()[x[1]])[["al',
    'wrapper(make_data()[[x[1]]])[["al',
    'wrapper(make_data()[[x[1]]])[["alold"]]',
    'wrapper(make_data()[x[1]])["al',
  ]) {
    const cursor = text.indexOf('"al') + 3;
    const context = completion.getStaticFallbackContext(text, cursor);
    assert.equal(context?.kind, "bracket", text);
    assert.equal(context.prefix, "al", text);
    assert.equal(context.bracketQuote, '"', text);
    assert.equal(context.replaceStart, cursor - 2, text);
    const h = harness({ storedSources: { wrapper: "function(x) list(alpha = 1)" } });
    assert.deepEqual(labels(await h.complete(text, cursor)), ["alpha"], text);
    assert.deepEqual(h.sourceRequests, ["wrapper"], text);
    assert.deepEqual(h.native, [], text);
  }
});


test("structural inference failures skip prefix retries while pending analysis stays retryable", async () => {
  for (const reason of ['receiver-unresolved', 'unresolved-dispatch', 'unsupported-context',
    'analysis-limit', 'inference-cycle', 'no-receiver-members', 'analysis-pending', undefined]) {
    const h = harness({ lspItems: { items: [], rConsoleStaticUnavailableReason: reason } });
    await h.complete('unknown_factory()$abc');
    assert.equal(h.requests.length, reason === undefined ? 2 : 1, reason);
    if (reason === 'analysis-pending') {
      await h.complete('unknown_factory()$abc');
      assert.equal(h.requests.length, 2, 'a later request retries pending analysis');
    }
  }
});

test('static bracket fallback accepts only a standalone key prefix', async () => {
  for (const text of ['make_data()[[index + "al', 'make_data()[[1, "al',
    'make_data()[[name = "al', 'make_data()[[index + al', 'make_data()[[1, al',
    'make_data()[["al" # comment']) {
    assert.equal(completion.getStaticFallbackContext(text, text.length), undefined, text);
    const h = harness();
    await h.complete(text);
    assert.equal(h.requests.length, 0, text);
    assert.equal(h.native.length, 0, text);
  }
  for (const text of ['make_data()[["al', 'make_data()[[ # key\n "al']) {
    const line = text.split('\n').at(-1);
    assert.equal(completion.getStaticFallbackContext(line, line.length, text)?.prefix, 'al', text);
  }
});

test("cancelled LSP startup does not authorize a provider binding lookup", { timeout: 3000 }, async () => {
  for (const text of ['make_data()$', 'make_data()$method(']) {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const h = harness({ storedSources: { make_data: 'function() list(method=function(alpha) NULL)' } });
    const provider = h.lang.ensureConsoleLspStarted;
    h.lang.ensureConsoleLspStarted = async () => { entered(); await waiting; return provider(); };
    const pending = h.complete(text);
    await started;
    assert.deepEqual(h.sourceRequests, [], 'bindings are selected by the provider after startup');
    h.lang.cancelCompletion();
    release();
    await pending;
    assert.deepEqual(h.sourceRequests, []);
    assert.deepEqual(h.requests, []);
  }
});

test("factory argument source selection preserves complete receiver identity", () => {
  for (const [text, expected] of [
    ['make_data()$method(', 'make_data'],
    ['((make_data()))$inner[[1]]$method(', 'make_data'],
    ['((make_data))()$method(', 'make_data'],
    ['make_data()$method(alpha = "a', 'make_data'],
    ['pkg::make_data()$method(', undefined],
    ['obj$make_data()$method(', undefined],
    ['(other + make_data())$method(', undefined],
    ['obj[[make_data()]]$method(', undefined],
  ]) {
    const context = completion.getCompletionContext(text, text.length);
    assert.equal(completion.storedFunctionReceiver(context, text, text.length), expected, text);
  }
});

test("refused live receivers carry their root identity into source fallback", async () => {
  for (const text of ['iris$', 'iris$nested$', 'iris[["na']) {
    const h = harness({ inspected: { status: 'suppressed', reason: 'active-binding' } });
    await h.complete(text);
    assert.deepEqual(h.requests.at(-1).sourceDefinition, { name: 'iris', opaqueReceiver: true });
  }
});

test('static providers discover multiple dependencies without terminal receiver selection', async () => {
  for (const text of ['factory(helper())$', '(left + factory())$']) {
    const requests = [];
    const h = harness({ storedSources: name => 'function() list(' + name + '=1)',
      staticProvider: async request => {
        requests.push(request);
        assert.deepEqual(h.sourceRequests, [], 'terminal performs no speculative source lookup');
        for (const name of ['helper', 'left', 'factory']) {
          const found = await request.bindings.resolve({ name, lookup: 'function', scope: { kind: 'search-path' } });
          assert.equal(found.status, 'source');
        }
        return { status: 'resolved', completion: { items: [{ label: 'alpha', kind: 4, data: { type: 'member' } }] } };
      },
    });
    assert.deepEqual(labels(await h.complete(text)), ['alpha']);
    assert.deepEqual(h.sourceRequests, ['helper', 'left', 'factory']);
    assert.equal(requests[0].input, text);
    assert.equal(requests[0].cursor, text.length);
    assert.deepEqual(h.requests, [], 'general providers bypass the compatibility adapter');
    assert.deepEqual(h.native, []);
  }
});

test('unknown static contexts reach providers with full source and validated replacement edits', async () => {
  for (const marked of ['factory()[, co│lumn]', 'factory()[1, "co│lumn"]', 'x <- 1\nfactory()[, co│lumn]']) {
    const cursor = marked.indexOf('│'), text = marked.replace('│', '');
    const input = snapshot(text, cursor);
    let calls = 0;
    const h = harness({ staticProvider: async request => {
      calls++;
      assert.equal(request.input, text);
      assert.equal(request.cursor, cursor);
      assert.deepEqual(request.contextPosition, new Position(input.cursorRow, input.cursorCol));
      const range = { start: new Position(input.cursorRow, input.cursorCol - 2), end: new Position(input.cursorRow, input.cursorCol + 4) };
      return { status: 'resolved', completion: { items: [
        { label: 'column', insertText: 'column', kind: 4, range },
        { label: 'no edit', kind: 4 },
        { label: 'column_external', insertText: 'column_external()', kind: 2, detail: '[workspace]', range,
          data: { package: '_workspace_', context_uri: 'file:///other.R' } },
        { label: 'bad edit', insertText: 'bad', kind: 4, range: { ...range, start: new Position(input.cursorRow, -1) } },
        { label: 'past end', insertText: 'bad', kind: 4, range: { ...range, end: new Position(input.cursorRow, 999) } },
      ] } };
    } });
    const items = (await h.complete(text, cursor)).filter(x => 'insertText' in x);
    assert.equal(calls, 1);
    assert.deepEqual(items.map(x => x.insertText), ['column']);
    assert.equal(items[0].replaceStart, input.cursorCol - 2);
    assert.equal(items[0].replaceEnd, input.cursorCol + 4);
    assert.deepEqual(h.native, []);
    const disabled = harness({ staticAnalysis: false, staticProvider: () => { throw Error('static is disabled'); } });
    assert.deepEqual(labels(await disabled.complete(text, cursor)), []);
  }
});

test('unresolved and pending providers cannot leak unrelated candidates or reuse cancelled capabilities', async () => {
  for (const status of ['unresolved', 'pending']) {
    let retained, calls = 0;
    const h = harness({ storedSources: { helper: 'function() 1' }, staticProvider: async request => {
      retained = request.bindings;
      calls++;
      return { status, reason: status === 'pending' ? 'analysis-pending' : 'receiver-unresolved',
        completion: { items: [{ label: 'co_unrelated', kind: 4, data: { type: 'member' } }] } };
    } });
    assert.deepEqual(labels(await h.complete('factory()[, co')), []);
    assert.equal(calls, 1);
    assert.equal((await retained.resolve({ name: 'helper', lookup: 'function', scope: { kind: 'search-path' } })).reason, 'cancelled');
    assert.deepEqual(h.sourceRequests, []);
    await h.complete('factory()[, co');
    assert.equal(calls, 2, 'later requests can retry');
  }
});

test('authoritative empty live receivers bypass the general static provider', async () => {
  let calls = 0;
  const h = harness({ inspected: { status: 'available', names: [] }, staticProvider: async () => {
    calls++; return { status: 'resolved-empty', completion: { items: [] } };
  } });
  assert.deepEqual(labels(await h.complete('obj$')), []);
  assert.equal(calls, 0);
});

test('value lookup of a non-callable binding remains opaque in the compatibility adapter', async () => {
  const h = harness({ storedSources: { factory: { status: 'not-callable' } } });
  await h.complete('(factory)()$');
  assert.deepEqual(h.requests[0].sourceDefinition, { name: 'factory' });
  assert.deepEqual(h.sourceTargets, ['source-value']);
});

test('authoritative empty static results stay complete and source refusal keeps its diagnostic', async () => {
  for (const text of ['factory()$al', 'factory()[, co']) {
    let calls = 0;
    const h = harness({ staticProvider: async () => {
      calls++; return { status: 'resolved-empty', completion: { items: [] } };
    } });
    assert.deepEqual(labels(await h.complete(text)), []);
    assert.equal(calls, 1);
    assert.equal(h.lang.inlineCache.entries.isIncomplete, undefined);
    assert.ok(h.logs.some(line => line.includes('[Static Completion - Inferred]')));
  }
  const h = harness({ storedSources: { factory: { status: 'suppressed', reason: 'active-binding' } },
    lspItems: { items: [], rConsoleStaticUnavailableReason: 'receiver-unresolved' } });
  await h.complete('factory()$');
  assert.ok(h.logs.some(line => line.includes('automatically linked')));
});
