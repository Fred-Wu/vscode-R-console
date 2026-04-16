import * as vscode from "vscode";
import { Terminal as HeadlessTerminal, type IBufferCell, type IBufferLine } from "@xterm/headless";
import { spawnSync, ChildProcess } from "child_process";
import * as path from "path";
import * as os from "os";
import { CompletionPickItem } from "../Language/completion";
import { setNativeParseCallback } from "../Language/parser";
import {
  ANSI,
  stripBracketedPasteMarkers,
} from "./ansi";
import { ConsoleSyntax } from "./consoleSyntax";
import { HistoryManager } from "./history";
import { InputState } from "./inputState";
import { KeyProcessor, KeyAction } from "./keyProcessor";
import { Renderer } from "./renderer";
import {
  getContinuationPromptLength,
} from "./inputViewport";
import {
  type RTerminalOptions,
} from "./options";
import {
  RuntimeBackend,
} from "../Runtime/runtimeBackend";
import { SessionWatcher, WorkspaceData } from "../Runtime/sessionWatcher";
import {
  InputSnapshot,
  RTermLang,
} from "./rTerminal/lang";
import {
  buildInputRenderPlan,
  clearInputRender as clearViewInputRender,
  configureMainPrompt,
  getPromptRenderDelay as getViewPromptRenderDelay,
  getReplyPromptRenderDelay as getViewReplyPromptRenderDelay,
  type InputRenderPlan,
  renderInput as renderViewInput,
} from "./rTerminal/view";
import {
  createRuntimeBackend,
  enqueueRuntimeSubmission,
  finishRuntimeSubmission,
  getRuntimeTerminalName,
  interruptRuntime,
  type RuntimeHost,
  startNextRuntimeSubmission,
  type Submission,
  type TerminalMode,
  sendRuntimeReply,
  startRuntime,
} from "./rTerminal/runtime";

export { resolveRTerminalOptions } from "./options";

class TrackingWriteEmitter extends vscode.EventEmitter<string> {
  constructor(private readonly onFireCallback: (data: string) => void) {
    super();
  }

  override fire(data: string): void {
    this.onFireCallback(data);
    super.fire(data);
  }
}

type ReplayTerminal = HeadlessTerminal & {
  _core: {
    _writeBuffer: {
      writeSync(data: string): void;
    };
  };
};

type SerializedReplayRow = {
  plainText: string;
  styledText: string;
  wrapped: boolean;
};

type SerializedCellStyle = {
  fgMode: "default" | "palette" | "rgb";
  fg: number;
  bgMode: "default" | "palette" | "rgb";
  bg: number;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
};

export class RTerminal implements vscode.Pseudoterminal {
  private writeEmitter: vscode.EventEmitter<string>;
  private closeEmitter = new vscode.EventEmitter<number>();
  private nameEmitter = new vscode.EventEmitter<string>();
  private pidEmitter = new vscode.EventEmitter<number | undefined>();
  private lastKnownPid: number | undefined;

  get onDidWrite(): vscode.Event<string> {
    return this.writeEmitter.event;
  }
  get onDidClose(): vscode.Event<number> {
    return this.closeEmitter.event;
  }
  get onDidChangeName(): vscode.Event<string> {
    return this.nameEmitter.event;
  }
  get onDidChangePid(): vscode.Event<number | undefined> {
    return this.pidEmitter.event;
  }

  private rProcess: ChildProcess | null = null;
  private backendChildPid: number | undefined;
  private dimensions: { columns: number; rows: number } = { columns: 80, rows: 24 };

  private syntax: ConsoleSyntax;
  private renderer: Renderer;
  private inputState = new InputState();
  private keyProcessor = new KeyProcessor();

  private rHistory: HistoryManager;
  private historyBrowsing = false;
  private historyCollapsed = true;
  private escPendingClear = false;

  private sessionWatcher: SessionWatcher | undefined;
  private sessionAttached = false;

  private lang: RTermLang;

  private runtimeBackend: RuntimeBackend | undefined;
  private sessionHostConnected = false;

  private promptReady = false;
  promptKind: "main" | "cont" = "main";
  private promptVisible = false;
  private replyPromptText = "";
  private pendingPromptToken = false;
  private lastWriteEndedWithNewline = true;
  private hasReceivedOutput = false;
  private promptBlockStartRow = 0;
  private replayStartAbsoluteRow = 0;
  private terminalState: ReplayTerminal;
  private suppressTerminalStateCapture = false;
  private static readonly TERMINAL_SCROLLBACK = 5000;
  private pendingInitialPromptGap = false;
  private promptRenderTimer: NodeJS.Timeout | null = null;
  private replyPromptRenderTimer: NodeJS.Timeout | null = null;
  private lastOutputAt = 0;

  private mode: TerminalMode = "starting";
  private submissionPending = false;
  private awaitingExecutionStart = false;
  private pendingInputFlushTimer: NodeJS.Timeout | null = null;
  private pendingProgrammaticInput = "";
  private runtimeHostAdapter!: RuntimeHost;

  private programmaticSubmissionQueue: Promise<void> = Promise.resolve();
  private suppressNextEnterAfterPasteEnd = false;

  private submissionQueue: Submission[] = [];
  private activeSubmission: Submission | null = null;

  private inBracketPaste = false;
  private pasteBuffer = "";

  private autoMatch = true;
  private tabSize = 2;
  private lastSearchTerm = "";

  constructor(private options: RTerminalOptions, private extensionPath: string = "") {
    this.terminalState = this.createReplayTerminal();
    this.writeEmitter = this.createWriteEmitter();
    this.runtimeBackend = this.resolveRuntimeBackend();
    this.rHistory = new HistoryManager(path.join(os.homedir(), ".r_console_history"));
    this.rHistory.load();
    this.rHistory.setSearchNoDuplicates(true);
    this.lang = new RTermLang({
      extensionPath: this.extensionPath,
      rPath: this.options.rPath,
      getRecentSessionEntries: () => this.rHistory.getRecentSessionEntries(),
      requestMemberCompletions: async (expression, operator) =>
        await this.sessionWatcher?.requestMemberCompletions(expression, operator),
    });

    this.syntax = new ConsoleSyntax(
      () => {
        if (this.promptVisible) {
          this.renderInput();
        }
      },
      async (content) => await this.lang.requestSemanticTokens(content)
    );
    this.renderer = new Renderer((text) => this.writeEmitter.fire(text), this.syntax);

    if (options.sessionWatcherEnabled) {
      this.sessionWatcher = new SessionWatcher(options.watcherDir);
      this.sessionWatcher.onChange((data) => this.onSessionDataChanged(data));
    }

    this.loadSettings();
    this.runtimeHostAdapter = this.createRuntimeHost();
  }

  private createWriteEmitter(): vscode.EventEmitter<string> {
    return new TrackingWriteEmitter((data) => this.captureTerminalWrite(data));
  }

  private createReplayTerminal(): ReplayTerminal {
    return new HeadlessTerminal({
      cols: Math.max(20, this.dimensions.columns || 80),
      rows: Math.max(5, this.dimensions.rows || 24),
      scrollback: RTerminal.TERMINAL_SCROLLBACK,
      allowProposedApi: true,
    }) as ReplayTerminal;
  }

  private captureTerminalWrite(data: string): void {
    if (this.suppressTerminalStateCapture || data.length === 0) {
      return;
    }
    this.terminalState._core._writeBuffer.writeSync(data);
  }

  private withTerminalStateCaptureSuppressed<T>(action: () => T): T {
    const previous = this.suppressTerminalStateCapture;
    this.suppressTerminalStateCapture = true;
    try {
      return action();
    } finally {
      this.suppressTerminalStateCapture = previous;
    }
  }

  private syncReplayTerminalSize(): void {
    this.terminalState.resize(
      Math.max(20, this.dimensions.columns || 80),
      Math.max(5, this.dimensions.rows || 24)
    );
  }

  private loadSettings(): void {
    const config = vscode.workspace.getConfiguration("r.console");
    this.autoMatch = config.get<boolean>("autoMatch", true);
    this.tabSize = config.get<number>("tabSize", 2);
  }

