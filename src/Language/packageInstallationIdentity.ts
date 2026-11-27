import * as fs from "fs";
import * as path from "path";

export type InstallationIdentity = { directory: string; identity: string; linked?: boolean };

/** Directory identity excludes timestamps, which can change during installation. */
export function sameDirectory(a: fs.Stats, b: fs.Stats): boolean {
  return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino &&
    (a.ino !== 0 || a.birthtimeMs === b.birthtimeMs);
}

function changedDirectory(directory: string): Error {
  return Object.assign(new Error(`Package directory changed during metadata inspection: ${directory}`), { code: "ESTALE" });
}

/** Validate an observed ordinary directory, never resolve a replacement. */
export function verifyDirectory(directory: string, expected: fs.Stats): void {
  let actual: fs.Stats;
  try { actual = fs.lstatSync(directory); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") throw changedDirectory(directory);
    throw error;
  }
  if (!sameDirectory(actual, expected)) throw changedDirectory(directory);
}

const metadataIdentity = (value: fs.Stats) => [value.dev, value.ino, value.mtimeMs, value.ctimeMs, value.size];

/** Observe local installation metadata only. The caller supplies a guard for
 * the pinned library; check it and each known ancestor around asynchronous
 * operations. Path-based Node APIs cannot make these checks atomic with I/O. */
export async function inspectInstallation(directory: string, rootIsCurrent: () => boolean):
  Promise<InstallationIdentity | null | undefined> {
  if (!rootIsCurrent()) return undefined;
  try {
    const stat = await fs.promises.lstat(directory);
    if (!rootIsCurrent()) return undefined;
    if (stat.isSymbolicLink()) {
      // The link entry is the installation signal; its target is never read.
      return { directory, linked: true, identity: JSON.stringify([directory, "linked", ...metadataIdentity(stat)]) };
    }
    if (!stat.isDirectory()) return undefined;
    const metaPath = path.join(directory, "Meta");
    const check = (meta?: fs.Stats): boolean => {
      if (!rootIsCurrent()) return false;
      verifyDirectory(directory, stat);
      if (meta) verifyDirectory(metaPath, meta);
      return true;
    };
    if (!check()) return undefined;
    const meta = await fs.promises.lstat(metaPath);
    if (!check()) return undefined;
    if (meta.isSymbolicLink()) return null;
    if (!meta.isDirectory()) return undefined;
    if (!check(meta)) return undefined;
    const metadata = await fs.promises.lstat(path.join(metaPath, "package.rds"));
    if (!check(meta)) return undefined;
    if (metadata.isSymbolicLink()) return null;
    if (!metadata.isFile()) return undefined;
    const description = await fs.promises.lstat(path.join(directory, "DESCRIPTION"));
    if (!check(meta)) return undefined;
    if (description.isSymbolicLink()) return null;
    if (!description.isFile()) return undefined;
    // Do not open or parse either file. R owns package validity and versions.
    return { directory, identity: JSON.stringify([directory, ...[stat, metadata, description].map(metadataIdentity)]) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return null;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}
