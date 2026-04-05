const { spawnSync } = require("child_process");
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

function runCargo(args) {
  const result = spawnSync("cargo", args, {
    stdio: "inherit",
  });

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function getInstalledRustTargets() {
  const result = spawnSync("rustup", ["target", "list", "--installed"], {
    encoding: "utf8",
  });

  if ((result.status ?? 1) !== 0 || typeof result.stdout !== "string") {
    return new Set();
  }

  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.target ?? getDefaultPackageTarget();
  const targetInfo = getPackageTargetInfo(target);
  const manifestPath = "sidecar/pty-host/Cargo.toml";
  const baseArgs = ["build", "--manifest-path", manifestPath, "--release", "--bin", "R_CONSOLE_HOST"];
  const rustTarget = targetInfo.rustTarget;

  const installedTargets = getInstalledRustTargets();
  if (!installedTargets.has(rustTarget)) {
    process.stderr.write(
      `Missing Rust target ${rustTarget}. Install it with "rustup target add ${rustTarget}".\n`
    );
    process.exit(1);
  }

  runCargo([...baseArgs, "--target", rustTarget]);
}

main();
