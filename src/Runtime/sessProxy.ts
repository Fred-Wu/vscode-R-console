import { randomUUID } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import type {
  SessionMemberCompletionItem,
  WorkspaceData,
} from "./sessionWatcher";

type PendingRequest = {
  resolve: (value: unknown | undefined) => void;
  timeout: NodeJS.Timeout;
};

type SessProxyOptions = {
  upstreamPipePath: string;
  onWorkspaceData?: (data: WorkspaceData) => void;
};

const REQUEST_TIMEOUT_MS = 2000;
const R_SOCKET_WAIT_TIMEOUT_MS = 1200;

export class SessProxy {
  private server: net.Server | undefined;
  private proxyPipePath: string | undefined;
  private rSocket: net.Socket | undefined;
  private upstreamSocket: net.Socket | undefined;
  private rBuffer = "";
  private upstreamBuffer = "";
  private pendingRequests = new Map<string, PendingRequest>();
  private forwardedRequests = new Map<string, string>();
  private rSocketWaiters: Array<(socket: net.Socket | undefined) => void> = [];
  private workspaceData: WorkspaceData | undefined;

  constructor(private readonly options: SessProxyOptions) {}

  async start(): Promise<string> {
    this.dispose();
    const pipePath = this.createPipePath();
    if (process.platform !== "win32") {
      await fs.promises.rm(pipePath, { force: true }).catch(() => undefined);
    }

    this.server = net.createServer((socket) => this.attachRSocket(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("sess proxy server was not created"));
        return;
      }
      server.once("error", reject);
      server.listen(pipePath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.proxyPipePath = pipePath;
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
    this.rSocket?.destroy();
    this.upstreamSocket?.destroy();
    this.rSocket = undefined;
    this.upstreamSocket = undefined;
    this.rBuffer = "";
    this.upstreamBuffer = "";
    this.workspaceData = undefined;

    const server = this.server;
    this.server = undefined;
    if (server) {
      try {
        server.close();
      } catch {
      }
    }

    const pipePath = this.proxyPipePath;
    this.proxyPipePath = undefined;
    if (pipePath && process.platform !== "win32") {
      void fs.promises.rm(pipePath, { force: true }).catch(() => undefined);
    }
  }

  async requestWorkspace(): Promise<WorkspaceData | undefined> {
    const result = await this.request("workspace", {});
    if (!isWorkspaceData(result)) {
      return this.workspaceData;
    }
    this.setWorkspaceData(result);
    return result;
  }

  getWorkspaceData(): WorkspaceData | undefined {
    return this.workspaceData;
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
    return path.join("/tmp", `vrc-${suffix}.sock`);
  }

  private attachRSocket(socket: net.Socket): void {
    this.rSocket?.destroy();
    this.upstreamSocket?.destroy();
    this.rSocket = socket;
    this.upstreamSocket = net.createConnection({ path: this.options.upstreamPipePath });
    this.rBuffer = "";
    this.upstreamBuffer = "";
    this.resolveRSocketWaiters(socket);

    socket.on("data", (chunk) => this.forwardRData(chunk));
    this.upstreamSocket.on("data", (chunk) => this.forwardUpstreamData(chunk));

    const close = (): void => {
      if (this.rSocket === socket) {
        this.rSocket = undefined;
        this.resolveRSocketWaiters(undefined);
      }
      this.upstreamSocket?.destroy();
      this.upstreamSocket = undefined;
      this.resolvePendingRequests();
    };
    socket.on("close", close);
    socket.on("error", close);
    this.upstreamSocket.on("close", close);
    this.upstreamSocket.on("error", close);
  }

  private forwardRData(chunk: Buffer): void {
    this.rBuffer = this.forwardLines(
      this.rBuffer,
      chunk,
      (line) => this.handleRLine(line),
      this.upstreamSocket
    );
  }

  private forwardUpstreamData(chunk: Buffer): void {
    this.upstreamBuffer = this.forwardLines(
      this.upstreamBuffer,
      chunk,
      (line) => this.handleUpstreamLine(line),
      this.rSocket
    );
  }

  private forwardLines(
    buffer: string,
    chunk: Buffer,
    handleLine: (line: string) => boolean,
    target: net.Socket | undefined
  ): string {
    const combined = buffer + chunk.toString("utf8");
    const lines = combined.split("\n");
    const carry = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (handleLine(line)) {
        target?.write(`${line}\n`);
      }
    }
    return carry;
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

    if (message.method === "attach" || message.method === "workspace_updated") {
      setTimeout(() => void this.requestWorkspace(), 0);
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
    if (!socket || socket.destroyed) {
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
      try {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch {
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
    this.options.onWorkspaceData?.(data);
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
