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


test("console language server fingerprints cached and referenced packages without package versions", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "../../resources/r/console-language-server.R"),
    "utf8"
  );

  assert.match(script, /package_fingerprints <- new\.env\(parent = emptyenv\(\)\)/);
  assert.match(script, /workspace\$startup_packages/);
  assert.match(script, /workspace\$namespaces\$keys\(\)/);
  assert.match(script, /normalize_character\(params\$packages\)/);
  assert.match(script, /file\.info\(files\)/);
  assert.match(script, /info\$mtime/);
  assert.match(script, /info\$ctime/);
  assert.match(script, /"rConsole\/checkPackageChanges"/);
  assert.doesNotMatch(script, /packageVersion\(/);
});
