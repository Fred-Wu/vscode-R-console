const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

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

function getDefaultTarget() {
  if (process.platform === "win32") {
    if (process.arch === "x64") {
      return { target: "win32-x64" };
    }
    if (process.arch === "arm64") {
      return { target: "win32-arm64" };
    }
  }

  if (process.platform === "darwin") {
    if (process.arch === "x64") {
      return { target: "darwin-x64" };
    }
    if (process.arch === "arm64") {
      return { target: "darwin-arm64" };
    }
  }

  if (process.platform === "linux" && process.arch === "x64") {
    return { target: "linux-x64" };
  }

  throw new Error(
    `Unsupported host platform for packaging: ${process.platform}-${process.arch}`
  );
}

function getSidecarName(target) {
  return target.startsWith("win32") ? "R_CONSOLE_HOST.exe" : "R_CONSOLE_HOST";
}

function resolveSidecarSource(root, sidecarName) {
  const candidates = [
    path.join(root, "sidecar", "pty-host", "target", "release", sidecarName),
    path.join(root, "bundled", "bin", sidecarName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function createStage(root, stageDir, sidecarSource, sidecarName) {
  fs.rmSync(stageDir, { recursive: true, force: true });

  copyFile(path.join(root, "package.json"), path.join(stageDir, "package.json"));
  copyFile(path.join(root, "package.nls.json"), path.join(stageDir, "package.nls.json"));
  copyFile(path.join(root, "README.md"), path.join(stageDir, "README.md"));
  copyFile(path.join(root, "CHANGELOG.md"), path.join(stageDir, "CHANGELOG.md"));
  copyFile(path.join(root, "LICENSE"), path.join(stageDir, "LICENSE"));
  copyFile(path.join(root, "images", "Rlogo.png"), path.join(stageDir, "images", "Rlogo.png"));
  copyFile(path.join(root, "dist", "extension.js"), path.join(stageDir, "dist", "extension.js"));
  copyFile(sidecarSource, path.join(stageDir, "bundled", "bin", sidecarName));

  const stagedSidecar = path.join(stageDir, "bundled", "bin", sidecarName);
  if (!sidecarName.endsWith(".exe")) {
    fs.chmodSync(stagedSidecar, 0o755);
  }

  const packageJsonPath = path.join(stageDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  delete packageJson.scripts;
  packageJson.files = [
    "dist/**",
    "images/**",
    "bundled/**",
    "package.nls.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
  ];
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function getDefaultOutputPath(root, target) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  );
  return path.join(root, `${packageJson.name}-${packageJson.version}-${target}.vsix`);
}

function runVsce(stageDir, target, outputPath) {
  const vsceEntrypoint = path.join(
    __dirname,
    "..",
    "node_modules",
    "@vscode",
    "vsce",
    "vsce"
  );
  if (!fs.existsSync(vsceEntrypoint)) {
    throw new Error(`vsce entrypoint not found at ${vsceEntrypoint}. Run npm install first.`);
  }

  const result = spawnSync(
    process.execPath,
    [
      vsceEntrypoint,
      "package",
      "--no-dependencies",
      "--target",
      target,
      "-o",
      outputPath,
    ],
    {
      cwd: stageDir,
      stdio: "inherit",
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`vsce package failed with exit code ${result.status ?? "unknown"}`);
  }
}

function main() {
  const root = path.resolve(__dirname, "..");
  const args = parseArgs(process.argv.slice(2));
  const defaults = getDefaultTarget();
  const target = args.target ?? defaults.target;

  const bundlePath = path.join(root, "dist", "extension.js");
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Extension bundle not found at ${bundlePath}. Run npm run package:extension first.`);
  }

  const sidecarName = getSidecarName(target);
  const sidecarSource = resolveSidecarSource(root, sidecarName);
  if (!sidecarSource) {
    throw new Error(
      `Sidecar executable not found for ${target}. Run npm run build:sidecar first.`
    );
  }

  const outputPath = path.resolve(root, args.output ?? getDefaultOutputPath(root, target));
  const stageDir = path.join(root, ".vsix-stage");

  createStage(root, stageDir, sidecarSource, sidecarName);

  try {
    runVsce(stageDir, target, outputPath);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  process.stdout.write(`Packaged VSIX: ${outputPath}\n`);
}

main();
