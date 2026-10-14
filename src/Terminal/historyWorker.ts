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
  const snapshot = record.store.getSnapshot();
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
  for (const entry of request.entries) record.unconfirmed.add(entry.id);
  record.store.pushEntries(request.entries);
  let deleted: string[] | undefined;
  let deletionComplete = false;
  if (request.delete) {
    try {
      deleted = record.store.deleteEntries(request.delete);
      for (const id of deleted) record.unconfirmed.delete(id);
      deletionComplete = true;
    } catch {
      // Retain the worker and existing history on an unsuccessful rewrite.
    }
  }
  record.closed = request.close;
  publish(request.id, record);
  if (request.delete) {
    port.postMessage({ id: request.id, start: record.previous.start, reset: false,
      remove: 0, entries: [], deleted, deletionComplete });
  }
  releaseClosedStores();
});
