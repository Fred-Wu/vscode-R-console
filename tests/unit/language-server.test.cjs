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
  const end = script.indexOf('server$notification_handlers[["textDocument/didClose"]]', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = script.slice(start, end);

  assert.match(handler, /attached_packages <- normalize_character\(params\$attachedPackages\)/);
  assert.match(handler, /workspace\$startup_packages <- rev\(attached_packages\)/);
  assert.match(handler, /workspace\$update_loaded_packages\(\)/);
  assert.doesNotMatch(handler, /loadedNamespaces|get_namespace|namespaces_to_load/);
});


test("console language server fingerprints cached and referenced packages without attached-package scans", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "../../resources/r/console-language-server.R"),
    "utf8"
  );
  const start = script.indexOf("check_package_changes <- function");
  const end = script.indexOf("server <- languageserver:::LanguageServer$new", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const checker = script.slice(start, end);

  assert.match(script, /package_fingerprints <- new\.env\(parent = emptyenv\(\)\)/);
  assert.match(checker, /workspace\$namespaces\$keys\(\)/);
  assert.match(checker, /normalize_character\(packages\)/);
  assert.doesNotMatch(checker, /workspace\$startup_packages/);
  assert.match(script, /file\.info\(files\)/);
  assert.match(script, /info\$mtime/);
  assert.match(script, /info\$ctime/);
  assert.match(script, /"rConsole\/checkPackageChanges"/);
  assert.doesNotMatch(script, /packageVersion\(/);
});


test("newly cached namespaces are fingerprinted before completion is returned", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "../../resources/r/console-language-server.R"),
    "utf8"
  );
  const start = script.indexOf('server$request_handlers[["textDocument/completion"]]');
  const end = script.indexOf('server$request_handlers[["rConsole/syncSessionState"]]', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = script.slice(start, end);

  const reply = handler.indexOf("languageserver:::completion_reply");
  const record = handler.indexOf("record_cached_package_fingerprints(workspace)");
  const deliver = handler.indexOf("self$deliver(reply)");
  assert.ok(reply >= 0);
  assert.ok(record > reply);
  assert.ok(deliver > record);
  assert.match(script, /record_package_fingerprints\("languageserver"\)/);
  assert.match(script, /for \(workspace in server\$workspaces\$values\(\)\)/);
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
