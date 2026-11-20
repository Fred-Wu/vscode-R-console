const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

test("session state sync updates attached packages without eager namespace loading", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "../../resources/r/console-language-server.R"),
    "utf8"
  );
  const start = script.indexOf('server$request_handlers[["rConsole/syncSessionState"]]');
  const end = script.indexOf('server$request_handlers[["rConsole/libraryPaths"]]', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = script.slice(start, end);

  assert.match(handler, /attached_packages <- normalize_character\(params\$attachedPackages\)/);
  assert.match(handler, /workspace\$startup_packages <- rev\(attached_packages\)/);
  assert.match(handler, /workspace\$update_loaded_packages\(\)/);
  assert.doesNotMatch(handler, /functions|console_sync_workspace_functions/,
    "session-state synchronization must not inject function signature documents");
  assert.doesNotMatch(handler, /loadedNamespaces|get_namespace|namespaces_to_load/);
});


test("active console libraries take precedence over fallback R libraries", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "../../resources/r/console-language-server.R"), "utf8"
  );
  assert.match(script, /\.paths <- c\(add_lib_paths, \.paths\)/);
  assert.match(script, /\.libPaths\(\.paths\)/);
});


test("console R language server authenticates before entering the LSP event loop", () => {
  const script = fs.readFileSync(path.join(__dirname, "../../resources/r/console-language-server.R"), "utf8");
  const create = script.indexOf("LanguageServer$new(host, NULL)");
  const token = script.indexOf("digest::hmac(");
  const run = script.indexOf("server$run()");
  assert.ok(create >= 0 && token > create && run > token);
  assert.match(script, /VSCR_LSP_AUTH_TOKEN/);
  assert.match(script, /VSCR_LSP_CLIENT_NONCE/);
  assert.match(script, /bitwXor/);
  assert.match(script, /rconsole-lsp-server-v2/);
  assert.match(script, /rconsole-lsp-client-v2/);
  assert.doesNotMatch(script, /writeBin\(charToRaw\(token\)/);
});

test("console LSP connects only after language-server initialization", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "../../resources/r/console-language-server.R"), "utf8"
  );
  assert.match(script, /server <- languageserver:::LanguageServer\$new\(host, NULL\)/);
  const initialized = script.indexOf("server <- languageserver:::LanguageServer$new(host, NULL)");
  const connect = script.indexOf('server$inputcon <- socketConnection(', initialized);
  const authentication = script.indexOf('writeBin(nonce, server$outputcon)', initialized);
  assert.ok(initialized >= 0 && connect > initialized && authentication > connect);
  assert.match(script, /server\$tcp <- TRUE/);
});
