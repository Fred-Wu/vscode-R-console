const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("./helpers/load-source.cjs");
const { authenticateLspSocket } = loadSource("src/Language/lspSocketAuth.ts");
const { BACKEND_AUTH_TIMEOUT_MS } = loadSource("src/Runtime/backendAuthentication.ts");
const entryPoint = path.resolve(__dirname, "../resources/r/console-language-server.R");

test("TCP LSP discards stdout throughout startup and requests", { timeout: 60000 }, async () => {
  const { createConsoleLsp } = require("./helpers/console-lsp.cjs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-lsp-stdout-"));
  // Instrument console-owned entry points during startup and later requests,
  // independently of package load order.
  fs.cpSync(path.dirname(entryPoint), directory, { recursive: true });
  const script = path.join(directory, path.basename(entryPoint));
  const noise = 'cat(strrep("RCONSOLE_STDOUT_NOISE", 65536L)); flush(stdout())';
  let source = fs.readFileSync(script, "utf8");
  for (const anchor of ['server <- languageserver:::LanguageServer$new(host, NULL)',
    'server$request_handlers[["rConsole/libraryPaths"]] <- function(self, id, params) {']) {
    assert.ok(source.includes(anchor));
    source = source.replace(anchor, anchor.startsWith("server <-")
      ? `${noise}\n${anchor}` : `${anchor}\n    ${noise}`);
  }
  fs.writeFileSync(script, source);
  const { client, instances, logs } = createConsoleLsp({ after() {} });
  client.resolveLanguageServerScriptPath = () => script;
  let timer;
  try {
    await Promise.race([
      (async () => {
        await client.start();
        assert.equal(client.spawnedServer.stdin, null);
        assert.equal(client.spawnedServer.stdout, null);
        for (let i = 0; i < 2; i++) {
          const paths = await instances[0].sendRequest("rConsole/libraryPaths", {});
          assert.ok(paths.length, "LSP remains responsive after further stdout bursts");
        }
        assert.ok(!logs.some(line => line.includes("RCONSOLE_STDOUT_NOISE")),
          "discarded child stdout must not enter lifecycle logs");
      })(),
      new Promise((_, reject) => { timer = setTimeout(() =>
        reject(new Error("TCP LSP blocked on child stdout")), 45000); }),
    ]);
  } catch (error) {
    client.spawnedServer?.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(timer);
    await client.dispose();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an extension-host crash leaves no startup snapshot on disk", { timeout: 30000 }, async t => {
  const secret = "synthetic-startup-crash-secret";
  const worker = spawn(process.execPath, ["-e", `
    const { createConsoleLsp } = require('./tests/helpers/console-lsp.cjs');
    const { client } = createConsoleLsp({ after() {} });
    client.start().then(() => process.send({ workspace: client.workingDirectory,
      rPid: client.spawnedServer.pid,
      captured: Object.hasOwn(client, "startupState")
    })).catch(() => process.exit(1));
  `], {
    cwd: path.resolve(__dirname, ".."), env: { ...process.env, RCONSOLE_TEST_CREDENTIAL: secret },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let workspace, rPid;
  t.after(() => {
    worker.kill("SIGKILL");
    if (rPid) { try { process.kill(rPid, "SIGKILL"); } catch {} }
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const [message] = await Promise.race([
    once(worker, "message"),
    once(worker, "exit").then(() => { throw new Error("Startup fixture exited before transferring state"); }),
  ]);
  ({ workspace, rPid } = message);
  assert.equal(message.captured, false, "no startup snapshot is retained in the client");
  const exited = once(worker, "exit");
  worker.kill("SIGKILL");
  await exited;
  assert.deepEqual(fs.readdirSync(workspace), [], "a hard crash must leave no startup data to recover");
});

test("R sends only a public nonce to a socket peer with an invalid server proof", { timeout: 30000 }, async t => {
  const received = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("data", chunk => {
      received.push(chunk);
      if (Buffer.concat(received).length === 32) socket.write(Buffer.alloc(64));
    });
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const nonce = randomBytes(32).toString("hex");
  const child = spawn("Rscript", ["--vanilla", entryPoint], {
    env: { ...process.env, VSCR_LSP_HOST: "127.0.0.1", VSCR_LSP_PORT: String(server.address().port),
      VSCR_LSP_AUTH_TOKEN: randomBytes(32).toString("hex"), VSCR_LSP_CLIENT_NONCE: nonce,
      VSCR_LSP_AUTH_TIMEOUT_SECONDS: "3",
      RCONSOLE_TEST_CREDENTIAL: "synthetic-private-payload" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(stderr, /Invalid language server authentication proof/);
  assert.deepEqual(Buffer.concat(received), Buffer.from(nonce, "hex"), "only the public nonce reaches the peer");
  assert.ok(!stderr.includes("synthetic-private-payload"));
});

test("R authenticates after initialization exceeding the handshake deadline", { timeout: 30000 }, async (t) => {
  const source = fs.readFileSync(path.join(__dirname, "../resources/r/console-language-server.R"), "utf8");
  const ctor = "server <- languageserver:::LanguageServer$new(host, NULL)";
  const start = source.indexOf("if (!is.null(port)) {", source.indexOf(ctor));
  const end = source.indexOf("\n# Source dedicated completion adapters", start);
  assert.ok(start > source.indexOf(ctor) && end > start, "extract production R authentication block");
  const authentication = source.slice(start, end);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-lsp-auth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rFile = path.join(dir, "delayed-startup.R");
  // The constructor has finished before this block runs in production.
  // Simulate initialization taking longer than the socket-handshake deadline.
  fs.writeFileSync(rFile, [
    "port <- as.integer(commandArgs(TRUE)[[1L]])",
    'host <- "127.0.0.1"',
    "server <- new.env(parent = emptyenv())",
    'server$inputcon <- file("stdin", open = "rb", blocking = FALSE)',
    "server$outputcon <- stdout()",
    "server$tcp <- FALSE",
    "Sys.sleep(4)",
    authentication,
    'cat("R_LSP_AUTH_OK\n", file = stderr())'.replace("\n", "\\n"),
    "close(server$inputcon)",
  ].join("\n"));

  const token = randomBytes(32).toString("hex");
  const nonce = randomBytes(32).toString("hex");
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const sockets = new Set();
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });

  let acceptConnection;
  const authenticated = new Promise((resolve) => { acceptConnection = resolve; });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    void authenticateLspSocket(socket, token, BACKEND_AUTH_TIMEOUT_MS, nonce).then((ok) => {
      if (ok) socket.resume();
      acceptConnection(ok);
    });
  });

  const startTime = Date.now();
  const child = spawn("Rscript", ["--vanilla", rFile, String(server.address().port)], {
    env: {
      ...process.env,
      VSCR_LSP_AUTH_TOKEN: token,
      VSCR_LSP_CLIENT_NONCE: nonce,
      VSCR_LSP_AUTH_TIMEOUT_SECONDS: String(BACKEND_AUTH_TIMEOUT_MS / 1000),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  const exit = once(child, "exit");
  assert.equal(await authenticated, true, "R must authenticate despite slow initialization");
  const [code, signal] = await exit;
  assert.equal(code, 0, "R handshake failed: " + stderr + (signal || ""));
  assert.match(stderr, /R_LSP_AUTH_OK/);
  assert.ok(Date.now() - startTime > BACKEND_AUTH_TIMEOUT_MS,
    "initialization delay must exceed the handshake deadline");
});
