import * as vscode from "vscode";
import {
  type CompletionContext, type CompletionEntries, type CompletionEntry, type CompletionPickItem,
  getCompletionContext, getCompletionIdentityKey, rankCompletionEntries, isCompletionPickItem,
  toCompletionQuickPickItems,
} from "../../Language/completion";
import { rebaseCompletionEnds } from "../../Language/completion/refinement";
import type { InputSnapshot } from "./lang";

/** Quick Pick presentation and preview lifecycle, independent of LSP processes. */
export async function pickCompletion({
  context, latestInput, initialEntries, delayedEntries, force, isCurrent, collect,
}: {
  context: CompletionContext;
  latestInput: InputSnapshot;
  initialEntries: CompletionEntries;
  delayedEntries?: Promise<CompletionEntries | undefined>;
  force: boolean;
  isCurrent: () => boolean;
  collect: (context: CompletionContext, text: string, lines: string[], cursorCol: number) => Promise<CompletionEntries | undefined>;
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
    rankCompletionEntries(sourceEntries, searchValue(value), context);
  const mergeCompletionEntries = (
    firstEntries: CompletionEntry[],
    secondEntries: CompletionEntry[]
  ): CompletionEntry[] => {
    const seen = new Set<string>();
    const merged: CompletionEntry[] = [];
    const entries = [...firstEntries, ...secondEntries];
    for (const entry of entries) {
      const key = getCompletionIdentityKey(entry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(entry);
    }
    return merged;
  };
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
    delayedEntries?: Promise<CompletionEntries | undefined>
  ): Promise<CompletionPickItem | undefined> => await new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<vscode.QuickPickItem>();
    let active = true;
    let prefillTimer: ReturnType<typeof setTimeout> | undefined;
    let request = 0;
    let blankContextRefined = false;
    let baselineEntries = initialEntries;
    let baselineIncomplete = initialEntries.isIncomplete === true;
    let sourceEntries = initialEntries;
    let sourceIncomplete = baselineIncomplete;
    Object.assign(pick, {
      matchOnDescription: false,
      matchOnDetail: false,
      sortByLabel: false,
      placeholder: completionPlaceHolder,
    });
    setQuickPickItems(pick, sourceEntries, "");
    void delayedEntries?.then((nextEntries) => {
      if (!active || !nextEntries?.length || !isCurrent()) {
        return;
      }
      if (request !== 0) {
        return;
      }
      baselineEntries = nextEntries;
      baselineIncomplete = nextEntries.isIncomplete === true;
      sourceEntries = nextEntries;
      sourceIncomplete = baselineIncomplete;
      setQuickPickItems(pick, sourceEntries, pick.value);
    }).catch(() => undefined);
    pick.onDidChangeValue((value) => void (async () => {
      const refinesBlankContext =
        context.prefix.length === 0 &&
        ((context.kind === "default" && (force || !!context.dataObjectName)) ||
          context.kind === "argument" ||
          (context.kind === "bracket" && !!context.dataObjectName));
      if (value.length === 0 && refinesBlankContext) {
        blankContextRefined = false;
        request += 1;
        sourceEntries = baselineEntries;
        setQuickPickItems(pick, sourceEntries, value);
        return;
      }

      if (context.kind === "package" && value.length === 0) {
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
      if (context.kind === "package" && value.length > 0 && sourceIncomplete) {
        const currentRequest = ++request;
        await requestRefinedEntries(value, currentRequest);
        return;
      }
      if (refinesEmptyContext) {
        if (blankContextRefined) {
          return;
        }
        blankContextRefined = true;
        const currentRequest = ++request;
        await requestRefinedEntries(value[0], currentRequest);
        return;
      }
    })().catch(() => undefined));
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
      const nextEntries = await collect(nextContext, nextInputText, lines, cursorCol);
      if (!nextEntries || !isCurrent()) return;
      if (currentRequest === request) {
        // LSP edits target the preview, but acceptance edits the actual input.
        const originalEntries = rebaseCompletionEnds(nextEntries, latestInput.cursorCol - cursorCol);
        sourceEntries = context.kind === "package"
          ? originalEntries
          : mergeCompletionEntries(baselineEntries, originalEntries);
        sourceIncomplete = nextEntries.isIncomplete === true;
        setQuickPickItems(pick, sourceEntries, pick.value);
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
  return showCompletionQuickPick(initialEntries, delayedEntries);
}
