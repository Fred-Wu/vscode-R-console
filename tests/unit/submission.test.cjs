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
  const output = [];
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

test("ready-mode Ctrl+C invalidates an in-flight editor parse with empty input", async () => {
  const { terminal, commands, history } = createTerminal();
  let resolveParse;
  terminal.inputState.isExpressionCompleteAsync = () => new Promise(resolve => { resolveParse = resolve; });
  const pending = terminal.handleProgrammaticSubmission("1\n2\n");
  terminal.applyKeyAction({ type: "ctrl_c" });
  resolveParse(true);
  await pending;
  assert.deepEqual(commands, []);
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
    terminal.applyKeyAction({ type: "ctrl_c" });
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

test("ready-mode Ctrl+C cancels queued submissions even with editable input", async () => {
  const { terminal, commands } = createTerminal();
  terminal.inputState.insertText("not submitted");
  terminal.submissionQueue.push({ kind: "execute", code: "old", initialPromptKind: "main" });
  terminal.applyKeyAction({ type: "ctrl_c" });
  assert.equal(terminal.inputState.text, "");
  assert.deepEqual(terminal.submissionQueue, []);
  assert.equal(terminal.submissionGeneration, 1);
  assert.deepEqual(commands, []);
});

test("rejected delivery restores the unsent batch without leaving R executing", async () => {
  const { terminal, commands, output } = createTerminal();
  terminal.runtimeBackend.sendSessionCommand = () => false;
  await terminal.handleProgrammaticSubmission("1\n2\ny <- (\n");
  assert.deepEqual(commands, []);
  assert.equal(terminal.mode, "ready");
  assert.equal(terminal.activeSubmission, null);
  assert.equal(terminal.awaitingExecutionStart, false);
  assert.deepEqual(terminal.submissionQueue, []);
  assert.equal(terminal.inputState.text, "1\n2\ny <- (");
  assert.match(output.join(""), /submission was not sent.*Unsent code restored/);
});

test("rejected later delivery restores only the code not already submitted", async () => {
  const { terminal, commands } = createTerminal();
  let sends = 0;
  terminal.runtimeBackend.sendSessionCommand = (_session, command) => {
    if (++sends > 1) return false;
    commands.push(command);
    return true;
  };
  await terminal.handleProgrammaticSubmission("1\n2\ny <- (\n");
  runtime.handleRuntimeControl(terminal.runtimeHostAdapter, { type: "busy", value: true });
  runtime.handleBackendPrompt(terminal.runtimeHostAdapter, "main");
  assert.deepEqual(commands, [{ type: "submit", code: "1" }]);
  assert.equal(terminal.inputState.text, "2\ny <- (");
  assert.deepEqual(terminal.submissionQueue, []);
  assert.equal(terminal.activeSubmission, null);
  assert.equal(terminal.mode, "ready");
});

test("async editor parsing cannot overwrite console text entered during the parse", async () => {
  const { terminal, commands } = createTerminal();
  let resolveTail;
  terminal.inputState.isExpressionCompleteAsync = (code) =>
    code === "1" ? Promise.resolve(true) : new Promise((resolve) => { resolveTail = resolve; });
  const pending = terminal.handleProgrammaticSubmission("1\ny <- (\n");
  await Promise.resolve();
  assert.equal(typeof resolveTail, "function");
  terminal.inputState.insertText("user input");
  resolveTail(false);
  await pending;
  assert.deepEqual(commands, []);
  assert.equal(terminal.inputState.text, "user input");
  assert.deepEqual(terminal.submissionQueue.map((task) => task.kind), ["execute", "edit"]);
  terminal.inputState.reset();
  terminal.startNextSubmission();
  assert.deepEqual(commands, [{ type: "submit", code: "1" }]);
  runtime.handleRuntimeControl(terminal.runtimeHostAdapter, { type: "busy", value: true });
  runtime.handleBackendPrompt(terminal.runtimeHostAdapter, "main");
  assert.equal(terminal.inputState.text, "y <- (");
});

test("an edit tail cannot append to console input entered during earlier execution", async () => {
  const { terminal, commands } = createTerminal();
  await terminal.handleProgrammaticSubmission("1\ny <- (\n");
  terminal.inputState.insertText("user input");
  runtime.handleRuntimeControl(terminal.runtimeHostAdapter, { type: "busy", value: true });
  runtime.handleBackendPrompt(terminal.runtimeHostAdapter, "main");
  assert.equal(terminal.inputState.text, "user input");
  assert.equal(terminal.submissionQueue.length, 1);
  terminal.inputState.reset();
  terminal.startNextSubmission();
  assert.equal(terminal.inputState.text, "y <- (");
  assert.deepEqual(commands, [{ type: "submit", code: "1" }]);
});

test("Enter ignores stale completeness after input changes during parsing", async () => {
  for (const complete of [false, true]) {
    const { terminal, commands } = createTerminal();
    let resolveParse;
    terminal.inputState.isExpressionCompleteAsync = () => new Promise(resolve => { resolveParse = resolve; });
    terminal.inputState.insertText("1");
    const pending = terminal.handleEnterKey();
    terminal.inputState.insertText(" + 2");
    resolveParse(complete);
    await pending;
    assert.equal(terminal.inputState.text, "1 + 2");
    assert.deepEqual(commands, []);
  }
});

test("Enter ignores stale completeness after cursor movement", async () => {
  const { terminal, commands } = createTerminal();
  let resolveParse;
  terminal.inputState.isExpressionCompleteAsync = () => new Promise(resolve => { resolveParse = resolve; });
  terminal.inputState.insertText("x <- 1");
  const pending = terminal.handleEnterKey();
  terminal.inputState.cursorPosition = 0;
  resolveParse(true);
  await pending;
  assert.equal(terminal.inputState.text, "x <- 1");
  assert.equal(terminal.inputState.cursorPosition, 0);
  assert.deepEqual(commands, []);
});

test("Enter does not apply a stale result after entering reply mode", async () => {
  const { terminal, commands } = createTerminal();
  let resolveParse;
  terminal.inputState.isExpressionCompleteAsync = () => new Promise(resolve => { resolveParse = resolve; });
  terminal.inputState.insertText("x <- 1");
  const pending = terminal.handleEnterKey();
  terminal.mode = "reply";
  resolveParse(true);
  await pending;
  assert.equal(terminal.inputState.text, "x <- 1");
  assert.deepEqual(commands, []);
});

test("multiline paste is inserted before parsing and cannot erase subsequent typing", async () => {
  for (const complete of [false, true]) {
    const { terminal, commands } = createTerminal();
    let resolveParse;
    terminal.inputState.isExpressionCompleteAsync = () => new Promise(resolve => { resolveParse = resolve; });
    terminal.pasteBuffer = "x <- 1\n";
    const pending = terminal.handlePasteEnd();
    assert.equal(terminal.inputState.text, "x <- 1");
    terminal.inputState.insertText(" + 2");
    resolveParse(complete);
    await pending;
    assert.equal(terminal.inputState.text, "x <- 1 + 2");
    assert.deepEqual(commands, []);
  }
});

test("paste parse cannot execute after the cursor moves", async () => {
  const { terminal, commands } = createTerminal();
  let resolveParse;
  terminal.inputState.isExpressionCompleteAsync = () => new Promise(resolve => { resolveParse = resolve; });
  terminal.pasteBuffer = "x <- 1\n";
  const pending = terminal.handlePasteEnd();
  terminal.inputState.cursorPosition = 0;
  resolveParse(true);
  await pending;
  assert.equal(terminal.inputState.text, "x <- 1");
  assert.equal(terminal.inputState.cursorPosition, 0);
  assert.deepEqual(commands, []);
});

test("complete multiline paste still submits without additional checking", async () => {
  const { terminal, commands, history } = createTerminal();
  terminal.pasteBuffer = "x <- 1 +\n 2\n";
  await terminal.handlePasteEnd();
  assert.deepEqual(commands, [{ type: "submit", code: "x <- 1 +\n 2" }]);
  assert.deepEqual(history, ["x <- 1 +\n 2"]);
  assert.equal(terminal.inputState.text, "");
});

test("incomplete multiline paste remains in the editable input", async () => {
  const { terminal, commands } = createTerminal();
  terminal.pasteBuffer = "x <- (\n";
  await terminal.handlePasteEnd();
  assert.equal(terminal.inputState.text, "x <- (");
  assert.deepEqual(commands, []);
});

test("paste at an interior cursor preserves existing source order", async () => {
  const { terminal, commands } = createTerminal();
  terminal.inputState.insertText("x <- 3");
  terminal.inputState.cursorPosition = 5;
  terminal.pasteBuffer = "2\n";
  await terminal.handlePasteEnd();
  assert.equal(terminal.inputState.text, "x <- 23");
  assert.deepEqual(commands, []);
});
