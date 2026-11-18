import { allowsSymbolCompletions } from "./policy";
import type { CompletionContext, CompletionEntries, CompletionEntry } from "./types";

// Structural input contract shared by terminal snapshots and picker previews.
export interface CompletionInput {
  text: string;
  textBeforeCursor: string;
  cursorRow: number;
}

export function rebaseCompletionEnds(entries: CompletionEntry[], delta: number): CompletionEntries {
  const rebased = entries.map(entry => entry.replaceEnd === undefined ? entry : {
    ...entry, replaceEnd: entry.replaceEnd + delta,
  }) as CompletionEntries;
  if ((entries as CompletionEntries).isIncomplete) rebased.isIncomplete = true;
  return rebased;
}

/** Reuse only refinements of the same token with identical surrounding source. */
export function refineCompletionEntries(
  cached: { input: CompletionInput; context: CompletionContext; entries: CompletionEntries },
  input: CompletionInput, context: CompletionContext
): CompletionEntries | undefined {
  const old = cached.context;
  if (allowsSymbolCompletions(context) !== allowsSymbolCompletions(old) ||
      context.kind !== old.kind || context.replaceStart !== old.replaceStart ||
      (context.argumentTags === undefined) !== (old.argumentTags === undefined) ||
      input.cursorRow !== cached.input.cursorRow || !context.prefix.startsWith(old.prefix) ||
      input.textBeforeCursor.slice(0, input.textBeforeCursor.length - context.prefix.length) !==
        cached.input.textBeforeCursor.slice(0, cached.input.textBeforeCursor.length - old.prefix.length) ||
      input.text.slice(input.textBeforeCursor.length) !== cached.input.text.slice(cached.input.textBeforeCursor.length)) {
    return undefined;
  }
  const safe = cached.entries.filter(entry => entry.replaceStart === undefined || entry.replaceStart === old.replaceStart);
  return rebaseCompletionEnds(safe, context.prefix.length - old.prefix.length);
}
