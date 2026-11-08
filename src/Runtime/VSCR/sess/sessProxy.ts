import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as os from "os";
import type {
  SessionMemberCompletionItem,
  WorkspaceData,
} from "../types";

type PendingRequest = {
  resolve: (value: unknown | undefined) => void;
  timeout: NodeJS.Timeout;
};

type SessProxyOptions = {
  upstreamPipePath: string;
  runtimeHostPath?: string;
};

const REQUEST_TIMEOUT_MS = 2000;
const R_SOCKET_WAIT_TIMEOUT_MS = 1200;
const MAX_SESS_LINE_BYTES = 16 * 1024 * 1024;
// Bound resources held by clients that have not sent an attach message.
// These guards do not apply to established session traffic or R execution.
const ATTACH_TIMEOUT_MS = 3000;
const MAX_PENDING_R_SOCKETS = 8;

async function setOwnerOnlyPermissions(filePath: string, runtimeHostPath?: string): Promise<void> {
  if (process.platform === "win32") {
    if (!runtimeHostPath) throw new Error("R Console runtime host is required to secure the session pipe.");
    await promisify(execFile)(runtimeHostPath, ["--secure-session-pipe", filePath], {
      windowsHide: true,
    });
    return;
  }
  await fs.promises.chmod(filePath, 0o600);
}

export class SessProxy {
  private server: net.Server | undefined;
  private proxyPipePath: string | undefined;
  private socketDirectory: string | undefined;
  private rSocket: net.Socket | undefined;
  private upstreamSocket: net.Socket | undefined;
  private pendingRSockets = new Set<net.Socket>();
  private rBuffer = "";
  private upstreamBuffer = "";
  private pendingRequests = new Map<string, PendingRequest>();
  private forwardedRequests = new Map<string, string>();
  private rSocketWaiters: Array<(socket: net.Socket | undefined) => void> = [];
  private workspaceData: WorkspaceData | undefined;
  private libraryPathsRequest: Promise<void> | undefined;
  private sessionId: string | undefined;
  private onWorkspaceData: ((data: WorkspaceData) => void) | undefined;
  private onConnectionChange: ((state: "attached" | "disconnected") => void) | undefined;

  constructor(private readonly options: SessProxyOptions) {}

