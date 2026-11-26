const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

class Position {
  constructor(line, character) { Object.assign(this, { line, character }); }
}

function createClient(t, { reply, completion, packageChanges, librarySync, start, stop, libraries = [], getCachedWorkspaceData, staticAnalysis = false, requestRuntimeFunctionArguments, getStartupStateStore } = {}) {
  const instances = [];
  const logs = [];
  let owningClient, captures = 0;
  class LanguageClient {
    constructor() {
      this.running = false;
      this.requests = [];
      this.documents = [];
      this.closed = 0;
      this.code2ProtocolConverter = {
        asOpenTextDocumentParams: (doc) => ({ text: doc.getText() }),
        asChangeTextDocumentParams: (doc) => ({ text: doc.getText() }),
        asCloseTextDocumentParams: () => ({}),
        asCompletionParams: (doc, position) => ({ text: doc.getText(), position }),
      };
      this.protocol2CodeConverter = { asCompletionResult: async (result) => result };
      instances.push(this);
    }
    isRunning() { return this.running; }
    async start() {
      await start?.(this);
      this.running = true;
      // Mock the native first-child stdout capture, not an LSP request.
      if (!owningClient.startupState) {
        owningClient.startupState = Buffer.from("opaque R state");
        captures++;
      }
    }
    async stop() { this.running = false; await stop?.(this); }
    async dispose() { this.running = false; }
    async sendNotification(method, params) {
      if (!this.running) throw new Error("Client is not running");
      if (method === "open" || method === "change") this.documents.push(params.text);
      if (method === "close") this.closed++;
    }
    async sendRequest(method, params, token) {
      if (!this.running) throw new Error("Client is not running");
      this.requests.push({ method, params });
      assert.notEqual(method, "rConsole/takeStartupState", "startup credentials never travel over LSP");
      if (method === "rConsole/syncSessionState") return await reply?.(this, params) ?? { libraryPaths: libraries };
      if (method === "rConsole/libraryPaths") return libraries;
      if (method === "rConsole/syncLibraryPaths") return await librarySync?.(this, params) ?? { changed: false };
      if (method === "rConsole/refreshPackages") return { restart: await packageChanges?.(this) ?? [] };
      assert.equal(method, "completion");
      return await completion?.(this, params, token) ?? [{ label: "lm" }];
    }
  }
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode: {
      Position, Range: class Range { constructor(start, end) { this.start = start; this.end = end; } },
      Uri: { parse: (value) => ({ toString: () => value }), file: () => ({}) },
      window: { createOutputChannel: () => ({ appendLine: line => logs.push(line), dispose() {} }) },
      workspace: { getConfiguration: () => ({ get: (key) => {
        if (key === "libPaths" || key === "useRenvLibPath") {
          throw new Error("Console language server must not read vscode-R library settings");
        }
        return undefined;
      } }) },
      CompletionTriggerKind: { Invoke: 1, TriggerCharacter: 2 },
    },
    "vscode-languageclient/node": {
      LanguageClient,
      CancellationTokenSource: require("vscode-languageserver-protocol").CancellationTokenSource,
      CompletionRequest: { type: "completion" },
      DidOpenTextDocumentNotification: { type: "open" },
      DidChangeTextDocumentNotification: { type: "change" },
      DidCloseTextDocumentNotification: { type: "close" },
      RevealOutputChannelOn: { Never: 4 },
    },
  });
  const client = new ConsoleLspClient({
    consoleId: "lifecycle-test", extensionPath: path.resolve(__dirname, "../.."),
    rPath: "R", env: {}, getCachedWorkspaceData,
    getStaticAnalysisEnabled: () => staticAnalysis,
    requestRuntimeFunctionArguments,
    getStartupStateStore,
  });
  owningClient = client;
  client.packageInventory.setLibraryPaths = () => {};
  t.after(() => client.dispose());
  return { client, instances, logs, captures: () => captures };
}

function change() {
  return { libraries: [{ path: "/base/library", packages: new Map() }],
    packages: new Map(), changed: ["stats"], isCurrent: () => true };
}

test("persistent state is retrieved before launching R and never recaptured on reattach", async t => {
  let release;
  const loading = new Promise(resolve => { release = resolve; });
  const { client, instances } = createClient(t, { getStartupStateStore: async () => ({
    load: () => loading, save: async () => assert.fail("reattach must not overwrite startup state"),
  }) });
  const starting = client.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instances.length, 0);
  release(Buffer.from("retained configuration"));
  await starting;
  assert.ok(!instances[0].requests.some(request => request.method === "rConsole/takeStartupState"));
  assert.ok(client.buildServerArgs({ get: () => undefined }, "entry.R").includes("--no-init-file"));
});

test("initial startup waits for storage acknowledgement and retries failed saves without rereading profiles", async t => {
  let saves = 0;
  const { client, captures } = createClient(t, { getStartupStateStore: async () => ({
    load: async () => undefined,
    save: async () => { if (++saves === 1) throw new Error("storage interrupted"); },
  }) });
  await assert.rejects(client.start(), /storage interrupted/);
  assert.equal(client.startupStateSaved, false);
  await client.start();
  assert.equal(client.startupStateSaved, true);
  assert.equal(saves, 2);
  assert.equal(captures(), 1, "private child stdout is captured only once");
});

test("failed persistent-state retrieval cannot fall back to running profiles", async t => {
  const { client, instances } = createClient(t, { getStartupStateStore: async () => ({
    load: async () => { throw new Error("state unavailable"); }, save: async () => {},
  }) });
  await assert.rejects(client.start(), /state unavailable/);
  assert.equal(instances.length, 0);
});

test("concurrent startup and completion wait for the durable-in-session acknowledgement", async t => {
  let release, entered;
  const storing = new Promise(resolve => { entered = resolve; });
  const acknowledgement = new Promise(resolve => { release = resolve; });
  t.after(release);
  const { client, instances } = createClient(t, { getStartupStateStore: async () => ({
    load: async () => undefined,
    save: async () => { entered(); await acknowledgement; },
  }) });
  const initial = client.start();
  await storing;
  let started = false, completed = false;
  const second = client.start().then(() => { started = true; });
  const completion = client.provideCompletionItems({ getText: () => "stats::" }, new Position(0, 7))
    .then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, false);
  assert.equal(completed, false);
  assert.ok(!instances[0].requests.some(request => request.method === "completion"));
  release();
  await Promise.all([initial, second, completion]);
  assert.equal(completed, true);
});

