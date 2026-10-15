const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { buildSync } = require("esbuild");
const loadSource = require("../helpers/load-source.cjs");

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for history worker");
    await delay(5);
  }
}

function fixture(t, banner = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-worker-"));
  const workerPath = path.join(dir, "historyWorker.js");
  buildSync({
    entryPoints: [path.resolve(__dirname, "../../src/Terminal/historyWorker.ts")],
    bundle: true, platform: "node", format: "cjs", outfile: workerPath,
    banner: { js: banner },
  });
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const workers = [];
  const messages = [];
  const api = loadSource("src/Terminal/history.ts", {
    fs: new Proxy({}, { get: () => () => assert.fail("History used filesystem on the console thread") }),
    worker_threads: {
      Worker: class extends Worker {
        constructor(file, options) {
          super(file, { ...options, workerData: { ...options?.workerData, gate: gate.buffer } });
          workers.push(this);
          this.on("message", (message) => messages.push(message));
        }
      },
    },
  });
  const release = () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); };
  t.after(async () => {
    release();
    await api.disposeHistoryWorker();
    await Promise.all(workers.map((worker) => worker.terminate()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, gate, messages, workers, release, ...api,
    create: (location = path.join(dir, "history")) => new api.HistoryManager(location, workerPath),
  };
}

test("console input and submission continue while history reads, compacts, and writes are stalled", async (t) => {
  const f = fixture(t, `
    const testFs = require("node:fs");
    const testThreads = require("node:worker_threads");
    const testGate = new Int32Array(testThreads.workerData.gate);
    for (const operation of ["readSync", "renameSync", "appendFileSync"]) {
      const original = testFs[operation];
      let first = true;
      testFs[operation] = (...args) => {
        if (first) {
          first = false;
          Atomics.store(testGate, 0, 0);
          testThreads.parentPort.postMessage({ blocked: operation });
          Atomics.wait(testGate, 0, 0);
        }
        return original(...args);
      };
    }
  `);
  fs.writeFileSync(path.join(f.dir, "history"), Array.from({ length: 20000 }, (_, i) =>
    "\n# time: original\n+command-" + i + "\n").join(""));
  const history = f.create();
  history.load();
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    vscode: { EventEmitter: class {}, window: { createOutputChannel: () => ({}) } },
    "./rTerminal/lang": {},
  });
  const { InputState } = loadSource("src/Terminal/inputState.ts");
  const sent = [];
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    mode: "ready", promptReady: true, promptVisible: false, rHistory: history,
    inputState: new InputState(), lang: { updateInput() {} },
    ensureReadyPromptVisibleForInput() {}, renderInput() {},
  });
  const host = {
    mode: "ready", promptReady: false, activeSubmission: null, submissionQueue: [],
    inputState: terminal.inputState, promptKind: "main", clearPromptRenderTimer() {},
    lang: { refreshCompletionContextDocument() {} },
    runtimeBackend: { sendSessionCommand(_session, command) { sent.push(command.code); return true; } },
  };
  terminal.runtimeHost = () => host;
  for (const operation of ["readSync", "renameSync", "appendFileSync"]) {
    await waitFor(() => f.messages.some((message) => message.blocked === operation));
    host.mode = "ready";
    host.activeSubmission = null;
    const code = `print("${operation}")`;
    terminal.applyKeyAction({ type: "text", text: code });
    assert.equal(terminal.inputState.text, code);
    await terminal.handleEnterKey();
    assert.equal(sent.at(-1), code, "submission must reach the runtime before releasing storage");
    assert.ok(history.getEntries().includes(code));
    await delay(10);
    assert.equal(Atomics.load(f.gate, 0), 0, "storage is still stalled while the event loop runs");
    f.release();
  }
  await waitFor(() => !history.sent && !history.pending.length);
  assert.equal(f.workers.length, 1);
  const { HistoryStore } = loadSource("src/Terminal/historyStore.ts");
  const stored = new HistoryStore(path.join(f.dir, "history"));
  stored.load();
  for (const code of sent) assert.equal(stored.getEntries().filter((entry) => entry === code).length, 1);
});

test("one history worker shares a scope and keeps other scopes separate", async (t) => {
  const f = fixture(t);
  const location = { storageFolder: f.dir, scope: "workspace", workspaceFolder: f.dir };
  const first = f.create(location);
  const second = f.create(location);
  const other = f.create({ storageFolder: f.dir, scope: "global" });
  first.load(); second.load(); other.load();
  first.push("first()"); second.push("second()");
  await waitFor(() => first.getEntries().length === 2 && second.getEntries().length === 2);
  assert.equal(f.workers.length, 1);
  assert.deepEqual(other.getEntries(), []);
  assert.deepEqual(new Set(first.getEntries()), new Set(["first()", "second()"]));
  assert.deepEqual(first.getRecentSessionEntries(), ["first()"]);
});

