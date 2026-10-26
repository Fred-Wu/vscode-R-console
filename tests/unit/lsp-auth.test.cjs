const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { authenticateLspSocket } = loadSource("src/Language/lspSocketAuth.ts");

test("LSP listener rejects unauthenticated peers and handles fragmented credentials", async (t) => {
  const token = "a".repeat(64);
  const accepted = [];
  const server = net.createServer((socket) => {
    void authenticateLspSocket(socket, token, 100).then((ok) => {
      accepted.push(ok);
      if (ok) {
        socket.on("error", () => {});
        socket.destroy();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = server.address().port;
  const send = async (payloads) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.on("error", () => {});
    await once(socket, "connect");
    for (const payload of payloads) socket.write(payload);
    await once(socket, "close");
  };
  await send([Buffer.from("Content-Length: 4\r\n\r\ntest")]);
  await send([Buffer.from("b".repeat(64))]);
  await send([Buffer.from(token.slice(0, 17)), Buffer.from(token.slice(17))]);
  assert.deepEqual(accepted, [false, false, true]);
});

test("LSP authentication preserves early protocol bytes after the token", async (t) => {
  const token = "f".repeat(64);
  const payload = Buffer.from("Content-Length: 2\r\n\r\n{}");
  const server = net.createServer(async (socket) => {
    assert.equal(await authenticateLspSocket(socket, token, 100), true);
    socket.once("data", (chunk) => {
      assert.deepEqual(chunk, payload);
      socket.destroy();
    });
    socket.resume();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const socket = net.createConnection({ host: "127.0.0.1", port: server.address().port });
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.end(Buffer.concat([Buffer.from(token), payload]));
  await once(socket, "close");
});
