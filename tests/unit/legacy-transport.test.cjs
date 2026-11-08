const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

async function requestFrom(t, respond) {
  const server = http.createServer((req, res) => {
    req.resume();
    respond(res, req);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { SessionWatcher } = loadSource("src/Runtime/VSCR/legacy/sessionWatcher.ts");
  const watcher = new SessionWatcher("unused");
  watcher.server = { host: "127.0.0.1", port: server.address().port, token: "test-token" };
  // A separate guard makes a regression fail instead of leaving the test pending.
  let guard;
  t.after(() => clearTimeout(guard));
  return Promise.race([
    watcher.postToSessionServer({ command: "workspace" }),
    new Promise((resolve) => { guard = setTimeout(() => resolve("still pending"), 3500); }),
  ]);
}

test("legacy HTTP returns a complete authenticated JSON response", async (t) => {
  assert.deepEqual(await requestFrom(t, (res, req) => {
    assert.equal(req.headers.authorization, "test-token");
    res.end(JSON.stringify({ result: ["café", "😀"] }));
  }), { result: ["café", "😀"] });
});

test("legacy HTTP preserves connection reuse after successful requests", async (t) => {
  const connections = new Set();
  const server = http.createServer((req, res) => {
    connections.add(req.socket);
    req.resume();
    res.end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => {
    agent.destroy();
    server.closeAllConnections();
    server.close();
  });
  const { SessionWatcher } = loadSource("src/Runtime/VSCR/legacy/sessionWatcher.ts", {
    http: { ...http, request: (options, callback) => http.request({ ...options, agent }, callback) },
  });
  const watcher = new SessionWatcher("unused");
  watcher.server = { host: "127.0.0.1", port: server.address().port, token: "test-token" };
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(await watcher.postToSessionServer({ type: "workspace" }), { ok: true });
  }
  assert.equal(connections.size, 1);
});

test("legacy HTTP settles when a response is truncated", async (t) => {
  assert.equal(await requestFrom(t, (res) => {
    res.writeHead(200, { "Content-Length": 100 });
    res.write("{");
    const timer = setTimeout(() => res.destroy(), 30);
    t.after(() => clearTimeout(timer));
  }), undefined);
});

test("legacy HTTP accepts a progressing response that takes longer than the inactivity timeout", async (t) => {
  assert.deepEqual(await requestFrom(t, (res) => {
    res.write("[");
    const timer = setInterval(() => res.write(" "), 100);
    const finish = setTimeout(() => {
      clearInterval(timer);
      res.end('"complete"]');
    }, 1800);
    res.on("close", () => clearInterval(timer));
    t.after(() => {
      clearInterval(timer);
      clearTimeout(finish);
    });
  }), ["complete"]);
});

test("legacy HTTP still ends a response that stops making progress", async (t) => {
  assert.equal(await requestFrom(t, (res) => {
    res.write("[");
  }), undefined);
});

test("legacy HTTP rejects oversized responses", async (t) => {
  assert.equal(await requestFrom(t, (res) => {
    res.end(`"${"x".repeat(16 * 1024 * 1024)}"`);
  }), undefined);
});
