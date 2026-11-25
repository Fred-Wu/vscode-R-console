const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { registryKeys } = require("../helpers/registry-keys.cjs");
const { session } = require("../helpers/persistent-session.cjs");
const { PersistentSessionRegistry, getPersistentSessionRegistryPath } = loadSource("src/Runtime/persistentSessionRegistry.ts");

function fixture(t, content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-upgrade-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "persistent-sessions.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  const keys = registryKeys();
  const errors = [];
  const registry = new PersistentSessionRegistry(file, keys.readKey, error => errors.push(error));
  t.after(() => registry.dispose());
  return { file, registry, read: () => keys.read(file), keys, errors };
}

test("workspace sessions keep their existing registry path", async () => {
  const storagePath = path.join(os.tmpdir(), "workspace-storage");
  assert.equal(await getPersistentSessionRegistryPath({ storageUri: { fsPath: storagePath } }),
    path.join(storagePath, "persistent-sessions.json"));
});

test("folderless windows preserve separate sessions across saves and reloads", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-folderless-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateA = new Map();
  const stateB = new Map();
  const context = (state) => ({
    globalStorageUri: { fsPath: directory },
    workspaceState: {
      get: (key) => state.get(key),
      update: async (key, value) => { state.set(key, value); },
    },
  });
  const [fileA, fileB] = await Promise.all([
    getPersistentSessionRegistryPath(context(stateA)),
    getPersistentSessionRegistryPath(context(stateB)),
  ]);
  assert.notEqual(fileA, fileB);
  const keys = registryKeys();
  const registryA = new PersistentSessionRegistry(fileA, keys.readKey);
  const registryB = new PersistentSessionRegistry(fileB, keys.readKey);
  assert.deepEqual(await registryA.load(), []);
  assert.deepEqual(await registryB.load(), []);
  const sessionsA = [session(), session()];
  const sessionsB = [session()];
  assert.equal(await registryA.save(sessionsA), true);
  assert.equal(await registryB.save(sessionsB), true);

  // New contexts reuse persisted state, as after an extension host reload.
  const reloadedFileA = await getPersistentSessionRegistryPath(context(new Map(stateA)));
  const reloadedFileB = await getPersistentSessionRegistryPath(context(new Map(stateB)));
  assert.equal(reloadedFileA, fileA);
  assert.equal(reloadedFileB, fileB);
  assert.deepEqual(await new PersistentSessionRegistry(reloadedFileA, keys.readKey).load(), sessionsA);
  assert.deepEqual(await new PersistentSessionRegistry(reloadedFileB, keys.readKey).load(), sessionsB);

  // Closing all sessions in B must not remove A's reconnect records.
  assert.equal(await registryB.save([]), true);
  assert.deepEqual(await new PersistentSessionRegistry(fileA, keys.readKey).load(), sessionsA);
});

