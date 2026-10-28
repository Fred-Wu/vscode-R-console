const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
  "./rTerminal/lang": {},
  vscode: { EventEmitter: class {} },
});
const runtime = loadSource("src/Terminal/rTerminal/runtime.ts", { vscode: {} });
const { InputState } = loadSource("src/Terminal/inputState.ts");
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
    mode: "ready", promptReady: true, promptKind: "main", promptVisible: false,
    autoMatch: false, tabSize: 2,
    submissionGeneration: 0, submissionQueue: [], activeSubmission: null,
    programmaticSubmissionQueue: Promise.resolve(), pendingProgrammaticInput: "",
    pendingConsoleInputLines: [], pasteBuffer: "", inBracketPaste: false,
    submissionPending: false, awaitingExecutionStart: false,
    rProcess: {}, sessionHostConnected: true,
    inputState: new InputState(), keyProcessor: new KeyProcessor(),
    dimensions: { columns: 80, rows: 24 }, lastWriteEndedWithNewline: true,
    lang: { refreshCompletionContextDocument: async () => {}, updateInput() {} },
    rHistory: { resetIndex() {}, push(code) { history.push(code); } },
    renderer: new Renderer(() => {}),
    syntax: { setSource() {}, highlightLines(lines) { return lines; } },
    runtimeBackend: {
      isAlive: () => true,
      canUseSessionCommands: () => true,
      sendSessionCommand(session, command) { commands.push(command); return true; },
    },
    writeEmitter: { fire(text) { output.push(text); } },
    ensureReadyPromptVisibleForInput() {},
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

test("Enter commits a snapshot, accepts further typing, and executes only the original command", async () => {
  const { terminal, commands } = createTerminal();
  const parse = deferred();
  terminal.inputState.insertText("x <- 1");
  terminal.inputState.isExpressionCompleteAsync = () => parse.promise;
  const enter = terminal.handleEnterKey();
  assert.equal(terminal.inputState.text, "");
  terminal.handleInput("b");
  terminal.handleInput("\x7f");
  terminal.handleInput("c");
  assert.equal(terminal.inputState.text, "c");
  parse.resolve(true);
  await enter;
  assert.deepEqual(commands, [{ type: "submit", code: "x <- 1" }]);
  assert.equal(terminal.inputState.text, "c");
});

test("an incomplete Enter restores continuation without dropping subsequent typing", async () => {
  const { terminal, commands } = createTerminal();
  const parse = deferred();
  terminal.inputState.insertText("x <- (");
  terminal.inputState.isExpressionCompleteAsync = () => parse.promise;
  const enter = terminal.handleEnterKey();
  terminal.handleInput("2");
  parse.resolve(false);
  await enter;
  assert.equal(terminal.inputState.text, "x <- (\n  2");
  assert.deepEqual(commands, []);
});

test("multiline paste commits its snapshot and does not erase newer keyboard input", async () => {
  const { terminal, commands } = createTerminal();
  const parse = deferred();
  terminal.inputState.isExpressionCompleteAsync = code => code === "a <- 1" ? parse.promise : Promise.resolve(true);
  terminal.pasteBuffer = "a <- 1\nb <- 2\n";
  const pasted = terminal.handlePasteEnd();
  terminal.handleInput("z");
  assert.equal(terminal.inputState.text, "z");
  parse.resolve(true);
  await pasted;
  assert.deepEqual(commands, [{ type: "submit", code: "a <- 1" }]);
  assert.equal(terminal.inputState.text, "z");
  nextPrompt(terminal);
  assert.deepEqual(commands.map(c => c.code), ["a <- 1", "b <- 2"]);
});

test("editor source streams the first complete block without waiting for later parsing", async () => {
  const { terminal, commands } = createTerminal();
  const later = deferred();
  terminal.inputState.isExpressionCompleteAsync = code => code === "b <- 2" ? later.promise : Promise.resolve(true);
  const pending = terminal.handleProgrammaticSubmission("a <- 1\nb <- 2\nc <- 3\n");
  await Promise.resolve();
  assert.deepEqual(commands.map(c => c.code), ["a <- 1"]);
  nextPrompt(terminal);
  assert.deepEqual(commands.map(c => c.code), ["a <- 1"]);
  later.resolve(true);
  await pending;
  assert.deepEqual(commands.map(c => c.code), ["a <- 1", "b <- 2"]);
  nextPrompt(terminal);
  assert.deepEqual(commands.map(c => c.code), ["a <- 1", "b <- 2", "c <- 3"]);
});

