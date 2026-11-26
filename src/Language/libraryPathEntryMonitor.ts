import * as fs from "fs";
import * as path from "path";

export type LibraryPathEntryChange = {
  library: string;
  pinnedRoot: string;
  entry: string;
  kind: "physical" | "alias";
  state: "directory" | "link" | "missing" | "other";
};

type Entry = LibraryPathEntryChange & { parent: string; name: string; key: string };
type ParentWatch = { watcher: fs.FSWatcher; entries: Map<string, Entry> };
type Failure = { entries: Map<string, Entry>; attempts: number; lastAttemptAt: number; nextAttemptAt?: number };
export type EntryRetryClock = {
  now(): number;
  after(callback: () => void, delay: number): NodeJS.Timeout;
  cancel(timer: NodeJS.Timeout): void;
};

const MAX_PATH_COMPONENTS = 48;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;
const EVENT_RETRY_GAP_MS = 10000;
const systemClock: EntryRetryClock = {
  now: () => Date.now(),
  after: (callback, delay) => setTimeout(callback, delay),
  cancel: timer => clearTimeout(timer),
};

/**
 * Watches directory entries on pinned physical paths and configured aliases,
 * never following newly discovered destinations or package-cache links.
 * Parent watch failures get five automatic retries, then recover only on
 * relevant events, with no idle polling.
 */
