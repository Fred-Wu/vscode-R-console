import * as vscode from "vscode";
import type { CompletionProvider } from "./completion";
import type { DocumentSemanticTokensResult } from "./semanticTokens";
import type { SessionMemberCompletionItem } from "../Runtime/sessionWatcher";

type LanguageBridgeOptions = {
  requestMemberCompletions?: (
    expression: string,
    operator: "$" | "@"
  ) => Promise<SessionMemberCompletionItem[] | undefined>;
};

export class LanguageBridge implements CompletionProvider {
  private activationPromise: Promise<void> | undefined;

  constructor(private readonly options: LanguageBridgeOptions) {}

  async provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
    triggerCharacter?: string
  ): Promise<vscode.CompletionList | vscode.CompletionItem[] | undefined> {
    await this.activateVscodeR();
    return await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      doc.uri,
      position,
      triggerCharacter
    );
  }

  async provideMemberCompletionItems(
    expression: string,
    operator: "$" | "@"
  ): Promise<SessionMemberCompletionItem[] | undefined> {
    return await this.options.requestMemberCompletions?.(expression, operator);
  }

  async provideDocumentSemanticTokens(
    doc: vscode.TextDocument
  ): Promise<DocumentSemanticTokensResult | undefined> {
    await this.activateVscodeR();
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend | undefined>(
      "vscode.provideDocumentSemanticTokensLegend",
      doc.uri
    );
    if (!legend) {
      return undefined;
    }

    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens | undefined>(
      "vscode.provideDocumentSemanticTokens",
      doc.uri
    );
    if (!tokens) {
      return undefined;
    }

    return {
      legend: {
        tokenTypes: [...legend.tokenTypes],
        tokenModifiers: [...legend.tokenModifiers],
      },
      data: Array.from(tokens.data),
    };
  }

  private async activateVscodeR(): Promise<void> {
    if (!this.activationPromise) {
      this.activationPromise = this.doActivateVscodeR();
    }
    await this.activationPromise;
  }

  private async doActivateVscodeR(): Promise<void> {
    const extension =
      vscode.extensions.getExtension("REditorSupport.r") ??
      vscode.extensions.getExtension("reditorsupport.r");
    if (extension && !extension.isActive) {
      await extension.activate();
    }
  }
}