test("disposal during retrieval clears the received snapshot without launching R", async t => {
  let release, entered;
  const loading = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const { client, instances } = createClient(t, { getStartupStateStore: async () => ({
    load: () => { entered(); return response; }, save: async () => assert.fail("disposed client saved state"),
  }) });
  const rejected = assert.rejects(client.start(), /disposed/);
  await loading;
  const disposed = client.dispose();
  const state = Buffer.from("synthetic-secret");
  release(state);
  await Promise.all([rejected, disposed]);
  assert.deepEqual(state, Buffer.alloc(state.length));
  assert.equal(instances.length, 0);
});

// Each outcome bundles both TypeScript adapters. Give each an independent
// deadlock watchdog so parallel CI compilation does not consume a shared
// five-second budget; the promise gates below assert the required ordering.
for (const outcome of ['success', 'cancel', 'failure']) {
  test(`terminal static lookup overlaps startup: ${outcome}`, { timeout: 30000 }, async t => {
    let releaseStartup, sourceEntered;
    const startup = new Promise(resolve => { releaseStartup = resolve; });
    const inspected = new Promise(resolve => { sourceEntered = resolve; });
    t.after(releaseStartup);
    let starts = 0, reads = 0;
    const { client, instances } = createClient(t, { staticAnalysis: true,
      start: async () => {
        starts++;
        await startup;
        if (outcome === 'failure' && starts === 1) throw new Error('temporary startup failure');
      },
      completion: () => ({ rConsoleMemberResolved: true,
        items: [{ label: 'alpha', kind: 4, data: { type: 'member' } }] }),
    });
    const { RTermLang } = loadSource('src/Terminal/rTerminal/lang.ts', {
      vscode: { Position, CompletionItemKind: { Text: 0, Function: 2, Field: 4 },
        QuickPickItemKind: { Separator: -1 } },
      '../../Language/consoleLspClient': { ConsoleLspClient: class { constructor() { return client; } } },
    });
    const lang = new RTermLang({ extensionPath: '', rPath: 'R', env: {},
      getStaticAnalysisEnabled: () => true,
      requestRuntimeFunctionSource: async (name, target) => {
        reads++;
        assert.equal(name, 'factory');
        assert.equal(target, 'source');
        sourceEntered();
        return { status: 'source', text: 'function() list(alpha=1)' };
      },
    });
    lang.updateSessionData({ search: ['package:base'], globalenv: {} });
    const text = 'factory()$';
    const input = { text, textBeforeCursor: text, lines: [text], currentLine: text, cursorRow: 0, cursorCol: text.length };
    lang.getOrOpenCompletionDocument = async () => ({ version: 1, getText: () => text });
    let published = [];
    const complete = () => lang.handleAutocomplete({ input, force: true, getCurrentInput: () => input,
      getWorkspaceData: () => undefined, applyCompletion() {}, onInlineEntries: items => { published = items; } });
    const result = complete();
    await inspected;
    assert.equal(starts, 1, 'concurrent readiness calls share one native startup');
    assert.deepEqual(instances[0].documents, [], 'binding reads precede document synchronization');
    if (outcome === 'cancel') {
      lang.cancelCompletion();
      await result; // Cancellation settles the request while startup is blocked.
    }
    releaseStartup();
    await result;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(instances[0].requests.filter(r => r.method === 'completion').length, outcome === 'success' ? 1 : 0);
    assert.equal(published.some(item => item.insertText === 'alpha'), outcome === 'success');
    assert.equal(instances[0].documents.some(text => text.includes('factory')), outcome === 'success');
    if (outcome === 'failure') {
      assert.equal(lang.inlineCache.entries.isIncomplete, true);
      await complete();
      assert.equal(starts, 2);
      assert.equal(reads, 2, 'recovery obtains a fresh binding snapshot');
      assert.equal(published.some(item => item.insertText === 'alpha'), true);
    }
    await lang.dispose();
  });
}

test('cancelled startup cannot replace a newer stored-source projection', { timeout: 30000 }, async t => {
  let releaseStartup, releaseReply, markSent;
  const startup = new Promise(resolve => { releaseStartup = resolve; });
  const reply = new Promise(resolve => { releaseReply = resolve; });
  const sent = new Promise(resolve => { markSent = resolve; });
  t.after(() => { releaseStartup([]); releaseReply(); });
  const { client, instances } = createClient(t, {
    staticAnalysis: true,
    start: instance => {
      const send = instance.sendRequest.bind(instance);
      instance.sendRequest = (method, ...args) => method === 'rConsole/libraryPaths' ? startup : send(method, ...args);
    },
    completion: async () => { markSent(); await reply; return { items: [{ label: 'beta' }] }; },
  });
  const controller = new AbortController();
  let text = 'factory()$';
  const doc = { getText: () => text };
  const old = client.provideCompletionItems(doc, new Position(0, text.length), undefined, undefined,
    undefined, 'static', {}, { name: 'factory', body: 'function() list(alpha=1)' }, controller.signal);
  while (!instances[0]?.running) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  text = 'other()$';
  const latest = client.provideCompletionItems(doc, new Position(0, text.length), undefined, undefined,
    undefined, 'static', {}, { name: 'other', body: 'function() list(beta=1)' });
  await sent;
  releaseStartup([]);
  assert.equal(await old, undefined);
  assert.deepEqual(instances[0].documents, ['`other` <- function() list(beta=1)\nother()$']);
  releaseReply();
  assert.deepEqual((await latest).items, [{ label: 'beta' }]);
});

test('cancellation during session preparation or queued synchronization prevents obsolete work', async t => {
  for (const phase of ['session', 'document', 'refresh']) {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { entered = resolve; });
    t.after(release);
    let inspections = 0;
    const { client, instances } = createClient(t, { staticAnalysis: true,
      requestRuntimeFunctionArguments: async () => { inspections++; return { status: 'arguments', names: ['arg'] }; },
    });
    await client.start();
    if (phase === 'session') {
      const prepare = client.applySessionState.bind(client);
      let first = true;
      client.applySessionState = async (...args) => {
        if (first) { first = false; entered(); await gate; }
        return prepare(...args);
      };
    } else if (phase === 'document') {
      client.documentSyncPromise = gate;
      const sync = client.syncDocument.bind(client);
      client.syncDocument = (...args) => { entered(); return sync(...args); };
    } else {
      client.packageRefreshPromise = gate;
      entered();
    }
    const controller = new AbortController();
    const old = client.provideCompletionItems({ getText: () => 'old(' }, new Position(0, 4),
      undefined, undefined, undefined, 'static', {}, undefined, controller.signal);
    await waiting;
    controller.abort();
    if (phase === 'refresh') client.packageRefreshPromise = undefined;
    const latest = client.provideCompletionItems({ getText: () => 'new(' }, new Position(0, 4),
      undefined, undefined, undefined, 'static');
    release();
    assert.equal(await old, undefined, phase);
    assert.ok(await latest, phase);
    assert.deepEqual(instances[0].documents, ['new('], phase);
    assert.equal(inspections, 1, phase);
  }
});

