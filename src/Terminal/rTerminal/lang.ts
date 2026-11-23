import { pickCompletion } from "./completionPicker";
import { refineCompletionEntries } from "../../Language/completion/refinement";
import * as vscode from "vscode";
import {
  type CompletionEntries,
  type CompletionContext,
  type CompletionProvider,
  CompletionPickItem,
  type RuntimeMemberCompletionRequester,
  type RuntimeFunctionSourceRequester,
  storedFunctionReceiver,
  collectCompletionEntries,
  collectStaticFallbackEntries,
  getStaticFallbackContext,
  parseRuntimeMemberQuery,
  getCompletionContext,
  rankCompletionEntries,
  isCompletionPickItem,
  toCompletionQuickPickItems,
} from "../../Language/completion";
import { ConsoleLspClient } from "../../Language/consoleLspClient";
import { clearCompletionDiagnosticsScope, logConsoleCompletionDecision, noteConsoleCompletionContext } from "../../Language/completion/outputChannel";
import { completionDecisionContext, type CompletionSuppressionReason } from "../../Language/completion/diagnostics";
import { VirtualRDocument } from "../../Language/virtualRDocument";
import type { WorkspaceData } from "../../Runtime/VSCR";
import type { MemberInspectionResult } from "../../Runtime/backendProtocol";

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
  onPackagesChanged?: () => void;
  getStaticAnalysisEnabled?: () => boolean;
  requestRuntimeMemberCompletions?: RuntimeMemberCompletionRequester;
  requestRuntimeFunctionSource?: RuntimeFunctionSourceRequester;
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
};

