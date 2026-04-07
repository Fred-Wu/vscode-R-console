import * as vscode from "vscode";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { setNativeParseCallback } from "../../Language/parser";
import { type BackendControlEvent } from "../../Runtime/backendProtocol";
import {
  getBundledRustSidecarPath,
  resolveRustSidecarPath,
  RuntimeBackend,
  RustSidecarRuntimeBackend,
} from "../../Runtime/runtimeBackend";
import type { SessionWatcher, WorkspaceData } from "../../Runtime/sessionWatcher";
import { ANSI, stripBracketedPasteMarkers } from "../ansi";
import { ConsoleSyntax } from "../consoleSyntax";
import { InputState } from "../inputState";
import {
  getContinuationPromptLength,
  getRenderedRowCount,
} from "../inputViewport";
import {
  type RTerminalOptions,
} from "../options";
import { Renderer } from "../renderer";
import { RTermLang } from "./lang";
import {
  configureMainPrompt,
  formatTerminalOutput as formatViewOutput,
} from "./view";

const VSCODE_R_TERMINAL_NAME = "R Console";

type Dimensions = {
  columns: number;
  rows: number;
};

export type TerminalMode = "starting" | "ready" | "executing" | "reply" | "closed";

export type Submission = {
  code: string;
  alreadyVisible?: boolean;
  styledLines?: Promise<string[]>;
};

export type PendingSubmissionEcho = {
  code: string;
  rowCount: number;
  lineCount: number;
  plainLines: string[];
  styledLines?: Promise<string[]>;
  restyleStarted: boolean;
};

export type RuntimeHost = {
  options: RTerminalOptions;
  extensionPath: string;
  runtimeBackend: RuntimeBackend | undefined;
  rProcess: ChildProcess | null;
  backendChildPid: number | undefined;
  dimensions: Dimensions;
  mode: TerminalMode;
  promptReady: boolean;
  promptKind: "main" | "cont";
  promptVisible: boolean;
  replyPromptText: string;
  pendingPromptToken: boolean;
  pendingInitialPromptGap: boolean;
  lastWriteEndedWithNewline: boolean;
  hasReceivedOutput: boolean;
  sessionAttached: boolean;
  sessionHostConnected: boolean;
  activeSubmission: Submission | null;
  submissionQueue: Submission[];
  pendingSubmissionEcho: PendingSubmissionEcho | undefined;
  historyBrowsing: boolean;
  historyCollapsed: boolean;
  sessionWatcher: SessionWatcher | undefined;
  inputState: InputState;
  syntax: ConsoleSyntax;
  renderer: Renderer;
  lang: RTermLang;
  writeEmitter: vscode.EventEmitter<string>;
  closeEmitter: vscode.EventEmitter<number>;
  nameEmitter: vscode.EventEmitter<string>;
  clearPendingInputFlushTimer(): void;
  clearPromptRenderTimer(): void;
  clearReplyPromptRenderTimer(): void;
  schedulePrompt(): void;
  scheduleReplyPrompt(): void;
  clearInputRender(): void;
  renderInput(): void;
  recordOutputActivity(): void;
  isSessionProtocolActive(): boolean;
  isSessionReadyForPrompt(): boolean;
  startNextSubmission(): void;
  finishActiveSubmission(): void;
  getDisplayPid(): number | undefined;
  onSessionDataChanged(data: WorkspaceData | undefined): void;
};

export function getRuntimeTerminalName(host: Pick<RuntimeHost, "getDisplayPid">): string {
  const pid = host.getDisplayPid();
  if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
    return `${VSCODE_R_TERMINAL_NAME} (${pid})`;
  }
  return VSCODE_R_TERMINAL_NAME;
}

export function updateRuntimeTerminalName(
  host: Pick<RuntimeHost, "getDisplayPid" | "nameEmitter">
): void {
  host.nameEmitter.fire(getRuntimeTerminalName(host));
}

