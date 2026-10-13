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
  private readonly maxHistorySize = 10000;
  private diskStamp: string | undefined;

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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (force || this.diskStamp !== "missing") {
        this.historyBuffer = [];
        this.historyIndex = 0;
        this.diskStamp = "missing";
      }
      return;
    }
    const stamp = stat.size + ":" + stat.mtimeMs;
    if (!force && stamp === this.diskStamp) return;
    const text = fs.readFileSync(this.historyFile, "utf8");
    const lines = text.split(/\r?\n/);
    let pending: string[] = [];
    const entries: string[] = [];
    const flush = () => {
      if (!pending.length) return;
      const command = pending.join("\n");
      if (command.trim()) entries.push(command);
      pending = [];
    };
    for (const line of lines) {
      if (line.startsWith("+")) pending.push(line.slice(1));
      else if (line.trim() === "") flush();
    }
    flush();
    const oldEntries = this.historyBuffer;
    const oldLength = oldEntries.length;
    const oldIndex = this.historyIndex;
    this.historyBuffer = entries.slice(-this.maxHistorySize);
    // Entries removed from the front shift the absolute navigation cursor.
    // Locate the previous current entry in the updated history when possible.
    if (oldIndex === oldLength) {
      this.historyIndex = this.historyBuffer.length;
    } else {
      const previous = oldEntries[oldIndex];
      this.historyIndex = previous === undefined ? this.historyBuffer.length :
        Math.max(0, this.historyBuffer.lastIndexOf(previous));
    }
    this.diskStamp = stamp;
  }

  load(): void {
    this.refreshFromDisk(true);
    this.sessionEntries = [];
  }

  save(): void {}

  push(entry: string): void {
    if (!entry.trim()) return;
    this.refreshFromDisk();
    fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
    const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
    const record = "\n# time: " + now + "\n" +
      entry.split("\n").map((line) => "+" + line + "\n").join("");
    fs.appendFileSync(this.historyFile, record);
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
