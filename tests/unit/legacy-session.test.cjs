const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { createHmac } = require("node:crypto");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { session } = require("../helpers/persistent-session.cjs");

function u32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; }
function string(value) { const bytes = Buffer.from(value); return Buffer.concat([u32(bytes.length), bytes]); }
function frame(kind, payload) {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(payload.length); header.writeUInt16LE(kind, 4);
  return Buffer.concat([header, payload]);
}
function greeting(pid, protocolVersion = 1) {
  return Buffer.concat([
    frame(1, Buffer.concat([u32(protocolVersion), string("embedded-r-host"), u32(1), string("shutdown")])),
    frame(20, Buffer.concat([u32(pid), Buffer.from([0, 1])])),
  ]);
}

function fixture(t, { platform = "win32", processName = "R_CONSOLE_HOST", reusedPid = false, environmentMatches = true, currentVersion = 2, protocolVersion } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-old-process-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entry = session({ legacy: protocolVersion === undefined || protocolVersion === 1, pid: 4242,
    ...(protocolVersion !== undefined && { protocolVersion }) });
  const registry = loadSource("src/Runtime/persistentSessionRegistry.ts", {
    "./backendProtocol": { BACKEND_PROTOCOL_VERSION: currentVersion },
  });
  const bootstrap = path.join(directory, `r-console-session-${entry.terminal.runtime.sessionId}.json`);
  const writeBootstrap = () => fs.writeFileSync(bootstrap, JSON.stringify({ pid: 4242, port: entry.terminal.runtime.port, protocolVersion }));
  writeBootstrap();
  let alive = true;
  const expectedEnvironment = `VSC_R_BACKEND_SESSION_FILE=${environmentMatches ? bootstrap : "/different-session.json"}`;
  const api = loadSource("src/Runtime/legacySession.ts", {
    os: { tmpdir: () => directory },
    fs: { ...fs, promises: { ...fs.promises,
      readlink: async () => `/bin/${processName}`,
      readFile: async (file, encoding) => file === "/proc/4242/environ" ? expectedEnvironment + "\0" : fs.promises.readFile(file, encoding),
    } },
    child_process: { execFile: (_file, args, options, callback) => {
      if (platform === "win32") {
        assert.equal(options.windowsHide, true);
        callback(null, { stdout: JSON.stringify({ name: processName, startedMs: reusedPid ? Date.now() + 10000 : 1 }) });
      } else {
        callback(null, { stdout: args.includes("comm=") ? `/bin/${processName}\n` : `${processName} ${expectedEnvironment}\n` });
      }
    } },
    "./persistentSessionRegistry": { ...registry, isProcessAlive: () => alive },
  }, { "process.platform": JSON.stringify(platform) });
  return { ...api, entry, bootstrap, writeBootstrap, stop: () => { alive = false; } };
}

for (const platform of ["win32", "linux", "darwin"]) {
  test(`checks the old backend's process identity (${platform})`, async (t) => {
    const f = fixture(t, { platform });
    assert.equal((await f.inspectLegacySession(f.entry)).state, "verified");
  });
}

for (const options of [
  { processName: "unrelated-app" }, { reusedPid: true },
  { platform: "linux", environmentMatches: false }, { platform: "darwin", environmentMatches: false },
]) {
  test(`refuses a reused PID or different process/session: ${JSON.stringify(options)}`, async (t) => {
    const f = fixture(t, options);
    assert.equal((await f.inspectLegacySession(f.entry)).state, "unverified");
    await assert.rejects(f.closeLegacySession(f.entry));
  });
}

test("missing or mismatched bootstrap information never triggers shutdown", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.bootstrap, JSON.stringify({ pid: 4242, port: 54321 }));
  assert.equal((await f.inspectLegacySession(f.entry)).state, "unverified");
  await assert.rejects(f.closeLegacySession(f.entry));
  fs.rmSync(f.bootstrap);
  assert.equal((await f.inspectLegacySession(f.entry)).state, "unverified");
  f.stop();
  assert.equal((await f.inspectLegacySession(f.entry)).state, "stopped");
  await f.closeLegacySession(f.entry);
});

test("unversioned authentication records cannot use protocol 1 shutdown", async (t) => {
  const f = fixture(t);
  for (const token of ["a".repeat(64), "", null]) {
    f.entry.terminal.runtime.authToken = token;
    await assert.rejects(f.closeLegacySession(f.entry), /older protocol version/);
  }
});

