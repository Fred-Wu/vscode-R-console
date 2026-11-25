import * as vscode from "vscode";
import type { CompletionProvider, StaticCompletionCandidate } from "../../src/Language/completion/types";

export const provider: CompletionProvider = {
  async provideStaticCompletion(request) {
    const member: StaticCompletionCandidate = {
      label: "alpha", insertText: "alpha", kind: vscode.CompletionItemKind.Field,
      role: "member", range: new vscode.Range(request.position, request.contextPosition),
    };
    return { status: "resolved", completion: { items: [member], isIncomplete: false } };
  },
};

// @ts-expect-error Static candidates must distinguish members from ambient symbols.
export const missingRole: StaticCompletionCandidate = { label: "alpha" };

export const argument: StaticCompletionCandidate = {
  label: "alpha", insertText: "alpha = ", role: "argument",
};

export const workspace: StaticCompletionCandidate = {
  label: "factory", role: "symbol", workspaceOrigin: {
    definitionUri: "r-console://test/console.R", contextUri: "r-console://test/console.R",
  },
};

export const auxiliaryEdit: StaticCompletionCandidate = {
  label: "alpha", insertText: "alpha", role: "symbol",
  // @ts-expect-error The terminal applies one candidate edit.
  additionalTextEdits: [],
};

export const editorCommand: StaticCompletionCandidate = {
  label: "alpha", insertText: "alpha", role: "symbol",
  // @ts-expect-error Acceptance does not execute editor commands.
  command: { title: "Import", command: "provider.import" },
};
