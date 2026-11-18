const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const versions = require("../sidecar/pty-host/runtime-versions.json");
const checksums = require("../sidecar/pty-host/runtime-checksums.json");

async function verify(target, file) {
  const version = versions[target];
  const expected = checksums[version]?.[target];
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`Missing reviewed SHA-256 for ${target} runtime ${version}.`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== expected) {
    throw new Error(`SHA-256 mismatch for ${target} runtime ${version}.`);
  }
}

verify(process.argv[2], process.argv[3]).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
