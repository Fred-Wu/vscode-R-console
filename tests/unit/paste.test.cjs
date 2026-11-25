const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createTerminal, createTerminalWithScreen, nextPrompt } = require("../helpers/submission-terminal.cjs");

const settle = () => new Promise(resolve => setImmediate(resolve));
const paste = text => `\x1b[200~${text}\x1b[201~`;

test("opening a console enables clipboard paste markers with editor bracketed paste disabled", () => {
  const { terminal, output } = createTerminal();
  terminal.options.bracketedPaste = false;
  terminal.isRunning = () => false;
  terminal.startR = () => {};
  terminal.lang.start = async () => {};
  terminal.open();
  assert.ok(output.includes("\x1b[?2004h"));
});

for (const text of ["42", "42\n", "x <- 1\ny <- 2\n\n", "x <- 1\r\ny <- 2\r", 'x <- "a\n\n']) {
  for (const chunked of [false, true]) {
    test(`paste remains editable without parsing or execution (${JSON.stringify(text)}, chunked=${chunked})`, async () => {
      const { terminal, commands, history } = createTerminal();
      terminal.inputState.isExpressionCompleteAsync = () => assert.fail("paste must not parse input");
      const input = paste(text);
      // Split both paste markers and the payload across input events.
      for (const chunk of chunked ? [input.slice(0, 3), input.slice(3, 7), input.slice(7, -3), input.slice(-3)] : [input]) {
        terminal.handleInput(chunk);
      }
      await settle();
      const normalized = text.replace(/\r\n?/g, "\n");
      assert.equal(terminal.inputState.text, normalized);
      assert.equal(terminal.inputState.cursorPosition, normalized.length);
      assert.deepEqual(terminal.submissionQueue, []);
      assert.deepEqual(commands, []);
      assert.deepEqual(history, []);
      terminal.handleInput("z");
      assert.equal(terminal.inputState.text, normalized + "z");
    });
  }
}

test("pasting into recalled history expands it and preserves the surrounding input", async t => {
  const { terminal, commands, screenLines } = createTerminalWithScreen(t);
  terminal.applyHistorySearchResult("sum(\n  1\n)");
  terminal.inputState.cursorPosition = 8;
  terminal.handleInput(paste("2,\r\n  "));
  assert.equal(terminal.inputState.text, "sum(\n  12,\n  \n)");
  assert.equal(terminal.inputState.cursorPosition, 13);
  assert.equal(terminal.historyCollapsed, false);
  assert.ok(screenLines().some(line => line.includes("12,")));
  assert.deepEqual(commands, []);
});

for (const separateEnter of [false, true]) {
  test(`Enter after paste submits once (separate event=${separateEnter})`, async () => {
    const { terminal, commands, history } = createTerminal();
    const input = paste("x <- 1\ny <- 2\n");
    if (separateEnter) {
      terminal.handleInput(input);
      await settle();
      assert.deepEqual(commands, []);
      terminal.handleInput("\r");
    } else {
      // vscode-R sendText(code, true) appends Enter outside the paste markers.
      terminal.handleInput(input + "\r");
    }
    await settle();
    assert.deepEqual(commands.map(command => command.code), ["x <- 1"]);
    nextPrompt(terminal);
    assert.deepEqual(commands.map(command => command.code), ["x <- 1", "y <- 2"]);
    assert.deepEqual(history, ["x <- 1", "y <- 2"]);
  });
}

test("nested reply paste waits for Enter before sending or queuing replies", () => {
  const { terminal, commands } = createTerminal();
  terminal.mode = "reply";
  terminal.promptVisible = true;
  const replies = [];
  terminal.sendReadlineReply = text => replies.push(text);
  terminal.handleInput(paste("first\r\nsecond"));
  assert.equal(terminal.inputState.text, "first\nsecond");
  assert.deepEqual(replies, []);
  assert.deepEqual(commands, []);
  assert.deepEqual(terminal.pendingConsoleInputLines, []);
  terminal.handleInput("\r");
  assert.deepEqual(replies, ["first"]);
  assert.deepEqual(terminal.pendingConsoleInputLines, ["second"]);
});

for (const text of ["answer\n1", "answer\n1\n"]) {
  for (const [name, key, edited, cursor] of [
    ["typing", "2", text + "2", text.length + 1],
    ["Backspace", "\x7f", text.slice(0, -1), text.length - 1],
    ["Ctrl+A", "\x01", text, text.lastIndexOf("\n") + 1],
    ["Ctrl+E", "\x05", text, text.length],
  ]) {
    test(`${name} after a nested reply paste only edits until Enter (${JSON.stringify(text)})`, () => {
      const { terminal, commands } = createTerminal();
      terminal.mode = "reply";
      terminal.promptVisible = true;
      terminal.handleInput(paste(text));
      terminal.handleInput(key);
      assert.equal(terminal.mode, "reply");
      assert.equal(terminal.inputState.text, edited);
      assert.equal(terminal.inputState.cursorPosition, cursor);
      assert.deepEqual(commands, []);
      assert.deepEqual(terminal.pendingConsoleInputLines, []);

      terminal.handleInput("\r");
      assert.deepEqual(commands, [{ type: "reply-input", text: "answer" }]);
      assert.deepEqual(terminal.pendingConsoleInputLines, edited.split("\n").slice(1));
    });
  }
}

for (const input of ["first\nsecond\r", "first\r\nsecond\r\n", paste("first\nsecond") + "\r"]) {
  test(`editor sends still submit multiple nested replies (${JSON.stringify(input)})`, () => {
    const { terminal, commands } = createTerminal();
    terminal.mode = "reply";
    terminal.promptVisible = true;
    terminal.handleInput(input);
    assert.deepEqual(commands, [{ type: "reply-input", text: "first" }]);
    assert.deepEqual(terminal.pendingConsoleInputLines, ["second"]);
  });
}

for (const atEnd of [false, true]) {
  test(`Enter submits pasted reply lines including trailing blank lines (cursor at end=${atEnd})`, () => {
    const { terminal } = createTerminal();
    terminal.mode = "reply";
    terminal.promptVisible = true;
    const replies = [];
    terminal.sendReadlineReply = text => replies.push(text);
    terminal.handleInput(paste("first\nsecond\n"));
    if (!atEnd) terminal.inputState.cursorPosition = 0;
    terminal.handleInput("\r");
    assert.deepEqual(replies, ["first"]);
    assert.deepEqual(terminal.pendingConsoleInputLines, ["second", ""]);
  });
}
