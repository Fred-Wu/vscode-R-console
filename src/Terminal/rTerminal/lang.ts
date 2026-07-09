import * as vscode from "vscode";
import {
  type CompletionEntry,
  type CompletionProvider,
  CompletionPickItem,
  collectCompletionEntries,
  getCompletionContext,
  isCompletionPickItem,
  needsLanguageServerCompletion,
  toCompletionQuickPickItems,
} from "../../Language/completion";
import { ConsoleLspClient } from "../../Language/consoleLspClient";
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
  private readonly completionDocumentId = `${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  private consoleLsp: ConsoleLspClient | undefined;
  private readonly languageBridge: LanguageBridge;
  private sessionState: ConsoleSessionState | undefined;
  private silentCompletionRequest: Promise<void> | undefined;

  constructor(private readonly options: LangOptions) {
    this.languageBridge = new LanguageBridge({
      requestMemberCompletions: async (expression, operator) =>
        await this.options.requestMemberCompletions(expression, operator),
    });
  }

  async start(): Promise<void> {
    if (this.usesConsoleLsp()) {
      await this.ensureConsoleLspStarted();
      const docContext = await this.getOrOpenCompletionDocument("");
      if (docContext) {
        this.requestSilentCompletion(docContext.document);
      }
      return;
    }
    await this.getOrOpenCompletionDocument("");
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
      const cachedSessionData = getWorkspaceData();
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

      const filterAggregateProviderItems = !this.usesConsoleLsp();
      const needsLsp = needsLanguageServerCompletion(context);
      const needsStagedEntries = needsLsp || (
        context.kind === "bracket" && !!context.dataObjectName
      );
      const recentEntries = this.options.getRecentSessionEntries?.() ?? [];
      let completionProvider: CompletionProvider | undefined;
      const fullEntriesPromise = (async () => {
        const sessionData = shouldRequestWorkspaceData
          ? (await workspaceDataRequest) ?? getWorkspaceData() ?? cachedSessionData
          : cachedSessionData;
        if (!this.isCurrentCompletionRequest(requestId)) {
          return undefined;
        }

        const needsDocument = needsLsp || this.usesConsoleLsp();
        const completionProviderRequest = this.getCompletionProvider();
        const docContextRequest = needsDocument
          ? this.getOrOpenCompletionDocument(latestInput.text, sessionData)
          : Promise.resolve(undefined);

        completionProvider = await completionProviderRequest;
        if (!this.isCurrentCompletionRequest(requestId) || !completionProvider) {
          return undefined;
        }

        const docContext = await docContextRequest;
        if (!this.isCurrentCompletionRequest(requestId)) {
          return undefined;
        }
        if (needsDocument && !docContext) {
          return undefined;
        }

        const position = new vscode.Position(
          latestInput.cursorRow + (docContext?.lineOffset ?? 0),
          context.snapshotCursor
        );
        const linesBefore = [
          ...(docContext?.preludeLines ?? []),
          ...latestInput.lines.slice(0, latestInput.cursorRow),
        ];
        return await collectCompletionEntries(
          context,
          docContext?.document,
          docContext ? position : undefined,
          sessionData,
          linesBefore,
          recentEntries,
          completionProvider,
          latestInput.text,
          filterAggregateProviderItems
        );
      })();
      const stagedEntries = needsStagedEntries && context.kind !== "package"
        ? await collectCompletionEntries(
            context,
            undefined,
            undefined,
            cachedSessionData,
            [],
            [],
            undefined,
            latestInput.text,
            filterAggregateProviderItems
          )
        : undefined;
      if (!this.isCurrentCompletionRequest(requestId)) {
        return;
      }

      const entries = stagedEntries?.length
        ? stagedEntries
        : await fullEntriesPromise;
      if (!this.isCurrentCompletionRequest(requestId)) {
        return;
      }

      if (!entries || entries.length === 0) {
        return;
      }

      const pickOptions = {
        matchOnDescription: false,
        matchOnDetail: false,
        placeHolder: "R console completions",
      };
      const shouldPrefillQuickPick =
        context.prefix.length > 0 &&
        context.kind !== "package" &&
        context.kind !== "member";
      const prefillQuickPick = (pick: vscode.QuickPick<vscode.QuickPickItem>): void => {
        if (!shouldPrefillQuickPick) {
          return;
        }
        setTimeout(() => { if (pick.value.length === 0) { pick.value = context.prefix; } }, 0);
      };
      const searchValue = (value: string): string => {
        if (context.kind === "package" && value.length > 0 && !value.startsWith(context.prefix)) {
          return context.prefix + value;
        }
        return value;
      };
      const filterEntries = (sourceEntries: CompletionEntry[], value: string): CompletionEntry[] => {
        const query = searchValue(value).toLowerCase();
        if (query.length === 0) {
          return sourceEntries;
        }
        return sourceEntries.filter((entry) => entry.label.toLowerCase().startsWith(query));
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
        initialEntries: CompletionEntry[],
        delayedEntries?: typeof fullEntriesPromise
      ): Promise<CompletionPickItem | undefined> => await new Promise((resolve) => {
        const pick = vscode.window.createQuickPick<vscode.QuickPickItem>();
        let active = true;
        let request = 0;
        let sourceEntries = initialEntries;
        Object.assign(pick, {
          matchOnDescription: false,
          matchOnDetail: false,
          sortByLabel: false,
          placeholder: pickOptions.placeHolder,
        });
        setQuickPickItems(pick, sourceEntries, "");
        void delayedEntries?.then((nextEntries) => {
          if (!active || !nextEntries?.length || !this.isCurrentCompletionRequest(requestId)) {
            return;
          }
          sourceEntries = nextEntries;
          setQuickPickItems(pick, sourceEntries, pick.value);
        }).catch(() => undefined);
        pick.onDidChangeValue((value) => void (async () => {
          setQuickPickItems(pick, sourceEntries, value);
          if (context.kind !== "package") {
            return;
          }
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
            cachedSessionData
          );
          if (!this.isCurrentCompletionRequest(requestId)) {
            return;
          }
          if (!nextDocContext) {
            return;
          }
          if (!completionProvider) {
            return;
          }
          const nextEntries = await collectCompletionEntries(
            nextContext,
            nextDocContext.document,
            new vscode.Position(latestInput.cursorRow + nextDocContext.lineOffset, cursorCol),
            cachedSessionData,
            [
              ...nextDocContext.preludeLines,
              ...lines.slice(0, latestInput.cursorRow),
            ],
            recentEntries,
            completionProvider,
            nextInputText,
            filterAggregateProviderItems
          );
          if (!this.isCurrentCompletionRequest(requestId)) {
            return;
          }
          if (currentRequest === request) {
            sourceEntries = nextEntries;
            setQuickPickItems(pick, sourceEntries, value);
          }
        })().catch(() => undefined));
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
          const cancelled = active;
          active = false;
          request += 1;
          pick.dispose();
          if (cancelled) {
            resolve(undefined);
          }
        });
        pick.show();
        prefillQuickPick(pick);
      });
      let selection: vscode.QuickPickItem | undefined;
      if (context.kind !== "package" && stagedEntries?.length) {
        selection = await showCompletionQuickPick(entries, fullEntriesPromise);
      } else {
        selection = await showCompletionQuickPick(entries);
      }

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

  async refreshCompletionContextDocument(inputText: string): Promise<void> {
    if (!this.usesConsoleLsp()) {
      return;
    }
    if (!this.completionDocument) {
      return;
    }
    try {
      const docContext = await this.getOrOpenCompletionDocument(inputText);
      if (docContext) {
        await this.consoleLsp?.prepareDocument(docContext.document);
      }
    } catch {
    }
  }

  async refreshSessionCompletionDocument(): Promise<void> {
    if (this.usesConsoleLsp()) {
      return;
    }
    try {
      const docContext = await this.getOrOpenCompletionDocument("");
      if (docContext) {
        this.requestSilentCompletion(docContext.document);
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

  private requestSilentCompletion(document: vscode.TextDocument): void {
    if (this.silentCompletionRequest) {
      return;
    }

    this.silentCompletionRequest = (async () => {
      try {
        const completionProvider = this.usesConsoleLsp()
          ? this.consoleLsp
          : this.languageBridge;
        if (!completionProvider) {
          return;
        }
        const position = document.positionAt(document.getText().length);
        await completionProvider.provideCompletionItems(document, position);
      } catch {
      } finally {
        this.silentCompletionRequest = undefined;
      }
    })();
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