test("F8 retains stable occurrence IDs across local history evictions", (t) => {
  const f = fixture(t);
  const history = f.create();
  // This test isolates the foreground cache; no worker replies are required.
  history.disableStorage();
  history.setSearchNoDuplicates(true);
  // Simulate a full foreground cache to test cumulative front evictions.
  history.historyBuffer = Array.from({ length: 20000 }, (_, i) => `command-${i}`);
  history.historyIndex = history.historyBuffer.length;
  history.historyIds = Array.from({ length: 20000 }, (_, i) => `occurrence-${i}`);
  history.historyBuffer[5999] = "OLDER_TAG";
  history.historyBuffer[0] = "EVICTED_TAG";

  const [latest] = history.getPickerEntries("command-19999", false);
  const [older] = history.getPickerEntries("OLDER_TAG", false);
  const [evicted] = history.getPickerEntries("EVICTED_TAG", false);
  assert.deepEqual(older, { code: "OLDER_TAG", historyIndex: 5999, id: "occurrence-5999" });

  history.push("new-a");
  history.push("new-b");
  assert.equal(history.selectPickerEntry(latest), true);
  assert.equal(history.navigate(-1), "command-19998");

  assert.equal(history.selectPickerEntry(older), true);
  assert.equal(history.navigate(-1), "command-5998");
  assert.equal(history.selectPickerEntry(evicted), false);
  history.resetIndex();

  // Newly generated results use the same stable coordinate system.
  const [updated] = history.getPickerEntries("new-b", false);
  assert.equal(updated.code, "new-b");
  assert.ok(updated.historyIndex >= 0);
  assert.ok(updated.id);
  history.push("new-c");
  assert.equal(history.selectPickerEntry(updated), true);
  assert.equal(history.navigate(-1), "new-a");

  // A duplicate at an older occurrence retains its exact position.
  history.historyBuffer = Array.from({ length: 20000 }, (_, i) =>
    i === 2 || i === 15000 ? "repeat()" : `command-${i}`);
  history.historyIds = Array.from({ length: 20000 }, (_, i) => `duplicate-occurrence-${i}`);
  const duplicates = history.getPickerEntries("repeat()", false);
  assert.deepEqual(duplicates.map((item) => item.historyIndex), [15000, 2]);
  history.push("new-d");
  assert.equal(history.selectPickerEntry(duplicates[1]), true);
  assert.equal(history.navigate(0), "repeat()");
});

test("two consoles preserve exact F8 occurrence across shared-file reconciliation", async (t) => {
  const f = fixture(t);
  const a = f.create();
  const b = f.create();
  a.load(); b.load();
  a.push("repeat()");
  await waitFor(() => a.unconfirmed.length === 0);
  b.save();
  await waitFor(() => b.getEntries().length === 1);
  const resume = a.suspendUpdates();
  a.push("repeat()");
  const [selected] = a.getPickerEntries("repeat()", false);
  assert.equal(selected.historyIndex, 1);
  await waitFor(() => a.unconfirmed.length === 0);
  b.push("remote()");
  await waitFor(() => b.unconfirmed.length === 0);
  a.save();
  await waitFor(() => a.stored.includes("remote()"));
  assert.deepEqual(a.getEntries(), ["repeat()", "repeat()"]);
  assert.equal(a.selectPickerEntry(selected), true);
  resume();
  assert.deepEqual(a.getEntries(), ["repeat()", "repeat()", "remote()"]);
  assert.equal(a.navigate(-1), "repeat()");
  assert.equal(a.navigate(1), "repeat()");
  assert.equal(a.navigate(1), "remote()");
  b.save();
  await waitFor(() => b.getEntries().length === 3);
  assert.deepEqual(b.getEntries(), a.getEntries());
});

test("legacy duplicate records retain distinct IDs after compaction and reload", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  fs.writeFileSync(file, Array.from({ length: 20001 }, (_, i) =>
    "\\n# time: original\\n+" + (i === 1001 || i === 15001 ? "repeat()" : "item-" + i) + "\\n").join("")
    .replaceAll("\\n", "\n"));
  const history = f.create();
  history.load();
  await waitFor(() => history.getEntries().length === 200);
  const duplicates = (await history.getPage("repeat()", false)).entries;
  assert.equal(duplicates.length, 2);
  assert.ok(duplicates[0].id);
  assert.notEqual(duplicates[0].id, duplicates[1].id);
  assert.equal(await history.selectPickerEntryOnDemand(duplicates[1]), true);
  assert.equal(history.navigate(0), "repeat()");
});

test("background compaction preserves the selected duplicate while F8 defers updates", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "history"), Array.from({ length: 20000 }, (_, i) =>
    "\n# time: original\n+" + (i === 5001 || i === 15001 ? "repeat()" : "command-" + i) + "\n").join(""));
  const browsing = f.create();
  const writer = f.create();
  browsing.load(); writer.load();
  await waitFor(() => browsing.getEntries().length === 200 && writer.getEntries().length === 200);
  const resume = browsing.suspendUpdates();
  const snapshot = browsing.getEntries();
  writer.push("latest()");
  await waitFor(() => writer.stored.length === 200 && writer.storedStart > 19000);
  browsing.save();
  await waitFor(() => browsing.deferredHistory?.updated);
  assert.deepEqual(browsing.getEntries(), snapshot);
  const older = (await browsing.getPage("repeat()", false)).entries.at(-1);
  assert.ok(older);
  assert.equal(await browsing.selectPickerEntryOnDemand(older), true);
  resume();
  await waitFor(() => {
    browsing.save();
    return browsing.storedStart > 19000;
  });
  assert.equal(browsing.navigate(-1), "command-5000");
  assert.equal(browsing.navigate(1), "repeat()");
  assert.equal(browsing.navigate(1), "command-5002");
});

