import { parentPort } from "worker_threads";
import { getHistoryFile, HistoryStore } from "./historyStore";
import type { HistoryRequest, HistoryUpdate } from "./history";

const port = parentPort!;
type RecordState = {
  store: HistoryStore;
  previous: { entries: string[]; ids: string[]; start: number };
  unconfirmed: Set<string>;
  closed: boolean;
  initialized: boolean;
};
const stores = new Map<number, RecordState>();
let shuttingDown = false;

function publish(id: number, record: RecordState): void {
  const full = record.store.getSnapshot();
  const offset = Math.max(0, full.entries.length - 200);
  const snapshot = { entries: full.entries.slice(offset), ids: full.ids.slice(offset),
    start: full.start + offset };
  const previous = record.previous;
  const remove = snapshot.start - previous.start;
  const retained = previous.entries.length - remove;
  const reset = !record.initialized || remove < 0 || retained < 0 ||
    retained > snapshot.entries.length ||
    previous.ids.slice(remove).some((id, index) => id !== snapshot.ids[index]);
  const persisted = record.store.getPersistedIds([...record.unconfirmed]);
  for (const entry of persisted) record.unconfirmed.delete(entry);
  port.postMessage({
    id, start: snapshot.start, reset, remove,
    entries: reset ? snapshot.entries : snapshot.entries.slice(retained),
    ids: reset ? snapshot.ids : snapshot.ids.slice(retained),
    persisted,
  } satisfies HistoryUpdate);
  record.previous = snapshot;
  record.initialized = true;
}

function releaseClosedStores(): void {
  for (const [id, record] of stores) {
    if (record.unconfirmed.size) publish(id, record);
    if (record.closed && !record.store.hasPendingWrites && record.unconfirmed.size === 0) {
      record.store.dispose();
      stores.delete(id);
    }
  }
  if (shuttingDown && stores.size === 0) port.postMessage({ stopped: true });
}

const cleanup = setInterval(releaseClosedStores, 1000);
cleanup.unref();

port.on("message", (request: HistoryRequest | { shutdown: true }) => {
  if ("shutdown" in request) {
    shuttingDown = true;
    for (const record of stores.values()) {
      record.closed = true;
      record.store.save();
    }
    releaseClosedStores();
    return;
  }
  let record = stores.get(request.id);
  if (!record) {
    const location = request.location;
    const file = typeof location === "string" ? location
      : getHistoryFile(location.storageFolder, location.scope, location.workspaceFolder);
    const store = new HistoryStore(file);
    store.load();
    record = { store, previous: { entries: [], ids: [], start: 0 },
      unconfirmed: new Set<string>(), closed: false, initialized: false };
    stores.set(request.id, record);
  }
  if (request.page) {
    const source = record.store.getSnapshot();
    const { requestId, limit, query, collapse, offset, beforeId, afterId, aroundId } = request.page;
    const count = Math.max(1, Math.min(200, limit));
    const all = source.entries.map((code, index) => ({
      code, id: source.ids[index], historyIndex: source.start + index,
    }));
    let page: typeof all;
    let next = false;
    if (beforeId !== undefined || afterId !== undefined || aroundId !== undefined) {
      const target = beforeId ?? afterId ?? aroundId;
      const index = all.findIndex((entry) => entry.id === target);
      const anchor = index < 0 ? all.length : index;
      const from = aroundId !== undefined ? Math.max(0, anchor - Math.floor(count / 2))
        : afterId !== undefined ? Math.max(0, anchor + 1) : Math.max(0, anchor - count);
      const to = aroundId !== undefined ? Math.min(all.length, from + count)
        : afterId !== undefined ? Math.min(all.length, from + count) : anchor;
      page = all.slice(from, to);
      next = beforeId !== undefined ? from > 0 : to < all.length;
    } else {
      const lowerQuery = (query ?? "").toLowerCase();
      const matched: typeof all = [];
      const seen = new Set<string>();
      for (let index = all.length - 1; index >= 0; index--) {
        const entry = all[index];
        let position = 0;
        let found = true;
        for (const char of lowerQuery) {
          const nextIndex = entry.code.toLowerCase().indexOf(char, position);
          if (nextIndex < 0) { found = false; break; }
          position = nextIndex + 1;
        }
        if (!found || (collapse && seen.has(entry.code))) continue;
        seen.add(entry.code);
        matched.push(entry);
      }
      const start = Math.max(0, offset ?? 0);
      page = matched.slice(start, start + count);
      next = start + count < matched.length;
    }
    port.postMessage({ id: request.id, pageResult: { requestId, entries: page,
      hasMore: next } });
    return;
  }
  for (const entry of request.entries) record.unconfirmed.add(entry.id);
  record.store.pushEntries(request.entries);
  let deleted: string[] | undefined;
  let deletionComplete = false;
  let deletionError: string | undefined;
  if (request.delete) {
    try {
      deleted = record.store.deleteEntries(request.delete);
      for (const id of deleted) record.unconfirmed.delete(id);
      deletionComplete = true;
    } catch (error) {
      deletionError = error instanceof Error ? error.message : String(error);
    }
  }
  record.closed = request.close;
  publish(request.id, record);
  if (request.delete) {
    port.postMessage({ id: request.id, start: record.previous.start, reset: false,
      remove: 0, entries: [], deleted, deletionComplete, error: deletionError });
  }
  releaseClosedStores();
});
