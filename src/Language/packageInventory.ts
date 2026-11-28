import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { LibraryPathEntryMonitor } from "./libraryPathEntryMonitor";
import { captureLibraryPin, checkLibraryPin, describeLibraryPinChange, LibraryPinChanged,
  sameLibraryPin, type LibraryPin, type LibraryPinChange } from "./libraryLocationPin";
import type { LibraryMonitoringReview } from "./libraryMonitoringNotice";
import { inspectInstallation, verifyDirectory, type InstallationIdentity } from "./packageInstallationIdentity";

// A library may be on a slow network drive; bound watcher fanout per root.
const MAX_PACKAGE_WATCHES_PER_LIBRARY = 128;
const MAX_LIBRARY_ENTRIES = 4096;
const MAX_PACKAGE_READ_RETRIES = 5;

export type PackageInstallation = {
  name: string;
  path: string;
  target: string;
  identity: string;
  // The symlink entry itself, never its destination, supplies this identity.
  linked?: boolean;
};

export type LibraryInventory = {
  path: string;
  packages: Map<string, PackageInstallation>;
  // Paths deferred by installation locks or unreadable package metadata.
  deferred?: Map<string, string[]>;
  // Package-local read failures must not invalidate the rest of the library.
  unavailablePackages?: Map<string, string>;
  // Names excluded from monitoring because their installation contains links.
  unmonitored?: Set<string>;
  suspended?: boolean;
  // Keep verified state when a configured library is temporarily inaccessible.
  unavailable?: boolean;
};
export type PackageInventoryChange = {
  libraries: LibraryInventory[];
  packages: Map<string, PackageInstallation>;
  changed: string[];
  unmonitored?: string[];
  unmonitoredRoots?: string[];
  // Include every observed copy: R can skip an invalid higher-priority entry.
  changedInstallationPaths?: string[];
  isCurrent: () => boolean;
};

export class PackageInventory {
  private paths: string[] = [];
  private libraries: LibraryInventory[] = [];
  private packages = new Map<string, PackageInstallation>();
  private readonly watchers = new Map<string, PackageDirectoryWatcher>();
  private readonly entryMonitor: LibraryPathEntryMonitor;
  // A configuration authorises one physical directory and its ancestry.
  // Neither notifications nor watcher recovery may replace this identity.
  private readonly pins = new Map<string, LibraryPin>();
  private readonly suspended = new Set<string>();
  private readonly unavailable = new Set<string>();
  // Bounded metadata recovery budgets, independent of watcher failures.
  private readonly packageReadRetries = new Map<string, Map<string, number>>();
  private readonly reviews = new Map<string, LibraryMonitoringReview>();
  private timer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDelay = 1000;
  private pending: Promise<void> | undefined;
  private candidate: string | undefined;
  private initialized = false;
  private disposed = false;
  private revision = 0;
  private readonly dirtyLibraries = new Set<string>();
  // Ambiguous events can be directory metadata touches with no package change.
  private readonly unconfirmedLibraries = new Set<string>();

  constructor(
    private readonly onChange: (change: PackageInventoryChange) => Promise<void>,
    private readonly log: (message: string) => void,
    private readonly onLocationChange: (review: LibraryMonitoringReview) => void = () => {},
  ) {
    this.entryMonitor = new LibraryPathEntryMonitor(
      library => this.validateForEvent(library), message => this.log(message), fs);
  }

  private validateForEvent(library: string): boolean {
    if (this.disposed || !this.paths.includes(library) || this.suspended.has(library)) return false;
    try { return this.libraryTarget(library) !== undefined; }
    catch {
      // A transient failure is not a new identity. Keep the pin and recover
      // through the normal inventory retry path, without registering a watch.
      if (!this.unavailable.has(library)) {
        this.dirtyLibraries.add(library);
        this.schedule(250);
      } else this.scheduleRetry();
      return false;
    }
  }

  setLibraryPaths(paths: string[]): void {
    if (this.disposed || JSON.stringify(paths) === JSON.stringify(this.paths)) return;
    const active = new Set(paths);
    const previous = new Set(this.paths);
    this.paths = [...paths];
    this.revision++;
    this.candidate = undefined;
    for (const library of previous) {
      if (active.has(library)) continue;
      this.watchers.get(library)?.close();
      this.watchers.delete(library);
      this.pins.delete(library);
      this.reviews.delete(library);
      this.suspended.delete(library);
      this.unavailable.delete(library);
      this.packageReadRetries.delete(library);
      this.dirtyLibraries.delete(library);
      this.unconfirmedLibraries.delete(library);
      this.entryMonitor.remove(library);
    }
    for (const library of paths) {
      if (!previous.has(library)) this.pinLibrary(library);
      if (!this.suspended.has(library) && !this.watchers.has(library)) this.watchLibrary(library);
    }
    this.schedule(0);
  }