test("an upgrade retains old records while authenticated sessions remain reconnectable", async (t) => {
  const old = session({ legacy: true });
  const current = session();
  const { registry, read, file, keys } = fixture(t, { sessions: [old, current], futureMetadata: "retain" });
  const loaded = await registry.load();
  assert.deepEqual(loaded, [current]);
  assert.deepEqual(registry.legacySessions, [old]);
  assert.equal(await registry.save(loaded), true);
  const reloaded = new PersistentSessionRegistry(file, keys.readKey);
  assert.deepEqual(await reloaded.load(), [current]);
  assert.deepEqual(reloaded.legacySessions, [old]);
  assert.equal(read().futureMetadata, "retain");
  assert.equal(read().sessions.length, 2);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("legacy-only records survive startup, heartbeat, and deactivation saves", async (t) => {
  const old = session({ legacy: true });
  const { registry, read } = fixture(t, { sessions: [old] });
  assert.deepEqual(await registry.load(), []);
  for (let i = 0; i < 3; i++) assert.equal(await registry.save([]), true);
  assert.deepEqual(read().sessions, [old]);
});

for (const currentVersion of [3, 4]) {
  test(`protocol ${currentVersion} detects every older session for the same notice and close flow`, async t => {
    const { PersistentSessionRegistry: UpgradedRegistry } = loadSource("src/Runtime/persistentSessionRegistry.ts", {
      "./backendProtocol": { BACKEND_PROTOCOL_VERSION: currentVersion },
    });
    const old = [session({ legacy: true }), session({ legacy: true, protocolVersion: 1 }),
      ...Array.from({ length: currentVersion - 2 }, (_, i) => session({ protocolVersion: i + 2 }))];
    const current = session({ protocolVersion: currentVersion });
    const damaged = session({ protocolVersion: 2, authToken: "invalid" });
    const newer = session({ protocolVersion: currentVersion + 1 });
    const { file, read, keys } = fixture(t, { sessions: [...old, current, damaged, newer] });
    const registry = new UpgradedRegistry(file, keys.readKey);
    assert.deepEqual(await registry.load(), [current]);
    assert.deepEqual(registry.legacySessions, old);
    assert.equal(await registry.forgetLegacySession(old.at(-1)), true);
    assert.deepEqual(read().sessions, [current, ...old.slice(0, -1), damaged, newer]);
  });
}

test("only protocol 3 reconnects; old records are distinguished from unsupported or damaged records", async (t) => {
  const old = session({ legacy: true, protocolVersion: 1 });
  const historical = session({ legacy: true });
  const oldProtocol2 = session({ protocolVersion: 2 });
  const current = session();
  const incompatible = [
    session({ protocolVersion: 1 }),
    session({ protocolVersion: 4 }),
    session({ protocolVersion: undefined }),
    session({ legacy: true, protocolVersion: 3 }),
  ];
  const records = [current, old, historical, oldProtocol2, ...incompatible];
  const { registry, read } = fixture(t, { sessions: records });
  assert.deepEqual(await registry.load(), [current]);
  assert.deepEqual(registry.legacySessions, [old, historical, oldProtocol2]);
  assert.equal(await registry.save([current]), true);
  assert.deepEqual(read().sessions, JSON.parse(JSON.stringify(records)));
});

test("malformed credentials are preserved but never treated as a legacy authentication fallback", async (t) => {
  const malformed = session({ authToken: "invalid" });
  const current = session();
  const { registry, read } = fixture(t, { sessions: [malformed, null, current] });
  assert.deepEqual(await registry.load(), [current]);
  assert.deepEqual(registry.legacySessions, []);
  assert.equal(await registry.save([current]), false);
  assert.deepEqual(read().sessions, [malformed, null, current]);
});

for (const content of ['{"sessions":', '{"futureSchema":true}']) {
  test(`unreadable registry schema is not overwritten: ${content}`, async (t) => {
    const { registry, file } = fixture(t, content);
    assert.deepEqual(await registry.load(), []);
    assert.equal(await registry.save([session()]), false);
    assert.equal(fs.readFileSync(file, "utf8"), content);
  });
}

test("closing one old session removes only its record, including across a refresh", async (t) => {
  const first = session({ legacy: true, cwd: "/first" });
  const second = session({ legacy: true, cwd: "/second" });
  const current = session();
  const { registry, read } = fixture(t, { sessions: [first, second, current] });
  await registry.load();
  const selected = registry.legacySessions[0];
  await registry.load();
  assert.equal(await registry.forgetLegacySession(selected), true);
  assert.deepEqual(read().sessions, [current, second]);
});

test("replay, typed input, reconnect credentials and metadata are encrypted with fresh nonces", async t => {
  const entry = session();
  entry.terminal.ui.replay.lines.push("PRINTED_SECRET_123");
  entry.terminal.ui.inputText = "TYPED_SECRET_456";
  const { registry, file, keys, read } = fixture(t, { sessions: [entry], environment: "METADATA_SECRET_789" });
  assert.deepEqual(await registry.load(), [entry]);
  const first = fs.readFileSync(file, "utf8");
  for (const secret of ["PRINTED_SECRET_123", "TYPED_SECRET_456", "METADATA_SECRET_789", entry.terminal.runtime.authToken, entry.terminal.options.cwd]) {
    assert.equal(first.includes(secret), false);
  }
  assert.equal(read().environment, "METADATA_SECRET_789");
  assert.equal(await registry.save([entry]), true);
  const second = fs.readFileSync(file, "utf8");
  assert.notEqual(JSON.parse(first).sessions[0].iv, JSON.parse(second).sessions[0].iv);
  registry.dispose();
  const restored = new PersistentSessionRegistry(file, keys.readKey);
  t.after(() => restored.dispose());
  assert.deepEqual(await restored.load(), [entry]);
});

test("a lost key preserves that encrypted record while another session saves and reloads", async t => {
  const a = session(), b = session();
  const { registry, file, keys } = fixture(t, { sessions: [a, b] });
  await registry.load();
  const original = JSON.parse(fs.readFileSync(file, "utf8")).sessions[0];
  assert.notDeepEqual(...[...keys.runtimes.values()].map(runtime => runtime.key));
  keys.runtimes.get(`${a.terminal.runtime.sessionId}:${process.pid}`).unavailable = true;
  registry.dispose();
  const restored = new PersistentSessionRegistry(file, keys.readKey);
  t.after(() => restored.dispose());
  assert.deepEqual(await restored.load(), [b]);
  b.terminal.ui.inputText = "changed";
  assert.equal(await restored.save([b]), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).sessions.find(row => row.sessionId === a.terminal.runtime.sessionId), original);
  keys.runtimes.get(`${a.terminal.runtime.sessionId}:${process.pid}`).unavailable = false;
  const recovered = await new PersistentSessionRegistry(file, keys.readKey).load();
  assert.deepEqual(new Set(recovered.map(value => value.terminal.runtime.sessionId)), new Set([a, b].map(value => value.terminal.runtime.sessionId)));
  assert.equal(recovered.find(value => value.terminal.runtime.sessionId === b.terminal.runtime.sessionId).terminal.ui.inputText, "changed");
});

for (const field of ["ciphertext", "tag", "sessionId", "pid", "path"]) {
  test(`authenticated records reject changed ${field} and preserve unreadable ciphertext`, async t => {
    const entry = session();
    const { registry, file, keys } = fixture(t, { sessions: [entry] });
    await registry.load();
    registry.dispose();
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (["ciphertext", "tag"].includes(field)) {
      const bytes = Buffer.from(value.sessions[0][field], "base64");
      bytes[0] ^= 1;
      value.sessions[0][field] = bytes.toString("base64");
    } else if (field === "sessionId") value.sessions[0].sessionId = require("node:crypto").randomUUID();
    else if (field === "pid") value.sessions[0].pid = process.ppid;
    const target = field === "path" ? `${file}.copy` : file;
    const encoded = JSON.stringify(value);
    fs.writeFileSync(target, encoded);
    const restored = new PersistentSessionRegistry(target, keys.readKey);
    t.after(() => restored.dispose());
    assert.deepEqual(await restored.load(), []);
    assert.equal(await restored.save([]), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")).sessions, value.sessions);
  });
}

test("runtime rejects a plaintext downgrade even if a malformed record accompanies it", async t => {
  const entry = session();
  const { registry, file, keys } = fixture(t, { sessions: [entry] });
  await registry.load();
  registry.dispose();
  const replacement = JSON.stringify({ sessions: [entry, null] });
  fs.writeFileSync(file, replacement);
  const restored = new PersistentSessionRegistry(file, keys.readKey);
  t.after(() => restored.dispose());
  assert.deepEqual(await restored.load(), []);
  assert.equal(await restored.save([entry]), false);
  assert.equal(fs.readFileSync(file, "utf8"), replacement);
});

test("failed atomic replacement can retry the same migration but rejects changed plaintext", async t => {
  const entry = session();
  const { registry, file, keys } = fixture(t, { sessions: [entry] });
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error("write failure"); };
  try { assert.deepEqual(await registry.load(), [entry]); }
  finally { fs.renameSync = rename; }
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).format, undefined);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  assert.equal(await registry.save([entry]), true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).format, "r-console-session-records");

  const other = fixture(t, { sessions: [session()] });
  fs.renameSync = () => { throw new Error("write failure"); };
  try { await other.registry.load(); } finally { fs.renameSync = rename; }
  const changed = JSON.parse(fs.readFileSync(other.file, "utf8"));
  changed.sessions[0].terminal.ui.inputText = "changed";
  fs.writeFileSync(other.file, JSON.stringify(changed));
  assert.deepEqual(await new PersistentSessionRegistry(other.file, other.keys.readKey).load(), []);
});