test("F8 keeps the foreground cache stable and replays deferred deltas and acknowledgements", async (t) => {
  const f = fixture(t);
  const history = f.create();
  const initial = { id: history.id, start: 0, reset: true, remove: 0, entries: ["original()"] };
  history.receive(initial);
  const resume = history.suspendUpdates();
  history.selectEntryAt(0);
  history.push("local()");
  const [pending] = history.pending;
  // Simulate successive worker deltas and durable acknowledgements received
  // while the picker is open and foreground worker updates are deferred.
  history.receive({ id: history.id, start: 0, reset: false, remove: 0,
    entries: ["first()"], persisted: [] });
  history.receive({ id: history.id, start: 0, reset: false, remove: 0,
    entries: ["second()"], persisted: [pending.id] });
  assert.deepEqual(history.getEntries(), ["original()", "local()"]);
  assert.equal(history.unconfirmed.length, 0, "acknowledgements are processed during F8");
  resume();
  assert.deepEqual(history.getEntries(), ["original()", "first()", "second()", "local()"]);
  assert.deepEqual(history.unconfirmed, []);
  assert.equal(history.deferredHistory, undefined);
});

test("F8 does not block sequential history writes while the picker is open", async (t) => {
  const f = fixture(t);
  const history = f.create();
  history.load();
  await waitFor(() => history.sent === undefined && history.stored.length === 0);
  const resume = history.suspendUpdates();
  history.push("first()");
  await waitFor(() => history.unconfirmed.length === 0);
  assert.deepEqual(history.getEntries(), ["first()"]);
  history.push("second()");
  await waitFor(() => history.unconfirmed.length === 0);
  // Both requests have reached storage even though F8 still defers UI updates.
  const { HistoryStore } = loadSource("src/Terminal/historyStore.ts");
  const persisted = new HistoryStore(path.join(f.dir, "history"));
  persisted.load();
  assert.deepEqual(persisted.getEntries(), ["first()", "second()"]);
  assert.deepEqual(history.getEntries(), ["first()", "second()"]);
  resume();
  assert.deepEqual(history.getEntries(), ["first()", "second()"]);
});

test("closing a console drains queued writes after a contended lock is released", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  const lock = file + ".lock";
  fs.writeFileSync(lock, String(process.pid));
  const history = f.create();
  history.load();
  history.push("retained-on-close()");
  history.dispose();
  await waitFor(() => f.messages.some((message) => message.id !== undefined));
  fs.unlinkSync(lock);
  await f.disposeHistoryWorker();
  const { HistoryStore } = loadSource("src/Terminal/historyStore.ts");
  const restored = new HistoryStore(file);
  restored.load();
  assert.deepEqual(restored.getEntries(), ["retained-on-close()"]);
});

test("worker restart replays unacknowledged commands without duplicates", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  const history = f.create();
  history.load();
  history.push("before()");
  await waitFor(() => f.workers.length === 1);
  await waitFor(() => history.unconfirmed.length === 0);
  const lock = file + ".lock";
  fs.writeFileSync(lock, String(process.pid));
  history.push("during-lock()");
  await waitFor(() => history.sent === undefined);
  await f.workers[0].terminate();
  await waitFor(() => f.workers.length === 2);
  fs.unlinkSync(lock);
  await waitFor(() => history.unconfirmed.length === 0);
  const { HistoryStore } = loadSource("src/Terminal/historyStore.ts");
  const restored = new HistoryStore(file);
  restored.load();
  assert.deepEqual(restored.getEntries(), ["before()", "during-lock()"]);
  history.push("after()");
  await waitFor(() => history.unconfirmed.length === 0);
  restored.load();
  assert.deepEqual(restored.getEntries(), ["before()", "during-lock()", "after()"]);
});

test("dead worker's lock token can be reclaimed by its replacement", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  const history = f.create();
  history.load();
  await waitFor(() => f.workers.length === 1);
  // Observe the worker's lock identity by blocking its first append.
  const token = String(process.pid) + ":orphan-worker-token";
  const lock = file + ".lock";
  fs.writeFileSync(lock, token);
  // The token belongs to a previously crashed worker, not the live worker.
  // Here test the store directly using its explicit dead-worker ownership list.
  const { HistoryStore } = loadSource("src/Terminal/historyStore.ts", {
    worker_threads: { workerData: {
      historyOwner: "replacement-worker-token",
      orphanOwners: [token],
    } },
  });
  const store = new HistoryStore(file);
  store.load();
  store.push("recovered()");
  assert.deepEqual(store.getEntries(), ["recovered()"]);
  assert.equal(fs.existsSync(lock), false);
});

test("worker failure retains history and resumes persistence", async (t) => {
  const f = fixture(t);
  const history = f.create();
  history.load();
  history.push("before()");
  await waitFor(() => history.unconfirmed.length === 0);
  await f.workers[0].terminate();
  history.push("during-restart()");
  await waitFor(() => f.workers.length === 2);
  await waitFor(() => history.unconfirmed.length === 0);
  history.resetIndex();
  assert.equal(history.navigate(-1), "during-restart()");
  assert.equal(history.navigate(-1), "before()");
  const { HistoryStore } = loadSource("src/Terminal/historyStore.ts");
  const store = new HistoryStore(path.join(f.dir, "history"));
  store.load();
  assert.deepEqual(store.getEntries(), ["before()", "during-restart()"]);
});