export function createRuntimeBackend(
  extensionPath: string
): RuntimeBackend | undefined {
  const sidecarPath = resolveRustSidecarPath(extensionPath);
  if (sidecarPath) {
    return new RustSidecarRuntimeBackend(sidecarPath);
  }
  return undefined;
}

function getBundledConsoleProfilePath(extensionPath: string): string {
  return path.join(extensionPath, "bundled", "r", "console-profile.R");
}

export function startRuntime(host: RuntimeHost): void {
  host.clearPendingInputFlushTimer();
  host.clearPromptRenderTimer();
  host.lang.stopConsoleLsp();
  host.lang.resetSessionContext();
  host.pendingPromptToken = true;
  host.mode = "starting";
  host.promptReady = false;
  host.promptKind = "main";
  host.promptVisible = false;
  host.replyPromptText = "";
  host.pendingInitialPromptGap = true;
  host.lastWriteEndedWithNewline = true;
  host.hasReceivedOutput = false;
  host.inputState.reset();
  host.lang.clearPendingLibraries();
  host.submissionQueue = [];
  host.activeSubmission = null;
  host.backendChildPid = undefined;
  host.sessionAttached = false;
  host.sessionHostConnected = false;

  if (!host.runtimeBackend) {
    const expectedPath = host.extensionPath ? getBundledRustSidecarPath(host.extensionPath) : "";
    const details = expectedPath ? `\r\nExpected bundled sidecar:\r\n- ${expectedPath}` : "";
    host.writeEmitter.fire(
      `${ANSI.red}Failed to start R: sidecar backend not found.${ANSI.reset}${details}\r\n`
    );
    host.mode = "closed";
    return;
  }

  try {
    const args = [host.options.rPath, ...host.options.rArgs];
    const runtimeEnv: NodeJS.ProcessEnv = { ...host.options.env };
    if (host.extensionPath) {
      runtimeEnv.VSC_R_EXT = host.extensionPath;
      runtimeEnv.VSC_R_COLS = String(Math.max(20, host.dimensions.columns || 80));
      runtimeEnv.VSC_R_ROWS = String(Math.max(5, host.dimensions.rows || 24));
      const consoleProfilePath = getBundledConsoleProfilePath(host.extensionPath);
      if (!fs.existsSync(consoleProfilePath)) {
        throw new Error(`Console bootstrap script not found at ${consoleProfilePath}`);
      }
      runtimeEnv.R_PROFILE_USER = consoleProfilePath;
    }
    if (host.options.cwd) {
      runtimeEnv.VSC_R_SESSION_CWD = host.options.cwd;
    }

    host.rProcess = host.runtimeBackend.start(args, {
      cwd: host.options.cwd,
      env: runtimeEnv,
    });
    setNativeParseCallback(null);
    void host.lang.start();
    host.runtimeBackend.attach(host.rProcess, {
      onStdout: (output) => {
        handleRuntimeOutput(host, output);
      },
      onStderr: (errorText) => {
        handleRuntimeError(host, errorText);
      },
      onControl: (event) => {
        handleRuntimeControl(host, event);
      },
      onExit: (code) => {
        handleRuntimeExit(host, code);
      },
      onError: (err) => {
        setNativeParseCallback(null);
        host.writeEmitter.fire(
          `${ANSI.red}Failed to start R: ${err.message}${ANSI.reset}\r\n`
        );
        host.mode = "closed";
        host.rProcess = null;
        host.sessionAttached = false;
        host.lang.stopConsoleLsp();
      },
    });

    updateRuntimeTerminalName(host);
    if (!host.options.sessionWatcherEnabled) {
      host.sessionAttached = true;
    }
  } catch (err) {
    host.writeEmitter.fire(
      `${ANSI.red}Failed to start R: ${String(err)}${ANSI.reset}\r\n`
    );
    host.rProcess = null;
    host.mode = "closed";
    host.sessionAttached = false;
    host.lang.stopConsoleLsp();
  }
}

