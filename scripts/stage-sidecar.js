const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  getDefaultPackageTarget,
  getPackageTargetInfo,
  getTargetBinaryPath,
} = require("./sidecar-targets");

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }

    args[name] = value;
    index += 1;
  }

  return args;
}

function resolveSource(root, target) {
  const sourcePath = getTargetBinaryPath(root, target);
  return fs.existsSync(sourcePath) ? sourcePath : undefined;
}

function stageBinary(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);

  if (process.platform !== "win32") {
    fs.chmodSync(dst, 0o755);
  }
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function verifyStagedBinary(src, dst) {
  if (!fs.existsSync(dst)) {
    throw new Error(`Staged sidecar missing at ${dst}`);
  }

  const sourceHash = sha256(src);
  const stagedHash = sha256(dst);
  if (sourceHash !== stagedHash) {
    throw new Error(
      `Staged sidecar does not match source binary.\nsource: ${src}\ndestination: ${dst}`
    );
  }
}

function verifyBundledLayout(dstDir, sidecarName) {
  const entries = fs.readdirSync(dstDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  if (files.length !== 1 || files[0] !== sidecarName) {
    throw new Error(
      `Bundled runtime layout is invalid.\nexpected: ${sidecarName}\nfound: ${files.join(", ")}`
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.target ?? getDefaultPackageTarget();
  const sidecarName = getPackageTargetInfo(target).executable;
  const root = path.resolve(__dirname, "..");
  const bundledDir = path.join(root, "bundled");
  const dstDir = path.join(bundledDir, "bin");
  const resourcesDir = path.join(root, "resources");
  const runtimeProfileSrc = path.join(resourcesDir, "r", "console-profile.R");

  const sidecarSrc = resolveSource(root, target);
  if (!sidecarSrc) {
    throw new Error(`Sidecar binary not found in target directories for ${target}`);
  }
  if (!fs.existsSync(runtimeProfileSrc)) {
    throw new Error(`Runtime bootstrap script not found at ${runtimeProfileSrc}`);
  }

  fs.rmSync(bundledDir, { recursive: true, force: true });
  const sidecarDst = path.join(dstDir, sidecarName);
  stageBinary(sidecarSrc, sidecarDst);
  verifyStagedBinary(sidecarSrc, sidecarDst);
  verifyBundledLayout(dstDir, sidecarName);

  process.stdout.write(`Staged runtime bundle for ${target}: ${bundledDir}\n`);
}

main();