  private pinLibrary(library: string): void {
    let pin: LibraryPin;
    try { pin = captureLibraryPin(library); }
    catch (error) {
      if (error instanceof LibraryPinChanged) this.suspendLibrary(library, error.change);
      else {
        this.suspended.add(library);
        this.dirtyLibraries.add(library);
        this.log(`[Libraries] Monitoring suspended: ${library} - unable to pin the configured root: ${String(error)}; reconfigure to resume`);
      }
      return;
    }
    this.installPin(library, pin);
  }

  private installPin(library: string, pin: LibraryPin): void {
    this.pins.set(library, pin);
    this.suspended.delete(library);
    this.unavailable.delete(library);
    this.packageReadRetries.delete(library);
    this.reviews.delete(library);
    this.revision++;
    this.candidate = undefined;
    this.dirtyLibraries.add(library);
    this.log(pin.configured.length
      ? `[Libraries] Library alias: ${library} -> ${pin.root}`
      : `[Libraries] Pinned library: ${pin.root}`);
    this.entryMonitor.add(library, pin);
  }

  private suspendLibrary(library: string, change: LibraryPinChange): void {
    if (this.disposed || !this.paths.includes(library) || this.suspended.has(library)) return;
    const pin = this.pins.get(library);
    this.suspended.add(library);
    this.unavailable.delete(library);
    this.packageReadRetries.delete(library);
    this.revision++;
    this.candidate = undefined;
    this.watchers.get(library)?.close();
    this.watchers.delete(library);
    this.dirtyLibraries.add(library);
    this.unconfirmedLibraries.delete(library);
    this.entryMonitor.remove(library);
    const reason = describeLibraryPinChange(library, pin, change);
    this.log(`[Libraries] Monitoring suspended: ${library} - ${reason}: ${change.entry}`);
    const review: LibraryMonitoringReview = {
      library, previousRoot: pin?.root, entry: change.entry, reason,
      isCurrent: () => !this.disposed && this.paths.includes(library) && this.reviews.get(library) === review,
      review: () => review.isCurrent() ? captureLibraryPin(library) : undefined,
      reject: () => { if (review.isCurrent()) this.reviews.delete(library); },
      approve: proposal => {
        if (!review.isCurrent()) return false;
        let current: LibraryPin;
        try { current = captureLibraryPin(library); }
        catch { return false; }
        if (!sameLibraryPin(proposal, current) || !review.isCurrent()) return false;
        this.installPin(library, current);
        this.watchLibrary(library, true);
        this.schedule(250);
        return !this.suspended.has(library);
      },
    };
    this.reviews.set(library, review);
    this.schedule(250);
    try { this.onLocationChange(review); }
    catch { /* Notification failure must leave monitoring suspended. */ }
  }

  private rootFor(library: string): string {
    if (this.disposed || !this.paths.includes(library)) throw new Error("Library monitoring configuration changed");
    return this.pins.get(library)?.root ?? path.resolve(library);
  }

  private libraryTarget(library: string): LibraryPin | undefined {
    if (this.disposed || this.suspended.has(library)) return undefined;
    const pin = this.pins.get(library);
    if (!pin) return undefined;
    const change = checkLibraryPin(pin);
    if (change) {
      this.suspendLibrary(library, change);
      return undefined;
    }
    return pin;
  }

  private watchLibrary(library: string, recovering = false): void {
    if (this.disposed || this.suspended.has(library) || this.watchers.has(library)) return;
    let watcher: PackageDirectoryWatcher | undefined;
    try {
      const pin = this.libraryTarget(library);
      if (!pin) return;
      const root = pin.root;
      watcher = new PackageDirectoryWatcher(root, () => this.libraryTarget(library) === pin, (event, filename) => {
        if (this.disposed || this.watchers.get(library) !== watcher) return;
        if (!this.validateForEvent(library)) return;
        this.entryMonitor.onLibraryEvent(library);
        if (this.disposed || this.watchers.get(library) !== watcher) return;
        const name = filename ? String(filename) : "";
        // Directory notifications trigger a metadata identity check. Delayed
        // or duplicate events alone do not establish an installation change.
        if (event === "change" || !name || name === path.basename(root) || name.includes(path.sep)) {
          this.unconfirmedLibraries.add(library);
        } else {
          this.dirtyLibraries.add(library);
        }
        this.schedule(250);
      }, (reason) => this.log(`[Libraries] Limited package monitoring: ${library} - ${reason}; root events remain active`));
      if (this.libraryTarget(library) !== pin) { watcher.close(); return; }
      watcher.on("error", error => {
        if (this.disposed || this.watchers.get(library) !== watcher) return;
        this.watchers.delete(library);
        watcher?.close();
        if (this.suspended.has(library)) return;
        this.validateForEvent(library);
        if (this.suspended.has(library)) return;
        this.log(`[Libraries] Could not watch ${library}: ${String(error)}`);
        this.scheduleRetry();
      });
      this.watchers.set(library, watcher);
      this.dirtyLibraries.add(library);
      if (recovering) this.entryMonitor.add(library, pin);
      if (!this.suspended.has(library)) this.log(`[Libraries] ${recovering ? "Watcher restored" : "Watching folder"}: ${library}`);
    } catch (error) {
      watcher?.close();
      if (this.suspended.has(library)) return;
      this.validateForEvent(library);
      if (this.suspended.has(library)) return;
      this.log(`[Libraries] Could not watch ${library}: ${String(error)}`);
      this.scheduleRetry();
    }
  }

