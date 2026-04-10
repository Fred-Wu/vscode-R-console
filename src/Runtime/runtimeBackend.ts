import { ChildProcess, spawn, SpawnOptions } from "child_process";
import * as fs from "fs";
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

type BackendProcessState = {
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
};

const PARSE_STATUS_TIMEOUT_MS = 150;

export interface RuntimeBackend {
  start(args: string[], options: RuntimeBackendStartOptions): ChildProcess;
  attach(process: ChildProcess, handlers: RuntimeBackendHandlers): void;
  hasCapability(process: ChildProcess | null, capability: BackendCapability): boolean;
  canUseSessionCommands(process: ChildProcess | null): boolean;
  sendSessionCommand(process: ChildProcess | null, command: RuntimeSessionCommand): boolean;
  requestParseStatus(process: ChildProcess | null, code: string): Promise<number> | undefined;
  close(process: ChildProcess): void;
}

export class RustSidecarRuntimeBackend implements RuntimeBackend {
  private readonly processStates = new WeakMap<ChildProcess, BackendProcessState>();

  constructor(private readonly sidecarPath: string) {}

  start(args: string[], options: RuntimeBackendStartOptions): ChildProcess {
    const child = spawn(this.sidecarPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.processStates.set(child, {
      capabilities: new Set<BackendCapability>(),
      hostConnected: false,
      nextRequestId: 0,
      pendingParseRequests: new Map(),
    });
    return child;
  }

  attach(process: ChildProcess, handlers: RuntimeBackendHandlers): void {
    const state = this.getOrCreateState(process);
    let stdoutCarry: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    process.stdout?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "binary");
      const parsed = parseBackendFrames(buffer, stdoutCarry);
      stdoutCarry = parsed.carry;

      if (parsed.error) {
        handlers.onError?.(new Error(parsed.error));
        return;
      }

      for (const outputChunk of parsed.output) {
        if (outputChunk.length > 0) {
          handlers.onStdout?.(outputChunk.toString("utf8"));
        }
      }

      for (const event of parsed.events) {
        this.handleProcessControlEvent(state, event);
        handlers.onControl?.(event);
      }
    });

    process.stderr?.on("data", (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      handlers.onStderr?.(text);
    });

    process.on("exit", (code) => {
      if (stdoutCarry.length > 0) {
        handlers.onStderr?.(
          `[r-console] truncated backend frame stream (${stdoutCarry.length} buffered bytes left)\n`
        );
        stdoutCarry = Buffer.alloc(0);
      }
      this.resolvePendingParseRequests(state, 1);
      handlers.onExit?.(code ?? 0);
    });

    process.on("error", (error) => {
      this.resolvePendingParseRequests(state, 1);
      handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  canUseSessionCommands(process: ChildProcess | null): boolean {
    if (!process) {
      return false;
    }
    const state = this.processStates.get(process);
    if (!state) {
      return false;
    }
    return (
      state.hostConnected &&
      state.capabilities.has("session-control") &&
      state.capabilities.has("top-level-submit") &&
      state.capabilities.has("nested-input")
    );
  }

  hasCapability(process: ChildProcess | null, capability: BackendCapability): boolean {
    if (!process) {
      return false;
    }
    const state = this.processStates.get(process);
    if (!state || !state.hostConnected) {
      return false;
    }
    return state.capabilities.has(capability);
  }

  sendSessionCommand(process: ChildProcess | null, command: RuntimeSessionCommand): boolean {
    if (!process) {
      return false;
    }
    const state = this.processStates.get(process);
    if (!state || !state.hostConnected || !state.capabilities.has("session-control")) {
      return false;
    }

    switch (command.type) {
      case "submit":
        if (!state.capabilities.has("top-level-submit")) {
          return false;
        }
        return this.writeFrame(process, encodeSubmitFrame(command.code));
      case "interrupt":
        return this.writeFrame(process, encodeInterruptFrame());
      case "reply-input":
        if (!state.capabilities.has("nested-input")) {
          return false;
        }
        return this.writeFrame(process, encodeReplyInputFrame(command.text));
      case "set-width":
        if (!state.capabilities.has("set-width")) {
          return false;
        }
        return this.writeFrame(process, encodeSetWidthFrame(command.columns));
      case "dialog-result":
        return this.writeFrame(process, encodeDialogResultFrame(command.result));
      default:
        return false;
    }
  }

  requestParseStatus(process: ChildProcess | null, code: string): Promise<number> | undefined {
    if (!process) {
      return undefined;
    }
    const state = this.processStates.get(process);
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
      const sent = this.writeFrame(process, encodeParseStatusRequestFrame(requestId, code));
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

  close(process: ChildProcess): void {
    if (!process.stdin || process.killed || process.stdin.destroyed || process.stdin.writableEnded) {
      return;
    }
    try {
      process.stdin.write(encodeShutdownFrame());
      process.stdin.end();
    } catch {
    }
  }

  private writeFrame(process: ChildProcess, frame: Buffer): boolean {
    if (
      !process.stdin ||
      process.killed ||
      process.stdin.destroyed ||
      process.stdin.writableEnded
    ) {
      return false;
    }
    try {
      process.stdin.write(frame);
      return true;
    } catch {
      return false;
    }
  }

  private getOrCreateState(process: ChildProcess): BackendProcessState {
    const existing = this.processStates.get(process);
    if (existing) {
      return existing;
    }
    const created: BackendProcessState = {
      capabilities: new Set<BackendCapability>(),
      hostConnected: false,
      nextRequestId: 0,
      pendingParseRequests: new Map(),
    };
    this.processStates.set(process, created);
    return created;
  }

  private handleProcessControlEvent(
    state: BackendProcessState,
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

  private resolvePendingParseRequests(state: BackendProcessState, status: number): void {
    for (const pending of state.pendingParseRequests.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(status);
    }
    state.pendingParseRequests.clear();
  }
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