  private runtimeHost(): RuntimeHost {
    return this.runtimeHostAdapter;
  }

  private createRuntimeHost(): RuntimeHost {
    const self = this;

    const host: RuntimeHost = {
      get options() {
        return self.options;
      },
      set options(value) {
        self.options = value;
      },
      get extensionPath() {
        return self.extensionPath;
      },
      set extensionPath(value) {
        self.extensionPath = value;
      },
      get runtimeBackend() {
        return self.runtimeBackend;
      },
      set runtimeBackend(value) {
        self.runtimeBackend = value;
      },
      get rProcess() {
        return self.rProcess;
      },
      set rProcess(value) {
        self.rProcess = value;
      },
      get backendChildPid() {
        return self.backendChildPid;
      },
      set backendChildPid(value) {
        self.backendChildPid = value;
      },
      get dimensions() {
        return self.dimensions;
      },
      set dimensions(value) {
        self.dimensions = value;
      },
      get mode() {
        return self.mode;
      },
      set mode(value) {
        self.mode = value;
      },
      get promptReady() {
        return self.promptReady;
      },
      set promptReady(value) {
        self.promptReady = value;
      },
      get promptKind() {
        return self.promptKind;
      },
      set promptKind(value) {
        self.promptKind = value;
      },
      get promptVisible() {
        return self.promptVisible;
      },
      set promptVisible(value) {
        self.promptVisible = value;
      },
      get replyPromptText() {
        return self.replyPromptText;
      },
      set replyPromptText(value) {
        self.replyPromptText = value;
      },
      get pendingPromptToken() {
        return self.pendingPromptToken;
      },
      set pendingPromptToken(value) {
        self.pendingPromptToken = value;
      },
      get pendingInitialPromptGap() {
        return self.pendingInitialPromptGap;
      },
      set pendingInitialPromptGap(value) {
        self.pendingInitialPromptGap = value;
      },
      get submissionPending() {
        return self.submissionPending;
      },
      set submissionPending(value) {
        self.submissionPending = value;
      },
      get awaitingExecutionStart() {
        return self.awaitingExecutionStart;
      },
      set awaitingExecutionStart(value) {
        self.awaitingExecutionStart = value;
      },
      get lastWriteEndedWithNewline() {
        return self.lastWriteEndedWithNewline;
      },
      set lastWriteEndedWithNewline(value) {
        self.lastWriteEndedWithNewline = value;
      },
      get hasReceivedOutput() {
        return self.hasReceivedOutput;
      },
      set hasReceivedOutput(value) {
        self.hasReceivedOutput = value;
      },
      get sessionAttached() {
        return self.sessionAttached;
      },
      set sessionAttached(value) {
        self.sessionAttached = value;
      },
      get sessionHostConnected() {
        return self.sessionHostConnected;
      },
      set sessionHostConnected(value) {
        self.sessionHostConnected = value;
      },
      get activeSubmission() {
        return self.activeSubmission;
      },
      set activeSubmission(value) {
        self.activeSubmission = value;
      },
      get submissionQueue() {
        return self.submissionQueue;
      },
      set submissionQueue(value) {
        self.submissionQueue = value;
      },
      get historyBrowsing() {
        return self.historyBrowsing;
      },
      set historyBrowsing(value) {
        self.historyBrowsing = value;
      },
      get historyCollapsed() {
        return self.historyCollapsed;
      },
      set historyCollapsed(value) {
        self.historyCollapsed = value;
      },
      get sessionWatcher() {
        return self.sessionWatcher;
      },
      set sessionWatcher(value) {
        self.sessionWatcher = value;
      },
      get inputState() {
        return self.inputState;
      },
      set inputState(value) {
        self.inputState = value;
      },
      get syntax() {
        return self.syntax;
      },
      set syntax(value) {
        self.syntax = value;
      },
      get renderer() {
        return self.renderer;
      },
      set renderer(value) {
        self.renderer = value;
      },
      get lang() {
        return self.lang;
      },
      set lang(value) {
        self.lang = value;
      },
      get writeEmitter() {
        return self.writeEmitter;
      },
      set writeEmitter(value) {
        self.writeEmitter = value;
      },
      get closeEmitter() {
        return self.closeEmitter;
      },
      set closeEmitter(value) {
        self.closeEmitter = value;
      },
      get nameEmitter() {
        return self.nameEmitter;
      },
      set nameEmitter(value) {
        self.nameEmitter = value;
      },
      clearPendingInputFlushTimer: () => self.clearPendingInputFlushTimer(),
      clearPromptRenderTimer: () => self.clearPromptRenderTimer(),
      clearReplyPromptRenderTimer: () => self.clearReplyPromptRenderTimer(),
      schedulePrompt: () => self.schedulePrompt(),
      scheduleReplyPrompt: () => self.scheduleReplyPrompt(),
      clearInputRender: () => self.clearInputRender(),
      renderInput: () => self.renderInput(),
      recordOutputActivity: () => self.recordOutputActivity(),
      isSessionProtocolActive: () => self.isSessionProtocolActive(),
      isSessionReadyForPrompt: () => self.isSessionReadyForPrompt(),
      startNextSubmission: () => self.startNextSubmission(),
      finishActiveSubmission: () => self.finishActiveSubmission(),
      getDisplayPid: () => self.getDisplayPid(),
      notifyDisplayPidChanged: () => self.notifyDisplayPidChanged(),
      onSessionDataChanged: (data) => self.onSessionDataChanged(data),
    };

    return host;
  }

  public refreshAppearance(): void {
    this.loadSettings();
    this.syntax.invalidateTheme();

    if (!this.promptVisible) {
      return;
    }

    this.clearInputRender();
    this.promptVisible = false;

    if (this.mode === "reply") {
      this.showReplyPrompt();
      return;
    }

    if (this.mode === "ready" && this.promptReady) {
      this.showPrompt();
    }
  }

  private resolveRuntimeBackend(): RuntimeBackend | undefined {
    return createRuntimeBackend(this.extensionPath);
  }

  private isSessionProtocolActive(): boolean {
    return Boolean(
      this.rProcess &&
        this.runtimeBackend &&
        this.sessionHostConnected &&
        this.runtimeBackend.canUseSessionCommands(this.rProcess)
    );
  }

  private isSessionReadyForPrompt(): boolean {
    // The console prompt must not depend on vscode-R's session watcher.
    // Missing watcher bootstrap packages should degrade watcher-driven
    // features only, not block the embedded R session from becoming interactive.
    return true;
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    void this.lang.start();

    if (initialDimensions) {
      this.dimensions = initialDimensions;
      this.syncReplayTerminalSize();
    }

    if (this.options.bracketedPaste) {
      this.writeEmitter.fire("\x1b[?2004h");
    }

    if (!this.isRunning()) {
      this.startR();
      return;
    }

    const hadPromptVisible = this.promptVisible;
    this.restoreTerminalState();
    // Defer the name update: VSCode drops nameEmitter events fired
    // synchronously during open() because the terminal UI hasn't attached yet.
    setTimeout(() => {
      this.nameEmitter.fire(getRuntimeTerminalName(this.runtimeHost()));
      this.notifyDisplayPidChanged();
    }, 0);

    if (hadPromptVisible) {
      this.promptVisible = false;
      if (this.mode === "reply") {
        this.showReplyPrompt();
        return;
      }
      if (this.mode === "ready" && this.promptReady) {
        this.showPrompt();
        return;
      }
    }

    if (this.mode === "reply") {
      if (!this.promptVisible) {
        this.scheduleReplyPrompt();
      }
      return;
    }

    if (!this.promptVisible && this.mode === "ready" && this.promptReady && this.pendingPromptToken) {
      this.schedulePrompt();
    }
  }