  private async installationLocks(library: string, entries: fs.Dirent[], isCurrent: () => boolean): Promise<Set<string>> {
    const locked = new Set<string>();
    for (const entry of entries) {
      if (!isCurrent()) break;
      if (!entry.isDirectory()) continue;
      const named = /^00LOCK-([A-Za-z][A-Za-z0-9.]*)$/.exec(entry.name);
      if (named) locked.add(named[1]);
      else if (entry.name === "00LOCK") {
        locked.add("*");
        // Inspect ordinary backup directories for packages absent at discovery.
        // Check each component before descending into the next one.
        const lockPath = path.join(library, "00LOCK");
        let folder = lockPath;
        let lockStat: fs.Stats | undefined;
        for (let depth = 0; depth < 2; depth++) {
          try {
            if (!isCurrent()) break;
            if (lockStat) verifyDirectory(lockPath, lockStat);
            const stat = await fs.promises.lstat(folder);
            if (!isCurrent()) break;
            if (lockStat) verifyDirectory(lockPath, lockStat);
            if (!stat.isDirectory()) break;
            lockStat ??= stat;
            verifyDirectory(folder, stat);
            const items = await fs.promises.readdir(folder, { withFileTypes: true });
            if (!isCurrent()) break;
            verifyDirectory(lockPath, lockStat);
            if (folder !== lockPath) verifyDirectory(folder, stat);
            for (const item of items) {
              if (item.isDirectory() && /^[A-Za-z][A-Za-z0-9.]*$/.test(item.name)) locked.add(item.name);
            }
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ESTALE" && code !== "ELOOP") throw error;
            break;
          }
          folder = path.join(folder, "00new");
        }
      }
    }
    return locked;
  }

  private hasPackageReadRetries(): boolean {
    return [...this.packageReadRetries].some(([library, retries]) =>
      !this.suspended.has(library) && !this.unavailable.has(library) &&
      [...retries.values()].some(remaining => remaining > 0));
  }

  private updatePackageReadRetries(libraries: LibraryInventory[]): void {
    for (const library of libraries) {
      if (library.suspended || library.unavailable || !library.unavailablePackages?.size) {
        this.packageReadRetries.delete(library.path);
        continue;
      }
      const previous = this.packageReadRetries.get(library.path);
      this.packageReadRetries.set(library.path, new Map([...library.unavailablePackages.keys()]
        .map(name => [name, previous?.get(name) ?? MAX_PACKAGE_READ_RETRIES])));
    }
  }

  private runRecoveryRetry(): void {
    this.retryTimer = undefined;
    if (this.disposed) return;
    this.log("[Libraries] Recovery retry started");
    for (const library of this.paths) {
      if (!this.watchers.has(library)) this.watchLibrary(library, true);
      if (this.suspended.has(library) || this.unavailable.has(library)) continue;
      const retries = this.packageReadRetries.get(library);
      if (!retries) continue;
      for (const [name, remaining] of retries) {
        if (remaining <= 0) continue;
        retries.set(name, remaining - 1);
        this.dirtyLibraries.add(library);
      }
    }
    void this.refresh();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryDelay = 1000;
  }

  private scheduleRetry(cancelScheduledScan = false): void {
    if (this.disposed) return;
    // Keep already queued events from healthy libraries when a different
    // watcher fails. A failed publication must defer its next retry even
    // when another recovery timer is already armed.
    if (cancelScheduledScan) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.retryTimer) return;
    this.log(`[Libraries] Recovery retry scheduled in ${this.retryDelay / 1000}s`);
    this.retryTimer = setTimeout(() => this.runRecoveryRetry(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 30000);
    this.retryTimer.unref();
  }

