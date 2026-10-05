const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const completion = loadSource("src/Language/completion.ts", {
  vscode: {
    CompletionItemKind: { Field: 4, Function: 2, Variable: 5, Property: 9, Module: 8 },
    SnippetString: class SnippetString {},
  },
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
  for (const [input, expected] of [["df[", "`a b`"], ["df[[", '"a b"'], ['df[["', "a b"]]) {
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined, workspace, []);
    assert.equal(entries.find((entry) => entry.label === "a b").insertText, expected);
    assert.equal(entries.filter((entry) => entry.label === "alpha").length, 1);
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
    sendRequest: async (_method, params) => {
      assert.equal(params.text, "stats::filter() + dplyr::filter(si)");
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
      needsLanguageServerCompletion: () => true,
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
      needsLanguageServerCompletion: (context) => context.kind === "package",
      collectCompletionEntries: async () => [],
      getCompletionIdentityKey: () => "",
      isCompletionPickItem: () => false,
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
      needsLanguageServerCompletion: () => true,
      collectCompletionEntries: async (context) => {
        if (context.prefix === "f") {
          refinedCompletionStarted = true;
        }
        return [];
      },
      getCompletionIdentityKey: () => "",
      isCompletionPickItem: () => false,
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
      needsLanguageServerCompletion: () => true,
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
