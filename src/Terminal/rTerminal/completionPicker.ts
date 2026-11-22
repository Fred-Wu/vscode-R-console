import * as vscode from "vscode";
import {
  type CompletionContext, type CompletionEntries, type CompletionEntry, type CompletionPickItem,
  getCompletionContext, rankCompletionEntries, isCompletionPickItem,
  toCompletionQuickPickItems,
} from "../../Language/completion";
import { rebaseCompletionEnds } from "../../Language/completion/refinement";
import type { InputSnapshot } from "./lang";

/** Quick Pick presentation and preview lifecycle, independent of LSP processes. */
export async function pickCompletion({
  context, latestInput, initialEntries, stagedEntries, delayedEntries, force, isCurrent, collect, signal,
}: {
  context: CompletionContext;
  latestInput: InputSnapshot;
  initialEntries: CompletionEntries;
  stagedEntries?: Promise<CompletionEntries | undefined>;
  delayedEntries?: Promise<CompletionEntries | undefined>;
  force: boolean;
  signal?: AbortSignal;
  isCurrent: () => boolean;
  collect: (context: CompletionContext, text: string, lines: string[], cursorCol: number,
    onStagedEntries: (entries: CompletionEntries) => void) => Promise<CompletionEntries | undefined>;
}): Promise<CompletionPickItem | undefined> {
  const completionPlaceHolder = "R console completions";
  const shouldPrefillQuickPick =
    context.prefix.length > 0 &&
    context.kind !== "package" &&
    context.kind !== "member";
  const prefillQuickPick = (pick: vscode.QuickPick<vscode.QuickPickItem>): ReturnType<typeof setTimeout> | undefined => {
    if (!shouldPrefillQuickPick) {
      return;
    }
    return setTimeout(() => { if (pick.value.length === 0) { pick.value = context.prefix; } }, 0);
  };
  const searchValue = (value: string): string => {
    if (context.kind === "package" && value.length > 0 && !value.startsWith(context.prefix)) {
      return context.prefix + value;
    }
    return value;
  };
  const filterEntries = (sourceEntries: CompletionEntry[], value: string): CompletionEntry[] =>
    rankCompletionEntries(sourceEntries,
      context.kind === "member" && !value ? context.prefix : searchValue(value), context);
  const quickPickContext = (value: string) => ({
    ...context,
    prefix: searchValue(value),
    snapshotInput: latestInput.currentLine,
    snapshotCursor: latestInput.cursorCol,
  });
  const toGroupedItems = (
    sourceEntries: CompletionEntry[],
    value: string
  ): vscode.QuickPickItem[] => toCompletionQuickPickItems(
    filterEntries(sourceEntries, value),
    quickPickContext(value)
  );
  const setQuickPickItems = (
    pick: vscode.QuickPick<vscode.QuickPickItem>,
    sourceEntries: CompletionEntry[],
    value: string
  ): void => {
    const items = toGroupedItems(sourceEntries, value);
    pick.items = items;
    const firstCompletion = items.find(isCompletionPickItem);
    if (firstCompletion) {
      pick.activeItems = [firstCompletion];
    }
  };
  const showCompletionQuickPick = async (
    initialEntries: CompletionEntries,
    stagedEntries?: Promise<CompletionEntries | undefined>,
    delayedEntries?: Promise<CompletionEntries | undefined>
  ): Promise<CompletionPickItem | undefined> => await new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(undefined);
      return;
    }
    const pick = vscode.window.createQuickPick<vscode.QuickPickItem>();
    const cancel = () => pick.hide();
    signal?.addEventListener("abort", cancel, { once: true });
    let active = true;
    let prefillTimer: ReturnType<typeof setTimeout> | undefined;
    let request = 0;
    let refinedPrefix: string | undefined;
    let baselineEntries = initialEntries;
    let baselineIncomplete = initialEntries.isIncomplete === true;
    let sourceEntries = initialEntries;
    let sourceIncomplete = baselineIncomplete;
    let baselinePhase = 0;
    Object.assign(pick, {
      matchOnDescription: false,
      matchOnDetail: false,
      sortByLabel: false,
      placeholder: completionPlaceHolder,
    });
    setQuickPickItems(pick, sourceEntries, "");
    const updateBaseline = (phase: number, nextEntries: CompletionEntries | undefined): void => {
      if (!active || !nextEntries || !isCurrent() || phase < baselinePhase) return;
      // A slower native-only result must not replace the completed LSP merge.
      baselinePhase = phase;
      baselineEntries = nextEntries;
      baselineIncomplete = nextEntries.isIncomplete === true;
      if (refinedPrefix !== undefined) return;
      sourceEntries = nextEntries;
      sourceIncomplete = baselineIncomplete;
      void changeValue(pick.value).catch(() => undefined);
    };
    void stagedEntries?.then(entries => updateBaseline(1, entries)).catch(() => undefined);
    void delayedEntries?.then(entries => updateBaseline(2, entries)).catch(() => undefined);
    const changeValue = async (value: string): Promise<void> => {
      const refinesBlankContext =
        context.prefix.length === 0 &&
        ((context.kind === "default" && (force || !!context.dataObjectName)) ||
          context.kind === "argument" ||
          (context.kind === "bracket" && !!context.dataObjectName));
      if (value.length === 0) {
        refinedPrefix = undefined;
        request += 1;
        sourceEntries = baselineEntries;
        sourceIncomplete = baselineIncomplete;
        setQuickPickItems(pick, sourceEntries, value);
        return;
      }

      const refinesEmptyContext =
        value.length > 0 &&
        refinesBlankContext;
      setQuickPickItems(pick, sourceEntries, value);
      if (sourceIncomplete || (refinedPrefix !== undefined && !value.startsWith(refinedPrefix)) ||
          (refinedPrefix === undefined && context.kind !== "package" && !value.startsWith(context.prefix))) {
        refinedPrefix = value;
        const currentRequest = ++request;
        await requestRefinedEntries(value, currentRequest);
        return;
      }
      if (refinesEmptyContext) {
        if (refinedPrefix !== undefined && value.startsWith(refinedPrefix)) {
          return;
        }
        refinedPrefix = [...value][0];
        const currentRequest = ++request;
        await requestRefinedEntries(refinedPrefix, currentRequest);
        return;
      }
    };
    pick.onDidChangeValue(value => void changeValue(value).catch(() => undefined));
    const requestRefinedEntries = async (
      value: string,
      currentRequest: number
    ): Promise<void> => {
      const prefix = context.kind === "package" && !value.startsWith(context.prefix)
        ? context.prefix + value
        : value;
      const cursorCol = context.replaceStart + prefix.length;
      const currentLine = latestInput.currentLine.slice(0, context.replaceStart) + prefix + latestInput.currentLine.slice(latestInput.cursorCol);
      const lines = [...latestInput.lines];
      lines[latestInput.cursorRow] = currentLine;
      const fullTextBeforeCursor = [
        ...lines.slice(0, latestInput.cursorRow),
        currentLine.slice(0, cursorCol),
      ].join("\n");
      const nextInputText = lines.join("\n");
      const nextContext = context.kind === "package"
        ? { ...context, prefix, triggerCharacter: prefix.length === 0 ? context.triggerCharacter : undefined, snapshotInput: currentLine, snapshotCursor: cursorCol }
        : getCompletionContext(currentLine, cursorCol, fullTextBeforeCursor,
            nextInputText.slice(fullTextBeforeCursor.length));
      if (!nextContext) {
        return;
      }
      if (prefix.length > 0) {
        nextContext.triggerCharacter = undefined;
      }
      const publish = (nextEntries: CompletionEntries): boolean => {
        if (!active || !isCurrent() || currentRequest !== request) return false;
        // LSP edits target the preview, but acceptance edits the actual input.
        sourceEntries = rebaseCompletionEnds(nextEntries, latestInput.cursorCol - cursorCol);
        sourceIncomplete = nextEntries.isIncomplete === true;
        setQuickPickItems(pick, sourceEntries, pick.value);
        return true;
      };
      let finished = false;
      let nextEntries: CompletionEntries | undefined;
      try {
        nextEntries = await collect(nextContext, nextInputText, lines, cursorCol, staged => {
          if (!finished) publish(staged);
        });
      } finally {
        finished = true;
      }
      if (!nextEntries || !publish(nextEntries)) return;
      // Typing may have refined a complete baseline while this request was
      // pending. A truncated reply cannot cover that newer query locally.
      if (sourceIncomplete && pick.value !== value && pick.value.startsWith(value)) {
        await changeValue(pick.value);
      }
    };
    pick.onDidAccept(() => {
      const item = pick.selectedItems[0];
      if (!isCompletionPickItem(item)) {
        return;
      }
      active = false;
      request += 1;
      resolve(item);
      pick.hide();
    });
    pick.onDidHide(() => {
      signal?.removeEventListener("abort", cancel);
      clearTimeout(prefillTimer);
      const cancelled = active;
      active = false;
      request += 1;
      pick.dispose();
      if (cancelled) {
        resolve(undefined);
      }
    });
    pick.show();
    if (active) prefillTimer = prefillQuickPick(pick);
  });
  return showCompletionQuickPick(initialEntries, stagedEntries, delayedEntries);
}