  close(): void {
    if (this.mode === "reply") {
      this.interruptR();
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    const previous = this.dimensions;
    const hadVisiblePrompt = this.promptVisible;
    const changed =
      dimensions.columns !== previous.columns || dimensions.rows !== previous.rows;

    if (!changed) {
      return;
    }

    if (hadVisiblePrompt) {
      this.promptVisible = false;
    }

    this.dimensions = dimensions;

    this.syncReplayTerminalSize();

    if (!this.rProcess) {
      return;
    }

    if (this.isSessionProtocolActive()) {
      this.runtimeBackend?.sendSessionCommand(this.rProcess, {
        type: "set-width",
        columns: dimensions.columns,
      });
    }

    this.repaintAfterResize(hadVisiblePrompt);

    if (!this.promptVisible && this.mode === "ready" && this.promptReady && this.pendingPromptToken) {
      this.schedulePrompt();
    }
  }

  handleInput(data: string): void {
    if (this.consumeBufferedProgrammaticInput(data)) {
      return;
    }
    if (this.shouldBufferProgrammaticInput(data)) {
      this.bufferProgrammaticInput(data);
      return;
    }
    if (this.shouldHandleAsProgrammaticSubmission(data)) {
      this.queueProgrammaticSubmission(data);
      return;
    }
    if (this.mode === "executing" && this.isSessionProtocolActive()) {
      const hasCtrlC =
        data.includes("\x03") ||
        this.keyProcessor.parseInputChunk(data).some((action) => action.type === "ctrl_c");
      if (hasCtrlC) {
        this.interruptR();
      }
      return;
    }
    const actions = this.keyProcessor.parseInputChunk(data);
    for (const action of actions) {
      if (this.suppressNextEnterAfterPasteEnd) {
        this.suppressNextEnterAfterPasteEnd = false;
        if (action.type === "enter") {
          continue;
        }
      }
      this.applyKeyAction(action);
    }
  }

  private consumeBufferedProgrammaticInput(data: string): boolean {
    if (this.pendingProgrammaticInput.length === 0 && !this.pendingInputFlushTimer) {
      return false;
    }

    // VS Code may deliver sendText(text, true) to custom terminals as a text
    // chunk followed by Enter in a separate handleInput call on Windows.
    const combined = `${this.pendingProgrammaticInput}${data}`;
    if (this.shouldHandleAsProgrammaticSubmission(combined)) {
      this.pendingProgrammaticInput = "";
      this.clearPendingInputFlushTimer();
      this.queueProgrammaticSubmission(combined);
      return true;
    }

    if (this.shouldBufferProgrammaticInput(data)) {
      this.bufferProgrammaticInput(data);
      return true;
    }

    const buffered = this.pendingProgrammaticInput;
    this.pendingProgrammaticInput = "";
    this.clearPendingInputFlushTimer();
    this.flushBufferedProgrammaticInput(buffered);
    return false;
  }

  private shouldHandleAsProgrammaticSubmission(data: string): boolean {
    if (!this.canAcceptProgrammaticSubmission()) {
      return false;
    }

    const normalized = this.normalizeProgrammaticInput(data);
    return (
      normalized.includes("\n") &&
      normalized.trim().length > 0 &&
      !normalized.includes("\x1b") &&
      !normalized.includes("\x03")
    );
  }

  private shouldBufferProgrammaticInput(data: string): boolean {
    if (!this.canAcceptProgrammaticSubmission()) {
      return false;
    }

    const normalized = this.normalizeProgrammaticInput(data);
    return normalized.length > 1 && this.isPlainTextInputChunk(normalized);
  }

  private canAcceptProgrammaticSubmission(): boolean {
    return (
      !this.inBracketPaste &&
      this.mode !== "closed" &&
      this.mode !== "reply" &&
      this.inputState.text.length === 0 &&
      this.inputState.isAtEnd
    );
  }

  private normalizeProgrammaticInput(data: string): string {
    return data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  private isPlainTextInputChunk(data: string): boolean {
    if (!data || data.includes("\n") || data.includes("\x1b") || data.includes("\x03")) {
      return false;
    }

    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code === 127) {
        return false;
      }
    }

    return true;
  }

  private bufferProgrammaticInput(data: string): void {
    this.pendingProgrammaticInput += data;
    this.clearPendingInputFlushTimer();
    this.pendingInputFlushTimer = setTimeout(() => {
      this.pendingInputFlushTimer = null;
      const buffered = this.pendingProgrammaticInput;
      this.pendingProgrammaticInput = "";
      if (!buffered) {
        return;
      }
      this.flushBufferedProgrammaticInput(buffered);
    }, this.getProgrammaticSubmissionFlushDelay());
  }

  private getProgrammaticSubmissionFlushDelay(): number {
    const configuredDelay = vscode.workspace.getConfiguration("r").get<number>("rtermSendDelay", 8) ?? 8;
    const sendDelay = Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 8;
    return Math.max(40, sendDelay * 4);
  }

  private flushBufferedProgrammaticInput(data: string): void {
    if (!data) {
      return;
    }

    if (this.mode !== "ready" || !this.promptReady) {
      this.pendingProgrammaticInput = data;
      this.clearPendingInputFlushTimer();
      this.pendingInputFlushTimer = setTimeout(() => {
        this.pendingInputFlushTimer = null;
        const buffered = this.pendingProgrammaticInput;
        this.pendingProgrammaticInput = "";
        if (!buffered) {
          return;
        }
        this.flushBufferedProgrammaticInput(buffered);
      }, this.getProgrammaticSubmissionFlushDelay());
      return;
    }

    this.applyKeyAction({ type: "text", text: data });
  }

  private shouldSuppressEnterAfterPasteEnd(content: string): boolean {
    const normalized = stripBracketedPasteMarkers(content)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    return normalized.includes("\n");
  }

  private queueProgrammaticSubmission(data: string): void {
    this.programmaticSubmissionQueue = this.programmaticSubmissionQueue.then(
      async () => this.handleQueuedProgrammaticSubmission(data),
      async () => this.handleQueuedProgrammaticSubmission(data)
    );
  }

