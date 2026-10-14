import { createHash, randomUUID } from "crypto";
import { workerData } from "worker_threads";
import * as fs from "fs";
import * as path from "path";
import { HistoryBuffer } from "./historyBuffer";
import type { HistoryScope } from "./history";

export function getHistoryFile(storageFolder: string, scope: HistoryScope, workspaceFolder?: string): string {
  if (scope === "global" || !workspaceFolder) {
    return path.join(storageFolder, "history", "global.history");
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
  return path.join(storageFolder, "history", "workspace-" + id + ".history");
}

export type HistoryWrite = { id: string; code: string; createdAt?: number };
export type HistoryDeletion = { before: number; ids?: string[]; codeHashes?: string[]; all?: boolean };
function hashHistoryCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// Legacy history records lack an ID. Their absolute file ordinal survives
// front compaction, so use it to derive a stable ID for each occurrence.
function legacyHistoryId(ordinal: number): string {
  const hash = createHash("sha256").update("r-console-legacy:" + ordinal).digest("hex");
  return [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16),
    hash.slice(16, 20), hash.slice(20, 32)].join("-");
}

export class HistoryStore extends HistoryBuffer {
  // Reclaim headroom in batches instead of rewriting 20,000 commands on every submit.
  private readonly compactToSize = 19000;
  private diskStamp: string | undefined;
  private lastEntryCount = 0;
  // Number of entries pruned from the front of this history file. A stable
  // ordinal preserves cursor position across another console's compaction,
  // including when identical commands occur at several positions.
  private diskEntryBase = 0;
  private diskOffset = 0;
  private diskFileId: string | undefined;
  private pendingEntries: HistoryWrite[] = [];
  private historyIds: string[] = [];
  private savedIds = new Set<string>();
  private deletedIds = new Set<string>();
  private deletions: HistoryDeletion[] = [];
  private needsRecovery = false;
  private readonly lockOwner = process.pid + ":" +
    (workerData?.historyOwner || randomUUID());
  private readonly orphanOwners = new Set<string>(workerData?.orphanOwners ?? []);
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 50;

  constructor(
    private readonly historyFile: string
  ) { super(); }

  protected override refreshFromDisk(force = false): void {
    if (this.pendingEntries.length) {
      this.flushPending();
      if (this.pendingEntries.length) return;
    }
    // No file lock or disk read is needed when nothing has changed.
    if (!force) {
      try {
        const stat = fs.statSync(this.historyFile);
        const stamp = stat.size + ":" + stat.mtimeMs;
        if (stamp === this.diskStamp &&
          stat.dev + ":" + stat.ino === this.diskFileId) return;
      } catch {
        // A missing/replaced file is handled under the lock below.
      }
    }
    try {
      // A contended read retains its last complete snapshot until the next
      // history operation, instead of inspecting an in-progress append.
      this.withFileLock(() => this.readHistoryFromDisk(force));
    } catch {
      // History storage is optional and must never block starting R.
    }
  }

