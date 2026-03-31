import * as vscode from "vscode";
import type { ChildProcess } from "child_process";
import { setNativeParseCallback } from "../../Language/parser";
import { type BackendControlEvent } from "../../Runtime/backendProtocol";
import {
  getRustSidecarCandidates,
  resolveRustSidecarPath,
  RuntimeBackend,
  RustSidecarRuntimeBackend,
} from "../../Runtime/runtimeBackend";
import type { SessionWatcher, WorkspaceData } from "../../Runtime/sessionWatcher";
import { ANSI, stripBracketedPasteMarkers } from "../ansi";
import { InputState } from "../inputState";
import {
  configureEmbeddedRRuntimeEnv,
  type RTerminalOptions,
  resolveRHome,
} from "../options";
import { Renderer } from "../renderer";
import { TerminalState } from "../terminalState";
import { RTermLang } from "./lang";
import { formatTerminalOutput as formatViewOutput } from "./view";

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

export type RuntimeHost = {
  options: RTerminalOptions;
  extensionPath: string;
  runtimeBackend: RuntimeBackend | undefined;
  rProcess: ChildProcess | null;
  backendChildPid: number | undefined;
  dimensions: Dimensions;
  terminalState: TerminalState;
  pendingScreenReplay: boolean;
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
  attachWaitTimer: NodeJS.Timeout | undefined;
  pendingSubmissionEcho: unknown;
  activeSubmission: Submission | null;
  submissionQueue: Submission[];
  sessionWatcher: SessionWatcher | undefined;
  inputState: InputState;
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
  isTrueTerminalBackendConfigured(): boolean;
  startNextSubmission(): void;
  finishActiveSubmission(): void;
  getDisplayPid(): number | undefined;
  onSessionDataChanged(data: WorkspaceData | undefined): void;
};

export function createRuntimeBackend(
  extensionPath: string
): RuntimeBackend | undefined {
  const sidecarPath = resolveRustSidecarPath(extensionPath);
  if (sidecarPath) {
    return new RustSidecarRuntimeBackend(sidecarPath);
  }
  return undefined;
}

