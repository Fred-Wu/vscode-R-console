const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { registryKeys } = require("../helpers/registry-keys.cjs");
const { session } = require("../helpers/persistent-session.cjs");
const { PersistentSessionRegistry, getPersistentSessionRegistryPath } = loadSource("src/Runtime/persistentSessionRegistry.ts");

test("loading and saving bound simultaneous key reads and preserve session order", async t => {
  const sessions = Array.from({ length: 24 }, () => session());
  const { file, keys } = fixture(t, { sessions });
  let active = 0, peak = 0, calls = 0;
  const registry = new PersistentSessionRegistry(file, async identity => {
    calls++;
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return keys.readKey(identity);
  });
  t.after(() => registry.dispose());
  assert.deepEqual(await registry.load(), sessions);
  assert.equal(calls, sessions.length);
  assert.equal(peak, 4);
  const added = Array.from({ length: 24 }, () => session());
  assert.equal(await registry.save([...sessions, ...added]), true);
  assert.equal(peak, 4);
  assert.equal(calls, sessions.length + added.length);
  assert.deepEqual(keys.read(file).sessions, [...sessions, ...added]);
});

for (const plaintext of [false, true]) {
  test(`too many ${plaintext ? "plaintext" : "encrypted"} records preserve the original without key reads`, async t => {
    const { registry, file } = fixture(t, { sessions: Array.from({ length: 257 }, () => session()) }, { plaintext });
    const original = fs.readFileSync(file, "utf8");
    let calls = 0;
    registry.readKey = async () => { calls++; throw new Error("must not retrieve keys"); };
    assert.deepEqual(await registry.load(), []);
    assert.equal(calls, 0);
    assert.equal(await registry.save([session()]), false);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  });
}

test("oversized files are rejected before reading their contents and cannot be overwritten", async t => {
  const { registry, file, errors } = fixture(t, { sessions: [] });
  fs.truncateSync(file, 64 * 1024 * 1024 + 1);
  const before = fs.statSync(file);
  assert.deepEqual(await registry.load(), []);
  assert.equal(await registry.save([session()]), false);
  assert.equal(fs.statSync(file).size, before.size);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(errors.length, 1);
});

test("a growing file is bounded even when its initial stat is below the size limit", async t => {
  const { file } = fixture(t, { sessions: [] });
  fs.truncateSync(file, 64 * 1024 * 1024 + 1);
  let closed = false, readBytes = 0;
  const { PersistentSessionRegistry: Registry } = loadSource("src/Runtime/persistentSessionRegistry.ts", {
    fs: { ...fs, promises: { ...fs.promises, open: async (...args) => {
      const handle = await fs.promises.open(...args);
      return {
        stat: async () => ({ isFile: () => true, size: 64 }),
        createReadStream: options => {
          const stream = handle.createReadStream(options);
          stream.on("data", chunk => { readBytes += chunk.length; });
          return stream;
        },
        close: async () => { closed = true; await handle.close(); },
      };
    } } },
  });
  const registry = new Registry(file, async () => { throw new Error("must not retrieve keys"); });
  t.after(() => registry.dispose());
  assert.deepEqual(await registry.load(), []);
  assert.equal(closed, true);
  assert.equal(readBytes, 64 * 1024 * 1024 + 1);
  assert.equal(await registry.save([session()]), false);
});

test("over-limit saves and externally enlarged files preserve existing records", async t => {
  const entry = session();
  const { registry, file } = fixture(t, { sessions: [entry] });
  await registry.load();
  const original = fs.readFileSync(file, "utf8");
  assert.equal(await registry.save(Array.from({ length: 257 }, () => session())), false);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  fs.truncateSync(file, 64 * 1024 * 1024 + 1);
  assert.equal(await registry.save([entry]), false);
  assert.equal(fs.statSync(file).size, 64 * 1024 * 1024 + 1);
});

for (const stop of ["dispose", "budget"]) {
  test(`${stop} stops queued key requests and preserves unread sessions`, async t => {
    const sessions = Array.from({ length: 12 }, () => session());
    const { file, keys } = fixture(t, { sessions });
    const original = fs.readFileSync(file, "utf8");
    let release, started, calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const firstBatch = new Promise(resolve => { started = resolve; });
    const registry = new PersistentSessionRegistry(file, async identity => {
      if (++calls === 4) started();
      await gate;
      return keys.readKey(identity);
    });
    t.after(() => registry.dispose());
    const realNow = Date.now;
    let now = realNow();
    if (stop === "budget") Date.now = () => now;
    try {
      const pending = registry.load();
      await firstBatch;
      if (stop === "dispose") registry.dispose();
      else now += 5000;
      release();
      const restored = await pending;
      assert.equal(calls, 4);
      assert.equal(restored.length, stop === "dispose" ? 0 : 4);
      assert.equal(fs.readFileSync(file, "utf8"), original);
      if (stop === "budget") {
        assert.equal(await registry.save(restored), true);
        assert.deepEqual(new Set(keys.read(file).sessions.map(value => value.terminal.runtime.sessionId)),
          new Set(sessions.map(value => value.terminal.runtime.sessionId)));
      }
    } finally { Date.now = realNow; release(); }
  });
}

