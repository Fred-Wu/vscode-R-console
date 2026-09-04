import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { RuntimeHost } from "../../../Terminal/rTerminal/runtime";
import { BaseVscodeRSessionIntegration } from "../integration";
import type {
  SessionMemberCompletionItem,
  WorkspaceData,
} from "../types";
import { SessProxy } from "./sessProxy";

type VscodeRSessionConnection = {
  pipePath: string;
  jgdSocket?: string;
  attachCommand?: string;
};

const VSCODE_R_EXTENSION_ID = "REditorSupport.r";
const SESS_ASYNC_PROMPT_PATTERN = /(\r?\[sess\][^\r\n]*)(?:\r\n|\n){2}> ?/g;
const SESS_RECONNECT_NOISE_PATTERN =
  /\r?\[sess\] Failed to connect to IPC pipe: [^\r\n]*(?:\r\n|\n)?/g;

let connectionDiscovery: Promise<VscodeRSessionConnection | undefined> | undefined;
const proxiesByRuntimeSession = new Map<string, SessProxy>();
const attachCommandsByProxy = new WeakMap<SessProxy, string>();

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

async function pruneStaleSessionFiles(): Promise<void> {
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
): string | undefined {
  const quote = text[startIndex];
  if (quote !== "\"" && quote !== "'") {
    return undefined;
  }

  let value = "";
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === quote) {
      return value;
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
  return parseRStringLiteralAt(command, index);
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
  return parseRStringLiteralAt(content, index);
}

async function parsePipeAttachCommand(
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
        )
      : undefined;
    return { pipePath, jgdSocket, attachCommand: command.trim() };
  } catch {
    return undefined;
  }
}

async function discoverSessionConnection(): Promise<
  VscodeRSessionConnection | undefined
> {
  await pruneStaleSessionFiles();

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

      const connection = await parsePipeAttachCommand(currentClipboard);
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
        } catch {
        }
      }
    }
  }
}

function getSessionConnection(): Promise<VscodeRSessionConnection | undefined> {
  if (!connectionDiscovery) {
    connectionDiscovery = discoverSessionConnection().finally(() => {
      connectionDiscovery = undefined;
    });
  }
  return connectionDiscovery;
}

function asRLogical(value: boolean | undefined, defaultValue: boolean): string {
  return (value ?? defaultValue) ? "TRUE" : "FALSE";
}