test("explicit completion mode uses the existing virtual document and controls source inference", async t => {
  const { client, instances } = createClient(t, { staticAnalysis: true });
  const source = "object <- list(alpha = 1)\nobject$";
  const doc = { getText: () => source };
  const cursor = new Position(1, 7);
  await client.provideCompletionItems(doc, cursor, undefined, undefined, undefined, "runtime");
  await client.provideCompletionItems(doc, cursor, undefined, undefined, undefined, "static");
  const requests = instances[0].requests.filter(item => item.method === "completion");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].params.rConsoleStaticAnalysis, undefined);
  assert.equal(requests[1].params.rConsoleStaticAnalysis, true);
  assert.equal(requests[1].params.text, source,
    "static projection retains the original multiline input");
  assert.equal(requests[0].params.text.includes("object <- list"), false,
    "runtime projection hides unsubmitted definitions");
  for (const request of requests) {
    assert.equal(request.params.position.line, 1, "projected cursor stays on the second line");
    assert.equal(request.params.position.character, 7, "projected cursor preserves its column");
  }
  assert.equal(client.syncedDocuments.size, 1,
    "fallback reuses the existing document instead of creating another");
});


test("guarded source overlay preserves console replacement offsets and uses one virtual document", async t => {
  const { client, instances } = createClient(t, { staticAnalysis: true,
    completion: (_instance, params) => ({ items: [{
      label: "alpha", kind: 4, data: { type: "member" },
      range: { inserting: { start: params.position, end: params.position },
        replacing: { start: params.position, end: params.position } },
    }] }),
  });
  const text = "make_data()$";
  const cursor = new Position(0, text.length);
  const doc = { getText: () => text };
  const definition = { name: "make_data", body: "function() {\n  list(alpha = 1)\n}" };
  const result = await client.provideCompletionItems(doc, cursor, undefined,
    undefined, undefined, "static", undefined, definition);
  const request = instances[0].requests.find(item => item.method === "completion");
  const expectedPrelude = `\`make_data\` <- function() {\n  list(alpha = 1)\n}\n`;
  assert.equal(request.params.text, expectedPrelude + text);
  assert.equal(request.params.position.line, 3);
  assert.equal(request.params.position.character, text.length);
  assert.equal(result.items[0].range.inserting.start.line, 0,
    "provider edit points back to original console input");
  assert.equal(result.items[0].range.inserting.start.character, text.length);
  await client.provideCompletionItems(doc, cursor, undefined, undefined, undefined, "static");
  const requests = instances[0].requests.filter(item => item.method === "completion");
  assert.equal(requests[1].params.text, text, "request-scoped overlay is not retained");
  assert.equal(client.syncedDocuments.size, 1, "overlay never starts a second language server");
});

test("native member signatures never wait for runtime inspection", async t => {
  const { client } = createClient(t, {
    staticAnalysis: true,
    completion: () => ({ items: [], rConsoleLocalFunction: true }),
  });
  const result = await client.provideCompletionItems({ getText: () => "obj$fun(" }, new Position(0, 8));
  assert.equal(result.rConsoleLocalFunction, true);
});

test("attached packages prepare native metadata once, track detach and survive server replacement", async t => {
  const { client, instances } = createClient(t, { staticAnalysis: true,
    packageChanges: server => server === instances[0] ? ['stats'] : [] });
  await client.syncSessionState({ attachedPackages: ['polars', 'stats', 'polars', 'bad\";stop(1)'] });
  assert.deepEqual(instances[0].documents, ['stats::`.__r_console_metadata__`\npolars::`.__r_console_metadata__`']);
  assert.equal(instances[0].requests.some(item => item.method === 'completion'), false,
    'preparation only opens source for native background analysis');
  await client.syncSessionState({ attachedPackages: ['polars', 'stats', 'polars', 'bad\";stop(1)'] });
  assert.equal(instances[0].documents.length, 1, 'unchanged snapshots do not repeat preparation');
  await client.syncSessionState({ attachedPackages: ['stats'] });
  assert.equal(instances[0].closed, 1, 'remove old declarations before changing the search path');
  assert.equal(instances[0].documents.at(-1), 'stats::`.__r_console_metadata__`');
  await client.refreshPackages(change());
  assert.ok(instances[1].documents.includes('stats::`.__r_console_metadata__`'), 'replacement restores the current packages');
  assert.ok(!instances[1].documents.some(text => text.includes('polars')), 'detached packages stay detached');
  await client.syncSessionState({ attachedPackages: [] });
  assert.equal(client.packageDocument.getText(), '', 'detach clears package source');
});

test("package preparation is opt-in and can start after static analysis is enabled", async t => {
  const { client, instances } = createClient(t);
  const state = { attachedPackages: ['polars'] };
  await client.syncSessionState(state);
  assert.deepEqual(instances[0].documents, []);
  client.options.getStaticAnalysisEnabled = () => true;
  await client.syncSessionState(state);
  assert.deepEqual(instances[0].documents, ['polars::`.__r_console_metadata__`']);
  client.options.getStaticAnalysisEnabled = () => false;
  await client.syncSessionState(state);
  assert.equal(instances[0].closed, 1);
  assert.equal(client.syncedDocuments.size, 0);
});

test("background preparation reuses the native startup package metadata", async t => {
  const { client, instances } = createClient(t, { staticAnalysis: true,
    reply: () => ({ libraryPaths: [], startupPackages: ['base', 'stats'] }),
  });
  await client.syncSessionState({ attachedPackages: ['polars', 'stats', 'base'] });
  assert.deepEqual(instances[0].documents, ['polars::`.__r_console_metadata__`'],
    'do not build full namespace indexes for packages already covered by native startup');
});

