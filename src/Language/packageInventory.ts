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
  private watchers: fs.FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private candidate: string | undefined;
  private initialized = false;
  private disposed = false;
  private revision = 0;
  private readonly dirtyLibraries = new Set<string>();

  constructor(
    private readonly onChange: (change: PackageInventoryChange) => Promise<void>,
    private readonly log: (message: string) => void,
  ) {}

  setLibraryPaths(paths: string[]): void {
    if (this.disposed || JSON.stringify(paths) === JSON.stringify(this.paths)) return;
    this.paths = [...paths];
    this.revision++;
    for (const library of paths) this.dirtyLibraries.add(library);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const library of paths) {
      try {
        const watcher = fs.watch(library, { persistent: false }, () => {
          this.dirtyLibraries.add(library);
          this.schedule(250);
        });
        watcher.on("error", error => {
          watcher.close();
          this.log(`[Libraries] Could not watch ${library}: ${String(error)}`);
        });
        this.watchers.push(watcher);
      } catch (error) {
        this.log(`[Libraries] Could not watch ${library}: ${String(error)}`);
      }
    }
    this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    this.revision++;
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    const revision = this.revision;
    const request = this.scan().catch(error => {
      if (!this.disposed && revision === this.revision) {
        this.log(`[Libraries] Could not refresh package inventory: ${String(error)}`);
      }
    }).finally(() => {
      if (this.pending === request) this.pending = undefined;
      if (!this.timer && this.dirtyLibraries.size) this.schedule(250);
    });
    this.pending = request;
    return request;
  }

  private schedule(delay: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
    this.timer.unref();
  }

  private async scan(): Promise<void> {
    const revision = this.revision;
    const dirty = new Set(this.dirtyLibraries);
    this.dirtyLibraries.clear();
    const libraries: LibraryInventory[] = [];
    for (const library of this.paths) {
      if (this.disposed || revision !== this.revision) return;
      const previous = this.libraries.find(item => item.path === library);
      if (previous && !dirty.has(library)) {
        libraries.push(previous);
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(library, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        entries = [];
      }
      // R moves the old package aside during installation. Do not publish that
      // temporary absence or a partially written replacement.
      if (entries.some(entry => entry.name.startsWith("00LOCK"))) {
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
    if (this.dirtyLibraries.size) {
      for (const library of dirty) this.dirtyLibraries.add(library);
      this.schedule(250);
      return;
    }

    const signature = JSON.stringify(libraries.map(library => [library.path,
      [...library.packages.values()].map(item => [item.name, item.identity])]));
    const previousSignature = JSON.stringify(this.libraries.map(library => [library.path,
      [...library.packages.values()].map(item => [item.name, item.identity])]));
    if (this.initialized && signature === previousSignature) {
      this.candidate = undefined;
      return;
    }
    if (this.initialized && this.candidate !== signature) {
      this.candidate = signature;
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
