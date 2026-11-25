const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const root = path.resolve(__dirname, "../..");

test("Rust and TypeScript agree on authenticated protocol version 3", () => {
  const source = fs.readFileSync(path.join(root, "sidecar/pty-host/src/protocol.rs"), "utf8");
  const { BACKEND_PROTOCOL_VERSION } = require("../helpers/load-source.cjs")("src/Runtime/backendProtocol.ts");
  assert.equal(BACKEND_PROTOCOL_VERSION, 3);
  assert.equal(Number(/const PROTOCOL_VERSION: u32 = (\d+);/.exec(source)?.[1]), BACKEND_PROTOCOL_VERSION);
});

test("the implementation guide documents the active backend protocol", () => {
  const source = fs.readFileSync(path.join(root, "docs/IMPLEMENTATION.md"), "utf8");
  const { BACKEND_PROTOCOL_VERSION } = require("../helpers/load-source.cjs")("src/Runtime/backendProtocol.ts");
  const examples = [...source.matchAll(/"protocolVersion":(\d+)/g)].map(match => Number(match[1]));
  assert.ok(examples.length >= 1, "documentation must include a session bootstrap example");
  assert.ok(examples.every(version => version === BACKEND_PROTOCOL_VERSION),
    "all active bootstrap examples must match the current IPC protocol");
  assert.match(source, new RegExp(`requires protocol version ${BACKEND_PROTOCOL_VERSION}`));
});

test("the bundled sidecar versions match the Cargo manifest and lockfile", () => {
  const manifest = fs.readFileSync(path.join(root, "sidecar/pty-host/Cargo.toml"), "utf8");
  const lock = fs.readFileSync(path.join(root, "sidecar/pty-host/Cargo.lock"), "utf8");
  const versions = JSON.parse(fs.readFileSync(path.join(root, "sidecar/pty-host/runtime-versions.json"), "utf8"));
  const manifestVersion = /^version = "([^"]+)"/m.exec(manifest)?.[1];
  assert.ok(manifestVersion);
  assert.equal(/^name = "R_CONSOLE_HOST"\r?\nversion = "([^"]+)"/m.exec(lock)?.[1], manifestVersion);
  assert.deepEqual(Object.keys(versions).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
  for (const version of Object.values(versions)) assert.equal(version, manifestVersion);
});

test("release rebuilds a changed Rust runtime even if its version was not bumped", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /git diff --quiet .*sidecar\/pty-host\/src sidecar\/pty-host\/Cargo\.toml sidecar\/pty-host\/Cargo\.lock/);
});