  private readHistoryFromDisk(force = false): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.historyFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (force || this.diskStamp !== "missing") {
        this.historyBuffer = [];
        this.historyIds = [];
        this.historyIndex = 0;
        this.diskStamp = "missing";
        this.diskOffset = 0;
        this.lastEntryCount = 0;
        this.diskEntryBase = 0;
        this.diskFileId = undefined;
        this.savedIds.clear();
        this.deletedIds.clear();
        this.deletions = [];
      }
      return;
    }
    const stamp = stat.size + ":" + stat.mtimeMs;
    const fileId = stat.dev + ":" + stat.ino;
    if (!force && stamp === this.diskStamp && fileId === this.diskFileId) return;
    // Only parse newly appended lines. New records always start with a
    // blank separator, so a trailing incomplete command is never committed.
    const reload = force || stat.size < this.diskOffset || this.diskStamp === "missing" ||
      (stat.size === this.diskOffset && this.diskStamp !== stamp) ||
      (this.diskFileId !== undefined && fileId !== this.diskFileId);
    const offset = reload ? 0 : this.diskOffset;
    const fd = fs.openSync(this.historyFile, "r");
    let content: string;
    try {
      const bytes = Buffer.alloc(stat.size - offset);
      let position = 0;
      while (position < bytes.length) {
        const count = fs.readSync(fd, bytes, position, bytes.length - position, offset + position);
        if (!count) break;
        position += count;
      }
      content = bytes.subarray(0, position).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    // Preserve an incomplete last line until a subsequent refresh. If the
    // writer terminated unexpectedly, a later append starts a new record.
    const lastNewline = content.lastIndexOf("\n");
    if (lastNewline < 0) return;
    const complete = content.slice(0, lastNewline + 1);
    const lines = complete.split(/\r?\n/);
    let current: string[] = [];
    const entries: string[] = [];
    const parsedIds: (string | undefined)[] = [];
    let currentId: string | undefined;
    const flush = () => {
      if (current.length) {
        const value = current.join("\n");
        if (value.trim()) {
          entries.push(value);
          parsedIds.push(currentId);
        }
        current = [];
      }
    };
    // The original history format already has # time metadata. Newer
    // records also carry history-id; retain it rather than collapsing every
    // occurrence of the same command into an indistinguishable string.
    for (const line of lines) {
      if (line.startsWith("+")) {
        current.push(line.slice(1));
      } else if (line.startsWith("#") || !line.trim()) {
        flush();
        currentId = line.startsWith("# time:")
          ? /history-id: ([0-9a-f-]{36})/.exec(line)?.[1] : undefined;
      }
    }
    flush();
    const oldLength = this.historyBuffer.length;
    const oldIndex = this.historyIndex;
    const previousCount = reload ? 0 : this.lastEntryCount;
    const oldStart = this.diskEntryBase +
      Math.max(0, this.lastEntryCount - oldLength);
    // The marker is written only during compaction, so existing plaintext
    // histories without it naturally start at ordinal zero.
    const baseMatch = reload
      ? /^# r-console-history-base: (\d+)\r?\n/.exec(content)
      : null;
    const parsedBase = baseMatch ? Number(baseMatch[1]) : 0;
    if (reload) {
      this.diskEntryBase = Number.isSafeInteger(parsedBase) ? parsedBase : 0;
    }
    if (reload) {
      this.savedIds.clear();
      this.deletions = [...complete.matchAll(/^# r-console-deletion: (.+)\r?$/gm)]
        .flatMap((match) => {
          try {
            const value = JSON.parse(match[1]) as HistoryDeletion & { codes?: string[] };
            if (Array.isArray(value.codes)) {
              value.codeHashes = [...(value.codeHashes ?? []), ...value.codes.map(hashHistoryCode)];
              delete value.codes;
            }
            return typeof value.before === "number" && Number.isFinite(value.before) ? [value] : [];
          } catch { return []; }
        });
    }
    for (const match of complete.matchAll(/^# history-complete: ([0-9a-f-]{36})\r?$/gm)) {
      this.savedIds.add(match[1]);
    }
    const newIds = parsedIds.map((id, index) =>
      id ?? legacyHistoryId(this.diskEntryBase + previousCount + index));
    const combined = reload ? entries : [...this.historyBuffer, ...entries];
    const combinedIds = reload ? newIds : [...this.historyIds, ...newIds];
    this.historyBuffer = combined.slice(-this.maxHistorySize);
    this.historyIds = combinedIds.slice(-this.maxHistorySize);
    this.lastEntryCount = previousCount + entries.length;
    const newStart = this.diskEntryBase +
      Math.max(0, this.lastEntryCount - this.historyBuffer.length);
    // Keep the same logical entry if it survived; otherwise clamp to the
    // earliest retained entry. End-of-history remains at the new end.
    this.historyIndex = oldIndex === oldLength
      ? this.historyBuffer.length
      : Math.max(0, Math.min(this.historyBuffer.length, oldStart + oldIndex - newStart));
    this.diskOffset = offset + Buffer.byteLength(complete);
    this.diskStamp = stamp;
    this.diskFileId = fileId;
  }

  load(): void {
    try {
      this.withFileLock(() => {
        this.recoverInterruptedRecords();
        this.readHistoryFromDisk(true);
        if (this.lastEntryCount > this.maxHistorySize) {
          this.compactHistory(this.maxHistorySize);
        }
      });
    } catch {
      // Storage issues must not prevent the R console from starting.
    }
    this.sessionEntries = [];
  }

  save(): void {
    // Retry queued submissions without rewriting commands already saved.
    this.flushPending();
  }

  // Coordinate compaction and appends across consoles and VS Code windows.
  // Lock files from an interrupted writer may be reclaimed after its process exits.
  private withFileLock<T>(action: () => T): T {
    fs.mkdirSync(path.dirname(this.historyFile), {
      recursive: true,
      mode: process.platform === "win32" ? undefined : 0o700,
    });
    const lockPath = this.historyFile + ".lock";
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let reclaimed = false;
      try {
        const ownerText = fs.readFileSync(lockPath, "utf8").trim();
        const ownerPid = /^(\d+)(?::[0-9a-f-]+)?$/.exec(ownerText);
        const owner = ownerPid ? Number(ownerPid[1]) : NaN;
        const validOwner = Number.isSafeInteger(owner) && owner > 0;
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        let dead = false;
        if (validOwner && owner !== process.pid) {
          try {
            process.kill(owner, 0);
          } catch (processError) {
            dead = (processError as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
        if (this.orphanOwners.has(ownerText) || dead ||
          (age > 120000 && !validOwner)) {
          fs.rmSync(lockPath, { force: true });
          reclaimed = true;
        }
      } catch {
        // Another window may have released the lock.
      }
      if (!reclaimed) throw new Error("R Console history is busy.");
      // A competing writer may acquire the reclaimed lock first. Let the caller retry.
      fd = fs.openSync(lockPath, "wx", 0o600);
    }
    try {
      fs.writeSync(fd, this.lockOwner);
      return action();
    } finally {
      fs.closeSync(fd);
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // Avoid replaying a completed append because cleanup failed.
      }
    }
  }

  private deletionHeader(next?: HistoryDeletion): string {
    // A later matching rule with an equal or newer cutoff subsumes an
    // earlier rule. Never discard a rule merely because it is old: another
    // VS Code window may still replay an unacknowledged write.
    const rules = next ? [...this.deletions, next] : this.deletions;
    const retained: HistoryDeletion[] = [];
    for (let index = rules.length - 1; index >= 0; index--) {
      const rule = rules[index];
      const covered = retained.some((later) =>
        later.before >= rule.before && (
          later.all ||
          (!rule.all && !later.all &&
            (rule.ids ?? []).every((id) => later.ids?.includes(id)) &&
            (rule.codeHashes ?? []).every((hash) => later.codeHashes?.includes(hash)))
        ));
      if (!covered) retained.unshift(rule);
    }
    return retained.map((value) => "# r-console-deletion: " + JSON.stringify(value) + "\n").join("");
  }

  private isDeleted(entry: HistoryWrite): boolean {
    return this.deletions.some((deletion) => (entry.createdAt ?? 0) <= deletion.before &&
      (deletion.all || deletion.ids?.includes(entry.id) ||
        deletion.codeHashes?.includes(hashHistoryCode(entry.code))));
  }

  private compactHistory(keep: number): void {
    // Keep original timestamps and multiline records when the file uses the
    // regular console format; older irregular files can be reserialized.
    const raw = fs.readFileSync(this.historyFile, "utf8");
    const boundaries = [...raw.matchAll(/(?:^|\n)# time:[^\n]*\n(?=\+)/g)]
      .map((match) => match.index!);
    const entries = keep > 0 ? this.historyBuffer.slice(-keep) : [];
    const ids = keep > 0 ? this.historyIds.slice(-keep) : [];
    const nextBase = this.diskEntryBase + (this.lastEntryCount - entries.length);
    const completeEnd = raw.lastIndexOf("\n") + 1;
    const records = entries.length > 0 && boundaries.length === this.lastEntryCount &&
      boundaries.length >= entries.length
      ? raw.slice(boundaries[boundaries.length - entries.length], completeEnd)
      : entries.map((code, index) => this.serializeEntry({ id: ids[index], code })).join("");
    const content = "# r-console-history-base: " + nextBase + "\n" +
      this.deletionHeader() + records;
    const temporary = this.historyFile + "." + process.pid + "." +
      Math.random().toString(16).slice(2) + ".tmp";
    try {
      fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.historyFile);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    const originalLength = this.historyBuffer.length;
    const originalIndex = this.historyIndex;
    this.historyBuffer = entries;
    this.historyIds = ids;
    this.historyIndex = originalIndex === originalLength
      ? entries.length
      : Math.max(0, originalIndex - (originalLength - entries.length));
    this.lastEntryCount = entries.length;
    this.diskEntryBase = nextBase;
    const stat = fs.statSync(this.historyFile);
    this.diskStamp = stat.size + ":" + stat.mtimeMs;
    this.diskOffset = stat.size;
    this.diskFileId = stat.dev + ":" + stat.ino;
    this.savedIds = new Set(
      [...content.matchAll(/^# history-complete: ([0-9a-f-]{36})\r?$/gm)].map((match) => match[1])
    );
  }

  private serializeEntry(entry: HistoryWrite): string {
    const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
    return "\n# time: " + now + " history-id: " + entry.id +
      " submitted-at: " + (entry.createdAt ?? 0) + "\n" +
      entry.code.split("\n").map((line) => "+" + line + "\n").join("") +
      "# history-complete: " + entry.id + "\n";
  }

  private recoverInterruptedRecords(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.historyFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const boundaries = [...raw.matchAll(/(?:^|\n)# time:[^\n]*\n/g)];
    let rebuilt = "";
    let offset = 0;
    let changed = false;
    for (let i = 0; i < boundaries.length; i++) {
      const begin = boundaries[i].index!;
      const end = i + 1 < boundaries.length ? boundaries[i + 1].index! : raw.length;
      const record = raw.slice(begin, end);
      const tag = /history-id: ([0-9a-f-]{36})\r?\n/.exec(record);
      if (tag && !record.includes("# history-complete: " + tag[1] + "\n")) {
        rebuilt += raw.slice(offset, begin);
        offset = end;
        changed = true;
      }
    }
    if (!changed) {
      this.needsRecovery = false;
      return;
    }
    rebuilt += raw.slice(offset);
    const stat = fs.statSync(this.historyFile);
    const temporary = this.historyFile + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temporary, rebuilt, {
        encoding: "utf8", flag: "wx", mode: stat.mode & 0o777,
      });
      fs.renameSync(temporary, this.historyFile);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    this.needsRecovery = false;
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== undefined) return;
    const retry = () => {
      this.retryTimer = undefined;
      this.flushPending();
    };
    this.retryTimer = setTimeout(retry, this.retryDelay);
    this.retryTimer.unref();
    this.retryDelay = Math.min(this.retryDelay * 2, 5000);
  }

  private flushPending(): void {
    if (!this.pendingEntries.length) return;
    // Reconciliation replaces the in-memory buffer with the disk snapshot.
    // Preserve the visible entries and cursor if the append subsequently fails.
    const visibleHistory = this.historyBuffer;
    const visibleIds = this.historyIds;
    const visibleIndex = this.historyIndex;
    // A failed append restores this buffer; the disk cursor and entry count
    // must be restored with it or subsequent incremental reads skip entries
    // another console appended during the failed attempt.
    const diskState = {
      stamp: this.diskStamp,
      offset: this.diskOffset,
      fileId: this.diskFileId,
      entryCount: this.lastEntryCount,
      entryBase: this.diskEntryBase,
    };
    let compactedHistory: string[] | undefined;
    let compactedIds: string[] | undefined;
    let compactedIndex = 0;
    try {
      this.withFileLock(() => {
        // Resolve an earlier failed rollback before reading or appending anything.
        if (this.needsRecovery) this.recoverInterruptedRecords();
        // The in-memory tail also contains pending submissions. Temporarily
        // remove it so incremental disk reconciliation cannot duplicate them.
        // The catch block restores the original view if persistence fails.
        const diskLength = Math.max(0, this.historyBuffer.length - this.pendingEntries.length);
        const needsReload = this.pendingEntries.length >= this.historyBuffer.length &&
          this.lastEntryCount > 0;
        this.historyBuffer = this.historyBuffer.slice(0, diskLength);
        this.historyIds = this.historyIds.slice(0, diskLength);
        this.historyIndex = Math.min(this.historyIndex, diskLength);
        // Reconcile only new bytes under the lock. Reload from the beginning
        // on replacement/compaction or when the pending tail filled the buffer.
        this.readHistoryFromDisk(needsReload);
        const stat = fs.existsSync(this.historyFile)
          ? fs.statSync(this.historyFile) : undefined;
        if (stat && stat.size > this.diskOffset) {
          fs.truncateSync(this.historyFile, this.diskOffset);
          this.readHistoryFromDisk(false);
        }
        const blocked = this.pendingEntries.filter((entry) => this.isDeleted(entry));
        for (const entry of blocked) this.deletedIds.add(entry.id);
        const queued = this.pendingEntries.filter((entry) =>
          !this.savedIds.has(entry.id) && !this.isDeleted(entry)).slice(-this.maxHistorySize);
        if (!queued.length) {
          this.pendingEntries = [];
          return;
        }
        if (this.lastEntryCount + queued.length > this.maxHistorySize) {
          const keep = Math.max(0, Math.min(
            this.compactToSize, this.maxHistorySize - queued.length
          ));
          this.compactHistory(keep);
          // Compaction commits a new disk snapshot before the append. If the
          // append fails, restore pending commands onto this snapshot rather
          // than reviving the commands already pruned from disk.
          compactedHistory = this.historyBuffer;
          compactedIds = this.historyIds;
          compactedIndex = this.historyIndex;
        }
        const batch = queued.map((entry) => this.serializeEntry(entry)).join("");
        // Remember the exact pre-append boundary *after* any compaction.
        // A failed append may have written one or more complete records.
        const beforeAppend = fs.existsSync(this.historyFile)
          ? fs.statSync(this.historyFile) : undefined;
        try {
          fs.appendFileSync(
            this.historyFile,
            batch,
            // mode applies on creation only; do not change existing file permissions.
            process.platform === "win32" ? undefined : { mode: 0o600 }
          );
        } catch (error) {
          try {
            const current = fs.statSync(this.historyFile);
            if (beforeAppend && (current.dev !== beforeAppend.dev ||
              current.ino !== beforeAppend.ino)) {
              throw new Error("History file was replaced during a failed append.");
            }
            // Undo only bytes written by this attempt. A no-op truncate
            // changes mtime and needlessly forces a full history reload.
            if (current.size < (beforeAppend?.size ?? 0)) {
              throw new Error("History file shrank during a failed append.");
            }
            if (current.size > (beforeAppend?.size ?? 0)) {
              fs.truncateSync(this.historyFile, beforeAppend?.size ?? 0);
            }
          } catch (rollbackError) {
            // A nonexistent file cannot contain a partial append. Otherwise,
            // retain enough information to verify a safe rollback on retry.
            if ((rollbackError as NodeJS.ErrnoException).code !== "ENOENT") {
              const current = fs.statSync(this.historyFile);
              this.needsRecovery = true;
            }
          }
          throw error;
        }
        // No retry if subsequent metadata access fails after the append.
        this.pendingEntries = [];
        for (const entry of queued) this.savedIds.add(entry.id);
        this.historyBuffer.push(...queued.map((entry) => entry.code));
        this.historyIds.push(...queued.map((entry) => entry.id));
        this.historyBuffer = this.historyBuffer.slice(-this.maxHistorySize);
        this.historyIds = this.historyIds.slice(-this.maxHistorySize);
        this.historyIndex = this.historyBuffer.length;
        this.lastEntryCount += queued.length;
        this.diskStamp = undefined;
        const updated = fs.statSync(this.historyFile);
        this.diskStamp = updated.size + ":" + updated.mtimeMs;
        this.diskOffset = updated.size;
        this.diskFileId = updated.dev + ":" + updated.ino;
      });
      this.retryDelay = 50;
      if (this.retryTimer !== undefined) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
    } catch {
      if (this.pendingEntries.length) {
        if (compactedHistory) {
          const combined = [...compactedHistory, ...this.pendingEntries.map((entry) => entry.code)];
          const removed = Math.max(0, combined.length - this.maxHistorySize);
          this.historyBuffer = combined.slice(removed);
          this.historyIds = [...compactedIds!, ...this.pendingEntries.map((entry) => entry.id)].slice(removed);
          this.historyIndex = compactedIndex === compactedHistory.length
            ? this.historyBuffer.length
            : Math.max(0, compactedIndex - removed);
        } else {
          this.historyBuffer = visibleHistory;
          this.historyIds = visibleIds;
          this.historyIndex = visibleIndex;
          this.diskStamp = diskState.stamp;
          this.diskOffset = diskState.offset;
          this.diskFileId = diskState.fileId;
          this.lastEntryCount = diskState.entryCount;
          this.diskEntryBase = diskState.entryBase;
        }
      }
      // Keep submissions locally and retry without blocking the R session.
      // This also covers contention from a different VS Code window.
      this.scheduleRetry();
    }
  }

  override push(entry: string): void {
    this.pushEntries([{ id: randomUUID(), code: entry, createdAt: performance.timeOrigin + performance.now() }]);
  }

  pushEntries(entries: readonly HistoryWrite[]): void {
    for (const entry of entries) {
      if (!entry.code.trim() || this.savedIds.has(entry.id) ||
        this.pendingEntries.some((pending) => pending.id === entry.id)) continue;
      const submitted = { ...entry,
        createdAt: entry.createdAt ?? performance.timeOrigin + performance.now() };
      this.pendingEntries.push(submitted);
      super.push(submitted.code);
      this.historyIds.push(submitted.id);
      if (this.historyIds.length > this.maxHistorySize) this.historyIds.shift();
    }
    this.flushPending();
  }

  getSnapshot(): { entries: string[]; ids: string[]; start: number } {
    const entries = this.getEntries();
    return {
      entries,
      ids: [...this.historyIds],
      start: this.diskEntryBase + Math.max(0,
        this.lastEntryCount + this.pendingEntries.length - entries.length),
    };
  }

  // Delete under the same cross-process lock used for appends and compaction.
  // Retained legacy records acquire explicit IDs so removing a middle record
  // never changes the identity of the occurrences after it.
  deleteEntries(selection: { ids?: readonly string[]; codes?: readonly string[];
    all?: boolean; before?: number }): string[] {
    const deletion: HistoryDeletion = {
      before: selection.before ?? performance.timeOrigin + performance.now(),
      ...(selection.all ? { all: true } : {}),
      ...(selection.ids?.length ? { ids: [...selection.ids] } : {}),
      ...(selection.codes?.length ? { codeHashes: selection.codes.map(hashHistoryCode) } : {}),
    };
    const ids = new Set(deletion.ids ?? []);
    const hashes = new Set(deletion.codeHashes ?? []);
    const matches = (entry: HistoryWrite, createdAt = 0): boolean =>
      createdAt <= deletion.before &&
      (!!deletion.all || ids.has(entry.id) || hashes.has(hashHistoryCode(entry.code)));

    // Never remove queued writes before the operation commits. If append is
    // blocked, deletion fails and the pending commands remain available.
    if (this.pendingEntries.length) this.flushPending();
    if (this.pendingEntries.length) {
      throw new Error("History writes are pending; deletion was not applied.");
    }
    return this.withFileLock(() => {
      if (this.needsRecovery) this.recoverInterruptedRecords();
      this.readHistoryFromDisk(true);
      const existing = this.historyIds.map((id, index) => ({
        id, code: this.historyBuffer[index],
      }));
      const raw = fs.existsSync(this.historyFile) ? fs.readFileSync(this.historyFile, "utf8") : "";
      const boundaries = [...raw.matchAll(/(?:^|\n)# time:[^\n]*\n(?=\+)/g)]
        .map((match) => match.index!);
      const end = raw.lastIndexOf("\n") + 1;
      const preserve = boundaries.length === existing.length;
      const oldRecords = existing.map((entry, index) =>
        preserve ? raw.slice(boundaries[index], index + 1 < boundaries.length ? boundaries[index + 1] : end) : "");
      const removed = existing.filter((entry, index) => {
        const timestamp = /^# time:[^\n]*submitted-at: ([0-9.]+)/m.exec(oldRecords[index]);
        return matches(entry, timestamp ? Number(timestamp[1]) : 0);
      }).map((entry) => entry.id);
      const removedIds = new Set(removed);
      const records: string[] = [];
      for (let index = 0; index < existing.length; index++) {
        const entry = existing[index];
        if (removedIds.has(entry.id)) continue;
        if (!preserve) {
          records.push(this.serializeEntry(entry));
          continue;
        }
        let record = oldRecords[index];
        record = record.replace(/(# time:[^\n]*)(\r?\n)/, (_line, header: string, newline: string) =>
          (header.includes("history-id: ") ? header : header + " history-id: " + entry.id) + newline);
        if (!record.includes("# history-complete: " + entry.id + "\n")) {
          record = record.replace(/\s*$/, "") + "\n# history-complete: " + entry.id + "\n";
        }
        records.push(record);
      }
      const content = "# r-console-history-base: " + this.diskEntryBase + "\n" +
        this.deletionHeader(deletion) +
        records.join("");
      const temporary = this.historyFile + "." + process.pid + "." + randomUUID() + ".tmp";
      try {
        fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, this.historyFile);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      this.readHistoryFromDisk(true);
      return removed;
    });
  }

  getDeletionRules(): readonly HistoryDeletion[] {
    this.refreshFromDisk();
    return this.deletions;
  }

  getPersistedIds(ids: readonly string[]): string[] {
    return ids.filter((id) => this.savedIds.has(id) || this.deletedIds.has(id));
  }

  get hasPendingWrites(): boolean {
    return this.pendingEntries.length > 0;
  }

  dispose(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
  }
}