function fixture(t, content, { plaintext = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-upgrade-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "persistent-sessions.json");
  const keys = registryKeys();
  if (typeof content === "string" || plaintext || content.format) {
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  } else keys.seed(file, content);
  const values = new Map();
  const secrets = {
    get: async key => values.get(key),
    store: async (key, value) => { values.set(key, value); },
    delete: async key => { values.delete(key); },
  };
  const errors = [];
  const registry = new PersistentSessionRegistry(file, keys.readKey, error => errors.push(error), secrets);
  t.after(() => registry.dispose());
  return { file, registry, read: () => keys.read(file), keys, errors, secrets, values };
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


function shutdownRecord(entry) {
  const { sessionId, pid, port, protocolVersion, authToken } = entry.terminal.runtime;
  return { terminal: { runtime: { sessionId, pid, port, protocolVersion,
    ...(authToken ? { authToken } : {}) } } };
}

test("protocol 4 deletes old plaintext after securing only shutdown credentials", async t => {
  const old = session({ protocolVersion: 3 });
  old.terminal.ui.inputText = "OLD_UNSUBMITTED_SECRET";
  const { registry, file, keys, secrets, values } = fixture(t,
    { sessions: [old], environment: "OLD_METADATA" }, { plaintext: true });
  assert.deepEqual(await registry.load(), []);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(registry.legacySessions, [shutdownRecord(old)]);
  assert.equal(keys.runtimes.size, 0, "migration never requests the old runtime key");
  const secured = [...values.values()][0];
  assert.deepEqual(JSON.parse(secured), [shutdownRecord(old)]);
  assert.doesNotMatch(secured, /OLD_UNSUBMITTED_SECRET|OLD_METADATA|options|replay|location/);
  assert.equal(await registry.save([session()]), true);
  const reloaded = new PersistentSessionRegistry(file, keys.readKey, undefined, secrets);
  t.after(() => reloaded.dispose());
  assert.equal((await reloaded.load()).length, 1, "new session reattaches using encrypted replay");
  assert.deepEqual(reloaded.legacySessions, [shutdownRecord(old)]);
  assert.equal(await reloaded.forgetLegacySession(reloaded.legacySessions[0]), true);
  assert.equal(values.size, 0, "shutdown credentials disappear after confirmed close");
});

test("dismissal and reload preserve only minimal old shutdown records, not a plaintext file", async t => {
  const old = session({ protocolVersion: 3 });
  const { registry, file, secrets, keys } = fixture(t, { sessions: [old] }, { plaintext: true });
  assert.deepEqual(await registry.load(), []);
  assert.equal(fs.existsSync(file), false);
  for (let n = 0; n < 3; n++) assert.equal(await registry.save([]), true);
  const reload = new PersistentSessionRegistry(file, keys.readKey, undefined, secrets);
  t.after(() => reload.dispose());
  assert.deepEqual(await reload.load(), []);
  assert.deepEqual(reload.legacySessions, [shutdownRecord(old)]);
  assert.equal(await reload.forgetLegacySession(reload.legacySessions[0]), true);
  assert.deepEqual(reload.legacySessions, []);
});

test("an encrypted older-protocol session is removed from replay but retained for shutdown", async t => {
  const old = session({ protocolVersion: 3 }), current = session();
  const { registry, file, keys, secrets } = fixture(t, { sessions: [old, current] });
  assert.deepEqual(await registry.load(), [current]);
  assert.deepEqual(registry.legacySessions, [shutdownRecord(old)]);
  assert.deepEqual(keys.read(file).sessions, [current]);
  const reload = new PersistentSessionRegistry(file, keys.readKey, undefined, secrets);
  t.after(() => reload.dispose());
  assert.deepEqual(await reload.load(), [current]);
  assert.deepEqual(reload.legacySessions, [shutdownRecord(old)]);
});

test("plaintext with live current-protocol reconnect information is never silently deleted", async t => {
  const live = session();
  const { registry, file } = fixture(t, { sessions: [live] }, { plaintext: true });
  const original = fs.readFileSync(file, "utf8");
  assert.deepEqual(await registry.load(), []);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(await registry.save([live]), false);
});

test("unsupported and damaged plaintext rows cannot become shutdown credentials", async t => {
  const damaged = session({ protocolVersion: 3, authToken: "bad" });
  const { registry, file, values } = fixture(t, { sessions: [damaged, null] }, { plaintext: true });
  assert.deepEqual(await registry.load(), []);
  assert.deepEqual(registry.legacySessions, []);
  assert.equal(values.size, 0);
  assert.equal(fs.existsSync(file), false);
});

test("failed secret storage preserves the original plaintext and disables writes", async t => {
  const old = session({ protocolVersion: 3 });
  const { registry, file, secrets } = fixture(t, { sessions: [old] }, { plaintext: true });
  const original = fs.readFileSync(file, "utf8");
  secrets.store = async () => { throw new Error("SecretStorage unavailable"); };
  assert.deepEqual(await registry.load(), []);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(await registry.save([session()]), false);
});

test("locked plaintext file is left intact until deletion can safely retry", async t => {
  const old = session({ protocolVersion: 3 });
  const { registry, file, values } = fixture(t, { sessions: [old] }, { plaintext: true });
  const original = fs.readFileSync(file, "utf8");
  const remove = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (target === file) throw new Error("File locked");
    return remove(target, options);
  };
  try { assert.deepEqual(await registry.load(), []); }
  finally { fs.rmSync = remove; }
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(values.size, 1);
  assert.deepEqual(await registry.load(), []);
  assert.equal(fs.existsSync(file), false);
});

