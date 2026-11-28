import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import type { PersistedRTerminalState, PersistedRTerminalOptions } from "../Terminal/rTerminal";
import { BACKEND_PROTOCOL_VERSION } from "./backendProtocol";
import { isSessionRegistryIdentity, readSessionRegistryKey, type SessionRegistryIdentity, type SessionRegistryKeyReader } from "./sessionRegistryKey";

const REGISTRY_FORMAT = "r-console-session-records";
type EncryptedSession = SessionRegistryIdentity & { iv: string; tag: string; ciphertext: string };
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const identityKey = (identity: SessionRegistryIdentity): string => `${identity.sessionId}:${identity.pid}`;

function identityOf(record: unknown): SessionRegistryIdentity | undefined {
  if (!isObjectRecord(record) || !isObjectRecord(record.terminal) || !isObjectRecord(record.terminal.runtime)) return;
  const identity = { sessionId: record.terminal.runtime.sessionId,
    pid: record.terminal.runtime.pid ?? record.terminal.ui?.backendChildPid };
  return isSessionRegistryIdentity(identity) ? identity : undefined;
}

function base64(value: unknown, size?: number): Buffer {
  if (typeof value !== "string") throw new Error("Invalid encrypted registry");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (size !== undefined && bytes.length !== size)) throw new Error("Invalid encrypted registry");
  return bytes;
}

export type TerminalContext =
  | { kind: "panel" }
  | { kind: "editor"; viewColumn: vscode.ViewColumn };

export type PersistedConsoleRecord = {
  terminal: PersistedRTerminalState;
  location: TerminalContext;
  terminalName?: string;
};

export async function getPersistentSessionRegistryPath(
  context: Pick<vscode.ExtensionContext, "storageUri" | "globalStorageUri" | "workspaceState">
): Promise<string> {
  if (context.storageUri) {
    return path.join(context.storageUri.fsPath, "persistent-sessions.json");
  }

  // Empty windows have separate workspaceState, which survives window reloads.
  const key = "persistentSessionWindowId";
  let windowId = context.workspaceState.get<string>(key);
  if (!windowId) {
    windowId = randomUUID();
    await context.workspaceState.update(key, windowId);
  }
  return path.join(context.globalStorageUri.fsPath, "folderless", windowId, "persistent-sessions.json");
}

export type LegacyConsoleRecord = {
  terminal: {
    runtime: { sessionId: string; pid?: number; port: number; protocolVersion?: number; authToken?: string };
    ui?: { backendChildPid?: number };
  };
};
type ShutdownRecord = {
  terminal: {
    runtime: SessionRegistryIdentity & { port: number; protocolVersion: number; authToken?: string };
  };
};
type ShutdownStorage = Pick<vscode.SecretStorage, "get" | "store" | "delete">;

function shutdownRecord(value: unknown): ShutdownRecord | undefined {
  if (!isObjectRecord(value) || !isObjectRecord(value.terminal)) return;
  const { runtime, ui } = value.terminal;
  if (!isObjectRecord(runtime)) return;
  // Only the historical unauthenticated format omitted both fields.
  const version = !Object.hasOwn(runtime, "protocolVersion") && !Object.hasOwn(runtime, "authToken")
    ? 1 : runtime.protocolVersion;
  if (!isPositiveInteger(version) || version >= BACKEND_PROTOCOL_VERSION) return;
  const credentialsValid = version === 1
    ? !Object.hasOwn(runtime, "authToken")
    : typeof runtime.authToken === "string" && /^[0-9a-f]{64}$/.test(runtime.authToken);
  const identity = { sessionId: runtime.sessionId, pid: runtime.pid ?? ui?.backendChildPid };
  if (!credentialsValid || !isSessionRegistryIdentity(identity) ||
      !isPositiveInteger(runtime.port) || runtime.port > 65535) return;
  return { terminal: { runtime: { ...identity, port: runtime.port, protocolVersion: version,
    ...(version >= 2 ? { authToken: runtime.authToken } : {}) } } };
}

export function isLegacyConsoleRecord(value: unknown): value is LegacyConsoleRecord {
  return shutdownRecord(value) !== undefined;
}

