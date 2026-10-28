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


test("Enter commits input before the existing parser can finish", async () => {
  for (const complete of [false, true]) {
    const { terminal, commands } = createTerminal();
    let finishParse;
    terminal.inputState.isExpressionCompleteAsync = () =>
      new Promise(resolve => { finishParse = resolve; });
    terminal.inputState.insertText("x <- 1");
    const pending = terminal.handleEnterKey();
    terminal.handleInput("2");
    terminal.handleInput("\x7f");
    terminal.handleInput("\x1b[D");
    terminal.handleInput("\r");
    assert.equal(terminal.inputState.text, "x <- 1");
    assert.equal(terminal.inputState.cursorPosition, 6);
    finishParse(complete);
    await pending;
    assert.equal(terminal.inputCommitPending, false);
    if (complete) {
      assert.deepEqual(commands, [{ type: "submit", code: "x <- 1" }]);
      assert.equal(terminal.inputState.text, "");
    } else {
      assert.deepEqual(commands, []);
      assert.equal(terminal.inputState.text, "x <- 1\n");
    }
  }
});

test("incomplete Enter allows new input after the parse, not during it", async () => {
  const { terminal, commands } = createTerminal();
  let finishParse;
  terminal.inputState.isExpressionCompleteAsync = () =>
    new Promise(resolve => { finishParse = resolve; });
  terminal.inputState.insertText("x <- (");
  const pending = terminal.handleEnterKey();
  terminal.handleInput("4");
  assert.equal(terminal.inputState.text, "x <- (");
  finishParse(false);
  await pending;
  terminal.handleInput("42)");
  assert.equal(terminal.inputState.text, "x <- (\n  42)");
  assert.deepEqual(commands, []);
});

test("Ctrl+C releases a committed Enter even when the old parser finishes later", async () => {
  const { terminal, commands } = createTerminal();
  let finishParse;
  terminal.inputState.isExpressionCompleteAsync = () =>
    new Promise(resolve => { finishParse = resolve; });
  terminal.inputState.insertText("x <- 1");
  const pending = terminal.handleEnterKey();
  terminal.handleInput("\x03");
  finishParse(true);
  await pending;
  assert.equal(terminal.inputCommitPending, false);
  assert.equal(terminal.inputState.text, "");
  assert.deepEqual(commands, []);
});

test("multiline paste commits its input before the existing parser returns", async () => {
  for (const complete of [false, true]) {
    const { terminal, commands } = createTerminal();
    let finishParse;
    terminal.inputState.isExpressionCompleteAsync = () =>
      new Promise(resolve => { finishParse = resolve; });
    terminal.pasteBuffer = "x <- 1\n";
    const pending = terminal.handlePasteEnd();
    terminal.handleInput("2");
    terminal.handleInput("\x1b[D");
    assert.equal(terminal.inputState.text, "x <- 1");
    assert.equal(terminal.inputState.isAtEnd, true);
    finishParse(complete);
    await pending;
    assert.equal(terminal.inputCommitPending, false);
    if (complete) {
      assert.deepEqual(commands, [{ type: "submit", code: "x <- 1" }]);
      assert.equal(terminal.inputState.text, "");
    } else {
      assert.deepEqual(commands, []);
      assert.equal(terminal.inputState.text, "x <- 1");
      terminal.handleInput(" + 2");
      assert.equal(terminal.inputState.text, "x <- 1 + 2");
    }
  }
});

test("Ctrl+C releases a committed paste without submitting it", async () => {
  const { terminal, commands } = createTerminal();
  let finishParse;
  terminal.inputState.isExpressionCompleteAsync = () =>
    new Promise(resolve => { finishParse = resolve; });
  terminal.pasteBuffer = "x <- 1\n";
  const pending = terminal.handlePasteEnd();
  terminal.handleInput("\x03");
  finishParse(true);
  await pending;
  assert.equal(terminal.inputCommitPending, false);
  assert.equal(terminal.inputState.text, "");
  assert.deepEqual(commands, []);
});

test("Enter and paste preserve one completeness request apiece", async () => {
  const { terminal, commands } = createTerminal();
  const requests = [];
  terminal.inputState.isExpressionCompleteAsync = (code) => {
    requests.push(code);
    return Promise.resolve(true);
  };
  terminal.inputState.insertText("1");
  await terminal.handleEnterKey();
  assert.deepEqual(requests, ["1"]);
  assert.deepEqual(commands, [{ type: "submit", code: "1" }]);
  runtime.handleRuntimeControl(terminal.runtimeHostAdapter, { type: "busy", value: true });
  runtime.handleBackendPrompt(terminal.runtimeHostAdapter, "main");
  terminal.pasteBuffer = "2\n";
  await terminal.handlePasteEnd();
  assert.deepEqual(requests, ["1", "2"]);
  assert.deepEqual(commands.at(-1), { type: "submit", code: "2" });
});

test("paste at an interior cursor remains an edit, not a submission", async () => {
  const { terminal, commands } = createTerminal();
  terminal.inputState.insertText("x <- 3");
  terminal.inputState.cursorPosition = 5;
  terminal.pasteBuffer = "2\n";
  await terminal.handlePasteEnd();
  assert.equal(terminal.inputState.text, "x <- 23");
  assert.deepEqual(commands, []);
});

test("submitted multiline paste stays committed through block splitting", async () => {
  const { terminal, commands } = createTerminal();
  let finishSplit;
  terminal.inputState.isExpressionCompleteAsync = code =>
    code === "a <- 1\nb <- 2"
      ? Promise.resolve(true)
      : code === "a <- 1"
        ? new Promise(resolve => { finishSplit = resolve; })
        : Promise.resolve(true);
  terminal.pasteBuffer = "a <- 1\nb <- 2\n";
  const pending = terminal.handlePasteEnd();
  await Promise.resolve();
  assert.equal(typeof finishSplit, "function");
  assert.equal(terminal.inputCommitPending, true);
  terminal.handleInput("o");
  assert.equal(terminal.inputState.text, "");
  finishSplit(true);
  await pending;
  assert.equal(terminal.inputCommitPending, false);
  assert.deepEqual(commands, [{ type: "submit", code: "a <- 1" }]);
});

test("source-editor commands received during committed Enter wait in the existing queue", async () => {
  const { terminal, commands } = createTerminal();
  let finishParse;
  terminal.inputState.insertText("x <- 1");
  terminal.inputState.isExpressionCompleteAsync = code =>
    code === "x <- 1"
      ? new Promise(resolve => { finishParse = resolve; })
      : Promise.resolve(true);
  const enter = terminal.handleEnterKey();
  terminal.handleInput("y <- 2\n");
  assert.equal(terminal.inputState.text, "x <- 1");
  finishParse(true);
  await enter;
  runtime.handleRuntimeControl(terminal.runtimeHostAdapter, { type: "busy", value: true });
  runtime.handleBackendPrompt(terminal.runtimeHostAdapter, "main");
  await terminal.programmaticSubmissionQueue;
  assert.deepEqual(commands, [
    { type: "submit", code: "x <- 1" },
    { type: "submit", code: "y <- 2" },
  ]);
});
