import * as path from "path";
import { createHash, randomUUID } from "crypto";
import type { HistoryWrite, HistoryDeletion } from "./historyStore";
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

export type HistoryPickerEntry = { code: string; historyIndex: number; id?: string; order?: number };

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
  delete?: { ids?: string[]; codes?: string[]; all?: boolean; before?: number };
  page?: { requestId: number; limit: number; query?: string; collapse?: boolean;
    offset?: number; beforeId?: string; afterId?: string; aroundId?: string;
    beforeIndex?: number; afterIndex?: number; beforeOrder?: number; afterOrder?: number };
};

export type HistoryUpdate = {
  id: number;
  start: number;
  reset: boolean;
  remove: number;
  entries: string[];
  ids?: string[];
  orders?: number[];
  persisted?: string[];
  deleted?: string[];
  deletionComplete?: boolean;
  error?: string;
  deletedRules?: readonly HistoryDeletion[];
  pageResult?: { requestId: number; entries: HistoryPickerEntry[]; hasMore: boolean };
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
  private deletionQueue: { ids?: string[]; codes?: string[]; all?: boolean; before?: number }[] = [];
  private deleting: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private inFlightDeletion: { ids?: string[]; codes?: string[]; all?: boolean; before?: number } | undefined;
  private pageSequence = 0;
  private pageRequests = new Map<number, { resolve: (page: { entries: HistoryPickerEntry[]; hasMore: boolean }) => void;
    reject: (reason: Error) => void }>();
  private stored: string[] = [];
  private storedIds: string[] = [];
  private storedOrders: number[] = [];
  private historyIds: string[] = [];
  private navigationOrders: number[] = [];
  private sessionIds: string[] = [];
  private sessionTimestamps: number[] = [];
  private storedStart = 0;
  private browsingOlder = false;
  // The worker retains the complete scoped history. Navigation only caches a
  // sliding window around the current selection on the extension-host thread.
  private readonly navigationWindowSize = 400;
  private navigationStart = 0;
  private scheduled: ReturnType<typeof setImmediate> | undefined;
  private closing = false;
  private disabled = false;
  private suspended = 0;
  private deferredHistory: {
    updated: boolean;
  } | undefined;

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

  deleteEntries(entries: readonly HistoryPickerEntry[], collapseDuplicates: boolean): Promise<void> {
    const selection = collapseDuplicates
      ? { codes: [...new Set(entries.map((entry) => entry.code))] }
      : { ids: entries.map((entry) => entry.id).filter((id): id is string => !!id) };
    return this.requestDeletion(selection);
  }

  clearHistory(): Promise<void> {
    return this.requestDeletion({ all: true });
  }

  private requestDeletion(selection: { ids?: string[]; codes?: string[]; all?: boolean }): Promise<void> {
    if (this.disabled || this.closing) return Promise.reject(new Error("History storage is unavailable."));
    return new Promise<void>((resolve, reject) => {
      this.deletionQueue.push({ ...selection, before: performance.timeOrigin + performance.now() });
      this.deleting.push({ resolve, reject });
      this.save();
    });
  }

  async getPage(query: string, collapse: boolean, offset = 0, limit = 50,
    afterId?: string, afterIndex?: number, afterOrder?: number): Promise<{ entries: HistoryPickerEntry[]; hasMore: boolean }> {
    // The page must not overtake a submission queued on the extension host.
    // Wait only for queued writes; the worker still performs all disk I/O.
    if (this.pending.length || this.sent?.length) {
      this.save();
      await new Promise<void>((resolve, reject) => {
        let tries = 0;
        const check = (): void => {
          if (this.disabled || this.closing) {
            reject(new Error("History storage is unavailable."));
          } else if (!this.pending.length && !this.sent?.length) {
            resolve();
          } else if (++tries >= 500) {
            reject(new Error("Timed out waiting for pending history submissions."));
          } else {
            setTimeout(check, 10);
          }
        };
        check();
      });
    }
    return this.requestPage({ query, collapse, offset, limit, afterId, afterIndex, afterOrder });
  }

  private requestPage(page: Omit<NonNullable<HistoryRequest["page"]>, "requestId">): Promise<{
    entries: HistoryPickerEntry[]; hasMore: boolean
  }> {
    const requestId = ++this.pageSequence;
    return new Promise((resolve, reject) => {
      if (this.disabled || this.closing) return reject(new Error("History storage is unavailable."));
      this.pageRequests.set(requestId, { resolve, reject });
      try {
        getWorker(this.workerPath).postMessage({
          id: this.id, location: this.location, entries: [], close: false,
          page: { ...page, requestId },
        } satisfies HistoryRequest);
      } catch (error) {
        this.pageRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async searchBackwardOnDemand(term: string): Promise<string | null> {
    let found = this.searchBackward(term);
    while (found === null && await this.loadOlderNavigation()) {
      found = this.searchBackward(term);
    }
    return found;
  }

  async loadOlderNavigation(): Promise<boolean> {
    const first = this.historyIds[0];
    if (!first || this.disabled) return false;
    const page = await this.requestPage({
      beforeId: first, beforeIndex: this.navigationStart,
      beforeOrder: this.navigationOrders[0], limit: 200,
    });
    if (!page.entries.length) return false;
    // Another operation may have replaced this navigation window while
    // the background worker was fetching the preceding records.
    if (this.historyIds[0] !== first) return false;
    const alreadyLoaded = new Set(this.historyIds);
    const older = page.entries.filter((entry) => !alreadyLoaded.has(entry.id!));
    if (!older.length) return false;
    this.historyBuffer.unshift(...older.map((entry) => entry.code));
    this.historyIds.unshift(...older.map((entry) => entry.id!));
    this.navigationOrders.unshift(...older.map((entry) => entry.order!));
    this.navigationStart = older[0].historyIndex;
    this.historyIndex += older.length;
    // When moving backwards, discard the newest tail. Down will fetch it
    // again from the worker when the user reaches that boundary.
    const extra = Math.max(0, this.historyBuffer.length - this.navigationWindowSize);
    if (extra) {
      this.historyBuffer.splice(-extra);
      this.historyIds.splice(-extra);
      this.navigationOrders.splice(-extra);
      // Reverse search may have exhausted the whole preceding window; its
      // cursor can then point beyond the retained tail. Clamp it so another
      // search never indexes beyond the sliding cache.
      this.historyIndex = Math.min(this.historyIndex, this.historyBuffer.length);
    }
    this.browsingOlder = true;
    return true;
  }

  async selectPickerEntryOnDemand(entry: HistoryPickerEntry): Promise<boolean> {
    if (this.selectPickerEntry(entry)) return true;
    if (!entry.id) return false;
    const page = await this.requestPage({ aroundId: entry.id, limit: 200 });
    if (!page.entries.some((candidate) => candidate.id === entry.id)) return false;
    this.historyBuffer = page.entries.map((candidate) => candidate.code);
    this.historyIds = page.entries.map((candidate) => candidate.id!);
    this.navigationOrders = page.entries.map((candidate) => candidate.order!);
    this.navigationStart = page.entries[0].historyIndex;
    this.browsingOlder = true;
    const index = this.historyIds.indexOf(entry.id);
    this.selectEntryAt(index);
    return true;
  }

  async loadNewerNavigation(): Promise<boolean> {
    const last = this.historyIds[this.historyIds.length - 1];
    if (!last || this.disabled || !this.browsingOlder) return false;
    const page = await this.requestPage({
      afterId: last, afterIndex: this.navigationStart + this.historyIds.length - 1,
      afterOrder: this.navigationOrders.at(-1),
      limit: 200,
    });
    if (this.historyIds[this.historyIds.length - 1] !== last) return false;
    if (!page.entries.length) {
      this.browsingOlder = false;
      this.reconcileHistory();
      // We were on the newest entry. The pending Down should return the
      // saved editable draft, not jump to the oldest recent entry.
      this.historyIndex = Math.max(0, this.historyBuffer.length - 1);
      return true;
    }
    const alreadyLoaded = new Set(this.historyIds);
    const newer = page.entries.filter((entry) => !alreadyLoaded.has(entry.id!));
    if (!newer.length) return false;
    this.historyBuffer.push(...newer.map((entry) => entry.code));
    this.historyIds.push(...newer.map((entry) => entry.id!));
    this.navigationOrders.push(...newer.map((entry) => entry.order!));
    const extra = Math.max(0, this.historyBuffer.length - this.navigationWindowSize);
    if (extra) {
      this.historyBuffer.splice(0, extra);
      this.historyIds.splice(0, extra);
      this.navigationOrders.splice(0, extra);
      this.historyIndex = Math.max(0, this.historyIndex - extra);
    }
    this.navigationStart = this.historyIds.length
      ? page.entries.at(-1)!.historyIndex - this.historyIds.length + 1 : this.navigationStart;
    return true;
  }

  override resetIndex(): void {
    if (this.browsingOlder) {
      this.browsingOlder = false;
      this.reconcileHistory();
    }
    super.resetIndex();
  }

  override navigate(direction: number): string | null | undefined {
    if (this.browsingOlder && direction > 0 &&
      this.historyIndex + direction >= this.historyBuffer.length) return undefined;
    return super.navigate(direction);
  }

  // Match the exact occurrence ID; a stale picker position cannot select
  // another command after navigation paging or cross-window changes.
  selectPickerEntry(entry: HistoryPickerEntry): boolean {
    const index = entry.id ? this.historyIds.indexOf(entry.id) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.historyBuffer.length ||
      this.historyBuffer[index] !== entry.code) {
      return false;
    }
    this.selectEntryAt(index);
    return true;
  }

  override push(entry: string): void {
    if (!entry.trim() || this.closing) return;
    if (this.browsingOlder) {
      this.browsingOlder = false;
      this.reconcileHistory();
    }
    const write = { id: randomUUID(), code: entry, createdAt: performance.timeOrigin + performance.now() };
    super.push(entry);
    this.sessionIds.push(write.id);
    this.sessionTimestamps.push(write.createdAt);
    if (this.sessionIds.length > this.maxHistorySize) {
      this.sessionIds.shift();
      this.sessionTimestamps.shift();
    }
    this.historyIds.push(write.id);
    this.navigationOrders.push((this.navigationOrders.at(-1) ?? -1) + 1);
    if (this.navigationOrders.length > this.maxHistorySize) this.navigationOrders.shift();
    if (this.historyIds.length > this.maxHistorySize) this.historyIds.shift();
    if (!this.disabled) {
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
      const deletion = this.deletionQueue.shift();
      if (deletion) this.inFlightDeletion = deletion;
      this.sentClosing = this.closing;
      this.pending = [];
      try {
        getWorker(this.workerPath).postMessage({
          id: this.id, location: this.location, entries: this.sent, close: this.closing, delete: deletion,
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
      this.deferredHistory = { updated: false };
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
    const ids = update.ids ?? update.entries.map((_, index) =>
      "legacy-test:" + (update.start + (update.reset ? 0 : this.storedIds.length - update.remove) + index));
    this.storedIds = update.reset ? ids
      : [...this.storedIds.slice(update.remove), ...ids];
    // Older protocol snapshots may omit orders; retain positional fallback.
    this.storedOrders = update.reset ? (update.orders ?? [])
      : update.orders ? [...this.storedOrders.slice(update.remove), ...update.orders] : [];
    this.storedStart = update.start;
  }

  private acknowledge(update: HistoryUpdate): void {
    if (update.persisted?.length) {
      const saved = new Set(update.persisted);
      this.unconfirmed = this.unconfirmed.filter((entry) => !saved.has(entry.id));
    }
    this.sent = undefined;
    if (this.closing) {
      if (!this.sentClosing || this.pending.length || this.unconfirmed.length || this.deleting.length) this.save();
      else histories.delete(this.id);
    } else if (this.pending.length || this.deletionQueue.length) {
      this.save();
    }
  }

  private applyDeferredHistory(): void {
    const base = this.deferredHistory;
    this.deferredHistory = undefined;
    if (!base?.updated) return;
    this.reconcileHistory(true);
  }

  private reconcileHistory(includeSent = false): void {
    if (this.browsingOlder) return;
    const selected = this.historyIndex < this.historyBuffer.length
      ? this.historyIds[this.historyIndex] : undefined;
    const atEnd = this.historyIndex === this.historyBuffer.length;
    const sent = includeSent ? (this.sent ?? []) : [];
    const combined = [...this.stored, ...sent.map((entry) => entry.code),
      ...this.pending.map((entry) => entry.code)];
    const ids = [...this.storedIds, ...sent.map((entry) => entry.id),
      ...this.pending.map((entry) => entry.id)];
    const trim = Math.max(0, combined.length - this.maxHistorySize);
    this.historyBuffer = combined.slice(trim);
    this.historyIds = ids.slice(trim);
    this.navigationOrders = [...this.storedOrders,
      ...[...sent, ...this.pending].map((_entry, index) =>
        (this.storedOrders.at(-1) ?? -1) + index + 1)].slice(trim);
    this.navigationStart = this.storedStart + trim;
    const position = selected === undefined ? -1 : this.historyIds.indexOf(selected);
    this.historyIndex = atEnd ? this.historyBuffer.length
      : position >= 0 ? position : 0;
  }

  receive(update: HistoryUpdate): void {
    if (this.disabled) return;
    if (update.pageResult) {
      const request = this.pageRequests.get(update.pageResult.requestId);
      if (request) {
        this.pageRequests.delete(update.pageResult.requestId);
        request.resolve(update.pageResult);
      }
      return;
    }
    if (update.deletedRules?.length) {
      this.browsingOlder = false;
      const shouldRemove = (entry: HistoryWrite): boolean =>
        update.deletedRules!.some((rule) =>
          (entry.createdAt ?? 0) <= rule.before &&
          (rule.all || rule.ids?.includes(entry.id) ||
            rule.codeHashes?.includes(createHash("sha256").update(entry.code).digest("hex"))));
      this.pending = this.pending.filter((entry) => !shouldRemove(entry));
      this.unconfirmed = this.unconfirmed.filter((entry) => !shouldRemove(entry));
      if (this.sent) this.sent = this.sent.filter((entry) => !shouldRemove(entry));
      const kept = this.sessionIds.map((id, index) => ({
        id, code: this.sessionEntries[index], createdAt: this.sessionTimestamps[index],
      })).filter((entry) => !shouldRemove(entry));
      this.sessionIds = kept.map((entry) => entry.id);
      this.sessionEntries = kept.map((entry) => entry.code);
      this.sessionTimestamps = kept.map((entry) => entry.createdAt!);
    }
    if (update.deletionComplete !== undefined) {
      const operation = this.deleting.shift();
      this.inFlightDeletion = undefined;
      if (update.deletionComplete) {
        const removed = new Set(update.deleted ?? []);
        this.pending = this.pending.filter((entry) => !removed.has(entry.id));
        this.unconfirmed = this.unconfirmed.filter((entry) => !removed.has(entry.id));
        this.sessionEntries = this.sessionEntries.filter((_code, index) =>
          !removed.has(this.sessionIds[index]));
        this.sessionTimestamps = this.sessionTimestamps.filter((_timestamp, index) =>
          !removed.has(this.sessionIds[index]));
        this.sessionIds = this.sessionIds.filter((id) => !removed.has(id));
        this.browsingOlder = false;
        // A deletion overrides the picker freeze: the authoritative snapshot
        // has already been published by the worker before this confirmation.
        this.reconcileHistory();
        operation?.resolve();
      } else {
        operation?.reject(new Error(update.error ?? "History deletion failed."));
      }
      return;
    }
    if (this.suspended && !this.closing &&
      (update.deleted?.length || update.deletedRules?.length)) {
      this.applyStoredUpdate(update);
      this.reconcileHistory();
      this.acknowledge(update);
      return;
    }
    if (this.suspended && !this.closing) {
      // Update worker state and release the next queued write immediately,
      // without changing the cached entries that F8 is displaying.
      this.applyStoredUpdate(update);
      if (this.deferredHistory) this.deferredHistory.updated = true;
      this.acknowledge(update);
      return;
    }

    this.applyStoredUpdate(update);
    this.reconcileHistory();
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
    if (this.inFlightDeletion) {
      this.deletionQueue.unshift(this.inFlightDeletion);
      this.inFlightDeletion = undefined;
    }
    for (const request of this.pageRequests.values()) request.reject(new Error("History worker restarted."));
    this.pageRequests.clear();
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
    for (const request of this.pageRequests.values()) request.reject(new Error("History storage stopped."));
    this.pageRequests.clear();
    for (const operation of this.deleting) operation.reject(new Error("History storage stopped."));
    this.deleting = [];
    this.deletionQueue = [];
  }
}
