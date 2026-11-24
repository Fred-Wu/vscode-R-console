import * as vscode from "vscode";
import type { CompletionContext, CompletionEntry } from "./types";
import { R_RESERVED_WORDS } from "./rText";
import { allowsSymbolCompletions } from "./policy";

const CONSOLE_IDENTIFIER_PATTERN = /\b[a-zA-Z.][a-zA-Z0-9._]*\b/g;
const BACKTICKED_R_NAME_PATTERN = /`(?:\\.|[^`\\])*`/g;
export function getConsoleBufferCompletions(
  context: CompletionContext,
  currentInputText: string,
  recentConsoleEntries: string[]
): CompletionEntry[] {
  if (!allowsSymbolCompletions(context) || !context.prefix || context.pipe) return [];

  const result: CompletionEntry[] = [];
  const seen = new Set<string>();
  const sources = [currentInputText, ...[...recentConsoleEntries].reverse()];

  for (const sourceText of sources) {
    const matches = sourceText
      .replace(BACKTICKED_R_NAME_PATTERN, "")
      .match(CONSOLE_IDENTIFIER_PATTERN);
    if (!matches) {
      continue;
    }

    for (const label of matches) {
      if (
        label === context.prefix ||
        R_RESERVED_WORDS.has(label) ||
        seen.has(label)
      ) {
        continue;
      }

      seen.add(label);
      result.push({
        label,
        insertText: label,
        kind: vscode.CompletionItemKind.Text,
        source: "buffer",
      });

      if (result.length >= 200) {
        return result;
      }
    }
  }

  return result;
}

