import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export type RTerminalOptions = {
  rPath: string;
  consolePath: string;
  rArgs: string[];
  env: NodeJS.ProcessEnv;
  sessionWatcherEnabled: boolean;
  watcherDir: string;
  bracketedPaste: boolean;
  cwd?: string;
};

const SESSION_WATCHER_DIR = path.join(os.homedir(), ".vscode-R");
const REQUIRED_R_MAJOR = 4;
const REQUIRED_R_MINOR = 5;
const REQUIRED_R_SERIES = `${REQUIRED_R_MAJOR}.${REQUIRED_R_MINOR}`;

type ParsedRVersion = {
  major: number;
  minor: number;
  patch?: number;
  text: string;
};

function getRConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("r");
}

function getPlatformConfigEntry(kind: "rpath"): string {
  const platform =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
      ? "mac"
      : "linux";
  return `${kind}.${platform}`;
}

export function getPlatformRPathConfigEntry(): string {
  return getPlatformConfigEntry("rpath");
}

function getWorkspaceFolderPath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const folder = vscode.workspace.getWorkspaceFolder(active);
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  return folders[0].uri.fsPath;
}

function substituteVariable(
  value: string,
  token: string,
  resolveValue: () => string | undefined
): string {
  if (!value.includes(token)) {
    return value;
  }
  const resolved = resolveValue();
  return resolved ? value.replaceAll(token, resolved) : value;
}

function substituteVariables(value: string): string {
  let result = value;
  if (!result.includes("${")) {
    return result;
  }
  result = substituteVariable(result, "${userHome}", () => os.homedir());
  result = substituteVariable(result, "${workspaceFolder}", () => getWorkspaceFolderPath());
  result = substituteVariable(result, "${fileDirname}", () => {
    const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    return activeFilePath ? path.dirname(activeFilePath) : undefined;
  });
  return result;
}

function resolveConfiguredExecutablePath(
  configEntry: string,
  showErrors: boolean = true
): string | undefined {
  const configured = getRConfig().get<string>(configEntry) || "";
  if (!configured) {
    return undefined;
  }

  const resolved = substituteVariables(configured)
    .replace(/^"(.*)"$/, "$1")
    .replace(/^'(.*)'$/, "$1");
  if (!fs.existsSync(resolved)) {
    if (showErrors) {
      void vscode.window.showErrorMessage(
        `Cannot find R at ${resolved}. Check setting r.${configEntry}.`
      );
    }
    return undefined;
  }
  return resolved;
}

export function discoverRBinaryPath(): string | undefined {
  return resolveConfiguredExecutablePath(getPlatformRPathConfigEntry(), false) ?? findROnPath();
}

