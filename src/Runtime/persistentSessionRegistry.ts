import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import type { PersistedRTerminalState, PersistedRTerminalOptions } from "../Terminal/rTerminal";
import { BACKEND_PROTOCOL_VERSION } from "./backendProtocol";

export type TerminalContext =
  | { kind: "panel" }
  | { kind: "editor"; viewColumn: vscode.ViewColumn };

export type PersistedConsoleRecord = {
  terminal: PersistedRTerminalState;
  location: TerminalContext;
  terminalName?: string;
};

export type LegacyConsoleRecord = Omit<PersistedConsoleRecord, "terminal"> & {
  terminal: Omit<PersistedRTerminalState, "runtime"> & {
    runtime: Omit<PersistedRTerminalState["runtime"], "authToken" | "protocolVersion"> & { protocolVersion?: 1 };
  };
};

export function isLegacyConsoleRecord(value: unknown): value is LegacyConsoleRecord {
  if (!isObjectRecord(value) || !isObjectRecord(value.terminal)) return false;
  const { options, runtime, ui } = value.terminal;
  return isPersistedRTerminalOptions(options) && isPersistedUiSnapshot(ui) &&
    isPersistedTerminalContext(value.location) &&
    (value.terminalName === undefined || typeof value.terminalName === "string") &&
    isObjectRecord(runtime) && !Object.hasOwn(runtime, "authToken") &&
    // v0.5.4 did not persist its protocol version or authentication credentials.
    (!Object.hasOwn(runtime, "protocolVersion") || runtime.protocolVersion === 1) &&
    typeof runtime.sessionId === "string" && runtime.sessionId.trim().length > 0 &&
    isPositiveInteger(runtime.port) && runtime.port <= 65535 &&
    (runtime.pid === undefined || isPositiveInteger(runtime.pid));
}

/** Retain incompatible records without ever passing them to authenticated reconnect. */
export class PersistentSessionRegistry {
  private preserved: unknown[] = [];
  private sessions: PersistedConsoleRecord[] = [];
  private metadata: Record<string, unknown> = {};
  private writable = false;

  constructor(readonly filePath: string) {}

  get legacySessions(): LegacyConsoleRecord[] {
    return this.preserved.filter(isLegacyConsoleRecord);
  }

  async load(): Promise<PersistedConsoleRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await fs.promises.readFile(this.filePath, "utf8"));
      if (!isObjectRecord(parsed) || !Array.isArray(parsed.sessions)) {
        this.writable = false;
        return [];
      }
      this.metadata = parsed;
      this.preserved = parsed.sessions.filter((entry: unknown) => !isPersistedConsoleRecord(entry));
      this.sessions = parsed.sessions.filter(isPersistedConsoleRecord).filter(hasLivePersistedRuntime);
      this.writable = true;
      return [...this.sessions];
    } catch (error) {
      this.writable = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (this.writable) {
        this.metadata = {};
        this.preserved = [];
        this.sessions = [];
      }
      // Do not overwrite an unreadable or malformed registry on the next heartbeat.
      return [];
    }
  }

  save(sessions: PersistedConsoleRecord[]): boolean {
    if (!this.writable) return false;
    this.sessions = sessions.filter(hasLivePersistedRuntime);
    const all = [...this.sessions, ...this.preserved];
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      if (all.length === 0 && Object.keys(this.metadata).every((key) => key === "sessions")) {
        fs.rmSync(this.filePath, { force: true });
      } else {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify({ ...this.metadata, sessions: all }), {
          encoding: "utf8", mode: 0o600, flag: "wx",
        });
        fs.renameSync(temporary, this.filePath);
      }
      return true;
    } catch {
      return false;
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  }

  forgetLegacySession(entry: LegacyConsoleRecord): boolean {
    const previous = this.preserved;
    this.preserved = previous.filter((item) => !isLegacyConsoleRecord(item) ||
      item.terminal.runtime.sessionId !== entry.terminal.runtime.sessionId ||
      item.terminal.runtime.port !== entry.terminal.runtime.port ||
      getPersistedRuntimePid(item.terminal) !== getPersistedRuntimePid(entry.terminal));
    if (this.save(this.sessions)) return true;
    this.preserved = previous;
    return false;
  }
}

