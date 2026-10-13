import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

export type HistoryScope = "workspace" | "global";

// The history picker lists newest commands first. Collapsing is an optional
// view-only projection: exact command text is the key and the latest wins.
export function getHistoryPickerEntries(
  entries: readonly string[],
  collapseDuplicates: boolean
): string[] {
  const newestFirst = [...entries].reverse();
  if (!collapseDuplicates) {
    return newestFirst;
  }
  const seen = new Set<string>();
  return newestFirst.filter((entry) => {
    if (seen.has(entry)) {
      return false;
    }
    seen.add(entry);
    return true;
  });
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
  private diskOffset = 0;
  private diskFileId: string | undefined;

  constructor(
    private readonly historyFile: string
  ) {}

  setSearchNoDuplicates(value: boolean): void {
    this.searchNoDuplicates = value;
  }

  private refreshFromDisk(force = false): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.historyFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      if (force || this.diskStamp !== "missing") {
        this.historyBuffer = [];
        this.historyIndex = 0;
        this.diskStamp = "missing";
        this.diskOffset = 0;
        this.lastEntryCount = 0;
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
    let fd: number;
    try {
      fd = fs.openSync(this.historyFile, "r");
    } catch {
      // A history read failure must not stop the R console from opening.
      return;
    }
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
    } catch {
      // Leave the cached history intact if the shared file is inaccessible.
      return;
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
    const oldTotal = this.lastEntryCount;
    const oldStart = Math.max(0, oldTotal - oldLength);
    const combined = reload ? entries : [...this.historyBuffer, ...entries];
    this.historyBuffer = combined.slice(-this.maxHistorySize);
    this.lastEntryCount = previousCount + entries.length;
    const newStart = Math.max(0, this.lastEntryCount - this.historyBuffer.length);
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
          this.refreshFromDisk(true);
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
  private withFileLock<T>(action: () => T): T {
    fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
    const lockPath = this.historyFile + ".lock";
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 100; attempt++) {
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
          if (dead || age > 120000) {
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
        fs.rmSync(lockPath, { force: true });
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
    const entries = this.historyBuffer.slice(-keep);
    const completeEnd = raw.lastIndexOf("\n") + 1;
    const content = boundaries.length === this.lastEntryCount &&
      boundaries.length >= entries.length
      ? raw.slice(boundaries[boundaries.length - entries.length], completeEnd)
      : entries.map((entry) => this.serializeEntry(entry)).join("");
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

  push(entry: string): void {
    if (!entry.trim()) return;
    try {
      this.withFileLock(() => {
        this.refreshFromDisk();
        // A crashed append can leave an unfinished line. Discard that tail
        // before starting a new, well-formed command record.
        const stat = fs.existsSync(this.historyFile) ? fs.statSync(this.historyFile) : undefined;
        if (stat && stat.size > this.diskOffset) {
          fs.truncateSync(this.historyFile, this.diskOffset);
          this.refreshFromDisk(true);
        }
        if (this.lastEntryCount >= this.maxHistorySize) {
          this.compactHistory(this.compactToSize);
        }
        fs.appendFileSync(this.historyFile, this.serializeEntry(entry));
        this.historyBuffer.push(entry);
        this.historyBuffer = this.historyBuffer.slice(-this.maxHistorySize);
        this.sessionEntries.push(entry);
        this.sessionEntries = this.sessionEntries.slice(-this.maxHistorySize);
        this.historyIndex = this.historyBuffer.length;
        const updated = fs.statSync(this.historyFile);
        this.diskStamp = updated.size + ":" + updated.mtimeMs;
        this.diskOffset = updated.size;
        this.diskFileId = updated.dev + ":" + updated.ino;
        this.lastEntryCount++;
      });
    } catch {
      // Keep the command in session history when disk storage is unavailable.
      this.historyBuffer.push(entry);
      this.historyBuffer = this.historyBuffer.slice(-this.maxHistorySize);
      this.sessionEntries.push(entry);
      this.sessionEntries = this.sessionEntries.slice(-this.maxHistorySize);
      this.historyIndex = this.historyBuffer.length;
    }
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
