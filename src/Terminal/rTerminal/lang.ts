import { pickCompletion } from "./completionPicker";
import { refineCompletionEntries } from "../../Language/completion/refinement";
import * as vscode from "vscode";
import {
  type CompletionEntries,
  type CompletionContext,
  type CompletionProvider,
  type RuntimeMemberCompletionRequester,
  CompletionPickItem,
  collectCompletionEntries,
  getCompletionContext,
  rankCompletionEntries,
  isCompletionPickItem,
  toCompletionQuickPickItems,
} from "../../Language/completion";
import { ConsoleLspClient } from "../../Language/consoleLspClient";
import { VirtualRDocument } from "../../Language/virtualRDocument";
import type { WorkspaceData } from "../../Runtime/VSCR";
import type { SessionCompletionInspector } from "../../Runtime/VSCR/types";

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
  env: NodeJS.ProcessEnv;
  cwd?: string;
  getRecentSessionEntries?: () => string[];
  requestWorkspaceData?: () => Promise<WorkspaceData | undefined> | undefined;
  onPackagesChanged?: () => void;
  requestMemberCompletions: RuntimeMemberCompletionRequester;
  inspectRuntimeCompletion?: SessionCompletionInspector;
};

type AutocompleteRequest = {
  input: InputSnapshot;
  getCurrentInput: () => InputSnapshot;
  getWorkspaceData: () => WorkspaceData | undefined;
  force?: boolean;
  applyCompletion: (selection: CompletionPickItem) => void;
  onInlineEntries?: (items: import("../../Language/completion").CompletionQuickPickItem[]) => void;
};

type ConsoleSessionState = {
  attachedPackages: string[];
  functions?: Record<string, string>;
};

