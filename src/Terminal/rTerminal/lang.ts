import * as vscode from "vscode";
import {
  type CompletionProvider,
  CompletionPickItem,
  collectCompletionEntries,
  getCompletionContext,
  isCompletionPickItem,
  needsLanguageServerCompletion,
  toCompletionQuickPickItems,
} from "../../Language/completion";
import { ConsoleLspClient } from "../../Language/consoleLspClient";
import type { DocumentSemanticTokensResult } from "../../Language/semanticTokens";
import { LanguageBridge } from "../../Language/languageBridge";
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
  cwd?: string;
  extensionPath: string;
  rPath: string;
  languageServer: "vscode-r" | "console";
  getRecentSessionEntries?: () => string[];
  requestWorkspaceData?: () => Promise<WorkspaceData | undefined> | undefined;
  requestMemberCompletions: (
    expression: string,
    operator: "$" | "@"
  ) => Promise<SessionMemberCompletionItem[] | undefined> | undefined;
};

type AutocompleteRequest = {
  input: InputSnapshot;
  getCurrentInput: () => InputSnapshot;
  getWorkspaceData: () => WorkspaceData | undefined;
  refreshWorkspaceData: () => void;
  applyCompletion: (selection: CompletionPickItem) => void;
};

type ConsoleSessionState = {
  attachedPackages: string[];
  loadedNamespaces: string[];
};

type CompletionDocumentContext = {
  document: vscode.TextDocument;
  lineOffset: number;
  preludeLines: string[];
};

