const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

async function connection(t, { supported = true, load, save } = {}) {
  const ipc = [];
  let stored;
  const { RustSidecarRuntimeBackend } = loadSource("src/Runtime/runtimeBackend.ts", {
    "./privateStartupState": {
      loadPrivateStartupState: async identity => {
        ipc.push(["get", identity]);
        return load ? load(identity) : stored && Buffer.from(stored);
      },
      savePrivateStartupState: async (identity, bytes) => {
        ipc.push(["put", identity]);
        if (save) return save(identity, bytes);
        if (stored && !stored.equals(bytes)) throw new Error("Persistent session already has a different startup snapshot");
        stored = Buffer.from(bytes);
      },
    },
  });
  const backend = new RustSidecarRuntimeBackend("unused");
  const session = backend.reconnect({
    sessionId: "test", port: 12345, pid: process.pid, protocolVersion: 4, authToken: "a".repeat(64),
  });
  const writes = [], visible = [];
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false, resume() {}, destroy() { this.destroyed = true; },
    write(bytes) { writes.push(bytes); },
  });
  backend.connectSocketWithRetry = async () => socket;
  backend.attach(session, { onControl: event => visible.push(event.type), onError() {} });
  await nextTurn();
  const state = backend.getOrCreateState(session);
  state.hostConnected = true;
  if (supported) state.capabilities.add("lsp-startup-ipc-v1");
  t.after(() => backend.detach(session));
  return { backend, session, socket, writes, visible, ipc, state };
}

test("startup state uses private same-user IPC, never the backend TCP socket", async t => {
  const { backend, session, writes, visible, ipc } = await connection(t);
  assert.equal(await backend.loadLspStartupState(session), undefined);
  await backend.saveLspStartupState(session, Buffer.from("synthetic-credential"));
  const retrieved = await backend.loadLspStartupState(session);
  assert.equal(retrieved.toString(), "synthetic-credential");
  retrieved.fill(0);
  assert.deepEqual(ipc.map(([operation]) => operation), ["get", "put", "get"]);
  assert.ok(ipc.every(([, identity]) => identity.pid === process.pid && identity.sessionId === "test"));
  assert.deepEqual(writes, [], "no credential-bearing startup payload crosses TCP");
  assert.deepEqual(visible, []);
});

test("startup state is write-once and rejects unsupported runtime capability", async t => {
  const { backend, session, writes } = await connection(t);
  await backend.saveLspStartupState(session, Buffer.from("first"));
  await backend.saveLspStartupState(session, Buffer.from("first"));
  await assert.rejects(backend.saveLspStartupState(session, Buffer.from("second")), /different startup snapshot/);
  assert.deepEqual(writes, []);
  const old = await connection(t, { supported: false });
  await assert.rejects(old.backend.loadLspStartupState(old.session), /Close the old R session/);
  assert.deepEqual(old.writes, []);
});

test("detach rejects pending private reads and clears late sensitive data", async t => {
  let release;
  const { backend, session, writes } = await connection(t, {
    load: () => new Promise(resolve => { release = resolve; }),
  });
  const rejected = assert.rejects(backend.loadLspStartupState(session), /disconnected/);
  await nextTurn();
  backend.detach(session);
  await rejected;
  const late = Buffer.from("late-credential");
  release(late);
  await nextTurn();
  assert.deepEqual(late, Buffer.alloc(late.length));
  assert.deepEqual(writes, []);
});

test("ordinary submitted R code still uses TCP while state remains private", async t => {
  const { backend, session, writes, state } = await connection(t);
  state.capabilities.add("session-control");
  state.capabilities.add("top-level-submit");
  assert.equal(backend.sendSessionCommand(session, { type: "submit", code: "1 + 1" }), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].readUInt16LE(4), 12);
  await backend.saveLspStartupState(session, Buffer.from("sensitive"));
  assert.equal(writes.length, 1, "snapshot may not appear in ordinary backend frames");
  backend.close(session);
  await assert.rejects(backend.loadLspStartupState(session), /disconnected/);
});
