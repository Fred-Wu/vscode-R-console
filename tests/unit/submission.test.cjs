const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createTerminal, nextPrompt, deferred, parser } = require("../helpers/submission-terminal.cjs");

// An extra turn also drains Enter handlers invoked by handleInput without an
// exposed promise. Tests control parser completion explicitly, never by sleeps.
const settle = () => new Promise(resolve => setImmediate(resolve));

for (const [opening, closing] of [['x <- "a  ', 'b"'], ['x <- r"(a  ', 'b)"']]) {
  for (const overlap of [false, true]) {
    test(`Enter preserves literal trailing whitespace (${opening}, overlap=${overlap})`, async () => {
      const { terminal, commands } = createTerminal();
      terminal.inputState.insertText(opening);
      const first = terminal.handleEnterKey();
      if (!overlap) await first;
      terminal.inputState.insertText(closing);
      await Promise.all([first, terminal.handleEnterKey()]);
      assert.deepEqual(commands.map(c => c.code), [opening + "\n" + closing]);
    });
  }
}

test("repeated Enter preserves blank lines inside a multiline string", async () => {
  const { terminal, commands } = createTerminal();
  terminal.inputState.insertText('x <- "a  ');
  await terminal.handleEnterKey();
  await terminal.handleEnterKey();
  await terminal.handleEnterKey();
  assert.equal(terminal.inputState.text, 'x <- "a  \n\n\n');
  terminal.inputState.insertText('b"');
  await terminal.handleEnterKey();
  assert.deepEqual(commands.map(c => c.code), ['x <- "a  \n\n\nb"']);
});

test("Enter restores its newline and cursor inside incomplete input", async () => {
  const { terminal, commands } = createTerminal();
  terminal.inputState.insertText("c(1,2");
  terminal.inputState.cursorPosition = 4;
  await terminal.handleEnterKey();
  assert.equal(terminal.inputState.text, "c(1,\n2");
  assert.equal(terminal.inputState.cursorPosition, 5);
  assert.deepEqual(commands, []);
});

test("Enter inside complete input executes the original expression unchanged", async () => {
  const { terminal, commands } = createTerminal();
  terminal.inputState.insertText('paste("ab")');
  terminal.inputState.cursorPosition = 8;
  await terminal.handleEnterKey();
  assert.deepEqual(commands.map(c => c.code), ['paste("ab")']);
  assert.equal(terminal.inputState.text, "");
});

test("typing during a check is restored at the saved cursor, before the suffix", async () => {
  const { terminal } = createTerminal();
  const gate = deferred();
  terminal.inputState.isExpressionCompleteAsync = () => gate.promise;
  terminal.inputState.insertText("c(1,2");
  terminal.inputState.cursorPosition = 4;
  const first = terminal.handleEnterKey();
  terminal.inputState.insertText("3,");
  gate.resolve(false);
  await first;
  assert.equal(terminal.inputState.text, "c(1,\n3,2");
  assert.equal(terminal.inputState.cursorPosition, 7);
});

for (const overlap of [false, true]) {
  test(`successive Enter edits preserve the original suffix (overlap=${overlap})`, async () => {
    const { terminal, commands } = createTerminal();
    terminal.inputState.insertText("c(1,2");
    terminal.inputState.cursorPosition = 4;
    const first = terminal.handleEnterKey();
    if (!overlap) await first;
    terminal.inputState.insertText("3,");
    await Promise.all([first, terminal.handleEnterKey()]);
    assert.equal(terminal.inputState.text, "c(1,\n3,\n2");
    assert.equal(terminal.inputState.cursorPosition, 8);
    terminal.inputState.cursorToEnd();
    terminal.inputState.insertText(")");
    await terminal.handleEnterKey();
    assert.deepEqual(commands.map(c => c.code), ["c(1,\n3,\n2)"]);
  });
}

test("an editor send extends a queued cursor edit behind execution", async () => {
  const { terminal, commands } = createTerminal();
  terminal.inputState.insertText("1\nc(1,2");
  terminal.inputState.cursorPosition = 6;
  await terminal.handleEnterKey();
  assert.deepEqual(commands.map(c => c.code), ["1"]);
  terminal.handleInput("3,\n");
  await terminal.programmaticSubmissionQueue;
  nextPrompt(terminal);
  assert.equal(terminal.inputState.text, "c(1,\n3,\n2");
  assert.equal(terminal.inputState.cursorPosition, 8);
});

