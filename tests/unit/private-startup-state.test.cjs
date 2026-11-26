const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { sessionRegistryKeyEndpoint } = loadSource("src/Runtime/sessionRegistryKey.ts");
const { loadPrivateStartupState, savePrivateStartupState, MAX_PRIVATE_STARTUP_STATE_BYTES } =
  loadSource("src/Runtime/privateStartupState.ts");

async function broker(t, answer) {
  const identity = { sessionId: randomUUID(), pid: process.pid };
  const endpoint = sessionRegistryKeyEndpoint(identity);
  fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  const connections = new Set();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => connections.delete(socket));
    const chunks = [];
    let size = 0;
    socket.on("data", chunk => {
      chunks.push(chunk);
      size += chunk.length;
      if (size < 37) return;
      const data = Buffer.concat(chunks, size);
      const command = data.subarray(0, 4).toString("ascii");
      const expected = command === "RCSP" ? data.readUInt32LE(4) : 0;
      if (size === 37 + expected) answer(socket, command, data.subarray(37), identity);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });
  });
  return identity;
}

function response(socket, pid, state = Buffer.alloc(0)) {
  const header = Buffer.alloc(12);
  header.write("RCSR");
  header.writeUInt32LE(pid, 4);
  header.writeUInt32LE(state.length, 8);
  socket.write(header.subarray(0, 7));
  setImmediate(() => socket.end(Buffer.concat([header.subarray(7), state])));
}

test("private startup snapshot round-trips across fragmented OS-only responses", { skip: process.platform === "win32" }, async t => {
  const state = Buffer.from("synthetic-credential\0\xff", "latin1");
  let stored;
  const identity = await broker(t, (socket, command, data, owner) => {
    if (command === "RCSG") response(socket, owner.pid, stored ?? Buffer.alloc(0));
    else {
      const accepted = !stored || stored.equals(data);
      if (accepted) stored = Buffer.from(data);
      response(socket, owner.pid, Buffer.from([accepted ? 0 : 1]));
    }
  });
  assert.equal(await loadPrivateStartupState(identity), undefined);
  await savePrivateStartupState(identity, state);
  await savePrivateStartupState(identity, state);
  const fetched = await loadPrivateStartupState(identity);
  assert.deepEqual(fetched, state);
  fetched.fill(0);
  await assert.rejects(savePrivateStartupState(identity, Buffer.from("wrong")), /different startup snapshot/);
});

test("private broker response is bound to expected runtime PID", { skip: process.platform === "win32" }, async t => {
  const identity = await broker(t, (socket, _command, _data, owner) =>
    response(socket, owner.pid + 1, Buffer.from("credential")));
  await assert.rejects(loadPrivateStartupState(identity), /different runtime/);
});

test("private startup transport rejects malformed size and oversized writes", async () => {
  const identity = { sessionId: randomUUID(), pid: process.pid };
  await assert.rejects(savePrivateStartupState(identity, Buffer.alloc(0)), /size/);
  await assert.rejects(savePrivateStartupState(identity, Buffer.alloc(MAX_PRIVATE_STARTUP_STATE_BYTES + 1)), /size/);
  await assert.rejects(loadPrivateStartupState({ ...identity, sessionId: "../elsewhere" }), /identity/);
});

test("backend TCP startup-state commands are no longer accepted", () => {
  const { parseBackendFrames, encodeLspStartupStateFrame } = loadSource("src/Runtime/backendProtocol.ts");
  assert.equal(encodeLspStartupStateFrame, undefined);
  for (const kind of [27, 28, 29, 30]) {
    const packet = Buffer.alloc(12);
    packet.writeUInt16LE(kind, 4);
    assert.match(parseBackendFrames(packet).error, /Unknown backend frame/);
  }
});