test("stored method arguments are fetched afresh and never borrowed from global signatures", async t => {
  const inspected = [];
  let names = ['cols'];
  const { client, instances } = createClient(t, {
    getCachedWorkspaceData: () => ({ globalenv: { levels: { type: 'closure', str: 'function(wrong)' } } }),
    requestRuntimeFunctionArguments: expression => {
      inspected.push(expression); return { status: 'arguments', names };
    },
  });
  const text = 'task$levels(';
  for (const expected of [['cols'], ['replacement']]) {
    names = expected;
    await client.provideCompletionItems({ getText: () => text }, new Position(0, text.length));
    const params = instances[0].requests.filter(request => request.method === 'completion').at(-1).params;
    assert.deepEqual(params.rConsoleRuntimeArgumentNames, expected);
    assert.equal(params.rConsoleRuntimeArgumentRoot, 'task');
    assert.equal(params.rConsoleRuntimeSignature, undefined);
  }
  assert.deepEqual(inspected, ['task$levels', 'task$levels']);
  for (const source of ['levels(', 'factory()$levels(', 'task[[side_effect()]]$levels(']) {
    await client.provideCompletionItems({ getText: () => source }, new Position(0, source.length));
  }
  assert.equal(inspected.length, 2, 'executable receivers cannot reach native inspection');
});

test("prefix retries share native argument snapshots only within the current request", async t => {
  const { getLanguageServerCompletions } = loadSource('src/Language/completion/languageServer.ts', {
    vscode: { Position, CompletionItemKind: { Text: 0, Field: 4 } },
  });
  const text = 'obj$fun(alpha_beta = "zzz';
  const doc = { getText: () => text };
  const position = new Position(0, text.length);
  const context = { kind: 'argument', prefix: 'zzz', replaceStart: text.length - 3,
    snapshotInput: text, snapshotCursor: text.length, functionName: 'obj$fun', functionOperator: '$',
    argumentValue: { quote: '"', name: 'alpha_beta', prefix: 'zzz', replaceStart: text.length - 3 } };
  for (const mode of ['runtime', 'static']) {
    let inspections = 0;
    const { client, instances } = createClient(t, {
      requestRuntimeFunctionArguments: () => {
        inspections++; return { status: 'arguments', names: ['alpha_beta'] };
      },
      completion: () => ({ items: [], rConsoleWorkspaceFunction: true, rConsoleArgumentsResolved: true }),
    });
    for (let request = 1; request <= 2; request++) {
      await getLanguageServerCompletions(context, doc, position, [], client, undefined, mode);
      assert.equal(inspections, request, 'each new completion reads fresh live arguments');
      assert.equal(instances[0].requests.filter(item => item.method === 'completion').length, request * 2,
        'the prefix retry remains available after the preceding invocation expires');
    }
  }
});

test("a shared request never reuses arguments after runtime, document or session changes", async t => {
  for (const change of ['runtime', 'document', 'session', 'packages', 'client']) {
    let inspections = 0;
    const { client, instances } = createClient(t, {
      requestRuntimeFunctionArguments: () => { inspections++; return { status: 'arguments', names: ['old'] }; },
      completion: () => ({ items: [] }),
    });
    const scope = {}, text = 'obj$fun(zzz';
    const doc = { getText: () => text }, position = new Position(0, text.length);
    const complete = (document = doc) => client.provideCompletionItems(document, position,
      undefined, position, undefined, undefined, scope);
    await complete();
    const sent = instances.reduce((n, instance) => n + instance.requests.filter(r => r.method === 'completion').length, 0);
    if (change === 'runtime') client.invalidateRuntimeCompletion();
    if (change === 'session') await client.syncSessionState({ attachedPackages: ['base'] });
    if (change === 'packages') client.packageRevision++;
    if (change === 'client') { client.client = undefined; client.startPromise = undefined; }
    assert.equal(await complete(change === 'document' ? { getText: () => 'obj$fun(zzzz' } : doc), undefined, change);
    assert.equal(inspections, 1, change);
    assert.equal(instances.reduce((n, instance) => n + instance.requests.filter(r => r.method === 'completion').length, 0), sent, change);
  }
});

test("opaque source bindings preserve input and respect projected package selections", async t => {
  const { client, instances } = createClient(t, { staticAnalysis: true });
  const text = 'data.frame(fake = 1)$';
  const doc = { getText: () => text }, position = new Position(0, text.length);
  await client.provideCompletionItems(doc, position, undefined, undefined, undefined, 'static', undefined, { name: 'data.frame' });
  let params = instances[0].requests.filter(item => item.method === 'completion').at(-1).params;
  assert.equal(params.text, text, 'an opaque binding adds no invented R source');
  assert.equal(params.rConsoleOpaqueFunction, 'data.frame');
  client.updateInput(text);
  client.recordCompletion(text, 0, { insertText: 'data.frame()', packageName: 'base' });
  await client.provideCompletionItems(doc, position, undefined, undefined, undefined, 'static', undefined, { name: 'data.frame' });
  params = instances[0].requests.filter(item => item.method === 'completion').at(-1).params;
  assert.equal(params.text, 'base::' + text);
  assert.equal(params.rConsoleOpaqueFunction, undefined);
});

test("runtime changes while reading stored arguments discard the snapshot before sending it to LSP", async t => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { client, instances } = createClient(t, {
    requestRuntimeFunctionArguments: () => new Promise(resolve => { finish = resolve; started(); }),
  });
  const text = 'task$levels(';
  const pending = client.provideCompletionItems({ getText: () => text }, new Position(0, text.length));
  await ready;
  client.invalidateRuntimeCompletion();
  finish({ status: 'arguments', names: ['stale'] });
  assert.equal(await pending, undefined);
  assert.equal(instances[0].requests.filter(request => request.method === 'completion').length, 0);
});

test("any stored callable can supply arguments independently of its display class", async t => {
  const inspected = [];
  const { client, instances } = createClient(t, {
    getCachedWorkspaceData: () => ({ globalenv: {
      decorated: { type: 'closure', str: '<arbitrary class> custom display' },
      ordinary: { type: 'closure', str: 'function(x, mode = "auto")' },
    } }),
    requestRuntimeFunctionArguments: name => {
      inspected.push(name);
      return name === 'refused' ? { status: 'suppressed', reason: 'active-binding' }
        : { status: 'arguments', names: ['x', 'cols'] };
    },
  });
  for (const name of ['decorated', 'without_metadata', 'ordinary', 'refused']) {
    const text = name + '(';
    await client.provideCompletionItems({ getText: () => text }, new Position(0, text.length));
    const params = instances[0].requests.filter(item => item.method === 'completion').at(-1).params;
    if (name === 'ordinary') {
      assert.equal(params.rConsoleRuntimeSignature, 'function(x, mode = "auto")');
    } else if (name === 'refused') {
      assert.equal(params.rConsoleRuntimeArgumentsRefused, true);
      assert.equal(params.rConsoleRuntimeArgumentNames, undefined);
    } else {
      assert.deepEqual(params.rConsoleRuntimeArgumentNames, ['x', 'cols']);
      assert.equal(params.rConsoleRuntimeArgumentRoot, name);
    }
  }
  assert.deepEqual(inspected, ['decorated', 'without_metadata', 'refused']);
});

