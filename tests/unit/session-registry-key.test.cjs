const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { readSessionRegistryKey, sessionRegistryKeyEndpoint } = loadSource("src/Runtime/sessionRegistryKey.ts");

async function broker(t, respond) {
  const identity = { sessionId: randomUUID(), pid: process.pid };
  const endpoint = sessionRegistryKeyEndpoint(identity);
  fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    let bytes = Buffer.alloc(0);
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length === 37) respond(socket, bytes);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  fs.chmodSync(endpoint, 0o600);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(endpoint, { force: true });
  });
  return { identity, endpoint };
}

function response(pid = process.pid, status = 0) {
  const bytes = Buffer.alloc(41, 42);
  bytes.write("RCK1");
  bytes.writeUInt32LE(pid, 4);
  bytes[8] = status;
  return bytes;
}

test("session identities cannot choose arbitrary local or network endpoints", () => {
  for (const sessionId of ["../outside", "\\\\host\\share", "/tmp/anything", "bad", "", undefined]) {
    assert.throws(() => sessionRegistryKeyEndpoint({ sessionId, pid: process.pid }));
  }
  for (const pid of [0, -1, NaN, 2 ** 32, "123"]) {
    assert.throws(() => sessionRegistryKeyEndpoint({ sessionId: randomUUID(), pid }));
  }
});

test("private key broker supports fragmented replies and migration requests", { skip: process.platform === "win32" }, async t => {
  const digest = "ab".repeat(32);
  const { identity } = await broker(t, (socket, request) => {
    assert.equal(request.subarray(0, 4).toString(), "RCK1");
    assert.equal(request[4], 1);
    assert.equal(request.subarray(5).toString("hex"), digest);
    socket.write(response().subarray(0, 5));
    setImmediate(() => socket.end(response().subarray(5)));
  });
  const key = await readSessionRegistryKey(identity, digest);
  assert.deepEqual(key, Buffer.alloc(32, 42));
  key.fill(0);
});

for (const kind of ["wrong PID", "oversized", "bad magic", "truncated", "rejected migration"]) {
  test(`key reader rejects ${kind}`, { skip: process.platform === "win32" }, async t => {
    const { identity } = await broker(t, socket => {
      const bytes = response(kind === "wrong PID" ? process.ppid : process.pid, kind === "rejected migration" ? 1 : 0);
      if (kind === "bad magic") bytes[0] = 0;
      socket.end(kind === "oversized" ? Buffer.concat([bytes, Buffer.alloc(1)]) : kind === "truncated" ? bytes.subarray(0, 15) : bytes);
    });
    await assert.rejects(readSessionRegistryKey(identity), kind === "rejected migration" ? { code: "PLAINTEXT_REJECTED" } : undefined);
  });
}

test("key reader rejects a socket readable by other users before connecting", { skip: process.platform === "win32" }, async t => {
  let connected = false;
  const { identity, endpoint } = await broker(t, () => { connected = true; });
  fs.chmodSync(endpoint, 0o666);
  await assert.rejects(readSessionRegistryKey(identity), /not private/);
  assert.equal(connected, false);
});

test("a stalled broker has a bounded request lifetime", { skip: process.platform === "win32" }, async t => {
  const { identity } = await broker(t, () => {});
  const start = Date.now();
  await assert.rejects(readSessionRegistryKey(identity), /timed out/);
  assert.ok(Date.now() - start < 5000);
});