function beginRuntimeAttach(host: RuntimeHost): void {
  if (!host.sessionWatcher) {
    host.sessionAttached = true;
    return;
  }

  host.sessionWatcher.onAttach(() => onRuntimeAttached(host));
  host.sessionWatcher.start();
  host.sessionWatcher.refresh();
  if (host.sessionWatcher.isAttached()) {
    onRuntimeAttached(host);
  }
}

function onRuntimeAttached(host: RuntimeHost): void {
  if (host.sessionAttached) {
    return;
  }
  host.sessionAttached = true;
  host.onSessionDataChanged(host.sessionWatcher?.getWorkspaceData());
  updateRuntimeTerminalName(host);
  if (host.mode === "starting" && host.promptReady) {
    host.mode = "ready";
  }
  if (host.mode === "ready" && host.promptReady) {
    host.pendingPromptToken = true;
    host.schedulePrompt();
    if (host.activeSubmission === null && host.promptKind === "main") {
      host.startNextSubmission();
    }
  }
}

export function handleRuntimeOutput(host: RuntimeHost, output: string): void {
  host.hasReceivedOutput = true;
  host.clearPromptRenderTimer();
  host.clearReplyPromptRenderTimer();
  renderRuntimeOutput(host, output);
}

export function handleRuntimeControl(
  host: RuntimeHost,
  event: BackendControlEvent
): void {
  switch (event.type) {
    case "backend-ready":
      return;
    case "host-connected":
      host.sessionHostConnected = true;
      updateNativeParseCallback(host);
      return;
    case "child-spawned":
      if (typeof event.pid === "number" && Number.isFinite(event.pid) && event.pid > 0) {
        host.backendChildPid = event.pid;
        updateRuntimeTerminalName(host);
        if (host.options.sessionWatcherEnabled && host.sessionWatcher) {
          host.sessionWatcher.setExpectedPid(event.pid);
          beginRuntimeAttach(host);
        }
      } else if (host.options.sessionWatcherEnabled && host.sessionWatcher) {
        beginRuntimeAttach(host);
      }
      return;
    case "prompt":
      handleBackendPrompt(host, event.kind);
      return;
    case "busy":
      if (event.value && host.mode !== "reply") {
        host.mode = "executing";
      }
      return;
    case "input-request":
      handleBackendInputRequest(host, event.prompt);
      return;
    case "input-end":
      if (host.mode === "reply") {
        host.clearReplyPromptRenderTimer();
        host.mode = host.activeSubmission ? "executing" : "ready";
        host.replyPromptText = "";
        host.inputState.reset();
      }
      return;
    case "output-flush":
      if (host.mode === "reply" && !host.promptVisible) {
        host.scheduleReplyPrompt();
      } else if (
        host.mode === "ready" &&
        host.promptReady &&
        host.pendingPromptToken &&
        !host.promptVisible
      ) {
        host.schedulePrompt();
      }
      return;
    case "parse-status-result":
      return;
    case "host-error":
      if (event.message.trim().length > 0) {
        handleRuntimeError(
          host,
          event.message.endsWith("\n") ? event.message : `${event.message}\n`
        );
      }
      return;
  }
}

export function handleBackendPrompt(
  host: RuntimeHost,
  kind: "main" | "cont"
): void {
  host.promptReady = true;
  host.promptKind = kind;
  host.replyPromptText = "";

  if (host.mode === "reply") {
    host.inputState.reset();
  }

  if (host.mode === "starting") {
    if (host.isSessionReadyForPrompt()) {
      host.mode = "ready";
    }
  } else if (host.activeSubmission) {
    if (kind === "main") {
      host.finishActiveSubmission();
    } else {
      host.activeSubmission = null;
      host.mode = "ready";
      void host.lang.refreshCompletionContextDocument(host.inputState.text);
    }
  } else {
    host.mode = "ready";
  }

  host.pendingPromptToken = true;
  host.schedulePrompt();
  if (kind === "main" && host.mode === "ready" && host.activeSubmission === null) {
    host.startNextSubmission();
  }
}

