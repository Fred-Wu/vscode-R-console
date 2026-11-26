const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { RustSidecarRuntimeBackend } = loadSource("src/Runtime/runtimeBackend.ts");
const { MAX_BACKEND_FRAME_BYTES, encodeLspStartupStateFrame, parseBackendFrames } = loadSource("src/Runtime/backendProtocol.ts");

function frame(kind, id, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(payload.length); header.writeUInt16LE(kind, 4); header.writeUInt32LE(id, 8);
  return Buffer.concat([header, payload]);
}

async function connection(t, supported = true) {
  const backend = new RustSidecarRuntimeBackend("unused");
  const session = backend.reconnect({ sessionId: "test", port: 12345, protocolVersion: 4, authToken: "a".repeat(64) });
  const writes = [], visible = [];
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false, resume() {}, destroy() { this.destroyed = true; },
    write(bytes) { writes.push(bytes); },
  });
  backend.connectSocketWithRetry = async () => socket;
  backend.attach(session, { onControl: value => visible.push(value), onError() {} });
  await nextTurn();
  const state = backend.getOrCreateState(session);
  state.hostConnected = true;
  if (supported) state.capabilities.add("lsp-startup-state-v1");
  t.after(() => backend.detach(session));
  return { backend, session, socket, writes, visible, state };
}

test("private snapshot responses are correlated, fragmented and hidden from terminal handlers", async t => {
  const { backend, session, socket, writes, visible } = await connection(t);
  const load = backend.loadLspStartupState(session);
  await nextTurn();
  assert.equal(writes[0].readUInt16LE(4), 27);
  assert.equal(writes[0].readUInt32LE(12), 1);
  const response = frame(29, writes[0].readUInt32LE(8), Buffer.from("synthetic-secret"));
  socket.emit("data", response.subarray(0, 14));
  socket.emit("data", response.subarray(14));
  assert.equal((await load).toString(), "synthetic-secret");
  assert.deepEqual(visible, []);
  const store = backend.saveLspStartupState(session, Buffer.from("synthetic-secret"));
  await nextTurn();
  assert.equal(writes[1].readUInt16LE(4), 28);
  socket.emit("data", frame(30, writes[1].readUInt32LE(8), Buffer.from([0])));
  await store;
  assert.deepEqual(visible, []);
});

test("a confirmed empty store is distinct from failed retrieval or an unsupported runtime", async t => {
  const { backend, session, socket, writes } = await connection(t);
  const load = backend.loadLspStartupState(session);
  await nextTurn();
  socket.emit("data", frame(29, writes[0].readUInt32LE(8)));
  assert.equal(await load, undefined);
  const pending = backend.loadLspStartupState(session);
  const rejected = assert.rejects(pending, /disconnected/);
  await nextTurn();
  backend.detach(session);
  await rejected;
  const old = await connection(t, false);
  await assert.rejects(old.backend.loadLspStartupState(old.session), /Close the old R session/);
  assert.equal(old.writes.length, 0);
});

test("conflicting writes and malformed acknowledgements cannot declare a snapshot saved", async t => {
  const { backend, session, socket, writes } = await connection(t);
  const storing = backend.saveLspStartupState(session, Buffer.from("secret"));
  const rejected = assert.rejects(storing, /different startup snapshot/);
  await nextTurn();
  socket.emit("data", frame(30, writes[0].readUInt32LE(8), Buffer.from([1])));
  await rejected;
  assert.match(parseBackendFrames(frame(30, 3, Buffer.from([2]))).error, /acknowledgement/);
  const exact = encodeLspStartupStateFrame(9, Buffer.alloc(MAX_BACKEND_FRAME_BYTES, 42));
  assert.equal(exact.readUInt32LE(), MAX_BACKEND_FRAME_BYTES);
  assert.throws(() => encodeLspStartupStateFrame(9, Buffer.alloc(MAX_BACKEND_FRAME_BYTES + 1)), /frame limit/);
  assert.throws(() => encodeLspStartupStateFrame(9, Buffer.alloc(0)), /Empty/);
});

test("interactive submissions preserve snapshot transfers and closure rejects them", async t => {
  const { backend, session, socket, writes, state } = await connection(t);
  state.capabilities.add("session-control");
  state.capabilities.add("top-level-submit");
  const storing = backend.saveLspStartupState(session, Buffer.from("secret"));
  assert.equal(backend.sendSessionCommand(session, { type: "submit", code: "1 + 1" }), true);
  socket.emit("data", frame(30, writes[0].readUInt32LE(8), Buffer.from([0])));
  await storing;
  const rejected = assert.rejects(backend.loadLspStartupState(session), /disconnected/);
  socket.end = () => {};
  backend.close(session);
  await rejected;
  const count = writes.length;
  await assert.rejects(backend.saveLspStartupState(session, Buffer.from("secret")), /disconnected/);
  assert.equal(writes.length, count);
});

test("a replaced attachment rejects pending retrieval instead of accepting a late response", async t => {
  const { backend, session, socket, writes } = await connection(t);
  const rejected = assert.rejects(backend.loadLspStartupState(session), /disconnected/);
  backend.attach(session, {});
  socket.emit("data", frame(29, writes[0].readUInt32LE(8), Buffer.from("late-secret")));
  await rejected;
});