test("delete one occurrence immediately updates picker and persisted history", async (t) => {
  const f = fixture(t);
  const history = f.create();
  history.load();
  for (const code of ["repeat()", "other()", "repeat()"]) history.push(code);
  await waitFor(() => history.unconfirmed.length === 0);
  const resume = history.suspendUpdates();
  const entries = history.getPickerEntries("repeat()", false);
  assert.equal(entries.length, 2);
  await history.deleteEntries([entries[0]], false);
  assert.deepEqual(history.getPickerEntries("repeat()", false).map((item) => item.code), ["repeat()"]);
  assert.deepEqual(history.getEntries(), ["repeat()", "other()"]);
  resume();
  const { HistoryStore } = loadSource("src/Terminal/historyStore.ts");
  const stored = new HistoryStore(path.join(f.dir, "history"));
  stored.load();
  assert.deepEqual(stored.getEntries(), ["repeat()", "other()"]);
});

test("collapsed duplicate and bulk deletion remove all matching occurrences", async (t) => {
  const f = fixture(t);
  const history = f.create();
  history.load();
  for (const code of ["repeat()", "other()", "repeat()", "third()", "other()"]) history.push(code);
  await waitFor(() => history.unconfirmed.length === 0);
  const resume = history.suspendUpdates();
  await history.deleteEntries(history.getPickerEntries("repeat()", true), true);
  assert.deepEqual(history.getEntries(), ["other()", "third()", "other()"]);
  await history.deleteEntries(history.getPickerEntries("other()", false), false);
  assert.deepEqual(history.getEntries(), ["third()"]);
  resume();
});

test("delete all clears worker storage, picker and navigation without clearing other scopes", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  const current = f.create(file);
  const independent = f.create(path.join(f.dir, "independent"));
  current.load(); independent.load();
  current.push("old()"); independent.push("keep()");
  await waitFor(() => current.unconfirmed.length === 0 && independent.unconfirmed.length === 0);
  await current.clearHistory();
  assert.deepEqual(current.getEntries(), []);
  assert.deepEqual(current.getPickerEntries("", false), []);
  current.resetIndex();
  assert.equal(current.navigate(-1), undefined);
  assert.deepEqual(independent.getEntries(), ["keep()"]);
  const { HistoryStore } = loadSource("src/Terminal/historyStore.ts");
  const restored = new HistoryStore(file);
  restored.load();
  assert.deepEqual(restored.getEntries(), []);
});

test("history deletion retries a contended file lock without reporting premature success", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  const history = f.create(file);
  history.load();
  history.push("keep()");
  await waitFor(() => history.unconfirmed.length === 0);
  const lock = file + ".lock";
  fs.writeFileSync(lock, String(process.pid));
  let completed = false;
  const deleting = history.clearHistory().then(() => { completed = true; });
  try {
    await delay(50);
    assert.equal(completed, false, "deletion must wait for the contended file lock");
    assert.deepEqual(history.getEntries(), ["keep()"]);
  } finally {
    fs.unlinkSync(lock);
  }
  await deleting;
  assert.deepEqual(history.getEntries(), []);
});

test("F8 starts without the search-bar checkbox and refreshes after deletion", async (t) => {
  const f = fixture(t);
  const history = f.create();
  history.load();
  history.push("remove()");
  history.push("retain()");
  await waitFor(() => history.unconfirmed.length === 0);
  const handlers = {};
  const picker = {
    value: "remove", items: [], activeItems: [], selectedItems: [],
    onDidChangeValue(callback) { handlers.value = callback; },
    onDidTriggerButton(callback) { handlers.button = callback; },
    onDidChangeSelection(callback) { handlers.selection = callback; },
    onDidAccept(callback) { handlers.accept = callback; },
    onDidHide(callback) { handlers.hide = callback; },
    show() {}, hide() { handlers.hide(); }, dispose() {},
  };
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    vscode: {
      EventEmitter: class {},
      ThemeIcon: class { constructor(id) { this.id = id; } },
      ThemeColor: class { constructor(id) { this.id = id; } },
      window: { createQuickPick: () => picker, createOutputChannel: () => ({}) },
    },
    "./rTerminal/lang": {},
  });
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    mode: "ready", promptReady: true, rHistory: history,
    historyStorage: { state: { get: () => false, update: async () => {} } },
  });
  const opened = terminal.showHistoryPicker();
  await waitFor(() => picker.items.some((item) => item.code === "remove()"));
  assert.equal(picker.canSelectMany, true);
  assert.deepEqual(picker.items.map((item) => item.code), ["remove()"]);
  const initialQuery = picker.value;
  const item = picker.items[0];
  picker.selectedItems = [item];
  await handlers.button(picker.buttons.at(-1));
  await waitFor(() => picker.items.length === 0);
  assert.equal(picker.value, initialQuery);
  assert.deepEqual(history.getEntries(), ["retain()"]);
  handlers.hide();
  await opened;
});