export function handleBackendInputRequest(
  host: RuntimeHost,
  prompt: string
): void {
  const { prelude, inlinePrompt } = splitReplyPrompt(prompt);
  host.pendingSubmissionEcho = undefined;
  host.replyPromptText = inlinePrompt;
  host.clearPromptRenderTimer();
  host.clearReplyPromptRenderTimer();
  host.pendingPromptToken = false;
  host.promptReady = false;
  host.inputState.reset();

  if (host.promptVisible) {
    host.clearInputRender();
    host.promptVisible = false;
  }

  if (prelude.length > 0) {
    host.writeEmitter.fire(prelude);
    host.lastWriteEndedWithNewline = /(\n|\r)$/.test(prelude);
    host.renderer.renderedLineCount = 1;
    host.renderer.cursorRowFromTop = 0;
    host.recordOutputActivity();
  }

  host.mode = "reply";
  host.scheduleReplyPrompt();
}

export function splitReplyPrompt(
  prompt: string
): { prelude: string; inlinePrompt: string } {
  const normalized = prompt.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lastNewline = normalized.lastIndexOf("\n");
  if (lastNewline < 0) {
    return { prelude: "", inlinePrompt: normalized };
  }

  return {
    prelude: normalized.slice(0, lastNewline + 1).replace(/\n/g, "\r\n"),
    inlinePrompt: normalized.slice(lastNewline + 1),
  };
}

export function renderRuntimeOutput(host: RuntimeHost, text: string): void {
  if (!text) {
    return;
  }

  host.pendingSubmissionEcho = undefined;
  const shouldRestoreReplyPrompt = host.mode === "reply";
  const shouldRestoreReadyPrompt =
    host.mode === "ready" &&
    host.promptReady &&
    (host.pendingPromptToken || host.promptVisible || host.inputState.text.length > 0);
  const formatted = formatViewOutput(text);
  host.recordOutputActivity();
  if (host.promptVisible || host.inputState.text.length > 0) {
    host.clearInputRender();
    host.promptVisible = false;
  }

  host.writeEmitter.fire(formatted);
  host.lastWriteEndedWithNewline = /(\n|\r)$/.test(formatted);
  host.renderer.renderedLineCount = 1;
  host.renderer.cursorRowFromTop = 0;

  if (shouldRestoreReplyPrompt) {
    host.scheduleReplyPrompt();
  } else if (shouldRestoreReadyPrompt) {
    host.pendingPromptToken = true;
    host.schedulePrompt();
  }
}

export function handleRuntimeError(host: RuntimeHost, error: string): void {
  host.hasReceivedOutput = true;
  host.clearPromptRenderTimer();
  host.clearReplyPromptRenderTimer();
  const rawFormatted = stripBracketedPasteMarkers(error.replace(/\r?\n/g, "\r\n"));
  host.pendingSubmissionEcho = undefined;
  const shouldRestoreReplyPrompt = host.mode === "reply";
  const shouldRestoreReadyPrompt =
    host.mode === "ready" &&
    host.promptReady &&
    (host.pendingPromptToken || host.promptVisible || host.inputState.text.length > 0);
  host.recordOutputActivity();
  if (host.promptVisible || host.inputState.text.length > 0) {
    host.clearInputRender();
    host.promptVisible = false;
  }
  host.writeEmitter.fire(`${ANSI.red}${rawFormatted}${ANSI.reset}`);
  host.lastWriteEndedWithNewline =
    rawFormatted.endsWith("\n") || rawFormatted.endsWith("\r\n");
  if (shouldRestoreReplyPrompt) {
    host.scheduleReplyPrompt();
  } else if (shouldRestoreReadyPrompt) {
    host.pendingPromptToken = true;
    host.schedulePrompt();
  }
}

