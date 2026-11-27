import * as fs from "fs";
import * as path from "path";

type EntryState = "directory" | "link" | "missing" | "other";
type PinEntry = { path: string; state: "directory" | "link"; identity: string };
export type LibraryPin = { root: string; physical: PinEntry[]; configured: PinEntry[] };
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

function components(target: string): string[] {
  let current = path.parse(target).root;
  const entries = [current];
  for (const name of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, name);
    entries.push(current);
  }
  return entries;
}

/** Stable directory/link identity, shared with parent watcher registration. */
export function pinEntryIdentity(stat: fs.BigIntStats): string {
  // Directory contents change mtime/ctime, not this pin. Include birth time
  // to distinguish reused file identifiers where available.
  return [stat.dev, stat.ino, stat.birthtimeNs,
    ...(stat.isSymbolicLink() ? [stat.size, stat.mtimeNs, stat.ctimeNs] : [])].join(":");
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

function capturePath(target: string, kind: LibraryPinChange["kind"]): PinEntry[] {
  const entries: PinEntry[] = [];
  for (const entry of components(target)) {
    const { state, identity } = entryAt(entry);
    if (state !== "directory" && !(kind === "configured" && state === "link")) {
      throw new LibraryPinChanged({ entry, kind, state });
    }
    entries.push({ path: entry, state, identity });
    // Track the configured alias entry, not the path through a link.
    if (state === "link") break;
  }
  return entries;
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
  const configured = path.resolve(library);
  const entries = capturePath(configured, "configured");
  const root = path.resolve(fs.realpathSync.native(configured));
  const physical = capturePath(root, "physical");
  // Do not accept a path that changed during the resolution itself.
  const changed = checkEntries(entries, "configured") ?? checkEntries(physical, "physical");
  if (changed) throw new LibraryPinChanged(changed);
  return { root, physical, configured: configured === root ? [] : entries };
}

/** Validate from the filesystem root, stopping at the first mismatch. Never
 * resolve a changed path or inspect anything below a replaced component. */
export function checkLibraryPin(pin: LibraryPin): LibraryPinChange | undefined {
  return checkEntries(pin.physical, "physical") ?? checkEntries(pin.configured, "configured");
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