test("method refusal and resolution metadata survive conversion but source shadowing discards the old refusal", async t => {
  let ignored = false;
  const { client } = createClient(t, { staticAnalysis: true,
    requestRuntimeFunctionArguments: () => ({ status: 'suppressed', reason: 'unsafe-dispatch' }),
    completion: instance => {
      instance.protocol2CodeConverter.asCompletionResult = async result => ({ items: result.items });
      return { items: [], rConsoleArgumentsResolved: false, rConsoleRuntimeArgumentsIgnored: ignored,
        rConsoleStaticUnavailableReason: 'method-arguments-unavailable' };
    },
  });
  const text = 'task$levels(';
  const complete = () => client.provideCompletionItems({ getText: () => text }, new Position(0, text.length));
  const first = await complete();
  assert.equal(first.rConsoleArgumentsResolved, false);
  assert.equal(first.rConsoleArgumentSuppressionReason, 'unsafe-dispatch');
  assert.equal(first.rConsoleStaticUnavailableReason, 'method-arguments-unavailable');
  ignored = true;
  assert.equal((await complete()).rConsoleArgumentSuppressionReason, undefined);
});

test("unknown live argument inspection cannot authorize package signatures", async t => {
  let response;
  const { client, instances } = createClient(t, { staticAnalysis: true,
    requestRuntimeFunctionArguments: () => response,
  });
  for (response of [
    ...['opaque', 'unavailable', 'not-callable', 'missing', 'package'].map(status => ({ status })),
    undefined, Promise.resolve(undefined),
  ]) {
    const status = (await response)?.status;
    for (const text of ['data.frame(', 'api$scan(']) {
      await client.provideCompletionItems({ getText: () => text }, new Position(0, text.length));
      const params = instances[0].requests.filter(item => item.method === 'completion').at(-1).params;
      assert.equal(params.rConsoleRuntimeArgumentsRefused,
        !status || ['opaque', 'unavailable', 'not-callable'].includes(status) ? true : undefined, status + ': ' + text);
      assert.equal(params.rConsoleRuntimeArgumentNames, undefined);
    }
  }
});

test("failed package-document preparation is retryable on the same client and state", async t => {
  const { client, instances } = createClient(t, { staticAnalysis: true });
  await client.start();
  const instance = instances[0];
  const send = instance.sendNotification.bind(instance);
  let failures = 1;
  instance.sendNotification = async (method, params) => {
    if (method === 'open' && failures-- > 0) throw new Error('temporary document failure');
    return send(method, params);
  };
  const state = { attachedPackages: ['polars'] };
  await assert.rejects(client.syncSessionState(state), /temporary document failure/);
  await client.syncSessionState(state);
  assert.deepEqual(instance.documents, ['polars::`.__r_console_metadata__`']);
  await Promise.all([client.syncSessionState(state), client.syncSessionState({ ...state })]);
  assert.equal(instance.documents.length, 1);
});

test("static diagnostic metadata survives VS Code conversion without forwarding arbitrary text", async t => {
  let reason = "unresolved-dispatch";
  const { client } = createClient(t, { staticAnalysis: true,
    completion: instance => {
      // VS Code discards custom fields while converting the standard result.
      instance.protocol2CodeConverter.asCompletionResult = async result => ({ items: result.items });
      return { items: [], rConsoleMemberResolved: true, rConsoleStaticUnavailableReason: reason };
    },
  });
  const doc = { getText: () => "custom_obj$inner$" };
  const cursor = new Position(0, doc.getText().length);
  const result = await client.provideCompletionItems(doc, cursor);
  assert.equal(result.rConsoleMemberResolved, true);
  assert.equal(result.rConsoleStaticUnavailableReason, "unresolved-dispatch");
  reason = "secret_source\nINJECTED";
  assert.equal((await client.provideCompletionItems(doc, cursor)).rConsoleStaticUnavailableReason, undefined);
});

test("cached workspace functions use one LSP request without sess inspection", async t => {
  const { client, instances } = createClient(t, {
    getCachedWorkspaceData: () => ({ globalenv: {
      f: { type: "closure", str: "function(first, second = 2)" },
    } }),
    completion: (_client, params) => ({ items: [], seenSignature: params.rConsoleRuntimeSignature }),
  });
  for (const text of ["f(", "`f`("]) {
    const result = await client.provideCompletionItems({ getText: () => text },
      new Position(0, text.length));
    assert.equal(result.seenSignature, "function(first, second = 2)", text);
  }
  assert.equal(instances[0].requests.filter(request => request.method === "completion").length, 2);
});

test("first session snapshot keeps the running server", async (t) => {
  const { client, instances } = createClient(t);
  await client.start();
  await client.syncSessionState({ attachedPackages: ["stats"] });
  assert.equal(instances.length, 1, "matching paths must not restart a healthy server");
});

test("a package refresh recovers a stopped server and restores session state", async t => {
  const { client, instances } = createClient(t);
  await client.syncSessionState({ attachedPackages: ["stats"] });
  instances[0].running = false;
  await client.refreshPackages(change());
  assert.equal(instances.length, 2);
  const requests = instances[1].requests;
  const sync = requests.findIndex(request => request.method === "rConsole/syncSessionState");
  const refresh = requests.findIndex(request => request.method === "rConsole/refreshPackages");
  assert.ok(sync >= 0 && refresh > sync);
  assert.deepEqual(requests[refresh].params.changed, [], "a fresh server already loads the updated files");
  assert.deepEqual(await client.provideCompletionItems({ getText: () => "stats::l" }, new Position(0, 8)),
    [{ label: "lm" }]);
});