export function startRuntime(host: RuntimeHost): void {
  host.clearPendingInputFlushTimer();
  host.clearPromptRenderTimer();
  host.lang.stopConsoleLsp();
  host.pendingScreenReplay = false;
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
  host.terminalState.reset();
  host.terminalState.resize(host.dimensions.columns, host.dimensions.rows);
  host.backendChildPid = undefined;
  host.sessionHostConnected = false;

  if (!host.runtimeBackend) {
    const candidates = host.extensionPath ? getRustSidecarCandidates(host.extensionPath) : [];
    const details =
      candidates.length > 0
        ? `\r\nTried sidecar paths:\r\n${candidates
            .map((candidate) => `- ${candidate}`)
            .join("\r\n")}`
        : "";
    host.writeEmitter.fire(
      `${ANSI.red}Failed to start R: sidecar backend not found.${ANSI.reset}${details}\r\n`
    );
    host.mode = "closed";
    return;
  }

  try {
    const args = [...host.options.rArgs];
    const runtimeEnv: NodeJS.ProcessEnv = { ...host.options.env };
    if (host.extensionPath) {
      runtimeEnv.VSC_R_EXT = host.extensionPath;
      runtimeEnv.VSC_R_COLS = String(Math.max(20, host.dimensions.columns || 80));
      runtimeEnv.VSC_R_ROWS = String(Math.max(5, host.dimensions.rows || 24));
    }
    const rHome = resolveRHome(host.options.rPath);
    if (rHome) {
      configureEmbeddedRRuntimeEnv(runtimeEnv, rHome);
    }
    const originalProfileUser =
      runtimeEnv.R_PROFILE_USER ?? process.env.R_PROFILE_USER ?? "";
    runtimeEnv.R_PROFILE_USER_ORIG = originalProfileUser;

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

    const displayPid = host.getDisplayPid();
    if (displayPid !== undefined) {
      host.nameEmitter.fire(`R Console (PID: ${displayPid})`);
    }
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

function waitForRuntimeAttach(host: RuntimeHost): void {
  if (!host.sessionWatcher) {
    host.sessionAttached = true;
    return;
  }
  host.sessionWatcher.refresh();
  if (host.sessionWatcher.isAttached()) {
    onRuntimeAttached(host);
    return;
  }
  if (host.attachWaitTimer) {
    clearInterval(host.attachWaitTimer);
  }
  host.attachWaitTimer = setInterval(() => {
    host.sessionWatcher?.refresh();
    if (!host.sessionWatcher?.isAttached()) {
      return;
    }
    onRuntimeAttached(host);
  }, 100);
}

function onRuntimeAttached(host: RuntimeHost): void {
  if (host.sessionAttached) {
    return;
  }
  if (host.attachWaitTimer) {
    clearInterval(host.attachWaitTimer);
    host.attachWaitTimer = undefined;
  }
  host.sessionAttached = true;
  if (!host.isTrueTerminalBackendConfigured()) {
    host.promptReady = true;
    host.pendingPromptToken = true;
  }
  host.onSessionDataChanged(host.sessionWatcher?.getWorkspaceData());
  const displayPid = host.getDisplayPid();
  if (displayPid !== undefined) {
    host.nameEmitter.fire(`R Console (PID: ${displayPid})`);
  }
  if (host.mode === "starting") {
    if (!host.isTrueTerminalBackendConfigured() || host.promptReady) {
      host.mode = "ready";
    }
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
        host.nameEmitter.fire(`R Console (PID: ${event.pid})`);
        if (host.options.sessionWatcherEnabled && host.sessionWatcher) {
          host.sessionWatcher.setExpectedPid(event.pid);
          host.sessionWatcher.start();
          waitForRuntimeAttach(host);
        }
      } else if (host.options.sessionWatcherEnabled && host.sessionWatcher) {
        host.sessionWatcher.start();
        waitForRuntimeAttach(host);
      }
      return;
    case "prompt":
      handleBackendPrompt(host, event.kind);
      return;
    case "busy":
      if (host.isTrueTerminalBackendConfigured() && event.value && host.mode !== "reply") {
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
  host.pendingSubmissionEcho = undefined;
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

export function renderRuntimeOutput(host: RuntimeHost, text: string): void {
  if (!text) {
    return;
  }

  const shouldRestoreReplyPrompt = host.mode === "reply";
  const shouldRestoreReadyPrompt =
    host.mode === "ready" &&
    host.promptReady &&
    (host.pendingPromptToken || host.promptVisible || host.inputState.text.length > 0);
  const formatted = formatViewOutput(text);
  host.recordOutputActivity();
  host.pendingSubmissionEcho = undefined;
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
  const shouldRestoreReplyPrompt = host.mode === "reply";
  const shouldRestoreReadyPrompt =
    host.mode === "ready" &&
    host.promptReady &&
    (host.pendingPromptToken || host.promptVisible || host.inputState.text.length > 0);
  host.recordOutputActivity();
  host.pendingSubmissionEcho = undefined;
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

export function interruptRuntime(host: RuntimeHost): void {
  if (!host.rProcess || host.rProcess.killed) {
    return;
  }

  if (host.isSessionProtocolActive() && host.mode === "executing") {
    host.writeEmitter.fire("^C\r\n");
    host.runtimeBackend?.sendSessionCommand(host.rProcess, {
      type: "interrupt",
    });
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
    host.runtimeBackend?.sendSessionCommand(host.rProcess, {
      type: "interrupt",
    });
    return;
  }

  if (host.mode === "ready" && host.inputState.text.length > 0) {
    host.clearInputRender();
    host.inputState.reset();
    host.renderInput();
    return;
  }

  host.writeEmitter.fire("^C\r\n");
  host.runtimeBackend?.write(host.rProcess, "\x03");

  host.inputState.reset();
  host.activeSubmission = null;

  host.mode = "ready";
  host.pendingPromptToken = true;
  host.schedulePrompt();
}

export function handleRuntimeExit(host: RuntimeHost, code: number): void {
  host.clearPendingInputFlushTimer();
  host.clearPromptRenderTimer();
  host.clearReplyPromptRenderTimer();
  setNativeParseCallback(null);

  if (host.attachWaitTimer) {
    clearInterval(host.attachWaitTimer);
    host.attachWaitTimer = undefined;
  }

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

  host.writeEmitter.fire(
    `\r\n${ANSI.yellow}R exited with code ${code}${ANSI.reset}\r\n`
  );
  host.closeEmitter.fire(code);
}

function updateNativeParseCallback(host: RuntimeHost): void {
  if (!host.runtimeBackend || !host.rProcess || !host.sessionHostConnected) {
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
