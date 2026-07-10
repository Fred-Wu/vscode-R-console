import * as vscode from "vscode";
import {
  type CompletionEntry,
  type CompletionProvider,
  CompletionPickItem,
  collectCompletionEntries,
  getCompletionContext,
  getCompletionIdentityKey,
  isCompletionPickItem,
  needsLanguageServerCompletion,
  toCompletionQuickPickItems,
} from "../../Language/completion";
import { ConsoleLspClient } from "../../Language/consoleLspClient";
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
  force?: boolean;
  applyCompletion: (selection: CompletionPickItem) => void;
};

type ConsoleSessionState = {
  attachedPackages: string[];
  loadedNamespaces: string[];
};

type CompletionDocumentContext = {
  document: vscode.TextDocument;
};

export class RTermLang {
  private completionRequestId = 0;
  private completionDocument: VirtualRDocument | undefined;
  private readonly completionDocumentId = `${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  private consoleLsp: ConsoleLspClient | undefined;
  private sessionState: ConsoleSessionState | undefined;
  private silentCompletionRequest: Promise<void> | undefined;

  constructor(private readonly options: LangOptions) {}

  async start(): Promise<void> {
    await this.ensureConsoleLspStarted();
    const docContext = await this.getOrOpenCompletionDocument("");
    if (docContext) {
      this.requestSilentCompletion(docContext.document);
    }
  }

  async handleAutocomplete({
    input,
    getCurrentInput,
    getWorkspaceData,
    refreshWorkspaceData,
    force = false,
    applyCompletion,
  }: AutocompleteRequest): Promise<void> {
    const context = getCompletionContext(
      input.currentLine,
      input.cursorCol,
      input.textBeforeCursor
    ) ?? (force
      ? {
          kind: "default" as const,
          prefix: "",
          replaceStart: input.cursorCol,
          snapshotInput: input.currentLine,
          snapshotCursor: input.cursorCol,
        }
      : undefined);
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

        const needsDocument = needsLsp || !!this.consoleLsp;
        const completionProviderRequest = this.getCompletionProvider();
        const docContextRequest = needsDocument
          ? this.getOrOpenCompletionDocument(latestInput.text)
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
          latestInput.cursorRow,
          context.snapshotCursor
        );
        const linesBefore = latestInput.lines.slice(0, latestInput.cursorRow);
        return await collectCompletionEntries(
          context,
          docContext?.document,
          docContext ? position : undefined,
          sessionData,
          linesBefore,
          recentEntries,
          completionProvider,
          latestInput.text
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
            latestInput.text
          )
        : undefined;
      if (!this.isCurrentCompletionRequest(requestId)) {
        return;
      }

      const opensEmptyQuickPick = force && context.prefix.length === 0;
      const entries = stagedEntries?.length
        ? stagedEntries
        : opensEmptyQuickPick
        ? []
        : await fullEntriesPromise;
      if (!this.isCurrentCompletionRequest(requestId)) {
        return;
      }

      if (!entries || entries.length === 0) {
        if (!force) {
          return;
        }
      }
      const initialEntries = entries ?? [];

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
        return sourceEntries
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => entry.label.toLowerCase().includes(query))
          .sort((a, b) => {
            const aLabel = a.entry.label.toLowerCase();
            const bLabel = b.entry.label.toLowerCase();
            const aRank = aLabel === query ? 0 : aLabel.startsWith(query) ? 1 : 2;
            const bRank = bLabel === query ? 0 : bLabel.startsWith(query) ? 1 : 2;
            return (
              aRank - bRank ||
              aLabel.indexOf(query) - bLabel.indexOf(query) ||
              aLabel.length - bLabel.length ||
              a.index - b.index
            );
          })
          .map(({ entry }) => entry);
      };
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
        initialEntries: CompletionEntry[],
        delayedEntries?: typeof fullEntriesPromise
      ): Promise<CompletionPickItem | undefined> => await new Promise((resolve) => {
        const pick = vscode.window.createQuickPick<vscode.QuickPickItem>();
        let active = true;
        let request = 0;
        let blankContextRefined = false;
        let baselineEntries = initialEntries;
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
          if (request !== 0) {
            return;
          }
          baselineEntries = nextEntries;
          sourceEntries = nextEntries;
          setQuickPickItems(pick, sourceEntries, pick.value);
        }).catch(() => undefined);
        pick.onDidChangeValue((value) => void (async () => {
          const refinesBlankContext =
            context.prefix.length === 0 &&
            ((force && context.kind === "default" && !context.dataObjectName) ||
              context.kind === "argument" ||
              (context.kind === "bracket" && !!context.dataObjectName));
          if (value.length === 0 && refinesBlankContext) {
            blankContextRefined = false;
            request += 1;
            sourceEntries = baselineEntries;
            setQuickPickItems(pick, sourceEntries, value);
            return;
          }

          const refinesEmptyContext =
            value.length > 0 &&
            refinesBlankContext;
          setQuickPickItems(pick, sourceEntries, value);
          if (refinesEmptyContext) {
            if (blankContextRefined) {
              return;
            }
            blankContextRefined = true;
            const currentRequest = ++request;
            await requestRefinedEntries(value[0], currentRequest);
            return;
          }
          if (context.kind !== "package") {
            return;
          }
          const currentRequest = ++request;
          await requestRefinedEntries(value, currentRequest);
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
          const nextContext = context.kind === "package"
            ? { ...context, prefix, triggerCharacter: prefix.length === 0 ? context.triggerCharacter : undefined, snapshotInput: currentLine, snapshotCursor: cursorCol }
            : getCompletionContext(currentLine, cursorCol, fullTextBeforeCursor);
          if (!nextContext) {
            return;
          }
          if (prefix.length > 0) {
            nextContext.triggerCharacter = undefined;
          }
          const nextInputText = lines.join("\n");
          const refinedSessionData =
            (await this.options.requestWorkspaceData?.()) ??
            getWorkspaceData() ??
            cachedSessionData;
          const nextDocContext = await this.getOrOpenCompletionDocument(
            nextInputText
          );
          if (!this.isCurrentCompletionRequest(requestId)) {
            return;
          }
          if (!nextDocContext) {
            return;
          }
          completionProvider ??= await this.getCompletionProvider();
          if (!completionProvider) {
            return;
          }
          const nextEntries = await collectCompletionEntries(
            nextContext,
            nextDocContext.document,
            new vscode.Position(latestInput.cursorRow, cursorCol),
            refinedSessionData,
            lines.slice(0, latestInput.cursorRow),
            recentEntries,
            completionProvider,
            nextInputText
          );
          if (!this.isCurrentCompletionRequest(requestId)) {
            return;
          }
          if (currentRequest === request) {
            sourceEntries = context.kind === "package"
              ? nextEntries
              : mergeCompletionEntries(baselineEntries, nextEntries);
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
      if (context.kind !== "package" && (stagedEntries?.length || opensEmptyQuickPick)) {
        selection = await showCompletionQuickPick(initialEntries, fullEntriesPromise);
      } else {
        selection = await showCompletionQuickPick(initialEntries);
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
      content
    );
    return this.completionDocument;
  }

  private async getOrOpenCompletionDocument(
    content: string
  ): Promise<CompletionDocumentContext | undefined> {
    try {
      return {
        document: this.getOrUpdateCompletionDocument(
          content
        ) as unknown as vscode.TextDocument,
      };
    } catch {
      return undefined;
    }
  }

  private isCurrentCompletionRequest(requestId: number): boolean {
    return requestId === this.completionRequestId;
  }

  private async getCompletionProvider(): Promise<CompletionProvider | undefined> {
    await this.ensureConsoleLspStarted();
    return this.consoleLsp;
  }

  private requestSilentCompletion(document: vscode.TextDocument): void {
    if (this.silentCompletionRequest) {
      return;
    }

    this.silentCompletionRequest = (async () => {
      try {
        const completionProvider = this.consoleLsp;
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
    return context.kind !== "member" && context.kind !== "package";
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
