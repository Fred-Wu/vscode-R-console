const loadSource = require("./load-source.cjs");
const parser = loadSource("src/Language/parser.ts");
const runtime = loadSource("src/Terminal/rTerminal/runtime.ts", { vscode: {}, "../../Language/parser": parser });
const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
  "./rTerminal/lang": {},
  "./rTerminal/runtime": runtime,
  vscode: {
    EventEmitter: class {}, window: {},
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  },
});
const { InputState } = loadSource("src/Terminal/inputState.ts", { "../Language/parser": parser });
const { Renderer } = loadSource("src/Terminal/renderer.ts");
const { KeyProcessor } = loadSource("src/Terminal/keyProcessor.ts");

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve: value => resolve(value) };
}

function createTerminal() {
  const commands = [];
  const history = [];
  const output = [];
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    options: { vscodeR: { kind: "disabled" } },
    mode: "ready", promptReady: true, promptKind: "main", promptVisible: false,
    autoMatch: false, tabSize: 2,
    submissionGeneration: 0, submissionQueue: [], activeSubmission: null,
    programmaticSubmissionQueue: Promise.resolve(), pendingProgrammaticInput: "",
    pendingConsoleInputLines: [], pasteBuffer: "", inBracketPaste: false,
    submissionPending: false, awaitingExecutionStart: false,
    rProcess: {}, sessionHostConnected: true,
    nameEmitter: { fire() {} }, closeEmitter: { fire() {} }, notifyDisplayPidChanged() {},
    inputState: new InputState(), keyProcessor: new KeyProcessor(),
    dimensions: { columns: 80, rows: 24 }, lastWriteEndedWithNewline: true,
    lang: { refreshCompletionContextDocument: async () => {}, updateInput() {}, clearSessionState() {} },
    rHistory: { resetIndex() {}, push(code) { history.push(code); } },
    renderer: new Renderer(() => {}),
    syntax: { setSource() {}, highlightLines(lines) { return lines; } },
    runtimeBackend: {
      isAlive: () => true,
      hasCapability: () => false,
      canUseSessionCommands: () => true,
      sendSessionCommand(session, command) { commands.push(command); return true; },
    },
    writeEmitter: { fire(text) { output.push(text); } },
    ensureReadyPromptVisibleForInput() {},
    captureVisibleInputForReplay() {},
    renderInput() { this.promptVisible = true; },
    clearInputRender() { this.promptVisible = false; },
    clearPromptRenderTimer() {}, clearReplyPromptRenderTimer() {},
    schedulePrompt() {}, scheduleReplyPrompt() {},
    getProgrammaticSubmissionFlushDelay() { return 1; },
  });
  terminal.runtimeHostAdapter = terminal.createRuntimeHost();
  return { terminal, commands, history, output };
}
function nextPrompt(terminal) {
  runtime.handleRuntimeControl(terminal.runtimeHostAdapter, { type: "busy", value: true });
  runtime.handleBackendPrompt(terminal.runtimeHostAdapter, "main");
}

function createTerminalWithScreen(t) {
  const { Terminal } = require("@xterm/headless");
  const { InlineCompletion } = loadSource("src/Terminal/inlineCompletion.ts");
  const fixture = createTerminal();
  const { terminal, output } = fixture;
  const screen = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  terminal.inlineCompletion = new InlineCompletion(screen._core.unicodeService);
  terminal.inlineSuggestionRowCount = 0;
  terminal.lang.cancelCompletion = () => {};
  terminal.pendingPromptToken = false;
  terminal.writeEmitter.fire = text => {
    output.push(text);
    screen._core._writeBuffer.writeSync(text);
  };
  terminal.renderer = new Renderer(text => terminal.writeEmitter.fire(text));
  // Exercise the actual prompt, clear, and rendering paths, including ANSI output.
  for (const key of ["ensureReadyPromptVisibleForInput", "renderInput", "clearInputRender",
    "schedulePrompt", "clearPromptRenderTimer"]) delete terminal[key];
  terminal.getPromptRenderDelay = () => 0;
  terminal.showPrompt();
  t.after(() => {
    terminal.clearPromptRenderTimer();
    terminal.dismissInlineCompletion(false);
    screen.dispose();
  });
  const screenLines = () => Array.from({ length: screen.buffer.active.length },
    (_, index) => screen.buffer.active.getLine(index).translateToString(true)).filter(Boolean);
  return { ...fixture, screenLines };
}

module.exports = { createTerminal, createTerminalWithScreen, nextPrompt, deferred, runtime, parser };
