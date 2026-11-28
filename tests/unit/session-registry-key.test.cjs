const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const os = require("node:os");
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

test("Unix key discovery uses the protected account location and ignores the public UID directory", { skip: process.platform === "win32" }, t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "key-home-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { sessionRegistryKeyEndpoint: endpoint } = loadSource("src/Runtime/sessionRegistryKey.ts", {
    os: { userInfo: () => ({ homedir: home }) },
    fs: { ...fs, lstatSync: file => {
      assert.ok(!String(file).startsWith("/tmp/r-console-keys-"));
      return fs.lstatSync(file);
    } },
  }, { "process.platform": '"linux"' });
  const identity = { sessionId: randomUUID(), pid: process.pid };
  assert.equal(endpoint(identity), path.join(home, ".r-console", identity.sessionId.replace(/-/g, "")));
  fs.chmodSync(home, 0o777);
  assert.throws(() => endpoint(identity), /not protected/);
  assert.equal(fs.statSync(home).mode & 0o777, 0o777, "never repair an untrusted parent's permissions");
});

test("Unix key discovery rejects a foreign-owned account location", { skip: process.platform === "win32" }, () => {
  const home = fs.realpathSync.native(os.userInfo().homedir);
  const { sessionRegistryKeyEndpoint: endpoint } = loadSource("src/Runtime/sessionRegistryKey.ts", {
    os: { userInfo: () => ({ homedir: home }) },
    fs: { ...fs, lstatSync: file => {
      const stat = fs.lstatSync(file);
      return file === home ? Object.assign(Object.create(stat), { uid: process.getuid() + 1, mode: 0o40700 }) : stat;
    } },
  }, { "process.platform": '"linux"' });
  assert.throws(() => endpoint({ sessionId: randomUUID(), pid: process.pid }), /not protected/);
});

test("Windows key reads require the native verifier and clear rejected output", async () => {
  const identity = { sessionId: randomUUID(), pid: process.pid };
  let fail = false, output;
  const calls = [];
  const { readSessionRegistryKey: read } = loadSource("src/Runtime/sessionRegistryKey.ts", {
    child_process: { execFile: (file, args, options, callback) => {
      calls.push({ file, args, options });
      output = Buffer.alloc(32, 42);
      callback(fail ? new Error("wrong server identity") : null, output, Buffer.alloc(0));
    } },
    net: { createConnection: () => { throw new Error("must not accept an unverified pipe response"); } },
  }, { "process.platform": '"win32"' });
  await assert.rejects(read(identity), /verification is unavailable/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await read(identity, "/packaged/R_CONSOLE_HOST.exe"), Buffer.alloc(32, 42));
  assert.deepEqual(calls[0].args, ["--read-session-key", identity.sessionId, String(identity.pid)]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.ok(calls[0].options.timeout <= 4000);
  fail = true;
  await assert.rejects(read(identity, "/packaged/R_CONSOLE_HOST.exe"), /authenticated/);
  assert.deepEqual(output, Buffer.alloc(32));
});

test("private key broker supports fragmented replies without migration requests", { skip: process.platform === "win32" }, async t => {
  const { identity } = await broker(t, (socket, request) => {
    assert.equal(request.subarray(0, 4).toString(), "RCK1");
    assert.deepEqual(request.subarray(4), Buffer.alloc(33));
    socket.write(response().subarray(0, 5));
    setImmediate(() => socket.end(response().subarray(5)));
  });
  const key = await readSessionRegistryKey(identity);
  assert.deepEqual(key, Buffer.alloc(32, 42));
  key.fill(0);
});

for (const kind of ["wrong PID", "oversized", "bad magic", "truncated", "nonzero status"]) {
  test(`key reader rejects ${kind}`, { skip: process.platform === "win32" }, async t => {
    const { identity } = await broker(t, socket => {
      const bytes = response(kind === "wrong PID" ? process.ppid : process.pid, kind === "nonzero status" ? 1 : 0);
      if (kind === "bad magic") bytes[0] = 0;
      socket.end(kind === "oversized" ? Buffer.concat([bytes, Buffer.alloc(1)]) : kind === "truncated" ? bytes.subarray(0, 15) : bytes);
    });
    await assert.rejects(readSessionRegistryKey(identity));
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
