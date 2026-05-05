import { randomUUID } from "crypto";
import { ChildProcess, spawn, SpawnOptions } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
  type BackendCapability,
  type BackendControlEvent,
  type BackendDialogResult,
  encodeDialogResultFrame,
  encodeInterruptFrame,
  encodeParseStatusRequestFrame,
  encodeReplyInputFrame,
  encodeSetWidthFrame,
  encodeShutdownFrame,
  encodeSubmitFrame,
  parseBackendFrames,
} from "./backendProtocol";

type RuntimeBackendStartOptions = Pick<SpawnOptions, "cwd" | "env">;

type RuntimeBackendHandlers = {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onControl?: (event: BackendControlEvent) => void;
  onExit?: (code: number) => void;
  onError?: (error: Error) => void;
};

type RuntimeSessionCommand =
  | {
      type: "submit";
      code: string;
    }
  | {
      type: "interrupt";
    }
  | {
      type: "reply-input";
      text: string;
    }
  | {
      type: "set-width";
      columns: number;
    }
  | {
      type: "dialog-result";
      result: BackendDialogResult;
    };

export type RuntimeSessionReconnectInfo = {
  sessionId: string;
  port: number;
  pid?: number;
};

export type RuntimeSessionHandle = {
  readonly sessionId: string;
};

