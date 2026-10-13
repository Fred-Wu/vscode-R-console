import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

export type HistoryScope = "workspace" | "global";

export const historyPickerText = {
  title: "R Console: Command History",
  placeholder: "Type to filter command history",
  emptyMessage: "R Console command history is empty.",
} as const;

export function getHistoryPickerTogglePresentation(collapseDuplicates: boolean): {
  icon: "collapse-all" | "expand-all";
  tooltip: string;
} {
  return collapseDuplicates
    ? { icon: "expand-all", tooltip: "Expand duplicate commands" }
    : { icon: "collapse-all", tooltip: "Collapse duplicate commands" };
}

// The history picker lists newest commands first. Preserve each occurrence's
// original index so selecting an older duplicate navigates from that position.
export function getHistoryPickerEntries(
  entries: readonly string[],
  collapseDuplicates: boolean
): { code: string; historyIndex: number }[] {
  const items: { code: string; historyIndex: number }[] = [];
  const seen = new Set<string>();
  for (let historyIndex = entries.length - 1; historyIndex >= 0; historyIndex--) {
    const code = entries[historyIndex];
    if (collapseDuplicates && seen.has(code)) continue;
    seen.add(code);
    items.push({ code, historyIndex });
  }
  return items;
}

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

export class HistoryManager {
  private historyBuffer: string[] = [];
  private sessionEntries: string[] = [];
  private historyIndex = 0;
  private searchNoDuplicates = false;
  private readonly maxHistorySize = 20000;
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
  private pendingEntries: string[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 50;

  constructor(
    private readonly historyFile: string
  ) {}

  setSearchNoDuplicates(value: boolean): void {
    this.searchNoDuplicates = value;
  }

  private refreshFromDisk(force = false): void {
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
      this.withFileLock(() => this.readHistoryFromDisk(force), 25);
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
        this.historyIndex = 0;
        this.diskStamp = "missing";
        this.diskOffset = 0;
        this.lastEntryCount = 0;
        this.diskEntryBase = 0;
        this.diskFileId = undefined;
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
    const flush = () => {
      if (current.length) {
        const value = current.join("\n");
        if (value.trim()) entries.push(value);
        current = [];
      }
    };
    // Metadata lines mark a new record. We only publish a completed entry
    // once its next separator is visible.
    for (const line of lines) {
      if (line.startsWith("+")) current.push(line.slice(1));
      else if (line.startsWith("#") || !line.trim()) flush();
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
    const combined = reload ? entries : [...this.historyBuffer, ...entries];
    this.historyBuffer = combined.slice(-this.maxHistorySize);
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
    this.refreshFromDisk(true);
    this.sessionEntries = [];
    // Cap pre-existing history files when this console starts, not on extension activation.
    if (this.lastEntryCount > this.maxHistorySize) {
      try {
        this.withFileLock(() => {
          this.readHistoryFromDisk(true);
          if (this.lastEntryCount > this.maxHistorySize) {
            this.compactHistory(this.maxHistorySize);
          }
        });
      } catch {
        // Storage issues must not prevent the R console from starting.
      }
    }
  }

  save(): void {}

  // Coordinate compaction and appends across consoles and VS Code windows.
  // Lock files from an interrupted writer may be reclaimed after its process exits.
  private withFileLock<T>(action: () => T, maxAttempts = 100): T {
    fs.mkdirSync(path.dirname(this.historyFile), {
      recursive: true,
      mode: process.platform === "win32" ? undefined : 0o700,
    });
    const lockPath = this.historyFile + ".lock";
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let fd: number;
      try {
        fd = fs.openSync(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const owner = Number(fs.readFileSync(lockPath, "utf8").trim());
          const age = Date.now() - fs.statSync(lockPath).mtimeMs;
          let dead = false;
          if (Number.isSafeInteger(owner) && owner > 0 && owner !== process.pid) {
            try {
              process.kill(owner, 0);
            } catch (processError) {
              dead = (processError as NodeJS.ErrnoException).code === "ESRCH";
            }
          }
          if (dead || (age > 120000 && !Number.isSafeInteger(owner))) {
            fs.rmSync(lockPath, { force: true });
          }
        } catch {
          // Another window may have released the lock.
        }
        Atomics.wait(pause, 0, 0, 10);
        continue;
      }
      try {
        fs.writeSync(fd, String(process.pid));
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
    throw new Error("R Console history is busy.");
  }

  private compactHistory(keep: number): void {
    // Keep original timestamps and multiline records when the file uses the
    // regular console format; older irregular files can be reserialized.
    const raw = fs.readFileSync(this.historyFile, "utf8");
    const boundaries = [...raw.matchAll(/(?:^|\n)# time:[^\n]*\n(?=\+)/g)]
      .map((match) => match.index!);
    const entries = keep > 0 ? this.historyBuffer.slice(-keep) : [];
    const nextBase = this.diskEntryBase + (this.lastEntryCount - entries.length);
    const completeEnd = raw.lastIndexOf("\n") + 1;
    const records = entries.length > 0 && boundaries.length === this.lastEntryCount &&
      boundaries.length >= entries.length
      ? raw.slice(boundaries[boundaries.length - entries.length], completeEnd)
      : entries.map((entry) => this.serializeEntry(entry)).join("");
    const content = "# r-console-history-base: " + nextBase + "\n" + records;
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
    this.historyIndex = originalIndex === originalLength
      ? entries.length
      : Math.max(0, originalIndex - (originalLength - entries.length));
    this.lastEntryCount = entries.length;
    this.diskEntryBase = nextBase;
    const stat = fs.statSync(this.historyFile);
    this.diskStamp = stat.size + ":" + stat.mtimeMs;
    this.diskOffset = stat.size;
    this.diskFileId = stat.dev + ":" + stat.ino;
  }

  private serializeEntry(entry: string): string {
    const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
    return "\n# time: " + now + "\n" +
      entry.split("\n").map((line) => "+" + line + "\n").join("");
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
    const visibleIndex = this.historyIndex;
    try {
      this.withFileLock(() => {
        // The in-memory tail also contains pending submissions. Temporarily
        // remove it so incremental disk reconciliation cannot duplicate them.
        // The catch block restores the original view if persistence fails.
        const diskLength = Math.max(0, this.historyBuffer.length - this.pendingEntries.length);
        const needsReload = this.pendingEntries.length >= this.historyBuffer.length &&
          this.lastEntryCount > 0;
        this.historyBuffer = this.historyBuffer.slice(0, diskLength);
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
        const queued = this.pendingEntries.slice(-this.maxHistorySize);
        if (this.lastEntryCount + queued.length > this.maxHistorySize) {
          const keep = Math.max(0, Math.min(
            this.compactToSize, this.maxHistorySize - queued.length
          ));
          this.compactHistory(keep);
        }
        fs.appendFileSync(
          this.historyFile,
          queued.map((entry) => this.serializeEntry(entry)).join(""),
          // mode applies on creation only; do not change existing file permissions.
          process.platform === "win32" ? undefined : { mode: 0o600 }
        );
        // No retry if subsequent metadata access fails after the append.
        this.pendingEntries = [];
        this.historyBuffer.push(...queued);
        this.historyBuffer = this.historyBuffer.slice(-this.maxHistorySize);
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
        this.historyBuffer = visibleHistory;
        this.historyIndex = visibleIndex;
      }
      // Keep submissions locally and retry without blocking the R session.
      // This also covers contention from a different VS Code window.
      this.scheduleRetry();
    }
  }

  push(entry: string): void {
    if (!entry.trim()) return;
    this.pendingEntries.push(entry);
    this.historyBuffer.push(entry);
    this.historyBuffer = this.historyBuffer.slice(-this.maxHistorySize);
    this.sessionEntries.push(entry);
    this.sessionEntries = this.sessionEntries.slice(-this.maxHistorySize);
    this.historyIndex = this.historyBuffer.length;
    this.flushPending();
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

  selectEntryAt(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.historyBuffer.length) {
      return;
    }
    // The picker holds a snapshot of this buffer. Set the original position
    // before refreshing, so a concurrent compaction remaps the same occurrence.
    this.historyIndex = index;
    this.refreshFromDisk();
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

    const length = this.historyBuffer.length;
    let nextIndex = this.historyIndex + direction;
    if (this.searchNoDuplicates && direction !== 0 && this.historyIndex < length) {
      const current = this.historyBuffer[this.historyIndex];
      // Skip commands identical to the currently displayed entry in either
      // direction. Comparing with the destination incorrectly visits the same
      // run again when navigating forward.
      while (nextIndex >= 0 && nextIndex < length &&
        this.historyBuffer[nextIndex] === current) {
        nextIndex += direction;
      }
    }
    if (nextIndex < 0 || nextIndex > length) return undefined;
    this.historyIndex = nextIndex;
    return nextIndex === length ? null : this.historyBuffer[nextIndex];
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