test("interruption retains earlier history while later parsing is pending", async () => {
  const { terminal, commands, history } = createTerminal();
  const gate = deferred();
  const check = terminal.inputState.isExpressionCompleteAsync.bind(terminal.inputState);
  terminal.inputState.isExpressionCompleteAsync = code => code === "42" ? gate.promise : check(code);
  terminal.handleInput('cat("ran\\n")\nSys.sleep(30)\n42\n');
  const batch = terminal.programmaticSubmissionQueue;
  await settle();
  nextPrompt(terminal);
  assert.deepEqual(history, ['cat("ran\\n")', "Sys.sleep(30)"]);
  terminal.interruptR();
  gate.resolve(true);
  await batch;
  assert.deepEqual(commands.map(c => c.type), ["submit", "submit", "interrupt"]);
  assert.deepEqual(history, ['cat("ran\\n")', "Sys.sleep(30)"]);
});

test("a later delivery failure keeps earlier history without duplicating a retry", async () => {
  const { terminal, commands, history } = createTerminal();
  const gate = deferred();
  const check = terminal.inputState.isExpressionCompleteAsync.bind(terminal.inputState);
  terminal.inputState.isExpressionCompleteAsync = code => code === "2" ? gate.promise : check(code);
  terminal.handleInput("1\n2\n");
  const batch = terminal.programmaticSubmissionQueue;
  await settle();
  nextPrompt(terminal);
  const send = terminal.runtimeBackend.sendSessionCommand;
  terminal.runtimeBackend.sendSessionCommand = () => false;
  gate.resolve(true);
  await batch;
  assert.deepEqual(history, ["1"]);
  assert.equal(terminal.inputState.text, "2");
  terminal.runtimeBackend.sendSessionCommand = send;
  await terminal.handleEnterKey();
  assert.deepEqual(commands.map(c => c.code), ["1", "2"]);
  assert.deepEqual(history, ["1", "2"]);
});

for (const timing of ["during parsing", "after parsing", "after restoration"]) {
  test(`editor continuation is consumed once ${timing}`, async () => {
    const { terminal, commands, history } = createTerminal();
    terminal.handleInput("Sys.sleep(1)\nx <- (\n");
    if (timing !== "during parsing") await terminal.programmaticSubmissionQueue;
    if (timing === "after restoration") {
      nextPrompt(terminal);
      assert.equal(terminal.inputState.text, "x <- (\n");
    }
    terminal.handleInput("2)\n");
    await terminal.programmaticSubmissionQueue;
    await settle();
    if (timing !== "after restoration") nextPrompt(terminal);
    assert.deepEqual(commands.map(c => c.code), ["Sys.sleep(1)", "x <- (\n2)"]);
    assert.deepEqual(history, ["Sys.sleep(1)", "x <- (\n2)"]);
    assert.equal(terminal.inputState.text, "");
    assert.deepEqual(terminal.submissionQueue, []);
  });
}

test("Enter waits for the previous native check and checks only the combined continuation", async (t) => {
  const { terminal, commands } = createTerminal();
  const first = deferred();
  const checked = [];
  parser.setNativeParseCallback(code => {
    checked.push(code);
    return code === "if" ? first.promise : Promise.resolve(1);
  });
  t.after(() => parser.setNativeParseCallback(null));
  terminal.inputState.insertText("if");
  const a = terminal.handleEnterKey();
  terminal.inputState.insertText("(TRUE) 1");
  const b = terminal.handleEnterKey();
  await settle();
  assert.deepEqual(checked, ["if"], "no speculative check of the second input");
  assert.deepEqual(commands, []);
  first.resolve(2);
  await Promise.all([a, b]);
  assert.equal(checked.filter(code => code === "if\n(TRUE) 1").length, 1);
  assert.ok(checked.every(code => code.startsWith("if")));
  assert.deepEqual(commands.map(c => c.code), ["if\n(TRUE) 1"]);
  assert.equal(terminal.inputState.text, "");
});

for (const source of ["Enter", "paste", "editor"]) {
  test(`${source} extends a pending editor expression without consuming newer typing`, async () => {
    const { terminal, commands } = createTerminal();
    const gate = deferred();
    const check = terminal.inputState.isExpressionCompleteAsync.bind(terminal.inputState);
    let first = true;
    terminal.inputState.isExpressionCompleteAsync = async code => {
      if (first) { first = false; await gate.promise; }
      return check(code);
    };
    terminal.handleInput("x <- (\n");
    let accepted;
    if (source === "Enter") {
      terminal.inputState.insertText("2)");
      accepted = terminal.handleEnterKey();
    } else if (source === "paste") {
      terminal.pasteBuffer = "2)\n";
      accepted = terminal.handlePasteEnd();
    } else {
      terminal.handleInput("2)\n");
      accepted = terminal.programmaticSubmissionQueue;
    }
    terminal.handleInput("z");
    gate.resolve();
    await accepted;
    assert.deepEqual(commands.map(c => c.code), ["x <- (\n2)"]);
    assert.equal(terminal.inputState.text, "z");
  });
}

