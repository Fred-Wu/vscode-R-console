const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
// vsce already depends on yauzl; no additional test dependency is needed.
const yauzl = require("yauzl");
const { getDefaultPackageTarget, getPackageTargetInfo } = require("../scripts/sidecar-targets");
const pkg = require("../package.json");

test("VSIX contains the extension, R scripts, and exactly the staged runtime", async () => {
  const root = path.resolve(__dirname, "..");
  const target = getDefaultPackageTarget();
  const binary = getPackageTargetInfo(target).executable;
  const file = path.join(root, `${pkg.name}-${pkg.version}-${target}.vsix`);
  const entries = new Map();
  await new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
  for (const name of ["dist/extension.js", "package.json", "package.nls.json", "changelog.md",
    "resources/r/console-profile.R", "resources/r/console-language-server.R",
    "resources/r/VSCR/legacy.R", "resources/r/VSCR/sess.R"]) {
    assert.ok(entries.get(`extension/${name}`)?.uncompressedSize > 0, name);
  }
  const runtimeEntries = [...entries.keys()].filter((name) => name.startsWith("extension/bundled/bin/") && !name.endsWith("/"));
  assert.deepEqual(runtimeEntries, [`extension/bundled/bin/${binary}`]);
  const runtime = entries.get(runtimeEntries[0]);
  assert.equal(runtime.uncompressedSize, fs.statSync(path.join(root, "bundled/bin", binary)).size);
  if (process.platform !== "win32") assert.ok((runtime.externalFileAttributes >>> 16) & 0o111);
});
