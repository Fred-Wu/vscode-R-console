const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

class Position {
  constructor(line, character) { Object.assign(this, { line, character }); }
}

function createClient(t, { reply, completion, packageChanges, start, stop, libraries = [] } = {}) {
  const instances = [];
  class LanguageClient {
    constructor() {
      this.running = false;
      this.requests = [];
      this.documents = [];
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
    async start() { await start?.(this); this.running = true; }
    async stop() { this.running = false; await stop?.(this); }
    async dispose() { this.running = false; }
    async sendNotification(method, params) {
      if (!this.running) throw new Error("Client is not running");
      if (method === "open" || method === "change") this.documents.push(params.text);
    }
    async sendRequest(method, params) {
      if (!this.running) throw new Error("Client is not running");
      this.requests.push({ method, params });
      if (method === "rConsole/syncSessionState") return await reply?.(this, params) ?? { libraryPaths: params.libraryPaths ?? libraries };
      if (method === "rConsole/libraryPaths") return libraries;
      if (method === "rConsole/refreshPackages") return { restart: await packageChanges?.(this) ?? [] };
      if (method === "rConsole/exportPackageMetadata") return { saved: ["utils"], skipped: [] };
      if (method === "rConsole/restorePackageMetadata") return { restored: ["utils"], skipped: [] };
      assert.equal(method, "completion");
      return await completion?.(this, params) ?? [{ label: "lm" }];
    }
  }
  const { ConsoleLspClient } = loadSource("src/Language/consoleLspClient.ts", {
    vscode: {
      Position, Range: class Range {},
      Uri: { parse: (value) => ({ toString: () => value }), file: () => ({}) },
      window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
      workspace: { getConfiguration: () => ({ get: (key) => key === "libPaths" ? libraries : undefined }) },
      CompletionTriggerKind: { Invoke: 1, TriggerCharacter: 2 },
    },
    "vscode-languageclient/node": {
      LanguageClient,
      CompletionRequest: { type: "completion" },
      DidOpenTextDocumentNotification: { type: "open" },
      DidChangeTextDocumentNotification: { type: "change" },
      DidCloseTextDocumentNotification: { type: "close" },
      RevealOutputChannelOn: { Never: 4 },
    },
  });
  const client = new ConsoleLspClient({
    consoleId: "lifecycle-test", extensionPath: path.resolve(__dirname, "../.."),
    rPath: "R", env: {},
  });
  client.packageInventory.setLibraryPaths = () => {};
  t.after(() => client.dispose());
  return { client, instances };
}

function change() {
  return { libraries: [{ path: "/base/library", packages: new Map() }],
    packages: new Map(), changed: ["stats"], isCurrent: () => true };
}

test("first session snapshot keeps a server whose effective library paths already match", async (t) => {
  const { client, instances } = createClient(t);
  await client.start();
  await client.syncSessionState({ attachedPackages: ["stats"], libraryPaths: ["/base/library"] });
  assert.equal(instances.length, 1, "matching paths must not restart a healthy server");
});

test("session path checks include configured fallback libraries", async (t) => {
  const { client, instances } = createClient(t, { libraries: ["/configured"] });
  await client.syncSessionState({ attachedPackages: ["stats"], libraryPaths: ["/session"] });
  const request = instances[0].requests.find(({ method }) => method === "rConsole/syncSessionState");
  assert.deepEqual(request.params.libraryPaths, ["/session", "/configured"]);
});

test("a confirmed loaded-package change restarts once and applies the latest session state", async (t) => {
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  t.after(releaseStart);
  const { client, instances } = createClient(t, {
    packageChanges: (server) => server === instances[0] ? ["stats"] : [],
    start: async (server) => { if (server === instances[1]) await startGate; },
  });
  await client.start();
  await client.syncSessionState({ attachedPackages: ["stats"], libraryPaths: ["/first"] });
  const first = client.refreshPackages(change());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instances.length, 2);
  const concurrentStart = client.start();
  const latest = client.syncSessionState({ attachedPackages: ["utils"], libraryPaths: ["/latest"] });
  releaseStart();
  await Promise.all([first, concurrentStart, latest]);
  assert.equal(instances.length, 2, "concurrent callers share one restart");
  assert.deepEqual(instances[1].requests.filter(request => request.method === "rConsole/syncSessionState").at(-1).params, {
    attachedPackages: ["utils"], libraryPaths: ["/latest"],
  });
  assert.ok(instances[0].requests.some(request => request.method === "rConsole/exportPackageMetadata"));
  const restored = instances[1].requests.findIndex(request => request.method === "rConsole/restorePackageMetadata");
  assert.ok(restored > instances[1].requests.findIndex(request => request.method === "rConsole/refreshPackages"));
  assert.ok(restored < instances[1].requests.findIndex(request => request.method === "completion"));
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

test("package replacement and a simultaneous library update share one restart", async (t) => {
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
  const state = { attachedPackages: ["stats"], libraryPaths: ["/project"] };
  const sync = client.syncSessionState(state);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instances.length, 1, "do not launch a server while its predecessor is stopping");
  releaseStop();
  const [result] = await Promise.all([request, sync, refresh]);
  assert.deepEqual(result, [{ label: "lm" }]);
  assert.equal(instances.length, 2);
  assert.deepEqual(instances[1].requests.find(({ method }) => method === "rConsole/syncSessionState").params, state);
});

test("an obsolete library update does not restart a server that matches the latest state", async (t) => {
  let releaseReply;
  let enteredRequest;
  const replyGate = new Promise((resolve) => { releaseReply = resolve; });
  const requested = new Promise((resolve) => { enteredRequest = resolve; });
  t.after(() => releaseReply({ libraryPaths: ["/obsolete"] }));
  let requests = 0;
  const { client, instances } = createClient(t, {
    reply: async () => { if (++requests === 1) { enteredRequest(); return replyGate; } return { libraryPaths: ["/current"] }; },
  });
  const first = client.syncSessionState({ attachedPackages: ["stats"], libraryPaths: ["/obsolete"] });
  await requested;
  const latest = client.syncSessionState({ attachedPackages: ["stats"], libraryPaths: ["/current"] });
  releaseReply({ libraryPaths: ["/obsolete"] });
  await Promise.all([first, latest]);
  assert.equal(instances.length, 1);
  assert.equal(requests, 2, "check the latest state before deciding to restart");
});

test("cached session state reaches the LSP before its first launch", async () => {
  const calls = [];
  class ConsoleLspClient {
    async start() { calls.push("start"); }
    async syncSessionState(state) { calls.push(state); }
    async dispose() {}
  }
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {}, "../../Language/completion": {},
    "../../Language/consoleLspClient": { ConsoleLspClient },
  });
  const lang = new RTermLang({ extensionPath: "", rPath: "R", env: {}, requestMemberCompletions: async () => [] });
  lang.updateSessionData({ search: ["package:stats"], globalenv: {}, libraryPaths: ["/project"], loaded_namespaces: [] });
  await lang.ensureConsoleLspStarted();
  assert.deepEqual(calls, [{ attachedPackages: ["stats"], libraryPaths: ["/project"] }]);
  await lang.dispose();
});
