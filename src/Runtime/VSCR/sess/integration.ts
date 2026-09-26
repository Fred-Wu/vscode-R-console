import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { RuntimeHost } from "../../../Terminal/rTerminal/runtime";
import { BaseVscodeRSessionIntegration } from "../integration";
import type {
  SessionMemberCompletionItem,
  WorkspaceData,
} from "../types";
import { SessProxy } from "./sessProxy";

type VscodeRPlotBackend = "auto" | "standard" | "httpgd" | "jgd";

type VscodeRSessionApi = {
  getConnectionInfo(): Promise<{
    protocolVersion: number;
    endpoint: string;
    plotBackend: VscodeRPlotBackend;
    jgdSocket?: string;
  } | undefined>;
  activate(sessionId: string): Promise<boolean>;
};

type VscodeRExtensionApi = {
  session?: VscodeRSessionApi;
};

type VscodeRSessionConnection = {
  pipePath: string;
  plotBackend: VscodeRPlotBackend;
  jgdSocket?: string;
  activateSession(sessionId: string): Promise<boolean>;
};

const VSCODE_R_EXTENSION_ID = "REditorSupport.r";
const SUPPORTED_SESS_PROTOCOL_VERSION = 1;
const SESS_ASYNC_PROMPT_PATTERN = /(\r?\[sess\][^\r\n]*)(?:\r\n|\n){2}> ?/g;
const SESS_RECONNECT_NOISE_PATTERN =
  /\r?\[sess\] Failed to connect to IPC (?:pipe|endpoint): [^\r\n]*(?:\r\n|\n)?/g;

let connectionDiscovery: Promise<VscodeRSessionConnection | undefined> | undefined;
const proxiesByRuntimeSession = new Map<string, SessProxy>();
const connectionsByProxy = new WeakMap<SessProxy, VscodeRSessionConnection>();

async function discoverSessionConnection(): Promise<
  VscodeRSessionConnection | undefined