test("older runtimes without a key keep their existing registry and never fall back to plaintext writes", async t => {
  const entry = session();
  const { file } = fixture(t, { sessions: [entry] });
  const before = fs.readFileSync(file, "utf8");
  const registry = new PersistentSessionRegistry(file, async () => { throw new Error("Old runtime"); });
  t.after(() => registry.dispose());
  assert.deepEqual(await registry.load(), [entry]);
  entry.terminal.ui.inputText = "must not be written";
  assert.equal(await registry.save([entry]), false);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("concurrent saves finish in order and observe snapshots taken at request time", async t => {
  const entry = session();
  const { registry, read } = fixture(t, { sessions: [] });
  await registry.load();
  const first = registry.save([entry]);
  entry.terminal.ui.inputText = "latest input";
  const second = registry.save([entry]);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(read().sessions[0].terminal.ui.inputText, "latest input");
});

test("external registry changes are preserved and failed saves do not leave temporary files", async t => {
  const { registry, file } = fixture(t, { sessions: [] });
  await registry.load();
  const external = '{"newerWriter":true}';
  fs.writeFileSync(file, external);
  assert.equal(await registry.save([session()]), false);
  assert.equal(fs.readFileSync(file, "utf8"), external);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
});

test("disposing a registry cancels pending key retrieval and clears the received key", async t => {
  const { file } = fixture(t, { format: "r-console-session-records", version: 1, sessions: [] });
  let release;
  const transferred = Buffer.alloc(32, 42);
  const registry = new PersistentSessionRegistry(file, () => new Promise(resolve => { release = resolve; }));
  await registry.load();
  const before = fs.readFileSync(file, "utf8");
  const pending = registry.save([session()]);
  await new Promise(resolve => setImmediate(resolve));
  registry.dispose();
  release(transferred);
  assert.equal(await pending, false);
  assert.deepEqual(transferred, Buffer.alloc(32));
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("queued snapshots coalesce while one runtime key request is in flight", async t => {
  const { file, keys } = fixture(t, { sessions: [] });
  let release;
  let requests = 0;
  const registry = new PersistentSessionRegistry(file, async identity => {
    requests++;
    await new Promise(resolve => { release = resolve; });
    return keys.readKey(identity);
  });
  t.after(() => registry.dispose());
  await registry.load();
  const entry = session();
  const first = registry.save([entry]);
  await new Promise(resolve => setImmediate(resolve));
  const pending = [];
  for (let i = 0; i < 50; i++) {
    entry.terminal.ui.inputText = `snapshot ${i}`;
    pending.push(registry.save([entry]));
  }
  assert.equal(pending[0], pending.at(-1), "queued saves share one pending write");
  release();
  assert.equal(await first, true);
  assert.ok((await Promise.all(pending)).every(Boolean));
  assert.equal(requests, 1);
  assert.equal(keys.read(file).sessions[0].terminal.ui.inputText, "snapshot 49");
});

test("missing runtime keys back off so heartbeat saves do not repeatedly block shutdown", async t => {
  const { file } = fixture(t, { sessions: [] });
  let calls = 0;
  const registry = new PersistentSessionRegistry(file, async () => { calls++; throw new Error("Missing runtime"); });
  t.after(() => registry.dispose());
  await registry.load();
  const entry = session();
  for (let i = 0; i < 5; i++) assert.equal(await registry.save([entry]), false);
  assert.equal(calls, 1);
});

test("unknown metadata stays with its record during partial recovery", async t => {
  const original = session(), other = session();
  const { registry, file, keys } = fixture(t, { sessions: [original], futureMetadata: "retain" });
  await registry.load();
  registry.dispose();
  const runtime = keys.runtimes.get(`${original.terminal.runtime.sessionId}:${process.pid}`);
  runtime.unavailable = true;
  const partial = new PersistentSessionRegistry(file, keys.readKey);
  assert.deepEqual(await partial.load(), []);
  assert.equal(await partial.save([other]), true);
  partial.dispose();
  runtime.unavailable = false;
  const restored = new PersistentSessionRegistry(file, keys.readKey);
  t.after(() => restored.dispose());
  const records = await restored.load();
  assert.equal(await restored.save(records), true);
  // Remove the newly added record to inspect the recovered record's metadata.
  assert.equal(await restored.save([original]), true);
  assert.equal(keys.read(file).futureMetadata, "retain");
});

test("closing sessions removes only their records and deletes the file after the last one", async t => {
  const first = session(), second = session();
  const { registry, file, read } = fixture(t, { sessions: [first, second] });
  await registry.load();
  assert.equal(await registry.save([second]), true);
  assert.deepEqual(read().sessions, [second]);
  assert.equal(await registry.save([]), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(await registry.save([]), true, "later empty saves must keep the registry absent");
  assert.equal(fs.existsSync(file), false);
  assert.equal(await registry.save([session()]), true, "a new session must recreate the registry");
  assert.equal(read().sessions.length, 1);
});

test("an empty window does not create a registry file or storage directory", async t => {
  const { file, keys } = fixture(t, { sessions: [] });
  const absentFile = path.join(path.dirname(file), "new-window", "persistent-sessions.json");
  const registry = new PersistentSessionRegistry(absentFile, keys.readKey);
  t.after(() => registry.dispose());
  assert.deepEqual(await registry.load(), []);
  assert.equal(await registry.save([]), true);
  assert.equal(fs.existsSync(path.dirname(absentFile)), false);
});

test("an empty save preserves a live session whose key is unavailable", async t => {
  const entry = session();
  const { registry, file, keys } = fixture(t, { sessions: [entry] });
  await registry.load();
  const before = JSON.parse(fs.readFileSync(file, "utf8"));
  registry.dispose();
  const reloaded = new PersistentSessionRegistry(file, async () => { throw new Error("Temporarily unavailable"); });
  t.after(() => reloaded.dispose());
  assert.deepEqual(await reloaded.load(), []);
  assert.equal(await reloaded.save([]), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), before);
});

test("cleanup preserves a registry changed by another writer", async t => {
  const { registry, file } = fixture(t, { sessions: [session()] });
  await registry.load();
  const external = '{"futureSchema":true}';
  fs.writeFileSync(file, external);
  assert.equal(await registry.save([]), false);
  assert.equal(fs.readFileSync(file, "utf8"), external);
});

test("failed last-session deletion retains the file and can be retried", async t => {
  const { registry, file } = fixture(t, { sessions: [session()] });
  await registry.load();
  const before = fs.readFileSync(file, "utf8");
  const remove = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (target === file) throw Object.assign(new Error("File is temporarily locked"), { code: "EBUSY" });
    return remove(target, options);
  };
  try { assert.equal(await registry.save([]), false); }
  finally { fs.rmSync = remove; }
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(await registry.save([]), true);
  assert.equal(fs.existsSync(file), false);
});

test("Ctrl+L removes old output from encrypted replay while retaining the live session and draft", async t => {
  const { createTerminalWithScreen } = require("../helpers/submission-terminal.cjs");
  const { terminal, history } = createTerminalWithScreen(t);
  const record = session();
  terminal.options = { ...terminal.options, ...record.terminal.options };
  terminal.runtimeBackend.getReconnectInfo = () => record.terminal.runtime;
  terminal.backendChildPid = process.pid;
  terminal.replyPromptText = "";
  terminal.pendingInitialPromptGap = false;
  terminal.hasReceivedOutput = true;
  terminal.replayStartAbsoluteRow = 0;
  const initialReplay = terminal.terminalState = terminal.createReplayTerminal();
  t.after(() => { initialReplay.dispose(); terminal.terminalState.dispose(); });
  terminal.captureTerminalWrite("R> print('OLD_PRINTED_VALUE')\r\nOLD_PRINTED_VALUE\r\n");
  terminal.inputState.text = "draft <- 42";
  terminal.inputState.cursorToEnd();
  terminal.rHistory.push("print('OLD_PRINTED_VALUE')");
  const snapshot = () => ({ ...record, terminal: terminal.exportPersistentState() });
  const { registry, file, read, keys } = fixture(t, { sessions: [] });
  await registry.load();
  assert.equal(await registry.save([snapshot()]), true);
  assert.match(read().sessions[0].terminal.ui.replay.lines.join("\n"), /OLD_PRINTED_VALUE/);
  terminal.handleInput("\x0c");
  assert.equal(await registry.save([snapshot()]), true);
  const saved = read().sessions[0];
  assert.doesNotMatch(saved.terminal.ui.replay.lines.join("\n"), /OLD_PRINTED_VALUE/);
  assert.equal(saved.terminal.ui.inputText, "draft <- 42");
  assert.deepEqual(history, ["print('OLD_PRINTED_VALUE')"]);
  assert.equal(fs.existsSync(file), true, "the living session still needs its reconnect record");
  registry.dispose();
  const restored = new PersistentSessionRegistry(file, keys.readKey);
  t.after(() => restored.dispose());
  assert.deepEqual(await restored.load(), [saved]);
});