  async start(): Promise<string> {
    this.dispose();
    const pipePath = process.platform === "win32"
      ? this.createPipePath()
      : path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), "vrc-")), "sess.sock");
    if (process.platform !== "win32") this.socketDirectory = path.dirname(pipePath);
    let permissionsReady = false;
    const startupSockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      if (!permissionsReady) {
        // Do not exchange session data while the Windows DACL is being set.
        // Keep metadata-only helper handles alive until permission setup ends.
        socket.on("error", () => socket.destroy());
        if (startupSockets.size >= MAX_PENDING_R_SOCKETS) { socket.destroy(); return; }
        startupSockets.add(socket);
        socket.once("close", () => startupSockets.delete(socket));
        return;
      }
      this.acceptRSocket(socket);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipePath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await setOwnerOnlyPermissions(pipePath, this.options.runtimeHostPath);
      if (this.server !== server) throw new Error("Session proxy startup was cancelled.");
      permissionsReady = true;
      this.proxyPipePath = pipePath;
    } catch (error) {
      if (this.server === server) this.dispose();
      throw error;
    } finally {
      for (const socket of startupSockets) socket.destroy();
    }

    return pipePath;
  }

  dispose(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(undefined);
    }
    this.pendingRequests.clear();
    this.forwardedRequests.clear();
    this.resolveRSocketWaiters(undefined);
    for (const socket of this.pendingRSockets) socket.destroy();
    this.pendingRSockets.clear();
    this.rSocket?.destroy();
    this.upstreamSocket?.destroy();
    this.rSocket = undefined;
    this.upstreamSocket = undefined;
    this.rBuffer = "";
    this.upstreamBuffer = "";
    this.workspaceData = undefined;
    this.libraryPathsRequest = undefined;
    this.sessionId = undefined;

    const server = this.server;
    this.server = undefined;
    if (server) {
      try {
        server.close();
      } catch {
      }
    }

    this.proxyPipePath = undefined;
    const directory = this.socketDirectory;
    this.socketDirectory = undefined;
    if (directory) void fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }

  async requestWorkspace(): Promise<WorkspaceData | undefined> {
    const socket = this.rSocket;
    const result = await this.request("workspace", {});
    if (!isWorkspaceData(result)) {
      return this.workspaceData;
    }
    // Do not restore data from a previous R socket after it disconnects.
    if (socket && (this.rSocket !== socket || socket.destroyed)) {
      return this.workspaceData;
    }
    if (this.workspaceData?.libraryPaths) {
      result.libraryPaths = this.workspaceData.libraryPaths;
    }
    // Workspace updates must not wait for the optional library-path probe.
    this.setWorkspaceData(result);
    this.refreshLibraryPaths();
    return result;
  }

  private refreshLibraryPaths(): void {
    const socket = this.rSocket;
    if (!socket || socket.destroyed || this.libraryPathsRequest) {
      return;
    }
    // sess completion returns list names without modifying R state.
    const request = this.request("completion", {
      expr: "stats::setNames(as.list(.libPaths()), .libPaths())",
      trigger: "$",
    }).then((paths) => {
      if (this.rSocket !== socket || socket.destroyed || !this.workspaceData) {
        return;
      }
      if (!Array.isArray(paths) || paths.length === 0 || !paths.every((item) =>
        item && typeof item.name === "string" && item.name.length > 0
      )) {
        return;
      }
      const libraryPaths = paths.map((item) => item.name as string);
      if (JSON.stringify(this.workspaceData.libraryPaths) !== JSON.stringify(libraryPaths)) {
        this.setWorkspaceData({ ...this.workspaceData, libraryPaths });
      }
    }).catch(() => undefined).finally(() => {
      if (this.libraryPathsRequest === request) {
        this.libraryPathsRequest = undefined;
      }
    });
    this.libraryPathsRequest = request;
  }

  getWorkspaceData(): WorkspaceData | undefined {
    return this.workspaceData;
  }

  setWorkspaceDataListener(listener: ((data: WorkspaceData) => void) | undefined): void {
    this.onWorkspaceData = listener;
    if (listener && this.workspaceData) {
      listener(this.workspaceData);
    }
  }

  setConnectionListener(listener: ((state: "attached" | "disconnected") => void) | undefined): void {
    this.onConnectionChange = listener;
  }

  getPipePath(): string | undefined {
    return this.proxyPipePath;
  }

  isConnected(): boolean {
    return Boolean(
      this.rSocket &&
        !this.rSocket.destroyed &&
        this.upstreamSocket &&
        !this.upstreamSocket.destroyed
    );
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  async requestMemberCompletions(
    expression: string,
    operator: "$" | "@"
  ): Promise<SessionMemberCompletionItem[] | undefined> {
    const result = await this.request("completion", {
      expr: expression,
      trigger: operator,
    });
    return parseMemberCompletionItems(result);
  }

  private createPipePath(): string {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    if (process.platform === "win32") {
      return `\\\\.\\pipe\\vscode-r-console-${suffix}`;
    }
    return path.join(os.tmpdir(), `vrc-${suffix}.sock`);
  }

  private acceptRSocket(socket: net.Socket): void {
    if (this.pendingRSockets.size >= MAX_PENDING_R_SOCKETS) {
      socket.destroy();
      return;
    }
    this.pendingRSockets.add(socket);
    socket.setEncoding("utf8");
    let parts: string[] = [];
    let lineBytes = 0;
    const cleanup = (): void => {
      clearTimeout(deadline);
      this.pendingRSockets.delete(socket);
      socket.off("data", receive);
      socket.off("error", reject);
      socket.off("close", reject);
    };
    const reject = (): void => {
      cleanup();
      socket.destroy();
    };
    const receive = (chunk: string): void => {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf("\n", offset);
        const part = chunk.slice(offset, end < 0 ? undefined : end);
        lineBytes += Buffer.byteLength(part, "utf8");
        if (lineBytes > MAX_SESS_LINE_BYTES) {
          reject();
          return;
        }
        parts.push(part);
        if (end < 0) return;
        const line = parts.join("");
        if (!line.trim()) {
          parts = [];
          lineBytes = 0;
          offset = end + 1;
          continue;
        }
        const message = parseJsonObject(line);
        const params = message?.params as Record<string, unknown> | undefined;
        if (message?.method !== "attach" || !params ||
            typeof params.session_id !== "string" || !params.session_id) {
          reject();
          return;
        }
        // A silent/read-only pipe client must not evict R or receive requests.
        // This is an admission check, not authentication: vscode-R still owns
        // attachment credentials and protocol validation.
        cleanup();
        this.attachRSocket(socket, `${line}\n${chunk.slice(end + 1)}`);
        return;
      }
    };
    const deadline = setTimeout(reject, ATTACH_TIMEOUT_MS);
    socket.on("data", receive);
    socket.on("error", reject);
    socket.on("close", reject);
  }

  private attachRSocket(socket: net.Socket, initialData: string): void {
    this.rSocket?.destroy();
    this.upstreamSocket?.destroy();
    this.resolvePendingRequests();
    this.forwardedRequests.clear();
    // A new attach can replace an old R socket during sess recovery.
    this.sessionId = undefined;
    this.workspaceData = undefined;
    this.libraryPathsRequest = undefined;
    this.rSocket = socket;
    const upstream = net.createConnection({ path: this.options.upstreamPipePath });
    this.upstreamSocket = upstream;
    // Keep the decoder installed during admission: it may hold a partial
    // UTF-8 character from a message following attach in the same chunk.
    upstream.setEncoding("utf8");
    this.rBuffer = "";
    this.upstreamBuffer = "";
    this.resolveRSocketWaiters(socket);

    socket.on("data", (chunk) => {
      if (this.rSocket !== socket) {
        return;
      }
      this.rBuffer = this.forwardLines(
        this.rBuffer,
        chunk,
        (line) => this.handleRLine(line),
        upstream,
        socket
      );
    });
    upstream.on("data", (chunk) => {
      if (this.rSocket !== socket) {
        return;
      }
      this.upstreamBuffer = this.forwardLines(
        this.upstreamBuffer,
        chunk,
        (line) => this.handleUpstreamLine(line),
        socket,
        upstream
      );
    });
    upstream.on("drain", () => {
      if (this.rSocket !== socket || socket.destroyed || upstream.destroyed) return;
      this.rBuffer = this.forwardLines(this.rBuffer, "", (line) => this.handleRLine(line), upstream, socket);
      if (!upstream.writableNeedDrain && !upstream.destroyed) socket.resume();
    });
    socket.on("drain", () => {
      if (this.rSocket !== socket || socket.destroyed || upstream.destroyed) return;
      this.upstreamBuffer = this.forwardLines(this.upstreamBuffer, "", (line) => this.handleUpstreamLine(line), socket, upstream);
      if (!socket.writableNeedDrain && !socket.destroyed) upstream.resume();
    });

    const close = (): void => {
      if (this.rSocket !== socket) {
        return;
      }
      this.rSocket = undefined;
      this.upstreamSocket = undefined;
      this.rBuffer = "";
      this.upstreamBuffer = "";
      socket.destroy();
      upstream.destroy();
      const wasAttached = Boolean(this.sessionId);
      this.sessionId = undefined;
      this.workspaceData = undefined;
      this.libraryPathsRequest = undefined;
      if (wasAttached) { this.onConnectionChange?.("disconnected"); }
      this.forwardedRequests.clear();
      this.resolveRSocketWaiters(undefined);
      this.resolvePendingRequests();
    };
    socket.on("close", close);
    socket.on("error", close);
    upstream.on("close", close);
    upstream.on("error", close);
    this.rBuffer = this.forwardLines("", initialData, (line) => this.handleRLine(line), upstream, socket);
  }

  private forwardLines(
    buffer: string,
    chunk: string | Buffer,
    handleLine: (line: string) => boolean,
    target: net.Socket | undefined,
    source?: net.Socket
  ): string {
    const combined = buffer + chunk.toString();
    const lines = combined.split("\n");
    const carry = lines.pop() ?? "";
    // A large batch of valid JSON-RPC messages is safe: bound each line,
    // not the entire socket chunk containing multiple completed messages.
    if ([...lines, carry].some((line) => Buffer.byteLength(line, "utf8") > MAX_SESS_LINE_BYTES)) {
      this.rSocket?.destroy();
      this.upstreamSocket?.destroy();
      return "";
    }
    let offset = 0;
    for (const rawLine of lines) {
      // Stop processing this batch as well as pausing future data events.
      // The drain handler forwards the untouched remainder before resuming reads.
      if (target?.writableNeedDrain) {
        source?.pause();
        return combined.slice(offset);
      }
      offset += rawLine.length + 1;
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (handleLine(line)) {
        if (!this.writeToSocket(target, `${line}\n`, source)) return "";
      }
    }
    return carry;
  }

  private writeToSocket(target: net.Socket | undefined, data: string, source?: net.Socket): boolean {
    if (!target || target.destroyed || target.writableNeedDrain) return false;
    try {
      if (!target.write(data)) source?.pause();
      return true;
    } catch {
      this.rSocket?.destroy();
      this.upstreamSocket?.destroy();
      return false;
    }
  }

  private handleRLine(line: string): boolean {
    const message = parseJsonObject(line);
    if (!message) {
      return true;
    }

    const id = getMessageId(message);
    if (id && !message.method) {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        clearTimeout(pending.timeout);
        pending.resolve(message.error ? undefined : message.result);
        return false;
      }

      const forwardedMethod = this.forwardedRequests.get(id);
      if (forwardedMethod) {
        this.forwardedRequests.delete(id);
        if (forwardedMethod === "workspace" && isWorkspaceData(message.result)) {
          this.setWorkspaceData(message.result);
        }
      }
      return true;
    }

    if (message.method === "attach") {
      const params = message.params;
      if (params && typeof params === "object" && !Array.isArray(params)) {
        const sessionId = (params as Record<string, unknown>).session_id;
        if (typeof sessionId === "string" && sessionId.length > 0) {
          this.sessionId = sessionId;
          this.onConnectionChange?.("attached");
        }
      }
      void this.requestWorkspace();
    } else if (message.method === "workspace_updated") {
      void this.requestWorkspace();
    }
    return true;
  }

  private handleUpstreamLine(line: string): boolean {
    const message = parseJsonObject(line);
    const id = message ? getMessageId(message) : undefined;
    if (id && typeof message?.method === "string") {
      this.forwardedRequests.set(id, message.method);
    }
    return true;
  }

  private async request(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown | undefined> {
    const socket = await this.waitForRSocket();
    // Optional workspace/completion probes must not bypass stream backpressure
    // or accumulate requests that will time out before they can be sent.
    if (!socket || socket.destroyed || socket.writableNeedDrain) {
      return undefined;
    }

    return new Promise((resolve) => {
      const id = `r-console-${randomUUID()}`;
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (!pending) {
          return;
        }
        this.pendingRequests.delete(id);
        pending.resolve(undefined);
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, timeout });
      if (!this.writeToSocket(socket, `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)) {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        resolve(undefined);
      }
    });
  }

  private waitForRSocket(): Promise<net.Socket | undefined> {
    const socket = this.rSocket;
    if (socket && !socket.destroyed) {
      return Promise.resolve(socket);
    }

    return new Promise((resolve) => {
      const done = (nextSocket: net.Socket | undefined): void => {
        clearTimeout(timer);
        resolve(nextSocket && !nextSocket.destroyed ? nextSocket : undefined);
      };
      const timer = setTimeout(() => {
        this.rSocketWaiters = this.rSocketWaiters.filter((waiter) => waiter !== done);
        resolve(undefined);
      }, R_SOCKET_WAIT_TIMEOUT_MS);
      this.rSocketWaiters.push(done);
    });
  }

  private resolveRSocketWaiters(socket: net.Socket | undefined): void {
    const waiters = this.rSocketWaiters.splice(0);
    for (const waiter of waiters) {
      waiter(socket);
    }
  }

  private setWorkspaceData(data: WorkspaceData): void {
    this.workspaceData = data;
    this.onWorkspaceData?.(data);
  }

  private resolvePendingRequests(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(undefined);
    }
    this.pendingRequests.clear();
  }
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function getMessageId(message: Record<string, unknown>): string | undefined {
  const id = message.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

function isWorkspaceData(value: unknown): value is WorkspaceData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const data = value as WorkspaceData;
  return (
    Array.isArray(data.search) &&
    Array.isArray(data.loaded_namespaces) &&
    !!data.globalenv &&
    typeof data.globalenv === "object" &&
    !Array.isArray(data.globalenv)
  );
}

function parseMemberCompletionItems(value: unknown): SessionMemberCompletionItem[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter(
    (item): item is SessionMemberCompletionItem =>
      !!item && typeof item === "object" && typeof item.name === "string" && item.name.length > 0
  );
  return items.length > 0 ? items : undefined;
}
