import * as fs from "fs";
import * as path from "path";

/** A path-entry event is evidence of a rename/replacement, not permission to
 * resolve or adopt a new physical library destination. */
export type LibraryPathEntryChange = {
  library: string;
  pinnedRoot: string;
  entry: string;
  kind: "physical" | "alias";
  state: "directory" | "link" | "missing" | "other";
};

type Entry = LibraryPathEntryChange & { parent: string; name: string; key: string };
type ParentWatch = { watcher: fs.FSWatcher; entries: Map<string, Entry> };

const MAX_PATH_COMPONENTS = 48;

/**
 * Watches *directory entries* leading to pinned roots, not subtree contents.
 * Shared ancestor subscriptions do not follow links or dynamically discover
 * package-cache destinations. An absent ancestor can be added after an event
 * from its existing parent. This module never polls the filesystem.
 */
export class LibraryPathEntryMonitor {
  private readonly roots = new Map<string, string>();
  private readonly watches = new Map<string, ParentWatch>();
  private readonly identities = new Map<string, string>();
  private readonly unavailable = new Set<string>();
  private disposed = false;

  constructor(
    private readonly onChange: (change: LibraryPathEntryChange) => void,
    private readonly log: (message: string) => void,
    private readonly filesystem: Pick<typeof fs, "lstatSync" | "watch"> = fs,
  ) {}

  add(library: string, pinnedRoot: string): void {
    if (this.disposed) return;
    if (this.roots.get(library) === pinnedRoot) return;
    this.roots.set(library, pinnedRoot);
    this.reconcile();
  }

  hasPhysicalEntryWatch(library: string): boolean {
    for (const watch of this.watches.values()) {
      for (const entry of watch.entries.values()) {
        if (entry.library === library && entry.kind === "physical") return true;
      }
    }
    return false;
  }

  remove(library: string): void {
    if (!this.roots.delete(library)) return;
    for (const key of this.identities.keys()) {
      if (key.startsWith(JSON.stringify(library) + "|")) this.identities.delete(key);
    }
    this.reconcile();
  }

  dispose(): void {
    this.disposed = true;
    this.roots.clear();
    this.identities.clear();
    this.unavailable.clear();
    for (const item of this.watches.values()) item.watcher.close();
    this.watches.clear();
  }

  private identity(entry: string): { value: string; state: LibraryPathEntryChange["state"] } {
    try {
      const s = this.filesystem.lstatSync(entry);
      const state = s.isSymbolicLink() ? "link" : s.isDirectory() ? "directory" : "other";
      // Directory mtime/ctime changes during ordinary package installation.
      // Only directory-entry identity changes should trigger root validation.
      return { state, value: JSON.stringify([state, s.dev, s.ino || 0, s.birthtimeMs]) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", value: "missing" };
      // No newly discovered directory is trusted when an entry is unreadable.
      return { state: "other", value: `unavailable:${String(code ?? error)}` };
    }
  }

  private gather(library: string, pinnedRoot: string, kind: "physical" | "alias", wanted: Map<string, Map<string, Entry>>): void {
    const target = path.resolve(kind === "physical" ? pinnedRoot : library);
    const parsed = path.parse(target);
    let parent = parsed.root;
    const parts = target.slice(parent.length).split(path.sep).filter(Boolean);
    if (parts.length > MAX_PATH_COMPONENTS) {
      this.log(`[Libraries] Limited root-entry monitoring: ${library} - path depth exceeds ${MAX_PATH_COMPONENTS}`);
      return;
    }
    for (const name of parts) {
      // Check each prefix independently; never register watches through a
      // symlinked ancestor of the pinned path or configured alias.
      if (this.identity(parent).state !== "directory") break;
      const entry = path.join(parent, name);
      const key = `${JSON.stringify(library)}|${kind}|${entry}`;
      const entries = wanted.get(parent) ?? new Map<string, Entry>();
      entries.set(key, { library, pinnedRoot, kind, parent, name, entry, key, state: "missing" });
      wanted.set(parent, entries);
      parent = entry;
    }
  }

  private reconcile(): void {
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
    const activeKeys = new Set<string>();
    for (const [parent, entries] of wanted) {
      for (const entry of entries.values()) {
        activeKeys.add(entry.key);
        if (!this.identities.has(entry.key)) this.identities.set(entry.key, this.identity(entry.entry).value);
      }
      const existing = this.watches.get(parent);
      if (existing) {
        existing.entries = entries;
        continue;
      }
      if (this.unavailable.has(parent)) continue;
      try {
        const watcher = this.filesystem.watch(parent,
          { persistent: false, recursive: false, encoding: "utf8" }, (_event, filename) => this.handle(parent, filename));
        watcher.on("error", error => {
          if (this.watches.get(parent)?.watcher !== watcher) return;
          watcher.close();
          this.watches.delete(parent);
          this.unavailable.add(parent);
          this.log(`[Libraries] Root-entry watcher unavailable: ${parent} - ${String(error)}`);
        });
        this.watches.set(parent, { watcher, entries });
      } catch (error) {
        this.unavailable.add(parent);
        this.log(`[Libraries] Root-entry watcher unavailable: ${parent} - ${String(error)}`);
      }
    }
    for (const key of this.identities.keys()) if (!activeKeys.has(key)) this.identities.delete(key);
  }

  private handle(parent: string, filename?: string | Buffer | null): void {
    const watch = this.watches.get(parent);
    if (!watch || this.disposed) return;
    const name = filename === undefined || filename === null ? undefined : String(filename);
    let changed = false;
    for (const entry of watch.entries.values()) {
      if (name && (process.platform === "win32"
        ? name.toLowerCase() !== entry.name.toLowerCase() : name !== entry.name)) continue;
      const next = this.identity(entry.entry);
      if (this.identities.get(entry.key) === next.value) continue;
      this.identities.set(entry.key, next.value);
      changed = true;
      this.onChange({ library: entry.library, pinnedRoot: entry.pinnedRoot,
        kind: entry.kind, entry: entry.entry, state: next.state });
    }
    // A newly created ordinary directory may now need its own parent-entry
    // subscription. Do not re-enumerate anything for unrelated notifications.
    if (changed) this.reconcile();
  }
}