test("F8 check buttons support selecting multiple commands without changing Enter behaviour", async (t) => {
  const f = fixture(t);
  const history = f.create();
  history.load();
  for (const entry of ["first()", "second()", "third()"]) history.push(entry);
  await waitFor(() => history.unconfirmed.length === 0);
  const handlers = {};
  const picker = {
    value: "", items: [], activeItems: [], selectedItems: [],
    onDidChangeValue(cb) { handlers.value = cb; },
    onDidTriggerButton(cb) { handlers.button = cb; },
    onDidChangeSelection(cb) { handlers.selection = cb; },
    onDidAccept(cb) { handlers.accept = cb; },
    onDidHide(cb) { handlers.hide = cb; },
    show() {}, hide() { handlers.hide(); }, dispose() {},
  };
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    vscode: {
      EventEmitter: class {},
      ThemeIcon: class { constructor(id) { this.id = id; } },
      ThemeColor: class { constructor(id) { this.id = id; } },
      window: { createQuickPick: () => picker, createOutputChannel: () => ({}) },
    },
    "./rTerminal/lang": {},
  });
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    mode: "ready", promptReady: true, rHistory: history,
    historyStorage: { state: { get: () => false, update: async () => {} } },
  });
  const opened = terminal.showHistoryPicker();
  await waitFor(() => picker.items.filter((item) => item.code).length === 3);
  assert.equal(picker.canSelectMany, true);
  picker.selectedItems = picker.items.filter((item) => ["first()", "third()"].includes(item.code));
  await handlers.button(picker.buttons.at(-1));
  assert.deepEqual(picker.items.filter((item) => item.code).map((item) => item.code), ["second()"]);
  assert.deepEqual(history.getEntries(), ["second()"]);
  handlers.hide();
  await opened;
});

test("on-demand picker pages filter without loading the full history into the console", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  fs.writeFileSync(file, Array.from({ length: 1000 }, (_, i) =>
    "\\n# time: old\\n+command-" + i + "\\n").join("").replaceAll("\\n", "\n"));
  const history = f.create(file);
  history.load();
  await waitFor(() => history.getEntries().length === 200);
  assert.equal(history.getEntries()[0], "command-800");
  const first = await history.getPage("command-", false, 0, 50);
  const second = await history.getPage("command-", false, 50, 50);
  assert.equal(first.entries.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(second.entries[0].code, "command-949");
  assert.equal(first.entries.at(-1).code, "command-950");
  assert.equal((await history.getPage("command-25", false)).entries.at(-1).code, "command-25");
  assert.equal(history.getEntries().length, 200);
});

test("Up and Down load older history incrementally without replacing the entire cache", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  fs.writeFileSync(file, Array.from({ length: 650 }, (_, i) =>
    "\\n# time: old\\n+command-" + i + "\\n").join("").replaceAll("\\n", "\n"));
  const history = f.create(file);
  history.load();
  await waitFor(() => history.getEntries().length === 200);
  history.selectEntryAt(0);
  assert.equal(history.navigate(-1), undefined);
  assert.equal(await history.loadOlderNavigation(), true);
  assert.equal(history.navigate(-1), "command-449");
  assert.equal(history.getEntries().length, 400);
  history.selectEntryAt(history.getEntries().length - 1);
  assert.equal(history.navigate(1), undefined);
  assert.equal(await history.loadNewerNavigation(), true);
  assert.equal(history.navigate(1), null);
  history.resetIndex();
  assert.equal(history.navigate(-1), "command-649");
});


test("a stale pending write in another store cannot resurrect deleted history", (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  const { HistoryStore } = loadSource("src/Terminal/historyStore.ts");
  const first = new HistoryStore(file);
  const second = new HistoryStore(file);
  first.load(); second.load();
  first.push("old()");
  const before = performance.timeOrigin + performance.now();
  const staleId = require("node:crypto").randomUUID();
  const freshId = require("node:crypto").randomUUID();
  first.deleteEntries({ all: true, before });
  second.pushEntries([{ id: staleId, code: "old()", createdAt: before - 1 }]);
  assert.deepEqual(second.getEntries(), []);
  second.pushEntries([{ id: freshId, code: "old()", createdAt: before + 1 }]);
  const restored = new HistoryStore(file);
  restored.load();
  assert.deepEqual(restored.getEntries(), ["old()"]);
  assert.deepEqual(restored.getPersistedIds([staleId, freshId]),
    [freshId], "only a new submission should be stored on disk");
});

test("failed deletion keeps pending commands for a later successful append", (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  const { HistoryStore } = loadSource("src/Terminal/historyStore.ts");
  const store = new HistoryStore(file);
  store.load();
  const lock = file + ".lock";
  fs.writeFileSync(lock, String(process.pid));
  try {
    store.push("queued()");
    assert.deepEqual(store.getEntries(), ["queued()"]);
    assert.throws(() => store.deleteEntries({ all: true }), /pending|busy/i);
    assert.equal(store.hasPendingWrites, true);
  } finally {
    fs.unlinkSync(lock);
  }
  store.save();
  const restored = new HistoryStore(file);
  restored.load();
  assert.deepEqual(restored.getEntries(), ["queued()"]);
});

test("deleting one duplicate retains unrelated identical session completion entries", async (t) => {
  const f = fixture(t);
  const history = f.create();
  history.load();
  history.push("same()");
  history.push("same()");
  await waitFor(() => history.unconfirmed.length === 0);
  const occurrence = history.getPickerEntries("same()", false)[0];
  await history.deleteEntries([occurrence], false);
  assert.deepEqual(history.getRecentSessionEntries(), ["same()"]);
  assert.deepEqual(history.getEntries(), ["same()"]);
});

