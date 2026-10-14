import * as path from "path";
import { randomUUID } from "crypto";
import type { HistoryWrite } from "./historyStore";
import { Worker } from "worker_threads";
import { HistoryBuffer } from "./historyBuffer";

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

export const HISTORY_PICKER_LIMIT = 50;

export type HistoryPickerEntry = { code: string; historyIndex: number };

// Search the existing console history buffer without copying it. Quick Pick
// only needs a small newest-first set; matching runs over the full cache.
// A subsequence match preserves Quick Pick's fuzzy-search behavior.
export function getHistoryPickerEntries(
  entries: readonly string[],
  collapseDuplicates: boolean,
  query = "",
  limit = HISTORY_PICKER_LIMIT
): HistoryPickerEntry[] {
  const items: HistoryPickerEntry[] = [];
  if (!Number.isSafeInteger(limit) || limit <= 0) return items;
  const term = query.toLowerCase();
  const seen = collapseDuplicates ? new Set<string>() : undefined;
  for (let historyIndex = entries.length - 1; historyIndex >= 0; historyIndex--) {
    const code = entries[historyIndex];
    if (term) {
      const lowerCode = code.toLowerCase();
      let position = 0;
      let matched = true;
      for (const char of term) {
        position = lowerCode.indexOf(char, position);
        if (position < 0) {
          matched = false;
          break;
        }
        position++;
      }
      if (!matched) continue;
    }
    if (seen?.has(code)) continue;
    seen?.add(code);
    items.push({ code, historyIndex });
    if (items.length === limit) break;
  }
  return items;
}

export type HistoryLocation = string | {
  storageFolder: string;
  scope: HistoryScope;
  workspaceFolder?: string;
};

export type HistoryRequest = {
  id: number;
  location: HistoryLocation;
  entries: HistoryWrite[];
  close: boolean;
};

export type HistoryUpdate = {
  id: number;
  start: number;
  reset: boolean;
  remove: number;
  entries: string[];
  persisted?: string[];
};

let worker: Worker | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let nextId = 0;
const deadOwners = new Set<string>();
const histories = new Map<number, HistoryManager>();

function getWorker(workerPath: string): Worker {
  if (!worker) {
    const owner = process.pid + ":" + randomUUID();
    const created = new Worker(workerPath, {
      workerData: { historyOwner: owner.split(":")[1], orphanOwners: [...deadOwners] },
    });
    worker = created;
    created.on("message", (update: HistoryUpdate) => histories.get(update.id)?.receive(update));
    const failed = () => {
      if (worker !== created) return;
      worker = undefined;
      deadOwners.add(owner);
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = undefined;
      for (const history of histories.values()) history.restartStorage();
      if (histories.size) {
        // Reopen on the next event-loop turn; never retry worker startup in
        // a tight failure loop on the extension-host thread.
        setTimeout(() => {
          for (const history of histories.values()) history.save();
        }, 100).unref();
      }
    };
    created.on("error", failed);
    created.on("exit", failed);
    created.unref();
    refreshTimer = setInterval(() => {
      for (const history of histories.values()) history.save();
    }, 1000);
    refreshTimer.unref();
  }
  return worker;
}

export async function disposeHistoryWorker(): Promise<void> {
  for (const history of histories.values()) history.dispose();
  // Let queued close requests reach the worker before asking it to stop.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const current = worker;
  if (!current) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      clearInterval(drain);
      current.off("message", onMessage);
      current.off("exit", finish);
      resolve();
    };
    const onMessage = (message: { stopped?: boolean }) => {
      if (message.stopped) finish();
    };
    const timeout = setTimeout(finish, 1500);
    const drain = setInterval(() => {
      if (histories.size === 0) {
        clearInterval(drain);
        current.postMessage({ shutdown: true });
      }
    }, 10);
    current.on("message", onMessage);
    current.once("exit", finish);
  });
  worker = undefined;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
  for (const history of histories.values()) history.disableStorage();
  histories.clear();
  void current.terminate().catch(() => {});
}

export class HistoryManager extends HistoryBuffer {
  private readonly id = ++nextId;
  private pending: HistoryWrite[] = [];
  private sent: HistoryWrite[] | undefined;
  private unconfirmed: HistoryWrite[] = [];
  private sentClosing = false;
  private stored: string[] = [];
  private storedStart = 0;
  private scheduled: ReturnType<typeof setImmediate> | undefined;
  private closing = false;
  private disabled = false;
  private suspended = 0;
  private deferredHistory: {
    storedStart: number;
    storedLength: number;
    unmerged: number;
    pushed: number;
    updated: boolean;
  } | undefined;
  // Only local pushes can evict cached entries while F8 defers worker updates.
  // Monotonic positions keep each displayed occurrence stable without a snapshot.
  private pickerFrontEvictions = 0;

  constructor(
    private readonly location: HistoryLocation,
    private readonly workerPath = path.join(__dirname, "historyWorker.js")
  ) {
    super();
    histories.set(this.id, this);
  }

  load(): void {
    this.save();
  }

  getPickerEntries(query: string, collapseDuplicates: boolean): HistoryPickerEntry[] {
    return getHistoryPickerEntries(this.historyBuffer, collapseDuplicates, query)
      .map(({ code, historyIndex }) => ({
        code, historyIndex: historyIndex + this.pickerFrontEvictions,
      }));
  }

