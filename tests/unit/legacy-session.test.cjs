const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { session } = require("../helpers/persistent-session.cjs");
const registryApi = loadSource("src/Runtime/persistentSessionRegistry.ts");

function u32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; }
function string(value) { const bytes = Buffer.from(value); return Buffer.concat([u32(bytes.length), bytes]); }
function frame(kind, payload) {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(payload.length); header.writeUInt16LE(kind, 4);
  return Buffer.concat([header, payload]);
}
function greeting(pid) {
  return Buffer.concat([
    frame(1, Buffer.concat([u32(1), string("embedded-r-host"), u32(1), string("shutdown")])),
    frame(20, Buffer.concat([u32(pid), Buffer.from([0, 1])])),
  ]);
}

function fixture(t, { platform = "win32", processName = "R_CONSOLE_HOST", reusedPid = false, environmentMatches = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-old-process-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entry = session({ legacy: true, pid: 4242 });
  const bootstrap = path.join(directory, `r-console-session-${entry.terminal.runtime.sessionId}.json`);
  const writeBootstrap = () => fs.writeFileSync(bootstrap, JSON.stringify({ pid: 4242, port: entry.terminal.runtime.port }));
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
    "./persistentSessionRegistry": { ...registryApi, isProcessAlive: () => alive },
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

test("modern or malformed authentication records cannot use old-session shutdown", async (t) => {
  const f = fixture(t);
  for (const token of ["a".repeat(64), "", null]) {
    f.entry.terminal.runtime.authToken = token;
    await assert.rejects(f.closeLegacySession(f.entry), /before authentication/);
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
