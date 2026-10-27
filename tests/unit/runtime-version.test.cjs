const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const root = path.resolve(__dirname, "../..");

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