  // F8 items carry a position from when they were displayed, not a live
  // array index. Return false if local submissions evicted the occurrence.
  selectPickerEntry(entry: HistoryPickerEntry): boolean {
    const index = entry.historyIndex - this.pickerFrontEvictions;
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.historyBuffer.length ||
      this.historyBuffer[index] !== entry.code) {
      return false;
    }
    this.selectEntryAt(index);
    return true;
  }

  override push(entry: string): void {
    if (!entry.trim() || this.closing) return;
    if (this.historyBuffer.length >= this.maxHistorySize) this.pickerFrontEvictions++;
    if (this.deferredHistory) this.deferredHistory.pushed++;
    super.push(entry);
    if (!this.disabled) {
      const write = { id: randomUUID(), code: entry };
      this.pending.push(write);
      this.unconfirmed.push(write);
      if (this.pending.length > this.maxHistorySize) this.pending.shift();
      if (this.unconfirmed.length > this.maxHistorySize) this.unconfirmed.shift();
    }
    this.save();
  }

  protected override refreshFromDisk(): void {
    this.save();
  }

  save(): void {
    if (this.disabled || this.scheduled || this.sent) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      if (this.disabled) return;
      this.sent = this.pending;
      this.sentClosing = this.closing;
      this.pending = [];
      try {
        getWorker(this.workerPath).postMessage({
          id: this.id, location: this.location, entries: this.sent, close: this.closing,
        } satisfies HistoryRequest);
      } catch {
        this.disableStorage();
      }
    });
  }

  // Freeze only the cache and navigation positions used by F8. Worker
  // snapshots, write acknowledgements, and new submissions keep flowing.
  suspendUpdates(): () => void {
    if (!this.suspended) {
      this.deferredHistory = {
        storedStart: this.storedStart,
        storedLength: this.stored.length,
        unmerged: (this.sent?.length ?? 0) + this.pending.length,
        pushed: 0,
        updated: false,
      };
    }
    this.suspended++;
    return () => {
      this.suspended--;
      if (!this.suspended) this.applyDeferredHistory();
    };
  }

  private applyStoredUpdate(update: HistoryUpdate): void {
    this.stored = update.reset ? update.entries
      : [...this.stored.slice(update.remove), ...update.entries];
    this.storedStart = update.start;
  }

  private acknowledge(update: HistoryUpdate): void {
    if (update.persisted?.length) {
      const saved = new Set(update.persisted);
      this.unconfirmed = this.unconfirmed.filter((entry) => !saved.has(entry.id));
    }
    this.sent = undefined;
    if (this.closing) {
      if (!this.sentClosing || this.pending.length || this.unconfirmed.length) this.save();
      else histories.delete(this.id);
    } else if (this.pending.length) {
      this.save();
    }
  }

  private applyDeferredHistory(): void {
    const base = this.deferredHistory;
    this.deferredHistory = undefined;
    if (!base?.updated) return;

    const oldLength = this.historyBuffer.length;
    const oldIndex = this.historyIndex;
    const oldTrim = Math.max(0, base.storedLength + base.unmerged + base.pushed - oldLength);
    const originalIndex = oldIndex + oldTrim;
    const stillUnmerged = (this.sent?.length ?? 0) + this.pending.length;
    const processed = base.unmerged + base.pushed - stillUnmerged;
    const nextIndex = originalIndex < base.storedLength
      ? base.storedStart + originalIndex - this.storedStart
      : this.stored.length + originalIndex - base.storedLength - processed;

    // A sent request has not been reflected in the last received worker
    // snapshot yet. Keep it visible along with new unsent submissions.
    const combined = [...this.stored,
      ...(this.sent ?? []).map((entry) => entry.code),
      ...this.pending.map((entry) => entry.code)];
    const trim = Math.max(0, combined.length - this.maxHistorySize);
    this.historyBuffer = combined.slice(trim);
    this.historyIndex = oldIndex === oldLength ? this.historyBuffer.length
      : Math.max(0, Math.min(this.historyBuffer.length, nextIndex - trim));
  }

  receive(update: HistoryUpdate): void {
    if (this.disabled) return;
    if (this.suspended && !this.closing) {
      // Update worker state and release the next queued write immediately,
      // without changing the cached entries that F8 is displaying.
      this.applyStoredUpdate(update);
      if (this.deferredHistory) this.deferredHistory.updated = true;
      this.acknowledge(update);
      return;
    }

    const oldLength = this.historyBuffer.length;
    const oldIndex = this.historyIndex;
    const sentLength = this.sent?.length ?? 0;
    if (update.reset || update.remove || update.entries.length || sentLength) {
      const oldTrim = Math.max(0, this.stored.length + sentLength + this.pending.length - oldLength);
      const originalIndex = oldIndex + oldTrim;
      let nextIndex = originalIndex < this.stored.length
        ? this.storedStart + originalIndex - update.start
        : originalIndex - this.stored.length - sentLength;
      const wasStored = originalIndex < this.stored.length;
      this.applyStoredUpdate(update);
      if (!wasStored) nextIndex += this.stored.length;
      const combined = [...this.stored, ...this.pending.map((entry) => entry.code)];
      const trim = Math.max(0, combined.length - this.maxHistorySize);
      this.historyBuffer = combined.slice(trim);
      this.historyIndex = oldIndex === oldLength ? this.historyBuffer.length
        : Math.max(0, Math.min(this.historyBuffer.length, nextIndex - trim));
    } else {
      this.applyStoredUpdate(update);
    }
    this.acknowledge(update);
  }

  dispose(): void {
    if (this.closing) return;
    this.closing = true;
    this.applyDeferredHistory();
    this.save();
  }

  restartStorage(): void {
    if (this.disabled) return;
    this.sent = undefined;
    this.sentClosing = false;
    this.pending = [...this.unconfirmed];
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
  }

  disableStorage(): void {
    this.disabled = true;
    histories.delete(this.id);
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.sent = undefined;
    this.pending = [];
    this.deferredHistory = undefined;
  }
}
