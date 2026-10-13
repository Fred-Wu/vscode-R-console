import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { EncryptedStorage, StorageEncryptionError } from "../Runtime/encryptedStorage";

export type HistoryScope = "workspace" | "global";

export function getHistoryFile(storageFolder: string, scope: HistoryScope, workspaceFolder?: string): string {
  if (scope === "global" || !workspaceFolder) {
    return path.join(storageFolder, "history", "global.enc");
  }
  let canonical = path.resolve(workspaceFolder);
  try {
    canonical = fs.realpathSync.native(canonical);
  } catch {
    // A workspace may be temporarily unavailable while restoring a session.
  }
  if (process.platform === "win32") {
    canonical = canonical.toLowerCase();
  }
  const id = createHash("sha256").update(canonical).digest("hex");
  return path.join(storageFolder, "history", "workspace-" + id + ".enc");
}

export class HistoryManager {
  private historyBuffer: string[] = [];
  private sessionEntries: string[] = [];
  private historyIndex = 0;
  private searchNoDuplicates = false;
  private readonly maxHistorySize = 10000;
  private diskStamp: string | undefined;

  constructor(
    private readonly historyFile: string,
    private readonly encryption: EncryptedStorage
  ) {}

  setSearchNoDuplicates(value: boolean): void {
    this.searchNoDuplicates = value;
  }

  private refreshFromDisk(force = false): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.historyFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      if (force || this.diskStamp !== "missing") {
        this.historyBuffer = [];
        this.historyIndex = 0;
        this.diskStamp = "missing";
      }
      return;
    }

    const stamp = stat.size + ":" + stat.mtimeMs;
    if (!force && stamp === this.diskStamp) {
      return;
    }
    const content = fs.readFileSync(this.historyFile, "utf8");
    if (content.length > 0 && !content.endsWith("\n")) {
      throw new StorageEncryptionError(
        "R Console encrypted history has an incomplete final record. The file has been preserved."
      );
    }
    const records = content.split("\n");
    records.pop();
    const entries = records.filter((record) => record.length > 0)
      .map((record) => this.encryption.decrypt(
        record, "history:" + path.basename(this.historyFile)
      ));
    const oldLength = this.historyBuffer.length;
    const oldIndex = this.historyIndex;
    this.historyBuffer = entries.slice(-this.maxHistorySize);
    this.historyIndex = oldIndex === oldLength
      ? this.historyBuffer.length
      : Math.min(this.historyBuffer.length, oldIndex);
    this.diskStamp = stamp;
  }

  load(): void {
    this.refreshFromDisk(true);
    this.sessionEntries = [];
  }

  // Each command is committed immediately. Never overwrite shared history on shutdown.
  save(): void {}

  push(entry: string): void {
    if (!entry.trim()) return;
    this.refreshFromDisk();
    fs.mkdirSync(path.dirname(this.historyFile), { recursive: true, mode: 0o700 });
    const ciphertext = this.encryption.encrypt(
      entry, "history:" + path.basename(this.historyFile)
    );
    fs.appendFileSync(this.historyFile, ciphertext + "\n", { mode: 0o600 });
    this.historyBuffer.push(entry);
    this.historyBuffer = this.historyBuffer.slice(-this.maxHistorySize);
    this.sessionEntries.push(entry);
    this.historyIndex = this.historyBuffer.length;
    const stat = fs.statSync(this.historyFile);
    this.diskStamp = stat.size + ":" + stat.mtimeMs;
  }

  getEntries(): string[] {
    this.refreshFromDisk();
    return [...this.historyBuffer];
  }

  selectEntry(entry: string): void {
    this.refreshFromDisk();
    const index = this.historyBuffer.lastIndexOf(entry);
    if (index >= 0) {
      this.historyIndex = index;
    }
  }

  getRecentSessionEntries(limit = 200): string[] {
    return limit > 0 ? this.sessionEntries.slice(-limit) : [];
  }

  resetIndex(): void {
    this.refreshFromDisk();
    this.historyIndex = this.historyBuffer.length;
  }

  navigate(direction: number): string | null | undefined {
    this.refreshFromDisk();
    if (this.historyBuffer.length === 0) return undefined;

    const newIndex = this.historyIndex + direction;
    if (newIndex < 0 || newIndex > this.historyBuffer.length) return undefined;
    this.historyIndex = newIndex;
    if (newIndex === this.historyBuffer.length) {
      return null;
    }
    if (!this.searchNoDuplicates) {
      return this.historyBuffer[newIndex];
    }
    const current = this.historyBuffer[newIndex];
    let idx = newIndex;
    if (direction < 0) {
      while (idx > 0 && this.historyBuffer[idx - 1] === current) idx -= 1;
    } else {
      while (idx < this.historyBuffer.length - 1 && this.historyBuffer[idx + 1] === current) idx += 1;
    }
    this.historyIndex = idx;
    return this.historyBuffer[idx];
  }

  searchBackward(term: string, fromIndex?: number): string | null {
    this.refreshFromDisk();
    if (!term) return null;
    const start = fromIndex === undefined ? this.historyIndex - 1 : fromIndex;
    for (let i = start; i >= 0; i--) {
      if (this.historyBuffer[i].includes(term)) {
        this.historyIndex = i;
        return this.historyBuffer[i];
      }
    }
    return null;
  }
}