test("a confirmed loaded-package change restarts once and applies the latest session state", async (t) => {
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  t.after(releaseStart);
  const oldProcess = { exitCode: 0, signalCode: null };
  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const { client, instances, logs } = createClient(t, {
    packageChanges: (server) => server === instances[0] ? ["stats"] : [],
    start: async (server) => {
      if (server === instances[1]) {
        client.logServerStarted();
        client.logServerError(reset, {});
        await startGate;
      }
    },
    stop: server => {
      if (server === instances[0]) {
        client.logServerError(reset, oldProcess);
        client.logServerStopped(0, null, oldProcess);
      }
    },
  });
  await client.start();
  client.spawnedServer = oldProcess;
  await client.syncSessionState({ attachedPackages: ["stats"] });
  const first = client.refreshPackages(change());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instances.length, 2);
  const concurrentStart = client.start();
  const latest = client.syncSessionState({ attachedPackages: ["utils"] });
  releaseStart();
  await Promise.all([first, concurrentStart, latest]);
  assert.equal(instances.length, 2, "concurrent callers share one restart");
  assert.deepEqual(instances[1].requests.filter(request => request.method === "rConsole/syncSessionState").at(-1).params, {
    attachedPackages: ["utils"],
  });
  const refreshed = instances[1].requests.findIndex(request => request.method === "rConsole/refreshPackages");
  assert.ok(refreshed >= 0);
  assert.ok(refreshed < instances[1].requests.findIndex(request => request.method === "completion"));
  assert.ok(logs.some(line => line.includes("connection closed during planned restart: stats (removed) (ECONNRESET)")));
  assert.ok(logs.some(line => line.includes("stopped (exit code 0; planned restart: stats (removed))")));
  assert.ok(logs.some(line => line.endsWith("R Console language server started")));
  assert.equal(logs.filter(line => line.startsWith("[Error -") && line.includes("ECONNRESET")).length, 1,
    "a connection reset from the replacement process must still be reported as an error");
});

test("completion survives a background replacement while its response is pending", async (t) => {
  const { client, instances } = createClient(t, {
    packageChanges: (server) => server === instances[0] ? ["stats"] : [],
  });
  await client.start();
  const first = instances[0];
  const originalRequest = first.sendRequest.bind(first);
  let sync;
  first.sendRequest = async (method, params) => {
    if (method === "completion") {
      sync = client.refreshPackages(change());
      await sync;
      throw new Error("Pending response rejected since connection got disposed");
    }
    return originalRequest(method, params);
  };
  const result = await client.provideCompletionItems({ getText: () => "stats::l" }, new Position(0, 8));
  await sync;
  assert.deepEqual(result, [{ label: "lm" }]);
  assert.equal(instances.length, 2);
  assert.equal(instances[1].documents.at(-1), "stats::l", "reopen the document on the replacement server");
});

test("completion retries a request interrupted by a server replacement", async (t) => {
  const { client, instances } = createClient(t, {
    packageChanges: (server) => server === instances[0] ? ["stats"] : [],
    completion: async (server) => {
      if (server === instances[0]) {
        await client.refreshPackages(change());
        throw new Error("Pending response rejected since connection got disposed");
      }
      return [{ label: "lm" }];
    },
  });
  await client.start();
  assert.deepEqual(await client.provideCompletionItems({ getText: () => "stats::l" }, new Position(0, 8)),
    [{ label: "lm" }]);
  assert.equal(instances.length, 2);
});

test("ordinary completion errors do not restart the server or repeat the request", async (t) => {
  const { client, instances } = createClient(t, {
    completion: () => { throw new Error("Invalid completion input"); },
  });
  const result = await client.provideCompletionItems({ getText: () => "stats::l" }, new Position(0, 8));
  assert.equal(result, undefined);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].requests.filter(({ method }) => method === "completion").length, 1);
});

test("package replacement and a simultaneous session update share one restart", async (t) => {
  let releaseStop;
  let enteredStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  const stopping = new Promise((resolve) => { enteredStop = resolve; });
  t.after(releaseStop);
  const { client, instances } = createClient(t, {
    packageChanges: (server) => server === instances[0] ? ["stats"] : [],
    stop: async (server) => {
      if (server === instances[0]) { enteredStop(); await stopGate; }
    },
  });
  await client.start();
  const refresh = client.refreshPackages(change());
  const request = client.provideCompletionItems({ getText: () => "stats::l" }, new Position(0, 8));
  await stopping;
  const state = { attachedPackages: ["stats"] };
  const sync = client.syncSessionState(state);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instances.length, 1, "do not launch a server while its predecessor is stopping");
  releaseStop();
  const [result] = await Promise.all([request, sync, refresh]);
  assert.deepEqual(result, [{ label: "lm" }]);
  assert.equal(instances.length, 2);
  assert.deepEqual(instances[1].requests.find(({ method }) => method === "rConsole/syncSessionState").params, state);
});

test("a superseded session update applies the latest attached packages", async (t) => {
  let releaseReply;
  let enteredRequest;
  const replyGate = new Promise((resolve) => { releaseReply = resolve; });
  const requested = new Promise((resolve) => { enteredRequest = resolve; });
  t.after(() => releaseReply({ libraryPaths: ["/obsolete"] }));
  let requests = 0;
  const { client, instances } = createClient(t, {
    staticAnalysis: true,
    reply: async () => { if (++requests === 1) { enteredRequest(); return replyGate; } return { libraryPaths: ["/current"] }; },
  });
  const first = client.syncSessionState({ attachedPackages: ["stats"] });
  await requested;
  const latest = client.syncSessionState({ attachedPackages: ["utils"] });
  releaseReply({ libraryPaths: ["/obsolete"] });
  await Promise.all([first, latest]);
  assert.equal(instances.length, 1);
  assert.equal(requests, 2, "check the latest state before deciding to restart");
  assert.deepEqual(instances[0].documents, ['utils::`.__r_console_metadata__`'],
    'an obsolete session reply must not start metadata preparation for detached packages');
});

test("cached session state reaches the LSP before its first launch", async () => {
  const calls = [];
  class ConsoleLspClient {
    async start() { calls.push("start"); }
    async syncSessionState(state) { calls.push(state); }
    updateInput() {}
    async dispose() {}
  }
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {}, "../../Language/completion": {},
    "../../Language/consoleLspClient": { ConsoleLspClient },
  });
  const lang = new RTermLang({ extensionPath: "", rPath: "R", env: {} });
  const data = { search: ["package:stats"], globalenv: { f: { type: "closure", str: "function(first)" } }, loaded_namespaces: [] };
  lang.updateSessionData(data);
  await lang.getCompletionProvider();
  assert.deepEqual(calls, [{ attachedPackages: ["stats"] }],
    "workspace function signatures are no longer sent to the separate language server");
  assert.equal(lang.updateSessionData(data), false, "unchanged metadata is not resent");
  lang.clearSessionState();
  assert.deepEqual(calls.at(-1), { attachedPackages: [] });
  await lang.dispose();
});

test("a pending LSP response cannot publish after the runtime changes", async t => {
  let release, entered;
  const reply = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  t.after(() => release({ items: [] }));
  let requests = 0;
  const { client } = createClient(t, {
    completion: async () => { requests++; entered(); return reply; },
  });
  const pending = client.provideCompletionItems({ getText: () => "f(" }, new Position(0, 2));
  await waiting;
  client.invalidateRuntimeCompletion();
  release({ items: [{ label: "old_arg", detail: "parameter" }] });
  assert.equal(await pending, undefined);
  assert.equal(requests, 1);
});