export function sendRuntimeReply(host: RuntimeHost, text: string): void {
  host.clearReplyPromptRenderTimer();
  if (host.promptVisible) {
    host.writeEmitter.fire("\r\n");
    host.lastWriteEndedWithNewline = true;
    host.renderer.renderedLineCount = 1;
    host.renderer.cursorRowFromTop = 0;
    host.promptVisible = false;
  }
  host.inputState.reset();
  host.mode = host.activeSubmission ? "executing" : "ready";
  host.replyPromptText = "";
  host.runtimeBackend?.sendSessionCommand(host.rProcess, {
    type: "reply-input",
    text,
  });
}

export function startRuntimeSubmission(host: RuntimeHost, task: Submission): void {
  host.mode = "executing";
  if (task.alreadyVisible) {
    triggerPendingSubmissionRestyle(host);
  } else {
    writeRuntimeSubmissionEcho(host, task);
  }
  host.clearPromptRenderTimer();
  host.runtimeBackend?.sendSessionCommand(host.rProcess, {
    type: "submit",
    code: task.code,
  });
}

export function finishRuntimeSubmission(host: RuntimeHost): void {
  host.activeSubmission = null;
  host.mode = "ready";
  void host.lang.refreshCompletionContextDocument(host.inputState.text);
}

export function startNextRuntimeSubmission(host: RuntimeHost): void {
  if (host.mode !== "ready" && !(host.mode === "executing" && host.activeSubmission === null)) {
    return;
  }
  if (host.activeSubmission) {
    return;
  }
  const task = host.submissionQueue.shift();
  if (!task) {
    return;
  }
  host.activeSubmission = task;
  startRuntimeSubmission(host, task);
}

export async function enqueueRuntimeSubmission(
  host: RuntimeHost,
  code: string,
  skipSplit: boolean = false,
  alreadyVisible: boolean = false
) : Promise<string[]> {
  const blocks = skipSplit
    ? [normalizeSubmissionBlock(code)]
    : await splitSubmissionBlocks(host, code);

  if (blocks.length === 0) {
    if (alreadyVisible && host.activeSubmission === null) {
      host.mode = "ready";
      host.pendingPromptToken = true;
      host.schedulePrompt();
    }
    return [];
  }

  for (const block of blocks) {
    host.lang.trackPendingLibraries(block);
    host.submissionQueue.push({
      code: block,
      alreadyVisible,
      styledLines: alreadyVisible ? undefined : host.syntax.prepareSnapshot(block),
    });
  }

  void host.lang.refreshCompletionContextDocument(host.inputState.text);
  startNextRuntimeSubmission(host);
  return blocks;
}

export function beginVisibleRuntimeSubmission(
  host: RuntimeHost,
  visibleCode: string
): void {
  if (host.promptVisible) {
    const plainLines = visibleCode.split("\n");
    host.pendingSubmissionEcho = {
      code: visibleCode,
      rowCount: host.renderer.renderedLineCount,
      lineCount: plainLines.length,
      plainLines,
      styledLines: host.syntax.prepareSnapshot(plainLines),
      restyleStarted: false,
    };
    const rowsBelowCursor = Math.max(
      0,
      host.renderer.renderedLineCount - 1 - host.renderer.cursorRowFromTop
    );
    if (rowsBelowCursor > 0) {
      host.writeEmitter.fire(`\x1b[${rowsBelowCursor}B`);
    }
    host.writeEmitter.fire("\r\n");
    host.lastWriteEndedWithNewline = true;
    host.renderer.renderedLineCount = 1;
    host.renderer.cursorRowFromTop = 0;
    host.promptVisible = false;
  }
  host.inputState.reset();
  host.mode = "executing";
}

function normalizeSubmissionBlock(code: string): string {
  return code.replace(/\n+$/, "").trimEnd();
}

async function splitSubmissionBlocks(host: RuntimeHost, code: string): Promise<string[]> {
  const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let currentBlock = "";

  for (const line of lines) {
    currentBlock = currentBlock.length > 0 ? `${currentBlock}\n${line}` : line;
    const normalizedBlock = normalizeSubmissionBlock(currentBlock);

    if (!normalizedBlock.trim()) {
      continue;
    }

    const isComplete = await host.inputState.isExpressionCompleteAsync(normalizedBlock);
    if (!isComplete) {
      continue;
    }

    blocks.push(normalizedBlock);
    currentBlock = "";
  }

  const trailingBlock = normalizeSubmissionBlock(currentBlock);
  if (trailingBlock.trim() && (await host.inputState.isExpressionCompleteAsync(trailingBlock))) {
    blocks.push(trailingBlock);
  }

  return blocks;
}