export function getPersistedRuntimePid(state: Pick<PersistedRTerminalState, "ui"> & { runtime: { pid?: number } }): number | undefined {
  const runtimePid = state.runtime.pid;
  if (isPositiveInteger(runtimePid)) {
    return runtimePid;
  }

  const backendChildPid = state.ui.backendChildPid;
  return isPositiveInteger(backendChildPid) ? backendChildPid : undefined;
}

export function hasLivePersistedRuntime(entry: PersistedConsoleRecord): boolean {
  const pid = getPersistedRuntimePid(entry.terminal);
  return typeof pid !== "number" || isProcessAlive(pid);
}

function isPersistedConsoleRecord(value: unknown): value is PersistedConsoleRecord {
  if (!isObjectRecord(value)) {
    return false;
  }
  if (!isPersistedRTerminalState(value.terminal)) {
    return false;
  }
  if (!isPersistedTerminalContext(value.location)) {
    return false;
  }
  if (value.terminalName !== undefined && typeof value.terminalName !== "string") {
    return false;
  }
  return true;
}

function isPersistedRTerminalState(value: unknown): value is PersistedRTerminalState {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    isPersistedRTerminalOptions(value.options) &&
    isRuntimeSessionReconnectInfo(value.runtime) &&
    isPersistedUiSnapshot(value.ui)
  );
}

function isPersistedRTerminalOptions(value: unknown): value is PersistedRTerminalOptions {
  if (!isObjectRecord(value)) {
    return false;
  }
  if (typeof value.rPath !== "string" || value.rPath.trim().length === 0) {
    return false;
  }
  if (!Array.isArray(value.rArgs) || value.rArgs.some((entry) => typeof entry !== "string")) {
    return false;
  }
  if (typeof value.bracketedPaste !== "boolean") {
    return false;
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    return false;
  }
  return true;
}

function isRuntimeSessionReconnectInfo(
  value: unknown
): value is PersistedRTerminalState["runtime"] {
  if (!isObjectRecord(value)) {
    return false;
  }
  if (typeof value.sessionId !== "string" || value.sessionId.trim().length === 0) {
    return false;
  }
  if (value.protocolVersion !== BACKEND_PROTOCOL_VERSION) return false;
  if (!isPositiveInteger(value.port) || typeof value.authToken !== "string" || !/^[0-9a-f]{64}$/.test(value.authToken)) {
    return false;
  }
  if (value.pid !== undefined && !isPositiveInteger(value.pid)) {
    return false;
  }
  return true;
}

function isPersistedUiSnapshot(value: unknown): value is PersistedRTerminalState["ui"] {
  if (!isObjectRecord(value) || !isPersistedReplaySnapshot(value.replay)) {
    return false;
  }
  if (!isPositiveInteger(value.replayColumns) || !isPositiveInteger(value.replayRows)) {
    return false;
  }
  if (!["starting", "ready", "executing", "reply", "closed"].includes(String(value.mode))) {
    return false;
  }
  if (!["main", "cont"].includes(String(value.promptKind))) {
    return false;
  }
  if (
    typeof value.promptReady !== "boolean" ||
    typeof value.promptVisible !== "boolean" ||
    typeof value.replyPromptText !== "string" ||
    typeof value.pendingPromptToken !== "boolean" ||
    typeof value.pendingInitialPromptGap !== "boolean" ||
    typeof value.lastWriteEndedWithNewline !== "boolean" ||
    typeof value.hasReceivedOutput !== "boolean" ||
    typeof value.inputText !== "string" ||
    !isNonNegativeInteger(value.inputCursorPosition)
  ) {
    return false;
  }
  if (value.backendChildPid !== undefined && !isPositiveInteger(value.backendChildPid)) {
    return false;
  }
  return true;
}

function isPersistedReplaySnapshot(
  value: unknown
): value is PersistedRTerminalState["ui"]["replay"] {
  if (!isObjectRecord(value)) {
    return false;
  }
  if (!Array.isArray(value.lines) || value.lines.some((line) => typeof line !== "string")) {
    return false;
  }
  return (
    isNonNegativeInteger(value.finalRow) &&
    isNonNegativeInteger(value.cursorRow) &&
    isNonNegativeInteger(value.cursorCol)
  );
}

function isPersistedTerminalContext(value: unknown): value is TerminalContext {
  if (!isObjectRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "panel") {
    return true;
  }
  return value.kind === "editor" && typeof value.viewColumn === "number";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isObjectRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

