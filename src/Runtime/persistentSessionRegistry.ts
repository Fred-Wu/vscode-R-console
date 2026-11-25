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

export type LegacyConsoleRecord = Omit<PersistedConsoleRecord, "terminal"> & {
  terminal: Omit<PersistedRTerminalState, "runtime"> & {
    runtime: Omit<PersistedRTerminalState["runtime"], "authToken" | "protocolVersion"> & {
      protocolVersion?: number;
      authToken?: string;
    };
  };
};

export function isLegacyConsoleRecord(value: unknown): value is LegacyConsoleRecord {
  if (!isObjectRecord(value) || !isObjectRecord(value.terminal)) return false;
  const { options, runtime, ui } = value.terminal;
  if (!isObjectRecord(runtime)) return false;
  // Only v0.5.4 omitted both fields. Explicit versions drive all later upgrades.
  const version = !Object.hasOwn(runtime, "protocolVersion") && !Object.hasOwn(runtime, "authToken")
    ? 1 : runtime.protocolVersion;
  if (!isPositiveInteger(version) || version >= BACKEND_PROTOCOL_VERSION) return false;
  const credentialsValid = version === 1
    ? !Object.hasOwn(runtime, "authToken")
    : typeof runtime.authToken === "string" && /^[0-9a-f]{64}$/.test(runtime.authToken);
  return isPersistedRTerminalOptions(options) && isPersistedUiSnapshot(ui) &&
    isPersistedTerminalContext(value.location) &&
    (value.terminalName === undefined || typeof value.terminalName === "string") &&
    credentialsValid &&
    typeof runtime.sessionId === "string" && runtime.sessionId.trim().length > 0 &&
    isPositiveInteger(runtime.port) && runtime.port <= 65535 &&
    (runtime.pid === undefined || isPositiveInteger(runtime.pid));
}

