const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  getDefaultPackageTarget,
  getPackageTargetInfo,
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

function resolveBundledSidecarSource(root, sidecarName) {
  const bundledSidecar = path.join(root, "bundled", "bin", sidecarName);
  if (fs.existsSync(bundledSidecar)) {
    return bundledSidecar;
  }
  return undefined;
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDirectory(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, dstPath);
      continue;
    }
    copyFile(srcPath, dstPath);
  }
}

function createStage(root, stageDir, bundledSidecar, sidecarName) {
  fs.rmSync(stageDir, { recursive: true, force: true });

  copyFile(path.join(root, "package.json"), path.join(stageDir, "package.json"));
  copyFile(path.join(root, "package.nls.json"), path.join(stageDir, "package.nls.json"));
  copyFile(path.join(root, "README.md"), path.join(stageDir, "README.md"));
  copyFile(path.join(root, "CHANGELOG.md"), path.join(stageDir, "CHANGELOG.md"));
  copyFile(path.join(root, "LICENSE"), path.join(stageDir, "LICENSE"));
  copyFile(path.join(root, "images", "Rlogo.png"), path.join(stageDir, "images", "Rlogo.png"));
  copyFile(path.join(root, "dist", "extension.js"), path.join(stageDir, "dist", "extension.js"));
  copyDirectory(path.join(root, "resources", "r"), path.join(stageDir, "resources", "r"));
  copyFile(bundledSidecar, path.join(stageDir, "bundled", "bin", sidecarName));

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
    "bundled/bin/**",
    "resources/r/**",
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
  const vsceEntrypoint = require.resolve("@vscode/vsce/vsce");
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
  const target = args.target ?? getDefaultPackageTarget();
  const targetInfo = getPackageTargetInfo(target);

  const bundlePath = path.join(root, "dist", "extension.js");
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Extension bundle not found at ${bundlePath}. Run npm run package:extension first.`);
  }

  const sidecarName = targetInfo.executable;
  const bundledSidecar = resolveBundledSidecarSource(root, sidecarName);
  if (!bundledSidecar) {
    throw new Error(
      `Bundled sidecar not found for ${target}. Run node scripts/stage-sidecar.js --target ${target} first.`
    );
  }
  const resourcesProfile = path.join(root, "resources", "r", "console-profile.R");
  if (!fs.existsSync(resourcesProfile)) {
    throw new Error(`Runtime bootstrap script not found at ${resourcesProfile}`);
  }

  const outputPath = path.resolve(root, args.output ?? getDefaultOutputPath(root, target));
  const stageDir = path.join(root, ".vsix-stage");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  createStage(root, stageDir, bundledSidecar, sidecarName);

  try {
    runVsce(stageDir, target, outputPath);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  process.stdout.write(`Packaged VSIX: ${outputPath}\n`);
}

main();
