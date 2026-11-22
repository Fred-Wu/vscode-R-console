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

function harness({ staticAnalysis = true, inspected, lspItems, sessionData } = {}) {
  const logs = [], native = [], requests = [];
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
    requestRuntimeMemberCompletions: (receiver, operator) => {
      native.push([receiver, operator]);
      return Promise.resolve(typeof inspected === "function" ? inspected(receiver, operator) :
        inspected ?? { status: "available", names: [] });
    },
  });
  const provider = { provideCompletionItems: async (doc, position, trigger, contextPosition, bracket, mode) => {
    requests.push({ text: doc.getText(), position, mode });
    return typeof lspItems === "function" ? lspItems(mode) : lspItems ?? {
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
  return { lang, complete, logs, native, requests };
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
  assert.deepEqual(labels(await h.complete("obj[[")), ["alpha"]);
  assert.deepEqual(h.native, [["obj", "[["]]);
  assert.deepEqual(h.requests.map(r => r.mode), ["static"]);
});

test("executable single brackets do not borrow method arguments or lexical fields", async () => {
  const h = harness({ lspItems: { items: [
    { label: "drop", kind: 5, data: { type: "subscript_parameter" } },
    { label: "scope_field", kind: 4, data: { type: "scope" } },
  ] } });
  assert.deepEqual(labels(await h.complete("make_data()[")), []);
  assert.deepEqual(h.native, [], "executable receivers never reach the inspector");
  assert.deepEqual(h.requests.map(r => r.mode), ["static"]);
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
