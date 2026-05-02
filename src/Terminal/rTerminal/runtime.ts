import * as vscode from "vscode";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { setNativeParseCallback, stripCommentLines } from "../../Language/parser";
import {
  type BackendControlEvent,
  type BackendDialogRequest,
} from "../../Runtime/backendProtocol";
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
  buildSubmissionRenderPlan,
  getContinuationPromptLength,
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

type PendingRuntimeRewrite = {
  bareCarriageReturn: boolean;
  clearFrame: {
    text: string;
    endedWithLineFeed: boolean;
  } | null;
};

type Dimensions = {
  columns: number;
  rows: number;
};

export type TerminalMode = "starting" | "ready" | "executing" | "reply" | "closed";

export type Submission = {
  code: string;
};

const pendingRuntimeRewrites = new WeakMap<RuntimeHost, PendingRuntimeRewrite>();

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
  submissionPending: boolean;
  awaitingExecutionStart: boolean;
  lastWriteEndedWithNewline: boolean;
  hasReceivedOutput: boolean;
  sessionAttached: boolean;
  sessionHostConnected: boolean;
  activeSubmission: Submission | null;
  submissionQueue: Submission[];
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
  notifyDisplayPidChanged(): void;
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
  host: Pick<RuntimeHost, "getDisplayPid" | "nameEmitter" | "notifyDisplayPidChanged">
): void {
  host.nameEmitter.fire(getRuntimeTerminalName(host));
  host.notifyDisplayPidChanged();
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

function getConsoleProfilePath(extensionPath: string): string {
  return path.join(extensionPath, "resources", "r", "console-profile.R");
}

export function startRuntime(host: RuntimeHost): void {
  pendingRuntimeRewrites.delete(host);
  host.clearPendingInputFlushTimer();
  host.clearPromptRenderTimer();
  host.lang.stopConsoleLsp();
  host.lang.clearSessionState();
  host.pendingPromptToken = true;
  host.mode = "starting";
  host.promptReady = false;
  host.promptKind = "main";
  host.promptVisible = false;
  host.replyPromptText = "";
  host.pendingInitialPromptGap = true;
  host.submissionPending = false;
  host.awaitingExecutionStart = false;
  host.lastWriteEndedWithNewline = true;
  host.hasReceivedOutput = false;
  host.inputState.reset();
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
      const consoleProfilePath = getConsoleProfilePath(host.extensionPath);
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
  if (host.mode === "ready" && host.promptReady && !host.promptVisible) {
    host.pendingPromptToken = true;
    host.schedulePrompt();
    if (host.activeSubmission === null && host.promptKind === "main") {
      host.startNextSubmission();
    }
  }
}

export function handleRuntimeOutput(host: RuntimeHost, output: string): void {
  if (host.awaitingExecutionStart && host.activeSubmission) {
    host.awaitingExecutionStart = false;
  }
  host.hasReceivedOutput = true;
  host.clearPromptRenderTimer();
  host.clearReplyPromptRenderTimer();
  renderRuntimeOutput(host, output);
}

export function handleRuntimeControl(
  host: RuntimeHost,
  event: BackendControlEvent
): void {
  if (event.type !== "output-flush") {
    discardPendingRuntimeRewrite(host);
  }

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
      if (event.value) {
        if (host.awaitingExecutionStart && host.activeSubmission) {
          host.awaitingExecutionStart = false;
        }
        if (host.mode !== "reply" && (host.activeSubmission !== null || host.mode === "starting")) {
          host.mode = "executing";
        }
        return;
      }

      if (host.mode === "executing") {
        restoreReadyStateAfterExecution(host);
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
    case "dialog-request":
      void handleBackendDialogRequest(host, event.dialog);
      return;
    case "output-flush":
      if (host.mode === "reply" && !host.promptVisible) {
        host.scheduleReplyPrompt();
      } else if (
        !host.submissionPending &&
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

function restoreReadyStateAfterExecution(host: RuntimeHost): void {
  if (host.submissionPending) {
    return;
  }

  if (host.activeSubmission) {
    // Top-level submissions are complete when R returns the next prompt, not
    // when Windows emits an intermediate busy(false) transition during redraws.
    host.awaitingExecutionStart = false;
    return;
  }

  host.mode = "ready";

  if (!host.promptReady || host.promptVisible || !host.isSessionReadyForPrompt()) {
    return;
  }

  host.pendingPromptToken = true;
  host.schedulePrompt();
}

export function handleBackendPrompt(
  host: RuntimeHost,
  kind: "main" | "cont"
): void {
  if (host.awaitingExecutionStart && host.activeSubmission) {
    host.promptReady = true;
    host.promptKind = kind;
    host.replyPromptText = "";
    host.pendingPromptToken = false;
    return;
  }

  host.promptReady = true;
  host.promptKind = kind;
  host.replyPromptText = "";

  if (host.mode === "reply") {
    host.inputState.reset();
  }

  if (host.mode === "starting") {
    host.mode = "ready";
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

  if (host.submissionPending) {
    host.pendingPromptToken = false;
    if (kind === "main" && host.mode === "ready" && host.activeSubmission === null) {
      host.startNextSubmission();
    }
    return;
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

async function handleBackendDialogRequest(
  host: RuntimeHost,
  dialog: BackendDialogRequest
): Promise<void> {
  switch (dialog.kind) {
    case "choose-file":
      await handleChooseFileDialog(host, dialog.newFile);
      return;
    case "edit-expression":
      await handleEditExpressionDialog(host, dialog.path);
      return;
    case "edit-files":
      await handleEditFilesDialog(host, dialog.paths);
      return;
  }
}

async function handleChooseFileDialog(
  host: RuntimeHost,
  newFile: boolean
): Promise<void> {
  let selectedPath: string | undefined;
  const defaultUri =
    host.options.cwd && path.isAbsolute(host.options.cwd)
      ? vscode.Uri.file(host.options.cwd)
      : undefined;

  try {
    if (newFile) {
      const uri = await vscode.window.showSaveDialog({ defaultUri });
      selectedPath = uri?.fsPath;
    } else {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri,
      });
      selectedPath = uris?.[0]?.fsPath;
    }
  } catch (error) {
    void vscode.window.showErrorMessage(`R Console file chooser failed: ${String(error)}`);
  }

  host.runtimeBackend?.sendSessionCommand(host.rProcess, {
    type: "dialog-result",
    result: {
      kind: "choose-file",
      path: selectedPath,
    },
  });
}

async function handleEditExpressionDialog(
  host: RuntimeHost,
  filePath: string
): Promise<void> {
  const completed = await runEditorSession(host, [filePath], true);

  host.runtimeBackend?.sendSessionCommand(host.rProcess, {
    type: "dialog-result",
    result: {
      kind: "edit-expression",
      completed,
    },
  });
}

async function handleEditFilesDialog(
  host: RuntimeHost,
  filePaths: string[]
): Promise<void> {
  const completed = await runEditorSession(host, filePaths, false);

  host.runtimeBackend?.sendSessionCommand(host.rProcess, {
    type: "dialog-result",
    result: {
      kind: "edit-files",
      completed,
    },
  });
}

async function runEditorSession(
  host: RuntimeHost,
  filePaths: readonly string[],
  normalizeTrailingNewline: boolean
): Promise<boolean> {
  try {
    const targetUris: vscode.Uri[] = [];
    const tabs: vscode.Tab[] = [];
    for (const filePath of filePaths) {
      const targetUri = await resolveEditorFileUri(host, filePath);
      targetUris.push(targetUri);
      const targetTab = await openEditorTab(targetUri);
      if (!tabs.includes(targetTab)) {
        tabs.push(targetTab);
      }
    }
    await waitForClosedTabs(tabs);
    if (normalizeTrailingNewline && targetUris.length > 0) {
      await ensureTrailingNewline(targetUris[0]);
    }
    return true;
  } catch (error) {
    void vscode.window.showErrorMessage(`R Console editor session failed: ${String(error)}`);
    return false;
  }
}

async function resolveEditorFileUri(
  host: RuntimeHost,
  filePath: string
): Promise<vscode.Uri> {
  const resolvedPath =
    path.isAbsolute(filePath)
      ? filePath
      : path.resolve(host.options.cwd ?? process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.promises.writeFile(resolvedPath, "");
  }
  const canonicalPath = await fs.promises.realpath(resolvedPath).catch(() => resolvedPath);
  return vscode.Uri.file(canonicalPath);
}

async function openEditorTab(targetUri: vscode.Uri): Promise<vscode.Tab> {
  const existingTabs = getTextTabs(targetUri);
  const document = await vscode.workspace.openTextDocument(targetUri);
  await vscode.window.showTextDocument(document, { preview: false });

  const activeTab = getActiveTextTab(targetUri);
  if (activeTab) {
    return activeTab;
  }

  const openedTab = getTextTabs(targetUri).find((tab) => !existingTabs.includes(tab));
  if (openedTab) {
    return openedTab;
  }

  throw new Error(`failed to track editor tab for ${targetUri.fsPath}`);
}

function waitForClosedTabs(tabs: readonly vscode.Tab[]): Promise<void> {
  if (tabs.length === 0 || tabs.every((tab) => !isTabOpen(tab))) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const remaining = new Set(tabs);
    const finishIfDone = (): void => {
      for (const tab of [...remaining]) {
        if (!isTabOpen(tab)) {
          remaining.delete(tab);
        }
      }
      if (remaining.size === 0) {
        subscription.dispose();
        resolve();
      }
    };

    const subscription = vscode.window.tabGroups.onDidChangeTabs((event) => {
      for (const tab of event.closed) {
        remaining.delete(tab);
      }
      finishIfDone();
    });

    finishIfDone();
  });
}

function getTextTabs(targetUri: vscode.Uri): vscode.Tab[] {
  const targetKey = targetUri.toString();
  const matches: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === targetKey) {
        matches.push(tab);
      }
    }
  }
  return matches;
}