export class RTermLang {
  private completionRequestId = 0;
  private inlineCache: { input: InputSnapshot; context: CompletionContext; entries: CompletionEntries } | undefined;
  private completionDocument: VirtualRDocument | undefined;
  private readonly completionDocumentId = `${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  private consoleLsp: ConsoleLspClient | undefined;
  private sessionState: ConsoleSessionState | undefined;
  private silentCompletionRequest: Promise<void> | undefined;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private completionPickerAbort: AbortController | undefined;

  constructor(private readonly options: LangOptions) {}

  async start(): Promise<void> {
    const completionProvider = await this.ensureConsoleLspStarted();
    if (!completionProvider) {
      return;
    }
    const document = await this.getOrOpenCompletionDocument("");
    if (document && this.consoleLsp === completionProvider) {
      this.requestSilentCompletion(document, completionProvider);
    }
  }

  async handleAutocomplete({
    input,
    getCurrentInput,
    getWorkspaceData,
    force = false,
    applyCompletion,
    onInlineEntries,
  }: AutocompleteRequest): Promise<void> {
    if (this.disposed) {
      return;
    }
    const requestId = ++this.completionRequestId;
    const context = getCompletionContext(
      input.currentLine,
      input.cursorCol,
      input.textBeforeCursor,
      input.text.slice(input.textBeforeCursor.length)
    ) ?? (force
      ? {
          kind: "default" as const,
          prefix: "",
          replaceStart: input.cursorCol,
          snapshotInput: input.currentLine,
          snapshotCursor: input.cursorCol,
        }
      : undefined);
    if (!context || context.suppressAutomatic) {
      onInlineEntries?.([]);
      return;
    }

    {
      const shouldRequestWorkspaceData = this.shouldRequestWorkspaceData(context);
      const workspaceDataRequest = shouldRequestWorkspaceData
        ? this.options.requestWorkspaceData?.()
        : undefined;
      const cachedSessionData = getWorkspaceData();

      const latestInput = getCurrentInput();
      if (
        latestInput.text !== input.text || latestInput.cursorRow !== input.cursorRow ||
        latestInput.currentLine !== context.snapshotInput ||
        latestInput.cursorCol !== context.snapshotCursor
      ) {
        return;
      }

      const recentEntries = this.options.getRecentSessionEntries?.() ?? [];
      let refreshedSessionData: WorkspaceData | undefined;
      void workspaceDataRequest?.then((data) => {
        refreshedSessionData = data ?? getWorkspaceData();
      }).catch(() => undefined);

      let completionProvider: CompletionProvider | undefined;
      const documentRequest = this.getOrOpenCompletionDocument(latestInput.text);
      const fullEntriesPromise = (async () => {
        completionProvider = await this.ensureConsoleLspStarted();
        if (!this.isCurrentCompletionRequest(requestId)) {
          return undefined;
        }

        const document = await documentRequest;
        if (!this.isCurrentCompletionRequest(requestId)) {
          return undefined;
        }
        const position = new vscode.Position(
          latestInput.cursorRow,
          context.snapshotCursor
        );
        const linesBefore = latestInput.lines.slice(0, latestInput.cursorRow);
        const sessionData =
          refreshedSessionData ?? getWorkspaceData() ?? cachedSessionData;
        return await collectCompletionEntries(
          context,
          document,
          document ? position : undefined,
          sessionData,
          linesBefore,
          recentEntries,
          completionProvider,
          this.options.requestMemberCompletions,
          latestInput.text,
          this.options.inspectRuntimeCompletion
        );
      })();
      // Argument candidates must await LSP parameters; early session-only
      // results would select an unrelated runtime variable.
      const stagedEntries = context.kind === "default"
        ? await collectCompletionEntries(
            context,
            undefined,
            undefined,
            cachedSessionData,
            [],
            [],
            undefined,
            undefined,
            latestInput.text
          )
        : undefined;
      if (!this.isCurrentCompletionRequest(requestId)) {
        return;
      }

      const opensBeforeFullResults = (force && context.kind !== "argument") || !!stagedEntries?.length;
      const entries = stagedEntries?.length
        ? stagedEntries
        : opensBeforeFullResults
        ? []
        : await fullEntriesPromise;
      if (!this.isCurrentCompletionRequest(requestId)) {
        return;
      }

      if (!entries || entries.length === 0) {
        if (!force && !onInlineEntries) {
          return;
        }
      }
      const initialEntries = entries ?? [];

      if (onInlineEntries) {
        const publish = (results: CompletionEntries): void => {
          if (!this.isCurrentCompletionRequest(requestId)) return;
          const current = getCurrentInput();
          if (current.text !== latestInput.text || current.cursorRow !== latestInput.cursorRow ||
              current.cursorCol !== context.snapshotCursor) return;
          this.inlineCache = { input: latestInput, context, entries: results };
          onInlineEntries(toCompletionQuickPickItems(rankCompletionEntries(results, context.prefix, context), context));
        };
        if (initialEntries.length || !opensBeforeFullResults) publish(initialEntries);
        if (opensBeforeFullResults) {
          void fullEntriesPromise.then(results => {
            if (results) publish(results);
          }).catch(() => undefined);
        }
        return;
      }

      this.completionPickerAbort?.abort();
      const pickerAbort = new AbortController();
      this.completionPickerAbort = pickerAbort;
      const selection = await pickCompletion({
        context, latestInput, initialEntries,
        signal: pickerAbort.signal,
        delayedEntries: opensBeforeFullResults ? fullEntriesPromise : undefined,
        force, isCurrent: () => this.isCurrentCompletionRequest(requestId),
        collect: async (nextContext, nextInputText, lines, cursorCol) => {
          let refreshedRefinedSessionData: WorkspaceData | undefined;
          const refinedWorkspaceDataRequest = this.shouldRequestWorkspaceData(nextContext)
            ? this.options.requestWorkspaceData?.()
            : undefined;
          void refinedWorkspaceDataRequest?.then((data) => {
            refreshedRefinedSessionData = data ?? getWorkspaceData();
          }).catch(() => undefined);

          const nextDocumentRequest = this.getOrOpenCompletionDocument(nextInputText);
          if (!completionProvider) {
            completionProvider = await this.ensureConsoleLspStarted();
          }
          const nextDocument = await nextDocumentRequest;
          if (!this.isCurrentCompletionRequest(requestId)) {
            return;
          }
          const refinedSessionData =
            refreshedRefinedSessionData ?? getWorkspaceData() ?? cachedSessionData;
          const nextEntries = await collectCompletionEntries(
            nextContext,
            nextDocument,
            nextDocument
              ? new vscode.Position(latestInput.cursorRow, cursorCol)
              : undefined,
            refinedSessionData,
            lines.slice(0, latestInput.cursorRow),
            recentEntries,
            completionProvider,
            this.options.requestMemberCompletions,
            nextInputText,
            this.options.inspectRuntimeCompletion
          );
          return nextEntries;
        },
      });
      if (this.completionPickerAbort === pickerAbort) this.completionPickerAbort = undefined;

      if (!isCompletionPickItem(selection)) {
        return;
      }
      if (!this.isCurrentCompletionRequest(requestId)) {
        return;
      }

      const currentInput = getCurrentInput();
      if (
        currentInput.text !== latestInput.text || currentInput.cursorRow !== latestInput.cursorRow ||
        currentInput.currentLine !== selection.snapshotInput ||
        currentInput.cursorCol !== selection.snapshotCursor
      ) {
        return;
      }

      applyCompletion(selection);
    }
  }

  /** Reuse candidates only for a refinement of the same replacement span.
   * Rebuild edit snapshots before exposing them: an old LSP edit must never be
   * accepted against a different line, suffix, object, or multiline context. */
  refineInlineCompletion(input: InputSnapshot, context?: CompletionContext): import("../../Language/completion").CompletionQuickPickItem[] | undefined {
    this.completionRequestId++;
    const cached = this.inlineCache;
    if (!cached) return undefined;
    context ??= getCompletionContext(input.currentLine, input.cursorCol, input.textBeforeCursor,
      input.text.slice(input.textBeforeCursor.length));
    if (!context) return undefined;
    const safeEntries = refineCompletionEntries(cached, input, context);
    if (!safeEntries) return undefined;
    return toCompletionQuickPickItems(rankCompletionEntries(safeEntries, context.prefix, context), context);
  }

  cancelCompletion(): void {
    this.completionRequestId++;
    this.inlineCache = undefined;
    this.completionPickerAbort?.abort();
    this.completionPickerAbort = undefined;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }

    this.disposed = true;
    this.cancelCompletion();
    const lsp = this.consoleLsp;
    this.consoleLsp = undefined;
    this.completionDocument = undefined;
    this.sessionState = undefined;

    this.disposePromise = lsp ? lsp.dispose() : Promise.resolve();
    return this.disposePromise;
  }

  clearSessionState(): void {
    this.cancelCompletion();
    this.sessionState = { attachedPackages: [] };
    void this.consoleLsp?.syncSessionState(this.sessionState).catch(() => undefined);
    this.consoleLsp?.updateInput("");
  }

  updateInput(input: string): void {
    this.consoleLsp?.updateInput(input);
  }

  recordCompletion(input: string, start: number, selection: CompletionPickItem): void {
    this.consoleLsp?.recordCompletion(input, start, selection);
  }

  async refreshCompletionContextDocument(inputText: string): Promise<void> {
    this.updateInput(inputText);
    if (this.disposed || !this.completionDocument) {
      return;
    }
    try {
      const document = await this.getOrOpenCompletionDocument(inputText);
      if (document) {
        await this.consoleLsp?.prepareDocument(document);
      }
    } catch {
    }
  }

  updateSessionData(data: WorkspaceData | undefined): boolean {
    this.inlineCache = undefined;
    if (this.disposed || !data) {
      return false;
    }

    const nextState = this.toSessionState(data);
    if (
      this.sessionState &&
      this.arraysEqual(nextState.attachedPackages, this.sessionState.attachedPackages) &&
      JSON.stringify(nextState.functions) === JSON.stringify(this.sessionState.functions)
    ) {
      return false;
    }

    this.sessionState = nextState;
    if (this.consoleLsp) {
      void this.consoleLsp.syncSessionState(nextState).catch(() => undefined);
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
  ): Promise<vscode.TextDocument | undefined> {
    if (this.disposed) {
      return undefined;
    }
    try {
      return this.getOrUpdateCompletionDocument(
        content
      ) as unknown as vscode.TextDocument;
    } catch {
      return undefined;
    }
  }

  private isCurrentCompletionRequest(requestId: number): boolean {
    return requestId === this.completionRequestId;
  }

  private requestSilentCompletion(
    document: vscode.TextDocument,
    completionProvider: CompletionProvider
  ): void {
    if (this.silentCompletionRequest) {
      return;
    }

    this.silentCompletionRequest = (async () => {
      try {
        const position = document.positionAt(document.getText().length);
        await completionProvider.provideCompletionItems(document, position);
      } catch {
      } finally {
        this.silentCompletionRequest = undefined;
      }
    })();
  }

  private async ensureConsoleLspStarted(): Promise<ConsoleLspClient | undefined> {
    if (this.disposed) {
      return undefined;
    }

    let lsp = this.consoleLsp;
    if (!lsp) {
      lsp = new ConsoleLspClient({
        consoleId: this.completionDocumentId,
        extensionPath: this.options.extensionPath,
        rPath: this.options.rPath,
        env: this.options.env,
        cwd: this.options.cwd,
        inspectRuntimeCompletion: this.options.inspectRuntimeCompletion,
        onPackagesChanged: () => {
          this.cancelCompletion();
          this.options.onPackagesChanged?.();
        },
      });
      this.consoleLsp = lsp;
    }

    try {
      const initialState = this.sessionState;
      if (initialState) {
        await lsp.syncSessionState(initialState);
      } else {
        await lsp.start();
      }
      if (this.disposed || this.consoleLsp !== lsp) {
        return undefined;
      }
      if (this.sessionState && this.sessionState !== initialState) {
        await lsp.syncSessionState(this.sessionState);
      }
      return this.disposed || this.consoleLsp !== lsp ? undefined : lsp;
    } catch {
      return undefined;
    }
  }

  private shouldRequestWorkspaceData(
    context: NonNullable<ReturnType<typeof getCompletionContext>>
  ): boolean {
    return context.kind !== "member" && context.kind !== "package";
  }

  private toSessionState(data: WorkspaceData): ConsoleSessionState {
    const functions = Object.fromEntries(Object.entries(data.globalenv)
      .filter(([, item]) => ["closure", "builtin", "special"].includes(item.type) && item.str)
      .map(([name, item]) => [name, item.str ?? ""]));
    return {
      ...(Object.keys(functions).length ? { functions } : {}),
      attachedPackages: data.search
        .filter((value) => value.startsWith("package:"))
        .map((value) => value.slice(8)),
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