  dispose(): void {
    this.disposed = true;
    this.revision++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.clearRetry();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.unconfirmedLibraries.clear();
    this.entryMonitor.dispose();
    this.pins.clear();
    this.reviews.clear();
    this.suspended.clear();
    this.unavailable.clear();
    this.packageReadRetries.clear();
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    const revision = this.revision;
    const dirty = new Set(this.dirtyLibraries);
    const unconfirmed = new Set(this.unconfirmedLibraries);
    this.dirtyLibraries.clear();
    this.unconfirmedLibraries.clear();
    let failed = false;
    const request = this.scan(revision, dirty, unconfirmed).then(() => {
      if (this.disposed || revision !== this.revision) return;
      if (this.hasPackageReadRetries()) {
        this.scheduleRetry();
      } else if (this.paths.every(library => this.watchers.has(library) || this.suspended.has(library)) &&
          !this.dirtyLibraries.size && !this.unconfirmedLibraries.size && !this.unavailable.size) {
        if (this.retryDelay > 1000 && !this.libraries.some(library => library.unavailablePackages?.size)) {
          this.log("[Libraries] Recovery complete; retries stopped");
        }
        this.clearRetry();
      }
    }).catch(error => {
      failed = true;
      if (!this.disposed && revision === this.revision) {
        for (const library of dirty) this.dirtyLibraries.add(library);
        for (const library of unconfirmed) this.unconfirmedLibraries.add(library);
        this.log(`[Libraries] Could not refresh package inventory: ${String(error)}`);
        this.scheduleRetry(true);
      }
    }).finally(() => {
      if (this.pending === request) this.pending = undefined;
      // The scan consumed these events before a newer library order arrived.
      // Replay them for paths still in the search order; otherwise the next
      // scan could reuse stale package metadata without another filesystem event.
      if (!this.disposed && revision !== this.revision) {
        const active = new Set(this.paths);
        for (const library of dirty) {
          if (active.has(library)) this.dirtyLibraries.add(library);
        }
        for (const library of unconfirmed) {
          if (active.has(library)) this.unconfirmedLibraries.add(library);
        }
        this.schedule(0);
      } else if (!this.disposed && !failed && !this.timer &&
          (this.dirtyLibraries.size || this.unconfirmedLibraries.size)) {
        // The normal timer may have fired while this scan was still pending.
        // Re-arm it independently of unrelated watcher or metadata recovery.
        this.schedule(250);
      }
    });
    this.pending = request;
    return request;
  }

  private schedule(delay: number): void {
    // Event-driven scans for healthy libraries must not wait for an unrelated
    // library watcher or failed publish to exhaust its recovery backoff.
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
    this.timer.unref();
  }