function getActiveTextTab(targetUri: vscode.Uri): vscode.Tab | undefined {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (
    activeTab?.input instanceof vscode.TabInputText &&
    activeTab.input.uri.toString() === targetUri.toString()
  ) {
    return activeTab;
  }
  return undefined;
}

function isTabOpen(targetTab: vscode.Tab): boolean {
  return vscode.window.tabGroups.all.some((group) => group.tabs.includes(targetTab));
}

async function ensureTrailingNewline(targetUri: vscode.Uri): Promise<void> {
  let content: Buffer;
  try {
    content = await fs.promises.readFile(targetUri.fsPath);
  } catch {
    return;
  }

  if (content.length === 0) {
    return;
  }

  const lastByte = content[content.length - 1];
  if (lastByte === 0x0a || lastByte === 0x0d) {
    return;
  }

  const newline = content.toString("utf8").includes("\r\n") ? "\r\n" : "\n";
  await fs.promises.appendFile(targetUri.fsPath, newline);
}

export function renderRuntimeOutput(host: RuntimeHost, text: string): void {
  if (!text) {
    return;
  }

  const formatted = formatViewOutput(text);
  renderRuntimeText(host, formatted, didOutputEndWithLineFeed(formatted));
}

export function handleRuntimeError(host: RuntimeHost, error: string): void {
  host.hasReceivedOutput = true;
  host.clearPromptRenderTimer();
  host.clearReplyPromptRenderTimer();
  const formatted = formatViewOutput(stripBracketedPasteMarkers(error));
  renderRuntimeText(
    host,
    `${ANSI.red}${formatted}${ANSI.reset}`,
    didOutputEndWithLineFeed(formatted)
  );
}

