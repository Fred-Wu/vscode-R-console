const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const loadSource = require("./helpers/load-source.cjs");
const { authenticateLspSocket } = loadSource("src/Language/lspSocketAuth.ts");
const { BACKEND_AUTH_TIMEOUT_MS } = loadSource("src/Runtime/backendAuthentication.ts");

function lspConnection(socket) {
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  const pending = new Map();
  const fail = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) break;
      const headers = buffer.subarray(0, end).toString("ascii");
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(headers);
      if (!match) {
        fail(new Error("Invalid LSP headers: " + headers));
        socket.destroy();
        return;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length > 8 * 1024 * 1024) {
        fail(new Error("Invalid LSP message length"));
        socket.destroy();
        return;
      }
      if (buffer.length < end + 4 + length) break;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
      buffer = buffer.subarray(end + 4 + length);
      if (message.id === undefined) continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Language-server socket closed before LSP response")));

  function send(message) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    socket.write(Buffer.concat([
      Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "ascii"), body,
    ]));
  }

  return {
    notify(method, params) { send({ method, params }); },
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Timed out waiting for LSP response: " + method));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    },
  };
}

test("real console languageserver authenticates, initializes and completes code", { timeout: 90000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-lsp-integration-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "completion.R");
  fs.writeFileSync(file, "stats::l\n");
  const workspaceUri = pathToFileURL(directory + path.sep).href;
  const uri = pathToFileURL(file).href;

  const token = randomBytes(32).toString("hex");
  const nonce = randomBytes(32).toString("hex");
  const server = net.createServer();
  const sockets = new Set();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });

  let accept;
  let rejectConnection;
  const connected = new Promise((resolve, reject) => {
    accept = resolve;
    rejectConnection = reject;
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    void authenticateLspSocket(socket, token, BACKEND_AUTH_TIMEOUT_MS, nonce)
      .then((ok) => {
        if (!ok) throw new Error("Production R language-server authentication failed");
        const lsp = lspConnection(socket);
        socket.resume();
        accept(lsp);
      }).catch(rejectConnection);
  });

  const script = path.resolve(__dirname, "../resources/r/console-language-server.R");
  const child = spawn("Rscript", ["--vanilla", script], {
    cwd: directory,
    env: {
      ...process.env,
      VSCR_LSP_HOST: "127.0.0.1",
      VSCR_LSP_PORT: String(server.address().port),
      VSCR_LSP_AUTH_TOKEN: token,
      VSCR_LSP_CLIENT_NONCE: nonce,
      VSCR_LSP_AUTH_TIMEOUT_SECONDS: String(BACKEND_AUTH_TIMEOUT_MS / 1000),
      VSCR_USE_RENV_LIB_PATH: "FALSE",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-12000); });
  const childFailed = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error("R languageserver exited before completing LSP test (" +
        (signal || code) + "):\n" + stderr));
    });
  });

  const lsp = await Promise.race([connected, childFailed]);
  const initialized = await lsp.request("initialize", {
    processId: process.pid,
    clientInfo: { name: "r-console-lsp-integration-test" },
    rootUri: workspaceUri,
    rootPath: directory,
    workspaceFolders: [{ uri: workspaceUri, name: "test-workspace" }],
    capabilities: {
      workspace: { workspaceFolders: true },
      textDocument: { completion: { completionItem: { snippetSupport: true } } },
    },
    trace: "off",
  });
  assert.ok(initialized && initialized.capabilities, "the real LSP initialize request must succeed");
  lsp.notify("initialized", {});
  const synced = await lsp.request("rConsole/syncSessionState", {
    attachedPackages: ["stats"],
    libraryPaths: [],
  });
  assert.equal(synced, true, "console-specific session synchronization must work");

  lsp.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "r", version: 1, text: "stats::l\n" },
  });
  const completions = await lsp.request("textDocument/completion", {
    textDocument: { uri },
    position: { line: 0, character: 8 },
    context: { triggerKind: 1 },
  });
  const items = Array.isArray(completions) ? completions : completions?.items;
  assert.ok(Array.isArray(items) && items.some((item) => /(?:^|::)lm$/.test(item.label)),
    "the real language server must return stats::lm completion; got: " +
    JSON.stringify(items?.slice(0, 12)));

  await lsp.request("shutdown", null); // R languageserver may serialize a void response as [].
  lsp.notify("exit", null);
});