  private async hasInstalledPackagesChanged(library: string, previous: LibraryInventory, isCurrent: () => boolean): Promise<boolean> {
    try {
      if (!isCurrent() || this.libraryTarget(library) === undefined) return true;
      const root = this.rootFor(library);
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      if (!isCurrent() || this.libraryTarget(library) === undefined) return true;
      if (entries.some(entry => entry.isDirectory() && /^00LOCK(?:-[A-Za-z][A-Za-z0-9.]*)?$/.test(entry.name))) return true;
      if (previous.deferred?.size) return true;
      const names = entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) &&
        /^[A-Za-z][A-Za-z0-9.]*$/.test(entry.name)).map(entry => entry.name);
      if (names.length !== previous.packages.size + (previous.unmonitored?.size ?? 0)) return true;
      // lstat observes a linked package entry without reading its destination.
      // A link replacement changes its own identity and invalidates metadata.
      for (const name of names) {
        if (!isCurrent()) return true;
        const installed = previous.packages.get(name);
        const current = await this.inspectPackage(library, name, isCurrent);
        if (previous.unmonitored?.has(name)) {
          if (current) return true; // An unsafe installation became ordinary.
        } else if (!installed || !current || current.identity !== installed.identity) {
          return true;
        }
      }
      return !isCurrent() || this.libraryTarget(library) === undefined;
    } catch {
      // A missing or transient directory must take the normal recovery path.
      return true;
    }
  }

  private async scan(revision: number, dirty: Set<string>,
    unconfirmed: Set<string> = new Set()): Promise<void> {
    const libraries: LibraryInventory[] = [];
    const isCurrent = () => !this.disposed && revision === this.revision;
    for (const library of this.paths) {
      if (!isCurrent()) return;
      const previous = this.libraries.find(item => item.path === library);
      if (previous && !dirty.has(library) && !previous.unavailable) {
        if (!unconfirmed.has(library) ||
            !(await this.hasInstalledPackagesChanged(library, previous, isCurrent))) {
          libraries.push(previous);
          continue;
        }
        if (!isCurrent()) return;
        dirty.add(library);
      }
      // A pinned root can be temporarily inaccessible on a network share.
      // Do not turn read failures into package removals or force LSP restarts.
      const retained = (state: "suspended" | "unavailable"): LibraryInventory => ({
        path: library,
        packages: new Map(previous?.packages),
        deferred: new Map(previous?.deferred),
        unmonitored: new Set(previous?.unmonitored),
        unavailablePackages: new Map(previous?.unavailablePackages),
        [state]: true,
      });
      let entries: fs.Dirent[];
      try {
        this.log(`[Libraries] Scanning folder: ${library}`);
        const originalTarget = this.libraryTarget(library);
        if (originalTarget === undefined) {
          libraries.push(retained("suspended"));
          continue;
        }
        entries = await fs.promises.readdir(originalTarget.root, { withFileTypes: true });
        if (!isCurrent() || this.libraryTarget(library) !== originalTarget) return;
        if (entries.length > MAX_LIBRARY_ENTRIES) {
          throw Object.assign(new Error(`library entry budget exceeded (${MAX_LIBRARY_ENTRIES})`),
            { code: "E2BIG" });
        }
        const locked = await this.installationLocks(originalTarget.root, entries,
          () => isCurrent() && this.libraryTarget(library) === originalTarget);
        if (!isCurrent() || this.libraryTarget(library) !== originalTarget) return;
        // The package entry may be a symlink (renv/uvr). Record its lstat
        // identity, but never traverse, read or watch its target from here.
        const unmonitored = new Set<string>();
        const unavailablePackages = new Map<string, string>();
        if (locked.size) this.log(`[Libraries] Scan deferred: installation lock present - ${library}`);
        const deferred = new Map<string, string[]>();
        const libraryRoot = originalTarget.root;
        const defer = (name: string) => {
          const old = previous?.packages.get(name);
          const paths = new Set(previous?.deferred?.get(name));
          paths.add(path.join(library, name));
          paths.add(path.join(libraryRoot, name));
          if (old?.target) paths.add(old.target);
          deferred.set(name, [...paths].sort());
          return old;
        };
        const names = [...new Set([
          ...entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) &&
            /^[A-Za-z][A-Za-z0-9.]*$/.test(entry.name)).map(entry => entry.name),
          ...[...locked].filter(name => name !== "*"),
          ...(locked.has("*") ? previous?.packages.keys() ?? [] : []),
          ...(locked.has("*") ? previous?.deferred?.keys() ?? [] : []),
          ...(locked.has("*") ? previous?.unavailablePackages?.keys() ?? [] : []),
        ])].sort();
        const packages = new Map<string, PackageInstallation>();
        for (let offset = 0; offset < names.length; offset += 8) {
          if (!isCurrent()) return;
          const batch = await Promise.all(names.slice(offset, offset + 8).map(async name => {
            const old = previous?.packages.get(name);
            if (unmonitored.has(name)) return undefined;
            if (locked.has("*") || locked.has(name)) {
              const failure = previous?.unavailablePackages?.get(name);
              if (failure !== undefined) unavailablePackages.set(name, failure);
              return defer(name);
            }
            try {
              const item = await this.observePackage(library, name, old, isCurrent);
              if (item === null) unmonitored.add(name);
              return item;
            } catch (error) {
              if (!isCurrent()) return undefined;
              // An unreadable package is not evidence of removal. Keep its
              // last verified installation and defer reconciliation of this
              // path, without losing observations of healthy siblings.
              unavailablePackages.set(name, String(error));
              return defer(name);
            }
          }));
          for (const item of batch) if (item) packages.set(item.name, item);
        }
        // Re-validate after asynchronous reads before publishing observations.
        if (!isCurrent() || this.libraryTarget(library) !== originalTarget) return;
        if (this.unavailable.delete(library)) {
          this.log(`[Libraries] Monitoring restored: ${library}`);
          this.entryMonitor.add(library, originalTarget);
          if (!isCurrent()) return;
        }
        libraries.push({ path: library, packages, unmonitored, unavailablePackages,
          deferred: new Map([...deferred].sort(([a], [b]) => a.localeCompare(b))) });
      } catch (error) {
        if (!isCurrent()) return;
        if ((error as NodeJS.ErrnoException).code === "E2BIG") {
          // Refuse a too-broad root instead of repeatedly enumerating an
          // entire network share or home directory in recovery retries.
          this.suspended.add(library);
          this.unavailable.delete(library);
          this.packageReadRetries.delete(library);
          this.watchers.get(library)?.close();
          this.watchers.delete(library);
          this.entryMonitor.remove(library);
          this.log(`[Libraries] Monitoring suspended: ${library} - library exceeds ${MAX_LIBRARY_ENTRIES} entries; narrow the configured root and reconfigure`);
          libraries.push(retained("suspended"));
          continue;
        }
        if (this.suspended.has(library)) {
          libraries.push(retained("suspended"));
          continue;
        }
        // ENOENT from an asynchronous read is not proof of identity change;
        // validate the pinned ancestry again before deciding how to recover.
        try { this.libraryTarget(library); } catch { /* Temporarily unavailable. */ }
        if (!isCurrent()) return;
        if (!this.unavailable.has(library)) {
          const reason = error instanceof Error ? error.message : String(error);
          this.log(`[Libraries] Monitoring temporarily unavailable: ${library} - ${reason}; keeping last verified state`);
        }
        this.unavailable.add(library);
        libraries.push(retained("unavailable"));
        this.scheduleRetry();
      }
    }
    if (!isCurrent()) return;
    // Cached inventories also need a valid pin before automatic publication.
    // An unrelated library event may arrive before the changed ancestor's event.
    for (const item of libraries) {
      if (item.suspended || item.unavailable) continue;
      try { if (!this.libraryTarget(item.path)) return; }
      catch { this.dirtyLibraries.add(item.path); }
    }
    if (this.dirtyLibraries.size || this.unconfirmedLibraries.size) {
      for (const library of dirty) this.dirtyLibraries.add(library);
      for (const library of unconfirmed) this.unconfirmedLibraries.add(library);
      this.schedule(250);
      return;
    }

    // Lock transitions also need publication: a namespace deferred during
    // discovery may disappear without ever entering the package inventory.
    const signatureOf = (items: LibraryInventory[]) => JSON.stringify(items.map(library => [library.path,
      [...library.packages.values()].map(item => [item.name, item.identity]), [...(library.deferred ?? [])],
      [...(library.unmonitored ?? [])].sort(), [...(library.unavailablePackages?.keys() ?? [])].sort(),
      library.suspended ?? false, library.unavailable ?? false]));
    const signature = signatureOf(libraries);
    const previousSignature = signatureOf(this.libraries);
    if (this.initialized && signature === previousSignature) {
      this.candidate = undefined;
      // A content check without a package change is routine, not a lifecycle
      // event. Avoid flooding the output channel on normal console input.
      if (dirty.size) this.log("[Libraries] Package inventory unchanged");
      return;
    }
    if (this.initialized && this.candidate !== signature) {
      this.candidate = signature;
      this.log("[Libraries] Package inventory changed; checking again to confirm");
      for (const library of dirty) this.dirtyLibraries.add(library);
      this.schedule(250);
      return;
    }

    const packages = new Map<string, PackageInstallation>();
    const unmonitored = new Set<string>();
    for (const library of libraries) {
      // An unreadable higher-priority entry still occupies its search-order
      // position, even if it has never been successfully inventoried.
      for (const name of library.unavailablePackages?.keys() ?? []) {
        if (packages.has(name) || unmonitored.has(name)) continue;
        const old = library.packages.get(name);
        if (old) packages.set(name, old);
        unmonitored.add(name);
      }
      for (const name of library.unmonitored ?? []) if (!packages.has(name)) unmonitored.add(name);
      for (const [name, item] of library.packages) {
        if (!packages.has(name) && !unmonitored.has(name)) packages.set(name, item);
      }
    }
    // Retain the selected copy for display/precedence, but never ask the LSP
    // to compare or reload a namespace based on a suspended physical root.
    for (const library of libraries) {
      if (!library.suspended && !library.unavailable) continue;
      for (const [name, item] of library.packages) {
        if (packages.get(name) === item) unmonitored.add(name);
      }
    }
    const changed = [...new Set([...this.packages.keys(), ...packages.keys()])].filter(name =>
      !unmonitored.has(name) && this.packages.get(name)?.identity !== packages.get(name)?.identity);
    const changedInstallationPaths = new Set<string>();
    for (const library of libraries) {
      if (library.suspended || library.unavailable) continue;
      const previous = this.libraries.find(item => item.path === library.path);
      for (const name of new Set([...previous?.packages.keys() ?? [], ...library.packages.keys()])) {
        if (library.deferred?.has(name) || library.unmonitored?.has(name)) continue;
        const before = previous?.packages.get(name), after = library.packages.get(name);
        if (before?.identity === after?.identity) continue;
        if (before) changedInstallationPaths.add(before.target);
        if (after) changedInstallationPaths.add(after.target);
      }
    }
    const unmonitoredRoots = libraries.filter(library => library.suspended || library.unavailable)
      .flatMap(library => [library.path, this.rootFor(library.path)]);
    await this.onChange({ libraries, packages, unmonitored: [...unmonitored], unmonitoredRoots, changed: this.initialized ? changed : [],
      changedInstallationPaths: this.initialized ? [...changedInstallationPaths] : [],
      isCurrent: () => !this.disposed && revision === this.revision });
    if (this.disposed || revision !== this.revision) return;

    for (const library of libraries) {
      if (library.suspended || library.unavailable) continue;
      const previous = this.libraries.find(item => item.path === library.path);
      for (const [name, reason] of library.unavailablePackages ?? []) {
        if (!previous?.unavailablePackages?.has(name)) {
          this.log(`[Packages] Metadata temporarily unavailable: ${name} - ${library.path} (${reason}); keeping last verified state`);
        }
      }
      for (const name of previous?.unavailablePackages?.keys() ?? []) {
        if (!library.unavailablePackages?.has(name) && library.packages.has(name)) {
          this.log(`[Packages] Metadata restored: ${name} - ${library.path}`);
        }
      }
    }
    this.updatePackageReadRetries(libraries);

    if (this.initialized) {
      for (const library of this.libraries) {
        const next = libraries.find(item => item.path === library.path);
        for (const [name, item] of library.packages) {
          if (!next?.packages.has(name)) {
            if (next?.unmonitored?.has(name)) {
              this.log(`[Packages] Monitoring skipped: ${name} - installation contains links`);
              continue;
            }
            this.log(`[Packages] Removed copy: ${name} - ${item.path}`);
            const active = packages.get(name);
            if (active && active.identity === this.packages.get(name)?.identity) {
              this.log(`[Packages] Earlier library copy unchanged: ${name} - ${active.path}`);
            }
          }
        }
      }
      for (const library of libraries) {
        const previous = this.libraries.find(item => item.path === library.path)?.packages;
        for (const [name, item] of library.packages) {
          const old = previous?.get(name);
          if (!old) this.log(`[Packages] Added: ${name} - ${item.path}`);
          else if (old.identity !== item.identity) {
            this.log(`[Packages] Updated: ${name} - ${item.path}`);
          }
        }
      }
      for (const [name, old] of this.packages) {
        if (unmonitored.has(name)) continue;
        const next = packages.get(name);
        if (!next) this.log(`[Packages] Removed: ${name} - no copies remain in active libraries`);
        else if (next.path !== old.path) {
          const retained = libraries.some(library => library.packages.get(name)?.path === old.path);
          this.log(`[Packages] ${retained ? "First library copy changed" : "Remaining library copy"}: ${name} - ${next.path}`);
        }
      }
      if (!changed.length) this.log("[Libraries] First library copies unchanged");
    }
    this.log("[Libraries] Search order:");
    libraries.forEach((library, index) => this.log(
      `  ${index + 1}. ${library.path} - ${library.packages.size} ${library.packages.size === 1 ? "package" : "packages"}`));
    this.log(`[Libraries] ${libraries.reduce((sum, library) => sum + library.packages.size, 0)} installations; ${packages.size} unique package names`);
    this.libraries = libraries;
    this.packages = packages;
    this.initialized = true;
    this.candidate = undefined;
  }

  private async inspectPackage(library: string, name: string, isCurrent: () => boolean): Promise<InstallationIdentity | null | undefined> {
    if (!isCurrent()) return undefined;
    const pin = this.libraryTarget(library);
    if (!pin) return undefined;
    return inspectInstallation(path.join(pin.root, name),
      () => isCurrent() && this.libraryTarget(library) === pin);
  }

  private async observePackage(library: string, name: string, previous: PackageInstallation | undefined,
    isCurrent: () => boolean): Promise<PackageInstallation | null | undefined> {
    const current = await this.inspectPackage(library, name, isCurrent);
    if (!isCurrent()) return undefined;
    if (!current) return current;
    if (previous?.identity === current.identity) return previous;
    return { name, path: path.join(library, name), target: current.directory, identity: current.identity,
      ...(current.linked ? { linked: true } : {}) };
  }
}

