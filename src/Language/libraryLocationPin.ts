import * as fs from "fs";
import * as path from "path";

type EntryState = "directory" | "link" | "missing" | "other";
type PinEntry = { path: string; state: "directory" | "link"; identity: string };
export type LibraryPin = { root: string; physical: PinEntry[]; configured: PinEntry[][] };
export type LibraryPinChange = {
  entry: string;
  kind: "physical" | "configured";
  state: EntryState;
  previous?: PinEntry["state"];
};

export class LibraryPinChanged extends Error {
  constructor(readonly change: LibraryPinChange) {
    super(`Library path entry changed: ${change.entry}`);
  }
}

/** Stable directory/link identity, shared with parent watcher registration. */
export function pinEntryIdentity(stat: fs.BigIntStats): string {
  // Ordinary directories are identified by their device and file identifier.
  // Birth time is mutable on some filesystems (macOS can backdate it on
  // utimes), so it must not invalidate an otherwise unchanged directory pin.
  // Preserve the existing timestamp fallback for missing file identifiers
  // and the extra metadata used to recognise changes to link entries.
  const linked = stat.isSymbolicLink();
  return [stat.dev, stat.ino,
    ...(linked || stat.ino === 0n ? [stat.birthtimeNs] : []),
    ...(linked ? [stat.size, stat.mtimeNs, stat.ctimeNs] : [])].join(":");
}

function entryAt(entry: string): { state: EntryState; identity: string } {
  try {
    const stat = fs.lstatSync(entry, { bigint: true });
    const state = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "other";
    return { state, identity: pinEntryIdentity(stat) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", identity: "" };
    // Permission and transient I/O errors are not evidence of replacement.
    throw error;
  }
}

function capturePath(target: string, kind: LibraryPinChange["kind"]):
  { entries: PinEntry[]; remaining: string[]; parent: boolean } {
  const entries: PinEntry[] = [];
  const root = path.parse(target).root;
  const names = [root, ...target.slice(root.length).split(process.platform === "win32" ? /[\\/]/ : /\//).filter(Boolean)];
  let entry = root;
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    if (index > 0 && name === ".") continue;
    // Record the directory traversed before '..': replacing it with a link
    // can change the destination even when the final physical root survives.
    if (index > 0 && name === "..") return { entries, remaining: names.slice(index + 1), parent: true };
    if (index > 0) entry = path.join(entry, name);
    const { state, identity } = entryAt(entry);
    if (state !== "directory" && !(kind === "configured" && state === "link")) {
      throw new LibraryPinChanged({ entry, kind, state });
    }
    entries.push({ path: entry, state, identity });
    // A link's target gets a separate rooted chain.
    if (state === "link") return { entries, remaining: names.slice(index + 1), parent: false };
  }
  return { entries, remaining: [], parent: false };
}

function checkEntries(entries: PinEntry[], kind: LibraryPinChange["kind"]): LibraryPinChange | undefined {
  for (const entry of entries) {
    const current = entryAt(entry.path);
    if (current.state !== entry.state || current.identity !== entry.identity) {
      return { entry: entry.path, kind, state: current.state, previous: entry.state };
    }
  }
  return undefined;
}

/** Resolve only on initial configuration or an explicit user review. */
export function captureLibraryPin(library: string): LibraryPin {
  const configured: PinEntry[][] = [];
  const initial = path.resolve(library);
  let target = initial;
  let links = 0;
  let entries: PinEntry[];
  for (;;) {
    // Only initial configuration or explicit review may follow these links.
    for (const chain of configured) {
      const changed = checkEntries(chain, "configured");
      if (changed) throw new LibraryPinChanged(changed);
    }
    const captured = capturePath(target, "configured");
    entries = captured.entries;
    const last = entries[entries.length - 1];
    if (captured.parent) {
      configured.push(entries);
      target = [path.dirname(last.path), ...captured.remaining].join(path.sep);
      continue;
    }
    if (last.state !== "link") break;
    if (++links > 40) throw new Error("Library alias chain exceeds 40 links");
    configured.push(entries);
    const destination = fs.readlinkSync(last.path);
    // Preserve target components until their links have been resolved. Joining
    // or resolving the whole string would collapse '..' before following links.
    const next = path.isAbsolute(destination) ? destination : path.dirname(last.path) + path.sep + destination;
    target = [next, ...captured.remaining].join(path.sep);
  }
  const root = path.resolve(fs.realpathSync.native(initial));
  const physical = capturePath(root, "physical").entries;
  // Canonical spelling may differ, but resolution must reach the same object.
  if (entries[entries.length - 1].identity !== physical[physical.length - 1].identity) {
    throw new Error("Library alias resolution changed during pinning");
  }
  // Do not accept a path that changed during the resolution itself.
  const pin = { root, physical, configured };
  const changed = checkLibraryPin(pin);
  if (changed) throw new LibraryPinChanged(changed);
  return pin;
}

/** Validate from the filesystem root, stopping at the first mismatch. Never
 * resolve a changed path or inspect anything below a replaced component. */
export function checkLibraryPin(pin: LibraryPin): LibraryPinChange | undefined {
  const physical = checkEntries(pin.physical, "physical");
  if (physical) return physical;
  for (const chain of pin.configured) {
    const changed = checkEntries(chain, "configured");
    if (changed) return changed;
  }
  return undefined;
}

export function sameLibraryPin(a: LibraryPin, b: LibraryPin): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function describeLibraryPinChange(library: string, pin: LibraryPin | undefined, change: LibraryPinChange): string {
  const original = change.kind === "physical" ? pin?.root : path.resolve(library);
  const subject = !pin ? "Configured library path" : change.kind === "physical"
    ? (change.entry === original ? "Pinned library" : "Pinned library ancestor")
    : (change.previous === "link" ? "Configured library alias" :
      change.entry === original ? "Configured library path" : "Configured library ancestor");
  if (change.state === "missing") return `${subject} missing or renamed`;
  if (change.state === "link") return change.previous === "link"
    ? `${subject} changed` : `${subject} replaced by a symlink`;
  if (change.state === "other") return `${subject} is no longer a directory`;
  return change.previous === "link" ? `${subject} replaced by an ordinary directory` : `${subject} replaced`;
}