test("collapsed duplicate deletion includes matches outside the loaded foreground window", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  fs.writeFileSync(file, Array.from({ length: 600 }, (_, i) =>
    "\n# time: old\n+" + (i === 2 || i === 500 ? "duplicate()" : "item-" + i) + "\n").join(""));
  const history = f.create(file);
  history.load();
  await waitFor(() => history.getEntries().length === 200);
  const group = (await history.getPage("duplicate()", true)).entries;
  assert.equal(group.length, 1);
  await history.deleteEntries(group, true);
  assert.deepEqual((await history.getPage("duplicate()", false)).entries, []);
  const { HistoryStore } = loadSource("src/Terminal/historyStore.ts");
  const reopened = new HistoryStore(file);
  reopened.load();
  assert.equal(reopened.getEntries().filter((code) => code === "duplicate()").length, 0);
});

test("F8 Enter restores the highlighted command rather than deleting it", async (t) => {
  const f = fixture(t);
  const history = f.create();
  history.load();
  history.push("restore()");
  await waitFor(() => history.unconfirmed.length === 0);
  const handlers = {};
  const picker = {
    value: "", items: [], activeItems: [], selectedItems: [],
    onDidChangeValue(cb) { handlers.value = cb; },
    onDidTriggerButton(cb) { handlers.button = cb; },
    onDidChangeSelection(cb) { handlers.selection = cb; },
    onDidAccept(cb) { handlers.accept = cb; },
    onDidHide(cb) { handlers.hide = cb; },
    show() {}, hide() { handlers.hide(); }, dispose() {},
  };
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    vscode: {
      EventEmitter: class {},
      ThemeIcon: class { constructor(id) { this.id = id; } },
      ThemeColor: class { constructor(id) { this.id = id; } },
      window: { createQuickPick: () => picker, createOutputChannel: () => ({}) },
    }, "./rTerminal/lang": {},
  });
  const restored = [];
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    mode: "ready", promptReady: true, rHistory: history,
    historyStorage: { state: { get: () => false, update: async () => {} } },
    applyHistorySearchResult: (code) => restored.push(code),
  });
  const opened = terminal.showHistoryPicker();
  await waitFor(() => picker.items.length > 0);
  assert.equal(picker.canSelectMany, true);
  assert.equal(picker.items[0].label, "restore()");
  assert.equal(picker.items[0].buttons, undefined);
  picker.activeItems = [picker.items[0]];
  handlers.accept();
  await opened;
  assert.deepEqual(restored, ["restore()"]);
  assert.deepEqual(history.getEntries(), ["restore()"]);
});


test("collapsed deletion does not retain removed plaintext in history metadata", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  const history = f.create(file);
  history.load();
  const secret = "sensitive_command_with_secret_token()";
  history.push(secret);
  history.push(secret);
  history.push("retained()");
  await waitFor(() => history.unconfirmed.length === 0);
  const collapsed = history.getPickerEntries(secret, true);
  await history.deleteEntries(collapsed, true);
  const onDisk = fs.readFileSync(file, "utf8");
  assert.ok(!onDisk.includes(secret), "deleted command text must not survive in tombstones");
  assert.match(onDisk, /# r-console-deletion:/);
  assert.ok(onDisk.includes("retained()"));
});

test("remote deletion refresh removes matching local history caches", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  const a = f.create(file);
  const b = f.create(file);
  a.load(); b.load();
  a.push("from-A()");
  b.push("from-B()");
  await waitFor(() => a.unconfirmed.length === 0 && b.unconfirmed.length === 0);
  await a.clearHistory();
  b.save();
  await waitFor(() => b.getEntries().length === 0);
  assert.deepEqual(b.getRecentSessionEntries(), []);
  assert.deepEqual(b.getPickerEntries("", false), []);
});


test("Up and Down preserve the unfinished input and cursor while browsing history", async (t) => {
  const f = fixture(t);
  const history = f.create();
  history.load();
  history.push("stored()");
  await waitFor(() => history.unconfirmed.length === 0);
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    vscode: { EventEmitter: class {}, window: { createOutputChannel: () => ({}) } },
    "./rTerminal/lang": {},
  });
  const { InputState } = loadSource("src/Terminal/inputState.ts");
  const inputState = new InputState();
  inputState.insertText("draft command");
  inputState.cursorPosition = 5;
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    mode: "ready", promptReady: true, promptVisible: true,
    rHistory: history, inputState, historyBrowsing: false, historyCollapsed: true,
    lang: { updateInput() {} }, clearInputRender() {}, renderInput() {},
  });
  terminal.navigateHistory(-1);
  assert.equal(inputState.text, "stored()");
  terminal.navigateHistory(1);
  assert.equal(inputState.text, "draft command");
  assert.equal(inputState.cursorPosition, 5);
});


test("worker restart replays an in-flight deletion and settles its request", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  const history = f.create(file);
  history.load();
  history.push("delete-across-restart()");
  await waitFor(() => history.unconfirmed.length === 0);
  const request = history.clearHistory();
  await f.workers[0].terminate();
  await request;
  assert.deepEqual(history.getEntries(), []);
  const { HistoryStore } = loadSource("src/Terminal/historyStore.ts");
  const restored = new HistoryStore(file);
  restored.load();
  assert.deepEqual(restored.getEntries(), []);
});

test("irrecoverable deletion rewrite error rejects without corrupting saved history", async (t) => {
  const f = fixture(t,
    "const testFs = require('node:fs');" +
    "const testRename = testFs.renameSync;" +
    "let fail = true;" +
    "testFs.renameSync = (...args) => {" +
    " if (fail) { fail = false; throw new Error('simulated inaccessible destination'); }" +
    " return testRename(...args); };"
  );
  const history = f.create();
  history.load();
  history.push("retained()");
  await waitFor(() => history.unconfirmed.length === 0);
  await assert.rejects(history.clearHistory(), /inaccessible destination/);
  assert.deepEqual(history.getEntries(), ["retained()"]);
  await history.clearHistory();
  assert.deepEqual(history.getEntries(), []);
});