test("editor batch retains its position ahead of a later console Enter", async () => {
  const { terminal, commands } = createTerminal();
  const first = deferred();
  terminal.inputState.isExpressionCompleteAsync = code => code === "a <- 1" ? first.promise : Promise.resolve(true);
  terminal.handleInput("a <- 1\na <- 2\n");
  await Promise.resolve();
  terminal.handleInput("b");
  const enter = terminal.handleEnterKey();
  assert.equal(terminal.inputState.text, "");
  first.resolve(true);
  await terminal.programmaticSubmissionQueue;
  await enter;
  assert.deepEqual(commands.map(c => c.code), ["a <- 1"]);
  nextPrompt(terminal);
  assert.deepEqual(commands.map(c => c.code), ["a <- 1", "a <- 2"]);
  nextPrompt(terminal);
  assert.deepEqual(commands.map(c => c.code), ["a <- 1", "a <- 2", "b"]);
});

test("editor batch retains its position ahead of a later multiline console paste", async () => {
  const { terminal, commands } = createTerminal();
  const first = deferred();
  terminal.inputState.isExpressionCompleteAsync = code => code === "a <- 1" ? first.promise : Promise.resolve(true);
  terminal.handleInput("a <- 1\na <- 2\n");
  await Promise.resolve();
  terminal.pasteBuffer = "b <- 1\nb <- 2\n";
  const pasted = terminal.handlePasteEnd();
  first.resolve(true);
  await terminal.programmaticSubmissionQueue;
  await pasted;
  assert.deepEqual(commands.map(c => c.code), ["a <- 1"]);
  for (const expected of ["a <- 2", "b <- 1", "b <- 2"]) {
    nextPrompt(terminal);
    assert.equal(commands.at(-1).code, expected);
  }
});

test("incomplete source tail survives completed blocks and becomes editable at the next prompt", async () => {
  const { terminal, commands, history } = createTerminal();
  await terminal.handleProgrammaticSubmission("a <- 1\nb <- (\n");
  assert.deepEqual(commands.map(c => c.code), ["a <- 1"]);
  nextPrompt(terminal);
  assert.equal(terminal.inputState.text, "b <- (\n");
  assert.deepEqual(history, ["a <- 1"]);
});

test("Ctrl+C cancels queued blocks after an accepted interrupt", async () => {
  const { terminal, commands } = createTerminal();
  await terminal.handleProgrammaticSubmission("1\n2\n3\n");
  assert.deepEqual(commands.map(c => c.code), ["1"]);
  terminal.interruptR();
  nextPrompt(terminal);
  assert.deepEqual(commands.map(c => c.type), ["submit", "interrupt"]);
  assert.deepEqual(terminal.submissionQueue, []);
});

test("Ctrl+C during parsing invalidates pending source without late execution", async () => {
  const { terminal, commands } = createTerminal();
  const parse = deferred();
  terminal.inputState.isExpressionCompleteAsync = () => parse.promise;
  terminal.handleInput("x <- 1\n");
  const oldQueue = terminal.programmaticSubmissionQueue;
  await Promise.resolve();
  terminal.applyKeyAction({ type: "ctrl_c" });
  parse.resolve(true);
  await oldQueue;
  assert.deepEqual(commands, []);
  assert.equal(terminal.submissionQueue.length, 0);
});

test("failed backend delivery restores unsent blocks and does not strand the console", async () => {
  const { terminal, commands, output } = createTerminal();
  terminal.runtimeBackend.sendSessionCommand = () => false;
  await terminal.handleProgrammaticSubmission("a <- 1\nb <- 2\n");
  assert.deepEqual(commands, []);
  assert.equal(terminal.mode, "ready");
  assert.equal(terminal.activeSubmission, null);
  assert.equal(terminal.submissionQueue.length, 0);
  assert.equal(terminal.inputState.text, "a <- 1\nb <- 2");
  assert.match(output.join(""), /submission was not sent/i);
});

test("failed later backend delivery restores only unsent blocks", async () => {
  const { terminal, commands } = createTerminal();
  let sends = 0;
  terminal.runtimeBackend.sendSessionCommand = (session, command) => {
    if (++sends === 1) { commands.push(command); return true; }
    return false;
  };
  await terminal.handleProgrammaticSubmission("1\n2\n");
  nextPrompt(terminal);
  assert.deepEqual(commands.map(c => c.code), ["1"]);
  assert.equal(terminal.mode, "ready");
  assert.equal(terminal.inputState.text, "2");
});

test("rejected interrupt does not discard queued source", async () => {
  const { terminal } = createTerminal();
  await terminal.handleProgrammaticSubmission("1\n2\n");
  terminal.runtimeBackend.sendSessionCommand = () => false;
  terminal.interruptR();
  assert.equal(terminal.submissionQueue.length, 1);
});