test("live console paths override startup paths, including stale LSP synchronization replies", async t => {
  const { client, logs } = createClient(t, { libraries: ["/startup"] });
  const watched = [];
  client.packageInventory.setLibraryPaths = paths => watched.push([...paths]);
  client.updateRuntimeLibraryPaths(["/added", "/startup"]);
  await client.start();
  assert.deepEqual(watched.at(-1), ["/added", "/startup"],
    "a snapshot received before LSP startup must become its initial inventory");
  await client.syncSessionState({ attachedPackages: ["stats"] });
  assert.deepEqual(watched.at(-1), ["/added", "/startup"],
    "the LSP's own stale paths must not overwrite the R Console");
  client.updateRuntimeLibraryPaths(["/startup", "/added"]);
  assert.deepEqual(watched.at(-1), ["/startup", "/added"], "reordering changes precedence");
  client.updateRuntimeLibraryPaths(["/startup"]);
  assert.deepEqual(watched.at(-1), ["/startup"], "removal stops monitoring the old library");
  const count = watched.length;
  client.updateRuntimeLibraryPaths(["/startup"]);
  assert.equal(watched.length, count, "unchanged snapshots do not rescan");
  assert.ok(logs.some(line => line.includes("Removed from search order: /added")));
  assert.ok(logs.some(line => line.includes("R Console library search order changed")));
  client.resetRuntimeLibraryPaths();
  assert.deepEqual(watched.at(-1), ["/startup"]);
});

test("a late session-sync reply cannot replace newer R Console paths", async t => {
  let releaseReply, requestStarted;
  const gate = new Promise(resolve => { releaseReply = resolve; });
  const started = new Promise(resolve => { requestStarted = resolve; });
  t.after(() => releaseReply({ libraryPaths: ["/stale"] }));
  const { client } = createClient(t, {
    libraries: ["/startup"],
    reply: async () => { requestStarted(); return gate; },
  });
  const watched = [];
  client.packageInventory.setLibraryPaths = paths => watched.push([...paths]);
  await client.start();
  const synchronizing = client.syncSessionState({ attachedPackages: ["stats"] });
  await started;
  client.updateRuntimeLibraryPaths(["/new", "/startup"]);
  releaseReply({ libraryPaths: ["/stale"] });
  await synchronizing;
  assert.deepEqual(watched.at(-1), ["/new", "/startup"]);
  assert.equal(client.buildServerEnv({ get: () => undefined }).VSCR_RUNTIME_LIB_PATHS,
    "/new\n/startup");
  client.resetRuntimeLibraryPaths();
  assert.equal(client.buildServerEnv({ get: () => undefined }).VSCR_RUNTIME_LIB_PATHS, "/startup",
    "replacement falls back to the captured server libraries after a runtime reset");
});

test("library directory additions, reordering and removals synchronize without inventory publication", async t => {
  const { client, instances } = createClient(t, { libraries: ["/base"] });
  // The fixture disables inventory monitoring. No refreshPackages callback is delivered.
  await client.start();
  for (const paths of [["/first", "/base"], ["/base", "/first"], ["/base"]]) {
    client.updateRuntimeLibraryPaths(paths);
    await client.libraryPathsSyncPromise;
    assert.deepEqual(instances[0].requests.at(-1), {
      method: "rConsole/syncLibraryPaths", params: { libraryPaths: paths },
    });
  }
  const count = instances[0].requests.length;
  client.updateRuntimeLibraryPaths(["/base"]);
  await client.syncLibraryPaths();
  assert.equal(instances[0].requests.length, count);
  assert.ok(!instances[0].requests.some(request => request.method === "rConsole/refreshPackages"));
});

test("library synchronization serializes snapshots and gates completion on the latest order", async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release({ changed: false }));
  const { client, instances } = createClient(t, { libraries: ["/base"],
    librarySync: async (_instance, params) => {
      if (params.libraryPaths[0] === "/first") { entered(); return gate; }
    },
  });
  await client.start();
  client.updateRuntimeLibraryPaths(["/first", "/base"]);
  await started;
  client.updateRuntimeLibraryPaths(["/second", "/base"]);
  const completing = client.provideCompletionItems({ getText: () => "stats::l" }, new Position(0, 8));
  assert.ok(!instances[0].requests.some(request => request.method === "completion"));
  release({ changed: false });
  await completing;
  const requests = instances[0].requests;
  assert.deepEqual(requests.filter(request => request.method === "rConsole/syncLibraryPaths")
    .map(request => request.params.libraryPaths), [["/first", "/base"], ["/second", "/base"]]);
  assert.equal(requests.at(-1).method, "completion");
});

test("a path snapshot arriving during completion preparation cannot publish old candidates", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release({ changed: false }));
  const { client } = createClient(t, { libraries: ["/base"], librarySync: () => gate,
    completion: () => [{ label: "oldCandidate" }],
  });
  await client.start();
  const prepare = client.applySessionState.bind(client);
  client.applySessionState = async (...args) => {
    await prepare(...args);
    client.updateRuntimeLibraryPaths(["/new", "/base"]);
  };
  assert.equal(await client.provideCompletionItems({ getText: () => "stats::l" }, new Position(0, 8)),
    undefined);
});

test("a library change refreshes cached namespaces independently of package discovery", async t => {
  let changed = true;
  const { client, instances } = createClient(t, { libraries: ["/base"],
    librarySync: () => { const reply = { changed }; changed = false; return reply; },
  });
  await client.start();
  await client.syncSessionState({ attachedPackages: ["stats"] });
  const startupState = client.startupState;
  client.updateRuntimeLibraryPaths(["/new", "/base"]);
  await client.libraryPathsSyncPromise;
  assert.equal(instances.length, 2);
  assert.equal(client.startupState, startupState);
  await client.provideCompletionItems({ getText: () => "stats::l" }, new Position(0, 8));
  assert.ok(instances[1].requests.some(request => request.method === "rConsole/syncSessionState"));
  assert.ok(!instances.flatMap(instance => instance.requests)
    .some(request => request.method === "rConsole/refreshPackages"));
});

