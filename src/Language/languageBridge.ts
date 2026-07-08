import * as vscode from "vscode";
import type { CompletionProvider } from "./completion";
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

  private async activateVscodeR(): Promise<void> {
    if (!this.activationPromise) {
      this.activationPromise = this.doActivateVscodeR();
    }
    try {
      await this.activationPromise;
    } catch (error) {
      this.activationPromise = undefined;
      throw error;
    }
  }

  private async doActivateVscodeR(): Promise<void> {
    const extension = vscode.extensions.getExtension("REditorSupport.r")!;
    if (!extension.isActive) {
      await extension.activate();
    }
  }
}