/** Watch the library and its immediate ordinary package directories.
 * Each OS watch is non-recursive; package contents and links are not traversed. */
class PackageDirectoryWatcher extends EventEmitter {
  private readonly directories = new Map<string, { watcher: fs.FSWatcher; identity: string }>();
  private readonly failedPackages = new Map<string, { attempts: number; nextAttemptAt?: number }>();
  private static readonly retryDelays = [1000, 2000, 4000, 8000, 16000] as const;
  private timer: NodeJS.Timeout | undefined;
  private packageRetryTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private limitation: string | undefined;

  constructor(private readonly root: string, private readonly rootIsValid: () => boolean,
    onChange: (event: string, filename?: string) => void,
    private readonly onLimited?: (message: string) => void) {
    super();
    this.on("change", onChange);
    try { this.refresh(); }
    catch (error) { this.close(); throw error; }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.packageRetryTimer) clearTimeout(this.packageRetryTimer);
    this.packageRetryTimer = undefined;
    this.failedPackages.clear();
    for (const directory of this.directories.keys()) this.closeDirectory(directory);
  }

  private closeDirectory(directory: string): void {
    const current = this.directories.get(directory);
    this.directories.delete(directory);
    current?.watcher.close();
  }

  private failPackage(directory: string, error: unknown): void {
    this.closeDirectory(directory);
    if (this.closed || this.failedPackages.has(directory)) return;
    this.failedPackages.set(directory, { attempts: 0,
      nextAttemptAt: Date.now() + PackageDirectoryWatcher.retryDelays[0] });
    this.onLimited?.(`package watcher unavailable: ${directory} (${String(error)})`);
  }

  private watchDirectory(directory: string): boolean {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(directory); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      this.closeDirectory(directory);
      return false;
    }
    if (!stat.isDirectory()) {
      this.closeDirectory(directory);
      return false;
    }
    const identity = JSON.stringify([stat.dev, stat.ino || stat.birthtimeMs]);
    if (this.directories.get(directory)?.identity === identity) return true;
    this.closeDirectory(directory);
    const watcher = fs.watch(directory, { persistent: false, recursive: false }, (event, filename) => {
      if (this.closed || this.directories.get(directory)?.watcher !== watcher) return;
      const file = filename ? path.join(directory, String(filename)) : directory;
      const relative = path.relative(this.root, file);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return;
      if (relative.split(path.sep).length > 2) return;
      this.emit("change", event, relative);
      // Only root notifications can change the set of immediate package
      // directories. Coalesce bursts before reconciling that set.
      if (directory !== this.root || this.closed || this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        try { this.refresh(); } catch (error) { if (!this.closed) this.emit("error", error); }
      }, 50);
      this.timer.unref();
    });
    watcher.on("error", error => {
      if (this.closed || this.directories.get(directory)?.watcher !== watcher) return;
      if (directory === this.root) {
        this.emit("error", error);
      } else {
        this.failPackage(directory, error);
        this.emit("change", "change", path.relative(this.root, directory));
        this.schedulePackageRetry();
      }
    });
    // Reject a replacement between lstat and fs.watch. Node's path-based
    // API cannot remove the race entirely, but must not retain a watch on
    // a new link or directory identity.
    try {
      const confirmed = fs.lstatSync(directory);
      if (!confirmed.isDirectory() ||
          JSON.stringify([confirmed.dev, confirmed.ino || confirmed.birthtimeMs]) !== identity) {
        throw new Error("Watched directory identity changed during setup");
      }
    } catch (error) { watcher.close(); throw error; }
    this.directories.set(directory, { watcher, identity });
    return true;
  }

  private watchPackage(directory: string): void {
    try {
      this.watchDirectory(directory);
    } catch (error) {
      this.failPackage(directory, error);
      return;
    }
    // Either the ordinary watch has been restored, or this entry no longer
    // needs one. Check for changes that may have occurred during the gap.
    if (this.failedPackages.delete(directory)) {
      this.emit("change", "rename", path.relative(this.root, directory));
    }
  }

  private schedulePackageRetry(): void {
    if (this.packageRetryTimer) clearTimeout(this.packageRetryTimer);
    this.packageRetryTimer = undefined;
    if (this.closed) return;
    const due = [...this.failedPackages.values()].map(failure => failure.nextAttemptAt)
      .filter((value): value is number => value !== undefined);
    if (!due.length) return;
    this.packageRetryTimer = setTimeout(() => this.retryPackages(), Math.max(0, Math.min(...due) - Date.now()));
    this.packageRetryTimer.unref();
  }

  private retryPackages(): void {
    this.packageRetryTimer = undefined;
    if (this.closed) return;
    try {
      const now = Date.now();
      for (const [directory, failure] of this.failedPackages) {
        if (failure.nextAttemptAt === undefined || failure.nextAttemptAt > now) continue;
        // A retry must not traverse a changed or unverified library root.
        if (!this.rootIsValid() || this.closed) return;
        failure.attempts++;
        failure.nextAttemptAt = failure.attempts < PackageDirectoryWatcher.retryDelays.length
          ? now + PackageDirectoryWatcher.retryDelays[failure.attempts] : undefined;
        this.watchPackage(directory);
      }
      if (this.rootIsValid() && !this.closed) this.schedulePackageRetry();
    } catch (error) { if (!this.closed) this.emit("error", error); }
  }

  private refresh(): void {
    if (this.closed || !this.rootIsValid()) return;
    if (!this.watchDirectory(this.root)) throw new Error("Library directory disappeared during watch setup");
    if (!this.rootIsValid() || this.closed) return;
    // Root enumeration errors still use the library-level recovery path.
    const entries = fs.readdirSync(this.root, { withFileTypes: true });
    if (!this.rootIsValid() || this.closed) return;
    const present = new Set<string>([this.root]);
    let limited: string | undefined;
    if (entries.length > MAX_LIBRARY_ENTRIES) {
      limited = `library entry budget (${MAX_LIBRARY_ENTRIES}) exceeded`;
    } else {
      // Select a stable, bounded subset of ordinary directories. Failed
      // candidates still count toward the budget; do not expand the set.
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink() ||
            !/^[A-Za-z][A-Za-z0-9.]*$/.test(entry.name)) continue;
        if (present.size > MAX_PACKAGE_WATCHES_PER_LIBRARY) {
          limited = `package watcher budget (${MAX_PACKAGE_WATCHES_PER_LIBRARY}) reached`;
          break;
        }
        const directory = path.join(this.root, entry.name);
        present.add(directory);
        if (this.closed) return;
        this.watchPackage(directory);
      }
    }
    if (this.closed || !this.rootIsValid()) return;
    if (limited !== this.limitation) {
      this.limitation = limited;
      if (limited) this.onLimited?.(limited);
    }
    for (const directory of this.directories.keys()) {
      if (!present.has(directory)) this.closeDirectory(directory);
    }
    for (const directory of this.failedPackages.keys()) {
      if (!present.has(directory)) this.failedPackages.delete(directory);
    }
    // Five timed attempts per failed package, then only root notifications
    // can retry it. No periodic polling when healthy or after exhaustion.
    this.schedulePackageRetry();
  }
}