/** Retain incompatible records without ever passing them to authenticated reconnect. */
export class PersistentSessionRegistry {
  private legacyRecords: ShutdownRecord[] = [];
  private sessions: PersistedConsoleRecord[] = [];
  private metadata: Record<string, unknown> = {};
  private readonly recordMetadata = new Map<string, Record<string, unknown>>();
  private writable = false;
  private opaque: EncryptedSession[] = [];
  private encryptedRecords = new Map<string, EncryptedSession>();
  private readonly keys = new Map<string, Buffer>();
  private readonly pendingKeys = new Map<string, Promise<Buffer>>();
  private readonly failedKeys = new Map<string, { error: unknown; retryAfter: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  private scheduledSave: { records: unknown[]; generation: number; result: Promise<boolean> } | undefined;
  private originalDigest: string | undefined;
  private generation = 0;
  private disposed = false;
  private reportedError: string | undefined;
  private readonly scope: string;

  constructor(readonly filePath: string, private readonly readKey: SessionRegistryKeyReader = readSessionRegistryKey,
    private readonly onError: (message: string) => void = () => {},
    private readonly shutdownStorage?: ShutdownStorage) {
    this.scope = digest(path.resolve(filePath));
  }

  get legacySessions(): LegacyConsoleRecord[] {
    return this.legacyRecords.filter(entry => isProcessAlive(entry.terminal.runtime.pid));
  }

  load(): Promise<PersistedConsoleRecord[]> {
    this.scheduledSave = undefined;
    const pending = this.queue.then(() => this.loadInternal());
    this.queue = pending.catch(() => {});
    return pending;
  }

  private async loadInternal(): Promise<PersistedConsoleRecord[]> {
    if (this.disposed) return [];
    this.writable = false;
    this.generation++;
    this.clearKeys();
    this.metadata = {};
    this.recordMetadata.clear();
    this.sessions = [];
    this.opaque = [];
    this.encryptedRecords.clear();
    try {
      let original: string | undefined;
      try { original = await fs.promises.readFile(this.filePath, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      this.originalDigest = original === undefined ? undefined : digest(original);
      const parsed: unknown = original === undefined ? { format: REGISTRY_FORMAT, version: 1, sessions: [] } : JSON.parse(original);
      if (!isObjectRecord(parsed) || !Array.isArray(parsed.sessions)) throw new Error("Invalid registry schema");
      let records: unknown[];
      const plaintext = parsed.format !== REGISTRY_FORMAT;
      if (!plaintext) {
        if (parsed.version !== 1) throw new Error("Unsupported registry format");
        const entries = parsed.sessions.map((entry: unknown) => {
          if (!isSessionRegistryIdentity(entry) || !isObjectRecord(entry)) throw new Error("Invalid registry identity");
          const row = entry as EncryptedSession;
          base64(row.iv, 12); base64(row.tag, 16); base64(row.ciphertext);
          return row;
        });
        this.encryptedRecords = new Map(entries.map(row => [identityKey(row), row]));
        const decoded = await Promise.all(entries.map(async row => {
          if (!isProcessAlive(row.pid)) return;
          try {
            const key = await this.keyFor(row);
            const decipher = createDecipheriv("aes-256-gcm", key, base64(row.iv, 12));
            decipher.setAAD(this.associatedData(row));
            decipher.setAuthTag(base64(row.tag, 16));
            const partial = decipher.update(base64(row.ciphertext));
            let plaintext: Buffer | undefined;
            try {
              plaintext = Buffer.concat([partial, decipher.final()]);
              const value = JSON.parse(plaintext.toString("utf8"));
              if (!isObjectRecord(value) || identityKey(identityOf(value.record) ?? { sessionId: "", pid: 0 }) !== identityKey(row) ||
                  !isObjectRecord(value.metadata)) throw new Error("Registry identity mismatch");
              if (!isPersistedConsoleRecord(value.record) && !isLegacyConsoleRecord(value.record)) {
                this.opaque.push(row);
                return;
              }
              this.recordMetadata.set(identityKey(row), value.metadata);
              return value;
            } finally { partial.fill(0); plaintext?.fill(0); }
          } catch {
            this.opaque.push(row);
            return;
          }
        }));
        records = decoded.filter(value => value !== undefined).map(value => value.record);
        this.metadata = decoded.find(value => value && isPersistedConsoleRecord(value.record))?.metadata ?? {};
        if (this.opaque.length) this.reportError("Some saved R Console sessions could not be decrypted. Their encrypted records have been retained for retry.");
      } else {
        if (Object.hasOwn(parsed, "format")) throw new Error("Unsupported registry format");
        records = parsed.sessions;
      }
      // Keep shutdown credentials separate from restorable records, even if
      // the user later cancels the upgrade prompt.
      const legacy = records.some(isLegacyConsoleRecord);
      try {
        await this.retainShutdownRecords(records);
      } catch (error) {
        if (plaintext || legacy) throw error;
        this.reportError("R Console could not read its old-session shutdown credentials.");
      }
      if (this.disposed) return [];
      if (plaintext) {
        // A same/newer protocol record cannot be safely classified as an old
        // shutdown-only runtime. Never discard its last reconnect information.
        if (records.some(entry => {
          const record = entry as { terminal?: { runtime?: { protocolVersion?: number } } } | null;
          const version = record?.terminal?.runtime?.protocolVersion;
          const id = identityOf(entry);
          return typeof version === "number" && version >= BACKEND_PROTOCOL_VERSION &&
            id !== undefined && isProcessAlive(id.pid);
        })) throw new Error("Live plaintext session cannot be safely replaced before the protocol upgrade");
        // No plaintext replay is restored or converted. Remove the file only
        // after securing old-protocol shutdown credentials.
        this.assertRegistryUnchanged();
        fs.rmSync(this.filePath, { force: true });
        this.originalDigest = undefined;
        this.writable = true;
        return [];
      }
      this.sessions = records.filter(isPersistedConsoleRecord).filter(hasLivePersistedRuntime);
      this.writable = true;
      if (legacy) await this.saveInternal(this.sessions);
      return [...this.sessions];
    } catch {
      this.writable = false;
      this.clearKeys();
      this.reportError("R Console could not read its saved session registry. The existing file has been preserved and saving is disabled.");
      return [];
    }
  }

  save(sessions: PersistedConsoleRecord[]): Promise<boolean> {
    if (!this.writable || this.disposed) return Promise.resolve(false);
    this.sessions = sessions.filter(isPersistedConsoleRecord).filter(hasLivePersistedRuntime);
    let records: unknown[];
    try { records = JSON.parse(JSON.stringify(this.sessions)); }
    catch { this.reportError("R Console could not encode its saved sessions. The existing file has been preserved."); return Promise.resolve(false); }
    if (this.scheduledSave?.generation === this.generation) {
      this.scheduledSave.records = records;
      return this.scheduledSave.result;
    }
    const generation = this.generation;
    const batch = { records, generation, result: Promise.resolve(false) };
    const pending = this.queue.then(() => {
      if (this.scheduledSave === batch) this.scheduledSave = undefined;
      return generation === this.generation ? this.saveInternal(batch.records) : false;
    });
    batch.result = pending;
    this.scheduledSave = batch;
    this.queue = pending.catch(() => false);
    return pending;
  }

  private get shutdownStorageKey(): string {
    return "r-console.legacy-shutdown.v1:" + this.scope;
  }

  private async retainShutdownRecords(records: unknown[]): Promise<void> {
    const incoming = records.map(shutdownRecord).filter((entry): entry is ShutdownRecord =>
      entry !== undefined && isProcessAlive(entry.terminal.runtime.pid));
    if (!this.shutdownStorage) {
      if (incoming.length) throw new Error("Secure shutdown storage unavailable");
      return;
    }
    const saved = await this.shutdownStorage.get(this.shutdownStorageKey);
    const decoded: unknown = saved === undefined ? [] : JSON.parse(saved);
    if (!Array.isArray(decoded)) throw new Error("Invalid shutdown storage");
    const entries = new Map<string, ShutdownRecord>();
    for (const value of [...decoded, ...incoming]) {
      const entry = shutdownRecord(value);
      if (!entry || !isProcessAlive(entry.terminal.runtime.pid)) continue;
      const id = identityKey(entry.terminal.runtime);
      if (!entries.has(id)) entries.set(id, entry);
    }
    const next = [...entries.values()];
    if (this.disposed) return;
    if (saved !== (next.length ? JSON.stringify(next) : undefined)) await this.writeShutdownRecords(next);
    this.legacyRecords = next;
  }

  private async writeShutdownRecords(records: ShutdownRecord[]): Promise<void> {
    if (!this.shutdownStorage) throw new Error("Secure shutdown storage unavailable");
    if (records.length) await this.shutdownStorage.store(this.shutdownStorageKey, JSON.stringify(records));
    else await this.shutdownStorage.delete(this.shutdownStorageKey);
  }

  forgetLegacySession(entry: LegacyConsoleRecord): Promise<boolean> {
    const pending = this.queue.then(async () => {
      if (this.disposed) return false;
      const selected = shutdownRecord(entry);
      if (!selected) return false;
      const id = identityKey(selected.terminal.runtime);
      const next = this.legacyRecords.filter(item => identityKey(item.terminal.runtime) !== id);
      if (next.length === this.legacyRecords.length) return true;
      try {
        await this.writeShutdownRecords(next);
        this.legacyRecords = next;
        return true;
      } catch {
        this.reportError("R Console could not remove the old session's saved shutdown credentials.");
        return false;
      }
    });
    this.queue = pending.catch(() => false);
    return pending;
  }

  dispose(): void {
    this.disposed = true;
    this.writable = false;
    this.generation++;
    this.clearKeys();
  }

  private clearKeys(): void {
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
    this.pendingKeys.clear();
    this.failedKeys.clear();
  }

  private async keyFor(identity: SessionRegistryIdentity): Promise<Buffer> {
    const id = identityKey(identity);
    const existing = this.keys.get(id);
    if (existing) return existing;
    const pending = this.pendingKeys.get(id);
    if (pending) return pending;
    const failed = this.failedKeys.get(id);
    if (failed && Date.now() < failed.retryAfter) throw failed.error;
    const generation = this.generation;
    const request = this.readKey(identity).then(key => {
      if (this.disposed || generation !== this.generation || key.length !== 32) {
        key.fill(0);
        throw new Error("Session key transfer cancelled or invalid");
      }
      this.keys.set(id, key);
      this.failedKeys.delete(id);
      return key;
    }).catch(error => {
      if (!this.disposed && generation === this.generation) this.failedKeys.set(id, { error, retryAfter: Date.now() + 5000 });
      throw error;
    });
    this.pendingKeys.set(id, request);
    try { return await request; }
    finally { if (this.pendingKeys.get(id) === request) this.pendingKeys.delete(id); }
  }

  private associatedData(identity: SessionRegistryIdentity): Buffer {
    return Buffer.from(`${REGISTRY_FORMAT}:1:${this.scope}:${identityKey(identity)}`);
  }

  private reportError(message: string): void {
    if (this.disposed || this.reportedError === message) return;
    this.reportedError = message;
    try { this.onError(message); } catch { /* Reporting must not interrupt persistence. */ }
  }

  private assertRegistryUnchanged(): void {
    let current: string | undefined;
    try { current = fs.readFileSync(this.filePath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if ((current === undefined ? undefined : digest(current)) !== this.originalDigest) throw new Error("Registry changed on disk");
  }

  private async saveInternal(records: unknown[]): Promise<boolean> {
    if (this.disposed || !this.writable) return false;
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const opaque = this.opaque.filter(row => isProcessAlive(row.pid));
      const blocked = new Set(opaque.map(identityKey));
      const owned = records.map(record => ({ record, identity: identityOf(record) }));
      if (owned.some(item => !item.identity)) throw new Error("Saved record has no session key owner");
      const alive = owned.filter(item => isProcessAlive(item.identity!.pid) && !blocked.has(identityKey(item.identity!)));
      const encrypted = await Promise.allSettled(alive.map(async ({ record, identity }) => {
        const key = await this.keyFor(identity!);
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(this.associatedData(identity!));
        const plaintext = Buffer.from(JSON.stringify({ record, metadata: this.recordMetadata.get(identityKey(identity!)) ?? this.metadata }));
        let ciphertext: Buffer;
        try { ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); }
        finally { plaintext.fill(0); }
        return { ...identity!, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
      }));
      let incomplete = false;
      const rows = encrypted.flatMap((result, index) => {
        if (result.status === "fulfilled") return [result.value];
        incomplete = true;
        const previous = this.encryptedRecords.get(identityKey(alive[index].identity!));
        return previous ? [previous] : [];
      });
      if (this.disposed) return false;
      this.assertRegistryUnchanged();
      if (rows.length === 0 && opaque.length === 0) {
        fs.rmSync(this.filePath, { force: true });
        this.originalDigest = undefined;
      } else {
        const encoded = JSON.stringify({ format: REGISTRY_FORMAT, version: 1, sessions: [...rows, ...opaque] });
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(temporary, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, this.filePath);
        this.originalDigest = digest(encoded);
      }
      const retained = new Set([...rows, ...opaque].map(identityKey));
      for (const [id, key] of this.keys) if (!retained.has(id)) { key.fill(0); this.keys.delete(id); }
      for (const id of this.recordMetadata.keys()) if (!retained.has(id)) this.recordMetadata.delete(id);
      this.opaque = opaque;
      this.encryptedRecords = new Map([...rows, ...opaque].map(row => [identityKey(row), row]));
      if (incomplete) {
        this.reportError("Some R Console sessions could not be saved. Their previous encrypted records have been retained where available; other sessions were saved successfully.");
      } else this.reportedError = undefined;
      return !incomplete;
    } catch {
      this.reportError("R Console could not update its saved sessions. The existing saved data has been retained; no plaintext fallback was written.");
      return false;
    } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
  }
}

export function getPersistedRuntimePid(state: { ui?: { backendChildPid?: number }; runtime: { pid?: number } }): number | undefined {
  const runtimePid = state.runtime.pid;
  if (isPositiveInteger(runtimePid)) {
    return runtimePid;
  }

  const backendChildPid = state.ui?.backendChildPid;
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