for (const content of ['{"sessions":', '{"futureSchema":true}']) {
  test(`unreadable registry schema is not overwritten: ${content}`, async t => {
    const { registry, file } = fixture(t, content);
    assert.deepEqual(await registry.load(), []);
    assert.equal(await registry.save([session()]), false);
    assert.equal(fs.readFileSync(file, "utf8"), content);
  });
}

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

test("tampered plaintext never downgrades an already encrypted live session", async t => {
  const entry = session();
  const { registry, file, keys } = fixture(t, { sessions: [entry] });
  assert.deepEqual(await registry.load(), [entry]);
  registry.dispose();
  const tampered = JSON.stringify({ sessions: [entry, null] });
  fs.writeFileSync(file, tampered);
  const replacement = new PersistentSessionRegistry(file, keys.readKey);
  t.after(() => replacement.dispose());
  assert.deepEqual(await replacement.load(), []);
  assert.equal(await replacement.save([entry]), false);
  assert.equal(fs.readFileSync(file, "utf8"), tampered);
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

test("a new session with an unavailable key does not block healthy saves or replay clearing", async t => {
  const healthy = session(), missing = session(), another = session();
  const { registry, file, keys, read, errors } = fixture(t, { sessions: [healthy] });
  await registry.load();
  await keys.readKey(missing.terminal.runtime);
  keys.runtimes.get(`${missing.terminal.runtime.sessionId}:${process.pid}`).unavailable = true;
  healthy.terminal.ui.replay.lines = [];
  missing.terminal.ui.inputText = "UNSAVED_SECRET";
  assert.equal(await registry.save([healthy, missing, another]), false, "report the incomplete save");
  assert.deepEqual(read().sessions, [healthy, another], "healthy records still commit");
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /UNSAVED_SECRET/);
  assert.ok(errors.length);
  keys.runtimes.get(`${missing.terminal.runtime.sessionId}:${process.pid}`).unavailable = false;
  registry.failedKeys.clear();
  assert.equal(await registry.save([healthy, missing, another]), true);
  assert.deepEqual(read().sessions, [healthy, missing, another]);
});

test("a failed re-encryption retains the last ciphertext while other records advance", async t => {
  const healthy = session(), unavailable = session();
  const { registry, file, keys, read } = fixture(t, { sessions: [healthy, unavailable] });
  await registry.load();
  const original = JSON.parse(fs.readFileSync(file, "utf8")).sessions[1];
  registry.clearKeys();
  keys.runtimes.get(`${unavailable.terminal.runtime.sessionId}:${process.pid}`).unavailable = true;
  healthy.terminal.ui.inputText = "healthy update";
  const newer = structuredClone(unavailable);
  newer.terminal.ui.inputText = "unavailable update";
  assert.equal(await registry.save([healthy, newer]), false);
  assert.deepEqual(read().sessions, [healthy, unavailable]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).sessions[1], original);
  assert.equal(await registry.save([healthy]), true, "explicitly removed readable records are pruned");
  assert.deepEqual(read().sessions, [healthy]);
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
