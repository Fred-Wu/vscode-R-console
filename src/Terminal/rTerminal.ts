import * as vscode from "vscode";
import { Terminal as HeadlessTerminal, type IBufferCell, type IBufferLine } from "@xterm/headless";
import { spawnSync, ChildProcess } from "child_process";
import * as path from "path";
import * as os from "os";
import { CompletionPickItem } from "../Language/completion";
import { setNativeParseCallback, stripCommentLines } from "../Language/parser";
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
  clearInputRender as clearViewInputRender,
  configureMainPrompt,
  getPromptRenderDelay as getViewPromptRenderDelay,
  getReplyPromptRenderDelay as getViewReplyPromptRenderDelay,
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
  private terminalState: ReplayTerminal;
  private suppressTerminalStateCapture = false;
  private static readonly TERMINAL_SCROLLBACK = 5000;
  private pendingInitialPromptGap = false;
  private promptRenderTimer: NodeJS.Timeout | null = null;
  private replyPromptRenderTimer: NodeJS.Timeout | null = null;
  private lastOutputAt = 0;

  private mode: TerminalMode = "starting";
  private pendingInputFlushTimer: NodeJS.Timeout | null = null;

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
    return this as unknown as RuntimeHost;
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
    return !this.options.sessionWatcherEnabled || this.sessionAttached;
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

    this.restoreTerminalState();
    // Defer the name update: VSCode drops nameEmitter events fired
    // synchronously during open() because the terminal UI hasn't attached yet.
    setTimeout(() => {
      this.nameEmitter.fire(getRuntimeTerminalName(this.runtimeHost()));
      this.notifyDisplayPidChanged();
    }, 0);

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
    this.dimensions = dimensions;
    const changed =
      dimensions.columns !== previous.columns || dimensions.rows !== previous.rows;

    if (changed) {
      this.syncReplayTerminalSize();
    }

    if (!this.rProcess) {
      return;
    }

    if (process.platform !== "win32" && this.isSessionProtocolActive()) {
      this.runtimeBackend?.sendSessionCommand(this.rProcess, {
        type: "set-width",
        columns: dimensions.columns,
      });
    }

    if (!changed) {
      return;
    }

    if (this.promptVisible && this.inputState.text.length > 0) {
      this.clearInputRender();
      this.promptVisible = false;
      this.renderInput();
      this.promptVisible = true;
    }

    if (!this.promptVisible && this.mode === "ready" && this.promptReady && this.pendingPromptToken) {
      this.schedulePrompt();
    }
  }

  handleInput(data: string): void {
    if (this.mode === "executing" && this.isSessionProtocolActive()) {
      const hasCtrlC =
        data.includes("\x03") ||
        this.keyProcessor.parseInputChunk(data).some((action) => action.type === "ctrl_c");
      if (hasCtrlC) {
        this.interruptR();
      }
      return;
    }
    if (this.shouldHandleAsProgrammaticSubmission(data)) {
      this.programmaticSubmissionQueue = this.programmaticSubmissionQueue.then(
        async () => this.handleProgrammaticSubmission(data),
        async () => this.handleProgrammaticSubmission(data)
      );
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

  private shouldHandleAsProgrammaticSubmission(data: string): boolean {
    if (this.mode !== "ready" || !this.promptReady) {
      return false;
    }
    if (this.inBracketPaste) {
      return false;
    }
    if (this.inputState.text.length !== 0 || !this.inputState.isAtEnd) {
      return false;
    }
    const unwrapped = stripBracketedPasteMarkers(data);
    if (unwrapped.length <= 1) {
      return false;
    }
    // Accept bracketed-paste wrappers, but reject any remaining escape/control streams.
    if (unwrapped.includes("\x1b")) {
      return false;
    }
    return unwrapped.includes("\n") || unwrapped.includes("\r");
  }

  private async handleProgrammaticSubmission(data: string): Promise<void> {
    const normalized = stripCommentLines(
      stripBracketedPasteMarkers(data)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/^\n+/, "")
    );
    const trimmed = normalized.replace(/\n+$/, "");
    if (!trimmed) {
      return;
    }

    const isComplete = await this.inputState.isExpressionCompleteAsync(trimmed);
    if (!isComplete) {
      this.historyBrowsing = false;
      this.historyCollapsed = true;
      this.escPendingClear = false;
      this.rHistory.resetIndex();
      this.inputState.insertText(trimmed);
      this.renderInput();
      return;
    }

    const sanitized = trimmed.trimEnd();
    if (!sanitized) {
      return;
    }

    this.inputState.reset();
    this.historyBrowsing = false;
    this.historyCollapsed = true;
    this.escPendingClear = false;
    this.rHistory.resetIndex();

    const blocks = await this.enqueueRSubmission(sanitized, false);
    this.recordSubmissionHistory(blocks);
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
        this.suppressNextEnterAfterPasteEnd = true;
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
        this.terminalState.clear();
        this.writeEmitter.fire("\x1b[2J\x1b[H");
        this.renderer.renderedLineCount = 1;
        this.renderer.cursorRowFromTop = 0;
        this.promptVisible = false;
        this.renderInput();
        this.promptVisible = true;
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

    this.suppressTerminalStateCapture = true;
    try {
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
    } finally {
      this.suppressTerminalStateCapture = false;
    }
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
    const firstContentRow = rawRows.findIndex((row) => row.plainText.trimEnd().length > 0);
    let lastContentRow = -1;
    for (let index = rawRows.length - 1; index >= 0; index -= 1) {
      if (rawRows[index]?.plainText.trimEnd().length) {
        lastContentRow = index;
        break;
      }
    }
    const rowStart = firstContentRow === -1 ? cursorAbsoluteRow : Math.min(firstContentRow, cursorAbsoluteRow);
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

  private serializeReplayRow(line: IBufferLine | undefined): SerializedReplayRow {
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

    for (let index = 0; index < line.length; index += 1) {
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

    this.renderInput();
    this.promptVisible = true;
  }

  private clearInputRender(): void {
    clearViewInputRender(
      (text) => {
        this.writeEmitter.fire(text);
      },
      this.renderer
    );
  }

  private renderInput(): void {
    renderViewInput({
      syntax: this.syntax,
      renderer: this.renderer,
      inputState: this.inputState,
      dimensions: this.dimensions,
      historyBrowsing: this.historyBrowsing,
      historyCollapsed: this.historyCollapsed,
    });
  }

  private refreshSyntax(): void {
    this.syntax.setSource(this.inputState.lines);
  }

  sendCode(code: string): void {
    const sanitized = stripCommentLines(stripBracketedPasteMarkers(code)).trimEnd();
    if (!sanitized) {
      return;
    }

    this.inputState.reset();
    this.historyBrowsing = false;
    this.historyCollapsed = true;
    this.escPendingClear = false;
    this.rHistory.resetIndex();

    void this.enqueueRSubmission(sanitized, false).then((blocks) => {
      this.recordSubmissionHistory(blocks);
    });
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
