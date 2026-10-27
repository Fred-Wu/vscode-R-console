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

function createTerminal() {
  const commands = [];
  const history = [];
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    mode: "ready", promptReady: true, promptKind: "main", promptVisible: false,
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
    writeEmitter: { fire() {} },
    renderInput() { this.promptVisible = true; },
    clearInputRender() { this.promptVisible = false; },
    clearPromptRenderTimer() {}, clearReplyPromptRenderTimer() {},
    schedulePrompt() {}, scheduleReplyPrompt() {},
    getProgrammaticSubmissionFlushDelay() { return 1; },
  });
  terminal.runtimeHostAdapter = terminal.createRuntimeHost();
  return { terminal, commands, history };
}

test("incomplete editor tail survives completed expressions and is editable at the next prompt", async () => {
  const { terminal, commands, history } = createTerminal();
  await terminal.handleProgrammaticSubmission("x <- 1\ny <- (\n");
  assert.deepEqual(commands, [{ type: "submit", code: "x <- 1" }]);
  assert.deepEqual(history, ["x <- 1"]);
  assert.equal(terminal.inputState.text, "");
  runtime.handleRuntimeControl(terminal.runtimeHostAdapter, { type: "busy", value: true });
  runtime.handleBackendPrompt(terminal.runtimeHostAdapter, "main");
  assert.equal(terminal.inputState.text, "y <- (");
  assert.equal(terminal.inputState.isAtEnd, true);
  assert.equal(terminal.mode, "ready");
  terminal.inputState.insertText("2)");
  await terminal.handleEnterKey();
  assert.deepEqual(commands.at(-1), { type: "submit", code: "y <- (2)" });
  assert.deepEqual(history, ["x <- 1", "y <- (2)"]);
});

test("an entirely incomplete submission is restored without execution or history", async () => {
  const { terminal, commands, history } = createTerminal();
  await terminal.handleProgrammaticSubmission("f <- function(x) {\n");
  assert.equal(terminal.inputState.text, "f <- function(x) {");
  assert.deepEqual(commands, []);
  assert.deepEqual(history, []);
});

test("a pending tail survives nested input and is not used as a reply", async () => {
  const { terminal, commands } = createTerminal();
  await terminal.handleProgrammaticSubmission('readline("name: ")\ny <- (\n');
  runtime.handleBackendInputRequest(terminal.runtimeHostAdapter, "name: ");
  terminal.inputState.insertText("Ada");
  runtime.sendRuntimeReply(terminal.runtimeHostAdapter, "Ada");
  runtime.handleBackendPrompt(terminal.runtimeHostAdapter, "main");
  assert.equal(terminal.inputState.text, "y <- (");
  assert.deepEqual(commands.map(command => command.type), ["submit", "reply-input"]);
});

for (const mode of ["executing", "reply"]) {
  test(`Ctrl+C cancels the remaining batch while ${mode}`, async () => {
    const { terminal, commands } = createTerminal();
    await terminal.handleProgrammaticSubmission('Sys.sleep(30)\nmessage("must not run")\ny <- (\n');
    terminal.mode = mode;
    // Also covers interrupt before the first busy notification.
    terminal.interruptR();
    runtime.handleBackendPrompt(terminal.runtimeHostAdapter, "main");
    assert.deepEqual(commands.map(command => command.type), ["submit", "interrupt"]);
    assert.deepEqual(terminal.submissionQueue, []);
    assert.equal(terminal.inputState.text, "");
    assert.equal(terminal.mode, "ready");
    await terminal.handleProgrammaticSubmission("42\n");
    assert.deepEqual(commands.at(-1), { type: "submit", code: "42" });
  });
}

test("rejected interrupt retains queued submissions", async () => {
  const { terminal } = createTerminal();
  await terminal.handleProgrammaticSubmission("1\n2\n");
  terminal.runtimeBackend.sendSessionCommand = () => false;
  terminal.interruptR();
  assert.equal(terminal.submissionQueue.length, 1);
  assert.equal(terminal.submissionGeneration, 0);
});

test("Ctrl+C invalidates an in-flight parse before it can queue or restore input", async () => {
  const { terminal, commands, history } = createTerminal();
  let resolveParse;
  terminal.inputState.isExpressionCompleteAsync = () => new Promise(resolve => { resolveParse = resolve; });
  const pending = terminal.handleProgrammaticSubmission("1\n2\n");
  terminal.interruptR();
  resolveParse(true);
  await pending;
  assert.deepEqual(commands, [{ type: "interrupt" }]);
  assert.deepEqual(terminal.submissionQueue, []);
  assert.deepEqual(history, []);
  assert.equal(terminal.inputState.text, "");
});

for (const action of ["enter", "paste"]) {
  test(`Ctrl+C invalidates an in-flight ${action} completeness check`, async () => {
    const { terminal, commands } = createTerminal();
    let resolveParse;
    terminal.inputState.isExpressionCompleteAsync = () => new Promise(resolve => { resolveParse = resolve; });
    terminal.inputState.insertText("1");
    terminal.pasteBuffer = "\n2\n";
    const pending = action === "enter" ? terminal.handleEnterKey() : terminal.handlePasteEnd();
    terminal.interruptR();
    resolveParse(true);
    await pending;
    assert.deepEqual(commands, []);
    assert.equal(terminal.inputState.text, "");
    assert.deepEqual(terminal.submissionQueue, []);
  });
}

test("Ctrl+C cancels waiting editor requests and buffered input without blocking new requests", async () => {
  const { terminal, commands } = createTerminal();
  terminal.mode = "executing";
  terminal.queueProgrammaticSubmission("old1\n");
  terminal.queueProgrammaticSubmission("old2\n");
  const oldQueue = terminal.programmaticSubmissionQueue;
  await Promise.resolve(); // Let the first request start waiting for a prompt.
  terminal.bufferProgrammaticInput("old3");
  terminal.pendingConsoleInputLines.push("old4");
  terminal.interruptR();
  terminal.mode = "ready";
  terminal.queueProgrammaticSubmission("new\n");
  await terminal.programmaticSubmissionQueue;
  await oldQueue;
  assert.deepEqual(commands, [{ type: "interrupt" }, { type: "submit", code: "new" }]);
  assert.equal(terminal.pendingProgrammaticInput, "");
  assert.equal(terminal.pendingInputFlushTimer, null);
  assert.deepEqual(terminal.pendingConsoleInputLines, []);
});

test("raw-string contents and following expressions survive submission splitting", async () => {
  const { terminal, commands, history } = createTerminal();
  const code = 's <- r"-(a-"\n#keep\nb)-"';
  await terminal.handleProgrammaticSubmission(`${code}\nprint(s)\n`);
  assert.deepEqual(commands, [{ type: "submit", code }]);
  assert.deepEqual(history, [code, "print(s)"]);
  runtime.handleRuntimeControl(terminal.runtimeHostAdapter, { type: "busy", value: true });
  runtime.handleBackendPrompt(terminal.runtimeHostAdapter, "main");
  assert.deepEqual(commands.at(-1), { type: "submit", code: "print(s)" });
});

test("unfinished string contents retain trailing spaces and newlines for editing", async () => {
  for (const tail of ['s <- "unfinished  ', 's <- r"--(unfinished\n# content  \n']) {
    const { terminal } = createTerminal();
    await terminal.handleProgrammaticSubmission(`1\n${tail}\n`);
    runtime.handleRuntimeControl(terminal.runtimeHostAdapter, { type: "busy", value: true });
    runtime.handleBackendPrompt(terminal.runtimeHostAdapter, "main");
    assert.equal(terminal.inputState.text, tail);
  }
});