function renderRuntimeText(
  host: RuntimeHost,
  text: string,
  endedWithLineFeed: boolean
): void {
  if (!text) {
    return;
  }

  const pending = getPendingRuntimeRewrite(host);
  if (pending.clearFrame) {
    if (shouldReplacePendingClearFrame(text)) {
      pending.clearFrame = null;
    } else {
      const pendingClearFrame = pending.clearFrame;
      pending.clearFrame = null;
      writeRuntimeText(
        host,
        pendingClearFrame.text,
        pendingClearFrame.endedWithLineFeed
      );
    }
  }

  if (pending.bareCarriageReturn) {
    pending.bareCarriageReturn = false;
    if (text === "\r") {
      pending.bareCarriageReturn = true;
      return;
    }
    if (shouldPrefixPendingCarriageReturn(text)) {
      text = `\r${text}`;
      endedWithLineFeed = didOutputEndWithLineFeed(text);
    } else if (!text.startsWith("\r")) {
      writeRuntimeText(host, "\r", false);
    }
  }

  if (text === "\r") {
    pending.bareCarriageReturn = true;
    return;
  }

  if (shouldDeferClearFrame(text)) {
    pending.clearFrame = {
      text,
      endedWithLineFeed,
    };
    return;
  }

  writeRuntimeText(host, text, endedWithLineFeed);
}

function writeRuntimeText(
  host: RuntimeHost,
  text: string,
  endedWithLineFeed: boolean
): void {
  const shouldRestoreReplyPrompt = host.mode === "reply";
  const shouldRestoreReadyPrompt =
    endedWithLineFeed &&
    !host.submissionPending &&
    host.mode === "ready" &&
    host.promptReady &&
    host.activeSubmission === null &&
    (host.pendingPromptToken || host.promptVisible || host.inputState.text.length > 0);
  const shouldRearmReadyPrompt =
    !host.submissionPending &&
    host.mode === "ready" &&
    host.promptReady &&
    host.activeSubmission === null &&
    (host.promptVisible || host.inputState.text.length > 0);
  host.recordOutputActivity();
  if (host.promptVisible || host.inputState.text.length > 0) {
    host.clearInputRender();
    host.promptVisible = false;
    if (shouldRearmReadyPrompt) {
      host.pendingPromptToken = true;
    }
  }

  if (isSimpleCarriageReturnRewrite(text)) {
    host.writeEmitter.fire(rewriteSimpleCarriageReturnOutput(text));
  } else {
    host.writeEmitter.fire(text);
  }

  host.lastWriteEndedWithNewline = endedWithLineFeed;
  host.renderer.renderedLineCount = 1;
  host.renderer.cursorRowFromTop = 0;

  if (shouldRestoreReplyPrompt) {
    host.scheduleReplyPrompt();
  } else if (shouldRestoreReadyPrompt) {
    host.pendingPromptToken = true;
    host.schedulePrompt();
  }
}

