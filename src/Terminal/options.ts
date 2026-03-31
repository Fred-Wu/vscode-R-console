import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export type RTerminalOptions = {
  rPath: string;
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

function getRPathConfigEntry(term: boolean = false): string {
  const trunc = term ? "rterm" : "rpath";
  const platform =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
      ? "mac"
      : "linux";
  return `${trunc}.${platform}`;
}

function substituteVariable(
  str: string,
  key: string,
  getValue: () => string | undefined
): string {
  if (!str.includes(key)) {
    return str;
  }
  const value = getValue();
  return value ? str.replaceAll(key, value) : str;
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

function substituteVariables(str: string): string {
  let result = str;
  if (str.includes("${")) {
    result = substituteVariable(result, "${userHome}", () => os.homedir());
    result = substituteVariable(
      result,
      "${workspaceFolder}",
      () => getWorkspaceFolderPath()
    );
    result = substituteVariable(result, "${fileDirname}", () => {
      const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
      return activeFilePath ? path.dirname(activeFilePath) : undefined;
    });
  }
  return result;
}

function findRInPath(): string | undefined {
  const splitChar = process.platform === "win32" ? ";" : ":";
  const fileExtension = process.platform === "win32" ? ".exe" : "";
  const osPaths = process.env.PATH ? process.env.PATH.split(splitChar) : [];
  for (const osPath of osPaths) {
    const candidate = path.join(osPath, `R${fileExtension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function guessRHomeFromExecutable(rPath: string): string | undefined {
  const normalized = path.resolve(rPath);
  const lower = normalized.toLowerCase();
  const binSegment = `${path.sep}bin${path.sep}`;
  const binIndex = lower.lastIndexOf(binSegment);
  if (binIndex <= 0) {
    return undefined;
  }
  return normalized.slice(0, binIndex);
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

function prependRBinToPath(env: NodeJS.ProcessEnv, rHome: string): void {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const pathEntries: string[] = [];
  if (process.platform === "win32") {
    pathEntries.push(path.join(rHome, "bin", "x64"));
    pathEntries.push(path.join(rHome, "bin"));
  } else {
    pathEntries.push(path.join(rHome, "bin"));
  }

  const existingPath = env.PATH ?? process.env.PATH ?? "";
  env.PATH = [...pathEntries.filter((entry) => fs.existsSync(entry)), existingPath]
    .filter((entry) => entry.length > 0)
    .join(delimiter);
}

function prependDelimitedPaths(
  env: NodeJS.ProcessEnv,
  name: string,
  values: string[],
  delimiter: string
): void {
  const existing = env[name] ?? process.env[name] ?? "";
  const entries = [
    ...values.filter((value) => value.length > 0 && fs.existsSync(value)),
    ...existing.split(delimiter).filter((value) => value.length > 0),
  ];
  const deduped: string[] = [];
  for (const entry of entries) {
    if (!deduped.includes(entry)) {
      deduped.push(entry);
    }
  }
  if (deduped.length > 0) {
    env[name] = deduped.join(delimiter);
  }
}

function loadEmbeddedRLibraryEnvFromLdpaths(
  env: NodeJS.ProcessEnv,
  rHome: string
): Partial<NodeJS.ProcessEnv> | undefined {
  if (process.platform === "win32") {
    return undefined;
  }

  const ldpaths = path.join(rHome, "etc", "ldpaths");
  if (!fs.existsSync(ldpaths)) {
    return undefined;
  }

  const variableNames =
    process.platform === "darwin"
      ? ["R_LD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH"]
      : ["R_LD_LIBRARY_PATH", "LD_LIBRARY_PATH"];
  const secondaryVariable =
    process.platform === "darwin" ? "DYLD_FALLBACK_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  const script = `. "$1"; printf '%s\\n' "\${R_LD_LIBRARY_PATH-}" "\${${secondaryVariable}-}"`;
  const result = spawnSync("/bin/sh", ["-c", script, "sh", ldpaths], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      R_HOME: rHome,
    },
    windowsHide: true,
  });

  if (result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }

  const values = result.stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const loaded: Partial<NodeJS.ProcessEnv> = {};
  for (let index = 0; index < variableNames.length; index += 1) {
    const value = values[index]?.trim();
    if (value) {
      loaded[variableNames[index]] = value;
    }
  }
  return Object.keys(loaded).length > 0 ? loaded : undefined;
}

export function configureEmbeddedRRuntimeEnv(
  env: NodeJS.ProcessEnv,
  rHome: string
): void {
  env.R_HOME = env.R_HOME || rHome;
  env.VSC_R_HOME = rHome;
  env.R_SHARE_DIR = env.R_SHARE_DIR || path.join(rHome, "share");
  env.R_INCLUDE_DIR = env.R_INCLUDE_DIR || path.join(rHome, "include");
  env.R_DOC_DIR = env.R_DOC_DIR || path.join(rHome, "doc");

  prependRBinToPath(env, rHome);

  if (process.platform === "win32") {
    return;
  }

  const ldpathsEnv = loadEmbeddedRLibraryEnvFromLdpaths(env, rHome);
  if (ldpathsEnv) {
    for (const [name, value] of Object.entries(ldpathsEnv)) {
      if (value) {
        env[name] = value;
      }
    }
    return;
  }

  const delimiter = ":";
  const rLibPaths = [path.join(rHome, "lib")];
  const javaHome = env.JAVA_HOME ?? process.env.JAVA_HOME ?? "";
  if (javaHome) {
    rLibPaths.push(path.join(javaHome, "lib", "server"));
  }

  prependDelimitedPaths(env, "R_LD_LIBRARY_PATH", rLibPaths, delimiter);
  if (process.platform === "darwin") {
    prependDelimitedPaths(env, "DYLD_FALLBACK_LIBRARY_PATH", rLibPaths, delimiter);
  } else {
    prependDelimitedPaths(env, "LD_LIBRARY_PATH", rLibPaths, delimiter);
  }
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

function resolveRtermPath(): string | undefined {
  const config = getRConfig();
  const configEntry = getRPathConfigEntry(true);
  let rPath = config.get<string>(configEntry) || "";
  if (rPath) {
    rPath = substituteVariables(rPath);
    rPath = rPath.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (!fs.existsSync(rPath)) {
      void vscode.window.showErrorMessage(
        `Cannot find R at ${rPath}. Check setting r.${configEntry}.`
      );
      return undefined;
    }
    return rPath;
  }
  return findRInPath();
}

function resolveRtermArgs(): string[] {
  const config = getRConfig();
  const userArgs = config.get<string[]>("rterm.option") || [];
  const rawArgs = userArgs.map(substituteVariables).filter((arg) => arg.trim().length > 0);
  const args = rawArgs.filter(
    (arg) => !(process.platform !== "win32" && arg.trim().toLowerCase() === "--ess")
  );
  if (
    process.platform === "win32" &&
    !args.some((arg) => arg.trim().toLowerCase() === "--ess")
  ) {
    args.unshift("--ess");
  }

  const defaultArgs = ["--no-save", "--no-restore"];
  for (const defaultArg of defaultArgs) {
    if (!args.includes(defaultArg)) {
      args.push(defaultArg);
    }
  }

  return args;
}

function resolveVscodeRSessionPaths():
  | { profilePath: string; initPath: string }
  | undefined {
  const extension = vscode.extensions.getExtension("REditorSupport.r");
  let extensionPath = extension?.extensionPath;
  if (!extensionPath) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.find(
      (folder) => path.basename(folder.uri.fsPath).toLowerCase() === "vscode-r"
    );
    extensionPath = workspaceFolder?.uri.fsPath;
  }
  if (!extensionPath) {
    return undefined;
  }
  const profilePath = path.join(extensionPath, "R", "session", "profile.R");
  const initPath = path.join(extensionPath, "R", "session", "init.R");
  if (!fs.existsSync(profilePath) || !fs.existsSync(initPath)) {
    return undefined;
  }
  return { profilePath, initPath };
}

function buildRProcessEnv(rPath: string, sessionWatcherEnabled: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: "xterm-256color",
    TERM_PROGRAM: "vscode",
  };

  const rHome = resolveRHome(rPath);
  if (rHome) {
    configureEmbeddedRRuntimeEnv(env, rHome);
  }

  if (!sessionWatcherEnabled) {
    return env;
  }

  const sessionPaths = resolveVscodeRSessionPaths();
  if (!sessionPaths) {
    return env;
  }
  env.R_PROFILE_USER_OLD = process.env.R_PROFILE_USER ?? "";
  env.R_PROFILE_USER = sessionPaths.profilePath;
  env.VSCODE_INIT_R = sessionPaths.initPath;
  env.VSCODE_WATCHER_DIR = SESSION_WATCHER_DIR;
  return env;
}

export function resolveRTerminalOptions(): RTerminalOptions | undefined {
  const config = getRConfig();
  const sessionWatcherEnabled = config.get<boolean>("sessionWatcher") !== false;
  const bracketedPaste = config.get<boolean>("bracketedPaste") !== false;
  const configEntry = getRPathConfigEntry(true);
  const configuredPath = config.get<string>(configEntry) || "";
  const rPath = resolveRtermPath();
  if (!rPath) {
    if (configuredPath) {
      return undefined;
    }
    void vscode.window.showErrorMessage(
      `Cannot find R installation. Please install R or configure the path in settings (r.rterm.${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux"}).`
    );
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

  const rArgs = resolveRtermArgs();
  const env = buildRProcessEnv(rPath, sessionWatcherEnabled);
  const cwd = getWorkspaceFolderPath();
  return {
    rPath,
    rArgs,
    env,
    sessionWatcherEnabled,
    watcherDir: SESSION_WATCHER_DIR,
    bracketedPaste,
    cwd,
  };
}
