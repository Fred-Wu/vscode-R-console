import * as vscode from "vscode";
import type {
  CompletionContext,
  CompletionEntry,
} from "./completion";

type ProposedTerminalWindow = typeof vscode.window & {
  registerTerminalCompletionProvider?: typeof vscode.window.registerTerminalCompletionProvider;
};

export function isTerminalCompletionProviderAvailable(): boolean {
  return typeof (vscode.window as ProposedTerminalWindow)
    .registerTerminalCompletionProvider === "function";
}

export function registerTerminalCompletionProvider(
  provider: vscode.TerminalCompletionProvider<vscode.TerminalCompletionItem>,
  ...triggerCharacters: string[]
): vscode.Disposable | undefined {
  const register = (vscode.window as ProposedTerminalWindow)
    .registerTerminalCompletionProvider;
  if (!register) {
    return undefined;
  }

  try {
    return register(provider, ...triggerCharacters);
  } catch {
    return undefined;
  }
}

export function toTerminalCompletionItems(
  entries: readonly CompletionEntry[],
  context: CompletionContext,
  lineStartIndex: number,
  cursorIndex: number
): vscode.TerminalCompletionItem[] {
  return entries.flatMap((entry) => {
    const replaceStart = lineStartIndex + (entry.replaceStart ?? context.replaceStart);
    if (replaceStart < 0 || replaceStart > cursorIndex) {
      return [];
    }

    const detail = entry.detail ?? (
      entry.label !== entry.insertText ? entry.label : undefined
    );
    return [{
      // The proposed API does not expose a separate insertText. Use the actual
      // insertion text as the label so accepting snippets such as fn() remains
      // correct.
      label: entry.insertText,
      replacementRange: [replaceStart, cursorIndex] as const,
      detail,
      kind: toTerminalCompletionKind(entry, context),
    }];
  });
}

function toTerminalCompletionKind(
  entry: CompletionEntry,
  context: CompletionContext
): vscode.TerminalCompletionItemKind {
  switch (entry.kind) {
    case vscode.CompletionItemKind.Function:
    case vscode.CompletionItemKind.Method:
    case vscode.CompletionItemKind.Constructor:
      return vscode.TerminalCompletionItemKind.Method;
  }

  if (context.kind === "argument") {
    return vscode.TerminalCompletionItemKind.Argument;
  }

  return vscode.TerminalCompletionItemKind.Argument;
}
