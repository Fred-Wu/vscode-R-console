import * as fs from "fs";

export const MAX_DIRECTORY_ENTRIES = 4096;
const READ_BATCH_SIZE = 32;

export class DirectoryEntryLimitError extends Error {
  constructor(readonly directory: string) {
    super(`Directory exceeds ${MAX_DIRECTORY_ENTRIES} entries: ${directory}`);
  }
}

/** Read one shallow directory with bounded buffering and no partial results.
 * Validate the pinned path asynchronously around opening and bounded batches.
 * Reads use the held directory handle; no child paths are followed here.
 * Cancellation and errors close the handle, including a delayed open. */
export async function readBoundedDirectory(
  directory: string, isCurrent: () => boolean,
  validate: () => Promise<boolean> = async () => true,
): Promise<fs.Dirent[] | undefined> {
  const valid = async () => isCurrent() && await validate() && isCurrent();
  if (!await valid()) return;
  const handle = await fs.promises.opendir(directory, { bufferSize: READ_BATCH_SIZE });
  try {
    const entries: fs.Dirent[] = [];
    if (!await valid()) return;
    while (isCurrent()) {
      let done = false, overflow = false;
      for (let index = 0; index < READ_BATCH_SIZE; index++) {
        if (!isCurrent()) return;
        const entry = await handle.read();
        if (!isCurrent()) return;
        if (!entry) { done = true; break; }
        if (entries.length === MAX_DIRECTORY_ENTRIES) { overflow = true; break; }
        entries.push(entry);
      }
      if (!await valid()) return;
      if (overflow) throw new DirectoryEntryLimitError(directory);
      if (done) return entries;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}