export class LibraryPathEntryMonitor {
  private readonly roots = new Map<string, string>();
  private readonly watches = new Map<string, ParentWatch>();
  private readonly identities = new Map<string, string>();
  private readonly failures = new Map<string, Failure>();
  private recoveryTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly onChange: (change: LibraryPathEntryChange) => void,
    private readonly log: (message: string) => void,
    private readonly filesystem: Pick<typeof fs, "lstatSync" | "watch"> = fs,
    private readonly validateLibrary: (library: string) => boolean = () => true,
    private readonly clock: EntryRetryClock = systemClock,
  ) {}

  add(library: string, pinnedRoot: string): void {
    if (this.disposed || this.roots.get(library) === pinnedRoot) return;
    this.roots.set(library, pinnedRoot);
    this.reconcile();
  }

  /** A library's missing entry is covered by its immediate existing parent,
   * not by just any watcher somewhere higher in the path. */
  hasPhysicalEntryWatch(library: string): boolean {
    const parent = this.requiredPhysicalParent(library);
    const watched = parent && this.watches.get(parent);
    return !!watched && [...watched.entries.values()].some(entry =>
      entry.kind === "physical" && entry.library === library);
  }

  /** A failed watcher owns recovery for this missing entry; don't start an
   * additional, unbounded package-inventory retry loop. */
  hasPhysicalEntryRecovery(library: string): boolean {
    const parent = this.requiredPhysicalParent(library);
    const failed = parent && this.failures.get(parent);
    return !!failed && [...failed.entries.values()].some(entry =>
      entry.kind === "physical" && entry.library === library);
  }

  /** Called from an active package watcher or a relevant ancestor-entry event.
   * Each event validates the pinned path; after five scheduled retries,
   * it can also retry a failed registration at most once per ten seconds. */
  onLibraryEvent(library: string): void {
    if (this.disposed || !this.roots.has(library)) return;
    const affected = [...this.failures].filter(([, failure]) =>
      [...failure.entries.values()].some(entry => entry.library === library));
    if (!affected.length || !this.validate(library)) return;
    const now = this.clock.now();
    const allowed = new Set<string>();
    for (const [parent, failure] of affected) {
      if (failure.attempts < RETRY_DELAYS_MS.length ||
          now - failure.lastAttemptAt < EVENT_RETRY_GAP_MS) continue;
      failure.lastAttemptAt = now;
      allowed.add(parent);
    }
    if (allowed.size) this.reconcile(allowed);
  }

  remove(library: string): void {
    if (!this.roots.delete(library)) return;
    for (const key of this.identities.keys()) {
      if (key.startsWith(JSON.stringify(library) + "|")) this.identities.delete(key);
    }
    this.reconcile();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    this.roots.clear();
    this.identities.clear();
    this.failures.clear();
    for (const item of this.watches.values()) item.watcher.close();
    this.watches.clear();
  }

  private identity(entry: string): { value: string; state: LibraryPathEntryChange["state"] } {
    try {
      const s = this.filesystem.lstatSync(entry);
      const state = s.isSymbolicLink() ? "link" : s.isDirectory() ? "directory" : "other";
      // Package updates change directory mtime/ctime, not entry identity.
      return { state, value: JSON.stringify([state, s.dev, s.ino || 0, s.birthtimeMs]) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", value: "missing" };
      return { state: "other", value: `unavailable:${String(code ?? error)}` };
    }
  }

  private requiredPhysicalParent(library: string): string | undefined {
    const root = this.roots.get(library);
    if (!root) return undefined;
    let parent = path.parse(root).root;
    for (const part of root.slice(parent.length).split(path.sep).filter(Boolean)) {
      const child = path.join(parent, part);
      if (this.identity(child).state !== "directory") return parent;
      parent = child;
    }
    return path.dirname(root);
  }

  private gather(library: string, pinnedRoot: string, kind: "physical" | "alias",
    wanted: Map<string, Map<string, Entry>>): void {
    const target = path.resolve(kind === "physical" ? pinnedRoot : library);
    let parent = path.parse(target).root;
    const parts = target.slice(parent.length).split(path.sep).filter(Boolean);
    if (parts.length > MAX_PATH_COMPONENTS) {
      this.log(`[Libraries] Limited root-entry monitoring: ${library} - path depth exceeds ${MAX_PATH_COMPONENTS}`);
      return;
    }
    for (const name of parts) {
      // Never subscribe through a known link in the pinned physical path.
      if (this.identity(parent).state !== "directory") break;
      const entry = path.join(parent, name);
      const key = `${JSON.stringify(library)}|${kind}|${entry}`;
      const entries = wanted.get(parent) ?? new Map<string, Entry>();
      entries.set(key, { library, pinnedRoot, kind, parent, name, entry, key, state: "missing" });
      wanted.set(parent, entries);
      parent = entry;
    }
  }

  private validate(library: string): boolean {
    if (!this.roots.has(library)) return false;
    try { return this.validateLibrary(library); }
    catch { return false; }
  }

  private validateEntries(entries: Map<string, Entry>): void {
    for (const library of new Set([...entries.values()].map(entry => entry.library))) {
      this.validate(library);
    }
  }

  private fail(parent: string, entries: Map<string, Entry>, error: unknown): void {
    if (this.disposed) return;
    const previous = this.failures.get(parent);
    if (previous) {
      previous.entries = entries;
    } else {
      this.failures.set(parent, {
        entries, attempts: 0, lastAttemptAt: -Infinity,
        nextAttemptAt: this.clock.now() + RETRY_DELAYS_MS[0],
      });
      this.log(`[Libraries] Monitoring degraded: ${parent} - filesystem watcher unavailable (${String(error)})`);
    }
  }

  private cancelTimer(): void {
    if (this.recoveryTimer) this.clock.cancel(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  private armTimer(): void {
    this.cancelTimer();
    if (this.disposed) return;
    const due = [...this.failures.values()].map(failure => failure.nextAttemptAt)
      .filter((value): value is number => value !== undefined);
    if (!due.length) return;
    this.recoveryTimer = this.clock.after(() => this.retryScheduled(),
      Math.max(0, Math.min(...due) - this.clock.now()));
    this.recoveryTimer.unref?.();
  }

  private retryScheduled(): void {
    this.recoveryTimer = undefined;
    if (this.disposed) return;
    const now = this.clock.now();
    const allowed = new Set<string>();
    for (const [parent, failure] of this.failures) {
      if (failure.nextAttemptAt === undefined || failure.nextAttemptAt > now) continue;
      failure.attempts++;
      failure.lastAttemptAt = now;
      failure.nextAttemptAt = failure.attempts < RETRY_DELAYS_MS.length
        ? now + RETRY_DELAYS_MS[failure.attempts] : undefined;
      allowed.add(parent);
    }
    // lstat the pinned path before any attempt at registration.
    for (const parent of allowed) {
      const failure = this.failures.get(parent);
      if (failure) this.validateEntries(failure.entries);
    }
    if (allowed.size) this.reconcile(allowed);
    else this.armTimer();
  }

  private reconcile(allowedRetries: Set<string> = new Set()): void {
    if (this.disposed) return;
    const wanted = new Map<string, Map<string, Entry>>();
    for (const [library, root] of this.roots) {
      this.gather(library, root, "physical", wanted);
      if (path.resolve(library) !== path.resolve(root)) this.gather(library, root, "alias", wanted);
    }
    for (const [parent, existing] of this.watches) {
      if (!wanted.has(parent)) {
        existing.watcher.close();
        this.watches.delete(parent);
      }
    }
    for (const parent of this.failures.keys()) {
      if (!wanted.has(parent)) this.failures.delete(parent);
    }
    const activeKeys = new Set<string>();
    const newlyFailed: Map<string, Entry>[] = [];
    const missed: LibraryPathEntryChange[] = [];
    for (const [parent, entries] of wanted) {
      for (const entry of entries.values()) {
        activeKeys.add(entry.key);
        if (!this.identities.has(entry.key)) this.identities.set(entry.key, this.identity(entry.entry).value);
      }
      const current = this.watches.get(parent);
      if (current) {
        current.entries = entries;
        continue;
      }
      const failure = this.failures.get(parent);
      if (failure && !allowedRetries.has(parent)) {
        failure.entries = entries;
        continue;
      }
      try {
        if (this.identity(parent).state !== "directory") {
          throw Object.assign(new Error("Parent directory not ordinary"), { code: "ENOTDIR" });
        }
        const watcher = this.filesystem.watch(parent,
          { persistent: false, recursive: false, encoding: "utf8" },
          (_event, filename) => this.handle(parent, filename));
        watcher.on("error", error => {
          if (this.watches.get(parent)?.watcher !== watcher) return;
          watcher.close();
          this.watches.delete(parent);
          this.fail(parent, entries, error);
          this.validateEntries(entries);
          this.reconcile();
        });
        this.watches.set(parent, { watcher, entries });
        if (failure) {
          this.failures.delete(parent);
          this.log(`[Libraries] Monitoring restored: ${parent}`);
          // Recheck identities to detect changes missed during watcher downtime.
          for (const entry of entries.values()) {
            const next = this.identity(entry.entry);
            if (this.identities.get(entry.key) !== next.value) {
              this.identities.set(entry.key, next.value);
              missed.push({ library: entry.library, pinnedRoot: entry.pinnedRoot,
                entry: entry.entry, kind: entry.kind, state: next.state });
            }
          }
        }
      } catch (error) {
        const alreadyFailed = this.failures.has(parent);
        this.fail(parent, entries, error);
        if (!alreadyFailed) newlyFailed.push(entries);
      }
    }
    for (const key of this.identities.keys()) if (!activeKeys.has(key)) this.identities.delete(key);
    this.armTimer();
    for (const entries of newlyFailed) this.validateEntries(entries);
    for (const change of missed) {
      if (!this.disposed && this.roots.get(change.library) === change.pinnedRoot) this.onChange(change);
    }
  }

  private handle(parent: string, filename?: string | Buffer | null): void {
    const watch = this.watches.get(parent);
    if (!watch || this.disposed) return;
    const name = filename == null ? undefined : String(filename);
    const affected = new Set<string>();
    const changes: LibraryPathEntryChange[] = [];
    for (const entry of watch.entries.values()) {
      if (name && (process.platform === "win32"
        ? name.toLowerCase() !== entry.name.toLowerCase() : name !== entry.name)) continue;
      affected.add(entry.library);
      const next = this.identity(entry.entry);
      if (this.identities.get(entry.key) === next.value) continue;
      this.identities.set(entry.key, next.value);
      changes.push({ library: entry.library, pinnedRoot: entry.pinnedRoot,
        kind: entry.kind, entry: entry.entry, state: next.state });
    }
    for (const change of changes) this.onChange(change);
    for (const library of affected) this.onLibraryEvent(library);
    if (changes.length) this.reconcile();
  }
}
