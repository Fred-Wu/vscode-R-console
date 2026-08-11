import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setNativeParseCallback, stripCommentLines } from "../../Language/parser";
import {
  type BackendControlEvent,
  type BackendDialogRequest,
} from "../../Runtime/backendProtocol";
import {
  getBundledRustSidecarPath,
  resolveRustSidecarPath,
  RuntimeBackend,
  type RuntimeSessionHandle,
  RustSidecarRuntimeBackend,
} from "../../Runtime/runtimeBackend";
import { SessProxy } from "../../Runtime/sessProxy";
import type {
  SessionMemberCompletionItem,
  SessionWatcher,
  WorkspaceData,
} from "../../Runtime/sessionWatcher";
import { ANSI, stripBracketedPasteMarkers } from "../ansi";
import { ConsoleSyntax } from "../consoleSyntax";
import { InputState } from "../inputState";
import {
  buildSubmissionRenderPlan,
  getContinuationPromptLength,
} from "../inputViewport";
import {
  type RTerminalOptions,
} from "../options";
import { Renderer } from "../renderer";
import { RTermLang } from "./lang";
import {
  configureMainPrompt,
  formatTerminalOutput as formatViewOutput,
} from "./view";

const VSCODE_R_TERMINAL_NAME = "R Console";

type PendingRuntimeRewrite = {
  bareCarriageReturn: boolean;
  clearFrame: {
    text: string;
    endedWithLineFeed: boolean;
  } | null;
};

type Dimensions = {
  columns: number;
  rows: number;
};

export type TerminalMode = "starting" | "ready" | "executing" | "reply" | "closed";

export type Submission = {
  code: string;
  initialPromptKind: "main" | "cont";
};

export type VscodeRSessionConnection = {
  pipePath: string;
  attachScriptPath?: string;
  jgdSocket?: string;
};

const pendingRuntimeRewrites = new WeakMap<RuntimeHost, PendingRuntimeRewrite>();

export type RuntimeHost = {
  options: RTerminalOptions;
  extensionPath: string;
  runtimeBackend: RuntimeBackend | undefined;
  rProcess: RuntimeSessionHandle | null;
  backendChildPid: number | undefined;
  dimensions: Dimensions;
  mode: TerminalMode;
  promptReady: boolean;
  promptKind: "main" | "cont";
  promptVisible: boolean;
  replyPromptText: string;
  pendingPromptToken: boolean;
  pendingInitialPromptGap: boolean;
  submissionPending: boolean;
  awaitingExecutionStart: boolean;
  lastWriteEndedWithNewline: boolean;
  hasReceivedOutput: boolean;
  sessionAttached: boolean;
  sessionHostConnected: boolean;
  activeSubmission: Submission | null;
  submissionQueue: Submission[];
  historyBrowsing: boolean;
  historyCollapsed: boolean;
  sessionWatcher: SessionWatcher | undefined;
  inputState: InputState;
  syntax: ConsoleSyntax;
  renderer: Renderer;
  lang: RTermLang;
  writeEmitter: vscode.EventEmitter<string>;
  closeEmitter: vscode.EventEmitter<number>;
  nameEmitter: vscode.EventEmitter<string>;
  clearPendingInputFlushTimer(): void;
  clearPromptRenderTimer(): void;
  clearReplyPromptRenderTimer(): void;
  clearPendingConsoleInput(): void;
  captureVisibleInputForReplay(): void;
  sendPendingConsoleInput(kind: "top-level" | "nested"): boolean;
  schedulePrompt(): void;
  scheduleReplyPrompt(): void;
  clearInputRender(): void;
  renderInput(): void;
  recordOutputActivity(): void;
  isSessionProtocolActive(): boolean;
  startNextSubmission(): void;
  finishActiveSubmission(): void;
  getDisplayPid(): number | undefined;
  getTerminalName(): string;
  notifyDisplayPidChanged(): void;
  onSessionDataChanged(data: WorkspaceData | undefined): void;
  vscodeRSessionReconnectPending: boolean;
  vscodeRSessionActivationPending: boolean;
};

export function getRuntimeTerminalName(host: Pick<RuntimeHost, "getDisplayPid">): string {
  const pid = host.getDisplayPid();
  if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
    return `${VSCODE_R_TERMINAL_NAME} (${pid})`;
  }
  return VSCODE_R_TERMINAL_NAME;
}

export function isDefaultRuntimeTerminalName(terminalName: string): boolean {
  return (
    terminalName === VSCODE_R_TERMINAL_NAME ||
    /^R Console \(\d+\)$/.test(terminalName)
  );
}

export function updateRuntimeTerminalName(
  host: Pick<
    RuntimeHost,
    "getTerminalName" | "nameEmitter" | "notifyDisplayPidChanged"
  >
): void {
  host.nameEmitter.fire(host.getTerminalName());
  host.notifyDisplayPidChanged();
}

export function createRuntimeBackend(
  extensionPath: string
): RuntimeBackend | undefined {
  const sidecarPath = resolveRustSidecarPath(extensionPath);
  if (sidecarPath) {
    return new RustSidecarRuntimeBackend(sidecarPath);
  }
  return undefined;
}

const VSCODE_R_EXTENSION_ID = "REditorSupport.r";
const SESS_ASYNC_PROMPT_PATTERN = /(\r?\[sess\][^\r\n]*)(?:\r\n|\n){2}> ?/g;
const SESS_RECONNECT_NOISE_PATTERN =
  /\r?\[sess\] Failed to connect to IPC pipe: [^\r\n]*(?:\r\n|\n)?/g;
const vscodeRSessionConnections = new WeakMap<RuntimeHost, VscodeRSessionConnection>();
const vscodeRSessionConnectionRefreshes = new WeakMap<
  RuntimeHost,
  Promise<VscodeRSessionConnection | undefined>
>();
let vscodeRSessionConnectionDiscovery:
  | Promise<VscodeRSessionConnection | undefined>
  | undefined;
const vscodeRSessionFiles = new WeakMap<RuntimeHost, string>();
const vscodeRSessionProxies = new WeakMap<RuntimeHost, SessProxy>();
const vscodeRSessionProxiesByRuntimeSession = new Map<string, SessProxy>();
const vscodeRSessionReconnectInFlight = new WeakSet<RuntimeHost>();
const vscodeRSessionReconnectNoiseUntil = new WeakMap<RuntimeHost, number>();

function clearVscodeRSessionConnection(host: RuntimeHost): void {
  const proxy = vscodeRSessionProxies.get(host);
  vscodeRSessionConnections.delete(host);
  vscodeRSessionProxies.delete(host);
  const sessionId = host.rProcess?.sessionId;
  if (sessionId && vscodeRSessionProxiesByRuntimeSession.get(sessionId) === proxy) {
    vscodeRSessionProxiesByRuntimeSession.delete(sessionId);
  }
  proxy?.dispose();
}

export function disposeVscodeRSessionProxyForRuntimeSession(sessionId: string): void {
  const proxy = vscodeRSessionProxiesByRuntimeSession.get(sessionId);
  vscodeRSessionProxiesByRuntimeSession.delete(sessionId);
  proxy?.dispose();
}

function usesSessIntegration(host: RuntimeHost): boolean {
  return host.options.sessionMode === "sess";
}