test("Ctrl+R searches older pages and repeated presses advance to older matches", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  fs.writeFileSync(file, Array.from({ length: 650 }, (_, i) =>
    "\n# time: old\n+" + (i === 10 ? "needle-earlier()" :
      i === 550 ? "needle-recent()" : "other-" + i) + "\n").join(""));
  const history = f.create(file);
  history.load();
  await waitFor(() => history.getEntries().length === 200);
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    vscode: { EventEmitter: class {}, window: { createOutputChannel: () => ({}) } },
    "./rTerminal/lang": {},
  });
  const { InputState } = loadSource("src/Terminal/inputState.ts");
  const inputState = new InputState();
  inputState.insertText("needle");
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    mode: "ready", promptReady: true, promptVisible: true,
    rHistory: history, inputState, historyBrowsing: false, historyCollapsed: true,
    lastSearchTerm: "", lang: { updateInput() {} },
    ensureReadyPromptVisibleForInput() {}, clearInputRender() {}, renderInput() {},
  });
  terminal.reverseSearch();
  await terminal.reverseSearchQueue;
  assert.equal(inputState.text, "needle-recent()");
  terminal.reverseSearch();
  await terminal.reverseSearchQueue;
  assert.equal(inputState.text, "needle-earlier()");
});

test("native Select All only deletes loaded picker entries; Load More is toolbar-only", async (t) => {
  const f = fixture(t);
  const history = f.create();
  history.load();
  for (let i = 0; i < 80; i++) history.push("command-" + i);
  await waitFor(() => history.unconfirmed.length === 0);
  const handlers = {};
  const picker = {
    value: "", items: [], activeItems: [], selectedItems: [],
    onDidChangeValue(fn) { handlers.change = fn; },
    onDidChangeSelection(fn) { handlers.selection = fn; },
    onDidTriggerButton(fn) { handlers.button = fn; },
    onDidAccept(fn) { handlers.accept = fn; },
    onDidHide(fn) { handlers.hide = fn; },
    show() {}, hide() { handlers.hide(); }, dispose() {},
  };
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    vscode: {
      EventEmitter: class {}, ThemeIcon: class { constructor(id) { this.id = id; } },
      ThemeColor: class { constructor(id) { this.id = id; } },
      window: { createQuickPick: () => picker, createOutputChannel: () => ({}) },
    }, "./rTerminal/lang": {},
  });
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    mode: "ready", promptReady: true, rHistory: history,
    historyStorage: { state: { get: () => false, update: async () => {} } },
  });
  const opened = terminal.showHistoryPicker();
  await waitFor(() => picker.items.length === 50);
  assert.equal(picker.canSelectMany, true);
  assert.equal(picker.items.filter((item) => item.code).length, 50);
  const more = picker.buttons.find((button) => button.iconPath.id === "arrow-down");
  assert.ok(more, "load more must be a toolbar action rather than a selectable row");
  picker.selectedItems = [...picker.items];
  await handlers.button(picker.buttons.at(-1));
  await waitFor(() => history.getEntries().length === 30);
  assert.equal(picker.items.length, 30);
  handlers.hide();
  await opened;
});

test("missing page anchors cannot return unrelated commands", async (t) => {
  const f = fixture(t);
  const history = f.create();
  history.load();
  history.push("first()");
  history.push("second()");
  await waitFor(() => history.unconfirmed.length === 0);
  const page = await history.requestPage({ beforeId: "missing-id", limit: 20 });
  assert.deepEqual(page.entries, []);
  assert.equal(page.hasMore, false);
});

test("rapid repeated Up presses at the older-page boundary are processed in order", async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "history");
  fs.writeFileSync(file, Array.from({ length: 450 }, (_, i) =>
    "\n# time: old\n+command-" + i + "\n").join(""));
  const history = f.create(file);
  history.load();
  await waitFor(() => history.getEntries().length === 200);
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    vscode: { EventEmitter: class {}, window: { createOutputChannel: () => ({}) } },
    "./rTerminal/lang": {},
  });
  const { InputState } = loadSource("src/Terminal/inputState.ts");
  const inputState = new InputState();
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    mode: "ready", promptReady: true, promptVisible: true,
    rHistory: history, inputState, historyBrowsing: true,
    historyNavigationQueue: [], historyNavigationLoading: false,
    lang: { updateInput() {} }, clearInputRender() {}, renderInput() {},
  });
  history.selectEntryAt(0);
  terminal.navigateHistory(-1);
  terminal.navigateHistory(-1);
  await waitFor(() => !terminal.historyNavigationLoading);
  assert.equal(inputState.text, "command-248");
});