export class RTermLang {
  private completionRequestId = 0;
  private lastStaticAnalysisEnabled: boolean | undefined;
  private inlineCache: { input: InputSnapshot; context: CompletionContext; entries: CompletionEntries } | undefined;
  private completionDocument: VirtualRDocument | undefined;
  private readonly completionDocumentId = `${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  private consoleLsp: ConsoleLspClient | undefined;
  private sessionState: ConsoleSessionState | undefined;
  private runtimeLibraryPaths: string[] | undefined;
  private workspaceRevision: number | undefined;
  private cachedSessionData: WorkspaceData | undefined;
  private silentCompletionRequest: Promise<void> | undefined;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private completionPickerAbort: AbortController | undefined;

  constructor(private readonly options: LangOptions) {}

  get completionDiagnosticsScope(): string { return this.completionDocumentId; }

  // A native bracket lookup is independent of the language server. Start it
  // immediately, but keep LSP active for method arguments such as DT[, keyby.
  // Static-analysis mode continues to let source inference take precedence.
  private prefetchBracketMembers(context: CompletionContext): Promise<MemberInspectionResult | undefined> | undefined {
    const receiver = context.objectName;
    if (context.kind !== "bracket" || context.staticFallback || !receiver || !parseRuntimeMemberQuery(receiver)) return undefined;
    const requester = this.options.requestRuntimeMemberCompletions;
    if (!requester) return undefined;
    try {
      return Promise.resolve(requester(receiver, context.bracketOperator ?? "["))
        .catch(() => undefined);
    } catch {
      return undefined;
    }
  }

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
    const staticEnabled = this.options.getStaticAnalysisEnabled?.() === true;
    if (this.lastStaticAnalysisEnabled !== undefined &&
        this.lastStaticAnalysisEnabled !== staticEnabled) this.cancelCompletion();
    this.lastStaticAnalysisEnabled = staticEnabled;
    const requestId = ++this.completionRequestId;
    noteConsoleCompletionContext(completionDecisionContext(input.textBeforeCursor), this.completionDocumentId);
    let context = getCompletionContext(
      input.currentLine,
      input.cursorCol,
      input.textBeforeCursor,
      input.text.slice(input.textBeforeCursor.length)
    );
    if (staticEnabled && (context?.rejectionReason ||
        (context?.suppressAutomatic && input.textBeforeCursor.includes("[")))) {
      context = getStaticFallbackContext(input.currentLine, input.cursorCol,
        input.textBeforeCursor, input.text.slice(input.textBeforeCursor.length), context) ?? context;
    }
    context ??= (force
      ? {
          kind: "default" as const,
          prefix: "",
          replaceStart: input.cursorCol,
          snapshotInput: input.currentLine,
          snapshotCursor: input.cursorCol,
        }
      : undefined);
    if (context?.rejectionReason) {
      logConsoleCompletionDecision(staticEnabled
        ? { kind: "StaticUnavailable", reason: "unsupported-context" }
        : { kind: "Rejected", reason: context.rejectionReason },
        completionDecisionContext(input.textBeforeCursor), this.completionDocumentId);
      onInlineEntries?.([]);
      return;
    }
    if (!context || context.suppressAutomatic) {
      onInlineEntries?.([]);
      return;
    }

    {
      const cachedSessionData = getWorkspaceData() ?? this.cachedSessionData;

      const latestInput = getCurrentInput();
      if (
        latestInput.text !== input.text || latestInput.cursorRow !== input.cursorRow ||
        latestInput.currentLine !== context.snapshotInput ||
        latestInput.cursorCol !== context.snapshotCursor
      ) {
        return;
      }

      const recentEntries = this.options.getRecentSessionEntries?.() ?? [];

      let completionProvider: CompletionProvider | undefined;
      // Runtime-only member inspection is owned by the guarded native backend.
      // Do not make it wait for the separate language server to start or reply.
      const runtimeMember = context.kind === "member" && !context.staticFallback &&
        this.options.requestRuntimeMemberCompletions !== undefined &&
        (!staticEnabled || !!(context.objectName && parseRuntimeMemberQuery(context.objectName)));
      const prefetchedBracketMembers = this.prefetchBracketMembers(context);
      // Publish guarded bracket names as soon as they arrive. Do not hold
      // columns hostage to a slow or restarting language server; its method
      // parameters can enrich the same suggestions afterward.
      const stagedBracketEntries = prefetchedBracketMembers?.then(result =>
        staticEnabled && (result?.status === "suppressed" || result?.status === "missing")
          ? undefined : collectCompletionEntries(
          context, undefined, undefined,
          getWorkspaceData() ?? cachedSessionData,
          latestInput.lines.slice(0, latestInput.cursorRow),
          recentEntries, undefined, undefined, latestInput.text,
          Promise.resolve(result)
        )
      );
      const documentRequest = runtimeMember
        ? Promise.resolve(undefined) : this.getOrOpenCompletionDocument(latestInput.text);
      const fullEntriesPromise = (async () => {
        completionProvider = runtimeMember ? undefined : await this.ensureConsoleLspStarted();
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
          getWorkspaceData() ?? cachedSessionData;
        return await this.collectRoutedEntries(
          context, document, position, sessionData, linesBefore, recentEntries,
          completionProvider, latestInput.text, prefetchedBracketMembers, requestId
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

      const opensBeforeFullResults = (force && context.kind !== "argument") ||
        !!stagedEntries?.length || !!stagedBracketEntries;
      const entries = stagedEntries?.length
        ? stagedEntries
        : opensBeforeFullResults
        ? []
        : await fullEntriesPromise;
      if (!this.isCurrentCompletionRequest(requestId)) {
        return;
      }

      if (!entries || entries.length === 0) {
        // Tab may open an empty picker while bracket inspection is pending.
        // Its staged columns and LSP method arguments populate it afterward.
        if (!force && !onInlineEntries && !opensBeforeFullResults) {
          return;
        }
      }
      const initialEntries = entries ?? [];

      if (onInlineEntries) {
        let publishedPhase = -1;
        const publish = (results: CompletionEntries, phase: number): void => {
          if (phase < publishedPhase || !this.isCurrentCompletionRequest(requestId)) return;
          const current = getCurrentInput();
          if (current.text !== latestInput.text || current.cursorRow !== latestInput.cursorRow ||
              current.cursorCol !== context.snapshotCursor) return;
          publishedPhase = phase;
          this.inlineCache = { input: latestInput, context, entries: results };
          onInlineEntries(toCompletionQuickPickItems(rankCompletionEntries(results, context.prefix, context), context));
        };
        if (initialEntries.length || !opensBeforeFullResults) publish(initialEntries, 0);
        void stagedBracketEntries?.then(results => {
          if (results) publish(results, 1);
        }).catch(() => undefined);
        if (opensBeforeFullResults) {
          void fullEntriesPromise.then(results => {
            if (results) publish(results, 2);
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
        stagedEntries: stagedBracketEntries,
        delayedEntries: opensBeforeFullResults ? fullEntriesPromise : undefined,
        force, isCurrent: () => this.isCurrentCompletionRequest(requestId),
        collect: async (nextContext, nextInputText, lines, cursorCol, onStagedEntries) => {

          if (nextContext.rejectionReason && staticEnabled) {
            nextContext = getStaticFallbackContext(lines[latestInput.cursorRow], cursorCol,
              [...lines.slice(0, latestInput.cursorRow),
                lines[latestInput.cursorRow].slice(0, cursorCol)].join("\n"),
              nextInputText.slice([...lines.slice(0, latestInput.cursorRow),
                lines[latestInput.cursorRow].slice(0, cursorCol)].join("\n").length)) ?? nextContext;
          }
          if (nextContext.rejectionReason) return [];
          const nextRuntimeMember = nextContext.kind === "member" && !nextContext.staticFallback &&
            this.options.requestRuntimeMemberCompletions !== undefined &&
            (!staticEnabled || !!(nextContext.objectName && parseRuntimeMemberQuery(nextContext.objectName)));
          const nextBracketMembers = this.prefetchBracketMembers(nextContext);
          // Refinements need the same early native results as the initial
          // picker. The picker guards these against newer queries and the
          // final LSP merge, and rebases edits to the actual console input.
          void nextBracketMembers?.then(result => staticEnabled &&
            (result?.status === "suppressed" || result?.status === "missing")
            ? undefined : collectCompletionEntries(
            nextContext, undefined, undefined, getWorkspaceData() ?? cachedSessionData,
            lines.slice(0, latestInput.cursorRow), recentEntries, undefined, undefined,
            nextInputText, Promise.resolve(result)
          )).then(entries => { if (entries) onStagedEntries(entries); }).catch(() => undefined);
          const nextDocumentRequest = nextRuntimeMember
            ? Promise.resolve(undefined) : this.getOrOpenCompletionDocument(nextInputText);
          if (!completionProvider && !nextRuntimeMember) {
            completionProvider = await this.ensureConsoleLspStarted();
          }
          const nextDocument = await nextDocumentRequest;
          if (!this.isCurrentCompletionRequest(requestId)) {
            return;
          }
          const refinedSessionData =
            getWorkspaceData() ?? cachedSessionData;
          return await this.collectRoutedEntries(
            nextContext, nextDocument, new vscode.Position(latestInput.cursorRow, cursorCol),
            refinedSessionData, lines.slice(0, latestInput.cursorRow),
            recentEntries, completionProvider, nextInputText, nextBracketMembers,
            requestId, false
          );
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

  /**
   * Preserve native completion for stored receivers. Only a definitive safety
   * refusal is routed to static source inference, never a successful empty
   * result or a transiently unavailable R session.
   */
  private async collectRoutedEntries(
    context: CompletionContext,
    document: vscode.TextDocument | undefined,
    position: vscode.Position,
    sessionData: WorkspaceData | undefined,
    linesBefore: string[],
    recentEntries: string[],
    provider: CompletionProvider | undefined,
    inputText: string,
    bracketInspection: Promise<MemberInspectionResult | undefined> | undefined,
    requestId: number,
    logOutcome = true
  ): Promise<CompletionEntries | undefined> {
    const staticEnabled = this.options.getStaticAnalysisEnabled?.() === true;
    const fallback = async (logUnresolved = true, runtimeReason?: CompletionSuppressionReason): Promise<CompletionEntries | undefined> => {
      const lsp = provider ?? await this.ensureConsoleLspStarted();
      if (!this.isCurrentCompletionRequest(requestId)) return undefined;
      const doc = document ?? await this.getOrOpenCompletionDocument(inputText);
      if (!this.isCurrentCompletionRequest(requestId)) return undefined;
      if (!doc || !lsp) {
        if (logOutcome && logUnresolved) {
          logConsoleCompletionDecision({ kind: "StaticUnavailable",
            reason: !lsp ? "provider-unavailable" : "document-unavailable", runtimeReason },
            completionDecisionContext(inputText), this.completionDocumentId);
        }
        // A missing language server or document is not an authoritative empty
        // result. Keep inline completion retryable after the provider recovers.
        const pending = [] as CompletionEntries;
        pending.isIncomplete = true;
        return pending;
      }
      // Source inference must also see functions defined in earlier submissions.
      // Request their *current* stored closure AST from the guarded idle R host;
      // never execute a call or persist submitted function bodies.
      const cursorOffset = linesBefore.join("\n").length + (linesBefore.length ? 1 : 0) + position.character;
      const receiver = storedFunctionReceiver(context, inputText, cursorOffset);
      let sourceDefinition: { name: string; body: string } | undefined;
      if (receiver && this.options.requestRuntimeFunctionSource) {
        try {
          const body = await this.options.requestRuntimeFunctionSource(receiver);
          if (body && Buffer.byteLength(body, "utf8") <= 64 * 1024) {
            sourceDefinition = { name: receiver, body };
          }
        } catch {
          // An unavailable, active or deferred binding is not source evidence.
        }
      }
      if (!this.isCurrentCompletionRequest(requestId)) return undefined;
      const entries = await collectStaticFallbackEntries(context, doc, position, linesBefore, lsp, sourceDefinition);
      if (this.isCurrentCompletionRequest(requestId) && logOutcome &&
          (entries.staticResolved || logUnresolved)) {
        logConsoleCompletionDecision(entries.staticResolved ? { kind: "StaticInferred" } : {
          kind: "StaticUnavailable", reason: entries.staticUnavailableReason, runtimeReason,
        }, completionDecisionContext(inputText.slice(0,
          linesBefore.join("\n").length + (linesBefore.length ? 1 : 0) + position.character)),
        this.completionDocumentId);
      }
      return this.isCurrentCompletionRequest(requestId) ? entries : undefined;
    };

    if (context.staticFallback) return staticEnabled ? fallback() : [];
    const requester = this.options.requestRuntimeMemberCompletions;
    // A cached workspace snapshot may be stale or unavailable. Only the
    // native inspector's explicit missing-root status authorizes source
    // inference for an unsubmitted definition; available([]) stays live.
    if (staticEnabled && context.kind === "member" && requester &&
        context.objectName && parseRuntimeMemberQuery(context.objectName)) {
      const result = await Promise.resolve(requester(context.objectName, context.operator ?? "$"))
        .catch(() => undefined);
      if (!this.isCurrentCompletionRequest(requestId)) return undefined;
      if (result?.status === "suppressed") return fallback(true, result.reason);
      if (result?.status === "missing") return fallback(false);
      return collectCompletionEntries(context, undefined, undefined, sessionData,
        linesBefore, recentEntries, undefined, () => Promise.resolve(result), inputText);
    }
    if (staticEnabled && context.kind === "bracket" && bracketInspection) {
      const result = await bracketInspection.catch(() => undefined);
      if (!this.isCurrentCompletionRequest(requestId)) return undefined;
      if (result?.status === "suppressed") return fallback(true, result.reason);
      if (result?.status === "missing") return fallback(false);
      bracketInspection = Promise.resolve(result);
    }
    return collectCompletionEntries(context, document, document ? position : undefined,
      sessionData, linesBefore, recentEntries, provider, requester, inputText,
      bracketInspection, staticEnabled && context.kind === "bracket" && bracketInspection
        ? "runtime" : undefined);
  }

  /** Reuse candidates only for a refinement of the same replacement span.
   * Rebuild edit snapshots before exposing them: an old LSP edit must never be
   * accepted against a different line, suffix, object, or multiline context. */
  refineInlineCompletion(input: InputSnapshot, context?: CompletionContext): import("../../Language/completion").CompletionQuickPickItem[] | undefined {
    if (this.lastStaticAnalysisEnabled !== undefined &&
        this.lastStaticAnalysisEnabled !== (this.options.getStaticAnalysisEnabled?.() === true)) {
      this.cancelCompletion();
      return undefined;
    }
    this.completionRequestId++;
    const cached = this.inlineCache;
    if (!cached) return undefined;
    context ??= getCompletionContext(input.currentLine, input.cursorCol, input.textBeforeCursor,
      input.text.slice(input.textBeforeCursor.length));
    if (this.options.getStaticAnalysisEnabled?.() === true &&
        (context?.rejectionReason || (context?.suppressAutomatic && input.textBeforeCursor.includes("[")))) {
      context = getStaticFallbackContext(input.currentLine, input.cursorCol,
        input.textBeforeCursor, input.text.slice(input.textBeforeCursor.length), context);
    }
    if (!context) return undefined;
    const safeEntries = refineCompletionEntries(cached, input, context);
    if (!safeEntries) return undefined;
    return toCompletionQuickPickItems(rankCompletionEntries(safeEntries, context.prefix, context), context);
  }

  /** True only after a successful, complete cache refinement in the same
   * member context. A partial language-server result must still be refreshed. */
  hasCompleteInlineMemberCache(): boolean {
    return this.inlineCache?.context.kind === "member" &&
      this.inlineCache.entries.isIncomplete !== true;
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
    clearCompletionDiagnosticsScope(this.completionDocumentId);
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
    this.runtimeLibraryPaths = undefined;
    this.consoleLsp?.resetRuntimeLibraryPaths?.();
    this.workspaceRevision = undefined;
    this.cachedSessionData = undefined;
    this.consoleLsp?.invalidateRuntimeCompletion?.();
    void this.consoleLsp?.syncSessionState(this.sessionState).catch(() => undefined);
    this.consoleLsp?.updateInput("");
  }

  updateInput(input: string): void {
    this.consoleLsp?.updateInput(input);
  }

  updateLibraryPaths(paths: string[]): void {
    if (this.disposed || this.arraysEqual(paths, this.runtimeLibraryPaths ?? [])) return;
    this.runtimeLibraryPaths = [...paths];
    this.inlineCache = undefined;
    this.cancelCompletion();
    this.consoleLsp?.updateRuntimeLibraryPaths(paths);
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
    if (this.disposed || !data) return false;
    this.cachedSessionData = data;

    // sess includes a stable revision in unchanged workspace responses.
    // Avoid cancelling suggestions on every ordinary completion-time poll.
    if (typeof data.revision === "number" && data.revision !== this.workspaceRevision) {
      this.workspaceRevision = data.revision;
      this.cancelCompletion();
      this.consoleLsp?.invalidateRuntimeCompletion?.();
    }
    const nextState = this.toSessionState(data);
    if (this.sessionState &&
        this.arraysEqual(nextState.attachedPackages, this.sessionState.attachedPackages)) {
      return false;
    }
    this.inlineCache = undefined;

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
    return requestId === this.completionRequestId &&
      this.lastStaticAnalysisEnabled === (this.options.getStaticAnalysisEnabled?.() === true);
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
        getCachedWorkspaceData: () => this.cachedSessionData,
        getStaticAnalysisEnabled: this.options.getStaticAnalysisEnabled,
        onPackagesChanged: () => {
          this.cancelCompletion();
          this.options.onPackagesChanged?.();
        },
      });
      this.consoleLsp = lsp;
      if (this.runtimeLibraryPaths) lsp.updateRuntimeLibraryPaths(this.runtimeLibraryPaths);
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

  private toSessionState(data: WorkspaceData): ConsoleSessionState {
    return {
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