  private async handleQueuedProgrammaticSubmission(data: string): Promise<void> {
    if (this.mode === "closed") {
      return;
    }

    if (!this.canRunProgrammaticSubmission()) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.getProgrammaticSubmissionFlushDelay());
      });
      await this.handleQueuedProgrammaticSubmission(data);
      return;
    }

    await this.handleProgrammaticSubmission(data);
  }

  private canRunProgrammaticSubmission(): boolean {
    return (
      this.mode === "ready" &&
      this.promptReady &&
      this.inputState.text.length === 0 &&
      this.inputState.isAtEnd
    );
  }

  private async handleProgrammaticSubmission(data: string): Promise<void> {
    const normalized = stripBracketedPasteMarkers(data)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    const trimmed = normalized.replace(/\n+$/, "");
    const submission = trimmed.trimEnd();
    if (!submission) {
      return;
    }

    this.historyBrowsing = false;
    this.historyCollapsed = true;
    this.escPendingClear = false;
    this.rHistory.resetIndex();

    const blocks = await this.enqueueRSubmission(submission, false);
    if (blocks.length > 0) {
      this.recordSubmissionHistory(blocks);
      return;
    }

    const isComplete = await this.inputState.isExpressionCompleteAsync(submission);
    if (
      !isComplete &&
      this.mode === "ready" &&
      this.promptReady &&
      this.inputState.text.length === 0 &&
      this.inputState.isAtEnd
    ) {
      this.inputState.insertText(trimmed);
      this.renderInput();
    }
  }

  private applyKeyAction(action: KeyAction): void {
    if (this.mode === "closed") {
      return;
    }

    if (this.mode === "executing" || this.mode === "starting") {
      if (action.type === "ctrl_c") {
        this.interruptR();
      }
      return;
    }

    if (this.mode === "reply") {
      this.handleReplyInputAction(action);
      return;
    }

    if (this.mode !== "ready" || !this.promptReady) {
      return;
    }

    if (action.type !== "escape") {
      this.escPendingClear = false;
    }

    switch (action.type) {
      case "paste-start":
        this.inBracketPaste = true;
        this.pasteBuffer = "";
        return;
      case "paste-end":
        this.inBracketPaste = false;
        this.suppressNextEnterAfterPasteEnd = this.shouldSuppressEnterAfterPasteEnd(
          this.pasteBuffer
        );
        void this.handlePasteEnd();
        return;
      case "text":
        if (this.inBracketPaste) {
          this.pasteBuffer += action.text;
          return;
        }
        this.expandForEdit();
        this.handleTextInsert(action.text);
        this.renderInput();
        return;
      case "enter":
        void this.handleEnterKey();
        return;
      case "arrow":
        this.handleArrow(action.dir);
        return;
      case "backspace":
        this.expandForEdit();
        this.handleBackspace();
        this.renderInput();
        return;
      case "delete":
        this.expandForEdit();
        if (!this.inputState.isAtEnd) {
          this.inputState.deleteAfterCursor();
          this.renderInput();
        }
        return;
      case "home":
      case "ctrl_a":
        this.expandForEdit();
        this.inputState.cursorPosition += this.inputState.getStartOfLinePosition();
        this.renderInput();
        return;
      case "end":
      case "ctrl_e":
        this.expandForEdit();
        this.inputState.cursorPosition += this.inputState.getEndOfLinePosition();
        this.renderInput();
        return;
      case "word-left": {
        this.expandForEdit();
        const left = this.inputState.currentLineBeforeCursor;
        const match = left.match(/[\w.]+$/);
        const delta = match ? match[0].length : 1;
        this.inputState.cursorLeft(delta);
        this.renderInput();
        return;
      }
      case "word-right": {
        this.expandForEdit();
        const right = this.inputState.currentLineAfterCursor;
        const match = right.match(/^[\w.]+/);
        const delta = match ? match[0].length : 1;
        this.inputState.cursorRight(delta);
        this.renderInput();
        return;
      }
      case "tab": {
        this.expandForEdit();
        const beforeCursor = this.inputState.currentLineBeforeCursor;
        if (/^\s*$/.test(beforeCursor)) {
          this.inputState.insertText(" ".repeat(this.tabSize));
          this.renderInput();
        } else {
          void this.handleAutocomplete();
        }
        return;
      }
      case "backtab": {
        this.expandForEdit();
        const beforeCursor = this.inputState.currentLineBeforeCursor;
        const leadingSpaces = beforeCursor.match(/^\s*/)?.[0].length ?? 0;
        if (leadingSpaces > 0) {
          const toRemove = Math.min(this.tabSize, leadingSpaces);
          const cursorCol = this.inputState.cursorCol;
          this.inputState.cursorPosition -= cursorCol;
          this.inputState.deleteAfterCursor(toRemove);
          this.inputState.cursorPosition += Math.max(0, cursorCol - toRemove);
          this.renderInput();
        }
        return;
      }
      case "ctrl_r": {
        const term = this.inputState.currentLine.trim() || this.lastSearchTerm;
        if (!term) {
          return;
        }
        const found = this.rHistory.searchBackward(term);
        if (found !== null) {
          this.lastSearchTerm = term;
          this.historyBrowsing = true;
          this.historyCollapsed = true;
          this.inputState.applyHistoryEntry(found);
          this.renderInput();
        }
        return;
      }
      case "ctrl_l":
        if (this.promptVisible) {
          this.clearInputRender();
          this.promptVisible = false;
        }
        this.withTerminalStateCaptureSuppressed(() => {
          this.writeEmitter.fire("\x1b[H\x1b[2J\x1b[3J");
        });
        // Ctrl+L is a hard visual reset. Drop the replay buffer too so old
        // output cannot reappear on resize or terminal reattach.
        this.terminalState = this.createReplayTerminal();
        this.replayStartAbsoluteRow = 0;
        this.lastWriteEndedWithNewline = true;
        this.pendingInitialPromptGap = false;
        this.renderer.renderedLineCount = 1;
        this.renderer.cursorRowFromTop = 0;
        if (this.promptReady) {
          this.promptBlockStartRow = 0;
          this.renderInputFresh(this.buildCurrentInputRenderPlan());
          this.promptVisible = true;
        }
        return;
      case "escape":
        if (this.historyBrowsing) {
          if (!this.historyCollapsed) {
            this.clearInputRender();
            this.historyCollapsed = true;
            this.inputState.cursorToEnd();
            this.renderInput();
            this.escPendingClear = true;
          } else if (this.inputState.text.length > 0) {
            if (this.escPendingClear) {
              this.clearInputRender();
              this.historyBrowsing = false;
              this.historyCollapsed = true;
              this.inputState.reset();
              this.rHistory.resetIndex();
              this.renderInput();
              this.escPendingClear = false;
            } else {
              this.escPendingClear = true;
            }
          } else {
            this.historyBrowsing = false;
            this.historyCollapsed = true;
            this.rHistory.resetIndex();
            this.escPendingClear = false;
          }
        } else if (this.inputState.text.length > 0) {
          if (this.escPendingClear) {
            this.clearInputRender();
            this.inputState.reset();
            this.renderInput();
            this.escPendingClear = false;
          } else {
            this.escPendingClear = true;
          }
        }
        return;
      case "ctrl_c":
        if (this.inputState.text.length > 0) {
          this.clearInputRender();
          this.inputState.reset();
          this.historyBrowsing = false;
          this.historyCollapsed = true;
          this.rHistory.resetIndex();
          this.renderInput();
        }
        return;
      case "ctrl_d":
        if (this.inputState.text.length === 0) {
          void this.confirmAndClose();
        }
        return;
      case "ctrl_n":
        if (this.historyBrowsing && this.historyCollapsed) {
          this.navigateHistory(1);
        } else {
          const result = this.inputState.autoDown(this.getInputRenderMetrics());
          if (result === "history") {
            this.navigateHistory(1);
          } else {
            this.renderInput();
          }
        }
        return;
      case "ctrl_p":
        if (this.historyBrowsing && this.historyCollapsed) {
          this.navigateHistory(-1);
        } else {
          const result = this.inputState.autoUp(this.getInputRenderMetrics());
          if (result === "history") {
            this.navigateHistory(-1);
          } else {
            this.renderInput();
          }
        }
        return;
      default:
        return;
    }
  }

  private expandForEdit(): void {
    if (this.historyBrowsing && this.historyCollapsed) {
      this.clearInputRender();
      this.historyCollapsed = false;
    }
  }

  private handleArrow(dir: "up" | "down" | "left" | "right"): void {
    if (dir === "up") {
      if (this.historyBrowsing && this.historyCollapsed) {
        this.navigateHistory(-1);
        return;
      }
      const result = this.inputState.autoUp(this.getInputRenderMetrics());
      if (result === "history") {
        this.navigateHistory(-1);
      } else {
        this.renderInput();
      }
      return;
    }
    if (dir === "down") {
      if (this.historyBrowsing && this.historyCollapsed) {
        this.navigateHistory(1);
        return;
      }
      const result = this.inputState.autoDown(this.getInputRenderMetrics());
      if (result === "history") {
        this.navigateHistory(1);
      } else {
        this.renderInput();
      }
      return;
    }
    if (dir === "left" || dir === "right") {
      this.expandForEdit();
      if (dir === "left") {
        this.inputState.cursorLeft();
      } else {
        this.inputState.cursorRight();
      }
      this.renderInput();
    }
  }

  private handleBackspace(): void {
    if (this.inputState.isAtStart) {
      return;
    }

    if (this.autoMatch && this.inputState.isBetweenMatchingPair()) {
      this.inputState.deleteAfterCursor();
      this.inputState.deleteBeforeCursor();
      return;
    }

    const beforeOnLine = this.inputState.currentLineBeforeCursor;
    if (/^\s+$/.test(beforeOnLine)) {
      const toDelete = Math.min(this.tabSize, beforeOnLine.length);
      this.inputState.deleteBeforeCursor(toDelete);
      return;
    }

    this.inputState.deleteBeforeCursor();
  }

  private handleTextInsert(text: string): void {
    if (text.length === 1) {
      const handled = this.handleAutoBracket(text);
      if (handled) {
        return;
      }
    }

    this.inputState.insertText(text);
  }

  private handleAutoBracket(ch: string): boolean {
    if (!this.autoMatch) {
      if (this.inputState.isClosingBracket(ch)) {
        const dedent = this.inputState.calculateClosingBracketDedent(this.tabSize);
        if (dedent > 0) {
          this.inputState.deleteBeforeCursor(dedent);
        }
        this.inputState.insertText(ch);
        return true;
      }
      return false;
    }

    const closingBracket = this.inputState.getClosingBracket(ch);

    if (closingBracket && !this.inputState.isInString() && this.inputState.canAutoCloseBracket()) {
      if ((ch === '"' || ch === "'" || ch === "`") && this.inputState.currentChar === ch) {
        this.inputState.cursorRight();
        return true;
      }
      this.inputState.insertText(ch + closingBracket);
      this.inputState.cursorLeft();
      return true;
    }

    if (this.inputState.isClosingBracket(ch) && this.inputState.currentChar === ch) {
      this.inputState.cursorRight();
      return true;
    }

    if (this.inputState.isClosingBracket(ch)) {
      const dedent = this.inputState.calculateClosingBracketDedent(this.tabSize);
      if (dedent > 0) {
        this.inputState.deleteBeforeCursor(dedent);
      }
      this.inputState.insertText(ch);
      return true;
    }

    return false;
  }

  private async handlePasteEnd(): Promise<void> {
    if (this.pasteBuffer.length === 0) {
      return;
    }
    const content = stripBracketedPasteMarkers(this.pasteBuffer);
    this.pasteBuffer = "";
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    const endsWithNewline = normalized.endsWith("\n");
    const containsNewline = normalized.includes("\n");

    // Single-line paste must update the input buffer synchronously so a trailing
    // Enter action in the same input chunk executes that line immediately.
    if (!containsNewline && !endsWithNewline) {
      this.inputState.insertText(normalized);
      this.renderInput();
      return;
    }

    const cursorAtEnd = this.inputState.text.length === 0 || this.inputState.isAtEnd;
    const trimmed = normalized.replace(/\n+$/, "");
    const fullText = this.inputState.text + trimmed;

    const isComplete = await this.inputState.isExpressionCompleteAsync(fullText);

    if ((endsWithNewline || containsNewline) && cursorAtEnd && isComplete) {
      const submission = fullText.trimEnd();
      if (submission) {
        this.inputState.reset();
        this.historyBrowsing = false;
        this.historyCollapsed = true;
        this.rHistory.resetIndex();
        const blocks = await this.enqueueRSubmission(submission, !/[\r\n]/.test(submission));
        this.recordSubmissionHistory(blocks);
      }
      return;
    }

    this.inputState.insertText(trimmed);
    this.renderInput();
  }

  private handleReplyInputAction(action: KeyAction): void {
    switch (action.type) {
      case "ctrl_c":
        this.interruptR();
        return;
      case "paste-start":
        this.inBracketPaste = true;
        this.pasteBuffer = "";
        return;
      case "paste-end":
        this.inBracketPaste = false;
        if (this.pasteBuffer.length > 0) {
          const content = stripBracketedPasteMarkers(this.pasteBuffer);
          this.inputState.insertText(content);
          this.pasteBuffer = "";
          this.renderInput();
        }
        return;
      case "text":
        if (this.inBracketPaste) {
          this.pasteBuffer += action.text;
          return;
        }
        this.inputState.insertText(action.text);
        this.renderInput();
        return;
      case "backspace":
        if (!this.inputState.isAtStart) {
          this.inputState.deleteBeforeCursor();
          this.renderInput();
        }
        return;
      case "delete":
        if (!this.inputState.isAtEnd) {
          this.inputState.deleteAfterCursor();
          this.renderInput();
        }
        return;
      case "arrow":
        if (action.dir === "left") {
          this.inputState.cursorLeft();
        } else if (action.dir === "right") {
          this.inputState.cursorRight();
        }
        this.renderInput();
        return;
      case "home":
      case "ctrl_a":
        this.inputState.cursorPosition += this.inputState.getStartOfLinePosition();
        this.renderInput();
        return;
      case "end":
      case "ctrl_e":
        this.inputState.cursorPosition += this.inputState.getEndOfLinePosition();
        this.renderInput();
        return;
      case "enter": {
        const reply = this.inputState.text;
        this.sendReadlineReply(reply);
        return;
      }
      default:
        return;
    }
  }

  private async handleEnterKey(): Promise<void> {
    if (this.mode !== "ready") {
      return;
    }

    if (this.inputState.isBetweenCurlyBraces()) {
      const indent = this.inputState.calculateNewLineIndent(this.tabSize);
      const baseIndent = " ".repeat(Math.max(0, indent - this.tabSize));
      const newIndent = " ".repeat(indent);
      this.inputState.insertText("\n" + newIndent + "\n" + baseIndent);
      this.inputState.cursorPosition -= baseIndent.length + 1;
      this.renderInput();
      return;
    }

    const isComplete = await this.inputState.isExpressionCompleteAsync();
    if (!isComplete) {
      if (this.inputState.cursorCol === 0) {
        this.inputState.insertText("\n");
      } else {
        const indent = this.inputState.calculateNewLineIndent(this.tabSize);
        this.inputState.insertText("\n" + " ".repeat(indent));
      }
      this.renderInput();
      return;
    }

    if (!this.inputState.isAtEnd) {
      this.inputState.cursorPosition = this.inputState.text.length;
    }

    const fullText = this.inputState.text;
    if (!fullText.trim()) {
      this.inputState.reset();
      this.promptVisible = false;
      this.writeEmitter.fire("\r\n");
      this.lastWriteEndedWithNewline = true;
      this.renderer.renderedLineCount = 1;
      this.renderer.cursorRowFromTop = 0;
      this.pendingPromptToken = true;
      this.schedulePrompt();
      return;
    }

    const sanitized = stripBracketedPasteMarkers(fullText).trimEnd();
    if (this.promptVisible) {
      // Clear the live input viewport before any async submission work starts.
      // Otherwise semantic-token callbacks can rerender against the reset input
      // state and leave stale viewport content behind.
      this.clearInputRender();
      this.promptVisible = false;
      this.lastWriteEndedWithNewline = true;
    }
    this.inputState.reset();
    this.historyBrowsing = false;
    this.historyCollapsed = true;
    this.rHistory.resetIndex();

    if (!sanitized) {
      this.showPrompt();
      return;
    }

    const blocks = await this.enqueueRSubmission(
      sanitized,
      !/[\r\n]/.test(sanitized)
    );
    this.recordSubmissionHistory(blocks);
  }

  private navigateHistory(direction: number): void {
    const entry = this.rHistory.navigate(direction);
    if (entry === undefined) {
      return;
    }
    if (entry === null) {
      this.clearInputRender();
      this.historyBrowsing = false;
      this.historyCollapsed = true;
      this.inputState.reset();
      this.promptVisible = false;
      this.renderInput();
      this.promptVisible = true;
      return;
    }
    this.historyBrowsing = true;
    this.historyCollapsed = true;
    this.clearInputRender();
    this.inputState.applyHistoryEntry(entry);
    this.renderInput();
  }

  private getInputSnapshot(): InputSnapshot {
    return {
      text: this.inputState.text,
      currentLine: this.inputState.currentLine,
      cursorCol: this.inputState.cursorCol,
      cursorRow: this.inputState.cursorRow,
      lines: [...this.inputState.lines],
      textBeforeCursor: this.inputState.textBeforeCursor,
    };
  }

  private async handleAutocomplete(): Promise<void> {
    this.sessionWatcher?.refresh();
    await this.lang.handleAutocomplete({
      input: this.getInputSnapshot(),
      getCurrentInput: () => this.getInputSnapshot(),
      getWorkspaceData: () => this.sessionWatcher?.getWorkspaceData(),
      applyCompletion: (selection) => {
        this.applyCompletion(selection);
      },
    });
  }

  private applyCompletion(selection: CompletionPickItem): void {
    const currentLine = this.inputState.currentLine;
    const before = currentLine.slice(0, selection.replaceStart);
    const after = currentLine.slice(this.inputState.cursorCol);
    const newLine = `${before}${selection.insertText}${after}`;

    const lines = this.inputState.lines;
    lines[this.inputState.cursorRow] = newLine;

    const cursorInsideEmptyCall = selection.insertText.endsWith("()") ? 1 : 0;
    const newCursorCol = before.length + selection.insertText.length - cursorInsideEmptyCall;
    this.inputState.text = lines.join("\n");
    this.inputState.cursorPosition = this.inputState.translateRowColToIndex(
      this.inputState.cursorRow,
      newCursorCol
    );
    this.renderInput();
  }

  private onSessionDataChanged(data: WorkspaceData | undefined): void {
    if (!this.lang.updateSessionData(data)) {
      return;
    }
    void this.lang.refreshCompletionContextDocument(this.inputState.text);
    this.refreshSyntax();
  }

  private startR(): void {
    startRuntime(this.runtimeHost());
  }

  finishActiveSubmission(): void {
    finishRuntimeSubmission(this.runtimeHost());
  }

  private async enqueueRSubmission(
    code: string,
    skipSplit: boolean = false
  ): Promise<string[]> {
    return await enqueueRuntimeSubmission(this.runtimeHost(), code, skipSplit);
  }

  private recordSubmissionHistory(blocks: string[]): void {
    for (const block of blocks) {
      if (block.trim()) {
        this.rHistory.push(block);
      }
    }
  }

  private startNextSubmission(): void {
    startNextRuntimeSubmission(this.runtimeHost());
  }

  private sendReadlineReply(text: string): void {
    sendRuntimeReply(this.runtimeHost(), text);
  }

  private interruptR(): void {
    interruptRuntime(this.runtimeHost());
  }

  private schedulePrompt(): void {
    this.clearPromptRenderTimer();
    if (!this.pendingPromptToken || !this.promptReady) {
      return;
    }
    if (this.mode !== "ready") {
      return;
    }
    if (!this.isSessionReadyForPrompt()) {
      return;
    }

    const delay = this.getPromptRenderDelay();
    if (delay <= 0) {
      this.showPrompt();
      return;
    }

    this.promptRenderTimer = setTimeout(() => {
      this.promptRenderTimer = null;
      if (!this.pendingPromptToken || !this.promptReady) {
        return;
      }
      if (this.mode !== "ready") {
        return;
      }
      if (!this.isSessionReadyForPrompt()) {
        return;
      }
      this.showPrompt();
    }, delay);
  }

  private clearPromptRenderTimer(): void {
    if (!this.promptRenderTimer) {
      return;
    }
    clearTimeout(this.promptRenderTimer);
    this.promptRenderTimer = null;
  }

  scheduleReplyPrompt(): void {
    this.clearReplyPromptRenderTimer();
    if (this.mode !== "reply") {
      return;
    }

    const delay = this.getReplyPromptRenderDelay();
    if (delay <= 0) {
      this.showReplyPrompt();
      return;
    }

    this.replyPromptRenderTimer = setTimeout(() => {
      this.replyPromptRenderTimer = null;
      if (this.mode !== "reply") {
        return;
      }
      this.showReplyPrompt();
    }, delay);
  }

  private clearReplyPromptRenderTimer(): void {
    if (!this.replyPromptRenderTimer) {
      return;
    }
    clearTimeout(this.replyPromptRenderTimer);
    this.replyPromptRenderTimer = null;
  }

  private getPromptRenderDelay(): number {
    return getViewPromptRenderDelay(this.pendingInitialPromptGap, this.lastOutputAt);
  }

  private getInputRenderMetrics(): {
    columns: number;
    promptLen: number;
    continuationPromptLen: number;
  } {
    return {
      columns: this.dimensions.columns,
      promptLen: this.renderer.promptLen,
      continuationPromptLen: getContinuationPromptLength(
        this.renderer.continuationPromptText
      ),
    };
  }

  private getReplyPromptRenderDelay(): number {
    return getViewReplyPromptRenderDelay(this.lastOutputAt);
  }

  recordOutputActivity(): void {
    this.lastOutputAt = Date.now();
  }

  private configureRendererPrompt(): void {
    configureMainPrompt(this.renderer);
  }

  private restoreTerminalState(): void {
    const replay = this.buildTerminalReplay();
    if (replay.lines.length === 0) {
      return;
    }

    this.withTerminalStateCaptureSuppressed(() => {
      replay.lines.forEach((line, index) => {
        this.writeEmitter.fire(line);
        if (index < replay.lines.length - 1) {
          this.writeEmitter.fire("\r\n");
        }
      });

      const deltaUp = replay.finalRow - replay.cursorRow;
      if (deltaUp > 0) {
        this.writeEmitter.fire(`\x1b[${deltaUp}A`);
      }
      this.writeEmitter.fire(`\r\x1b[${replay.cursorCol + 1}G`);
    });
  }

  private restoreVisibleTerminalState(): void {
    const replay = this.buildVisibleTerminalReplay();
    if (replay.lines.length === 0) {
      return;
    }

    this.withTerminalStateCaptureSuppressed(() => {
      replay.lines.forEach((line, index) => {
        this.writeEmitter.fire(`\x1b[${index + 1};1H`);
        this.writeEmitter.fire(line);
      });
      this.writeEmitter.fire(`\x1b[${replay.cursorRow + 1};${replay.cursorCol + 1}H`);
    });
  }

  private buildTerminalReplay(): {
    lines: string[];
    finalRow: number;
    cursorRow: number;
    cursorCol: number;
  } {
    const buffer = this.terminalState.buffer.active;
    const rawRows = Array.from({ length: buffer.length }, (_, index) =>
      this.serializeReplayRow(buffer.getLine(index))
    );
    const cursorAbsoluteRow = buffer.baseY + buffer.cursorY;
    const baselineRow = Math.max(0, Math.min(this.replayStartAbsoluteRow, rawRows.length));
    const firstContentOffset = rawRows
      .slice(baselineRow)
      .findIndex((row) => row.plainText.trimEnd().length > 0);
    const firstContentRow =
      firstContentOffset === -1 ? -1 : baselineRow + firstContentOffset;
    let lastContentRow = -1;
    for (let index = rawRows.length - 1; index >= baselineRow; index -= 1) {
      if (rawRows[index]?.plainText.trimEnd().length) {
        lastContentRow = index;
        break;
      }
    }
    const rowStart = Math.max(
      baselineRow,
      firstContentRow === -1 ? cursorAbsoluteRow : Math.min(firstContentRow, cursorAbsoluteRow)
    );
    const rowEnd = Math.max(lastContentRow, cursorAbsoluteRow);

    if (rowEnd < rowStart) {
      return { lines: [], finalRow: 0, cursorRow: 0, cursorCol: 0 };
    }

    const rows = rawRows.slice(rowStart, rowEnd + 1);
    const adjustedCursorRow = cursorAbsoluteRow - rowStart;
    const lines: Array<{ plainText: string; styledText: string }> = [];
    const rowOffsets: Array<{ lineIndex: number; offset: number }> = [];

    rows.forEach((row, index) => {
      if (index === 0 || !row.wrapped || lines.length === 0) {
        lines.push({
          plainText: row.plainText,
          styledText: row.styledText,
        });
        rowOffsets[index] = { lineIndex: lines.length - 1, offset: 0 };
        return;
      }

      const offset = lines[lines.length - 1]?.plainText.length ?? 0;
      lines[lines.length - 1] = {
        plainText: `${lines[lines.length - 1]?.plainText ?? ""}${row.plainText}`,
        styledText: `${lines[lines.length - 1]?.styledText ?? ""}${row.styledText}`,
      };
      rowOffsets[index] = { lineIndex: lines.length - 1, offset };
    });

    const cursorOffset = rowOffsets[adjustedCursorRow] ?? {
      lineIndex: Math.max(0, lines.length - 1),
      offset: 0,
    };
    const absoluteCursorCol = cursorOffset.offset + buffer.cursorX;
    const safeColumns = Math.max(1, this.dimensions.columns || 80);
    const wrapRows = lines.map((line) => Math.max(1, Math.ceil(line.plainText.length / safeColumns)));
    const finalRow = wrapRows.reduce((sum, count) => sum + count, 0) - 1;
    const cursorRow =
      wrapRows.slice(0, cursorOffset.lineIndex).reduce((sum, count) => sum + count, 0) +
      Math.floor(absoluteCursorCol / safeColumns);

    return {
      lines: lines.map((line) => line.styledText),
      finalRow,
      cursorRow,
      cursorCol: absoluteCursorCol % safeColumns,
    };
  }

  private buildVisibleTerminalReplay(maxRows?: number): {
    lines: string[];
    finalRow: number;
    cursorRow: number;
    cursorCol: number;
  } {
    const buffer = this.terminalState.buffer.active;
    const viewportStart = buffer.viewportY;
    const visibleRows = Array.from({ length: this.dimensions.rows }, (_, index) =>
      this.serializeReplayRow(buffer.getLine(viewportStart + index), true)
    );

    let lastContentRow = -1;
    for (let index = visibleRows.length - 1; index >= 0; index -= 1) {
      if (visibleRows[index]?.plainText.trimEnd().length) {
        lastContentRow = index;
        break;
      }
    }

    const finalRow = Math.max(lastContentRow, buffer.cursorY);
    if (finalRow < 0) {
      return { lines: [], finalRow: 0, cursorRow: 0, cursorCol: 0 };
    }

    const replayLines = visibleRows.slice(0, finalRow + 1).map((row) => row.styledText);
    const boundedRows =
      maxRows === undefined
        ? replayLines.length
        : Math.max(0, Math.min(maxRows, replayLines.length));
    const firstVisibleRow = Math.max(0, replayLines.length - boundedRows);
    const lines = replayLines.slice(firstVisibleRow);

    return {
      lines,
      finalRow: Math.max(0, lines.length - 1),
      cursorRow:
        lines.length > 0
          ? Math.max(0, Math.min(buffer.cursorY - firstVisibleRow, lines.length - 1))
          : 0,
      cursorCol: buffer.cursorX,
    };
  }

  private serializeReplayRow(
    line: IBufferLine | undefined,
    trimTrailingWhitespace = false
  ): SerializedReplayRow {
    if (!line) {
      return {
        plainText: "",
        styledText: "",
        wrapped: false,
      };
    }

    let plainText = "";
    let styledText = "";
    let activeStyleKey = this.serializeCellStyleKey(this.getDefaultSerializedCellStyle());
    const defaultStyleKey = activeStyleKey;
    let lastCellIndex = line.length - 1;

    if (trimTrailingWhitespace) {
      while (lastCellIndex >= 0) {
        const cell = line.getCell(lastCellIndex);
        if (!cell || cell.getWidth() === 0) {
          lastCellIndex -= 1;
          continue;
        }

        const chars = cell.getChars();
        const text = chars.length > 0 ? chars : " ";
        if (text !== " ") {
          break;
        }
        lastCellIndex -= 1;
      }
    }

    for (let index = 0; index <= lastCellIndex; index += 1) {
      const cell = line.getCell(index);
      if (!cell) {
        continue;
      }

      const width = cell.getWidth();
      if (width === 0) {
        continue;
      }

      const chars = cell.getChars();
      const text = chars.length > 0 ? chars : " ";
      plainText += text;

      const style = this.serializeCellStyle(cell);
      const styleKey = this.serializeCellStyleKey(style);
      if (styleKey !== activeStyleKey) {
        styledText += this.buildAnsiForSerializedCellStyle(style);
        activeStyleKey = styleKey;
      }
      styledText += text;
    }

    if (activeStyleKey !== defaultStyleKey) {
      styledText += ANSI.reset;
    }

    return {
      plainText,
      styledText,
      wrapped: line.isWrapped,
    };
  }

  private serializeCellStyle(cell: IBufferCell): SerializedCellStyle {
    return {
      fgMode: cell.isFgRGB() ? "rgb" : cell.isFgPalette() ? "palette" : "default",
      fg: cell.getFgColor(),
      bgMode: cell.isBgRGB() ? "rgb" : cell.isBgPalette() ? "palette" : "default",
      bg: cell.getBgColor(),
      bold: cell.isBold() !== 0,
      italic: cell.isItalic() !== 0,
      dim: cell.isDim() !== 0,
      underline: cell.isUnderline() !== 0,
      blink: cell.isBlink() !== 0,
      inverse: cell.isInverse() !== 0,
      invisible: cell.isInvisible() !== 0,
      strikethrough: cell.isStrikethrough() !== 0,
      overline: cell.isOverline() !== 0,
    };
  }

  private getDefaultSerializedCellStyle(): SerializedCellStyle {
    return {
      fgMode: "default",
      fg: -1,
      bgMode: "default",
      bg: -1,
      bold: false,
      italic: false,
      dim: false,
      underline: false,
      blink: false,
      inverse: false,
      invisible: false,
      strikethrough: false,
      overline: false,
    };
  }

  private serializeCellStyleKey(style: SerializedCellStyle): string {
    return [
      style.fgMode,
      style.fg,
      style.bgMode,
      style.bg,
      Number(style.bold),
      Number(style.italic),
      Number(style.dim),
      Number(style.underline),
      Number(style.blink),
      Number(style.inverse),
      Number(style.invisible),
      Number(style.strikethrough),
      Number(style.overline),
    ].join("|");
  }

  private buildAnsiForSerializedCellStyle(style: SerializedCellStyle): string {
    const codes = ["0"];

    if (style.bold) {
      codes.push("1");
    }
    if (style.dim) {
      codes.push("2");
    }
    if (style.italic) {
      codes.push("3");
    }
    if (style.underline) {
      codes.push("4");
    }
    if (style.blink) {
      codes.push("5");
    }
    if (style.inverse) {
      codes.push("7");
    }
    if (style.invisible) {
      codes.push("8");
    }
    if (style.strikethrough) {
      codes.push("9");
    }
    if (style.overline) {
      codes.push("53");
    }

    this.appendColorCodes(codes, style.fgMode, style.fg, false);
    this.appendColorCodes(codes, style.bgMode, style.bg, true);

    return `\x1b[${codes.join(";")}m`;
  }

  private appendColorCodes(
    codes: string[],
    mode: SerializedCellStyle["fgMode"],
    color: number,
    background: boolean
  ): void {
    const prefix = background ? "48" : "38";
    if (mode === "palette") {
      codes.push(prefix, "5", String(Math.max(0, color)));
      return;
    }
    if (mode === "rgb") {
      const red = (color >> 16) & 0xff;
      const green = (color >> 8) & 0xff;
      const blue = color & 0xff;
      codes.push(prefix, "2", String(red), String(green), String(blue));
    }
  }

  private showPrompt(): void {
    this.clearPromptRenderTimer();
    if (
      this.promptVisible ||
      !this.promptReady ||
      this.mode !== "ready" ||
      !this.isSessionReadyForPrompt()
    ) {
      return;
    }

    this.configureRendererPrompt();

    if (this.pendingInitialPromptGap) {
      if (this.hasReceivedOutput) {
        // Keep a single visual separator between startup banner and first prompt.
        this.writeEmitter.fire("\r\n");
      }
      this.lastWriteEndedWithNewline = true;
      this.pendingInitialPromptGap = false;
    } else if (!this.lastWriteEndedWithNewline) {
      this.writeEmitter.fire("\r\n");
      this.lastWriteEndedWithNewline = true;
    }

    this.promptBlockStartRow = this.getVisibleOutputCursorRow();
    this.renderInput();
    this.promptVisible = true;
    this.pendingPromptToken = false;
  }

  private showReplyPrompt(): void {
    this.clearPromptRenderTimer();
    if (this.mode !== "reply" || this.promptVisible) {
      return;
    }

    this.renderer.setPrompt(this.replyPromptText, ANSI.brightGreen);
    this.renderer.clearContinuationPrompt();

    if (!this.lastWriteEndedWithNewline && !this.pendingInitialPromptGap) {
      this.writeEmitter.fire("\r\n");
      this.lastWriteEndedWithNewline = true;
    }

    this.promptBlockStartRow = this.getVisibleOutputCursorRow();
    this.renderInput();
    this.promptVisible = true;
  }

  private clearInputRender(): void {
    this.withTerminalStateCaptureSuppressed(() => {
      clearViewInputRender(
        (text) => {
          this.writeEmitter.fire(text);
        },
        this.renderer
      );
    });
  }

  private renderInput(): void {
    this.withTerminalStateCaptureSuppressed(() => {
      renderViewInput({
        syntax: this.syntax,
        renderer: this.renderer,
        inputState: this.inputState,
        dimensions: this.dimensions,
        historyBrowsing: this.historyBrowsing,
        historyCollapsed: this.historyCollapsed,
      });
    });
  }

  private buildCurrentInputRenderPlan(): InputRenderPlan {
    this.syntax.setSource(this.inputState.lines);
    return buildInputRenderPlan({
      renderer: this.renderer,
      inputState: this.inputState,
      dimensions: this.dimensions,
      historyBrowsing: this.historyBrowsing,
      historyCollapsed: this.historyCollapsed,
    });
  }

  private getVisibleOutputCursorRow(): number {
    return Math.max(
      0,
      Math.min(this.terminalState.buffer.active.cursorY, this.dimensions.rows - 1)
    );
  }

  private renderInputFresh(plan: InputRenderPlan): void {
    this.withTerminalStateCaptureSuppressed(() => {
      this.renderer.renderFreshWithCursor(
        plan.lines,
        plan.cursorRow,
        plan.cursorCol,
        this.dimensions.columns,
        plan.sourceLineMap,
        plan.promptKinds
      );
    });
  }

  private repaintAfterResize(restorePrompt: boolean): void {
    this.withTerminalStateCaptureSuppressed(() => {
      // Home first, then erase viewport AND scrollback. The \x1b[3J is critical:
      // \x1b[2J alone scrolls visible content into scrollback in xterm.js, causing
      // ghost prompt copies to accumulate and re-enter the viewport on reflow.
      this.writeEmitter.fire("\x1b[H\x1b[2J\x1b[3J");

      // Use the full-buffer replay which joins wrapped rows back into logical
      // lines. xterm will re-wrap them naturally at the new column width.
      // buildVisibleTerminalReplay() returns raw rows already wrapped at the
      // old width, which would cause double-wrapping artifacts.
      const replay = this.buildTerminalReplay();
      replay.lines.forEach((line, index) => {
        if (index > 0) {
          this.writeEmitter.fire("\r\n");
        }
        this.writeEmitter.fire(line);
      });
      if (replay.lines.length > 0) {
        // Advance to the next line, ready for the prompt (or cursor rest).
        this.writeEmitter.fire("\r\n");
      }

      if (restorePrompt) {
        const plan = this.buildCurrentInputRenderPlan();
        this.renderer.renderedLineCount = 1;
        this.renderer.cursorRowFromTop = 0;
        this.renderer.renderFreshWithCursor(
          plan.lines,
          plan.cursorRow,
          plan.cursorCol,
          this.dimensions.columns,
          plan.sourceLineMap,
          plan.promptKinds
        );
        this.promptBlockStartRow = this.getVisibleOutputCursorRow();
        this.promptVisible = true;
      }
    });
  }

  private refreshSyntax(): void {
    this.syntax.setSource(this.inputState.lines);
  }

  private saveHistory(): void {
    this.rHistory.save();
  }

  private clearPendingInputFlushTimer(): void {
    if (this.pendingInputFlushTimer) {
      clearTimeout(this.pendingInputFlushTimer);
      this.pendingInputFlushTimer = null;
    }
  }

  private killProcessTree(pid: number | undefined): void {
    if (!pid) {
      return;
    }

    if (process.platform === "win32") {
      let killed = false;
      try {
        const result = spawnSync("taskkill", ["/pid", pid.toString(), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          shell: false,
        });
        killed = (result.status ?? 1) === 0;
      } catch {
      }
      if (!killed) {
        try {
          const result = spawnSync("taskkill", ["/pid", pid.toString(), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            shell: true,
          });
          killed = (result.status ?? 1) === 0;
        } catch {
        }
      }
      if (!killed) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }
      return;
    }

    // On Unix, process-group kill is unreliable when the child is not a group leader.
    // Walk descendants explicitly to avoid leaving orphaned PTY children.
    const descendants: number[] = [];
    const queue: number[] = [pid];
    const seen = new Set<number>([pid]);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      try {
        const result = spawnSync("pgrep", ["-P", current.toString()], {
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8",
          shell: false,
        });
        if ((result.status ?? 1) !== 0 || !result.stdout) {
          continue;
        }
        const children = result.stdout
          .split(/\s+/)
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isFinite(value) && value > 0);
        for (const child of children) {
          if (seen.has(child)) {
            continue;
          }
          seen.add(child);
          descendants.push(child);
          queue.push(child);
        }
      } catch {
      }
    }

    for (const target of [...descendants.reverse(), pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
      }
    }
  }

  private async confirmAndClose(): Promise<void> {
    const result = await vscode.window.showWarningMessage(
      "Are you sure you want to close the R console?",
      { modal: true },
      "Yes",
      "No"
    );
    if (result !== "Yes") {
      return;
    }
    this.writeEmitter.fire("\r\n");
    this.forceClose();
    this.closeEmitter.fire(0);
  }

  forceClose(): void {
    this.saveHistory();
    this.sessionWatcher?.dispose();
    this.syntax.dispose();
    this.lang.cleanupCompletionDocument();
    this.clearPendingInputFlushTimer();
    this.pendingProgrammaticInput = "";
    this.clearPromptRenderTimer();
    this.clearReplyPromptRenderTimer();

    this.sessionAttached = false;
    this.lang.clearSessionState();
    this.lang.stopConsoleLsp();
    setNativeParseCallback(null);

    if (this.rProcess) {
      const processToClose = this.rProcess;
      const pid = processToClose.pid;
      if (this.runtimeBackend) {
        this.runtimeBackend.close(processToClose);
        // Give sidecar a short grace window to terminate its PTY child cleanly.
        if (pid) {
          const forceKillTimer = setTimeout(() => {
            if (processToClose.exitCode === null && processToClose.signalCode === null) {
              this.killProcessTree(pid);
            }
          }, 1200);
          processToClose.once("exit", () => {
            clearTimeout(forceKillTimer);
          });
        }
      } else {
        this.killProcessTree(pid);
      }
      this.rProcess = null;
    }

    this.backendChildPid = undefined;
    this.sessionHostConnected = false;
    this.mode = "closed";
    this.replyPromptText = "";
    this.notifyDisplayPidChanged();
    this.terminalState.dispose();
  }

  reattachToNewTerminal(): void {
    this.clearPromptRenderTimer();
    this.clearReplyPromptRenderTimer();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this.nameEmitter.dispose();
    this.writeEmitter = this.createWriteEmitter();
    this.closeEmitter = new vscode.EventEmitter<number>();
    this.nameEmitter = new vscode.EventEmitter<string>();
  }

  isRunning(): boolean {
    return this.rProcess !== null && !this.rProcess.killed;
  }

  getPid(): number | undefined {
    return this.getDisplayPid();
  }

  private getDisplayPid(): number | undefined {
    if (this.options.sessionWatcherEnabled) {
      const attachedPid = this.sessionWatcher?.getAttachedPid();
      if (typeof attachedPid === "number") {
        return attachedPid;
      }
    }
    if (typeof this.backendChildPid === "number") {
      return this.backendChildPid;
    }
    return this.rProcess?.pid;
  }

  notifyDisplayPidChanged(): void {
    const nextPid = this.getDisplayPid();
    if (nextPid === this.lastKnownPid) {
      return;
    }
    this.lastKnownPid = nextPid;
    this.pidEmitter.fire(nextPid);
  }

  dispose(): void {
    this.forceClose();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this.nameEmitter.dispose();
    this.pidEmitter.dispose();
  }
}