function findROnPath(): string | undefined {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const executableName = process.platform === "win32" ? "R.exe" : "R";
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, executableName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function guessRHomeFromExecutable(rPath: string): string | undefined {
  const normalized = path.resolve(rPath);
  const lower = normalized.toLowerCase();
  const marker = `${path.sep}bin${path.sep}`;
  const markerIndex = lower.lastIndexOf(marker);
  if (markerIndex <= 0) {
    return undefined;
  }
  return normalized.slice(0, markerIndex);
}

export function resolveRHome(rPath: string): string | undefined {
  try {
    const result = spawnSync(rPath, ["RHOME"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (result.status === 0 && stdout.length > 0 && fs.existsSync(stdout)) {
      return stdout;
    }
  } catch {
  }
  return guessRHomeFromExecutable(rPath);
}

function prependToPath(env: NodeJS.ProcessEnv, entries: string[]): void {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const existing = env.PATH ?? process.env.PATH ?? "";
  const combined = [...entries.filter((entry) => entry.length > 0 && fs.existsSync(entry))];
  if (existing.length > 0) {
    combined.push(existing);
  }
  if (combined.length > 0) {
    env.PATH = combined.join(delimiter);
  }
}

function configureRRuntimeEnv(env: NodeJS.ProcessEnv, rHome: string): void {
  env.R_HOME = env.R_HOME || rHome;
  env.R_SHARE_DIR = env.R_SHARE_DIR || path.join(rHome, "share");
  env.R_INCLUDE_DIR = env.R_INCLUDE_DIR || path.join(rHome, "include");
  env.R_DOC_DIR = env.R_DOC_DIR || path.join(rHome, "doc");

  const pathEntries =
    process.platform === "win32"
      ? [
          path.join(rHome, "bin", "x64"),
          path.join(rHome, "bin", "arm64"),
          path.join(rHome, "bin"),
        ]
      : [path.join(rHome, "bin")];
  prependToPath(env, pathEntries);
}

function resolveConsoleExecutable(rPath: string, rHome: string): string | undefined {
  if (process.platform !== "win32") {
    return rPath;
  }

  const executableName = path.basename(rPath).toLowerCase();
  if (executableName === "rterm.exe" || executableName === "rterm") {
    return rPath;
  }

  const candidates = [
    path.join(rHome, "bin", "x64", "Rterm.exe"),
    path.join(rHome, "bin", "arm64", "Rterm.exe"),
    path.join(rHome, "bin", "Rterm.exe"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function parseRVersionText(text: string): ParsedRVersion | undefined {
  const match = text.match(/R version\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) {
    return undefined;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = match[3] ? Number.parseInt(match[3], 10) : undefined;
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return undefined;
  }
  return {
    major,
    minor,
    patch,
    text: patch === undefined ? `${major}.${minor}` : `${major}.${minor}.${patch}`,
  };
}

function detectRVersion(rPath: string): ParsedRVersion | undefined {
  try {
    const result = spawnSync(rPath, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const output = `${typeof result.stdout === "string" ? result.stdout : ""}\n${
      typeof result.stderr === "string" ? result.stderr : ""
    }`;
    const parsed = parseRVersionText(output);
    if (parsed) {
      return parsed;
    }
  } catch {
  }

  const rHome = resolveRHome(rPath);
  if (!rHome) {
    return undefined;
  }

  const match = path.basename(rHome).match(/^R-(\d+)\.(\d+)(?:\.(\d+))?$/i);
  if (!match) {
    return undefined;
  }

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = match[3] ? Number.parseInt(match[3], 10) : undefined;
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return undefined;
  }

  return {
    major,
    minor,
    patch,
    text: patch === undefined ? `${major}.${minor}` : `${major}.${minor}.${patch}`,
  };
}

function isSupportedRVersion(version: ParsedRVersion | undefined): boolean {
  return Boolean(
    version &&
      version.major === REQUIRED_R_MAJOR &&
      version.minor === REQUIRED_R_MINOR
  );
}

function resolveRBinaryPath(): string | undefined {
  const rPathConfigEntry = getPlatformConfigEntry("rpath");
  const configured = resolveConfiguredExecutablePath(rPathConfigEntry);
  if (configured) {
    return configured;
  }

  const discovered = findROnPath();
  if (discovered) {
    return discovered;
  }

  void vscode.window.showErrorMessage(
    `Cannot find R. Please install R or configure r.${rPathConfigEntry}.`
  );
  return undefined;
}

function sanitizeRArgs(): string[] {
  const config = getRConfig();
  const configuredArgs = config.get<string[]>("rterm.option") ?? [];
  const args: string[] = [];

  for (let index = 0; index < configuredArgs.length; index += 1) {
    const arg = substituteVariables(configuredArgs[index]).trim();
    if (!arg) {
      continue;
    }

    const normalized = arg.toLowerCase();
    if (
      normalized === "--ess" ||
      normalized === "--interactive" ||
      normalized === "--r-binary" ||
      normalized === "--profile"
    ) {
      if (normalized === "--r-binary" || normalized === "--profile") {
        index += 1;
      }
      continue;
    }
    if (
      normalized.startsWith("--r-binary=") ||
      normalized.startsWith("--profile=")
    ) {
      continue;
    }

    args.push(arg);
  }

  const defaultArgs = ["--no-save", "--no-restore"];
  for (const defaultArg of defaultArgs) {
    if (!args.includes(defaultArg)) {
      args.push(defaultArg);
    }
  }

  return args;
}

function resolveVscodeRSessionInitPath(): string | undefined {
  const extension = vscode.extensions.getExtension("REditorSupport.r");
  const extensionPath = extension?.extensionPath;
  if (!extensionPath) {
    return undefined;
  }
  const initPath = path.join(extensionPath, "R", "session", "init.R");
  return fs.existsSync(initPath) ? initPath : undefined;
}

function buildRuntimeEnv(
  rPath: string,
  rHome: string | undefined,
  initPath: string | undefined
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: "xterm-256color",
    TERM_PROGRAM: "vscode",
    R_PROFILE_USER_OLD: process.env.R_PROFILE_USER ?? "",
  };

  if (rHome) {
    configureRRuntimeEnv(env, rHome);
  }

  if (initPath) {
    env.VSCODE_INIT_R = initPath;
    env.VSCODE_WATCHER_DIR = SESSION_WATCHER_DIR;
  } else {
    delete env.VSCODE_INIT_R;
    delete env.VSCODE_WATCHER_DIR;
  }

  env.VSC_R_EXECUTABLE = rPath;
  return env;
}

export function resolveRTerminalOptions(): RTerminalOptions | undefined {
  const config = getRConfig();
  const sessionWatcherConfigured = config.get<boolean>("sessionWatcher") !== false;
  const bracketedPaste = config.get<boolean>("bracketedPaste") !== false;

  const rPath = resolveRBinaryPath();
  if (!rPath) {
    return undefined;
  }

  const detectedVersion = detectRVersion(rPath);
  if (!isSupportedRVersion(detectedVersion)) {
    const detectedText = detectedVersion?.text ?? "unknown version";
    void vscode.window.showErrorMessage(
      `R Console requires R ${REQUIRED_R_SERIES}.x. Detected ${detectedText} at ${rPath}.`
    );
    return undefined;
  }

  const rHome = resolveRHome(rPath);
  if (!rHome) {
    void vscode.window.showErrorMessage(`Cannot determine R_HOME from ${rPath}.`);
    return undefined;
  }

  const consolePath = resolveConsoleExecutable(rPath, rHome);
  if (!consolePath) {
    void vscode.window.showErrorMessage(
      `Cannot find a console-capable R executable for ${rPath}.`
    );
    return undefined;
  }

  const initPath = sessionWatcherConfigured ? resolveVscodeRSessionInitPath() : undefined;
  const env = buildRuntimeEnv(rPath, rHome, initPath);

  return {
    rPath,
    consolePath,
    rArgs: sanitizeRArgs(),
    env,
    sessionWatcherEnabled: sessionWatcherConfigured && initPath !== undefined,
    watcherDir: SESSION_WATCHER_DIR,
    bracketedPaste,
    cwd: getWorkspaceFolderPath(),
  };
}
