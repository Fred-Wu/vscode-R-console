import * as vscode from "vscode";
import type { RuntimeHost } from "../../../Terminal/rTerminal/runtime";
import { BaseVscodeRSessionIntegration } from "../integration";
import type {
  SessionMemberCompletionItem,
  WorkspaceData,
} from "../types";
import { SessProxy } from "./sessProxy";

type VscodeRSessionInfo = {
  endpoint?: unknown;
  [key: string]: unknown;
};

type VscodeRPreparation = vscode.Disposable & {
  readonly attachmentId: string;
  readonly scriptPath: string;
  readonly command: string;
};

type VscodeRSessionReference = {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly attachmentId?: string;
};

type VscodeRSessionConnectionChange = {
  readonly kind: "connected" | "disconnected";
  readonly session: VscodeRSessionReference;
};

type VscodeRSessionApi = {
  prepareAttachment(options: {
    connection: { transport: "sess"; endpoint: string };
    autoActivate: false;
  }): Promise<VscodeRPreparation | undefined>;
  getConnectionInfo(): Promise<VscodeRSessionInfo | undefined>;
  getSessionReference(sessionId: string): VscodeRSessionReference | undefined;
  onDidChangeSessionConnection: vscode.Event<VscodeRSessionConnectionChange>;
  registerTerminalIntegration(terminal: vscode.Terminal, integration: {
    attach(token: vscode.CancellationToken): Promise<boolean>;
  }): vscode.Disposable;
  activate(
    sessionId: string,
    options?: { terminal?: vscode.Terminal; connectionId?: string; select?: boolean }
  ): Promise<boolean>;
};

type VscodeRExtensionApi = {
  session?: VscodeRSessionApi;
};

type VscodeRSessionConnection = {
  pipePath: string;
  prepareAttachment(endpoint: string): Promise<VscodeRPreparation | undefined>;
  getSessionReference(sessionId: string): VscodeRSessionReference | undefined;
  onDidChangeSessionConnection: vscode.Event<VscodeRSessionConnectionChange>;
  registerTerminalIntegration: VscodeRSessionApi["registerTerminalIntegration"];
  activateSession(
    sessionId: string,
    options?: { terminal?: vscode.Terminal; connectionId?: string; select?: boolean }
  ): Promise<boolean>;
};

const VSCODE_R_EXTENSION_ID = "REditorSupport.r";
const SESS_ASYNC_PROMPT_PATTERN = /(\r?\[sess\][^\r\n]*)(?:\r\n|\n){2}> ?/g;
const SESS_RECONNECT_NOISE_PATTERN =
  /\r?\[sess\] Failed to connect to IPC (?:pipe|endpoint): [^\r\n]*(?:\r\n|\n)?/g;