function quoteRString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function resolvePlotBackend(
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

function buildConnectCommand(connection: VscodeRSessionConnection): string {
  const rConfig = vscode.workspace.getConfiguration("r");
  const plotBackend = resolvePlotBackend(rConfig);
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

function buildAttachNotificationCommand(): string {
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

export class SessVscodeRIntegration extends BaseVscodeRSessionIntegration {
  private connection: VscodeRSessionConnection | undefined;
  private connectionRefresh: Promise<VscodeRSessionConnection | undefined> | undefined;
  private sessionFile: string | undefined;
  private proxy: SessProxy | undefined;
  private reconnectInFlight = false;
  private reconnectNoiseUntil = 0;
  private reconnectPending: boolean;
  private mainPromptObserved: boolean;
  private active = false;
  private activationPending = false;

  constructor(host: RuntimeHost) {
    super(host);
    this.reconnectPending = Boolean(host.rProcess);
    this.mainPromptObserved = !this.reconnectPending;
  }

  static disposeForRuntimeSession(sessionId: string): void {
    const proxy = proxiesByRuntimeSession.get(sessionId);
    proxiesByRuntimeSession.delete(sessionId);
    proxy?.dispose();
  }

  override resetForStart(): void {
    this.clearConnection();
    this.sessionFile = undefined;
    this.reconnectPending = false;
    this.mainPromptObserved = true;
    this.activationPending = false;
    this.reconnectInFlight = false;
    this.reconnectNoiseUntil = 0;
  }

  override async prepareStart(env: NodeJS.ProcessEnv): Promise<void> {
    const bootstrapPath = path.join(
      this.host.extensionPath,
      "resources",
      "r",
      "VSCR",
      "sess.R"
    );
    if (!fs.existsSync(bootstrapPath)) {
      throw new Error(`vscode-R sess bootstrap script not found at ${bootstrapPath}`);
    }

    const connection = await this.createProxiedConnection();
    if (!connection) {
      delete env.R_CONSOLE_SESSION_BOOTSTRAP;
      void vscode.window.showWarningMessage(
        "R Console could not obtain vscode-R session connection info. The console will start without vscode-R session attachment."
      );
      return;
    }

    this.connection = connection;
    env.R_CONSOLE_SESSION_BOOTSTRAP = bootstrapPath;
    env.SESS_PIPE = connection.pipePath;
    const rConfig = vscode.workspace.getConfiguration("r");
    const plotBackend = resolvePlotBackend(rConfig);
    env.SESS_RSTUDIOAPI = asRLogical(
      rConfig.get<boolean>("session.emulateRStudioAPI"),
      true
    );
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
    delete env.VSCODE_INIT_R;
    delete env.VSCODE_WATCHER_DIR;
    delete env.SESS_PORT;
    delete env.SESS_TOKEN;
    delete env.SESS_HOST;
  }

  override afterRuntimeStarted(): void {
    if (this.proxy && this.host.rProcess) {
      proxiesByRuntimeSession.set(this.host.rProcess.sessionId, this.proxy);
    }
  }

  override attachRuntime(): void {
    // Restoring the persistent runtime only reattaches the console UI to the
    // sidecar. Defer its new sess connection until this console is focused.
    if (!this.reconnectPending) {
      void this.refreshConnection();
    }
  }

  override handleHostConnected(): void {
    const pid = isLivePid(this.host.backendChildPid)
      ? this.host.backendChildPid
      : this.host.runtimeBackend?.getPid(this.host.rProcess);
    if (isLivePid(pid)) {
      this.persistConnection(pid);
    }
    if (this.reconnectPending && this.active) {
      void this.refreshConnection();
    }
  }

  override handleMainPrompt(): void {
    this.mainPromptObserved = true;
    if (this.reconnectPending) {
      if (this.active) {
        void this.reconnectRestoredRuntime();
      }
      return;
    }
    this.flushActivation();
  }

  override handleRuntimePid(pid: number): void {
    this.persistConnection(pid);
  }

  override setActive(active: boolean): void {
    this.active = active;
    this.activationPending = active;
    if (!active) {
      return;
    }
    if (this.reconnectPending) {
      if (!this.mainPromptObserved || !this.canSubmitHiddenCommand()) {
        void this.refreshConnection();
      } else {
        void this.reconnectRestoredRuntime();
      }
      return;
    }
    this.flushActivation();
  }

  isRedundantAttachSubmission(code: string): boolean {
    const proxy = this.proxy;
    return Boolean(
      proxy?.isConnected() &&
      code.trim() === attachCommandsByProxy.get(proxy)
    );
  }

  override getCachedWorkspaceData(): WorkspaceData | undefined {
    return this.proxy?.getWorkspaceData();
  }

  override async requestWorkspaceData(): Promise<WorkspaceData | undefined> {
    return await this.proxy?.requestWorkspace();
  }

  override refreshWorkspaceData(): void {
    void this.proxy?.requestWorkspace();
  }

  override async requestMemberCompletions(
    expression: string,
    operator: "$" | "@"
  ): Promise<SessionMemberCompletionItem[] | undefined> {
    return await this.proxy?.requestMemberCompletions(expression, operator);
  }

  override filterRuntimeOutput(text: string): string {
    let filtered = text.replace(SESS_ASYNC_PROMPT_PATTERN, "$1\r\n");
    if (this.reconnectPending || this.reconnectNoiseUntil > Date.now()) {
      filtered = filtered.replace(SESS_RECONNECT_NOISE_PATTERN, "");
    }
    return filtered;
  }

  override handleRuntimeExit(): void {
    this.removeSessionFile();
    this.reconnectPending = false;
    this.activationPending = false;
  }

  override disposeUi(): void {
    this.proxy?.setWorkspaceDataListener(undefined);
  }

  private clearConnection(): void {
    const proxy = this.proxy;
    this.connection = undefined;
    this.proxy = undefined;
    const sessionId = this.host.rProcess?.sessionId;
    if (sessionId && proxiesByRuntimeSession.get(sessionId) === proxy) {
      proxiesByRuntimeSession.delete(sessionId);
    }
    proxy?.dispose();
  }

  private async createProxiedConnection(): Promise<
    VscodeRSessionConnection | undefined
  > {
    const upstreamConnection = await getSessionConnection();
    if (!upstreamConnection) {
      return undefined;
    }

    const proxy = new SessProxy({
      upstreamPipePath: upstreamConnection.pipePath,
      onWorkspaceData: (data) => this.host.onSessionDataChanged(data),
    });
    try {
      const pipePath = await proxy.start();
      if (upstreamConnection.attachCommand) {
        attachCommandsByProxy.set(proxy, upstreamConnection.attachCommand);
      }
      this.clearConnection();
      this.proxy = proxy;
      const sessionId = this.host.rProcess?.sessionId;
      if (sessionId) {
        proxiesByRuntimeSession.set(sessionId, proxy);
      }
      return { ...upstreamConnection, pipePath };
    } catch {
      proxy.dispose();
      return undefined;
    }
  }

  private async resolveCurrentConnection(): Promise<
    VscodeRSessionConnection | undefined
  > {
    if (this.connection) {
      return this.connection;
    }

    const sessionId = this.host.rProcess?.sessionId;
    const proxy = sessionId ? proxiesByRuntimeSession.get(sessionId) : undefined;
    const pipePath = proxy?.getPipePath();
    if (proxy?.isConnected() && pipePath) {
      proxy.setWorkspaceDataListener((data) => this.host.onSessionDataChanged(data));
      this.proxy = proxy;
      this.connection = { pipePath };
      return this.connection;
    }
    if (proxy && sessionId) {
      proxiesByRuntimeSession.delete(sessionId);
      proxy.dispose();
    }

    if (!this.connectionRefresh) {
      this.connectionRefresh = this.createProxiedConnection().finally(() => {
        this.connectionRefresh = undefined;
      });
    }
    const connection = await this.connectionRefresh;
    if (connection) {
      this.connection = connection;
    }
    return connection;
  }

  private async writeSessionFile(
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
      this.sessionFile = filePath;
    } catch {
      await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    }
  }

  private persistConnection(pid: number): void {
    if (!isLivePid(pid) || !this.connection) {
      return;
    }
    void this.writeSessionFile(pid, this.connection);
  }

  private async refreshConnection(): Promise<void> {
    const pid = isLivePid(this.host.backendChildPid)
      ? this.host.backendChildPid
      : this.host.runtimeBackend?.getPid(this.host.rProcess);
    const connection = await this.resolveCurrentConnection();
    if (connection && isLivePid(pid)) {
      await this.writeSessionFile(pid, connection);
    }
  }

  private canSubmitHiddenCommand(): boolean {
    return Boolean(
      this.host.mode === "ready" &&
        this.host.promptReady &&
        this.host.promptKind === "main" &&
        this.host.activeSubmission === null &&
        !this.host.submissionPending &&
        this.host.inputState.text.length === 0 &&
        this.host.runtimeBackend?.canUseSessionCommands(this.host.rProcess)
    );
  }

  private submitHiddenCommand(code: string): boolean {
    const sent = this.host.runtimeBackend?.sendSessionCommand(this.host.rProcess, {
      type: "submit",
      code,
    }) ?? false;
    if (!sent) {
      return false;
    }

    this.host.clearPromptRenderTimer();
    if (this.host.promptVisible) {
      this.host.clearInputRender();
      this.host.promptVisible = false;
    }
    this.host.pendingPromptToken = false;
    if (this.host.mode !== "closed") {
      this.host.mode = "executing";
    }
    return true;
  }

  private flushActivation(): void {
    if (!this.activationPending || !this.canSubmitHiddenCommand()) {
      return;
    }
    if (this.submitHiddenCommand(buildAttachNotificationCommand())) {
      this.activationPending = false;
    }
  }

  private async reconnectRestoredRuntime(): Promise<void> {
    if (
      !this.reconnectPending ||
      this.reconnectInFlight ||
      !this.mainPromptObserved ||
      !this.canSubmitHiddenCommand()
    ) {
      return;
    }

    this.reconnectNoiseUntil = Date.now() + 10000;
    this.reconnectInFlight = true;
    try {
      const connection = await this.resolveCurrentConnection();
      const runtimeBackend = this.host.runtimeBackend;
      if (!connection || !this.active || !runtimeBackend) {
        return;
      }
      const pid = isLivePid(this.host.backendChildPid)
        ? this.host.backendChildPid
        : runtimeBackend.getPid(this.host.rProcess);
      if (isLivePid(pid)) {
        await this.writeSessionFile(pid, connection);
      }
      if (!this.active || !this.reconnectPending) {
        return;
      }

      if (this.proxy?.isConnected()) {
        this.reconnectPending = false;
        this.flushActivation();
        return;
      }
      if (
        this.canSubmitHiddenCommand() &&
        this.submitHiddenCommand(buildConnectCommand(connection))
      ) {
        this.reconnectPending = false;
        // sess::connect() sends the attach notification itself. Later focus
        // changes use flushActivation() to select this existing connection.
        this.activationPending = false;
      }
    } finally {
      this.reconnectInFlight = false;
    }
  }

  private removeSessionFile(): void {
    const filePath = this.sessionFile;
    this.sessionFile = undefined;
    this.clearConnection();
    if (filePath) {
      void fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    }
  }
}

export function disposeSessProxyForRuntimeSession(sessionId: string): void {
  SessVscodeRIntegration.disposeForRuntimeSession(sessionId);
}
