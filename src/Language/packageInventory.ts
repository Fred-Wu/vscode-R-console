import * as fs from "fs";
import * as path from "path";

export type PackageInstallation = {
  name: string;
  version: string;
  path: string;
  identity: string;
};

export type LibraryInventory = { path: string; packages: Map<string, PackageInstallation> };
export type PackageInventoryChange = {
  libraries: LibraryInventory[];
  packages: Map<string, PackageInstallation>;
  changed: string[];
  isCurrent: () => boolean;
};

export class PackageInventory {
  private paths: string[] = [];
  private libraries: LibraryInventory[] = [];
  private packages = new Map<string, PackageInstallation>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  // The child watcher follows the old inode after the library is replaced.
  // Watch its parent as well so an atomic directory/symlink switch re-arms it.
  private readonly parentWatchers = new Map<string, fs.FSWatcher>();
  // fs.watch follows the directory inode (or a symlink's target), not its path.
  private readonly watchedTargets = new Map<string, string | undefined>();
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
  ) {}

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
    for (const [library, watcher] of this.parentWatchers) {
      if (!active.has(library)) {
        watcher.close();
        this.parentWatchers.delete(library);
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
      if (!this.parentWatchers.has(library)) this.watchParent(library);
      if (!this.watchers.has(library)) this.watchLibrary(library);
    }
    this.schedule(0);
  }

  private libraryTarget(library: string): string | undefined {
    try {
      const stats = fs.statSync(library);
      // A real path distinguishes symlink / junction retargeting. Device,
      // inode, and creation time distinguish replacement at the same path,
      // including on Windows volumes where inode may not be available.
      return JSON.stringify([
        fs.realpathSync.native(library), stats.dev,
        stats.ino || stats.birthtimeMs,
      ]);
    } catch {
      // A temporarily missing target must be re-armed by the parent watcher.
      return undefined;
    }
  }

  private watchParent(library: string): void {
    if (this.disposed || this.parentWatchers.has(library)) return;
    try {
      const basename = path.basename(library);
      const watcher = fs.watch(path.dirname(library), { persistent: false }, (_event, filename) => {
        if (this.disposed || this.parentWatchers.get(library) !== watcher) return;
        if (filename && String(filename).toLowerCase() !== basename.toLowerCase()) return;
        // macOS can omit filenames for unrelated parent changes. Only re-arm
        // if the watched directory was actually removed or replaced.
        const previous = this.watchers.get(library);
        const target = this.libraryTarget(library);
        if (previous && target !== undefined &&
            target === this.watchedTargets.get(library)) return;
        if (previous) previous.close();
        this.watchers.delete(library);
        this.watchedTargets.delete(library);
        this.watchLibrary(library, true);
        this.dirtyLibraries.add(library);
        this.schedule(250);
      });
      watcher.on("error", error => {
        if (this.disposed || this.parentWatchers.get(library) !== watcher) return;
        this.parentWatchers.delete(library);
        watcher.close();
        this.log(`[Libraries] Could not watch parent of ${library}: ${String(error)}`);
        this.scheduleRetry();
      });
      this.parentWatchers.set(library, watcher);
    } catch (error) {
      this.log(`[Libraries] Could not watch parent of ${library}: ${String(error)}`);
      this.scheduleRetry();
    }
  }

  private watchLibrary(library: string, recovering = false): void {
    try {
      const target = this.libraryTarget(library);
      const watcher = fs.watch(library, { persistent: false }, (event, filename) => {
        if (this.disposed || this.watchers.get(library) !== watcher) return;
        const name = filename ? String(filename) : "";
        // Parent-unknown events and directory metadata touches need a cheap
        // content check first. R can update a library directory's timestamp
        // without changing any installed packages.
        if (event === "change" || !name || name === path.basename(library)) {
          this.unconfirmedLibraries.add(library);
        } else {
          this.dirtyLibraries.add(library);
        }
        this.schedule(250);
      });
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
      this.scheduleRetry();
    }
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
        if (!this.parentWatchers.has(library)) this.watchParent(library);
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
    for (const watcher of this.parentWatchers.values()) watcher.close();
    this.parentWatchers.clear();
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
          this.watchers.size === this.paths.length &&
          this.parentWatchers.size === this.paths.length &&
          !this.dirtyLibraries.size && !this.unconfirmedLibraries.size) {
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
      const entries = await fs.promises.readdir(library, { withFileTypes: true });
      if (entries.some(entry => entry.name.startsWith("00LOCK"))) return true;
      const names = entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) &&
        /^[A-Za-z][A-Za-z0-9.]*$/.test(entry.name)).map(entry => entry.name);
      if (names.length !== previous.packages.size) return true;
      // Same-name installations may be replaced, including via symlink targets.
      // Compare the identities already used by readPackage(), without reading
      // DESCRIPTION or any package metadata on unchanged events.
      for (const name of names) {
        const installed = previous.packages.get(name);
        if (!installed) return true;
        const directory = path.join(library, name);
        const target = await fs.promises.realpath(directory);
        const stat = await fs.promises.stat(directory);
        const identity = JSON.stringify([target, stat.mtimeMs, stat.ctimeMs, stat.ino]);
        if (identity !== installed.identity) return true;
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
      if (previous && !dirty.has(library)) {
        if (!unconfirmed.has(library) ||
            !(await this.hasInstalledPackagesChanged(library, previous))) {
          libraries.push(previous);
          continue;
        }
        if (this.disposed || revision !== this.revision) return;
        dirty.add(library);
      }
      let entries: fs.Dirent[];
      try {
        this.log(`[Libraries] Scanning folder: ${library}`);
        entries = await fs.promises.readdir(library, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        entries = [];
      }
      // R moves the old package aside during installation. Do not publish that
      // temporary absence or a partially written replacement.
      if (entries.some(entry => entry.name.startsWith("00LOCK"))) {
        this.log(`[Libraries] Scan deferred: installation lock present - ${library}`);
        libraries.push(previous ?? { path: library, packages: new Map() });
        continue;
      }
      const names = entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) &&
        /^[A-Za-z][A-Za-z0-9.]*$/.test(entry.name)).map(entry => entry.name).sort();
      const packages = new Map<string, PackageInstallation>();
      for (let offset = 0; offset < names.length; offset += 8) {
        if (this.disposed || revision !== this.revision) return;
        const batch = await Promise.all(names.slice(offset, offset + 8).map(name =>
          this.readPackage(library, name, previous?.packages.get(name))));
        for (const item of batch) if (item) packages.set(item.name, item);
      }
      libraries.push({ path: library, packages });
    }
    if (this.disposed || revision !== this.revision) return;
    if (this.dirtyLibraries.size || this.unconfirmedLibraries.size) {
      for (const library of dirty) this.dirtyLibraries.add(library);
      for (const library of unconfirmed) this.unconfirmedLibraries.add(library);
      this.schedule(250);
      return;
    }

    const signature = JSON.stringify(libraries.map(library => [library.path,
      [...library.packages.values()].map(item => [item.name, item.identity])]));
    const previousSignature = JSON.stringify(this.libraries.map(library => [library.path,
      [...library.packages.values()].map(item => [item.name, item.identity])]));
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
    for (const library of libraries) {
      for (const [name, item] of library.packages) if (!packages.has(name)) packages.set(name, item);
    }
    const changed = [...new Set([...this.packages.keys(), ...packages.keys()])].filter(name =>
      this.packages.get(name)?.identity !== packages.get(name)?.identity);
    await this.onChange({ libraries, packages, changed: this.initialized ? changed : [],
      isCurrent: () => !this.disposed && revision === this.revision });
    if (this.disposed || revision !== this.revision) return;

    if (this.initialized) {
      for (const library of this.libraries) {
        const next = libraries.find(item => item.path === library.path)?.packages;
        for (const [name, item] of library.packages) {
          if (!next?.has(name)) {
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
        const next = packages.get(name);
        if (!next) this.log(`[Packages] Removed: ${name} - no copies remain in active libraries`);
        else if (next.path !== old.path) {
          const retained = libraries.some(library => library.packages.get(name)?.path === old.path);
          this.log(`[Packages] ${retained ? "Selected copy changed" : "Using remaining copy"}: ${name} ${next.version} - ${next.path}`);
        }
      }
      if (!changed.length) this.log("[Completion] Active package copies unchanged; language server retained");
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

  private async readPackage(library: string, name: string, previous?: PackageInstallation): Promise<PackageInstallation | undefined> {
    const directory = path.join(library, name);
    try {
      const target = await fs.promises.realpath(directory);
      const stat = await fs.promises.stat(directory);
      const identity = JSON.stringify([target, stat.mtimeMs, stat.ctimeMs, stat.ino]);
      if (previous?.identity === identity) return previous;
      await fs.promises.access(path.join(directory, "Meta", "package.rds"));
      const description = await fs.promises.readFile(path.join(directory, "DESCRIPTION"), "utf8");
      const packageName = /^Package:\s*(\S+)/m.exec(description)?.[1];
      const version = /^Version:\s*(\S+)/m.exec(description)?.[1];
      if (packageName !== name || !version) return undefined;
      return { name, version, path: directory, identity };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
}