function usesLegacySessionWatcher(host: RuntimeHost): boolean {
  return host.options.sessionMode === "legacy" && !!host.sessionWatcher;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isLivePid(pid: number | undefined): pid is number {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pruneStaleVscodeRSessionFiles(): Promise<void> {
  const sessionsDir = path.join(os.homedir(), ".vscode-R", "sessions");
  let entries: string[];
  try {
    entries = await fs.promises.readdir(sessionsDir);
  } catch {
    return;
  }

  await Promise.all(entries.map(async (entry) => {
    if (!entry.endsWith(".json")) {
      return;
    }
    const pid = Number.parseInt(path.basename(entry, ".json"), 10);
    const filePath = path.join(sessionsDir, entry);
    if (isLivePid(pid)) {
      return;
    }
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
  }));
}

async function readClipboardText(): Promise<string | undefined> {
  try {
    return await vscode.env.clipboard.readText();
  } catch {
    return undefined;
  }
}

function parseRStringLiteralAt(
  text: string,
  startIndex: number
): { value: string; endIndex: number } | undefined {
  const quote = text[startIndex];
  if (quote !== "\"" && quote !== "'") {
    return undefined;
  }

  let value = "";
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === quote) {
      return { value, endIndex: index + 1 };
    }
    if (char === "\\" && index + 1 < text.length) {
      const escaped = text[index + 1];
      switch (escaped) {
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        default:
          value += escaped;
          break;
      }
      index += 1;
      continue;
    }
    value += char;
  }

  return undefined;
}

