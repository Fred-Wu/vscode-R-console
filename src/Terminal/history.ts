import * as path from "path";
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

export type HistoryLocation = string | {
  storageFolder: string;
  scope: HistoryScope;
  workspaceFolder?: string;
};

export type HistoryRequest = {
  id: number;
  location: HistoryLocation;
  entries: string[];
  close: boolean;
};

export type HistoryUpdate = {
  id: number;
  start: number;
  reset: boolean;
  remove: number;
  entries: string[];
};

let worker: Worker | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let nextId = 0;
const histories = new Map<number, HistoryManager>();

function getWorker(workerPath: string): Worker {
  if (!worker) {
    const created = new Worker(workerPath);
    worker = created;
    created.on("message", (update: HistoryUpdate) => histories.get(update.id)?.receive(update));
    const failed = () => {
      if (worker !== created) return;
      worker = undefined;
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = undefined;
      for (const history of histories.values()) history.disableStorage();
      histories.clear();
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
  private pending: string[] = [];
  private sent: string[] | undefined;
  private sentClosing = false;
  private stored: string[] = [];
  private storedStart = 0;
  private scheduled: ReturnType<typeof setImmediate> | undefined;
  private closing = false;
  private disabled = false;
  private suspended = 0;
  private deferredUpdate: HistoryUpdate | undefined;

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

  override push(entry: string): void {
    if (!entry.trim() || this.closing) return;
    super.push(entry);
    if (!this.disabled) {
      this.pending.push(entry);
      if (this.pending.length > this.maxHistorySize) this.pending.shift();
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

  // Keep the picker's occurrence indices stable until its selection is applied.
  suspendUpdates(): () => void {
    this.suspended++;
    return () => {
      this.suspended--;
      if (!this.suspended && this.deferredUpdate) {
        const update = this.deferredUpdate;
        this.deferredUpdate = undefined;
        this.receive(update);
      }
    };
  }

  receive(update: HistoryUpdate): void {
    if (this.disabled) return;
    if (this.suspended && !this.closing) {
      this.deferredUpdate = update;
      return;
    }
    const sentLength = this.sent?.length ?? 0;
    if (update.reset || update.remove || update.entries.length || sentLength) {
      const oldLength = this.historyBuffer.length;
      const oldIndex = this.historyIndex;
      const oldTrim = Math.max(0, this.stored.length + sentLength + this.pending.length - oldLength);
      const originalIndex = oldIndex + oldTrim;
      let nextIndex = originalIndex < this.stored.length
        ? this.storedStart + originalIndex - update.start
        : originalIndex - this.stored.length - sentLength;
      const wasStored = originalIndex < this.stored.length;
      this.stored = update.reset ? update.entries
        : [...this.stored.slice(update.remove), ...update.entries];
      this.storedStart = update.start;
      if (!wasStored) nextIndex += this.stored.length;
      const combined = [...this.stored, ...this.pending];
      const trim = Math.max(0, combined.length - this.maxHistorySize);
      this.historyBuffer = combined.slice(trim);
      this.historyIndex = oldIndex === oldLength ? this.historyBuffer.length
        : Math.max(0, Math.min(this.historyBuffer.length, nextIndex - trim));
    }
    this.sent = undefined;
    if (this.closing) {
      if (!this.sentClosing || this.pending.length) this.save();
      else histories.delete(this.id);
    } else if (this.pending.length) {
      this.save();
    }
  }

  dispose(): void {
    if (this.closing) return;
    this.closing = true;
    if (this.deferredUpdate) {
      const update = this.deferredUpdate;
      this.deferredUpdate = undefined;
      this.receive(update);
    }
    this.save();
  }

  disableStorage(): void {
    this.disabled = true;
    histories.delete(this.id);
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.sent = undefined;
    this.pending = [];
    this.deferredUpdate = undefined;
  }
}
