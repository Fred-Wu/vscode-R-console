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
  useRStudioApi?: boolean;
  useHttpgd?: boolean;
  useJgd?: boolean;
  attachCommand?: string;
};

type ProxiedSession = {
  proxy: SessProxy;
  connection: VscodeRSessionConnection;
};

const VSCODE_R_EXTENSION_ID = "REditorSupport.r";
const SESS_ASYNC_PROMPT_PATTERN = /(\r?\[sess\][^\r\n]*)(?:\r\n|\n){2}> ?/g;
const SESS_RECONNECT_NOISE_PATTERN =
  /\r?\[sess\] Failed to connect to IPC pipe: [^\r\n]*(?:\r\n|\n)?/g;

let connectionDiscovery: Promise<VscodeRSessionConnection | undefined> | undefined;
const sessionsByRuntimeSession = new Map<string, ProxiedSession>();

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

function parseNamedRLogical(content: string, name: string): boolean | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(TRUE|FALSE)\\b`).exec(content);
  return match ? match[1] === "TRUE" : undefined;
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
    return {
      pipePath,
      jgdSocket,
      useRStudioApi: vscode.workspace
        .getConfiguration("r")
        .get<boolean>("session.emulateRStudioAPI", true),
      useHttpgd: parseNamedRLogical(content, "use_httpgd"),
      useJgd: parseNamedRLogical(content, "use_jgd"),
      attachCommand: command.trim(),
    };
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

function getPlotBackend(
  { useHttpgd, useJgd }: VscodeRSessionConnection
): "auto" | "standard" | "httpgd" | "jgd" | undefined {
  if (useHttpgd === undefined || useJgd === undefined) {
    return undefined;
  }
  return useHttpgd ? (useJgd ? "auto" : "httpgd") : (useJgd ? "jgd" : "standard");
}

function quoteRString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function setOwnerOnlyPermissions(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await fs.promises.chmod(filePath, 0o600);
}

function buildConnectCommand(connection: VscodeRSessionConnection): string {
  const jgdSocketCommand = connection.jgdSocket
    ? `Sys.setenv(JGD_SOCKET=${quoteRString(connection.jgdSocket)});`
    : "Sys.unsetenv(\"JGD_SOCKET\");";
  return [
    "if (requireNamespace(\"sess\", quietly = TRUE) && \"pipe_path\" %in% names(formals(sess::connect))) {",
    jgdSocketCommand,
    "sess::connect(",
    `pipe_path=${quoteRString(connection.pipePath)},`,
    `use_rstudioapi=${asRLogical(connection.useRStudioApi, true)},`,
    `use_httpgd=${asRLogical(connection.useHttpgd, true)},`,
    `use_jgd=${asRLogical(connection.useJgd, false)}`,
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
  private session: ProxiedSession | undefined;
  private connectionRefresh: Promise<ProxiedSession | undefined> | undefined;
  private sessionFile: string | undefined;
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
    const session = sessionsByRuntimeSession.get(sessionId);
    sessionsByRuntimeSession.delete(sessionId);
    session?.proxy.dispose();
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

    const session = await this.createProxiedSession();
    if (!session) {
      delete env.R_CONSOLE_SESSION_BOOTSTRAP;
      void vscode.window.showWarningMessage(
        "R Console could not obtain vscode-R session connection info. The console will start without vscode-R session attachment."
      );
      return;
    }

    const { connection } = session;
    env.R_CONSOLE_SESSION_BOOTSTRAP = bootstrapPath;
    env.SESS_PIPE = connection.pipePath;
    env.SESS_RSTUDIOAPI = asRLogical(connection.useRStudioApi, true);
    env.SESS_USE_HTTPGD = asRLogical(connection.useHttpgd, true);
    env.SESS_USE_JGD = asRLogical(connection.useJgd, false);
    const plotBackend = getPlotBackend(connection);
    if (plotBackend) {
      env.SESS_PLOT_BACKEND = plotBackend;
    } else {
      delete env.SESS_PLOT_BACKEND;
    }
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
    if (this.session && this.host.rProcess) {
      sessionsByRuntimeSession.set(this.host.rProcess.sessionId, this.session);
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
      if (!this.mainPromptObserved || !this.host.canSubmitHiddenCommand()) {
        void this.refreshConnection();
      } else {
        void this.reconnectRestoredRuntime();
      }
      return;
    }
    this.flushActivation();
  }

  override isRedundantAttachSubmission(code: string): boolean {
    const session = this.session;
    return Boolean(
      session?.proxy.isConnected() &&
      code.trim() === session.connection.attachCommand
    );
  }

  override getCachedWorkspaceData(): WorkspaceData | undefined {
    return this.session?.proxy.getWorkspaceData();
  }

  override async requestWorkspaceData(): Promise<WorkspaceData | undefined> {
    return await this.session?.proxy.requestWorkspace();
  }

  override refreshWorkspaceData(): void {
    void this.session?.proxy.requestWorkspace();
  }

  override async requestMemberCompletions(
    expression: string,
    operator: "$" | "@"
  ): Promise<SessionMemberCompletionItem[] | undefined> {
    return await this.session?.proxy.requestMemberCompletions(expression, operator);
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
    this.session?.proxy.setWorkspaceDataListener(undefined);
  }

  private clearConnection(): void {
    const session = this.session;
    this.session = undefined;
    const sessionId = this.host.rProcess?.sessionId;
    if (sessionId && sessionsByRuntimeSession.get(sessionId) === session) {
      sessionsByRuntimeSession.delete(sessionId);
    }
    session?.proxy.dispose();
  }

  private async createProxiedSession(): Promise<ProxiedSession | undefined> {
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
      this.clearConnection();
      const session = { proxy, connection: { ...upstreamConnection, pipePath } };
      this.session = session;
      const sessionId = this.host.rProcess?.sessionId;
      if (sessionId) {
        sessionsByRuntimeSession.set(sessionId, session);
      }
      return session;
    } catch {
      proxy.dispose();
      return undefined;
    }
  }

  private async resolveCurrentConnection(): Promise<
    VscodeRSessionConnection | undefined
  > {
    if (this.session) {
      return this.session.connection;
    }

    const sessionId = this.host.rProcess?.sessionId;
    const session = sessionId ? sessionsByRuntimeSession.get(sessionId) : undefined;
    const proxy = session?.proxy;
    const pipePath = proxy?.getPipePath();
    if (session && proxy?.isConnected() && pipePath) {
      proxy.setWorkspaceDataListener((data) => this.host.onSessionDataChanged(data));
      this.session = session;
      return session.connection;
    }
    if (proxy && sessionId) {
      sessionsByRuntimeSession.delete(sessionId);
      proxy.dispose();
    }

    if (!this.connectionRefresh) {
      this.connectionRefresh = this.createProxiedSession().finally(() => {
        this.connectionRefresh = undefined;
      });
    }
    return (await this.connectionRefresh)?.connection;
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
    if (!isLivePid(pid) || !this.session) {
      return;
    }
    void this.writeSessionFile(pid, this.session.connection);
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

  private flushActivation(): void {
    if (!this.activationPending || !this.host.canSubmitHiddenCommand()) {
      return;
    }
    if (this.host.submitHiddenCommand(buildAttachNotificationCommand())) {
      this.activationPending = false;
    }
  }

  private async reconnectRestoredRuntime(): Promise<void> {
    if (
      !this.reconnectPending ||
      this.reconnectInFlight ||
      !this.mainPromptObserved ||
      !this.host.canSubmitHiddenCommand()
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

      if (this.session?.proxy.isConnected()) {
        this.reconnectPending = false;
        this.flushActivation();
        return;
      }
      if (
        this.host.canSubmitHiddenCommand() &&
        this.host.submitHiddenCommand(buildConnectCommand(connection))
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