function shouldPrefixPendingCarriageReturn(text: string): boolean {
  return !text.startsWith("\r") && !text.includes("\n");
}

function shouldDeferClearFrame(text: string): boolean {
  return /^\r\s*\| +$/.test(text);
}

function shouldReplacePendingClearFrame(text: string): boolean {
  return text.startsWith("\r") && !text.includes("\n");
}

function isSimpleCarriageReturnRewrite(text: string): boolean {
  return text.startsWith("\r") && !text.includes("\n") && !text.includes("\b") && !/\x1b\[/.test(text);
}

function rewriteSimpleCarriageReturnOutput(text: string): string {
  return `\x1b[2K\x1b[1G${text.slice(1)}`;
}

function didOutputEndWithLineFeed(text: string): boolean {
  return text.endsWith("\r\n");
}

function getPendingRuntimeRewrite(host: RuntimeHost): PendingRuntimeRewrite {
  let pending = pendingRuntimeRewrites.get(host);
  if (!pending) {
    pending = {
      bareCarriageReturn: false,
      clearFrame: null,
    };
    pendingRuntimeRewrites.set(host, pending);
  }
  return pending;
}

function discardPendingRuntimeRewrite(host: RuntimeHost): void {
  const pending = pendingRuntimeRewrites.get(host);
  if (!pending) {
    return;
  }

  pending.clearFrame = null;
  pending.bareCarriageReturn = false;
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
  host.awaitingExecutionStart = false;
  host.replyPromptText = "";
  host.runtimeBackend?.sendSessionCommand(host.rProcess, {
    type: "reply-input",
    text,
  });
}

export function startRuntimeSubmission(host: RuntimeHost, task: Submission): void {
  host.submissionPending = false;
  host.pendingPromptToken = false;
  host.awaitingExecutionStart = true;
  host.mode = "executing";
  writeRuntimeSubmissionEcho(host, task);
  host.clearPromptRenderTimer();
  host.runtimeBackend?.sendSessionCommand(host.rProcess, {
    type: "submit",
    code: task.code,
  });
}

export function finishRuntimeSubmission(host: RuntimeHost): void {
  host.activeSubmission = null;
  host.awaitingExecutionStart = false;
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
  skipSplit: boolean = false
) : Promise<string[]> {
  const blocks = skipSplit
    ? [normalizeSubmissionBlock(code)]
    : await splitSubmissionBlocks(host, code);

  if (blocks.length === 0) {
    host.submissionPending = false;
    host.awaitingExecutionStart = false;
    return [];
  }

  for (const block of blocks) {
    host.submissionQueue.push({
      code: block,
    });
  }

  void host.lang.refreshCompletionContextDocument(host.inputState.text);
  startNextRuntimeSubmission(host);
  return blocks;
}

function normalizeSubmissionBlock(code: string): string {
  return stripCommentLines(code.replace(/\n+$/, "")).trimEnd();
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
  host.syntax.setSource(plainLines);
  const plan = buildSubmissionRenderPlan(
    plainLines,
    Math.max(1, host.dimensions.rows - 1),
    host.dimensions.columns,
    host.renderer.promptLen,
    getContinuationPromptLength(host.renderer.continuationPromptText)
  );
  const styledLines = host.syntax.highlightLines(plan.lines, plan.sourceLineMap);
  writeRuntimeSubmissionLines(host, styledLines, plan.promptKinds);
  host.promptVisible = false;
}

function writeRuntimeSubmissionLines(
  host: RuntimeHost,
  styledLines: string[],
  promptKinds: Array<"main" | "cont">
): void {
  const continuationPad = 2;

  styledLines.forEach((line, index) => {
    if (index > 0) {
      host.writeEmitter.fire("\r\n");
    }
    const promptKind = promptKinds[index] ?? (index === 0 ? "main" : "cont");
    const prompt =
      promptKind === "main"
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
  discardPendingRuntimeRewrite(host);
  setNativeParseCallback(null);

  host.lang.cleanupCompletionDocument();
  host.lang.clearSessionState();
  host.lang.stopConsoleLsp();

  host.rProcess = null;
  host.backendChildPid = undefined;
  host.sessionHostConnected = false;
  host.mode = "closed";
  host.promptReady = false;
  host.promptVisible = false;
  host.replyPromptText = "";
  host.sessionAttached = false;
  host.awaitingExecutionStart = false;
  host.submissionPending = false;

  host.submissionQueue = [];
  host.activeSubmission = null;

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
