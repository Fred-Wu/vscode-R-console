import * as vscode from "vscode";
import {
  CompletionPickItem,
  collectCompletionEntries,
  getCompletionContext,
  toCompletionPick,
  type CompletionProvider,
} from "../../Language/completion";
import {
  ConsoleLspClient,
  type ConsoleLspSessionState,
  type DocumentSemanticTokensResult,
} from "../../Language/consoleLspClient";
import { VirtualRDocument } from "../../Language/virtualRDocument";
import type {
  SessionMemberCompletionItem,
  WorkspaceData,
} from "../../Runtime/sessionWatcher";

export type InputSnapshot = {
  text: string;
  currentLine: string;
  cursorCol: number;
  cursorRow: number;
  lines: string[];
  textBeforeCursor: string;
};

type LangOptions = {
  extensionPath: string;
  rPath: string;
  getRecentSessionEntries?: () => string[];
  requestMemberCompletions: (
    expression: string,
    operator: "$" | "@"
  ) => Promise<SessionMemberCompletionItem[] | undefined> | undefined;
};

type AutocompleteRequest = {
  input: InputSnapshot;
  getCurrentInput: () => InputSnapshot;
  getWorkspaceData: () => WorkspaceData | undefined | Promise<WorkspaceData | undefined>;
  applyCompletion: (selection: CompletionPickItem) => void;
};