function parseSourceScriptPath(command: string): string | undefined {
  const match = /\bsource\s*\(/.exec(command);
  if (!match) {
    return undefined;
  }

  let index = match.index + match[0].length;
  while (index < command.length && /\s/.test(command[index])) {
    index += 1;
  }

  return parseRStringLiteralAt(command, index)?.value;
}

function parseAssignedRString(content: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*<-\\s*`, "g");
  const match = pattern.exec(content);
  if (!match) {
    return undefined;
  }

  let index = match.index + match[0].length;
  while (index < content.length && /\s/.test(content[index])) {
    index += 1;
  }

  return parseRStringLiteralAt(content, index)?.value;
}

async function parseVscodeRPipeAttachCommand(
  command: string
): Promise<VscodeRSessionConnection | undefined> {
  const attachScriptPath = parseSourceScriptPath(command);
  if (!attachScriptPath) {
    return undefined;
  }

  try {
    const content = await fs.promises.readFile(attachScriptPath, "utf8");
    const pipePath = parseAssignedRString(content, "pipe_path");
    if (!pipePath) {
      return undefined;
    }
    const jgdSocketAssignment = /\bJGD_SOCKET\s*=\s*/.exec(content);
    const jgdSocket = jgdSocketAssignment
      ? parseRStringLiteralAt(
          content,
          jgdSocketAssignment.index + jgdSocketAssignment[0].length
        )?.value
      : undefined;
    return {
      pipePath,
      attachScriptPath,
      jgdSocket,
    };
  } catch {
    return undefined;
  }
}

async function discoverVscodeRSessionConnection(): Promise<
  VscodeRSessionConnection | undefined
> {
  await pruneStaleVscodeRSessionFiles();

  const extension = vscode.extensions.getExtension(VSCODE_R_EXTENSION_ID);
  if (!extension) {
    return undefined;
  }

  try {
    if (!extension.isActive) {
      await extension.activate();
    }
  } catch {
  }

  const previousClipboard = await readClipboardText();
  const clipboardProbe = `__vscode_r_console_session_probe_${Date.now()}_${Math.random()}__`;

  try {
    await vscode.env.clipboard.writeText(clipboardProbe);
  } catch {
    return undefined;
  }

  try {
    await vscode.commands.executeCommand("r.connectToSession");

    const startedAt = Date.now();
    while (Date.now() - startedAt < 1000) {
      const currentClipboard = (await readClipboardText()) ?? "";
      if (currentClipboard === clipboardProbe) {
        await sleep(50);
        continue;
      }

      const connection = await parseVscodeRPipeAttachCommand(currentClipboard);
      if (connection) {
        return connection;
      }
      await sleep(50);
    }

    return undefined;
  } catch {
    return undefined;
  } finally {
    if (previousClipboard !== undefined) {
      const currentClipboard = await readClipboardText();
      if (currentClipboard !== previousClipboard) {
        try {
          await vscode.env.clipboard.writeText(previousClipboard);
        } catch {}
      }
    }
  }
}

function getVscodeRSessionConnection(): Promise<
  VscodeRSessionConnection | undefined
> {
  if (!vscodeRSessionConnectionDiscovery) {
    vscodeRSessionConnectionDiscovery =
      discoverVscodeRSessionConnection().finally(() => {
        vscodeRSessionConnectionDiscovery = undefined;
      });
  }
  return vscodeRSessionConnectionDiscovery;
}

async function createProxiedVscodeRSessionConnection(
  host: RuntimeHost
): Promise<VscodeRSessionConnection | undefined> {
  const upstreamConnection = await getVscodeRSessionConnection();
  if (!upstreamConnection) {
    return undefined;
  }

  const proxy = new SessProxy({
    upstreamPipePath: upstreamConnection.pipePath,
    onWorkspaceData: (data) => host.onSessionDataChanged(data),
  });

  try {
    const pipePath = await proxy.start();
    clearVscodeRSessionConnection(host);
    const connection = {
      ...upstreamConnection,
      pipePath,
    };
    vscodeRSessionProxies.set(host, proxy);
    const sessionId = host.rProcess?.sessionId;
    if (sessionId) {
      vscodeRSessionProxiesByRuntimeSession.set(sessionId, proxy);
    }
    return connection;
  } catch {
    proxy.dispose();
    return undefined;
  }
}

function asRLogical(value: boolean | undefined, defaultValue: boolean): string {
  return (value ?? defaultValue) ? "TRUE" : "FALSE";
}

function quoteRString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function resolveVscodeRPlotBackend(
  rConfig: vscode.WorkspaceConfiguration
): "auto" | "standard" | "httpgd" | "jgd" {
  const backend = rConfig.get<"auto" | "standard" | "httpgd" | "jgd">(
    "plot.backend",
    "auto"
  );
  return backend === "auto" && rConfig.get<boolean>("plot.useHttpgd", false)
    ? "httpgd"
    : backend;
}

async function setOwnerOnlyPermissions(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await fs.promises.chmod(filePath, 0o600);
}

function buildSessConnectCommand(connection: VscodeRSessionConnection): string {
  const rConfig = vscode.workspace.getConfiguration("r");
  const plotBackend = resolveVscodeRPlotBackend(rConfig);
  const jgdSocketCommand = connection.jgdSocket
    ? `Sys.setenv(JGD_SOCKET=${quoteRString(connection.jgdSocket)});`
    : "Sys.unsetenv(\"JGD_SOCKET\");";
  return [
    "if (requireNamespace(\"sess\", quietly = TRUE) && \"pipe_path\" %in% names(formals(sess::connect))) {",
    jgdSocketCommand,
    "sess::connect(",
    `pipe_path=${quoteRString(connection.pipePath)},`,
    `use_rstudioapi=${asRLogical(rConfig.get<boolean>("session.emulateRStudioAPI"), true)},`,
    `use_httpgd=${asRLogical(plotBackend === "httpgd" || plotBackend === "auto", true)},`,
    `use_jgd=${asRLogical(plotBackend === "jgd" || plotBackend === "auto", false)}`,
    ")",
    "}",
  ].join(" ");
}

function buildSessAttachNotificationCommand(): string {
  return [
    "if (requireNamespace(\"sess\", quietly = TRUE) && \"notify_client\" %in% getNamespaceExports(\"sess\")) {",
    "sess::notify_client(\"attach\", list(",
    "version=sprintf(\"%s.%s\", R.version$major, R.version$minor),",
    "pid=Sys.getpid(),",
    "tempdir=file.path(tempdir(), \"sess\"),",
    "wd=getwd(),",
    "info=list(command=commandArgs()[[1L]], version=R.version.string, start_time=format(Sys.time()))",
    "))",
    "}",
  ].join(" ");
}

async function configureVscodeRSessionBootstrap(
  host: RuntimeHost,
  env: NodeJS.ProcessEnv
): Promise<VscodeRSessionConnection | undefined> {
  const connection = await createProxiedVscodeRSessionConnection(host);
  if (!connection) {
    void vscode.window.showWarningMessage(
      "R Console could not obtain vscode-R session connection info. The console will start without vscode-R session attachment."
    );
    return undefined;
  }

  env.SESS_PIPE = connection.pipePath;
  const rConfig = vscode.workspace.getConfiguration("r");
  const plotBackend = resolveVscodeRPlotBackend(rConfig);
  env.SESS_RSTUDIOAPI = asRLogical(rConfig.get<boolean>("session.emulateRStudioAPI"), true);
  env.SESS_USE_HTTPGD = asRLogical(
    plotBackend === "httpgd" || plotBackend === "auto",
    true
  );
  env.SESS_USE_JGD = asRLogical(
    plotBackend === "jgd" || plotBackend === "auto",
    false
  );
  if (connection.jgdSocket) {
    env.JGD_SOCKET = connection.jgdSocket;
  } else {
    delete env.JGD_SOCKET;
  }
  delete env.SESS_PORT;
  delete env.SESS_TOKEN;
  delete env.SESS_HOST;
  return connection;
}

async function resolveCurrentVscodeRSessionConnection(
  host: RuntimeHost
): Promise<VscodeRSessionConnection | undefined> {
  const existing = vscodeRSessionConnections.get(host);
  if (existing) {
    return existing;
  }

  const sessionId = host.rProcess?.sessionId;
  const proxy = sessionId ? vscodeRSessionProxiesByRuntimeSession.get(sessionId) : undefined;
  const pipePath = proxy?.getPipePath();
  if (proxy?.isConnected() && pipePath) {
    const connection = { pipePath };
    vscodeRSessionConnections.set(host, connection);
    vscodeRSessionProxies.set(host, proxy);
    return connection;
  }
  if (proxy && sessionId) {
    vscodeRSessionProxiesByRuntimeSession.delete(sessionId);
    proxy.dispose();
  }

  let refresh = vscodeRSessionConnectionRefreshes.get(host);
  if (!refresh) {
    refresh = createProxiedVscodeRSessionConnection(host).finally(() => {
      vscodeRSessionConnectionRefreshes.delete(host);
    });
    vscodeRSessionConnectionRefreshes.set(host, refresh);
  }

  const connection = await refresh;
  if (!connection) {
    return undefined;
  }

  vscodeRSessionConnections.set(host, connection);
  return connection;
}

async function writeVscodeRSessionFile(
  host: RuntimeHost,
  pid: number,
  connection: VscodeRSessionConnection
): Promise<void> {
  if (!connection.pipePath) {
    return;
  }

  const filePath = path.join(os.homedir(), ".vscode-R", "sessions", `${pid}.json`);
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({ pipe: connection.pipePath }),
      { encoding: "utf8", mode: 0o600 }
    );
    await setOwnerOnlyPermissions(filePath);
    vscodeRSessionFiles.set(host, filePath);
  } catch {
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
  }
}

function persistVscodeRSessionConnection(host: RuntimeHost, pid: number): void {
  if (!isLivePid(pid)) {
    return;
  }
  const connection = vscodeRSessionConnections.get(host);
  if (!connection) {
    return;
  }
  void writeVscodeRSessionFile(host, pid, connection);
}

async function refreshVscodeRSessionConnection(host: RuntimeHost): Promise<void> {
  if (!usesSessIntegration(host)) {
    return;
  }

  const pid = isLivePid(host.backendChildPid)
    ? host.backendChildPid
    : host.runtimeBackend?.getPid(host.rProcess);

  const connection = await resolveCurrentVscodeRSessionConnection(host);
  if (!connection) {
    return;
  }

  if (isLivePid(pid)) {
    await writeVscodeRSessionFile(host, pid, connection);
  }
}

function canSubmitHiddenRuntimeCommand(host: RuntimeHost): boolean {
  return Boolean(
    host.mode === "ready" &&
    host.promptReady &&
    host.promptKind === "main" &&
    host.activeSubmission === null &&
    !host.submissionPending &&
    host.inputState.text.length === 0 &&
    host.runtimeBackend?.canUseSessionCommands(host.rProcess)
  );
}

function submitHiddenRuntimeCommand(host: RuntimeHost, code: string): boolean {
  const sent = host.runtimeBackend?.sendSessionCommand(host.rProcess, {
    type: "submit",
    code,
  }) ?? false;
  if (!sent) {
    return false;
  }

  host.clearPromptRenderTimer();
  if (host.promptVisible) {
    host.clearInputRender();
    host.promptVisible = false;
  }
  host.pendingPromptToken = false;
  if (host.mode !== "closed") {
    host.mode = "executing";
  }
  return true;
}

export function setRuntimeVscodeRSessionActive(host: RuntimeHost, active: boolean): void {
  host.vscodeRSessionActivationPending = usesSessIntegration(host) && active;
  if (host.vscodeRSessionActivationPending) {
    flushRuntimeVscodeRSessionActivation(host);
  }
}

function flushRuntimeVscodeRSessionActivation(host: RuntimeHost): void {
  if (!host.vscodeRSessionActivationPending || !canSubmitHiddenRuntimeCommand(host)) {
    return;
  }
  if (submitHiddenRuntimeCommand(host, buildSessAttachNotificationCommand())) {
    host.vscodeRSessionActivationPending = false;
  }
}

async function reconnectVscodeRSessionForRestoredRuntime(host: RuntimeHost): Promise<void> {
  if (!host.vscodeRSessionReconnectPending || !usesSessIntegration(host)) {
    return;
  }
  if (vscodeRSessionReconnectInFlight.has(host)) {
    return;
  }
  if (!host.runtimeBackend?.canUseSessionCommands(host.rProcess)) {
    return;
  }

  vscodeRSessionReconnectNoiseUntil.set(host, Date.now() + 10000);
  vscodeRSessionReconnectInFlight.add(host);
  try {
    const connection = await resolveCurrentVscodeRSessionConnection(host);
    if (!connection) {
      return;
    }
    const alreadyConnected =
      vscodeRSessionProxies.get(host)?.isConnected() ?? false;

    const pid = isLivePid(host.backendChildPid)
      ? host.backendChildPid
      : host.runtimeBackend.getPid(host.rProcess);
    if (isLivePid(pid)) {
      await writeVscodeRSessionFile(host, pid, connection);
    }

    if (alreadyConnected) {
      host.vscodeRSessionReconnectPending = false;
      return;
    }

    if (submitHiddenRuntimeCommand(host, buildSessConnectCommand(connection))) {
      host.vscodeRSessionReconnectPending = false;
    }
  } finally {
    vscodeRSessionReconnectInFlight.delete(host);
  }
}

function removeVscodeRSessionFile(host: RuntimeHost): void {
  const filePath = vscodeRSessionFiles.get(host);
  vscodeRSessionFiles.delete(host);
  clearVscodeRSessionConnection(host);
  if (!filePath) {
    return;
  }
  void fs.promises.rm(filePath, { force: true }).catch(() => undefined);
}

export async function getRuntimeWorkspaceData(
  host: RuntimeHost
): Promise<WorkspaceData | undefined> {
  if (usesLegacySessionWatcher(host)) {
    return await host.sessionWatcher?.requestWorkspaceData();
  }
  if (!usesSessIntegration(host)) {
    return undefined;
  }
  const proxy = vscodeRSessionProxies.get(host);
  return await proxy?.requestWorkspace();
}

export async function requestRuntimeMemberCompletions(
  host: RuntimeHost,
  expression: string,
  operator: "$" | "@"
): Promise<SessionMemberCompletionItem[] | undefined> {
  if (usesLegacySessionWatcher(host)) {
    return await host.sessionWatcher?.requestMemberCompletions(expression, operator);
  }
  if (!usesSessIntegration(host)) {
    return undefined;
  }
  return await vscodeRSessionProxies.get(host)?.requestMemberCompletions(expression, operator);
}

export async function startRuntime(host: RuntimeHost): Promise<void> {
  pendingRuntimeRewrites.delete(host);
  clearVscodeRSessionConnection(host);
  vscodeRSessionFiles.delete(host);
  host.clearPendingInputFlushTimer();
  host.clearPromptRenderTimer();
  host.lang.clearSessionState();
  host.clearPendingConsoleInput();
  host.pendingPromptToken = true;
  host.mode = "starting";
  host.promptReady = false;
  host.promptKind = "main";
  host.promptVisible = false;
  host.replyPromptText = "";
  host.pendingInitialPromptGap = true;
  host.submissionPending = false;
  host.awaitingExecutionStart = false;
  host.lastWriteEndedWithNewline = true;
  host.hasReceivedOutput = false;
  host.inputState.reset();
  host.submissionQueue = [];
  host.activeSubmission = null;
  host.backendChildPid = undefined;
  host.sessionAttached = false;
  host.sessionHostConnected = false;
  host.vscodeRSessionReconnectPending = false;
  host.vscodeRSessionActivationPending = false;

  if (!host.runtimeBackend) {
    const expectedPath = host.extensionPath ? getBundledRustSidecarPath(host.extensionPath) : "";
    const details = expectedPath ? `\r\nExpected bundled sidecar:\r\n- ${expectedPath}` : "";
    host.writeEmitter.fire(
      `${ANSI.red}Failed to start R: sidecar backend not found.${ANSI.reset}${details}\r\n`
    );
    host.mode = "closed";
    return;
  }

  try {
    const args = [host.options.rPath, ...host.options.rArgs];
    const runtimeEnv: NodeJS.ProcessEnv = { ...host.options.env };
    if (usesSessIntegration(host)) {
      const connection = await configureVscodeRSessionBootstrap(host, runtimeEnv);
      if (connection) {
        vscodeRSessionConnections.set(host, connection);
      } else {
        runtimeEnv.R_CONSOLE_SESSION_MODE = "disabled";
      }
    } else if (host.options.sessionMode === "legacy") {
      fs.mkdirSync(host.options.watcherDir, { recursive: true });
    }
    if (host.extensionPath) {
      runtimeEnv.VSC_R_EXT = host.extensionPath;
      runtimeEnv.VSC_R_COLS = String(Math.max(20, host.dimensions.columns || 80));
      runtimeEnv.VSC_R_ROWS = String(Math.max(5, host.dimensions.rows || 24));
      const consoleProfilePath = path.join(host.extensionPath, "resources", "r", "console-profile.R");
      if (!fs.existsSync(consoleProfilePath)) {
        throw new Error(`Console bootstrap script not found at ${consoleProfilePath}`);
      }
      runtimeEnv.R_PROFILE_USER = consoleProfilePath;
    }
    if (host.options.cwd) {
      runtimeEnv.VSC_R_SESSION_CWD = host.options.cwd;
    }

    host.rProcess = host.runtimeBackend.start(args, {
      cwd: host.options.cwd,
      env: runtimeEnv,
    });
    const vscodeRSessionProxy = vscodeRSessionProxies.get(host);
    if (vscodeRSessionProxy) {
      vscodeRSessionProxiesByRuntimeSession.set(host.rProcess.sessionId, vscodeRSessionProxy);
    }
    primeRuntimeAttach(host);
    setNativeParseCallback(null);
    attachRuntimeSession(host, true);

    updateRuntimeTerminalName(host);
  } catch (err) {
    host.writeEmitter.fire(
      `${ANSI.red}Failed to start R: ${String(err)}${ANSI.reset}\r\n`
    );
    host.rProcess = null;
    host.mode = "closed";
    host.sessionAttached = false;
  }
}

export function primeRuntimeAttach(
  host: RuntimeHost
): void {
  if (!usesLegacySessionWatcher(host)) {
    host.sessionAttached = true;
    return;
  }

  const runtimePid = host.runtimeBackend?.getPid(host.rProcess) ?? host.getDisplayPid();
  if (typeof runtimePid === "number" && Number.isFinite(runtimePid) && runtimePid > 0) {
    host.sessionWatcher?.setExpectedPid(runtimePid);
  }

  beginRuntimeAttach(host);
}

export function attachRuntimeSession(host: RuntimeHost, showStartupErrors: boolean = false): void {
  if (!host.runtimeBackend || !host.rProcess) {
    return;
  }
  if (usesSessIntegration(host)) {
    void refreshVscodeRSessionConnection(host);
  }
  if (!usesLegacySessionWatcher(host)) {
    host.sessionAttached = true;
  }
  setNativeParseCallback(null);
  host.runtimeBackend.attach(host.rProcess, {
    onStdout: (output) => {
      handleRuntimeOutput(host, output);
    },
    onStderr: (errorText) => {
      handleRuntimeError(host, errorText);
    },
    onControl: (event) => {
      handleRuntimeControl(host, event);
    },
    onExit: (code) => {
      handleRuntimeExit(host, code);
    },
    onError: (err) => {
      setNativeParseCallback(null);
      if (showStartupErrors) {
        host.writeEmitter.fire(
          `${ANSI.red}Failed to start R: ${err.message}${ANSI.reset}\r\n`
        );
      }
      const failedRuntime = host.rProcess;
      if (failedRuntime && host.runtimeBackend) {
        host.runtimeBackend.detach(failedRuntime);
        host.runtimeBackend.close(failedRuntime);
      }
      handleRuntimeExit(host, 1);
    },
  });
}

function beginRuntimeAttach(host: RuntimeHost): void {
  if (!host.sessionWatcher) {
    host.sessionAttached = true;
    return;
  }

  host.sessionWatcher.onAttach(() => onRuntimeAttached(host));
  void (async () => {
    await host.sessionWatcher?.start();
    host.sessionWatcher?.refresh();
    if (host.sessionWatcher?.isAttached()) {
      onRuntimeAttached(host);
    }
  })();
}

function onRuntimeAttached(host: RuntimeHost): void {
  if (host.sessionAttached) {
    return;
  }
  host.sessionAttached = true;
  host.onSessionDataChanged(host.sessionWatcher?.getWorkspaceData());
  updateRuntimeTerminalName(host);
  if (host.mode === "starting" && host.promptReady) {
    host.mode = "ready";
  }
  if (host.mode === "ready" && host.promptReady && !host.promptVisible) {
    host.pendingPromptToken = true;
    host.schedulePrompt();
    if (host.activeSubmission === null && host.promptKind === "main") {
      host.startNextSubmission();
    }
  }
}

export function handleRuntimeOutput(host: RuntimeHost, output: string): void {
  if (host.awaitingExecutionStart && host.activeSubmission) {
    host.awaitingExecutionStart = false;
  }
  host.hasReceivedOutput = true;
  host.clearPromptRenderTimer();
  host.clearReplyPromptRenderTimer();
  renderRuntimeOutput(host, output);
}

export function handleRuntimeControl(
  host: RuntimeHost,
  event: BackendControlEvent
): void {
  if (event.type !== "output-flush") {
    flushPendingRuntimeRewrite(host);
  }

  switch (event.type) {
    case "backend-ready":
      return;
    case "host-connected":
      host.sessionHostConnected = true;
      {
        const pid = isLivePid(host.backendChildPid)
          ? host.backendChildPid
          : host.runtimeBackend?.getPid(host.rProcess);
        if (isLivePid(pid) && usesSessIntegration(host)) {
          persistVscodeRSessionConnection(host, pid);
        }
      }
      updateNativeParseCallback(host);
      if (host.vscodeRSessionReconnectPending && usesSessIntegration(host)) {
        void refreshVscodeRSessionConnection(host);
      }
      return;
    case "prompt":
      handleBackendPrompt(host, event.kind);
      if (event.kind === "main" && usesSessIntegration(host)) {
        void reconnectVscodeRSessionForRestoredRuntime(host);
        flushRuntimeVscodeRSessionActivation(host);
      }
      return;
    case "busy":
      if (event.value) {
        if (host.awaitingExecutionStart && host.activeSubmission) {
          host.awaitingExecutionStart = false;
        }
        if (host.mode !== "reply" && (host.activeSubmission !== null || host.mode === "starting")) {
          host.mode = "executing";
        }
        return;
      }

      if (host.mode === "executing") {
        restoreReadyStateAfterExecution(host);
      }
      return;
    case "input-request":
      handleBackendInputRequest(host, event.prompt);
      return;
    case "input-end":
      if (host.mode === "reply") {
        host.clearReplyPromptRenderTimer();
        host.mode = host.activeSubmission ? "executing" : "ready";
        host.replyPromptText = "";
        host.inputState.reset();
      }
      return;
    case "dialog-request":
      void handleBackendDialogRequest(host, event.dialog);
      return;
    case "output-flush":
      if (host.mode === "reply" && !host.promptVisible) {
        host.scheduleReplyPrompt();
      } else if (
        !host.submissionPending &&
        host.mode === "ready" &&
        host.promptReady &&
        host.pendingPromptToken &&
        !host.promptVisible
      ) {
        host.schedulePrompt();
      }
      return;
    case "parse-status-result":
      return;
    case "host-error":
      if (event.message.trim().length > 0) {
        handleRuntimeError(
          host,
          event.message.endsWith("\n") ? event.message : `${event.message}\n`
        );
      }
      return;
    case "session-state":
      applyRuntimeSessionState(host, event);
      return;
  }
}

function applyRuntimeSessionState(
  host: RuntimeHost,
  event: Extract<BackendControlEvent, { type: "session-state" }>
): void {
  if (typeof event.pid === "number" && Number.isFinite(event.pid) && event.pid > 0) {
    host.backendChildPid = event.pid;
    updateRuntimeTerminalName(host);
    if (usesSessIntegration(host)) {
      persistVscodeRSessionConnection(host, event.pid);
    }
    if (usesLegacySessionWatcher(host)) {
      host.sessionWatcher?.setExpectedPid(event.pid);
    }
  }

  host.sessionHostConnected = true;
  updateNativeParseCallback(host);

  if (event.busy) {
    host.promptReady = false;
    host.promptVisible = false;
    host.pendingPromptToken = false;
    if (host.mode !== "closed") {
      host.mode = "executing";
    }
    return;
  }

  switch (event.wait.kind) {
    case "none":
      return;
    case "top-level":
      host.promptReady = true;
      host.promptKind = event.wait.prompt;
      host.replyPromptText = "";
      if (host.mode !== "closed") {
        host.mode = "ready";
      }
      if (!host.promptVisible) {
        host.pendingPromptToken = true;
      }
      if (event.wait.prompt === "main" && usesSessIntegration(host)) {
        void reconnectVscodeRSessionForRestoredRuntime(host);
        flushRuntimeVscodeRSessionActivation(host);
      }
      return;
    case "nested":
      host.promptReady = false;
      host.replyPromptText = event.wait.prompt;
      if (host.mode !== "closed") {
        host.mode = "reply";
      }
      return;
  }
}

function restoreReadyStateAfterExecution(host: RuntimeHost): void {
  if (host.submissionPending) {
    return;
  }

  if (host.activeSubmission) {
    // Top-level submissions are complete when R returns the next prompt, not
    // when Windows emits an intermediate busy(false) transition during redraws.
    host.awaitingExecutionStart = false;
    return;
  }

  host.mode = "ready";

  if (!host.promptReady || host.promptVisible) {
    return;
  }

  host.pendingPromptToken = true;
  host.schedulePrompt();
}

export function handleBackendPrompt(
  host: RuntimeHost,
  kind: "main" | "cont"
): void {
  if (host.awaitingExecutionStart && host.activeSubmission) {
    host.promptReady = true;
    host.promptKind = kind;
    host.replyPromptText = "";
    host.pendingPromptToken = false;
    return;
  }

  host.promptReady = true;
  host.promptKind = kind;
  host.replyPromptText = "";

  if (host.mode === "reply") {
    host.inputState.reset();
  }

  if (host.mode === "starting") {
    host.mode = "ready";
  } else if (host.activeSubmission) {
    if (kind === "main") {
      host.finishActiveSubmission();
    } else {
      host.activeSubmission = null;
      host.mode = "ready";
      void host.lang.refreshCompletionContextDocument(host.inputState.text);
    }
  } else {
    host.mode = "ready";
  }

  if (host.submissionPending) {
    host.pendingPromptToken = false;
    if (kind === "main" && host.mode === "ready" && host.activeSubmission === null) {
      host.startNextSubmission();
    }
    return;
  }

  if (host.sendPendingConsoleInput("top-level")) {
    return;
  }

  host.pendingPromptToken = true;
  host.schedulePrompt();
  if (kind === "main" && host.mode === "ready" && host.activeSubmission === null) {
    host.startNextSubmission();
  }
}

export function handleBackendInputRequest(
  host: RuntimeHost,
  prompt: string
): void {
  const { prelude, inlinePrompt } = splitReplyPrompt(prompt);
  host.replyPromptText = inlinePrompt;
  host.clearPromptRenderTimer();
  host.clearReplyPromptRenderTimer();
  host.pendingPromptToken = false;
  host.promptReady = false;
  host.inputState.reset();

  if (host.promptVisible) {
    host.clearInputRender();
    host.promptVisible = false;
  }

  if (prelude.length > 0) {
    host.writeEmitter.fire(prelude);
    host.lastWriteEndedWithNewline = /(\n|\r)$/.test(prelude);
    host.renderer.renderedLineCount = 1;
    host.renderer.cursorRowFromTop = 0;
    host.recordOutputActivity();
  }

  host.mode = "reply";
  if (host.sendPendingConsoleInput("nested")) {
    return;
  }
  host.scheduleReplyPrompt();
}

export function splitReplyPrompt(
  prompt: string
): { prelude: string; inlinePrompt: string } {
  const normalized = prompt.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lastNewline = normalized.lastIndexOf("\n");
  if (lastNewline < 0) {
    return { prelude: "", inlinePrompt: normalized };
  }

  return {
    prelude: normalized.slice(0, lastNewline + 1).replace(/\n/g, "\r\n"),
    inlinePrompt: normalized.slice(lastNewline + 1),
  };
}

async function handleBackendDialogRequest(
  host: RuntimeHost,
  dialog: BackendDialogRequest
): Promise<void> {
  switch (dialog.kind) {
    case "choose-file":
      await handleChooseFileDialog(host, dialog.newFile);
      return;
    case "edit-expression":
      await handleEditExpressionDialog(host, dialog.path);
      return;
    case "edit-files":
      await handleEditFilesDialog(host, dialog.paths);
      return;
  }
}

async function handleChooseFileDialog(
  host: RuntimeHost,
  newFile: boolean
): Promise<void> {
  let selectedPath: string | undefined;
  const defaultUri =
    host.options.cwd && path.isAbsolute(host.options.cwd)
      ? vscode.Uri.file(host.options.cwd)
      : undefined;

  try {
    if (newFile) {
      const uri = await vscode.window.showSaveDialog({ defaultUri });
      selectedPath = uri?.fsPath;
    } else {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri,
      });
      selectedPath = uris?.[0]?.fsPath;
    }
  } catch (error) {
    void vscode.window.showErrorMessage(`R Console file chooser failed: ${String(error)}`);
  }

  host.runtimeBackend?.sendSessionCommand(host.rProcess, {
    type: "dialog-result",
    result: {
      kind: "choose-file",
      path: selectedPath,
    },
  });
}

async function handleEditExpressionDialog(
  host: RuntimeHost,
  filePath: string
): Promise<void> {
  const completed = await runEditorSession(host, [filePath], true);

  host.runtimeBackend?.sendSessionCommand(host.rProcess, {
    type: "dialog-result",
    result: {
      kind: "edit-expression",
      completed,
    },
  });
}

async function handleEditFilesDialog(
  host: RuntimeHost,
  filePaths: string[]
): Promise<void> {
  const completed = await runEditorSession(host, filePaths, false);

  host.runtimeBackend?.sendSessionCommand(host.rProcess, {
    type: "dialog-result",
    result: {
      kind: "edit-files",
      completed,
    },
  });
}

async function runEditorSession(
  host: RuntimeHost,
  filePaths: readonly string[],
  normalizeTrailingNewline: boolean
): Promise<boolean> {
  try {
    const targetUris: vscode.Uri[] = [];
    const tabs: vscode.Tab[] = [];
    for (const filePath of filePaths) {
      const targetUri = await resolveEditorFileUri(host, filePath);
      targetUris.push(targetUri);
      const targetTab = await openEditorTab(targetUri);
      if (!tabs.includes(targetTab)) {
        tabs.push(targetTab);
      }
    }
    await waitForClosedTabs(tabs);
    if (normalizeTrailingNewline && targetUris.length > 0) {
      await ensureTrailingNewline(targetUris[0]);
    }
    return true;
  } catch (error) {
    void vscode.window.showErrorMessage(`R Console editor session failed: ${String(error)}`);
    return false;
  }
}

async function resolveEditorFileUri(
  host: RuntimeHost,
  filePath: string
): Promise<vscode.Uri> {
  const resolvedPath =
    path.isAbsolute(filePath)
      ? filePath
      : path.resolve(host.options.cwd ?? process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.promises.writeFile(resolvedPath, "");
  }
  const canonicalPath = await fs.promises.realpath(resolvedPath).catch(() => resolvedPath);
  return vscode.Uri.file(canonicalPath);
}

async function openEditorTab(targetUri: vscode.Uri): Promise<vscode.Tab> {
  const existingTabs = getTextTabs(targetUri);
  const document = await vscode.workspace.openTextDocument(targetUri);
  await vscode.window.showTextDocument(document, { preview: false });

  const activeTab = getActiveTextTab(targetUri);
  if (activeTab) {
    return activeTab;
  }

  const openedTab = getTextTabs(targetUri).find((tab) => !existingTabs.includes(tab));
  if (openedTab) {
    return openedTab;
  }

  throw new Error(`failed to track editor tab for ${targetUri.fsPath}`);
}

function waitForClosedTabs(tabs: readonly vscode.Tab[]): Promise<void> {
  if (tabs.length === 0 || tabs.every((tab) => !isTabOpen(tab))) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const remaining = new Set(tabs);
    const finishIfDone = (): void => {
      for (const tab of [...remaining]) {
        if (!isTabOpen(tab)) {
          remaining.delete(tab);
        }
      }
      if (remaining.size === 0) {
        subscription.dispose();
        resolve();
      }
    };

    const subscription = vscode.window.tabGroups.onDidChangeTabs((event) => {
      for (const tab of event.closed) {
        remaining.delete(tab);
      }
      finishIfDone();
    });

    finishIfDone();
  });
}

function getTextTabs(targetUri: vscode.Uri): vscode.Tab[] {
  const targetKey = targetUri.toString();
  const matches: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === targetKey) {
        matches.push(tab);
      }
    }
  }
  return matches;
}

function getActiveTextTab(targetUri: vscode.Uri): vscode.Tab | undefined {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (
    activeTab?.input instanceof vscode.TabInputText &&
    activeTab.input.uri.toString() === targetUri.toString()
  ) {
    return activeTab;
  }
  return undefined;
}

function isTabOpen(targetTab: vscode.Tab): boolean {
  return vscode.window.tabGroups.all.some((group) => group.tabs.includes(targetTab));
}

async function ensureTrailingNewline(targetUri: vscode.Uri): Promise<void> {
  let content: Buffer;
  try {
    content = await fs.promises.readFile(targetUri.fsPath);
  } catch {
    return;
  }

  if (content.length === 0) {
    return;
  }

  const lastByte = content[content.length - 1];
  if (lastByte === 0x0a || lastByte === 0x0d) {
    return;
  }

  const newline = content.toString("utf8").includes("\r\n") ? "\r\n" : "\n";
  await fs.promises.appendFile(targetUri.fsPath, newline);
}

export function renderRuntimeOutput(host: RuntimeHost, text: string): void {
  if (!text) {
    return;
  }

  const formatted = filterSessRuntimeOutput(host, formatViewOutput(text));
  if (!formatted) {
    return;
  }
  renderRuntimeText(host, formatted, didOutputEndWithLineFeed(formatted));
}

export function handleRuntimeError(host: RuntimeHost, error: string): void {
  host.hasReceivedOutput = true;
  host.clearPromptRenderTimer();
  host.clearReplyPromptRenderTimer();
  const formatted = formatViewOutput(stripBracketedPasteMarkers(error));
  renderRuntimeText(
    host,
    colorRuntimeText(formatted, ANSI.red, ANSI.reset),
    didOutputEndWithLineFeed(formatted)
  );
}

function renderRuntimeText(
  host: RuntimeHost,
  text: string,
  endedWithLineFeed: boolean
): void {
  if (!text) {
    return;
  }

  const pending = getPendingRuntimeRewrite(host);
  if (pending.clearFrame) {
    if (shouldReplacePendingClearFrame(text)) {
      pending.clearFrame = null;
    } else {
      const pendingClearFrame = pending.clearFrame;
      pending.clearFrame = null;
      writeRuntimeText(
        host,
        pendingClearFrame.text,
        pendingClearFrame.endedWithLineFeed
      );
    }
  }

  if (pending.bareCarriageReturn) {
    pending.bareCarriageReturn = false;
    if (text === "\r") {
      pending.bareCarriageReturn = true;
      return;
    }
    if (shouldPrefixPendingCarriageReturn(text)) {
      text = `\r${text}`;
      endedWithLineFeed = didOutputEndWithLineFeed(text);
    } else if (!text.startsWith("\r")) {
      writeRuntimeText(host, "\r", false);
    }
  }

  if (text === "\r") {
    pending.bareCarriageReturn = true;
    return;
  }

  if (shouldDeferClearFrame(text)) {
    pending.clearFrame = {
      text,
      endedWithLineFeed,
    };
    return;
  }

  writeRuntimeText(host, text, endedWithLineFeed);
}

function writeRuntimeText(
  host: RuntimeHost,
  text: string,
  endedWithLineFeed: boolean
): void {
  const shouldRestoreReplyPrompt = host.mode === "reply";
  const shouldRestoreReadyPrompt =
    endedWithLineFeed &&
    !host.submissionPending &&
    host.mode === "ready" &&
    host.promptReady &&
    host.activeSubmission === null &&
    (host.pendingPromptToken || host.promptVisible || host.inputState.text.length > 0);
  const shouldRearmReadyPrompt =
    !host.submissionPending &&
    host.mode === "ready" &&
    host.promptReady &&
    host.activeSubmission === null &&
    (host.promptVisible || host.inputState.text.length > 0);
  host.recordOutputActivity();
  if (host.promptVisible || host.inputState.text.length > 0) {
    host.clearInputRender();
    host.promptVisible = false;
    if (shouldRearmReadyPrompt) {
      host.pendingPromptToken = true;
    }
  }

  if (isSimpleCarriageReturnRewrite(text)) {
    host.writeEmitter.fire(rewriteSimpleCarriageReturnOutput(text));
  } else {
    host.writeEmitter.fire(text);
  }

  host.lastWriteEndedWithNewline = endedWithLineFeed;
  host.renderer.renderedLineCount = 1;
  host.renderer.cursorRowFromTop = 0;

  if (shouldRestoreReplyPrompt) {
    host.scheduleReplyPrompt();
  } else if (shouldRestoreReadyPrompt) {
    host.pendingPromptToken = true;
    host.schedulePrompt();
  }
}

function filterSessRuntimeOutput(host: RuntimeHost, text: string): string {
  let filtered = text.replace(SESS_ASYNC_PROMPT_PATTERN, "$1\r\n");
  const suppressReconnectNoise =
    host.vscodeRSessionReconnectPending ||
    (vscodeRSessionReconnectNoiseUntil.get(host) ?? 0) > Date.now();
  if (suppressReconnectNoise) {
    filtered = filtered.replace(SESS_RECONNECT_NOISE_PATTERN, "");
  }
  return filtered;
}

function shouldPrefixPendingCarriageReturn(text: string): boolean {
  return !text.startsWith("\r") && !text.includes("\n");
}

function shouldDeferClearFrame(text: string): boolean {
  return /^\r\s*\| +$/.test(stripSgrCodes(text));
}

function shouldReplacePendingClearFrame(text: string): boolean {
  return text.startsWith("\r") && !text.includes("\n");
}

function isSimpleCarriageReturnRewrite(text: string): boolean {
  const withoutSgr = stripSgrCodes(text);
  return (
    withoutSgr.startsWith("\r") &&
    !withoutSgr.includes("\n") &&
    !withoutSgr.includes("\b") &&
    !/\x1b/.test(withoutSgr)
  );
}

function rewriteSimpleCarriageReturnOutput(text: string): string {
  return `\x1b[2K\x1b[1G${text.slice(1)}`;
}

function colorRuntimeText(text: string, prefix: string, suffix: string): string {
  if (!text || text === "\r") {
    return text;
  }

  if (text.startsWith("\r") && !text.startsWith("\r\n")) {
    return `\r${prefix}${text.slice(1)}${suffix}`;
  }

  return `${prefix}${text}${suffix}`;
}

function stripSgrCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function didOutputEndWithLineFeed(text: string): boolean {
  return text.endsWith("\r\n");
}

function getPendingRuntimeRewrite(host: RuntimeHost): PendingRuntimeRewrite {
  let pending = pendingRuntimeRewrites.get(host);
  if (!pending) {
    pending = {
      bareCarriageReturn: false,
      clearFrame: null,
    };
    pendingRuntimeRewrites.set(host, pending);
  }
  return pending;
}

function flushPendingRuntimeRewrite(host: RuntimeHost): void {
  const pending = pendingRuntimeRewrites.get(host);
  if (!pending) {
    return;
  }

  if (pending.clearFrame) {
    const clearFrame = pending.clearFrame;
    pending.clearFrame = null;
    writeRuntimeText(host, clearFrame.text, clearFrame.endedWithLineFeed);
  }

  if (pending.bareCarriageReturn) {
    pending.bareCarriageReturn = false;
    writeRuntimeText(host, "\r", false);
  }
}

export function sendRuntimeReply(host: RuntimeHost, text: string): void {
  host.clearReplyPromptRenderTimer();
  const sent =
    host.runtimeBackend?.sendSessionCommand(host.rProcess, {
      type: "reply-input",
      text,
    }) ?? false;

  if (!sent) {
    host.scheduleReplyPrompt();
    return;
  }

  if (host.promptVisible) {
    host.captureVisibleInputForReplay();
    host.writeEmitter.fire("\r\n");
    host.lastWriteEndedWithNewline = true;
    host.renderer.renderedLineCount = 1;
    host.renderer.cursorRowFromTop = 0;
    host.promptVisible = false;
  }
  host.inputState.reset();
  host.mode = host.activeSubmission ? "executing" : "ready";
  host.awaitingExecutionStart = false;
  host.replyPromptText = "";
}

export function startRuntimeSubmission(host: RuntimeHost, task: Submission): void {
  host.submissionPending = false;
  host.pendingPromptToken = false;
  host.awaitingExecutionStart = true;
  host.mode = "executing";
  writeRuntimeSubmissionEcho(host, task);
  host.clearPromptRenderTimer();
  host.runtimeBackend?.sendSessionCommand(host.rProcess, {
    type: "submit",
    code: task.code,
  });
}

export function finishRuntimeSubmission(host: RuntimeHost): void {
  host.activeSubmission = null;
  host.awaitingExecutionStart = false;
  host.mode = "ready";
  void host.lang.refreshCompletionContextDocument(host.inputState.text);
}

export function startNextRuntimeSubmission(host: RuntimeHost): void {
  if (host.mode !== "ready" && !(host.mode === "executing" && host.activeSubmission === null)) {
    return;
  }
  if (host.activeSubmission) {
    return;
  }
  const task = host.submissionQueue.shift();
  if (!task) {
    return;
  }
  host.activeSubmission = task;
  startRuntimeSubmission(host, task);
}

export async function enqueueRuntimeSubmission(
  host: RuntimeHost,
  code: string,
  skipSplit: boolean = false
) : Promise<string[]> {
  const blocks = skipSplit
    ? [normalizeSubmissionBlock(code)]
    : await splitSubmissionBlocks(host, code);

  if (blocks.length === 0) {
    host.submissionPending = false;
    host.awaitingExecutionStart = false;
    return [];
  }

  for (const block of blocks) {
    host.submissionQueue.push({
      code: block,
      initialPromptKind: host.promptKind,
    });
  }

  void host.lang.refreshCompletionContextDocument(host.inputState.text);
  startNextRuntimeSubmission(host);
  return blocks;
}

function normalizeSubmissionBlock(code: string): string {
  return stripCommentLines(code.replace(/\n+$/, ""))
    .replace(/^(?:[ \t]*[\r\n])+/, "")
    .trimEnd();
}

async function splitSubmissionBlocks(host: RuntimeHost, code: string): Promise<string[]> {
  const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let currentBlock = "";

  for (const line of lines) {
    currentBlock = currentBlock.length > 0 ? `${currentBlock}\n${line}` : line;
    const normalizedBlock = normalizeSubmissionBlock(currentBlock);

    if (!normalizedBlock.trim()) {
      continue;
    }

    const isComplete = await host.inputState.isExpressionCompleteAsync(normalizedBlock);
    if (!isComplete) {
      continue;
    }

    blocks.push(normalizedBlock);
    currentBlock = "";
  }

  const trailingBlock = normalizeSubmissionBlock(currentBlock);
  if (trailingBlock.trim() && (await host.inputState.isExpressionCompleteAsync(trailingBlock))) {
    blocks.push(trailingBlock);
  }

  return blocks;
}

function writeRuntimeSubmissionEcho(host: RuntimeHost, task: Submission): void {
  if ((host.mode !== "ready" && host.mode !== "executing") || !host.promptReady) {
    return;
  }

  host.historyBrowsing = false;
  host.historyCollapsed = true;

  configureMainPrompt(host.renderer);

  if (host.promptVisible || host.inputState.text.length > 0) {
    host.clearInputRender();
    host.promptVisible = false;
  } else {
    if (host.pendingInitialPromptGap) {
      if (host.hasReceivedOutput) {
        host.writeEmitter.fire("\r\n");
      }
      host.lastWriteEndedWithNewline = true;
      host.pendingInitialPromptGap = false;
    } else if (!host.lastWriteEndedWithNewline) {
      host.writeEmitter.fire("\r\n");
      host.lastWriteEndedWithNewline = true;
    }
  }

  host.pendingPromptToken = false;
  const plainLines = task.code.split("\n");
  host.syntax.setSource(plainLines);
  const plan = buildSubmissionRenderPlan(
    plainLines,
    Math.max(1, host.dimensions.rows - 1),
    host.dimensions.columns,
    host.renderer.promptLen,
    getContinuationPromptLength(host.renderer.continuationPromptText)
  );
  const styledLines = host.syntax.highlightLines(plan.lines, plan.sourceLineMap);
  const promptKinds = [...plan.promptKinds];
  if (task.initialPromptKind === "cont" && promptKinds.length > 0) {
    promptKinds[0] = "cont";
  }
  writeRuntimeSubmissionLines(host, styledLines, promptKinds);
  host.promptVisible = false;
}

function writeRuntimeSubmissionLines(
  host: RuntimeHost,
  styledLines: string[],
  promptKinds: Array<"main" | "cont">
): void {
  const continuationPad = 2;

  styledLines.forEach((line, index) => {
    if (index > 0) {
      host.writeEmitter.fire("\r\n");
    }
    const promptKind = promptKinds[index] ?? (index === 0 ? "main" : "cont");
    const prompt =
      promptKind === "main"
        ? `${ANSI.reset}${host.renderer.promptColor}${host.renderer.promptText}${ANSI.reset}`
        : (host.renderer.continuationPromptText === null
            ? " ".repeat(continuationPad)
            : `${ANSI.reset}${host.renderer.continuationPromptColor}${host.renderer.continuationPromptText}${ANSI.reset}`);
    host.writeEmitter.fire(prompt + line);
  });

  host.writeEmitter.fire("\r\n");
  host.lastWriteEndedWithNewline = true;
  host.renderer.renderedLineCount = 1;
  host.renderer.cursorRowFromTop = 0;
}
export function interruptRuntime(host: RuntimeHost): void {
  if (!host.rProcess || !host.runtimeBackend?.isAlive(host.rProcess)) {
    return;
  }

  const sendInterrupt = (): boolean =>
    host.runtimeBackend?.sendSessionCommand(host.rProcess, {
      type: "interrupt",
    }) ?? false;

  if (host.isSessionProtocolActive() && host.mode === "executing") {
    if (!sendInterrupt()) {
      return;
    }
    host.writeEmitter.fire("^C\r\n");
    host.inputState.reset();
    host.promptVisible = false;
    host.pendingPromptToken = false;
    host.clearPendingConsoleInput();
    return;
  }

  if (host.isSessionProtocolActive() && host.mode === "reply") {
    if (!sendInterrupt()) {
      host.scheduleReplyPrompt();
      return;
    }
    host.clearReplyPromptRenderTimer();
    host.writeEmitter.fire("^C\r\n");
    host.clearInputRender();
    host.inputState.reset();
    host.promptVisible = false;
    host.replyPromptText = "";
    host.mode = "executing";
    host.clearPendingConsoleInput();
    return;
  }

  if (host.mode === "ready" && host.inputState.text.length > 0) {
    host.clearInputRender();
    host.inputState.reset();
    host.renderInput();
    host.clearPendingConsoleInput();
    return;
  }

  if (!sendInterrupt()) {
    return;
  }

  host.writeEmitter.fire("^C\r\n");
  host.inputState.reset();
  host.promptVisible = false;
  host.clearPendingConsoleInput();
}

export function handleRuntimeExit(host: RuntimeHost, code: number): void {
  removeVscodeRSessionFile(host);
  host.clearPendingInputFlushTimer();
  host.clearPromptRenderTimer();
  host.clearReplyPromptRenderTimer();
  host.clearPendingConsoleInput();
  flushPendingRuntimeRewrite(host);
  setNativeParseCallback(null);

  host.lang.clearSessionState();
  host.rProcess = null;
  host.backendChildPid = undefined;
  host.sessionHostConnected = false;
  host.mode = "closed";
  host.promptReady = false;
  host.promptVisible = false;
  host.replyPromptText = "";
  host.sessionAttached = false;
  host.awaitingExecutionStart = false;
  host.submissionPending = false;

  host.submissionQueue = [];
  host.activeSubmission = null;

  host.writeEmitter.fire(
    `\r\n${ANSI.yellow}R exited with code ${code}${ANSI.reset}\r\n`
  );
  host.closeEmitter.fire(code);
}

function updateNativeParseCallback(host: RuntimeHost): void {
  if (
    !host.runtimeBackend ||
    !host.rProcess ||
    !host.sessionHostConnected ||
    !host.runtimeBackend.hasCapability(host.rProcess, "parse-status")
  ) {
    setNativeParseCallback(null);
    return;
  }

  setNativeParseCallback(async (code: string) => {
    const request = host.runtimeBackend?.requestParseStatus(host.rProcess, code);
    if (!request) {
      return 1;
    }
    return await request;
  });
}
