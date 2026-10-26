const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { authenticateLspSocket } = loadSource("src/Language/lspSocketAuth.ts");
const { BACKEND_AUTH_TIMEOUT_MS } = loadSource("src/Runtime/backendAuthentication.ts");

const token = "a".repeat(64);

test("LSP handshake uses the backend authentication deadline, not the R startup deadline", () => {
  assert.equal(BACKEND_AUTH_TIMEOUT_MS, 3000);
  const authSource = fs.readFileSync(path.join(__dirname, "../../src/Language/lspSocketAuth.ts"), "utf8");
  const clientSource = fs.readFileSync(path.join(__dirname, "../../src/Language/consoleLspClient.ts"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../../resources/r/console-language-server.R"), "utf8");
  assert.match(authSource, /timeoutMs = BACKEND_AUTH_TIMEOUT_MS/);
  assert.match(clientSource, /authenticateLspSocket\(socket, authToken, BACKEND_AUTH_TIMEOUT_MS, clientNonce\)/);
  assert.match(clientSource, /VSCR_LSP_AUTH_TIMEOUT_SECONDS: String\(BACKEND_AUTH_TIMEOUT_MS \/ 1_000\)/);
  assert.match(script, /Sys.getenv\("VSCR_LSP_AUTH_TIMEOUT_SECONDS"\)/);
  assert.match(script, /socketTimeout\(server\$inputcon, auth_timeout\)/);
  assert.match(script, /socketSelect\(list\(server\$inputcon\), timeout = remaining\)/);
  assert.match(script, /readBin\(server\$inputcon, "raw", n = count - length\(received\)\)/);
  assert.match(script, /socketTimeout\(server\$inputcon, previous_socket_timeout\)/);
});

test("LSP handshake rejects an idle peer when its deadline expires", async (t) => {
  let result;
  const server = net.createServer((socket) => {
    void authenticateLspSocket(socket, token, 80).then((accepted) => { result = accepted; });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const peer = net.createConnection({ host: "127.0.0.1", port: server.address().port });
  peer.on("error", () => {});
  await once(peer, "close");
  assert.equal(result, false);
});
function mac(key, context, clientNonce, serverNonce) {
  return createHmac("sha256", Buffer.from(key, "ascii"))
    .update(Buffer.from(context, "ascii")).update(clientNonce).update(serverNonce).digest();
}

async function checkHandshake(t, options = {}) {
  const clientNonce = Buffer.alloc(32, 6);
  const authenticated = [];
  const receivedAfter = [];
  const peerErrors = [];
  const server = net.createServer((socket) => {
    void authenticateLspSocket(socket, token, 500, clientNonce.toString("hex")).then((ok) => {
      authenticated.push(ok);
      if (ok) {
        socket.on("data", (data) => receivedAfter.push(data));
        socket.resume();
        setTimeout(() => socket.destroy(), 20);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const peer = net.createConnection({ host: "127.0.0.1", port: server.address().port });
  peer.on("error", (error) => peerErrors.push(error.message));
  let buffer = Buffer.alloc(0);
  await once(peer, "connect");
  const clientKey = options.wrongKey ? "b".repeat(64) : token;
  peer.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 64) return;
    const reply = buffer.subarray(0, 64);
    const serverNonce = reply.subarray(0, 32);
    const expected = mac(token, "rconsole-lsp-server-v2", clientNonce, serverNonce);
    assert.deepEqual(reply.subarray(32), expected, "the VS Code server must prove the secret");
    const proof = mac(clientKey, "rconsole-lsp-client-v2", clientNonce, serverNonce);
    const additional = options.extra ? Buffer.from("Content-Length: 2\r\n\r\n{}") : Buffer.alloc(0);
    peer.write(Buffer.concat([proof, additional]));
    buffer = Buffer.alloc(0);
    if (options.extra) setTimeout(() => peer.end(), 40);
  });
  if (options.fragmented) {
    peer.write(clientNonce.subarray(0, 13));
    peer.write(clientNonce.subarray(13));
  } else {
    peer.write(clientNonce);
  }
  await once(peer, "close");
  assert.equal(authenticated.length, 1);
  assert.equal(authenticated[0], !options.wrongKey);
  if (options.extra) assert.equal(Buffer.concat(receivedAfter).toString(), "Content-Length: 2\r\n\r\n{}");
  assert.deepEqual(peerErrors, []);
}

test("language server mutually authenticates fragmented R nonce and preserves early LSP bytes", async (t) => {
  await checkHandshake(t, { fragmented: true, extra: true });
});

test("language server rejects an R peer with a wrong secret", async (t) => {
  await checkHandshake(t, { wrongKey: true });
});

test("language server rejects unauthenticated connections without leaking token", async (t) => {
  const results = [];
  const server = net.createServer((socket) => {
    void authenticateLspSocket(socket, token, 100).then((ok) => results.push(ok));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const socket = net.createConnection({ host: "127.0.0.1", port: server.address().port });
  socket.on("error", () => {});
  socket.resume(); // Drain the server challenge even when the peer is deliberately invalid.
  await once(socket, "connect");
  socket.end(Buffer.from("old plaintext secret or incorrect handshake"));
  await once(socket, "close");
  assert.deepEqual(results, [false]);
});

test("language server rejects a process with a different startup nonce", async (t) => {
  const expectedNonce = Buffer.alloc(32, 4);
  const accepted = [];
  const server = net.createServer((socket) => {
    void authenticateLspSocket(socket, token, 500, expectedNonce.toString("hex"))
      .then((ok) => accepted.push(ok));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const peer = net.createConnection({ host: "127.0.0.1", port: server.address().port });
  peer.on("error", () => {});
  peer.resume();
  await once(peer, "connect");
  peer.end(Buffer.alloc(32, 9));
  await once(peer, "close");
  assert.deepEqual(accepted, [false]);
});
