import { parentPort } from "worker_threads";
import { getHistoryFile, HistoryStore } from "./historyStore";
import type { HistoryRequest, HistoryUpdate } from "./history";

const port = parentPort!;
const stores = new Map<number, {
  store: HistoryStore;
  previous: { entries: string[]; start: number };
  closed: boolean;
}>();
let shuttingDown = false;

function releaseClosedStores(): void {
  for (const [id, record] of stores) {
    if (record.closed && !record.store.hasPendingWrites) {
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
    record = { store, previous: { entries: [], start: 0 }, closed: false };
    stores.set(request.id, record);
  }
  record.store.pushEntries(request.entries);
  const snapshot = record.store.getSnapshot();
  const previous = record.previous;
  const remove = snapshot.start - previous.start;
  const retained = previous.entries.length - remove;
  const reset = remove < 0 || retained < 0 || retained > snapshot.entries.length ||
    previous.entries.slice(remove).some((entry, index) => entry !== snapshot.entries[index]);
  port.postMessage({
    id: request.id,
    start: snapshot.start,
    reset,
    remove,
    entries: reset ? snapshot.entries : snapshot.entries.slice(retained),
  } satisfies HistoryUpdate);
  record.previous = snapshot;
  record.closed = request.close;
  releaseClosedStores();
});