test("snapshots arriving during startup and replacement settle on the latest order", async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  t.after(release);
  let starts = 0;
  const { client, instances } = createClient(t, { libraries: ["/base"],
    start: async () => { if (++starts === 2) { entered(); await gate; } },
    librarySync: instance => ({ changed: instance === instances[0] }),
  });
  const starting = client.start();
  client.updateRuntimeLibraryPaths(["/first", "/base"]);
  await waiting;
  client.updateRuntimeLibraryPaths(["/second", "/base"]);
  release();
  await starting;
  assert.equal(instances.length, 2);
  assert.equal(client.syncedLibraryPaths.key, JSON.stringify(["/second", "/base"]));
  assert.deepEqual(instances[1].requests.at(-1).params.libraryPaths, ["/second", "/base"]);
});

test("failed library synchronization retries automatically and disposal cancels retry", async t => {
  let attempts = 0;
  const { client } = createClient(t, { libraries: ["/base"],
    librarySync: () => { if (++attempts === 1) throw new Error("temporary transport failure"); },
  });
  await client.start();
  client.libraryPathsRetryDelay = 5;
  client.updateRuntimeLibraryPaths(["/new", "/base"]);
  await assert.rejects(client.libraryPathsSyncPromise, /temporary transport failure/);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(attempts, 2);
  assert.equal(client.syncedLibraryPaths.key, JSON.stringify(["/new", "/base"]));
  attempts = 0;
  client.updateRuntimeLibraryPaths(["/another", "/base"]);
  await assert.rejects(client.libraryPathsSyncPromise);
  assert.ok(client.libraryPathsRetry);
  await client.dispose();
  assert.equal(client.libraryPathsRetry._destroyed, true);
});

test("startup state is retained across replacement and cleared on disposal", async t => {
  const { client, instances, captures } = createClient(t);
  await client.start();
  const state = client.startupState;
  assert.ok(Buffer.isBuffer(state));
  await client.restartClient(instances[0], "test restart");
  assert.equal(client.startupState, state);
  assert.equal(captures(), 1, "replacement never recaptures startup state");
  await client.dispose();
  assert.equal(client.startupState, undefined);
  assert.ok(state.every(byte => byte === 0), "release the retained sensitive buffer");
});

test("launch discards inherited LSP transport settings while preserving user configuration", t => {
  const { client } = createClient(t);
  const inherited = {
    VSCR_LSP_HOST: "127.0.0.2", VSCR_LSP_PORT: "1234", VSCR_LSP_AUTH_TOKEN: "old-token",
    vscr_lsp_client_nonce: "old-nonce", VSCR_LSP_RESTORE_STARTUP: "TRUE",
    R_LIBS_USER: "/user/library", USER_SETTING: "preserved",
  };
  client.options.env = inherited;
  const env = client.buildServerEnv({ get: () => undefined });
  for (const name of ["VSCR_LSP_HOST", "VSCR_LSP_PORT", "VSCR_LSP_AUTH_TOKEN", "vscr_lsp_client_nonce"]) {
    assert.ok(!Object.hasOwn(env, name));
  }
  assert.equal(env.VSCR_LSP_RESTORE_STARTUP, "FALSE");
  assert.equal(env.R_LIBS_USER, inherited.R_LIBS_USER);
  assert.equal(env.USER_SETTING, "preserved");
  assert.equal(inherited.VSCR_LSP_AUTH_TOKEN, "old-token", "launch must not mutate the caller's environment");
});

test("runtime library snapshots are retained before completion client construction", async () => {
  const paths = [], calls = [];
  class ConsoleLspClient {
    updateRuntimeLibraryPaths(value) { paths.push([...value]); }
    resetRuntimeLibraryPaths() { calls.push("reset"); }
    async syncSessionState(value) { calls.push(value); }
    async start() { calls.push("start"); }
    updateInput() {}
    async dispose() {}
  }
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {}, "../../Language/completion": {},
    "../../Language/consoleLspClient": { ConsoleLspClient },
  });
  const lang = new RTermLang({ extensionPath: "", rPath: "R", env: {} });
  lang.updateLibraryPaths(["/active", "/base"]);
  await lang.getCompletionProvider();
  assert.deepEqual(paths, [["/active", "/base"]]);
  lang.updateLibraryPaths(["/base"]);
  assert.deepEqual(paths.at(-1), ["/base"]);
  lang.clearSessionState();
  assert.equal(calls.includes("reset"), true);
  await lang.dispose();
});

test('static provider cancellation reaches the LSP and rejects late results', async t => {
  let started, release, token;
  const waiting = new Promise(resolve => { started = resolve; });
  const { client } = createClient(t, { staticAnalysis: true, completion: async (_client, _params, currentToken) => {
    token = currentToken; started();
    return new Promise(resolve => { release = resolve; });
  } });
  const { requestStaticCompletion } = loadSource('src/Language/completion/staticProvider.ts');
  const { createGuardedBindingResolver } = loadSource('src/Language/completion/bindings.ts');
  const controller = new AbortController();
  const input = 'stats::lm(';
  const position = new Position(0, input.length);
  const pending = requestStaticCompletion(client, {
    document: { version: 1, getText: () => input }, input, cursor: input.length,
    position, contextPosition: position, requestScope: {},
    bindings: createGuardedBindingResolver(undefined, { signal: controller.signal }),
  });
  await waiting;
  assert.equal(token.isCancellationRequested, false);
  controller.abort();
  assert.equal(token.isCancellationRequested, true);
  const result = await pending;
  assert.equal(result.staticStatus, 'pending');
  assert.deepEqual(result.items, []);
  release({ items: [{ label: 'stale' }] });
});

test("a replacement that still requests restart fails refresh without declaring success", async t => {
  const { client, instances } = createClient(t, { packageChanges: () => ["stats"] });
  await client.start();
  await assert.rejects(client.refreshPackages(change()), /retained stale packages: stats/);
  assert.equal(instances.length, 2, "a failed verification must not spin through replacement processes");
  assert.ok(!instances[1].requests.some(request => request.method === "completion"));
});

test("package refresh sends pinned installations and explicit monitoring exclusions", async t => {
  const { client, instances } = createClient(t);
  await client.start();
  await client.refreshPackages({
    libraries: [],
    packages: new Map([["example", { name: "example", version: "1.0",
      path: "/configured-alias/example", target: "/pinned-library/example", identity: "installed" }]]),
    changed: [], unmonitored: ["linked"], unmonitoredRoots: ["/suspended-library"],
    isCurrent: () => true,
  });
  const request = instances[0].requests.find(request => request.method === "rConsole/refreshPackages");
  assert.deepEqual(request.params.installations, { example: "/pinned-library/example" });
  assert.deepEqual(request.params.unmonitored, ["linked"]);
  assert.deepEqual(request.params.unmonitoredRoots, ["/suspended-library"]);
});
