const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { RustSidecarRuntimeBackend } = require("../helpers/load-source.cjs")("src/Runtime/runtimeBackend.ts");

for (const protocolVersion of [undefined, 1, 2, 3, 5]) {
  test(`rejects incompatible saved protocol ${protocolVersion} before connecting`, () => {
    const backend = new RustSidecarRuntimeBackend("unused");
    assert.throws(() => backend.reconnect({
      sessionId: "old", port: 12345, authToken: "a".repeat(64), protocolVersion,
    }), /protocol version .* incompatible/);
  });

  test(`rejects incompatible bootstrap protocol ${protocolVersion} without waiting for timeout`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-protocol-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sessionFilePath = path.join(directory, "bootstrap.json");
    fs.writeFileSync(sessionFilePath, JSON.stringify({ port: 12345, pid: process.pid, protocolVersion }));
    const backend = new RustSidecarRuntimeBackend("unused");
    await assert.rejects(backend.resolveReconnectInfo({
      reconnectInfo: { sessionId: "old" }, sessionFilePath, authToken: "a".repeat(64),
    }), /protocol version .* incompatible/);
  });
}

function u32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; }
function string(value) { const bytes = Buffer.from(value); return Buffer.concat([u32(bytes.length), bytes]); }
function frame(kind, payload) {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(payload.length); header.writeUInt16LE(kind, 4);
  return Buffer.concat([header, payload]);
}

test("ephemeral sessions accept commands but never export reconnect credentials", async () => {
  const backend = new RustSidecarRuntimeBackend("unused");
  const session = backend.reconnect({ sessionId: "ephemeral", port: 12345,
    pid: process.pid, protocolVersion: 4, authToken: "a".repeat(64) });
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false, resume() {}, destroy() { this.destroyed = true; },
  });
  backend.connectSocketWithRetry = async () => socket;
  backend.attach(session, {});
  assert.equal(backend.getReconnectInfo(session), undefined, "wait for capability negotiation");
  await new Promise(resolve => setImmediate(resolve));
  const info = Buffer.concat([string("embedded-r-host"), u32(2), string("session-control"), string("ephemeral-session")]);
  socket.emit("data", Buffer.concat([frame(1, Buffer.concat([u32(4), info])), frame(2, info)]));
  assert.equal(backend.hasCapability(session, "ephemeral-session"), true);
  assert.equal(backend.canUseSessionCommands(session), true);
  assert.equal(backend.getReconnectInfo(session), undefined);
  backend.detach(session);
});

for (const protocolVersion of [1, 2, 3, 4, 5]) {
  test(`validates live protocol ${protocolVersion} before enabling session commands`, async () => {
    const backend = new RustSidecarRuntimeBackend("unused");
    const session = backend.reconnect({
      sessionId: "version-check", port: 12345, protocolVersion: 4, authToken: "a".repeat(64),
    });
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false, resume() {}, destroy() { this.destroyed = true; },
    });
    backend.connectSocketWithRetry = async () => socket;
    const errors = [];
    const controls = [];
    backend.attach(session, { onError: error => errors.push(error), onControl: event => controls.push(event) });
    await new Promise(resolve => setImmediate(resolve));
    const info = Buffer.concat([string("embedded-r-host"), u32(1), string("session-control")]);
    const greeting = Buffer.concat([frame(1, Buffer.concat([u32(protocolVersion), info])), frame(2, info)]);
    // The version frame can be split across network packets.
    socket.emit("data", greeting.subarray(0, 15));
    assert.equal(backend.canUseSessionCommands(session), false);
    socket.emit("data", greeting.subarray(15));
    assert.equal(backend.canUseSessionCommands(session), protocolVersion === 4);
    assert.equal(socket.destroyed, protocolVersion !== 4);
    assert.equal(errors.length, protocolVersion === 4 ? 0 : 1);
    assert.equal(controls.length, protocolVersion === 4 ? 2 : 0);
    backend.detach(session);
  });
}