test("new Delete All supersedes older deletion rules without admitting stale writes", (t) => {
  const f = fixture(t);
  const { HistoryStore } = loadSource("src/Terminal/historyStore.ts");
  const file = path.join(f.dir, "history");
  const history = new HistoryStore(file);
  history.load();
  const first = performance.timeOrigin + performance.now();
  history.pushEntries([{ id: "first", code: "old()", createdAt: first - 1 }]);
  history.deleteEntries({ ids: ["first"], before: first });
  history.push("recent()");
  const second = performance.timeOrigin + performance.now();
  history.deleteEntries({ all: true, before: second });
  assert.equal((fs.readFileSync(file, "utf8").match(/# r-console-deletion:/g) || []).length, 1);
  const other = new HistoryStore(file);
  other.load();
  other.pushEntries([{ id: "stale-after-clear", code: "old()", createdAt: first - 1 }]);
  assert.deepEqual(other.getEntries(), []);
  other.pushEntries([{ id: "fresh-after-clear", code: "new()", createdAt: second + 1 }]);
  const restored = new HistoryStore(file);
  restored.load();
  assert.deepEqual(restored.getEntries(), ["new()"]);
});

test("picker deletion preserves the number of loaded matching rows", async (t) => {
  const f = fixture(t);
  const history = f.create();
  history.load();
  for (let i = 0; i < 120; i++) history.push("entry-" + i);
  await waitFor(() => history.unconfirmed.length === 0);
  const handlers = {};
  const picker = {
    value: "", items: [], activeItems: [], selectedItems: [],
    onDidChangeValue(fn) { handlers.change = fn; },
    onDidChangeSelection(fn) { handlers.selection = fn; },
    onDidTriggerButton(fn) { handlers.button = fn; },
    onDidAccept(fn) { handlers.accept = fn; },
    onDidHide(fn) { handlers.hide = fn; },
    show() {}, hide() { handlers.hide(); }, dispose() {},
  };
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    vscode: { EventEmitter: class {}, ThemeIcon: class { constructor(id) { this.id = id; } },
      ThemeColor: class { constructor(id) { this.id = id; } },
      window: { createQuickPick: () => picker, createOutputChannel: () => ({}) } },
    "./rTerminal/lang": {},
  });
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    mode: "ready", promptReady: true, rHistory: history,
    historyStorage: { state: { get: () => false, update: async () => {} } },
  });
  const opened = terminal.showHistoryPicker();
  await waitFor(() => picker.items.length === 50);
  const more = picker.buttons.find((button) => button.iconPath.id === "arrow-down");
  await handlers.button(more);
  assert.equal(picker.items.length, 100);
  picker.selectedItems = [picker.items[0]];
  await handlers.button(picker.buttons.at(-1));
  assert.equal(picker.items.length, 100);
  handlers.hide();
  await opened;
});

test("filtered pages use stable occurrence cursors after concurrent new submissions", async (t) => {
  const f = fixture(t);
  const a = f.create();
  const b = f.create();
  a.load(); b.load();
  for (let i = 0; i < 80; i++) a.push("entry-" + i);
  await waitFor(() => a.unconfirmed.length === 0);
  const first = await a.getPage("", false, 0, 50);
  b.push("newer()");
  await waitFor(() => b.unconfirmed.length === 0);
  const second = await a.getPage("", false, 0, 50, first.entries.at(-1).id);
  assert.equal(second.entries[0].code, "entry-29");
  assert.equal(new Set([...first.entries, ...second.entries].map(x => x.id)).size, 80);
});

test("F8 pagination observes recently queued local submissions", async (t) => {
  const f = fixture(t);
  const h = f.create();
  h.load();
  h.push("just-submitted()");
  const page = await h.getPage("", false);
  assert.equal(page.entries[0].code, "just-submitted()");
});

test("native Quick Pick checkbox clicks and Select All never replace picker items", async (t) => {
  const f = fixture(t);
  const history = f.create();
  history.load();
  for (const code of ["first()", "second()", "third()"]) history.push(code);
  await waitFor(() => history.unconfirmed.length === 0);
  const handlers = {};
  let itemWrites = 0;
  let visibleItems = [];
  const picker = {
    value: "", activeItems: [], selectedItems: [],
    get items() { return visibleItems; },
    set items(next) { itemWrites++; visibleItems = next; },
    onDidChangeValue(cb) { handlers.value = cb; },
    onDidTriggerButton(cb) { handlers.button = cb; },
    onDidChangeSelection(cb) { handlers.selection = cb; },
    onDidAccept(cb) { handlers.accept = cb; },
    onDidHide(cb) { handlers.hide = cb; },
    show() {}, hide() { handlers.hide(); }, dispose() {},
  };
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    vscode: {
      EventEmitter: class {},
      ThemeIcon: class { constructor(id) { this.id = id; } },
      window: { createQuickPick: () => picker, createOutputChannel: () => ({}) },
    }, "./rTerminal/lang": {},
  });
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    mode: "ready", promptReady: true, rHistory: history,
    historyStorage: { state: { get: () => false, update: async () => {} } },
  });
  const opened = terminal.showHistoryPicker();
  await waitFor(() => picker.items.length === 3);
  assert.equal(picker.canSelectMany, true);
  const initialWrites = itemWrites;
  picker.selectedItems = [picker.items[0]];
  handlers.selection?.(picker.selectedItems);
  assert.equal(itemWrites, initialWrites, "checking a row must not rerender Quick Pick items");
  picker.selectedItems = [...picker.items];
  handlers.selection?.(picker.selectedItems);
  assert.equal(itemWrites, initialWrites, "Select All must not rerender Quick Pick items");
  assert.equal(picker.selectedItems.length, 3);
  assert.equal(picker.items.some(item => item.buttons?.length), false,
    "there must be no per-row trash buttons");
  assert.equal(picker.buttons.filter(button => button.iconPath.id === "trash").length, 1);
  handlers.hide();
  await opened;
});
