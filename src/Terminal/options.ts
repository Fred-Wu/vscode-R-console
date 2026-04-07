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

type RStartupOptions = {
  rArch: string;
  noEnviron: boolean;
  noSiteFile: boolean;
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
  prependPathLikeEnv(env, "PATH", entries, process.platform === "win32" ? ";" : ":");
}

function prependPathLikeEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  entries: string[],
  delimiter: string = process.platform === "win32" ? ";" : ":"
): void {
  const existingEntries = (env[key] ?? process.env[key] ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const combined: string[] = [];
  const seen = new Set<string>();

  for (const entry of [...entries, ...existingEntries]) {
    if (!entry || !fs.existsSync(entry) || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    combined.push(entry);
  }

  if (combined.length > 0) {
    env[key] = combined.join(delimiter);
  }
}

function normalizeRArch(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseRStartupOptions(rHome: string, args: string[]): RStartupOptions | undefined {
  let rArch = normalizeRArch(process.env.R_ARCH);
  let noEnviron = false;
  let noSiteFile = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index].trim();
    if (!arg) {
      continue;
    }
    if (arg === "--args") {
      break;
    }
    if (arg === "--vanilla") {
      void vscode.window.showErrorMessage(
        "R Console requires vscode-R session bootstrap and cannot be launched with --vanilla."
      );
      return undefined;
    }
    if (arg === "--no-environ") {
      noEnviron = true;
      continue;
    }
    if (arg === "--no-site-file") {
      noSiteFile = true;
      continue;
    }
    if (arg === "--no-init-file") {
      void vscode.window.showErrorMessage(
        "R Console requires vscode-R session bootstrap and cannot be launched with --no-init-file."
      );
      return undefined;
    }
    if (arg === "--arch") {
      const nextArg = args[index + 1]?.trim();
      if (!nextArg || nextArg.startsWith("-")) {
        void vscode.window.showErrorMessage("R Console startup option --arch requires a value.");
        return undefined;
      }
      rArch = normalizeRArch(nextArg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--arch=")) {
      const value = arg.slice("--arch=".length).trim();
      if (!value) {
        void vscode.window.showErrorMessage("R Console startup option --arch requires a value.");
        return undefined;
      }
      rArch = normalizeRArch(value);
    }
  }

  if (rArch) {
    const archEtcDir = path.join(rHome, `etc${rArch}`);
    if (!fs.existsSync(archEtcDir)) {
      void vscode.window.showErrorMessage(
        `R Console cannot use sub-architecture ${rArch}. Directory not found: ${archEtcDir}`
      );
      return undefined;
    }
  }

  return {
    rArch,
    noEnviron,
    noSiteFile,
  };
}

function applyRStartupEnvOverrides(env: NodeJS.ProcessEnv, startup: RStartupOptions): void {
  env.R_ARCH = startup.rArch;
  if (startup.noEnviron) {
    env.R_ENVIRON = "";
    env.R_ENVIRON_USER = "";
  }
  if (startup.noSiteFile) {
    env.R_PROFILE = "";
  }
}

function parseNullSeparatedEnv(text: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const entry of text.split("\0")) {
    if (!entry) {
      continue;
    }
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = entry.slice(0, separator);
    result[key] = entry.slice(separator + 1);
  }
  return result;
}

function sourceRLauncherLibraryEnv(
  env: NodeJS.ProcessEnv,
  rHome: string,
  rArch: string
): boolean {
  if (process.platform === "win32") {
    return false;
  }

  const ldpathsPath = path.join(rHome, `etc${rArch}`, "ldpaths");
  if (!fs.existsSync(ldpathsPath)) {
    return false;
  }

  const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/sh";
  try {
    const result = spawnSync(shell, ["-c", '. "$1" >/dev/null 2>&1; env -0', "r-console", ldpathsPath], {
      encoding: "utf8",
      env: {
        ...env,
        R_HOME: rHome,
        R_ARCH: rArch,
      },
      windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") {
      return false;
    }

    const sourcedEnv = parseNullSeparatedEnv(result.stdout);
    const loaderKey = process.platform === "darwin" ? "DYLD_FALLBACK_LIBRARY_PATH" : "LD_LIBRARY_PATH";
    for (const key of ["JAVA_HOME", "R_JAVA_LD_LIBRARY_PATH", "R_LD_LIBRARY_PATH", loaderKey]) {
      const value = sourcedEnv[key];
      if (typeof value === "string") {
        env[key] = value;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function configureRDynamicLibraryEnvFallback(env: NodeJS.ProcessEnv, rHome: string): void {
  const loaderPathDelimiter = ":";
  const rLibDir = path.join(rHome, "lib");
  const javaHome =
    env.JAVA_HOME ||
    process.env.JAVA_HOME ||
    (process.platform === "darwin"
      ? "/Library/Java/JavaVirtualMachines/jdk-11.0.18+10/Contents/Home"
      : undefined);
  const rJavaLdLibraryPath =
    env.R_JAVA_LD_LIBRARY_PATH ||
    process.env.R_JAVA_LD_LIBRARY_PATH ||
    (javaHome ? path.join(javaHome, "lib", "server") : undefined);
  const rLdEntries = [rLibDir];

  if (javaHome && fs.existsSync(javaHome)) {
    env.JAVA_HOME = env.JAVA_HOME || javaHome;
  }
  if (rJavaLdLibraryPath && fs.existsSync(rJavaLdLibraryPath)) {
    env.R_JAVA_LD_LIBRARY_PATH = env.R_JAVA_LD_LIBRARY_PATH || rJavaLdLibraryPath;
    rLdEntries.push(rJavaLdLibraryPath);
  }

  prependPathLikeEnv(env, "R_LD_LIBRARY_PATH", rLdEntries, loaderPathDelimiter);
  prependPathLikeEnv(
    env,
    process.platform === "darwin" ? "DYLD_FALLBACK_LIBRARY_PATH" : "LD_LIBRARY_PATH",
    rLdEntries,
    loaderPathDelimiter
  );
}

function resolveRBlasPath(rHome: string): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  const libRPath = path.join(rHome, "lib", "libR.dylib");
  if (fs.existsSync(libRPath)) {
    try {
      const result = spawnSync("otool", ["-L", libRPath], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.status === 0 && typeof result.stdout === "string") {
        for (const line of result.stdout.split(/\r?\n/).slice(1)) {
          const candidate = line.trim().split(/\s+\(/, 1)[0];
          if (candidate.includes("libRblas") && fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }
    } catch {
    }
  }

  const fallback = path.join(rHome, "lib", "libRblas.dylib");
  return fs.existsSync(fallback) ? fallback : undefined;
}

function configureRBlasInjection(env: NodeJS.ProcessEnv, rHome: string): void {
  const blasPath = resolveRBlasPath(rHome);
  if (!blasPath) {
    return;
  }
  prependPathLikeEnv(env, "DYLD_INSERT_LIBRARIES", [blasPath], ":");
  env.R_DYLD_INSERT_LIBRARIES = env.R_DYLD_INSERT_LIBRARIES || blasPath;
}

function configureRRuntimeEnv(
  env: NodeJS.ProcessEnv,
  rHome: string,
  startup: RStartupOptions
): void {
  env.R_HOME = env.R_HOME || rHome;
  env.R_SHARE_DIR = env.R_SHARE_DIR || path.join(rHome, "share");
  env.R_INCLUDE_DIR = env.R_INCLUDE_DIR || path.join(rHome, "include");
  env.R_DOC_DIR = env.R_DOC_DIR || path.join(rHome, "doc");
  applyRStartupEnvOverrides(env, startup);
  if (!sourceRLauncherLibraryEnv(env, rHome, startup.rArch)) {
    configureRDynamicLibraryEnvFallback(env, rHome);
  }
  configureRBlasInjection(env, rHome);

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

function requireVscodeRSessionInitPath(): string | undefined {
  const extension = vscode.extensions.getExtension("REditorSupport.r");
  const extensionPath = extension?.extensionPath;
  if (!extensionPath) {
    void vscode.window.showErrorMessage(
      "R Console requires the vscode-R extension (REditorSupport.r), but it is not available."
    );
    return undefined;
  }
  const initPath = path.join(extensionPath, "R", "session", "init.R");
  if (!fs.existsSync(initPath)) {
    void vscode.window.showErrorMessage(
      `R Console requires vscode-R session bootstrap, but init.R was not found at ${initPath}.`
    );
    return undefined;
  }
  return initPath;
}

function buildRuntimeEnv(
  rPath: string,
  rHome: string | undefined,
  startup: RStartupOptions,
  initPath: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: "xterm-256color",
    TERM_PROGRAM: "vscode",
    R_PROFILE_USER_OLD: process.env.R_PROFILE_USER ?? "",
  };

  if (rHome) {
    configureRRuntimeEnv(env, rHome, startup);
  }

  env.VSCODE_INIT_R = initPath;
  env.VSCODE_WATCHER_DIR = SESSION_WATCHER_DIR;

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

  const rArgs = sanitizeRArgs();
  const startup = parseRStartupOptions(rHome, rArgs);
  if (!startup) {
    return undefined;
  }

  const initPath = requireVscodeRSessionInitPath();
  if (!initPath) {
    return undefined;
  }
  const env = buildRuntimeEnv(rPath, rHome, startup, initPath);

  return {
    rPath,
    rArgs,
    env,
    sessionWatcherEnabled: sessionWatcherConfigured,
    watcherDir: SESSION_WATCHER_DIR,
    bracketedPaste,
    cwd: getWorkspaceFolderPath(),
  };
}
