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