export class RTermLang {
  private completionInProgress = false;
  private completionDocument: VirtualRDocument | undefined;
  private readonly completionDocumentId = `${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  private semanticRequestCounter = 0;
  private consoleLsp: ConsoleLspClient | undefined;
  private sessionState: ConsoleLspSessionState | undefined;

  constructor(private readonly options: LangOptions) {}

  async start(): Promise<void> {
    await this.ensureConsoleLspStarted();
  }

  async handleAutocomplete({
    input,
    getCurrentInput,
    getWorkspaceData,
    applyCompletion,
  }: AutocompleteRequest): Promise<void> {
    if (this.completionInProgress) {
      return;
    }

    const context = getCompletionContext(
      input.currentLine,
      input.cursorCol,
      input.textBeforeCursor
    );
    if (!context) {
      return;
    }

    this.completionInProgress = true;
    try {
      await this.ensureConsoleLspStarted();

      const latestInput = getCurrentInput();
      if (
        latestInput.currentLine !== context.snapshotInput ||
        latestInput.cursorCol !== context.snapshotCursor
      ) {
        return;
      }

      const needsWorkspaceData =
        context.kind !== "member" && context.kind !== "bracket";
      const sessionData = needsWorkspaceData ? await getWorkspaceData() : undefined;
      const doc = this.getOrUpdateCompletionDocument(latestInput.text);
      if (!doc) {
        return;
      }
      if (this.consoleLsp) {
        await this.consoleLsp.prepareDocument(doc);
      }
      const completionProvider: CompletionProvider = {
        provideCompletionItems: async (document, docPosition, triggerCharacter) =>
          await this.consoleLsp?.provideCompletionItems(document, docPosition, triggerCharacter),
        provideSignatureHelp: async (document, docPosition, triggerCharacter) =>
          await this.consoleLsp?.provideSignatureHelp(document, docPosition, triggerCharacter),
        provideMemberCompletionItems: async (expression, operator) =>
          await this.options.requestMemberCompletions(expression, operator),
      };

      const position = new vscode.Position(latestInput.cursorRow, context.snapshotCursor);

      const linesBefore = latestInput.lines.slice(0, latestInput.cursorRow);
      const entries = await collectCompletionEntries(
        context,
        doc,
        position,
        sessionData,
        linesBefore,
        this.options.getRecentSessionEntries?.() ?? [],
        completionProvider
      );

      if (entries.length === 0) {
        return;
      }

      const picks = entries.map((entry) => toCompletionPick(entry, context));
      const selection = await vscode.window.showQuickPick(picks, {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: "R console completions",
      });

      if (!selection) {
        return;
      }

      const currentInput = getCurrentInput();
      if (
        currentInput.currentLine !== selection.snapshotInput ||
        currentInput.cursorCol !== selection.snapshotCursor
      ) {
        return;
      }

      applyCompletion(selection);
    } finally {
      this.completionInProgress = false;
    }
  }

  cleanupCompletionDocument(): void {
    if (this.consoleLsp) {
      if (this.completionDocument) {
        this.consoleLsp.closeDocument(this.completionDocument as unknown as vscode.TextDocument);
      }
    }
    this.completionDocument = undefined;
  }

  stopConsoleLsp(): void {
    const lsp = this.consoleLsp;
    this.consoleLsp = undefined;
    if (!lsp) {
      return;
    }
    void lsp.dispose();
  }

  clearSessionState(): void {
    this.sessionState = undefined;
  }

  async requestSemanticTokens(
    content: string
  ): Promise<DocumentSemanticTokensResult | undefined> {
    await this.ensureConsoleLspStarted();
    const lsp = this.consoleLsp;
    if (!lsp) {
      return undefined;
    }

    const doc = this.createSemanticSnapshotDocument(content);
    if (!doc) {
      return undefined;
    }

    try {
      return await lsp.provideDocumentSemanticTokens(doc);
    } finally {
      lsp.closeDocument(doc);
    }
  }

  async refreshCompletionContextDocument(inputText: string): Promise<void> {
    await this.ensureConsoleLspStarted();
    if (!this.consoleLsp) {
      return;
    }

    const doc = this.getOrUpdateCompletionDocument(inputText);
    if (!doc) {
      return;
    }
    await this.consoleLsp.prepareDocument(doc);
  }

  updateSessionData(data: WorkspaceData | undefined): boolean {
    if (!data) {
      return false;
    }

    const nextState = this.toSessionState(data);
    if (
      this.sessionState &&
      this.arraysEqual(nextState.attachedPackages, this.sessionState.attachedPackages) &&
      this.arraysEqual(nextState.loadedNamespaces, this.sessionState.loadedNamespaces)
    ) {
      return false;
    }

    this.sessionState = nextState;
    if (this.consoleLsp) {
      void this.consoleLsp.syncSessionState(nextState);
    }
    return true;
  }

  private getOrUpdateCompletionDocument(
    content: string
  ): vscode.TextDocument | undefined {
    try {
      if (this.completionDocument) {
        this.completionDocument.update(content);
        return this.completionDocument as unknown as vscode.TextDocument;
      }

      this.completionDocument = new VirtualRDocument(
        this.completionDocumentId,
        content,
        "completion.R"
      );
      return this.completionDocument as unknown as vscode.TextDocument;
    } catch {
      return undefined;
    }
  }

  private createSemanticSnapshotDocument(content: string): vscode.TextDocument | undefined {
    try {
      this.semanticRequestCounter += 1;
      const requestId = `${this.completionDocumentId}-semantic-${this.semanticRequestCounter}`;
      const document = new VirtualRDocument(
        requestId,
        content,
        `semantic-${this.semanticRequestCounter}.R`
      );
      return document as unknown as vscode.TextDocument;
    } catch {
      return undefined;
    }
  }

  private async ensureConsoleLspStarted(): Promise<void> {
    if (this.consoleLsp) {
      try {
        await this.consoleLsp.start();
        await this.syncConsoleSessionState();
      } catch {
      }
      return;
    }

    this.consoleLsp = new ConsoleLspClient({
      consoleId: this.completionDocumentId,
      extensionPath: this.options.extensionPath,
      rPath: this.options.rPath,
    });

    try {
      await this.consoleLsp.start();
      await this.syncConsoleSessionState();
    } catch {
    }
  }

  private async syncConsoleSessionState(): Promise<void> {
    if (!this.consoleLsp || !this.sessionState) {
      return;
    }
    await this.consoleLsp.syncSessionState(this.sessionState);
  }

  private toSessionState(data: WorkspaceData): ConsoleLspSessionState {
    return {
      attachedPackages: data.search
        .filter((value) => value.startsWith("package:"))
        .map((value) => value.slice(8)),
      loadedNamespaces: [...data.loaded_namespaces],
    };
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
      return false;
    }
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) {
        return false;
      }
    }
    return true;
  }
}