/** Retain incompatible records without ever passing them to authenticated reconnect. */
export class PersistentSessionRegistry {
  private preserved: unknown[] = [];
  private sessions: PersistedConsoleRecord[] = [];
  private metadata: Record<string, unknown> = {};
  private readonly recordMetadata = new Map<string, Record<string, unknown>>();
  private writable = false;
  private opaque: EncryptedSession[] = [];
  private readonly keys = new Map<string, Buffer>();
  private readonly pendingKeys = new Map<string, Promise<Buffer>>();
  private readonly failedKeys = new Map<string, { error: unknown; retryAfter: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  private scheduledSave: { records: unknown[]; generation: number; result: Promise<boolean> } | undefined;
  private originalDigest: string | undefined;
  private migrationDigest: string | undefined;
  private generation = 0;
  private disposed = false;
  private reportedError: string | undefined;
  private readonly scope: string;

  constructor(readonly filePath: string, private readonly readKey: SessionRegistryKeyReader = readSessionRegistryKey,
    private readonly onError: (message: string) => void = () => {}) {
    this.scope = digest(path.resolve(filePath));
  }

  get legacySessions(): LegacyConsoleRecord[] {
    return this.preserved.filter(isLegacyConsoleRecord);
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
    this.preserved = [];
    this.sessions = [];
    this.opaque = [];
    this.migrationDigest = undefined;
    try {
      let original: string | undefined;
      try { original = await fs.promises.readFile(this.filePath, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      this.originalDigest = original === undefined ? undefined : digest(original);
      const parsed: unknown = original === undefined ? { format: REGISTRY_FORMAT, version: 1, sessions: [] } : JSON.parse(original);
      if (!isObjectRecord(parsed) || !Array.isArray(parsed.sessions)) throw new Error("Invalid registry schema");
      let records: unknown[];
      if (parsed.format === REGISTRY_FORMAT) {
        if (parsed.version !== 1) throw new Error("Unsupported registry format");
        const entries = parsed.sessions.map((entry: unknown) => {
          if (!isSessionRegistryIdentity(entry) || !isObjectRecord(entry)) throw new Error("Invalid registry identity");
          const row = entry as EncryptedSession;
          base64(row.iv, 12); base64(row.tag, 16); base64(row.ciphertext);
          return row;
        });
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
              this.recordMetadata.set(identityKey(row), value.metadata);
              return value;
            } finally { partial.fill(0); plaintext?.fill(0); }
          } catch {
            this.opaque.push(row);
            return;
          }
        }));
        records = decoded.filter(value => value !== undefined).map(value => value.record);
        this.metadata = decoded.find(value => value !== undefined)?.metadata ?? {};
        if (this.opaque.length) this.reportError("Some saved R Console sessions could not be decrypted. Their encrypted records have been retained for retry.");
      } else {
        if (Object.hasOwn(parsed, "format")) throw new Error("Unsupported registry format");
        records = parsed.sessions;
        const { sessions: _sessions, ...metadata } = parsed;
        this.metadata = metadata;
        this.migrationDigest = this.originalDigest;
      }
      let migrationReady = true;
      if (this.migrationDigest) {
        // Probe every live owner even if another legacy row is malformed. A
        // damaged row must not bypass the runtime's plaintext downgrade guard.
        const owners = records.map(identityOf).filter((identity): identity is SessionRegistryIdentity =>
          identity !== undefined && isProcessAlive(identity.pid));
        const results = await Promise.allSettled(owners.map(identity => this.keyFor(identity)));
        if (results.some(result => result.status === "rejected" && result.reason?.code === "PLAINTEXT_REJECTED")) {
          throw new Error("Plaintext registry replacement rejected");
        }
        migrationReady = results.every(result => result.status === "fulfilled");
        if (!migrationReady) this.reportError("Some R Console runtimes cannot encrypt their saved sessions. Start new R sessions to enable encrypted persistence. The existing file has been retained.");
      }
      if (this.disposed) return [];
      this.preserved = records.filter(entry => !isPersistedConsoleRecord(entry));
      this.sessions = records.filter(isPersistedConsoleRecord).filter(hasLivePersistedRuntime);
      this.writable = true;
      if (this.migrationDigest && migrationReady) await this.saveInternal([...this.sessions, ...this.preserved]);
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
    this.sessions = sessions.filter(hasLivePersistedRuntime);
    let records: unknown[];
    try { records = JSON.parse(JSON.stringify([...this.sessions, ...this.preserved])); }
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

  async forgetLegacySession(entry: LegacyConsoleRecord): Promise<boolean> {
    const previous = this.preserved;
    this.preserved = previous.filter((item) => !isLegacyConsoleRecord(item) ||
      item.terminal.runtime.sessionId !== entry.terminal.runtime.sessionId ||
      item.terminal.runtime.port !== entry.terminal.runtime.port ||
      getPersistedRuntimePid(item.terminal) !== getPersistedRuntimePid(entry.terminal));
    if (await this.save(this.sessions)) return true;
    this.preserved = previous;
    return false;
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
    const request = this.readKey(identity, this.migrationDigest).then(key => {
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
      const failure = encrypted.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      const rows = encrypted.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      if (this.disposed) return false;
      let current: string | undefined;
      try { current = fs.readFileSync(this.filePath, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if ((current === undefined ? undefined : digest(current)) !== this.originalDigest) throw new Error("Registry changed on disk");
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
      if (this.migrationDigest) {
        await Promise.all(alive.map(async ({ identity }) => { const key = await this.readKey(identity!); key.fill(0); }));
        this.migrationDigest = undefined;
      }
      const retained = new Set([...rows, ...opaque].map(identityKey));
      for (const [id, key] of this.keys) if (!retained.has(id)) { key.fill(0); this.keys.delete(id); }
      for (const id of this.recordMetadata.keys()) if (!retained.has(id)) this.recordMetadata.delete(id);
      this.opaque = opaque;
      this.reportedError = undefined;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "PLAINTEXT_REJECTED") {
        this.writable = false;
        this.sessions = [];
        this.preserved = [];
      }
      this.reportError("R Console could not update its saved sessions. The existing saved data has been retained. Older runtimes require a new R session for encrypted persistence; no plaintext fallback was written.");
      return false;
    } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
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