type BackendSessionState = {
  capabilities: Set<BackendCapability>;
  hostConnected: boolean;
  nextRequestId: number;
  pendingParseRequests: Map<
    number,
    {
      resolve: (status: number) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >;
  child?: ChildProcess;
  childListenersAttached: boolean;
  sessionFilePath?: string;
  reconnectInfo: Partial<RuntimeSessionReconnectInfo> & Pick<RuntimeSessionReconnectInfo, "sessionId">;
  socket?: net.Socket;
  socketCarry: Buffer;
  explicitClose: boolean;
  attachGeneration: number;
  handlers?: RuntimeBackendHandlers;
};

type SessionBootstrapFile = {
  port?: number;
  pid?: number;
};

const PARSE_STATUS_TIMEOUT_MS = 150;
const SESSION_BOOTSTRAP_TIMEOUT_MS = 5000;
const SESSION_BOOTSTRAP_POLL_MS = 40;
const INITIAL_CONNECT_GRACE_MS = 60000;
const PERSISTENT_RECONNECT_GRACE_MS = 0;
const RECONNECT_SOCKET_RETRY_MS = 100;

export interface RuntimeBackend {
  start(args: string[], options: RuntimeBackendStartOptions): RuntimeSessionHandle;
  reconnect(info: RuntimeSessionReconnectInfo): RuntimeSessionHandle;
  attach(session: RuntimeSessionHandle, handlers: RuntimeBackendHandlers): void;
  hasCapability(session: RuntimeSessionHandle | null, capability: BackendCapability): boolean;
  canUseSessionCommands(session: RuntimeSessionHandle | null): boolean;
  sendSessionCommand(session: RuntimeSessionHandle | null, command: RuntimeSessionCommand): boolean;
  requestParseStatus(session: RuntimeSessionHandle | null, code: string): Promise<number> | undefined;
  close(session: RuntimeSessionHandle): void;
  isAlive(session: RuntimeSessionHandle | null): boolean;
  getPid(session: RuntimeSessionHandle | null): number | undefined;
  getReconnectInfo(session: RuntimeSessionHandle | null): RuntimeSessionReconnectInfo | undefined;
}

export class RustSidecarRuntimeBackend implements RuntimeBackend {
  private readonly sessionStates = new WeakMap<RuntimeSessionHandle, BackendSessionState>();

  constructor(private readonly sidecarPath: string) {}

  start(args: string[], options: RuntimeBackendStartOptions): RuntimeSessionHandle {
    const sessionId = randomUUID();
    const sessionFilePath = getSessionBootstrapFilePath(sessionId);
    try {
      fs.rmSync(sessionFilePath, { force: true });
    } catch {
    }

    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: {
        ...options.env,
        VSC_R_BACKEND_SESSION_FILE: sessionFilePath,
        VSC_R_BACKEND_INITIAL_CONNECT_GRACE_MS: String(INITIAL_CONNECT_GRACE_MS),
        VSC_R_BACKEND_RECONNECT_GRACE_MS: String(PERSISTENT_RECONNECT_GRACE_MS),
      },
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    };

    const child = spawn(this.sidecarPath, args, spawnOptions);
    child.unref();
    const handle: RuntimeSessionHandle = {
      sessionId,
    };

    this.sessionStates.set(handle, {
      capabilities: new Set<BackendCapability>(),
      hostConnected: false,
      nextRequestId: 0,
      pendingParseRequests: new Map(),
      child,
      childListenersAttached: false,
      sessionFilePath,
      reconnectInfo: { sessionId },
      socketCarry: Buffer.alloc(0),
      explicitClose: false,
      attachGeneration: 0,
    });

    return handle;
  }

  reconnect(info: RuntimeSessionReconnectInfo): RuntimeSessionHandle {
    const handle: RuntimeSessionHandle = {
      sessionId: info.sessionId,
    };

    this.sessionStates.set(handle, {
      capabilities: new Set<BackendCapability>(),
      hostConnected: false,
      nextRequestId: 0,
      pendingParseRequests: new Map(),
      childListenersAttached: false,
      sessionFilePath: getSessionBootstrapFilePath(info.sessionId),
      reconnectInfo: { ...info },
      socketCarry: Buffer.alloc(0),
      explicitClose: false,
      attachGeneration: 0,
    });

    return handle;
  }

  attach(session: RuntimeSessionHandle, handlers: RuntimeBackendHandlers): void {
    const state = this.getOrCreateState(session);
    state.explicitClose = false;
    state.handlers = handlers;
    state.attachGeneration += 1;
    const generation = state.attachGeneration;

    if (state.socket && !state.socket.destroyed) {
      state.socket.destroy();
    }
    state.socket = undefined;
    state.hostConnected = false;

    if (state.child && !state.childListenersAttached) {
      state.childListenersAttached = true;
      state.child.stderr?.on("data", (chunk: Buffer | string) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
        state.handlers?.onStderr?.(text);
      });

      state.child.on("exit", (code) => {
        this.refreshReconnectInfo(state);
        if (
          !state.explicitClose &&
          isRuntimeSessionPid(state.reconnectInfo.pid) &&
          isRuntimeSessionPidAlive(state.reconnectInfo.pid)
        ) {
          return;
        }
        if (state.socket && !state.socket.destroyed) {
          state.socket.destroy();
        }
        state.socket = undefined;
        state.hostConnected = false;
        this.resolvePendingParseRequests(state, 1);
        this.cleanupSessionBootstrapFile(state);
        state.handlers?.onExit?.(code ?? 0);
      });

      state.child.on("error", (error) => {
        if (state.socket && !state.socket.destroyed) {
          state.socket.destroy();
        }
        state.socket = undefined;
        state.hostConnected = false;
        this.resolvePendingParseRequests(state, 1);
        this.cleanupSessionBootstrapFile(state);
        state.handlers?.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    }

    void this.attachSocket(state, generation);
  }

  canUseSessionCommands(session: RuntimeSessionHandle | null): boolean {
    if (!session) {
      return false;
    }
    const state = this.sessionStates.get(session);
    if (!state) {
      return false;
    }
    return (
      state.hostConnected &&
      state.capabilities.has("session-control")
    );
  }

  hasCapability(session: RuntimeSessionHandle | null, capability: BackendCapability): boolean {
    if (!session) {
      return false;
    }
    const state = this.sessionStates.get(session);
    if (!state || !state.hostConnected) {
      return false;
    }
    return state.capabilities.has(capability);
  }

  sendSessionCommand(session: RuntimeSessionHandle | null, command: RuntimeSessionCommand): boolean {
    if (!session) {
      return false;
    }
    const state = this.sessionStates.get(session);
    if (!state || !state.hostConnected || !state.capabilities.has("session-control")) {
      return false;
    }

    switch (command.type) {
      case "submit":
        if (!state.capabilities.has("top-level-submit")) {
          return false;
        }
        return this.writeFrame(state, encodeSubmitFrame(command.code));
      case "interrupt":
        return this.writeFrame(state, encodeInterruptFrame());
      case "reply-input":
        if (!state.capabilities.has("nested-input")) {
          return false;
        }
        return this.writeFrame(state, encodeReplyInputFrame(command.text));
      case "set-width":
        if (!state.capabilities.has("set-width")) {
          return false;
        }
        return this.writeFrame(state, encodeSetWidthFrame(command.columns));
      case "dialog-result":
        return this.writeFrame(state, encodeDialogResultFrame(command.result));
      default:
        return false;
    }
  }

  requestParseStatus(session: RuntimeSessionHandle | null, code: string): Promise<number> | undefined {
    if (!session) {
      return undefined;
    }
    const state = this.sessionStates.get(session);
    if (!state || !state.hostConnected || !state.capabilities.has("parse-status")) {
      return undefined;
    }

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const requestId = ++state.nextRequestId;
      const timeout = setTimeout(() => {
        const pending = state.pendingParseRequests.get(requestId);
        if (!pending) {
          return;
        }
        state.pendingParseRequests.delete(requestId);
        settled = true;
        pending.reject(new Error("native parse-status request timed out"));
      }, PARSE_STATUS_TIMEOUT_MS);
      state.pendingParseRequests.set(requestId, {
        resolve: (status) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve(status);
        },
        reject: (error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      });
      const sent = this.writeFrame(state, encodeParseStatusRequestFrame(requestId, code));
      if (sent) {
        return;
      }
      const pending = state.pendingParseRequests.get(requestId);
      if (!pending) {
        return;
      }
      state.pendingParseRequests.delete(requestId);
      clearTimeout(pending.timeout);
      settled = true;
      resolve(1);
    });
  }

  close(session: RuntimeSessionHandle): void {
    const state = this.sessionStates.get(session);
    if (!state) {
      return;
    }
    state.explicitClose = true;
    const shutdownSent = this.writeFrame(state, encodeShutdownFrame(), true);
    if (shutdownSent) {
      return;
    }
    const reconnectInfo = this.readReconnectInfoFromBootstrapFile(state) ?? state.reconnectInfo;
    if (
      typeof reconnectInfo.port === "number" &&
      Number.isFinite(reconnectInfo.port) &&
      reconnectInfo.port > 0
    ) {
      void this.shutdownDetachedSession(state);
      return;
    }
    if (state.child && state.child.exitCode === null && state.child.signalCode === null) {
      try {
        state.child.kill();
      } catch {
      }
    }
  }

  isAlive(session: RuntimeSessionHandle | null): boolean {
    if (!session) {
      return false;
    }
    const state = this.sessionStates.get(session);
    if (!state || state.explicitClose) {
      return false;
    }
    this.refreshReconnectInfo(state);
    if (isRuntimeSessionPid(state.reconnectInfo.pid)) {
      return isRuntimeSessionPidAlive(state.reconnectInfo.pid);
    }
    if (state.child) {
      return (
        state.child.exitCode === null &&
        state.child.signalCode === null &&
        isRuntimeSessionPidAlive(state.child.pid)
      );
    }
    return Boolean(state.socket && !state.socket.destroyed) || state.attachGeneration > 0;
  }

  getPid(session: RuntimeSessionHandle | null): number | undefined {
    if (!session) {
      return undefined;
    }
    const state = this.sessionStates.get(session);
    if (!state) {
      return undefined;
    }
    this.refreshReconnectInfo(state);
    if (isRuntimeSessionPidAlive(state.reconnectInfo.pid)) {
      return state.reconnectInfo.pid;
    }
    if (isRuntimeSessionPidAlive(state.child?.pid)) {
      return state.child?.pid;
    }
    return undefined;
  }

  getReconnectInfo(session: RuntimeSessionHandle | null): RuntimeSessionReconnectInfo | undefined {
    if (!session) {
      return undefined;
    }
    const state = this.sessionStates.get(session);
    if (!state) {
      return undefined;
    }
    this.refreshReconnectInfo(state);
    const { sessionId, port, pid } = state.reconnectInfo;
    if (typeof port !== "number" || !Number.isFinite(port) || port <= 0) {
      return undefined;
    }
    if (isRuntimeSessionPid(pid) && !isRuntimeSessionPidAlive(pid)) {
      cleanupRuntimeSessionBootstrapFile(sessionId);
      return undefined;
    }
    return {
      sessionId,
      port,
      pid,
    };
  }

  private async attachSocket(
    state: BackendSessionState,
    generation: number
  ): Promise<void> {
    try {
      const info = await this.resolveReconnectInfo(state);
      if (state.attachGeneration !== generation || state.explicitClose) {
        return;
      }

      state.reconnectInfo = { ...state.reconnectInfo, ...info };

      const socket = await this.connectSocketWithRetry(state, info, generation);
      if (state.attachGeneration !== generation || state.explicitClose) {
        socket.destroy();
        return;
      }

      state.socket = socket;
      state.socketCarry = Buffer.alloc(0);

      socket.on("data", (chunk: Buffer) => {
        const parsed = parseBackendFrames(chunk, state.socketCarry);
        state.socketCarry = parsed.carry;

        if (parsed.error) {
          state.handlers?.onError?.(new Error(parsed.error));
          return;
        }

        for (const outputChunk of parsed.output) {
          if (outputChunk.data.length === 0) {
            continue;
          }

          const text = outputChunk.data.toString("utf8");
          if (outputChunk.stream === "stderr") {
            state.handlers?.onStderr?.(text);
          } else {
            state.handlers?.onStdout?.(text);
          }
        }

        for (const event of parsed.events) {
          this.handleSessionControlEvent(state, event);
          state.handlers?.onControl?.(event);
        }
      });

      socket.on("error", (error) => {
        if (state.socket !== socket) {
          return;
        }
        this.resolvePendingParseRequests(state, 1);
        if (state.hostConnected && isSocketDisconnectError(error)) {
          return;
        }
        state.handlers?.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

      socket.on("close", () => {
        if (state.socket !== socket) {
          return;
        }
        const wasHostConnected = state.hostConnected;
        state.socket = undefined;
        state.hostConnected = false;
        this.resolvePendingParseRequests(state, 1);
        if (!state.explicitClose && wasHostConnected) {
          state.handlers?.onExit?.(0);
        }
      });
    } catch (error) {
      if (state.attachGeneration !== generation || state.explicitClose) {
        return;
      }
      state.handlers?.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async resolveReconnectInfo(
    state: BackendSessionState
  ): Promise<RuntimeSessionReconnectInfo> {
    const reconnectInfo = state.reconnectInfo;
    if (
      typeof reconnectInfo.port === "number" &&
      Number.isFinite(reconnectInfo.port) &&
      reconnectInfo.port > 0
    ) {
      return reconnectInfo as RuntimeSessionReconnectInfo;
    }

    if (!state.sessionFilePath) {
      throw new Error("backend session bootstrap file is unavailable");
    }

    const deadline = Date.now() + SESSION_BOOTSTRAP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const raw = await fs.promises.readFile(state.sessionFilePath, "utf8");
        const parsed = JSON.parse(raw) as SessionBootstrapFile;
        if (
          typeof parsed.port === "number" &&
          Number.isFinite(parsed.port) &&
          parsed.port > 0
        ) {
          return {
            sessionId: reconnectInfo.sessionId,
            port: parsed.port,
            pid:
              typeof parsed.pid === "number" && Number.isFinite(parsed.pid) && parsed.pid > 0
                ? parsed.pid
                : undefined,
          };
        }
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, SESSION_BOOTSTRAP_POLL_MS));
    }

    throw new Error(
      `Timed out waiting for backend session bootstrap at ${state.sessionFilePath}`
    );
  }

  private connectSocket(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: "127.0.0.1",
        port,
      });
      const onError = (error: Error) => {
        socket.off("connect", onConnect);
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onConnect = () => {
        socket.off("error", onError);
        resolve(socket);
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
  }

  private async connectSocketWithRetry(
    state: BackendSessionState,
    info: RuntimeSessionReconnectInfo,
    generation: number
  ): Promise<net.Socket> {
    while (true) {
      if (state.attachGeneration !== generation || state.explicitClose) {
        throw new Error("backend reconnect was cancelled");
      }

      // On Windows, the spawned child may be only a launcher. It exits after
      // the real detached host writes the bootstrap file, so a child exit is
      // not fatal while that bootstrapped host pid is alive.
      const liveDetachedPid =
        isRuntimeSessionPid(info.pid) &&
        info.pid !== state.child?.pid &&
        isRuntimeSessionPidAlive(info.pid);

      if (state.child && state.child.exitCode !== null && !liveDetachedPid) {
        throw new Error(`R backend exited with code ${state.child.exitCode}`);
      }
      if (state.child && state.child.signalCode !== null && !liveDetachedPid) {
        throw new Error(`R backend exited with signal ${state.child.signalCode}`);
      }
      if (state.child && !liveDetachedPid && !isRuntimeSessionPidAlive(state.child.pid)) {
        this.cleanupSessionBootstrapFile(state);
        throw new Error(`R backend process ${state.child.pid} is no longer running`);
      }
      if (!state.child && isRuntimeSessionPid(info.pid) && !isRuntimeSessionPidAlive(info.pid)) {
        cleanupRuntimeSessionBootstrapFile(info.sessionId);
        throw new Error(`R backend process ${info.pid} is no longer running`);
      }

      try {
        return await this.connectSocket(info.port);
      } catch {
      }

      await new Promise((resolve) => setTimeout(resolve, RECONNECT_SOCKET_RETRY_MS));
    }
  }

  private writeFrame(state: BackendSessionState, frame: Buffer, closing: boolean = false): boolean {
    if (!state.socket || state.socket.destroyed) {
      return false;
    }
    try {
      state.socket.write(frame);
      if (closing) {
        state.socket.end();
      }
      return true;
    } catch {
      return false;
    }
  }

  private getOrCreateState(session: RuntimeSessionHandle): BackendSessionState {
    const existing = this.sessionStates.get(session);
    if (existing) {
      return existing;
    }
    const created: BackendSessionState = {
      capabilities: new Set<BackendCapability>(),
      hostConnected: false,
      nextRequestId: 0,
      pendingParseRequests: new Map(),
      childListenersAttached: false,
      reconnectInfo: { sessionId: session.sessionId },
      socketCarry: Buffer.alloc(0),
      explicitClose: false,
      attachGeneration: 0,
    };
    this.sessionStates.set(session, created);
    return created;
  }

  private handleSessionControlEvent(
    state: BackendSessionState,
    event: BackendControlEvent
  ): void {
    switch (event.type) {
      case "backend-ready":
        state.capabilities = new Set<BackendCapability>(event.capabilities);
        return;
      case "host-connected":
        state.hostConnected = true;
        for (const capability of event.capabilities) {
          state.capabilities.add(capability);
        }
        return;
      case "session-state":
        if (typeof event.pid === "number" && Number.isFinite(event.pid) && event.pid > 0) {
          state.reconnectInfo.pid = event.pid;
        }
        return;
      case "parse-status-result": {
        const pending = state.pendingParseRequests.get(event.requestId);
        if (!pending) {
          return;
        }
        state.pendingParseRequests.delete(event.requestId);
        clearTimeout(pending.timeout);
        pending.resolve(event.status);
        return;
      }
      default:
        return;
    }
  }

  private resolvePendingParseRequests(state: BackendSessionState, status: number): void {
    for (const pending of state.pendingParseRequests.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(status);
    }
    state.pendingParseRequests.clear();
  }

  private cleanupSessionBootstrapFile(state: BackendSessionState): void {
    if (!state.sessionFilePath) {
      return;
    }
    void fs.promises.rm(state.sessionFilePath, { force: true }).catch(() => {});
  }

  private refreshReconnectInfo(state: BackendSessionState): void {
    const resolvedInfo = this.readReconnectInfoFromBootstrapFile(state);
    if (!resolvedInfo) {
      return;
    }
    state.reconnectInfo = {
      ...state.reconnectInfo,
      ...resolvedInfo,
    };
  }

  private async shutdownDetachedSession(state: BackendSessionState): Promise<void> {
    const reconnectInfo = this.readReconnectInfoFromBootstrapFile(state) ?? state.reconnectInfo;
    const port = reconnectInfo.port;
    if (typeof port !== "number" || !Number.isFinite(port) || port <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      const socket = net.createConnection(
        {
          host: "127.0.0.1",
          port,
        },
        () => {
          socket.end(encodeShutdownFrame());
        }
      );
      const done = () => resolve();
      socket.once("error", done);
      socket.once("close", done);
    });
  }

  private readReconnectInfoFromBootstrapFile(
    state: BackendSessionState
  ): Partial<RuntimeSessionReconnectInfo> | undefined {
    if (!state.sessionFilePath) {
      return undefined;
    }
    try {
      const raw = fs.readFileSync(state.sessionFilePath, "utf8");
      const parsed = JSON.parse(raw) as SessionBootstrapFile;
      const resolved: Partial<RuntimeSessionReconnectInfo> = {};
      if (
        typeof parsed.port === "number" &&
        Number.isFinite(parsed.port) &&
        parsed.port > 0
      ) {
        resolved.port = parsed.port;
      }
      if (
        typeof parsed.pid === "number" &&
        Number.isFinite(parsed.pid) &&
        parsed.pid > 0
      ) {
        resolved.pid = parsed.pid;
      }
      return Object.keys(resolved).length > 0 ? resolved : undefined;
    } catch {
      return undefined;
    }
  }
}

function getSessionBootstrapFilePath(sessionId: string): string {
  return path.join(os.tmpdir(), `r-console-session-${sessionId}.json`);
}

function getRustSidecarExecutableName(): string {
  return process.platform === "win32" ? "R_CONSOLE_HOST.exe" : "R_CONSOLE_HOST";
}

export function getBundledRustSidecarPath(extensionPath: string): string {
  const exeName = getRustSidecarExecutableName();
  return path.join(extensionPath, "bundled", "bin", exeName);
}

export function resolveRustSidecarPath(extensionPath: string): string | undefined {
  const bundledPath = getBundledRustSidecarPath(extensionPath);
  return fs.existsSync(bundledPath) ? bundledPath : undefined;
}

function isRuntimeSessionPid(pid: number | undefined): pid is number {
  return typeof pid === "number" && Number.isFinite(pid) && pid > 0;
}

function isRuntimeSessionPidAlive(pid: number | undefined): boolean {
  if (!isRuntimeSessionPid(pid)) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isSocketDisconnectError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ECONNRESET" || code === "EPIPE";
}

function cleanupRuntimeSessionBootstrapFile(sessionId: string): void {
  try {
    fs.rmSync(getSessionBootstrapFilePath(sessionId), { force: true });
  } catch {
  }
}
