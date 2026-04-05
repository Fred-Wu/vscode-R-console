const path = require("path");

const PACKAGE_TARGETS = {
  "win32-x64": {
    os: "windows",
    rustTarget: "x86_64-pc-windows-msvc",
    executable: "R_CONSOLE_HOST.exe",
  },
  "win32-arm64": {
    os: "windows",
    rustTarget: "aarch64-pc-windows-msvc",
    executable: "R_CONSOLE_HOST.exe",
  },
  "darwin-x64": {
    os: "macos",
    rustTarget: "x86_64-apple-darwin",
    executable: "R_CONSOLE_HOST",
  },
  "darwin-arm64": {
    os: "macos",
    rustTarget: "aarch64-apple-darwin",
    executable: "R_CONSOLE_HOST",
  },
  "linux-x64": {
    os: "linux",
    rustTarget: "x86_64-unknown-linux-gnu",
    executable: "R_CONSOLE_HOST",
  },
  "linux-arm64": {
    os: "linux",
    rustTarget: "aarch64-unknown-linux-gnu",
    executable: "R_CONSOLE_HOST",
  },
};

function getDefaultPackageTarget() {
  if (process.platform === "win32") {
    if (process.arch === "x64") {
      return "win32-x64";
    }
    if (process.arch === "arm64") {
      return "win32-arm64";
    }
  }

  if (process.platform === "darwin") {
    if (process.arch === "x64") {
      return "darwin-x64";
    }
    if (process.arch === "arm64") {
      return "darwin-arm64";
    }
  }

  if (process.platform === "linux") {
    if (process.arch === "x64") {
      return "linux-x64";
    }
    if (process.arch === "arm64") {
      return "linux-arm64";
    }
  }

  throw new Error(
    `Unsupported host platform for packaging: ${process.platform}-${process.arch}`
  );
}

function getPackageTargetInfo(target) {
  const info = PACKAGE_TARGETS[target];
  if (!info) {
    throw new Error(
      `Unsupported package target "${target}". Supported targets: ${Object.keys(PACKAGE_TARGETS).join(", ")}`
    );
  }
  return info;
}

function getTargetBinaryPath(root, target) {
  const info = getPackageTargetInfo(target);
  return path.join(
    root,
    "sidecar",
    "pty-host",
    "target",
    info.rustTarget,
    "release",
    info.executable
  );
}

module.exports = {
  getDefaultPackageTarget,
  getPackageTargetInfo,
  getTargetBinaryPath,
};