export class RTermLang {
  private completionRequestId = 0;
  private completionDocument: VirtualRDocument | undefined;
  private semanticDocument: VirtualRDocument | undefined;
  private readonly completionDocumentId = `${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  private semanticRequestCounter = 0;
  private consoleLsp: ConsoleLspClient | undefined;
  private readonly languageBridge: LanguageBridge;
  private sessionState: ConsoleSessionState | undefined;

  constructor(private readonly options: LangOptions) {
    this.languageBridge = new LanguageBridge({
      requestMemberCompletions: async (expression, operator) =>
        await this.options.requestMemberCompletions(expression, operator),
    });
  }

  async start(): Promise<void> {
    if (this.usesConsoleLsp()) {
      await this.ensureConsoleLspStarted();
    }
  }

  async handleAutocomplete({
    input,
    getCurrentInput,
    getWorkspaceData,
    refreshWorkspaceData,
    applyCompletion,
  }: AutocompleteRequest): Promise<void> {
    const context = getCompletionContext(
      input.currentLine,
      input.cursorCol,
      input.textBeforeCursor
    );
    if (!context) {
      return;
    }

    const requestId = ++this.completionRequestId;
    {
      const shouldRequestWorkspaceData = this.shouldRequestWorkspaceData(context);
      const workspaceDataRequest = shouldRequestWorkspaceData
        ? this.options.requestWorkspaceData?.()
        : undefined;
      if (!shouldRequestWorkspaceData) {
        refreshWorkspaceData();
      }

      const latestInput = getCurrentInput();
      if (
        latestInput.currentLine !== context.snapshotInput ||
        latestInput.cursorCol !== context.snapshotCursor
      ) {
        return;
      }

      const sessionData = shouldRequestWorkspaceData
        ? (await workspaceDataRequest) ?? getWorkspaceData()
        : getWorkspaceData();
      if (!this.isCurrentCompletionRequest(requestId)) {
        return;
      }
      const completionProvider = await this.getCompletionProvider();
      if (!this.isCurrentCompletionRequest(requestId)) {
        return;
      }
      if (!completionProvider) {
        return;
      }
      const filterAggregateProviderItems = !this.usesConsoleLsp();
      const needsLsp = needsLanguageServerCompletion(context);

      const docContext =
        needsLsp || this.usesConsoleLsp()
          ? await this.getOrOpenCompletionDocument(latestInput.text, sessionData)
          : undefined;
      if (!this.isCurrentCompletionRequest(requestId)) {
        return;
      }
      if ((needsLsp || this.usesConsoleLsp()) && !docContext) {
        return;
      }

      const position = new vscode.Position(
        latestInput.cursorRow + (docContext?.lineOffset ?? 0),
        context.snapshotCursor
      );
      const linesBefore = [
        ...(docContext?.preludeLines ?? []),
        ...latestInput.lines.slice(0, latestInput.cursorRow),
      ];
      const entries = await collectCompletionEntries(
        context,
        docContext?.document,
        docContext ? position : undefined,
        sessionData,
        linesBefore,
        this.options.getRecentSessionEntries?.() ?? [],
        completionProvider,
        latestInput.text,
        filterAggregateProviderItems
      );
      if (!this.isCurrentCompletionRequest(requestId)) {
        return;
      }

      if (entries.length === 0) {
        return;
      }

      const picks = toCompletionQuickPickItems(entries, context);
      const pickOptions = {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: "R console completions",
      };
      const selection = context.kind !== "package"
        ? await vscode.window.showQuickPick(picks, pickOptions)
        : await new Promise<CompletionPickItem | undefined>((resolve) => {
            const pick = vscode.window.createQuickPick<vscode.QuickPickItem>();
            let request = 0;
            Object.assign(pick, { matchOnDescription: true, matchOnDetail: true, placeholder: pickOptions.placeHolder, items: picks });
            pick.onDidChangeValue((value) => void (async () => {
              const currentRequest = ++request;
              const prefix = value.startsWith(context.prefix) ? value : context.prefix + value;
              const cursorCol = context.replaceStart + prefix.length;
              const currentLine = latestInput.currentLine.slice(0, context.replaceStart) + prefix + latestInput.currentLine.slice(latestInput.cursorCol);
              const lines = [...latestInput.lines];
              lines[latestInput.cursorRow] = currentLine;
              const nextContext = { ...context, prefix, triggerCharacter: prefix.length === 0 ? context.triggerCharacter : undefined, snapshotInput: currentLine, snapshotCursor: cursorCol };
              const nextInputText = lines.join("\n");
              const nextDocContext = await this.getOrOpenCompletionDocument(
                nextInputText,
                sessionData
              );
              if (!this.isCurrentCompletionRequest(requestId)) {
                return;
              }
              if (!nextDocContext) {
                return;
              }
              const nextEntries = await collectCompletionEntries(
                nextContext,
                nextDocContext.document,
                new vscode.Position(latestInput.cursorRow + nextDocContext.lineOffset, cursorCol),
                sessionData,
                [
                  ...nextDocContext.preludeLines,
                  ...lines.slice(0, latestInput.cursorRow),
                ],
                this.options.getRecentSessionEntries?.() ?? [],
                completionProvider,
                nextInputText,
                filterAggregateProviderItems
              );
              if (!this.isCurrentCompletionRequest(requestId)) {
                return;
              }
              if (currentRequest === request) {
                pick.items = toCompletionQuickPickItems(nextEntries, { ...nextContext, snapshotInput: latestInput.currentLine, snapshotCursor: latestInput.cursorCol });
              }
            })().catch(() => undefined));
            pick.onDidAccept(() => { const item = pick.selectedItems[0]; resolve(isCompletionPickItem(item) ? item : undefined); pick.hide(); });
            pick.onDidHide(() => { request += 1; pick.dispose(); resolve(undefined); });
            pick.show();
          });

      if (!isCompletionPickItem(selection)) {
        return;
      }
      if (!this.isCurrentCompletionRequest(requestId)) {
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
    }
  }

  cleanupCompletionDocument(): void {
    if (this.consoleLsp && this.completionDocument) {
      this.consoleLsp.closeDocument(
        this.completionDocument as unknown as vscode.TextDocument
      );
    }
    this.completionDocument?.dispose();
    this.completionDocument = undefined;
    this.semanticDocument?.dispose();
    this.semanticDocument = undefined;
  }

  stopConsoleLsp(): void {
    this.cleanupCompletionDocument();
    const lsp = this.consoleLsp;
    this.consoleLsp = undefined;
    if (lsp) {
      void lsp.dispose();
    }
  }

  clearSessionState(): void {
    this.sessionState = undefined;
  }

  async requestSemanticTokens(
    content: string
  ): Promise<DocumentSemanticTokensResult | undefined> {
    if (this.usesConsoleLsp()) {
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

    const doc = await this.getOrOpenVscodeRSemanticDocument(content);
    if (!doc) {
      return undefined;
    }

    return await this.languageBridge.provideDocumentSemanticTokens(doc);
  }

  async refreshCompletionContextDocument(inputText: string): Promise<void> {
    if (!this.usesConsoleLsp()) {
      return;
    }
    if (!this.completionDocument) {
      return;
    }
    try {
      const docContext = await this.getOrOpenCompletionDocument(inputText);
      if (this.usesConsoleLsp() && docContext) {
        await this.consoleLsp?.prepareDocument(docContext.document);
      }
    } catch {
    }
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
  ): VirtualRDocument {
    if (this.completionDocument) {
      this.completionDocument.update(content);
      return this.completionDocument;
    }

    this.completionDocument = new VirtualRDocument(
      this.completionDocumentId,
      content,
      "console.rconsole",
      this.options.cwd,
      !this.usesConsoleLsp()
    );
    return this.completionDocument;
  }

  private async getOrOpenCompletionDocument(
    content: string,
    data?: WorkspaceData
  ): Promise<CompletionDocumentContext | undefined> {
    try {
      if (this.usesConsoleLsp()) {
        return {
          document: this.getOrUpdateCompletionDocument(
            content
          ) as unknown as vscode.TextDocument,
          lineOffset: 0,
          preludeLines: [],
        };
      }

      const documentContent = this.buildCompletionDocumentContent(content, data);
      const document = await this
        .getOrUpdateCompletionDocument(documentContent.text)
        .writeFileBackedDocument();
      return {
        document,
        lineOffset: documentContent.preludeLines.length,
        preludeLines: documentContent.preludeLines,
      };
    } catch {
      return undefined;
    }
  }

  private buildCompletionDocumentContent(
    inputText: string,
    data?: WorkspaceData
  ): { text: string; preludeLines: string[] } {
    const attachedPackages = data
      ? this.getAttachedPackages(data)
      : this.sessionState?.attachedPackages ?? [];
    const preludeLines = attachedPackages.map(
      (pkg) => `library(${JSON.stringify(pkg)})`
    );
    if (preludeLines.length === 0) {
      return { text: inputText, preludeLines };
    }
    return {
      text: `${preludeLines.join("\n")}\n${inputText}`,
      preludeLines,
    };
  }

  private getAttachedPackages(data: WorkspaceData): string[] {
    return data.search
      .filter((value) => value.startsWith("package:"))
      .map((value) => value.slice(8))
      .filter((value) => value.length > 0);
  }

  private createSemanticSnapshotDocument(content: string): vscode.TextDocument | undefined {
    try {
      this.semanticRequestCounter += 1;
      return new VirtualRDocument(
        `${this.completionDocumentId}-semantic-${this.semanticRequestCounter}`,
        content,
        `semantic-${this.semanticRequestCounter}.R`,
        this.options.cwd,
        false
      ) as unknown as vscode.TextDocument;
    } catch {
      return undefined;
    }
  }

  private async getOrOpenVscodeRSemanticDocument(
    content: string
  ): Promise<vscode.TextDocument | undefined> {
    try {
      if (!this.semanticDocument) {
        this.semanticDocument = new VirtualRDocument(
          `${this.completionDocumentId}-semantic`,
          content,
          "semantic.R",
          this.options.cwd,
          false
        );
      } else {
        this.semanticDocument.update(content);
      }
      return await this.semanticDocument.openTextDocument();
    } catch {
      return undefined;
    }
  }

  private usesConsoleLsp(): boolean {
    return this.options.languageServer === "console";
  }

  private isCurrentCompletionRequest(requestId: number): boolean {
    return requestId === this.completionRequestId;
  }

  private async getCompletionProvider(): Promise<CompletionProvider | undefined> {
    if (!this.usesConsoleLsp()) {
      return this.languageBridge;
    }

    await this.ensureConsoleLspStarted();
    return this.consoleLsp;
  }

  private async ensureConsoleLspStarted(): Promise<void> {
    if (!this.usesConsoleLsp()) {
      return;
    }

    if (!this.consoleLsp) {
      this.consoleLsp = new ConsoleLspClient({
        consoleId: this.completionDocumentId,
        extensionPath: this.options.extensionPath,
        rPath: this.options.rPath,
        requestMemberCompletions: async (expression, operator) =>
          await this.options.requestMemberCompletions(expression, operator),
      });
    }

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

  private shouldRequestWorkspaceData(
    context: NonNullable<ReturnType<typeof getCompletionContext>>
  ): boolean {
    return (
      (context.kind === "default" || context.kind === "argument") &&
      !context.dataObjectName
    );
  }

  private toSessionState(data: WorkspaceData): ConsoleSessionState {
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
