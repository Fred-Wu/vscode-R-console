import * as fs from "fs";

export const MAX_DIRECTORY_ENTRIES = 4096;

export class DirectoryEntryLimitError extends Error {
  constructor(readonly directory: string) {
    super(`Directory exceeds ${MAX_DIRECTORY_ENTRIES} entries: ${directory}`);
  }
}

/** Read one shallow directory with bounded buffering and no partial results.
 * Revalidate the caller's pinned path around each asynchronous operation.
 * Cancellation and errors close the handle, including a delayed open. */
export async function readBoundedDirectory(
  directory: string, isCurrent: () => boolean,
): Promise<fs.Dirent[] | undefined> {
  if (!isCurrent()) return;
  const handle = await fs.promises.opendir(directory, { bufferSize: 32 });
  try {
    const entries: fs.Dirent[] = [];
    while (isCurrent()) {
      const entry = await handle.read();
      if (!isCurrent()) return;
      if (!entry) return entries;
      if (entries.length === MAX_DIRECTORY_ENTRIES) throw new DirectoryEntryLimitError(directory);
      entries.push(entry);
    }
    return undefined;
  } finally {
    await handle.close();
  }
}
