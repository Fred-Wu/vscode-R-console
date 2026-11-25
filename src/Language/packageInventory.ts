import * as fs from "fs";
import * as path from "path";

export type PackageInstallation = {
  name: string;
  version: string;
  path: string;
  target: string;
  identity: string;
};

export type LibraryInventory = {
  path: string;
  packages: Map<string, PackageInstallation>;
  // Keep each locked package's logical and resolved paths until its lock clears.
  deferred?: Map<string, string[]>;
};
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
  // Poll only linked installations and their target parents. stat follows the
  // link through deletion/recreation and works when its cache is outside the
  // library's filesystem watcher. Parent changes include installation locks.
  private readonly linkedWatches = new Map<string, {
    libraries: Set<string>; listener: (current: fs.Stats, previous: fs.Stats) => void;
  }>();
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
    for (const [file, watch] of this.linkedWatches) {
      for (const library of watch.libraries) if (!active.has(library)) watch.libraries.delete(library);
      if (!watch.libraries.size) {
        fs.unwatchFile(file, watch.listener);
        this.linkedWatches.delete(file);
      }
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

  private async resolvePackageLink(link: string, files: Set<string>): Promise<string> {
    let target = link;
    const visited = new Set<string>();
    for (let hops = 0; hops < 40; hops++) {
      // Resolve parent aliases independently of the package's existence. Walk
      // each package link so a missing final target retains its lock location.
      const parent = await fs.promises.realpath(path.dirname(target)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return path.dirname(target);
      });
      target = path.join(parent, path.basename(target));
      files.add(parent);
      if (visited.has(target)) break;
      visited.add(target);
      let destination: string;
      try {
        destination = await fs.promises.readlink(target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EINVAL") return target;
        throw error;
      }
      // Preserve '..' until realpath resolves any preceding directory aliases.
      target = path.isAbsolute(destination) ? destination : parent + path.sep + destination;
      files.add(path.dirname(target));
    }
    throw Object.assign(new Error(`Too many symbolic links resolving ${link}`), { code: "ELOOP" });
  }

  private async watchLinkedPackages(library: string, entries: fs.Dirent[]): Promise<Map<string, string>> {
    const targets = new Map<string, string>();
    const files = new Set<string>();
    for (const entry of entries) {
      if (!entry.isSymbolicLink() || !/^[A-Za-z][A-Za-z0-9.]*$/.test(entry.name)) continue;
      const link = path.join(library, entry.name);
      try {
        const target = await this.resolvePackageLink(link, files);
        targets.set(entry.name, target);
        files.add(link);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" &&
            (error as NodeJS.ErrnoException).code !== "EINVAL") throw error;
      }
    }
    if (this.disposed || !this.paths.includes(library)) return targets;
    for (const [file, watch] of this.linkedWatches) {
      if (!files.has(file)) watch.libraries.delete(library);
      if (!watch.libraries.size) {
        fs.unwatchFile(file, watch.listener);
        this.linkedWatches.delete(file);
      }
    }
    for (const file of files) {
      const existing = this.linkedWatches.get(file);
      if (existing) { existing.libraries.add(library); continue; }
      const libraries = new Set([library]);
      const listener = (current: fs.Stats, previous: fs.Stats) => {
        if (this.disposed || this.linkedWatches.get(file)?.listener !== listener) return;
        if (current.dev === previous.dev && current.ino === previous.ino &&
            current.mtimeMs === previous.mtimeMs && current.ctimeMs === previous.ctimeMs &&
            current.size === previous.size && current.nlink === previous.nlink) return;
        for (const owner of libraries) this.dirtyLibraries.add(owner);
        this.schedule(250);
      };
      fs.watchFile(file, { persistent: false, interval: 1000 }, listener);
      this.linkedWatches.set(file, { libraries, listener });
    }
    return targets;
  }

  private async installationLocks(library: string, entries?: fs.Dirent[]): Promise<Set<string>> {
    const locked = new Set<string>();
    const read = async (directory: string) => {
      try { return await fs.promises.readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    };
    for (const entry of entries ?? await read(library)) {
      if (!entry.isDirectory()) continue;
      const named = /^00LOCK-([A-Za-z][A-Za-z0-9.]*)$/.exec(entry.name);
      if (named) locked.add(named[1]);
      else if (entry.name === "00LOCK") {
        // R also uses a whole-library lock for binary and multi-package
        // installs. Its scope includes new packages with no backup yet.
        locked.add("*");
        for (const folder of [path.join(library, "00LOCK"), path.join(library, "00LOCK", "00new")]) {
          for (const item of await read(folder)) {
            if ((item.isDirectory() || item.isSymbolicLink()) && /^[A-Za-z][A-Za-z0-9.]*$/.test(item.name)) {
              locked.add(item.name);
            }
          }
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
    for (const [file, watch] of this.linkedWatches) fs.unwatchFile(file, watch.listener);
    this.linkedWatches.clear();
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
      if (previous.deferred?.size) return true;
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
    const lockRequests = new Map<string, Promise<Set<string>>>();
    const locksFor = (library: string, entries?: fs.Dirent[]) => {
      let pending = lockRequests.get(library);
      if (!pending) {
        pending = this.installationLocks(library, entries);
        lockRequests.set(library, pending);
      }
      return pending;
    };
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
      const targets = await this.watchLinkedPackages(library, entries);
      if (this.disposed || revision !== this.revision) return;
      const locked = await locksFor(library, entries);
      if (locked.size) this.log(`[Libraries] Scan deferred: installation lock present - ${library}`);
      const deferred = new Map<string, string[]>();
      const defer = (name: string, target?: string) => {
        const old = previous?.packages.get(name);
        const paths = new Set(previous?.deferred?.get(name));
        paths.add(path.join(library, name));
        if (target) paths.add(target);
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
          if (locked.has("*") || locked.has(name)) return defer(name, targets.get(name));
          const target = targets.get(name);
          if (target) {
            const targetLocks = await locksFor(path.dirname(target));
            if (targetLocks.has("*") || targetLocks.has(path.basename(target))) return defer(name, target);
          }
          return this.readPackage(library, name, old);
        }));
        for (const item of batch) if (item) packages.set(item.name, item);
      }
      libraries.push({ path: library, packages,
        deferred: new Map([...deferred].sort(([a], [b]) => a.localeCompare(b))) });
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
      [...library.packages.values()].map(item => [item.name, item.identity]), [...(library.deferred ?? [])]]));
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
      return { name, version, path: directory, target, identity };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
}