function writeRuntimeSubmissionEcho(host: RuntimeHost, task: Submission): void {
  if ((host.mode !== "ready" && host.mode !== "executing") || !host.promptReady) {
    return;
  }

  host.historyBrowsing = false;
  host.historyCollapsed = true;

  configureMainPrompt(host.renderer);

  if (host.promptVisible || host.inputState.text.length > 0) {
    host.clearInputRender();
    host.promptVisible = false;
  } else {
    if (host.pendingInitialPromptGap) {
      if (host.hasReceivedOutput) {
        host.writeEmitter.fire("\r\n");
      }
      host.lastWriteEndedWithNewline = true;
      host.pendingInitialPromptGap = false;
    } else if (!host.lastWriteEndedWithNewline) {
      host.writeEmitter.fire("\r\n");
      host.lastWriteEndedWithNewline = true;
    }
  }

  host.pendingPromptToken = false;
  const plainLines = task.code.split("\n");
  const immediateLines = host.syntax.snapshotNow(plainLines);
  const rowCount = writeRuntimeSubmissionLines(host, plainLines, immediateLines);
  host.pendingSubmissionEcho = task.styledLines
    ? {
        code: task.code,
        rowCount,
        lineCount: plainLines.length,
        plainLines,
        styledLines: task.styledLines,
        restyleStarted: false,
      }
    : undefined;
  host.promptVisible = false;

  triggerPendingSubmissionRestyle(host);
}

function writeRuntimeSubmissionLines(
  host: RuntimeHost,
  plainLines: string[],
  styledLines: string[]
): number {
  const continuationPad =
    host.renderer.promptText === ">>> " ? host.renderer.promptLen : 2;
  const continuationPromptLen = getContinuationPromptLength(
    host.renderer.promptText,
    host.renderer.promptLen,
    host.renderer.continuationPromptText
  );

  styledLines.forEach((line, index) => {
    if (index > 0) {
      host.writeEmitter.fire("\r\n");
    }
    const prompt =
      index === 0
        ? `${ANSI.reset}${host.renderer.promptColor}${host.renderer.promptText}${ANSI.reset}`
        : (host.renderer.continuationPromptText === null
            ? " ".repeat(continuationPad)
            : `${ANSI.reset}${host.renderer.continuationPromptColor}${host.renderer.continuationPromptText}${ANSI.reset}`);
    host.writeEmitter.fire(prompt + line);
  });

  host.writeEmitter.fire("\r\n");
  host.lastWriteEndedWithNewline = true;
  host.renderer.renderedLineCount = 1;
  host.renderer.cursorRowFromTop = 0;

  return getRenderedRowCount(
    plainLines,
    host.dimensions.columns,
    host.renderer.promptLen,
    continuationPromptLen
  );
}

function triggerPendingSubmissionRestyle(host: RuntimeHost): void {
  const pending = host.pendingSubmissionEcho;
  if (!pending || !pending.styledLines || pending.restyleStarted) {
    return;
  }

  pending.restyleStarted = true;
  void restyleRuntimeSubmissionEcho(host, pending.code);
}