> {
  const extension = vscode.extensions.getExtension<VscodeRExtensionApi>(
    VSCODE_R_EXTENSION_ID
  );
  if (!extension) {
    return undefined;
  }

  let api: VscodeRExtensionApi | undefined;
  try {
    api = extension.isActive ? extension.exports : await extension.activate();
  } catch {
    return undefined;
  }

  const sessionApi = api?.session;
  if (
    !sessionApi ||
    typeof sessionApi.getConnectionInfo !== "function" ||
    typeof sessionApi.activate !== "function"
  ) {
    return undefined;
  }

  try {
    const info = await sessionApi.getConnectionInfo();
    if (
      !info ||
      info.protocolVersion !== SUPPORTED_SESS_PROTOCOL_VERSION ||
      !info.endpoint
    ) {
      return undefined;
    }
    return {
      pipePath: info.endpoint,
      plotBackend: info.plotBackend,
      jgdSocket: info.jgdSocket,
      activateSession: (sessionId: string) => sessionApi.activate(sessionId),
    };
  } catch {
    return undefined;
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

function buildConnectCommand(connection: VscodeRSessionConnection): string {
  const rConfig = vscode.workspace.getConfiguration("r");
  const plotBackend = connection.plotBackend;
  const jgdSocketCommand = connection.jgdSocket
    ? `Sys.setenv(JGD_SOCKET=${quoteRString(connection.jgdSocket)});`
    : "Sys.unsetenv(\"JGD_SOCKET\");";
  return [
    "if (requireNamespace(\"sess\", quietly = TRUE) && \"endpoint\" %in% names(formals(sess::connect))) {",
    `Sys.setenv(SESS_ENDPOINT=${quoteRString(connection.pipePath)});`,
    jgdSocketCommand,
    "sess::connect(",
    `endpoint=${quoteRString(connection.pipePath)},`,
    `use_rstudioapi=${asRLogical(rConfig.get<boolean>("session.emulateRStudioAPI"), true)},`,
    `use_httpgd=${asRLogical(plotBackend === "httpgd" || plotBackend === "auto", true)},`,
    `use_jgd=${asRLogical(plotBackend === "jgd" || plotBackend === "auto", false)}`,
    ")",
    "}",
  ].join(" ");
}

export class SessVscodeRIntegration extends BaseVscodeRSessionIntegration {
  private connection: VscodeRSessionConnection | undefined;
  private connectionRefresh: Promise<VscodeRSessionConnection | undefined> | undefined;
  private connectionGeneration = 0;
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

    delete env.SESS_DISCOVERY_FILE;
    const connection = await this.createProxiedConnection();
    if (!connection) {
      delete env.R_CONSOLE_SESSION_BOOTSTRAP;
      delete env.SESS_ENDPOINT;
      void vscode.window.showWarningMessage(
        "R Console could not obtain vscode-R session connection info. The console will start without vscode-R session attachment."
      );
      return;
    }

    this.connection = connection;
    env.R_CONSOLE_SESSION_BOOTSTRAP = bootstrapPath;
    env.SESS_ENDPOINT = connection.pipePath;
    delete env.SESS_PIPE;
    const rConfig = vscode.workspace.getConfiguration("r");
    const plotBackend = connection.plotBackend;
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
      void this.resolveCurrentConnection();
    }
  }

  override handleHostConnected(): void {
    if (this.reconnectPending && this.active) {
      void this.resolveCurrentConnection();
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

  override setActive(active: boolean): void {
    this.active = active;
    this.activationPending = active;
    if (!active) {
      return;
    }
    if (this.reconnectPending) {
      if (!this.mainPromptObserved || !this.canSubmitHiddenCommand()) {
        void this.resolveCurrentConnection();
      } else {
        void this.reconnectRestoredRuntime();
      }
      return;
    }
    this.flushActivation();
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
    this.clearConnection();
    this.reconnectPending = false;
    this.activationPending = false;
  }

  override disposeUi(): void {
    this.setActive(false);
    this.proxy?.setWorkspaceDataListener(undefined);
  }

  private clearConnection(): void {
    this.connectionGeneration++;
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
    const generation = this.connectionGeneration;
    const upstreamConnection = await getSessionConnection();
    if (!upstreamConnection || generation !== this.connectionGeneration) {
      return undefined;
    }

    const proxy = new SessProxy({
      upstreamPipePath: upstreamConnection.pipePath,
      onWorkspaceData: (data) => this.handleWorkspaceData(data),
    });
    try {
      const pipePath = await proxy.start();
      if (generation !== this.connectionGeneration) {
        proxy.dispose();
        return undefined;
      }
      connectionsByProxy.set(proxy, upstreamConnection);
      this.clearConnection();
      this.proxy = proxy;
      const sessionId = this.host.rProcess?.sessionId;
      if (sessionId) {
        proxiesByRuntimeSession.set(sessionId, proxy);
      }
      this.connection = { ...upstreamConnection, pipePath };
      return this.connection;
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
    const upstreamConnection = proxy ? connectionsByProxy.get(proxy) : undefined;
    if (proxy?.isConnected() && pipePath && upstreamConnection) {
      this.proxy = proxy;
      this.connection = { ...upstreamConnection, pipePath };
      proxy.setWorkspaceDataListener((data) => this.handleWorkspaceData(data));
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
    await this.connectionRefresh;
    return this.connection;
  }

  private handleWorkspaceData(data: WorkspaceData): void {
    this.host.onSessionDataChanged(data);
    this.flushActivation();
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
    if (!this.activationPending) {
      return;
    }
    const sessionId = this.proxy?.getSessionId();
    const activateSession = this.connection?.activateSession;
    if (!sessionId || !activateSession) {
      return;
    }

    this.activationPending = false;
    void activateSession(sessionId).then((activated) => {
      if (!activated && this.active) {
        this.activationPending = true;
      }
    }).catch(() => {
      if (this.active) {
        this.activationPending = true;
      }
    });
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
      if (!connection || !this.active || !this.reconnectPending) {
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
      }
    } finally {
      this.reconnectInFlight = false;
    }
  }
}

export function disposeSessProxyForRuntimeSession(sessionId: string): void {
  SessVscodeRIntegration.disposeForRuntimeSession(sessionId);
}