test("several editor batches complete nested expressions and leave a new tail", async () => {
  const { terminal, commands, history } = createTerminal();
  for (const code of [
    'cat("Starting\\n")\nSys.sleep(1)\nscore <- function(x) {\n  if (x > 0) {\n',
    '    x * 2\n  } else {\n',
    '    -x\n  }\n}\nscore(3)\nanswer <- (\n',
    '  score(-4) +\n  1\n)\nanswer\n',
  ]) terminal.handleInput(code);
  await terminal.programmaticSubmissionQueue;
  const expected = [
    'cat("Starting\\n")', 'Sys.sleep(1)',
    'score <- function(x) {\n  if (x > 0) {\n    x * 2\n  } else {\n    -x\n  }\n}',
    'score(3)', 'answer <- (\n  score(-4) +\n  1\n)', 'answer',
  ];
  for (let i = 1; i < expected.length; i++) nextPrompt(terminal);
  assert.deepEqual(commands.map(c => c.code), expected);
  assert.deepEqual(history, expected);
  assert.equal(terminal.inputState.text, "");
});

test("overlapping and settled Enter preserve the same indented multiline string", async () => {
  for (const overlap of [false, true]) {
    const { terminal, commands } = createTerminal();
    terminal.inputState.insertText('  x <- paste("a');
    const first = terminal.handleEnterKey();
    if (!overlap) await first;
    terminal.inputState.insertText('b")');
    await Promise.all([first, terminal.handleEnterKey()]);
    assert.deepEqual(commands.map(c => c.code), ['  x <- paste("a\n  b")']);
    assert.equal(terminal.inputState.text, "");
  }
});

test("cancellation releases new submissions without waiting for a stale parser", async () => {
  const { terminal, commands } = createTerminal();
  const stale = deferred();
  const check = terminal.inputState.isExpressionCompleteAsync.bind(terminal.inputState);
  terminal.inputState.isExpressionCompleteAsync = code => code === "if" ? stale.promise : check(code);
  terminal.inputState.insertText("if");
  const first = terminal.handleEnterKey();
  terminal.inputState.insertText("(TRUE) 1");
  const second = terminal.handleEnterKey();
  terminal.applyKeyAction({ type: "ctrl_c" });
  terminal.inputState.insertText("42");
  await terminal.handleEnterKey();
  assert.deepEqual(commands.map(c => c.code), ["42"]);
  stale.resolve(false);
  await Promise.all([first, second]);
  assert.deepEqual(commands.map(c => c.code), ["42"]);
  assert.deepEqual(terminal.submissionQueue, []);
  assert.equal(terminal.inputState.text, "");
});

test("delivery failure restores combined continuation and later reservations once", async () => {
  const { terminal, commands } = createTerminal();
  terminal.runtimeBackend.sendSessionCommand = () => false;
  terminal.handleInput("x <- (\n");
  terminal.handleInput("2)\n");
  terminal.handleInput("3\n");
  await terminal.programmaticSubmissionQueue;
  assert.deepEqual(commands, []);
  assert.equal(terminal.inputState.text, "x <- (\n2)\n3");
  assert.deepEqual(terminal.submissionQueue, []);
  assert.equal(terminal.mode, "ready");
});

test("an empty reservation does not block the next parser", async () => {
  const { terminal, commands } = createTerminal();
  terminal.queueProgrammaticSubmission("\n");
  terminal.handleInput("42\n");
  await terminal.programmaticSubmissionQueue;
  assert.deepEqual(commands.map(c => c.code), ["42"]);
});

test("bracketed paste while R is executing remains discarded", async () => {
  const { terminal, commands } = createTerminal();
  await terminal.handleProgrammaticSubmission("Sys.sleep(1)\n");
  terminal.handleInput("\x1b[200~ignored <- 1\nignored <- 2\x1b[201~");
  nextPrompt(terminal);
  assert.deepEqual(commands.map(c => c.code), ["Sys.sleep(1)"]);
  assert.equal(terminal.inputState.text, "");
  assert.deepEqual(terminal.submissionQueue, []);
});

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
