import type * as vscode from "vscode";
import type { CallCompletionContext } from "./contextParser";
export type CompletionContext = {
  kind: "member" | "package" | "bracket" | "argument" | "default";
  prefix: string;
  replaceStart: number;
  // Line-relative offset, potentially past this line for a multiline string.
  replaceEnd?: number;
  triggerCharacter?: string;
  objectName?: string;
  operator?: "$" | "@";
  bracketOperator?: "[" | "[[";
  bracketQuote?: "\"" | "'";
  bracketDimension?: number;
  bracketDimensions?: number;
  argumentValue?: CallCompletionContext["argumentValue"];
  pipe?: boolean;
  autoTrigger?: boolean;
  suppressAutomatic?: boolean;
  chainedBracket?: boolean;
  functionName?: string;
  functionOperator?: "$" | "@" | "::" | ":::";
  // Source tags from the lexer, available only at an argument-name position.
  argumentTags?: CallCompletionContext["argumentTags"];
  dataObjectName?: string;
  snapshotInput: string;
  snapshotCursor: number;
};

export type CompletionEntry = {
  label: string;
  insertText: string;
  kind?: vscode.CompletionItemKind;
  detail?: string;
  source: "lsp" | "session" | "buffer";
  replaceStart?: number;
  replaceEnd?: number;
  role?: "argument" | "value" | "member" | "scope";
  packageName?: string;
};

export type CompletionEntries = CompletionEntry[] & {
  isIncomplete?: boolean;
  argumentsExhausted?: boolean;
};

export type CompletionPickItem = vscode.QuickPickItem & {
  packageName?: string;
  insertText: string;
  isCallable?: boolean;
  replaceStart: number;
  replaceEnd?: number;
  snapshotInput: string;
  snapshotCursor: number;
  source: "lsp" | "session" | "buffer";
};

export type CompletionQuickPickItem = CompletionPickItem | vscode.QuickPickItem;

export type CompletionResult = (vscode.CompletionList | vscode.CompletionItem[]) & {
  // Applies even when filtering leaves no arguments or the definition has none.
  rConsoleLocalFunction?: boolean;
  rConsoleMemberResolved?: boolean;
  rConsoleNativeArguments?: boolean;
  rConsoleArgumentsExhausted?: boolean;
};

export interface CompletionProvider {
  // A selected package function can be qualified in the LSP projection while
  // its name remains unqualified in the visible console input.
  getCallContext?(doc: vscode.TextDocument, position: vscode.Position): CallCompletionContext | undefined;
  provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string,
    // Keep the user's cursor when position is moved to broaden matching.
    contextPosition?: vscode.Position
  ): Promise<CompletionResult | undefined>;
}

export type RuntimeMemberCompletionRequester = (
  expression: string,
  operator: "$" | "@"
) => Promise<
  Array<{
    name: string;
    type?: string;
    str?: string;
  }> | undefined
> | undefined;

export type GlobalEnvItem = {
  class?: string[];
  type?: string;
  length?: number;
  str?: string;
  size?: number;
  dim?: number[];
  names?: string | string[];
  slots?: string | string[];
};

export type WorkspaceData = {
  globalenv?: Record<string, GlobalEnvItem>;
};

