import { allowsSymbolCompletions } from "./policy";
import type { CompletionContext, CompletionEntries, CompletionEntry } from "./types";

// Structural input contract shared by terminal snapshots and picker previews.
export interface CompletionInput {
  text: string;
  textBeforeCursor: string;
  cursorRow: number;
}

/** Compose a provider edit with the prefix replacement used to build its preview. */
export function composeCompletionPreviewEdits(
  entries: CompletionEntry[],
  { prefixStart, originalCursor, originalLength, previewContext }: {
    prefixStart: number;
    originalCursor: number;
    // Length from the cursor's line start through the end of the original input.
    originalLength: number;
    previewContext: CompletionContext;
  }
): CompletionEntry[] {
  const previewCursor = previewContext.snapshotCursor;
  const delta = originalCursor - previewCursor;
  return entries.flatMap(entry => {
    const start = entry.replaceStart ?? previewContext.replaceStart;
    const end = entry.replaceEnd ?? previewContext.replaceEnd ?? previewCursor;
    const originalEnd = end + delta;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 ||
        start > previewCursor || end < previewCursor || originalEnd > originalLength) return [];
    // An insertion or partial-token edit can retain some of the search prefix.
    // Include that preview text in the edit applied to the original buffer.
    const retained = start > prefixStart ? previewContext.snapshotInput.slice(prefixStart, start) : "";
    return [{ ...entry, insertText: retained + entry.insertText,
      replaceStart: Math.min(start, prefixStart), replaceEnd: originalEnd }];
  });
}

/** Reuse only refinements of the same token with identical surrounding source. */
export function refineCompletionEntries(
  cached: { input: CompletionInput; context: CompletionContext; entries: CompletionEntries },
  input: CompletionInput, context: CompletionContext
): CompletionEntry[] | undefined {
  const old = cached.context;
  if (allowsSymbolCompletions(context) !== allowsSymbolCompletions(old) ||
      context.kind !== old.kind || context.replaceStart !== old.replaceStart ||
      (context.staticFallback === true) !== (old.staticFallback === true) ||
      (context.argumentTags === undefined) !== (old.argumentTags === undefined) ||
      input.cursorRow !== cached.input.cursorRow || !context.prefix.startsWith(old.prefix) ||
      input.textBeforeCursor.slice(0, input.textBeforeCursor.length - context.prefix.length) !==
        cached.input.textBeforeCursor.slice(0, cached.input.textBeforeCursor.length - old.prefix.length) ||
      input.text.slice(input.textBeforeCursor.length) !== cached.input.text.slice(cached.input.textBeforeCursor.length)) {
    return undefined;
  }
  const safe = cached.entries.filter(entry => entry.replaceStart === undefined || entry.replaceStart === old.replaceStart);
  const delta = context.prefix.length - old.prefix.length;
  return safe.map(entry => entry.replaceEnd === undefined ? entry : {
    ...entry, replaceEnd: entry.replaceEnd + delta,
  });
}
