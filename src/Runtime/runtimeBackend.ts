import { ChildProcess, spawn, SpawnOptions } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  type BackendCapability,
  type BackendControlEvent,
  encodeInputBytesFrame,
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
    };

type BackendProcessState = {
  capabilities: Set<BackendCapability>;
  hostConnected: boolean;
  nextRequestId: number;
  pendingParseRequests: Map<number, (status: number) => void>;
};

export interface RuntimeBackend {
  start(args: string[], options: RuntimeBackendStartOptions): ChildProcess;
  attach(process: ChildProcess, handlers: RuntimeBackendHandlers): void;
  canUseSessionCommands(process: ChildProcess | null): boolean;
  sendSessionCommand(process: ChildProcess | null, command: RuntimeSessionCommand): boolean;
  requestParseStatus(process: ChildProcess | null, code: string): Promise<number> | undefined;
  write(process: ChildProcess, payload: string): boolean;
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
      pendingParseRequests: new Map<number, (status: number) => void>(),
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
        return this.writeFrame(process, encodeSubmitFrame(command.code));
      case "interrupt":
        return this.writeFrame(process, encodeInterruptFrame());
      case "reply-input":
        return this.writeFrame(process, encodeReplyInputFrame(command.text));
      case "set-width":
        return this.writeFrame(process, encodeSetWidthFrame(command.columns));
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

    return new Promise<number>((resolve) => {
      const requestId = ++state.nextRequestId;
      state.pendingParseRequests.set(requestId, resolve);
      const sent = this.writeFrame(process, encodeParseStatusRequestFrame(requestId, code));
      if (sent) {
        return;
      }
      state.pendingParseRequests.delete(requestId);
      resolve(1);
    });
  }

  write(process: ChildProcess, payload: string): boolean {
    const normalizedPayload = payload.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return this.writeFrame(process, encodeInputBytesFrame(Buffer.from(normalizedPayload, "utf8")));
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
      pendingParseRequests: new Map<number, (status: number) => void>(),
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
        const resolve = state.pendingParseRequests.get(event.requestId);
        if (!resolve) {
          return;
        }
        state.pendingParseRequests.delete(event.requestId);
        resolve(event.status);
        return;
      }
      default:
        return;
    }
  }

  private resolvePendingParseRequests(state: BackendProcessState, status: number): void {
    for (const resolve of state.pendingParseRequests.values()) {
      resolve(status);
    }
    state.pendingParseRequests.clear();
  }
}

function getRustSidecarExecutableName(): string {
  return process.platform === "win32" ? "R_CONSOLE_HOST.exe" : "R_CONSOLE_HOST";
}

export function getRustSidecarCandidates(extensionPath: string): string[] {
  const exeName = getRustSidecarExecutableName();
  return [
    path.join(extensionPath, "sidecar", "pty-host", "target", "release", exeName),
    path.join(extensionPath, "sidecar", "pty-host", "target", "debug", exeName),
    path.join(extensionPath, "bundled", "bin", exeName),
  ];
}

export function resolveRustSidecarPath(extensionPath: string): string | undefined {
  const candidates = getRustSidecarCandidates(extensionPath);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
