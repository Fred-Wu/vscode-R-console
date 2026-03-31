const fs = require("fs");
const path = require("path");

function sidecarExeName() {
  return process.platform === "win32" ? "R_CONSOLE_HOST.exe" : "R_CONSOLE_HOST";
}

function resolveSource(root, exeName) {
  const release = path.join(root, "sidecar", "pty-host", "target", "release", exeName);
  const debug = path.join(root, "sidecar", "pty-host", "target", "debug", exeName);

  if (fs.existsSync(release)) {
    return release;
  }
  if (fs.existsSync(debug)) {
    return debug;
  }
  return undefined;
}

function stageBinary(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);

  if (process.platform !== "win32") {
    fs.chmodSync(dst, 0o755);
  }
}

function main() {
  const root = path.resolve(__dirname, "..");
  const dstDir = path.join(root, "bundled", "bin");

  const sidecarName = sidecarExeName();
  const sidecarSrc = resolveSource(root, sidecarName);
  if (!sidecarSrc) {
    throw new Error(`Sidecar binary not found in target directories for ${sidecarName}`);
  }

  fs.rmSync(dstDir, { recursive: true, force: true });
  const sidecarDst = path.join(dstDir, sidecarName);
  stageBinary(sidecarSrc, sidecarDst);
  process.stdout.write(`Staged sidecar: ${sidecarDst}\n`);
}

main();