async function restyleRuntimeSubmissionEcho(
  host: RuntimeHost,
  expectedCode: string
): Promise<void> {
  const pending = host.pendingSubmissionEcho;
  if (!pending || !pending.styledLines || pending.code !== expectedCode) {
    return;
  }

  const styledLines = await pending.styledLines;
  const latest = host.pendingSubmissionEcho;
  if (
    !styledLines ||
    !latest ||
    latest.code !== expectedCode ||
    latest.lineCount !== pending.lineCount
  ) {
    return;
  }

  const restoreReplyPrompt = host.promptVisible && host.mode === "reply";
  const restoreMainPrompt =
    host.promptVisible &&
    host.mode === "ready" &&
    host.promptReady &&
    host.isSessionReadyForPrompt();

  if (host.promptVisible) {
    host.clearInputRender();
    host.promptVisible = false;
  }

  host.writeEmitter.fire("\r");
  if (latest.rowCount > 0) {
    host.writeEmitter.fire(`\x1b[${latest.rowCount}A`);
  }

  for (let row = 0; row < latest.rowCount; row += 1) {
    host.writeEmitter.fire("\x1b[2K");
    if (row < latest.rowCount - 1) {
      host.writeEmitter.fire("\x1b[1B\r");
    }
  }

  if (latest.rowCount > 1) {
    host.writeEmitter.fire(`\x1b[${latest.rowCount - 1}A\r`);
  } else {
    host.writeEmitter.fire("\r");
  }

  writeRuntimeSubmissionLines(host, latest.plainLines, styledLines);
  host.pendingSubmissionEcho = undefined;

  if (restoreReplyPrompt) {
    host.scheduleReplyPrompt();
    return;
  }

  if (restoreMainPrompt) {
    host.schedulePrompt();
  }
}

export function interruptRuntime(host: RuntimeHost): void {
  if (!host.rProcess || host.rProcess.killed) {
    return;
  }

  const sendInterrupt = (): boolean =>
    host.runtimeBackend?.sendSessionCommand(host.rProcess, {
      type: "interrupt",
    }) ?? false;

  if (host.isSessionProtocolActive() && host.mode === "executing") {
    host.writeEmitter.fire("^C\r\n");
    sendInterrupt();
    host.inputState.reset();
    host.promptVisible = false;
    host.pendingPromptToken = false;
    return;
  }

  if (host.isSessionProtocolActive() && host.mode === "reply") {
    host.clearReplyPromptRenderTimer();
    host.writeEmitter.fire("^C\r\n");
    host.clearInputRender();
    host.inputState.reset();
    host.promptVisible = false;
    host.replyPromptText = "";
    host.mode = "executing";
    sendInterrupt();
    return;
  }

  if (host.mode === "ready" && host.inputState.text.length > 0) {
    host.clearInputRender();
    host.inputState.reset();
    host.renderInput();
    return;
  }

  if (!sendInterrupt()) {
    return;
  }

  host.writeEmitter.fire("^C\r\n");
  host.inputState.reset();
  host.promptVisible = false;
}

export function handleRuntimeExit(host: RuntimeHost, code: number): void {
  host.clearPendingInputFlushTimer();
  host.clearPromptRenderTimer();
  host.clearReplyPromptRenderTimer();
  setNativeParseCallback(null);

  host.lang.cleanupCompletionDocument();
  host.lang.clearPendingLibraries();
  host.lang.stopConsoleLsp();

  host.rProcess = null;
  host.backendChildPid = undefined;
  host.sessionHostConnected = false;
  host.mode = "closed";
  host.promptReady = false;
  host.promptVisible = false;
  host.replyPromptText = "";
  host.sessionAttached = false;

  host.submissionQueue = [];
  host.activeSubmission = null;
  host.pendingSubmissionEcho = undefined;

  host.writeEmitter.fire(
    `\r\n${ANSI.yellow}R exited with code ${code}${ANSI.reset}\r\n`
  );
  host.closeEmitter.fire(code);
}

function updateNativeParseCallback(host: RuntimeHost): void {
  if (
    !host.runtimeBackend ||
    !host.rProcess ||
    !host.sessionHostConnected ||
    !host.runtimeBackend.hasCapability(host.rProcess, "parse-status")
  ) {
    setNativeParseCallback(null);
    return;
  }

  setNativeParseCallback(async (code: string) => {
    const request = host.runtimeBackend?.requestParseStatus(host.rProcess, code);
    if (!request) {
      return 1;
    }
    return await request;
  });
}
