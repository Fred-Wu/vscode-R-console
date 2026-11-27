import * as fs from "fs";
import * as path from "path";
import { pinEntryIdentity, type LibraryPin } from "./libraryLocationPin";

type Entry = { library: string; name: string; parentIdentity: string };
type Entries = Map<string, Entry>;
type ParentWatch = { watcher: fs.FSWatcher; entries: Entries; identity: string };
type Failure = { entries: Entries; attempts: number; lastAttemptAt: number; nextAttemptAt?: number };
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

/** Watch entries from the authorised pin only. A notification or failed
 * registration revalidates that pin; it cannot discover a replacement root. */
export class LibraryPathEntryMonitor {
  private readonly roots = new Map<string, LibraryPin>();
  private readonly watches = new Map<string, ParentWatch>();
  private readonly failures = new Map<string, Failure>();
  private recoveryTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private reconciling = false;
  private reconcileAgain = false;
  private readonly queuedRetries = new Set<string>();

  constructor(
    private readonly validateLibrary: (library: string) => boolean,
    private readonly log: (message: string) => void,
    private readonly filesystem: Pick<typeof fs, "lstatSync" | "watch"> = fs,
    private readonly clock: EntryRetryClock = systemClock,
  ) {}

  add(library: string, pin: LibraryPin): void {
    if (this.disposed) return;
    this.roots.set(library, pin);
    this.reconcile();
  }

  /** Active package and relevant ancestor events can recover a failed parent
   * registration after its five scheduled attempts, at most once per 10s. */
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
    if (this.roots.delete(library)) this.reconcile();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    this.roots.clear();
    this.failures.clear();
    this.queuedRetries.clear();
    for (const item of this.watches.values()) item.watcher.close();
    this.watches.clear();
  }

  private validate(library: string): boolean {
    const pin = this.roots.get(library);
    if (!pin || this.disposed) return false;
    try { return this.validateLibrary(library) && this.roots.get(library) === pin; }
    catch { return false; }
  }

  private validateEntries(entries: Entries): void {
    for (const library of new Set([...entries.values()].map(entry => entry.library))) this.validate(library);
  }

  private fail(parent: string, entries: Entries, error: unknown): void {
    if (this.disposed) return;
    const previous = this.failures.get(parent);
    if (previous) previous.entries = entries;
    else {
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
    if (allowed.size) this.reconcile(allowed);
    else this.armTimer();
  }

  private reconcile(allowedRetries: Set<string> = new Set()): void {
    if (this.disposed) return;
    for (const parent of allowedRetries) this.queuedRetries.add(parent);
    // Validation may synchronously suspend and remove a library. Build a fresh
    // wanted set after removals instead of re-entering with obsolete entries.
    if (this.reconciling) { this.reconcileAgain = true; return; }
    this.reconciling = true;
    try {
      do {
        this.reconcileAgain = false;
        const retries = new Set(this.queuedRetries);
        this.queuedRetries.clear();
        this.reconcileOnce(retries);
      } while (!this.disposed && this.reconcileAgain);
    } finally { this.reconciling = false; }
  }

  private reconcileOnce(allowedRetries: Set<string>): void {
    const verified = new Set([...this.roots.keys()].filter(library => this.validate(library)));
    const wanted = new Map<string, Entries>();
    for (const [library, pin] of this.roots) {
      for (const chain of [pin.physical, pin.configured]) {
        // The pin already ends at the first configured link and contains only
        // ordinary physical ancestors. Never walk a newly discovered path.
        if (chain.length - 1 > MAX_PATH_COMPONENTS) {
          this.log(`[Libraries] Limited root-entry monitoring: ${library} - path depth exceeds ${MAX_PATH_COMPONENTS}`);
          continue;
        }
        for (let i = 1; i < chain.length; i++) {
          const parent = chain[i - 1];
          const name = path.basename(chain[i].path);
          const entries = wanted.get(parent.path) ?? new Map<string, Entry>();
          entries.set(JSON.stringify([library, name]), { library, name, parentIdentity: parent.identity });
          wanted.set(parent.path, entries);
        }
      }
    }
    for (const [parent, current] of this.watches) {
      if (!wanted.has(parent)) { current.watcher.close(); this.watches.delete(parent); }
    }
    for (const parent of this.failures.keys()) {
      if (!wanted.has(parent)) this.failures.delete(parent);
    }
    for (const [parent, entries] of wanted) {
      // Retain failure budgets/old watches during temporary I/O failures, but
      // register new watches only for libraries whose pin is still verified.
      const trusted = [...entries.values()].find(entry => verified.has(entry.library) && this.roots.has(entry.library));
      const current = this.watches.get(parent);
      if (current) {
        current.entries = entries;
        if (!trusted || current.identity === trusted.parentIdentity) continue;
        current.watcher.close();
        this.watches.delete(parent);
      }
      const failure = this.failures.get(parent);
      if (failure) {
        failure.entries = entries;
        if (!allowedRetries.has(parent)) continue;
      }
      if (!trusted) continue;
      try {
        // Recheck the original pin immediately before a new registration,
        // including ancestors above the parent being watched.
        if (!this.validate(trusted.library)) continue;
        const expected = trusted.parentIdentity;
        const matches = () => {
          const stat = this.filesystem.lstatSync(parent, { bigint: true });
          return stat.isDirectory() && pinEntryIdentity(stat) === expected;
        };
        if (!matches()) throw new Error("Pinned parent identity changed before watch registration");
        const watcher = this.filesystem.watch(parent,
          { persistent: false, recursive: false, encoding: "utf8" }, (_event, filename) => {
            const active = this.watches.get(parent);
            if (active?.watcher === watcher) this.handle(active.entries, filename);
          });
        try {
          if (!matches() || !this.validate(trusted.library)) {
            throw new Error("Pinned parent identity changed during watch registration");
          }
        } catch (error) { watcher.close(); throw error; }
        watcher.on("error", error => {
          const active = this.watches.get(parent);
          if (active?.watcher !== watcher) return;
          watcher.close();
          this.watches.delete(parent);
          this.fail(parent, active.entries, error);
          this.validateEntries(active.entries);
          this.reconcile();
        });
        this.watches.set(parent, { watcher, entries, identity: expected });
        if (failure) {
          this.failures.delete(parent);
          this.log(`[Libraries] Monitoring restored: ${parent}`);
        }
      } catch (error) {
        this.fail(parent, entries, error);
        this.validateEntries(entries);
      }
    }
    this.armTimer();
  }

  private handle(entries: Entries, filename?: string | Buffer | null): void {
    if (this.disposed) return;
    const name = filename == null ? undefined : String(filename);
    const affected = new Set([...entries.values()].filter(entry => !name || (process.platform === "win32"
      ? name.toLowerCase() === entry.name.toLowerCase() : name === entry.name)).map(entry => entry.library));
    for (const library of affected) {
      if (this.validate(library)) this.onLibraryEvent(library);
    }
  }
}
