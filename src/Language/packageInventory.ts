import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { LibraryPathEntryMonitor, type LibraryPathEntryChange } from "./libraryPathEntryMonitor";

// A library may be on a slow network drive; bound watcher fanout per root.
const MAX_PACKAGE_WATCHES_PER_LIBRARY = 128;
const MAX_LIBRARY_ENTRIES = 4096;

export type PackageInstallation = {
  name: string;
  version: string;
  path: string;
  target: string;
  identity: string;
  // The symlink entry itself, never its destination, supplies this identity.
  linked?: boolean;
};

export type LibraryInventory = {
  path: string;
  packages: Map<string, PackageInstallation>;
  // Keep each locked package's paths until its lock clears.
  deferred?: Map<string, string[]>;
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
  // Selection changes can reuse an installation already observed unchanged.
  // Only content changes require reloading a namespace at the same path.
  changedInstallations?: string[];
  isCurrent: () => boolean;
};

export class PackageInventory {
  private paths: string[] = [];
  private libraries: LibraryInventory[] = [];
  private packages = new Map<string, PackageInstallation>();
  private readonly watchers = new Map<string, PackageDirectoryWatcher>();
  private readonly entryMonitor: LibraryPathEntryMonitor;
  // Resolve explicitly configured aliases once. Watch and scan that root for
  // the lifetime of this configuration; retargeting an alias grants no new root.
  private readonly roots = new Map<string, string>();
  private readonly suspended = new Set<string>();
  private readonly unavailable = new Set<string>();
  private readonly watchedTargets = new Map<string, string>();
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
  ) {
    this.entryMonitor = new LibraryPathEntryMonitor(
      change => this.onLibraryPathEntryChange(change), message => this.log(message));
  }

  private onLibraryPathEntryChange(change: LibraryPathEntryChange): void {
    const library = change.library;
    if (this.disposed || !this.paths.includes(library)) return;
    if (change.kind === "alias") {
      this.log(`[Libraries] Configured library alias changed: ${change.entry}; monitoring remains pinned to ${change.pinnedRoot}`);
      return;
    }
    this.log(`[Libraries] Pinned library path entry changed: ${change.entry} (${change.state}); verifying ${change.pinnedRoot}`);
    let current: string | undefined;
    try { current = this.libraryTarget(library); }
    catch { /* A missing ordinary root will be revisited on its parent entry's next event. */ }
    if (this.suspended.has(library)) {
      this.entryMonitor.remove(library);
      this.dirtyLibraries.add(library);
      this.schedule(250);
      return;
    }
    if (current === this.watchedTargets.get(library)) return;
    this.watchers.get(library)?.close();
    this.watchers.delete(library);
    this.watchedTargets.delete(library);
    if (current !== undefined) this.watchLibrary(library, true);
    this.dirtyLibraries.add(library);
    this.schedule(250);
  }

  setLibraryPaths(paths: string[]): void {
    if (this.disposed || JSON.stringify(paths) === JSON.stringify(this.paths)) return;
    const active = new Set(paths);
    // Preserve existing watchers, cached packages and outstanding dirty scans.
    // Only paths leaving the R search order lose their watches.
    for (const [library, watcher] of this.watchers) {
      if (!active.has(library)) {
        watcher.close();
        this.watchers.delete(library);
        this.watchedTargets.delete(library);
      }
    }
    for (const library of this.roots.keys()) {
      if (!active.has(library)) {
        this.entryMonitor.remove(library);
        this.roots.delete(library);
        this.suspended.delete(library);
        this.unavailable.delete(library);
      }
    }
    for (const library of this.dirtyLibraries) {
      if (!active.has(library)) this.dirtyLibraries.delete(library);
    }
    for (const library of this.unconfirmedLibraries) {
      if (!active.has(library)) this.unconfirmedLibraries.delete(library);
    }
    this.paths = [...paths];
    this.revision++;
    this.candidate = undefined;
    for (const library of paths) {
      const root = this.rootFor(library);
      if (!this.suspended.has(library)) this.entryMonitor.add(library, root);
      if (!this.watchers.has(library)) this.watchLibrary(library);
    }
    this.schedule(0);
  }

  private rootFor(library: string): string {
    if (this.disposed || !this.paths.includes(library)) throw new Error("Library monitoring configuration changed");
    const pinned = this.roots.get(library);
    if (pinned !== undefined) return pinned;
    // Resolve once for this configuration. A missing library can be pinned
    // relative to the nearest existing canonical ancestor.
    let candidate = path.resolve(library);
    let resolved = candidate;
    const absent: string[] = [];
    try {
      for (;;) {
        try {
          resolved = path.join(fs.realpathSync.native(candidate), ...absent);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const parent = path.dirname(candidate);
          if (parent === candidate) throw error;
          absent.unshift(path.basename(candidate));
          candidate = parent;
        }
      }
    } catch (error) {
      // Never retry realpath on an unpinnable or retargeted configured alias.
      // Keep a lexical root only for exclusion reporting until reconfiguration.
      this.suspended.add(library);
      this.log(`[Libraries] Monitoring suspended: ${library} - unable to pin the configured root: ${String(error)}; reconfigure to resume`);
    }
    this.roots.set(library, resolved);
    if (!this.suspended.has(library)) {
      const kind = path.resolve(library) === resolved ? "physical library" : "configured library alias";
      this.log(`[Libraries] Pinned ${kind}: ${library} -> ${resolved}`);
    }
    return resolved;
  }

  private libraryTarget(library: string): string | undefined {
    if (this.suspended.has(library)) return undefined;
    const root = this.rootFor(library);
    if (this.suspended.has(library)) return undefined;
    // A pinned root or one of its ancestors can subsequently become a link.
    // Check from the filesystem root so no check traverses a known link.
    let current = path.parse(root).root;
    let stats: fs.Stats | undefined;
    for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      stats = fs.lstatSync(current);
      if (stats.isSymbolicLink()) {
        this.suspended.add(library);
        this.entryMonitor.remove(library);
        this.watchers.get(library)?.close();
        this.watchers.delete(library);
        this.watchedTargets.delete(library);
        this.dirtyLibraries.add(library);
        this.schedule(250);
        this.log(`[Libraries] Monitoring suspended: ${library} - a link appeared in the pinned library path; reconfigure the library to resume`);
        return undefined;
      }
    }
    stats ??= fs.lstatSync(root);
    if (!stats.isDirectory()) throw Object.assign(new Error("Library is not a directory"), { code: "ENOTDIR" });
    return JSON.stringify([root, stats.dev, stats.ino || stats.birthtimeMs]);
  }

  private watchLibrary(library: string, recovering = false): void {
    if (this.suspended.has(library)) return;
    try {
      const target = this.libraryTarget(library);
      if (target === undefined) return;
      const root = this.rootFor(library);
      const watcher = new PackageDirectoryWatcher(root, () => this.libraryTarget(library) !== undefined, (event, filename) => {
        if (this.disposed || this.watchers.get(library) !== watcher) return;
        let current: string | undefined;
        try { current = this.libraryTarget(library); } catch { /* Recover a removed root below. */ }
        if (current !== this.watchedTargets.get(library)) {
          watcher.close();
          this.watchers.delete(library);
          this.watchedTargets.delete(library);
          this.watchLibrary(library, true);
          this.dirtyLibraries.add(library);
        } else {
          const name = filename ? String(filename) : "";
          // Directory notifications trigger a metadata identity check. Delayed
          // or duplicate events alone do not establish an installation change.
          if (event === "change" || !name || name === path.basename(root) || name.includes(path.sep)) {
            this.unconfirmedLibraries.add(library);
          } else {
            this.dirtyLibraries.add(library);
          }
        }
        this.schedule(250);
      }, (reason) => this.log(`[Libraries] Limited package monitoring: ${library} - ${reason}; root events remain active`));
      watcher.on("error", error => {
        if (this.disposed || this.watchers.get(library) !== watcher) return;
        this.watchers.delete(library);
        this.watchedTargets.delete(library);
        watcher.close();
        this.log(`[Libraries] Could not watch ${library}: ${String(error)}`);
        this.scheduleRetry();
      });
      this.watchers.set(library, watcher);
      this.watchedTargets.set(library, target);
      this.dirtyLibraries.add(library);
      this.log(`[Libraries] ${recovering ? "Watcher restored" : "Watching folder"}: ${library}`);
    } catch (error) {
      this.log(`[Libraries] Could not watch ${library}: ${String(error)}`);
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "ENOENT" || code === "ENOTDIR") && this.entryMonitor.hasPhysicalEntryWatch(library)) {
        this.log(`[Libraries] Waiting for pinned library recreation event: ${this.rootFor(library)}`);
      } else {
        this.scheduleRetry();
      }
    }
  }

  private async installationLocks(library: string, entries: fs.Dirent[]): Promise<Set<string>> {
    const locked = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const named = /^00LOCK-([A-Za-z][A-Za-z0-9.]*)$/.exec(entry.name);
      if (named) locked.add(named[1]);
      else if (entry.name === "00LOCK") {
        locked.add("*");
        // Inspect ordinary backup directories for packages absent at discovery.
        // Check each component before descending into the next one.
        let folder = path.join(library, "00LOCK");
        for (let depth = 0; depth < 2; depth++) {
          try {
            if (!(await fs.promises.lstat(folder)).isDirectory()) break;
            for (const item of await fs.promises.readdir(folder, { withFileTypes: true })) {
              if (item.isDirectory() && /^[A-Za-z][A-Za-z0-9.]*$/.test(item.name)) locked.add(item.name);
            }
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
            break;
          }
          folder = path.join(folder, "00new");
        }
      }
    }
    return locked;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryDelay = 1000;
  }

  private scheduleRetry(cancelScheduledScan = false): void {
    if (this.disposed || this.retryTimer) return;
    // Keep already queued events from healthy libraries when a different
    // watcher fails. Only a failed publication should defer its next retry.
    if (cancelScheduledScan) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.log(`[Libraries] Recovery retry scheduled in ${this.retryDelay / 1000}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.log("[Libraries] Recovery retry started");
      for (const library of this.paths) {
        if (!this.watchers.has(library)) this.watchLibrary(library, true);
      }
      void this.refresh();
    }, this.retryDelay);
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
    this.watchedTargets.clear();
    this.unconfirmedLibraries.clear();
    this.entryMonitor.dispose();
    this.roots.clear();
    this.suspended.clear();
    this.unavailable.clear();
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    const revision = this.revision;
    const dirty = new Set(this.dirtyLibraries);
    const unconfirmed = new Set(this.unconfirmedLibraries);
    this.dirtyLibraries.clear();
    this.unconfirmedLibraries.clear();
    const request = this.scan(revision, dirty, unconfirmed).then(() => {
      if (!this.disposed && revision === this.revision &&
          this.paths.every(library => this.watchers.has(library) || this.suspended.has(library)) &&
          !this.dirtyLibraries.size && !this.unconfirmedLibraries.size && !this.unavailable.size) {
        if (this.retryDelay > 1000) this.log("[Libraries] Recovery complete; retries stopped");
        this.clearRetry();
      }
    }).catch(error => {
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
      } else if (!this.timer && !this.retryTimer &&
          (this.dirtyLibraries.size || this.unconfirmedLibraries.size)) {
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

  private async hasInstalledPackagesChanged(library: string, previous: LibraryInventory): Promise<boolean> {
    try {
      if (this.libraryTarget(library) === undefined) return true;
      const root = this.rootFor(library);
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      if (entries.some(entry => entry.isDirectory() && /^00LOCK(?:-[A-Za-z][A-Za-z0-9.]*)?$/.test(entry.name))) return true;
      if (previous.deferred?.size) return true;
      const names = entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) &&
        /^[A-Za-z][A-Za-z0-9.]*$/.test(entry.name)).map(entry => entry.name);
      if (names.length !== previous.packages.size + (previous.unmonitored?.size ?? 0)) return true;
      // lstat observes a linked package entry without reading its destination.
      // A link replacement changes its own identity and invalidates metadata.
      for (const name of names) {
        const installed = previous.packages.get(name);
        const current = await this.inspectPackage(library, name);
        if (previous.unmonitored?.has(name)) {
          if (current) return true; // An unsafe installation became ordinary.
        } else if (!installed || !current || current.identity !== installed.identity) {
          return true;
        }
      }
      return false;
    } catch {
      // A missing or transient directory must take the normal recovery path.
      return true;
    }
  }

  private async scan(revision: number, dirty: Set<string>,
    unconfirmed: Set<string> = new Set()): Promise<void> {
    const libraries: LibraryInventory[] = [];
    for (const library of this.paths) {
      if (this.disposed || revision !== this.revision) return;
      const previous = this.libraries.find(item => item.path === library);
      if (previous && !dirty.has(library) && !previous.unavailable) {
        if (!unconfirmed.has(library) ||
            !(await this.hasInstalledPackagesChanged(library, previous))) {
          libraries.push(previous);
          continue;
        }
        if (this.disposed || revision !== this.revision) return;
        dirty.add(library);
      }
      // A pinned root can be temporarily inaccessible on a network share.
      // Do not turn read failures into package removals or force LSP restarts.
      const retained = (state: "suspended" | "unavailable"): LibraryInventory => ({
        path: library,
        packages: new Map(previous?.packages),
        deferred: new Map(previous?.deferred),
        unmonitored: new Set(previous?.unmonitored),
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
        entries = await fs.promises.readdir(this.rootFor(library), { withFileTypes: true });
        if (this.disposed || revision !== this.revision) return;
        if (entries.length > MAX_LIBRARY_ENTRIES) {
          throw Object.assign(new Error(`library entry budget exceeded (${MAX_LIBRARY_ENTRIES})`),
            { code: "E2BIG" });
        }
      if (this.disposed || revision !== this.revision) return;
      const locked = await this.installationLocks(this.rootFor(library), entries);
      // The package entry may be a symlink (renv/uvr). Record its lstat
      // identity, but never traverse, read or watch its target from here.
      const unmonitored = new Set<string>();
      if (locked.size) this.log(`[Libraries] Scan deferred: installation lock present - ${library}`);
      const deferred = new Map<string, string[]>();
      const libraryRoot = this.rootFor(library);
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
      ])].sort();
      const packages = new Map<string, PackageInstallation>();
      for (let offset = 0; offset < names.length; offset += 8) {
        if (this.disposed || revision !== this.revision) return;
        const batch = await Promise.all(names.slice(offset, offset + 8).map(async name => {
          const old = previous?.packages.get(name);
          if (unmonitored.has(name)) return undefined;
          if (locked.has("*") || locked.has(name)) return defer(name);
          const item = await this.readPackage(library, name, old);
          if (item === null) unmonitored.add(name);
          return item;
        }));
        for (const item of batch) if (item) packages.set(item.name, item);
      }
      // Re-validate the pinned identity after asynchronous reads. An
      // intervening replacement must not publish observations from a new root.
      if (this.libraryTarget(library) !== originalTarget) {
        this.dirtyLibraries.add(library);
        this.schedule(250);
        libraries.push(retained("unavailable"));
        continue;
      }
      if (this.unavailable.delete(library)) {
        this.log(`[Libraries] Monitoring restored: ${library}`);
      }
      libraries.push({ path: library, packages, unmonitored,
        deferred: new Map([...deferred].sort(([a], [b]) => a.localeCompare(b))) });
      } catch (error) {
        if (this.disposed || revision !== this.revision) return;
        if ((error as NodeJS.ErrnoException).code === "E2BIG") {
          // Refuse a too-broad root instead of repeatedly enumerating an
          // entire network share or home directory in recovery retries.
          this.suspended.add(library);
          this.unavailable.delete(library);
          this.watchers.get(library)?.close();
          this.watchers.delete(library);
          this.watchedTargets.delete(library);
          this.log(`[Libraries] Monitoring suspended: ${library} - library exceeds ${MAX_LIBRARY_ENTRIES} entries; narrow the configured root and reconfigure`);
          libraries.push(retained("suspended"));
          continue;
        }
        if (this.suspended.has(library)) {
          libraries.push(retained("suspended"));
          continue;
        }
        if (!this.unavailable.has(library)) {
          const reason = error instanceof Error ? error.message : String(error);
          this.log(`[Libraries] Monitoring temporarily unavailable: ${library} - ${reason}; keeping last verified state`);
        }
        this.unavailable.add(library);
        libraries.push(retained("unavailable"));
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== "ENOENT" && code !== "ENOTDIR") ||
            !this.entryMonitor.hasPhysicalEntryWatch(library)) this.scheduleRetry();
      }
    }
    if (this.disposed || revision !== this.revision) return;
    if (this.dirtyLibraries.size || this.unconfirmedLibraries.size) {
      for (const library of dirty) this.dirtyLibraries.add(library);
      for (const library of unconfirmed) this.unconfirmedLibraries.add(library);
      this.schedule(250);
      return;
    }

    // Lock transitions also need publication: a namespace deferred during
    // discovery may disappear without ever entering the package inventory.
    const signatureOf = (items: LibraryInventory[]) => JSON.stringify(items.map(library => [library.path,
      [...library.packages.values()].map(item => [item.name, item.identity]), [...(library.deferred ?? [])], [...(library.unmonitored ?? [])].sort(), library.suspended ?? false, library.unavailable ?? false]));
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
      for (const name of library.unmonitored ?? []) if (!packages.has(name)) unmonitored.add(name);
      for (const [name, item] of library.packages) {
        if (!packages.has(name) && !unmonitored.has(name)) packages.set(name, item);
      }
    }
    const changed = [...new Set([...this.packages.keys(), ...packages.keys()])].filter(name =>
      !unmonitored.has(name) && this.packages.get(name)?.identity !== packages.get(name)?.identity);
    const changedInstallations = changed.filter(name => {
      const selected = packages.get(name);
      if (!selected) return true;
      const previous = this.libraries.map(library => library.packages.get(name))
        .find(item => item?.path === selected.path);
      return previous?.identity !== selected.identity;
    });
    const unmonitoredRoots = libraries.filter(library => library.suspended || library.unavailable)
      .flatMap(library => [library.path, this.rootFor(library.path)]);
    await this.onChange({ libraries, packages, unmonitored: [...unmonitored], unmonitoredRoots, changed: this.initialized ? changed : [],
      changedInstallations: this.initialized ? changedInstallations : [],
      isCurrent: () => !this.disposed && revision === this.revision });
    if (this.disposed || revision !== this.revision) return;

    if (this.initialized) {
      for (const library of this.libraries) {
        const next = libraries.find(item => item.path === library.path);
        for (const [name, item] of library.packages) {
          if (!next?.packages.has(name)) {
            if (next?.unmonitored?.has(name)) {
              this.log(`[Packages] Monitoring skipped: ${name} - installation contains links`);
              continue;
            }
            this.log(`[Packages] Removed copy: ${name} ${item.version} - ${item.path}`);
            const active = packages.get(name);
            if (active && active.identity === this.packages.get(name)?.identity) {
              this.log(`[Packages] Active copy unchanged: ${name} ${active.version} - ${active.path}`);
            }
          }
        }
      }
      for (const library of libraries) {
        const previous = this.libraries.find(item => item.path === library.path)?.packages;
        for (const [name, item] of library.packages) {
          const old = previous?.get(name);
          if (!old) this.log(`[Packages] Added: ${name} ${item.version} - ${item.path}`);
          else if (old.identity !== item.identity) {
            this.log(`[Packages] Updated: ${name} ${old.version} -> ${item.version} - ${item.path}`);
          }
        }
      }
      for (const [name, old] of this.packages) {
        if (unmonitored.has(name)) continue;
        const next = packages.get(name);
        if (!next) this.log(`[Packages] Removed: ${name} - no copies remain in active libraries`);
        else if (next.path !== old.path) {
          const retained = libraries.some(library => library.packages.get(name)?.path === old.path);
          this.log(`[Packages] ${retained ? "Selected copy changed" : "Using remaining copy"}: ${name} ${next.version} - ${next.path}`);
        }
      }
      if (!changed.length) this.log("[Completion] Active package copies unchanged; language server retained");
    }
    for (const [name, item] of packages) {
      const old = this.packages.get(name);
      if (item.linked && (!old?.linked || old.identity !== item.identity)) {
        this.log(`[Packages] Linked installation observed: ${name} - ${item.path} (external target not watched)`);
      }
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

  private async inspectPackage(library: string, name: string): Promise<{ directory: string; identity: string; linked?: boolean } | null | undefined> {
    const directory = path.join(this.rootFor(library), name);
    try {
      const stat = await fs.promises.lstat(directory);
      if (stat.isSymbolicLink()) {
        // Only lstat the entry. Never call realpath/stat/readlink on its
        // destination, and never subscribe to that destination.
        return { directory, linked: true, identity: JSON.stringify([directory, "linked",
          stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]) };
      }
      if (!stat.isDirectory()) return undefined;
      const meta = await fs.promises.lstat(path.join(directory, "Meta"));
      if (meta.isSymbolicLink()) return null;
      if (!meta.isDirectory()) return undefined;
      const metadata = await fs.promises.lstat(path.join(directory, "Meta", "package.rds"));
      const description = await fs.promises.lstat(path.join(directory, "DESCRIPTION"));
      if (metadata.isSymbolicLink() || description.isSymbolicLink()) return null;
      if (!metadata.isFile() || !description.isFile()) return undefined;
      const identity = JSON.stringify([directory, ...[stat, metadata, description]
        .map(value => [value.dev, value.ino, value.mtimeMs, value.ctimeMs, value.size])]);
      return { directory, identity };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP") return null;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  }

  private async readPackage(library: string, name: string, previous?: PackageInstallation): Promise<PackageInstallation | null | undefined> {
    const current = await this.inspectPackage(library, name);
    if (!current) return current;
    const { directory, identity } = current;
    if (previous?.identity === identity) return previous;
    if (current.linked) {
      // A link entry is tracked for lifecycle invalidation, not presented as
      // a verified package. R/languageserver resolves it normally on demand.
      return { name, version: "(linked)", path: path.join(library, name),
        target: directory, identity, linked: true };
    }
    try {
      const descriptionPath = path.join(directory, "DESCRIPTION");
      // Protect the final component if it changes between lstat and open.
      const file = await fs.promises.open(descriptionPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      let description: string;
      try {
        if (!(await file.stat()).isFile()) return undefined;
        description = await file.readFile("utf8");
      } finally { await file.close(); }
      const packageName = /^Package:\s*(\S+)/m.exec(description)?.[1];
      const version = /^Version:\s*(\S+)/m.exec(description)?.[1];
      if (packageName !== name || !version) return undefined;
      return { name, version, path: path.join(library, name), target: directory, identity };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP") return null;
      // An installation can disappear while its directory is being scanned.
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  }
}

/** Watch the library and its immediate ordinary package directories.
 * Each OS watch is non-recursive; package contents and links are not traversed. */
class PackageDirectoryWatcher extends EventEmitter {
  private readonly directories = new Map<string, { watcher: fs.FSWatcher; identity: string }>();
  private timer: NodeJS.Timeout | undefined;
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
    for (const { watcher } of this.directories.values()) watcher.close();
    this.directories.clear();
  }

  private refresh(): void {
    if (this.closed || !this.rootIsValid()) return;
    const present = new Set<string>();
    let packageWatchCount = 0;
    let limited: string | undefined;
    const visit = (directory: string, library = false) => {
      if (this.closed) return;
      let stat: fs.Stats;
      try { stat = fs.lstatSync(directory); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return;
        throw error;
      }
      if (!stat.isDirectory()) return;
      present.add(directory);
      const identity = JSON.stringify([stat.dev, stat.ino || stat.birthtimeMs]);
      const previous = this.directories.get(directory);
      if (previous?.identity !== identity) {
        previous?.watcher.close();
        const watcher = fs.watch(directory, { persistent: false, recursive: false }, (event, filename) => {
          if (this.closed || this.directories.get(directory)?.watcher !== watcher) return;
          const file = filename ? path.join(directory, String(filename)) : directory;
          const relative = path.relative(this.root, file);
          if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return;
          if (relative.split(path.sep).length > 2) return;
          this.emit("change", event, relative);
          // Package-directory events cannot change the set of immediate
          // package watches. Only root directory events re-enumerate entries.
          if (directory !== this.root || this.closed || this.timer) return;
          // Reconcile package directory watches after bursts of install events.
          // This timer is scheduled only by a filesystem notification.
          this.timer = setTimeout(() => {
            this.timer = undefined;
            try { this.refresh(); } catch (error) { this.emit("error", error); }
          }, 50);
          this.timer.unref();
        });
        // Reject a replacement between lstat and fs.watch. Node's path-based
        // API cannot remove the race entirely, but must not retain a watch on
        // a new link or directory identity.
        let confirmed: fs.Stats;
        try { confirmed = fs.lstatSync(directory); }
        catch (error) { watcher.close(); throw error; }
        if (!confirmed.isDirectory() ||
            JSON.stringify([confirmed.dev, confirmed.ino || confirmed.birthtimeMs]) !== identity) {
          watcher.close();
          throw new Error("Watched directory identity changed during setup");
        }
        watcher.on("error", error => {
          if (!this.closed && this.directories.get(directory)?.watcher === watcher) this.emit("error", error);
        });
        this.directories.set(directory, { watcher, identity });
      }
      if (!library) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return;
        throw error;
      }
      if (entries.length > MAX_LIBRARY_ENTRIES) {
        limited = `library entry budget (${MAX_LIBRARY_ENTRIES}) exceeded`;
        return;
      }
      // Select a stable, bounded subset of ordinary directories. Sorting
      // prevents watcher churn when directory enumeration order varies.
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink() ||
            !/^[A-Za-z][A-Za-z0-9.]*$/.test(entry.name)) continue;
        if (packageWatchCount >= MAX_PACKAGE_WATCHES_PER_LIBRARY) {
          limited = `package watcher budget (${MAX_PACKAGE_WATCHES_PER_LIBRARY}) reached`;
          break;
        }
        packageWatchCount++;
        visit(path.join(directory, entry.name));
      }
    };
    visit(this.root, true);
    if (limited !== this.limitation) {
      this.limitation = limited;
      if (limited) this.onLimited?.(limited);
    }
    for (const [directory, { watcher }] of this.directories) {
      if (!present.has(directory)) { watcher.close(); this.directories.delete(directory); }
    }
  }
}