let connectionDiscovery: Promise<VscodeRSessionConnection | undefined> | undefined;
const proxiesByRuntimeSession = new Map<string, SessProxy>();
const connectionsByProxy = new WeakMap<SessProxy, VscodeRSessionConnection>();
const preparationsByRuntimeSession = new Map<string, VscodeRPreparation>();

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
    typeof sessionApi.prepareAttachment !== "function" ||
    typeof sessionApi.activate !== "function" ||
    typeof sessionApi.getSessionReference !== "function" ||
    typeof sessionApi.onDidChangeSessionConnection !== "function" ||
    typeof sessionApi.registerTerminalIntegration !== "function"
  ) {
    return undefined;
  }

  try {
    const info = await sessionApi.getConnectionInfo();
    if (
      !info ||
      typeof info.endpoint !== "string" ||
      info.endpoint.length === 0
    ) {
      return undefined;
    }
    return {
      pipePath: info.endpoint,
      prepareAttachment: (endpoint: string) => sessionApi.prepareAttachment({
        connection: { transport: "sess", endpoint },
        autoActivate: false,
      }),
      getSessionReference: (sessionId: string) => sessionApi.getSessionReference(sessionId),
      onDidChangeSessionConnection: sessionApi.onDidChangeSessionConnection,
      registerTerminalIntegration: (
        terminal: vscode.Terminal,
        integration: { attach(token: vscode.CancellationToken): Promise<boolean> }
      ) => sessionApi.registerTerminalIntegration(terminal, integration),
      activateSession: (
        sessionId: string,
        options?: { terminal?: vscode.Terminal; connectionId?: string; select?: boolean }
      ) => sessionApi.activate(sessionId, options),
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
  private registeredTerminal: vscode.Terminal | undefined;
  private terminalRegistration: vscode.Disposable | undefined;
  private terminalRegistrationGeneration = 0;
  private connectionEvents: vscode.Disposable | undefined;
  private expectedAttachmentId: string | undefined;
  private manualWaiter: {
    terminal: vscode.Terminal;
    resolve: (result: boolean) => void;
    cancellation: vscode.Disposable;
  } | undefined;
  private manualFailureTimer: ReturnType<typeof setTimeout> | undefined;
  private activationPending = false;
  private preparation: VscodeRPreparation | undefined;
  private initialBootstrapPending = false;
  private reconnectCommandRunning = false;
  private reconnectRetryBlocked = false;
  private needsProxyReplacement = false;
  private proxyWasAttached = false;
  private activationInFlight = false;
  private activationTriggeredWhileInFlight = false;
  private disposed = false;

  constructor(host: RuntimeHost) {
    super(host);
    this.reconnectPending = Boolean(host.rProcess);
    this.mainPromptObserved = !this.reconnectPending;
  }

  static disposeForRuntimeSession(sessionId: string): void {
    const proxy = proxiesByRuntimeSession.get(sessionId);
    proxiesByRuntimeSession.delete(sessionId);
    proxy?.dispose();
    const preparation = preparationsByRuntimeSession.get(sessionId);
    preparationsByRuntimeSession.delete(sessionId);
    preparation?.dispose();
  }

  override resetForStart(): void {
    this.disposed = false;
    this.finishManualAttach(false);
    this.clearConnection();
    this.releasePreparation();
    this.reconnectPending = false;
    this.mainPromptObserved = true;
    this.initialBootstrapPending = false;
    this.reconnectCommandRunning = false;
    this.reconnectRetryBlocked = false;
    this.needsProxyReplacement = false;
    this.activationPending = false;
    this.activationInFlight = false;
    this.activationTriggeredWhileInFlight = false;
    this.reconnectInFlight = false;
    this.reconnectNoiseUntil = 0;
  }

  override async prepareStart(env: NodeJS.ProcessEnv): Promise<void> {
    // The vscode-R API owns package installation, consent, and sess setup.
    // The console owns only its private IPC proxy and the script's lifetime.
    delete env.R_CONSOLE_SESSION_BOOTSTRAP;
    delete env.SESS_DISCOVERY_FILE;
    delete env.SESS_ENDPOINT;
    delete env.SESS_PIPE;
    delete env.SESS_RSTUDIOAPI;
    delete env.SESS_PLOT_BACKEND;
    delete env.SESS_USE_HTTPGD;
    delete env.SESS_USE_JGD;
    delete env.JGD_SOCKET;
    delete env.VSCODE_INIT_R;
    delete env.VSCODE_WATCHER_DIR;
    delete env.SESS_PORT;
    delete env.SESS_TOKEN;
    delete env.SESS_HOST;

    const connection = await this.createProxiedConnection();
    if (!connection) {
      this.reconnectPending = true;
      this.reconnectRetryBlocked = true;
      void vscode.window.showWarningMessage(
        "R Console requires a compatible vscode-R installation to attach its session. The console will start without session integration."
      );
      return;
    }
    try {
      const preparation = await connection.prepareAttachment(connection.pipePath);
      if (!preparation || this.disposed || this.connection !== connection) {
        preparation?.dispose();
        if (!this.disposed && !preparation) {
          this.reconnectPending = true;
          this.reconnectRetryBlocked = true;
          void vscode.window.showWarningMessage("R Console could not prepare its vscode-R session attachment.");
        }
        return;
      }
      this.releasePreparation();
      this.preparation = preparation;
      this.expectedAttachmentId = preparation.attachmentId;
      this.initialBootstrapPending = true;
      env.R_CONSOLE_SESSION_BOOTSTRAP = preparation.scriptPath;
    } catch (error) {
      this.reconnectPending = true;
      this.reconnectRetryBlocked = true;
      void vscode.window.showWarningMessage(
        `R Console could not prepare its vscode-R connection: ${String(error)}`
      );
    }
  }

  override afterRuntimeStarted(): void {
    if (this.proxy && this.host.rProcess) {
      proxiesByRuntimeSession.set(this.host.rProcess.sessionId, this.proxy);
    }
    if (this.preparation && this.host.rProcess) {
      const sessionId = this.host.rProcess.sessionId;
      const previous = preparationsByRuntimeSession.get(sessionId);
      if (previous !== this.preparation) { previous?.dispose(); }
      preparationsByRuntimeSession.set(sessionId, this.preparation);
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
    if (this.initialBootstrapPending) {
      this.initialBootstrapPending = false;
      this.releasePreparation();
      // If initial setup was declined or failed, do not prompt repeatedly.
      if (!this.proxy?.getSessionId()) {
        this.reconnectPending = true;
        this.reconnectRetryBlocked = true;
      }
    }
    if (this.reconnectCommandRunning) {
      this.reconnectCommandRunning = false;
      this.releasePreparation();
      if (this.reconnectPending) {
        // One attempt per focus transition, not an endless install/reconnect loop.
        this.reconnectRetryBlocked = true;
        if (this.manualWaiter) {
          this.manualFailureTimer = setTimeout(() => {
            if (this.reconnectPending) { this.finishManualAttach(false); }
          }, 1500);
        }
      } else {
        this.flushActivation();
      }
      return;
    }
    if (this.reconnectPending) {
      if (this.active && !this.reconnectRetryBlocked) {
        void this.reconnectRestoredRuntime();
      }
      return;
    }
    this.flushActivation();
  }

  override setActive(active: boolean, terminal?: vscode.Terminal): void {
    const becameActive = active && !this.active;
    this.active = active;
    if (becameActive) {
      this.reconnectRetryBlocked = false;
    }
    if (active && terminal) {
      this.setTerminal(terminal);
    }
    if (active) { this.activationPending = true; }
    if (!active) {
      return;
    }
    if (this.reconnectPending) {
      if (this.reconnectRetryBlocked) { return; }
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
    this.disposed = true;
    this.finishManualAttach(false);
    this.clearConnection();
    this.releasePreparation();
    this.reconnectPending = false;
    this.activationPending = false;
    const sessionId = this.host.rProcess?.sessionId;
    if (sessionId) {
      const remaining = preparationsByRuntimeSession.get(sessionId);
      preparationsByRuntimeSession.delete(sessionId);
      remaining?.dispose();
    }
  }

  override disposeUi(): void {
    this.setActive(false);
    this.setTerminal(undefined);
    this.connectionEvents?.dispose();
    this.connectionEvents = undefined;
    this.proxy?.setWorkspaceDataListener(undefined);
    this.proxy?.setConnectionListener(undefined);
  }

  private releasePreparation(): void {
    const preparation = this.preparation;
    this.preparation = undefined;
    const sessionId = this.host.rProcess?.sessionId;
    if (sessionId && preparationsByRuntimeSession.get(sessionId) === preparation) {
      preparationsByRuntimeSession.delete(sessionId);
    }
    preparation?.dispose();
  }

  private clearConnection(): void {
    this.connectionGeneration++;
    this.proxyWasAttached = false;
    this.connectionEvents?.dispose();
    this.connectionEvents = undefined;
    this.expectedAttachmentId = undefined;
    const proxy = this.proxy;
    this.connection = undefined;
    this.proxy = undefined;
    const sessionId = this.host.rProcess?.sessionId;
    if (sessionId && proxiesByRuntimeSession.get(sessionId) === proxy) {
      proxiesByRuntimeSession.delete(sessionId);
    }
    proxy?.dispose();
  }

  private bindProxyListeners(proxy: SessProxy): void {
    proxy.setWorkspaceDataListener((data) => this.handleWorkspaceData(data));
    proxy.setConnectionListener((state) => {
      if (this.proxy !== proxy || this.disposed) { return; }
      if (state === "attached") {
        this.proxyWasAttached = true;
        // The proxy saw an attach request; vscode-R may not have accepted it yet.
        this.activationPending = true;
        this.flushActivation();
      } else {
        this.needsProxyReplacement = true;
        this.reconnectPending = true;
        this.activationPending = true;
        this.reconnectRetryBlocked = false;
        this.finishManualAttach(false);
        if (this.active && this.canSubmitHiddenCommand()) {
          void this.reconnectRestoredRuntime();
        }
      }
    });
    this.connectionEvents?.dispose();
    this.connectionEvents = this.connection?.onDidChangeSessionConnection((change) => {
      if (this.disposed || this.proxy !== proxy) { return; }
      if (change.kind !== "connected" || change.session.sessionId !== proxy.getSessionId()) { return; }
      if (this.expectedAttachmentId && change.session.attachmentId !== this.expectedAttachmentId) { return; }
      this.reconnectPending = false;
      this.reconnectRetryBlocked = false;
      this.activationPending = true;
      this.flushActivation();
    });
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
      this.needsProxyReplacement = false;
      this.connection = { ...upstreamConnection, pipePath };
      this.bindProxyListeners(proxy);
      const sessionId = this.host.rProcess?.sessionId;
      if (sessionId) {
        proxiesByRuntimeSession.set(sessionId, proxy);
      }
      return this.connection;
    } catch {
      proxy.dispose();
      return undefined;
    }
  }

  private async resolveCurrentConnection(): Promise<
    VscodeRSessionConnection | undefined
  > {
    if (this.connection && this.proxy && !this.needsProxyReplacement &&
        (!this.proxyWasAttached || this.proxy.isConnected())) {
      return this.connection;
    }

    const sessionId = this.host.rProcess?.sessionId;
    const proxy = sessionId ? proxiesByRuntimeSession.get(sessionId) : undefined;
    const pipePath = proxy?.getPipePath();
    const upstreamConnection = proxy ? connectionsByProxy.get(proxy) : undefined;
    if (proxy?.isConnected() && proxy.getSessionId() && pipePath && upstreamConnection) {
      this.proxy = proxy;
      this.proxyWasAttached = true;
      this.connection = { ...upstreamConnection, pipePath };
      this.bindProxyListeners(proxy);
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
    // Workspace data can precede acceptance of the attach handshake.
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

  /** Register the recovery handler immediately, without waiting for a shell PID. */
  override setTerminal(terminal: vscode.Terminal | undefined): void {
    if (this.registeredTerminal === terminal && (!terminal || this.terminalRegistration)) { return; }
    this.terminalRegistrationGeneration++;
    const generation = this.terminalRegistrationGeneration;
    this.terminalRegistration?.dispose();
    this.terminalRegistration = undefined;
    this.registeredTerminal = terminal;
    this.activationPending = true;
    if (!terminal) {
      this.finishManualAttach(false);
      return;
    }
    void Promise.resolve(this.connection ?? getSessionConnection()).then((connection) => {
      if (!connection || this.disposed || this.registeredTerminal !== terminal ||
          generation !== this.terminalRegistrationGeneration) { return; }
      const registration = connection.registerTerminalIntegration(terminal, {
        attach: (token) => this.attachManually(terminal, token),
      });
      if (this.disposed || this.registeredTerminal !== terminal ||
          generation !== this.terminalRegistrationGeneration) {
        registration.dispose();
        return;
      }
      this.terminalRegistration = registration;
      this.flushActivation();
    }).catch((error) => {
      if (!this.disposed && this.registeredTerminal === terminal) {
        void vscode.window.showWarningMessage(
          `R Console could not register its vscode-R attach handler: ${String(error)}`
        );
      }
    });
  }

  private currentReference(): VscodeRSessionReference | undefined {
    const proxy = this.proxy;
    const sessionId = proxy?.getSessionId();
    if (!proxy?.isConnected() || !sessionId) { return undefined; }
    const reference = this.connection?.getSessionReference(sessionId);
    if (!reference || (this.expectedAttachmentId &&
        reference.attachmentId !== this.expectedAttachmentId)) { return undefined; }
    return reference;
  }

  private finishManualAttach(result: boolean): void {
    const waiter = this.manualWaiter;
    this.manualWaiter = undefined;
    if (this.manualFailureTimer) {
      clearTimeout(this.manualFailureTimer);
      this.manualFailureTimer = undefined;
    }
    if (!waiter) { return; }
    waiter.cancellation.dispose();
    waiter.resolve(result);
  }

  private async attachManually(
    terminal: vscode.Terminal, token: vscode.CancellationToken
  ): Promise<boolean> {
    if (token.isCancellationRequested || this.disposed || this.registeredTerminal !== terminal ||
        !this.host.rProcess) { return false; }
    const reference = this.currentReference();
    if (reference && this.connection) {
      return this.connection.activateSession(reference.sessionId, {
        terminal, connectionId: reference.connectionId, select: false,
      });
    }
    if (this.manualWaiter || !this.canSubmitHiddenCommand()) { return false; }
    this.reconnectPending = true;
    this.reconnectRetryBlocked = false;
    this.activationPending = true;
    return new Promise<boolean>((resolve) => {
      const cancellation = token.onCancellationRequested(() => this.finishManualAttach(false));
      this.manualWaiter = { terminal, resolve, cancellation };
      if (token.isCancellationRequested) { this.finishManualAttach(false); return; }
      void this.reconnectRestoredRuntime(true).then(() => {
        if (!this.reconnectInFlight && !this.reconnectCommandRunning &&
            !this.currentReference() && !this.proxy?.getSessionId()) {
          this.finishManualAttach(false);
        } else {
          this.flushActivation();
        }
      }, () => this.finishManualAttach(false));
    });
  }

  private flushActivation(): void {
    if (!this.activationPending) { return; }
    if (this.activationInFlight) {
      this.activationTriggeredWhileInFlight = true;
      return;
    }
    const reference = this.currentReference();
    const proxy = this.proxy;
    const activateSession = this.connection?.activateSession;
    const terminal = this.registeredTerminal;
    if (!reference || !proxy || !terminal || !activateSession) { return; }
    const select = this.active && !this.manualWaiter;
    this.activationPending = false;
    this.activationInFlight = true;
    void activateSession(reference.sessionId, {
      terminal, connectionId: reference.connectionId, select,
    }).then((activated) => {
      if (this.disposed || this.proxy !== proxy || this.registeredTerminal !== terminal) { return; }
      if (activated && this.currentReference()?.connectionId === reference.connectionId) {
        this.reconnectPending = false;
        this.reconnectRetryBlocked = false;
        if (this.manualWaiter?.terminal === terminal) { this.finishManualAttach(true); }
      } else {
        this.activationPending = true;
      }
    }).catch(() => {
      if (!this.disposed && this.proxy === proxy) { this.activationPending = true; }
    }).finally(() => {
      this.activationInFlight = false;
      if (this.activationTriggeredWhileInFlight) {
        this.activationTriggeredWhileInFlight = false;
        this.flushActivation();
      }
    });
  }

  private async reconnectRestoredRuntime(force = false): Promise<void> {
    if (
      this.disposed ||
      !this.reconnectPending ||
      this.reconnectInFlight ||
      this.reconnectCommandRunning ||
      (!force && this.reconnectRetryBlocked) ||
      (!force && !this.active) ||
      !this.mainPromptObserved ||
      !this.canSubmitHiddenCommand()
    ) {
      return;
    }

    this.reconnectNoiseUntil = Date.now() + 10000;
    this.reconnectInFlight = true;
    try {
      const connection = await this.resolveCurrentConnection();
      if (!connection || (!force && !this.active) || (force && !this.manualWaiter) ||
          !this.reconnectPending || this.disposed) {
        return;
      }
      if (this.currentReference()) {
        this.activationPending = true;
        this.flushActivation();
        return;
      }
      if (this.proxy?.isConnected() && this.proxy.getSessionId()) {
        // Wait for the upstream acceptance instead of starting a competing connect.
        return;
      }
      const preparation = await connection.prepareAttachment(connection.pipePath);
      if (!preparation) { return; }
      if (this.disposed || (!force && !this.active) || (force && !this.manualWaiter) ||
          this.connection !== connection || !this.canSubmitHiddenCommand() ||
          !this.reconnectPending) {
        preparation.dispose();
        return;
      }
      this.releasePreparation();
      this.preparation = preparation;
      this.expectedAttachmentId = preparation.attachmentId;
      const runtimeSessionId = this.host.rProcess?.sessionId;
      if (runtimeSessionId) {
        const previous = preparationsByRuntimeSession.get(runtimeSessionId);
        if (previous !== preparation) { previous?.dispose(); }
        preparationsByRuntimeSession.set(runtimeSessionId, preparation);
      }
      if (this.submitHiddenCommand(preparation.command)) {
        this.reconnectCommandRunning = true;
      } else {
        this.releasePreparation();
      }
    } catch (error) {
      if (!this.disposed && this.active) {
        this.reconnectRetryBlocked = true;
        void vscode.window.showWarningMessage(
          `R Console could not reconnect to vscode-R: ${String(error)}`
        );
      }
    } finally {
      this.reconnectInFlight = false;
    }
  }
}

export function disposeSessProxyForRuntimeSession(sessionId: string): void {
  SessVscodeRIntegration.disposeForRuntimeSession(sessionId);
}
