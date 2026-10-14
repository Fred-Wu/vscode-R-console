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

test("F8 retains stable selection positions across local history evictions", (t) => {
  const f = fixture(t);
  const history = f.create();
  // This test isolates the foreground cache; no worker replies are required.
  history.disableStorage();
  history.setSearchNoDuplicates(true);
  // Simulate a full foreground cache to test cumulative front evictions.
  history.historyBuffer = Array.from({ length: 20000 }, (_, i) => `command-${i}`);
  history.historyIndex = history.historyBuffer.length;
  history.historyBuffer[5999] = "OLDER_TAG";
  history.historyBuffer[0] = "EVICTED_TAG";

  const [latest] = history.getPickerEntries("command-19999", false);
  const [older] = history.getPickerEntries("OLDER_TAG", false);
  const [evicted] = history.getPickerEntries("EVICTED_TAG", false);
  assert.deepEqual(older, { code: "OLDER_TAG", historyIndex: 5999 });

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
  assert.deepEqual(updated, { code: "new-b", historyIndex: 20001 });
  history.push("new-c");
  assert.equal(history.selectPickerEntry(updated), true);
  assert.equal(history.navigate(-1), "new-a");

  // A duplicate at an older occurrence retains its exact position.
  history.historyBuffer = Array.from({ length: 20000 }, (_, i) =>
    i === 2 || i === 15000 ? "repeat()" : `command-${i}`);
  history.pickerFrontEvictions = 0;
  const duplicates = history.getPickerEntries("repeat()", false);
  assert.deepEqual(duplicates.map((item) => item.historyIndex), [15000, 2]);
  history.push("new-d");
  assert.equal(history.selectPickerEntry(duplicates[1]), true);
  assert.equal(history.navigate(0), "repeat()");
});

test("background compaction preserves the selected duplicate while F8 defers updates", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "history"), Array.from({ length: 20000 }, (_, i) =>
    "\n# time: original\n+" + (i === 5001 || i === 15001 ? "repeat()" : "command-" + i) + "\n").join(""));
  const browsing = f.create();
  const writer = f.create();
  browsing.load(); writer.load();
  await waitFor(() => browsing.getEntries().length === 20000 && writer.getEntries().length === 20000);
  const resume = browsing.suspendUpdates();
  const snapshot = browsing.getEntries();
  writer.push("latest()");
  await waitFor(() => writer.stored.length === 19001);
  browsing.save();
  await waitFor(() => browsing.deferredUpdates.length > 0);
  assert.deepEqual(browsing.getEntries(), snapshot);
  browsing.selectEntryAt(5001);
  resume();
  await waitFor(() => {
    browsing.save();
    return browsing.storedStart === 1000;
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
  assert.equal(history.unconfirmed.length, 1);
  resume();
  assert.deepEqual(history.getEntries(), ["original()", "first()", "second()", "local()"]);
  assert.deepEqual(history.unconfirmed, []);
  assert.equal(history.deferredUpdates.length, 0);
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
