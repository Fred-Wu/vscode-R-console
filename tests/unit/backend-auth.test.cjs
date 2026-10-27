const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { authenticateBackendSocket, BackendAuthenticationError, BACKEND_AUTH_TIMEOUT_MS } =
  loadSource("src/Runtime/backendAuthentication.ts");

const token = "0123456789abcdef".repeat(4);

test("Rust and TypeScript use the same backend authentication deadline", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../sidecar/pty-host/src/protocol.rs"), "utf8");
  const matched = /^const BACKEND_AUTH_TIMEOUT: Duration = Duration::from_secs\((\d+)\);$/m.exec(source);
  assert.ok(matched, "Rust must declare the backend authentication deadline");
  assert.equal(BACKEND_AUTH_TIMEOUT_MS, Number(matched[1]) * 1000);
});
function frame(kind, payload) {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt16LE(kind, 4);
  return Buffer.concat([header, payload]);
}
function mac(context, serverNonce, clientNonce) {
  return createHmac("sha256", Buffer.from(token, "ascii"))
    .update(context).update(serverNonce).update(clientNonce).digest();
}
async function startServer(t, respond) {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    respond(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return server.address().port;
}
async function connect(port) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  return authenticateBackendSocket(socket, token, 400);
}

test("backend waits for valid server identity and preserves backlog after authentication", async (t) => {
  const nonce = Buffer.alloc(32, 7);
  const backlog = frame(8, Buffer.from([0, 65]));
  let observedProof;
  const port = await startServer(t, (socket) => {
    socket.write(frame(22, nonce));
    socket.on("data", (chunk) => {
      observedProof = chunk;
      assert.equal(chunk.readUInt16LE(4), 23);
      assert.equal(chunk.readUInt32LE(0), 64);
      const clientNonce = chunk.subarray(12, 44);
      assert.deepEqual(chunk.subarray(44, 76), mac("rconsole-backend-client-v2", nonce, clientNonce));
      socket.write(Buffer.concat([
        frame(24, mac("rconsole-backend-server-v2", nonce, clientNonce)),
        backlog,
      ]));
    });
  });
  const socket = await connect(port);
  assert.equal(observedProof.includes(Buffer.from(token)), false, "the reusable secret must stay private");
  const output = once(socket, "data");
  socket.resume();
  assert.deepEqual((await output)[0], backlog);
  socket.destroy();
});

test("fake backend cannot impersonate the R process by receiving the client proof", async (t) => {
  const nonce = Buffer.alloc(32, 8);
  const port = await startServer(t, (socket) => {
    socket.write(frame(22, nonce));
    socket.once("data", () => socket.end(frame(24, Buffer.alloc(32, 99))));
  });
  await assert.rejects(connect(port), BackendAuthenticationError);
});

test("malformed and replayed backend frames fail closed", async (t) => {
  const nonce = Buffer.alloc(32, 9);
  const staleServerProof = mac("rconsole-backend-server-v2", Buffer.alloc(32, 2), Buffer.alloc(32, 4));
  const port = await startServer(t, (socket) => {
    socket.write(frame(22, nonce));
    socket.once("data", () => socket.end(frame(24, staleServerProof)));
  });
  await assert.rejects(connect(port), /identity verification failed/);
});

test("incomplete server handshake is bounded by a timeout", async (t) => {
  const port = await startServer(t, () => {});
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await assert.rejects(authenticateBackendSocket(socket, token, 50), /timed out/);
});

test("transport closure is retryable but forged server identity is fatal", () => {
  assert.equal(new BackendAuthenticationError("disconnected", true).retryable, true);
  assert.equal(new BackendAuthenticationError("forged server proof").retryable, false);
});

test("runtime backend retries a transient closed handshake without trusting an invalid proof", async (t) => {
  const { RustSidecarRuntimeBackend } = loadSource("src/Runtime/runtimeBackend.ts");
  const backend = new RustSidecarRuntimeBackend("unused");
  const serverNonce = Buffer.alloc(32, 17);
  let connections = 0;
  const port = await startServer(t, (socket) => {
    connections++;
    if (connections === 1) {
      socket.destroy();
      return;
    }
    socket.write(frame(22, serverNonce));
    socket.once("data", (clientProof) => {
      const clientNonce = clientProof.subarray(12, 44);
      socket.write(frame(24, mac("rconsole-backend-server-v2", serverNonce, clientNonce)));
    });
  });
  const info = { sessionId: "transient", port, authToken: token };
  const state = { child: undefined, attachGeneration: 1, explicitClose: false, authToken: token };
  const socket = await backend.connectSocketWithRetry(state, info, 1);
  assert.ok(connections >= 2, "a prematurely closed socket must not permanently prevent reconnection");
  socket.destroy();
});
