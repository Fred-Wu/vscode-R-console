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

test("R authenticates after initialization exceeding the handshake deadline", { timeout: 30000 }, async (t) => {
  const source = fs.readFileSync(path.join(__dirname, "../resources/r/console-language-server.R"), "utf8");
  const ctor = "server <- languageserver:::LanguageServer$new(host, NULL)";
  const start = source.indexOf("if (!is.null(port)) {", source.indexOf(ctor));
  const end = source.indexOf("\nfor (workspace in server$workspaces$values())", start);
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