async function endpoint(t, f, bytes, resetOnShutdown = false) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("data", (data) => {
      received.push(data);
      f.stop();
      if (resetOnShutdown) socket.resetAndDestroy(); else socket.end();
    });
    // Exercise the same fragmented framing as a real backend.
    socket.write(bytes.subarray(0, 7));
    setImmediate(() => socket.write(bytes.subarray(7)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  f.entry.terminal.runtime.port = server.address().port;
  f.writeBootstrap();
  return received;
}

test("confirmed cleanup sends only shutdown to the matching old backend", async (t) => {
  const f = fixture(t);
  const received = await endpoint(t, f, greeting(4242));
  await f.closeLegacySession(f.entry);
  assert.deepEqual(Buffer.concat(received), frame(17, Buffer.alloc(0)));
});

test("a Windows-style connection reset after shutdown succeeds only once the process exits", async (t) => {
  const f = fixture(t);
  const received = await endpoint(t, f, greeting(4242), true);
  await f.closeLegacySession(f.entry);
  assert.deepEqual(Buffer.concat(received), frame(17, Buffer.alloc(0)));
});

for (const [name, bytes] of [
  ["different backend PID", greeting(4243)],
  ["modern authentication challenge", frame(22, Buffer.alloc(32))],
  ["different protocol version", greeting(4242, 2)],
]) {
  test(`does not send shutdown after ${name}`, async (t) => {
    const f = fixture(t);
    const received = await endpoint(t, f, bytes);
    await assert.rejects(f.closeLegacySession(f.entry));
    assert.deepEqual(received, []);
  });
}

test("process identity is rechecked after confirmation, before connecting", async (t) => {
  const f = fixture(t);
  assert.equal((await f.inspectLegacySession(f.entry)).state, "verified");
  fs.writeFileSync(f.bootstrap, JSON.stringify({ pid: 9999, port: 12345 }));
  await assert.rejects(f.closeLegacySession(f.entry), /no longer matches/);
});

async function authenticatedEndpoint(t, f, { forgedProof = false, liveVersion = f.entry.terminal.runtime.protocolVersion, livePid = 4242 } = {}) {
  const commands = [];
  const sockets = new Set();
  const token = f.entry.terminal.runtime.authToken;
  const nonce = Buffer.alloc(32, 17);
  const mac = (context, clientNonce) => createHmac("sha256", Buffer.from(token, "ascii"))
    .update(context).update(nonce).update(clientNonce).digest();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    let carry = Buffer.alloc(0);
    let authenticated = false;
    socket.on("data", chunk => {
      if (authenticated) {
        commands.push(chunk);
        f.stop();
        socket.end();
        return;
      }
      carry = Buffer.concat([carry, chunk]);
      if (carry.length < 76) return;
      assert.equal(carry.readUInt16LE(4), 23);
      const clientNonce = carry.subarray(12, 44);
      assert.deepEqual(carry.subarray(44, 76), mac("rconsole-backend-client-v2", clientNonce));
      assert.equal(carry.length, 76, "no shutdown may be sent before server authentication");
      authenticated = true;
      socket.write(Buffer.concat([
        frame(24, forgedProof ? Buffer.alloc(32, 99) : mac("rconsole-backend-server-v2", clientNonce)),
        greeting(livePid, liveVersion),
      ]));
    });
    socket.write(frame(22, nonce));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  f.entry.terminal.runtime.port = server.address().port;
  f.writeBootstrap();
  return commands;
}

for (const platform of ["win32", "linux", "darwin"]) {
  test(`protocol 2 to 3 cleanup authenticates then shuts down (${platform})`, async t => {
    const f = fixture(t, { platform, protocolVersion: 2, currentVersion: 3 });
    const commands = await authenticatedEndpoint(t, f);
    await f.closeLegacySession(f.entry);
    assert.deepEqual(Buffer.concat(commands), frame(17, Buffer.alloc(0)));
  });
}

test("later protocol upgrades use the same authenticated cleanup flow", async t => {
  const f = fixture(t, { protocolVersion: 3, currentVersion: 4 });
  const commands = await authenticatedEndpoint(t, f);
  await f.closeLegacySession(f.entry);
  assert.deepEqual(Buffer.concat(commands), frame(17, Buffer.alloc(0)));
});

for (const options of [{ forgedProof: true }, { liveVersion: 1 }, { livePid: 4243 }]) {
  test(`authenticated cleanup rejects mismatched identity: ${JSON.stringify(options)}`, async t => {
    const f = fixture(t, { protocolVersion: 2, currentVersion: 3 });
    const commands = await authenticatedEndpoint(t, f, options);
    await assert.rejects(f.closeLegacySession(f.entry));
    assert.deepEqual(commands, []);
  });
}

test("an authenticated old session never falls back to unauthenticated shutdown", async t => {
  const f = fixture(t, { protocolVersion: 2, currentVersion: 3 });
  const received = await endpoint(t, f, greeting(4242));
  await assert.rejects(f.closeLegacySession(f.entry));
  assert.deepEqual(received, []);
});
