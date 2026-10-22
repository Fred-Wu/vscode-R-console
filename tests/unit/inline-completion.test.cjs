const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { Terminal } = require("@xterm/headless");
const loadSource = require("../helpers/load-source.cjs");
const { InlineCompletion } = loadSource("src/Terminal/inlineCompletion.ts");
const widthTerminal = new Terminal({ cols: 20, rows: 2 });
const unicode = widthTerminal._core.unicodeService;
after(() => widthTerminal.dispose());

const item = label => ({ label, insertText: label, replaceStart: 0, snapshotInput: "", snapshotCursor: 0, source: "session" });

function createTerminal(t, columns = 80, rows = 24, trigger = "typing") {
  const { InputState } = loadSource("src/Terminal/inputState.ts");
  const { Renderer } = loadSource("src/Terminal/renderer.ts");
  const { KeyProcessor } = loadSource("src/Terminal/keyProcessor.ts");
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    "./rTerminal/lang": {},
    vscode: {
      EventEmitter: class {}, window: {},
      workspace: { getConfiguration: () => ({ get: (key, fallback) =>
        key === "completionUI" ? "inline" : key === "inlineCompletion.trigger" ? trigger : fallback }) },
    },
  });
  const screen = new Terminal({ cols: columns, rows, allowProposedApi: true });
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    inputState: new InputState(), inlineCompletion: new InlineCompletion(unicode),
    mode: "ready", promptReady: true, dimensions: { columns, rows },
    inlineSuggestionRowCount: 0,
    lang: { cancelCompletion() {}, updateInput() {} },
    syntax: { setSource() {} },
    writeEmitter: { fire(text) { screen._core._writeBuffer.writeSync(text); } },
    ensureReadyPromptVisibleForInput() {},
    withTerminalStateCaptureSuppressed(callback) { callback(); },
    applyCompletion(selection) { this.accepted = selection; },
    handleEnterKey() { this.submitted = this.inputState.text; },
  });
  terminal.renderer = new Renderer(text => terminal.writeEmitter.fire(text));
  terminal.renderer.setContinuationPrompt("   ");
  const keys = new KeyProcessor();
  screen.onData(data => {
    for (const action of keys.parseInputChunk(data)) terminal.applyKeyAction(action);
  });
  t.after(() => {
    terminal.dismissInlineCompletion(false);
    screen.dispose();
  });
  return { terminal, screen };
}

test("multiline input and suggestions share the viewport across redraw and dismissal", t => {
  const { terminal, screen } = createTerminal(t, 80, 12);
  const input = Array.from({ length: 10 }, (_, i) => i === 9 ? "mea" : "x <- " + i).join("\n");
  terminal.inputState.insertText(input);
  terminal.inlineCompletion.set(Array.from({ length: 20 }, (_, i) => item("mean" + i)), terminal.inlineCompletion.token);
  terminal.renderInput();
  const buffer = screen.buffer.active;
  const before = Array.from({ length: 12 }, (_, i) => buffer.getLine(buffer.baseY + i).translateToString(true));
  assert.ok(before.some(line => line.includes("╭")));
  assert.ok(before.some(line => line.includes("╰")));
  assert.match(buffer.getLine(buffer.baseY + buffer.cursorY).translateToString(true), /mea$/);
  assert.ok(terminal.renderer.renderedLineCount <= 12);
  const baseY = buffer.baseY;
  terminal.renderInput();
  assert.equal(buffer.baseY, baseY, "redrawing must not push the panel into scrollback");
  assert.deepEqual(Array.from({ length: 12 }, (_, i) => buffer.getLine(buffer.baseY + i).translateToString(true)), before);
  terminal.applyKeyAction({ type: "escape" });
  assert.equal(terminal.inputState.text, input);
  assert.ok(!Array.from({ length: 12 }, (_, i) => buffer.getLine(buffer.baseY + i).translateToString(true)).join("\n").includes("│"));
});

test("clicking the visible suggestion still works after the panel shrinks", t => {
  const { terminal, screen } = createTerminal(t);
  terminal.inputState.insertText("a");
  const choices = Array.from({ length: 20 }, (_, i) => ({ ...item("alpha" + i), snapshotInput: "a", snapshotCursor: 1 }));
  terminal.inlineCompletion.set(choices, terminal.inlineCompletion.token);
  terminal.renderInput();
  terminal.inlineCompletion.set([choices[0]], terminal.inlineCompletion.token);
  terminal.renderInput();
  const buffer = screen.buffer.active;
  const row = Array.from({ length: 24 }, (_, i) => buffer.getLine(buffer.baseY + i).translateToString(true)).findIndex(line => line.includes("alpha0")) + 1;
  assert.ok(row > 0);
  terminal.applyKeyAction({ type: "mouse", pressed: true, row, col: 8 });
  terminal.applyKeyAction({ type: "mouse", pressed: false, row, col: 8 });
  assert.equal(terminal.accepted, choices[0]);
});

test("a panel that cannot fit releases Enter and mouse reporting", t => {
  for (const [columns, rows] of [[19, 24], [80, 5]]) {
    const { terminal } = createTerminal(t, columns, rows);
    terminal.inputState.insertText("mea");
    terminal.inlineCompletion.set([{ ...item("mean"), snapshotInput: "mea", snapshotCursor: 3 }], terminal.inlineCompletion.token);
    terminal.renderInput();
    assert.equal(terminal.inlineCompletion.visible, false);
    assert.equal(Boolean(terminal.inlineMouseReporting), false);
    terminal.applyKeyAction({ type: "enter" });
    assert.equal(terminal.accepted, undefined);
    assert.equal(terminal.submitted, "mea");
  }
});

test("wide and combining characters fit the panel without moving the input cursor or mouse targets", t => {
  for (const label of ["字段名称", "姓名".repeat(30), "𠀀".repeat(30), "e\u0301".repeat(40), "a".repeat(31) + "姓名"]) {
    const { terminal, screen } = createTerminal(t, 40, 24);
    terminal.inputState.insertText("df$");
    const choice = {
      ...item(label), snapshotInput: "df$", snapshotCursor: 3,
      description: "变量", detail: "详细信息".repeat(20),
    };
    terminal.inlineCompletion.set([{ label: "列名称".repeat(20) }, choice], terminal.inlineCompletion.token);
    terminal.renderInput();
    const buffer = screen.buffer.active;
    assert.equal(buffer.cursorY, 0, label);
    assert.equal(buffer.cursorX, 6, label);
    assert.equal(buffer.getLine(buffer.baseY).translateToString(true), "R> df$");
    assert.equal(terminal.renderer.renderedLineCount, 7);
    const labelRow = buffer.getLine(buffer.baseY + 3).translateToString(true);
    assert.ok(labelRow.includes(label === "字段名称" ? label : "…"), "preserve short labels and mark truncation");
    for (let row = 1; row < 7; row++) {
      const line = buffer.getLine(buffer.baseY + row);
      assert.equal(line.isWrapped, false, label);
      assert.equal(line.getCell(0).getChars(), row === 1 ? "╭" : row === 6 ? "╰" : "│");
      assert.equal(line.getCell(38).getChars(), row === 1 ? "╮" : row === 6 ? "╯" : "│");
      assert.equal(line.getCell(39).getChars(), "");
    }
    terminal.renderInput();
    assert.equal(buffer.cursorY, 0, "stable redraw keeps the caret beside the input");
    terminal.applyKeyAction({ type: "mouse", pressed: true, row: 4, col: 8 });
    terminal.applyKeyAction({ type: "mouse", pressed: false, row: 4, col: 8 });
    assert.equal(terminal.accepted, choice);
  }
});

test("Escape cancels both delayed results and the typing debounce before a panel appears", async t => {
  const { terminal } = createTerminal(t);
  terminal.inputState.insertText("mea");
  let publish;
  let requests = 0;
  terminal.lang.handleAutocomplete = async ({ onInlineEntries }) => {
    requests++;
    publish = onInlineEntries;
  };
  terminal.requestInlineCompletion(true);
  terminal.applyKeyAction({ type: "escape" });
  publish([{ ...item("mean"), snapshotInput: "mea", snapshotCursor: 3 }]);
  assert.equal(terminal.inlineCompletion.visible, false);
  terminal.escPendingClear = false;
  terminal.scheduleInlineCompletion();
  terminal.applyKeyAction({ type: "escape" });
  assert.equal(terminal.inlineCompletionTimer, undefined);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(requests, 1);
  assert.equal(terminal.inputState.text, "mea");
});

test("Tab mode refreshes an open list on edits without opening one for ordinary typing", async t => {
  const { terminal } = createTerminal(t, 80, 24, "tab");
  let publish;
  let requestedInput;
  terminal.lang.handleAutocomplete = async ({ input, onInlineEntries }) => {
    requestedInput = input.currentLine;
    publish = onInlineEntries;
  };
  terminal.applyKeyAction({ type: "text", text: "df$a" });
  assert.equal(terminal.inlineCompletionTimer, undefined);
  terminal.inlineCompletion.set([{ ...item("alpha"), snapshotInput: "df$a", snapshotCursor: 4 }], terminal.inlineCompletion.token);
  terminal.renderInput();
  terminal.applyKeyAction({ type: "text", text: "z" });
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(requestedInput, "df$az");
  publish([]);
  assert.equal(terminal.inlineCompletion.visible, false);
  assert.equal(terminal.inlineMouseReporting, false);
  terminal.applyKeyAction({ type: "tab" });
  const choices = ["aztec", "azimuth"].map(label => ({
    ...item(label), snapshotInput: "df$az", snapshotCursor: 5,
  }));
  publish(choices);
  terminal.applyKeyAction({ type: "arrow", dir: "down" });
  terminal.applyKeyAction({ type: "tab" });
  assert.equal(terminal.accepted, choices[1], "Tab accepts the selected entry when the list is open");
});

test("Backspace resets selection and scrolling through staged and full results", async t => {
  for (const trigger of ["typing", "tab"]) {
    const { terminal, screen } = createTerminal(t, 80, 24, trigger);
    terminal.inputState.insertText("librar");
    const choices = Array.from({ length: 20 }, (_, i) => ({
      ...item("library" + i), snapshotInput: "librar", snapshotCursor: 6,
    }));
    terminal.inlineCompletion.set([{ label: "Functions" }, ...choices], terminal.inlineCompletion.token);
    terminal.inlineCompletion.move(15);
    terminal.renderInput();
    let publish;
    terminal.lang.handleAutocomplete = async ({ onInlineEntries }) => { publish = onInlineEntries; };
    terminal.applyKeyAction({ type: "backspace" });
    assert.equal(terminal.inputState.text, "libra");
    assert.equal(terminal.inlineCompletion.selected, 0, "reset before results arrive");
    const buffer = screen.buffer.active;
    assert.ok(Array.from({ length: 24 }, (_, i) => buffer.getLine(buffer.baseY + i).translateToString(true)).some(line => line.includes("Functions")));
    terminal.applyKeyAction({ type: "backspace" });
    assert.equal(terminal.inputState.text, "libr");
    await new Promise(resolve => setTimeout(resolve, 180));
    const updated = choices.map(choice => ({ ...choice, snapshotInput: "libr", snapshotCursor: 4 }));
    publish([{ label: "Functions" }, ...updated]);
    assert.equal(terminal.inlineCompletion.selected, 0);
    const full = [{ ...updated[0], label: "libr_new", insertText: "libr_new" }, ...updated];
    publish([{ label: "Functions" }, ...full]);
    assert.equal(terminal.inlineCompletion.selected, 0, "full results must not restore an old selection");
    terminal.applyKeyAction({ type: "arrow", dir: "down" });
    publish([{ label: "Functions" }, ...full]);
    assert.equal(terminal.inlineCompletion.selected, 1, "respect navigation after the reset");
  }
});

test("dismissal erases the panel even when the following key does not edit input", t => {
  for (const type of ["backtab", "ctrl_d", "completion"]) {
    const { terminal, screen } = createTerminal(t);
    terminal.inputState.insertText("mea");
    terminal.inlineCompletion.set([{ ...item("mean"), snapshotInput: "mea", snapshotCursor: 3 }], terminal.inlineCompletion.token);
    terminal.renderInput();
    terminal.applyKeyAction({ type });
    assert.equal(terminal.inputState.text, "mea");
    assert.equal(terminal.inlineCompletion.visible, false);
    assert.equal(terminal.inlineMouseReporting, false);
    const buffer = screen.buffer.active;
    assert.ok(!Array.from({ length: 24 }, (_, i) => buffer.getLine(buffer.baseY + i).translateToString(true)).join("\n").includes("╭"), type);
  }
});

test("typing publishes an empty list when matches or the completion context disappear", async () => {
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {
      Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      CompletionItemKind: { Field: 4, Variable: 5, Function: 2 },
      QuickPickItemKind: { Separator: -1 }, SnippetString: class {},
    },
    "../../Language/consoleLspClient": { ConsoleLspClient: class {} },
    "../../Language/virtualRDocument": { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({ extensionPath: "", rPath: "", env: {}, requestMemberCompletions: async () => [] });
  lang.ensureConsoleLspStarted = async () => undefined;
  lang.getOrOpenCompletionDocument = async () => undefined;
  const panel = new InlineCompletion(unicode);
  for (const text of ["df$a", "df$az", "df$a", "# comment"]) {
    const input = { text, currentLine: text, cursorCol: text.length, cursorRow: 0, lines: [text], textBeforeCursor: text };
    const token = panel.invalidate();
    await lang.handleAutocomplete({
      input, getCurrentInput: () => input,
      getWorkspaceData: () => ({ globalenv: { df: { names: ["alpha"] } } }),
      applyCompletion() {},
      onInlineEntries(items) { panel.set(items, token); },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(panel.visible, text === "df$a", text);
  }
});

test("inline completion navigates, clamps and accepts selected item", () => {
  const state = new InlineCompletion(unicode);
  assert.ok(state.set(["apple", "apricot", "avocado"].map(item), state.token));
  state.move(10);
  assert.equal(state.current().label, "avocado");
  state.move(-20);
  assert.equal(state.current().label, "apple");
  assert.equal(state.visible, true);
});

test("old asynchronous completion results cannot reopen a dismissed list", () => {
  const state = new InlineCompletion(unicode);
  const token = state.token;
  state.clear();
  assert.equal(state.set([item("stale")], token), false);
  assert.equal(state.visible, false);
});

test("inline completion draws a border, shows picker metadata, and hides codicon markup", () => {
  const state = new InlineCompletion(unicode);
  state.set([
    { label: "Runtime Variables" },
    { ...item("$(symbol-variable) mtcars"), description: "variable", detail: "session" },
    { ...item("$(symbol-function) mean"), description: "function", detail: "{base}" },
  ], state.token);
  const lines = state.lines(60, 9);
  const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /╭─/);
  assert.match(plain, /╰─/);
  assert.match(plain, /Runtime Variables/);
  assert.match(plain, /mtcars/);
  assert.match(plain, /variable/);
  assert.match(plain, /session/);
  assert.match(plain, /{base}/);
  assert.doesNotMatch(plain, /\$\(symbol-|> mtcars/);
  assert.match(lines.join(""), /\x1b\[38;5;75m/);
  assert.match(lines.join(""), /\x1b\[48;2;/);
  assert.match(plain, /● mtcars/);
  state.move(1);
  assert.equal(state.current().insertText, "$(symbol-function) mean");
});

test("inline scrolling follows selected completion and removes unsafe escapes", () => {
  const state = new InlineCompletion(unicode);
  state.set(Array.from({ length: 20 }, (_, i) => item("item" + i)), state.token);
  state.move(14);
  const lines = state.lines(40, 8);
  assert.equal(lines.length, 8);
  assert.ok(lines.some(line => line.includes("item14")));
  assert.ok(lines.some(line => line.includes("of 20")));
  state.clear();
  state.set([item("bad\x1b[31m red")], state.token);
  const plain = state.lines(40, 7).join("");
  assert.equal(plain.includes("bad\x1b[31m"), false);
  assert.deepEqual(state.lines(10, 5), []);
});

test("invalidation retains panel and preserves selection on updated entries", () => {
  const state = new InlineCompletion(unicode);
  state.set([item("one"), item("two")], state.token);
  state.move(1);
  const old = state.token;
  const next = state.invalidate();
  assert.equal(state.visible, true);
  assert.ok(state.lines(40, 8).some(line => line.includes("two")));
  assert.equal(state.set([item("stale")], old), false);
  assert.equal(state.set([item("zero"), item("two")], next), true);
  assert.equal(state.current().label, "two");
});

test("module icons use blue braces rather than a yellow dot", () => {
  const state = new InlineCompletion(unicode);
  state.set([{ ...item("$(symbol-module) stats"), description: "module" }], state.token);
  const rendered = state.lines(40, 7).join("");
  assert.ok(rendered.includes("\x1b[38;5;75m{}"));
  assert.doesNotMatch(rendered, /\$\(symbol-module\)/);
});

test("empty completion lists do not reserve terminal rows", () => {
  const state = new InlineCompletion(unicode);
  assert.deepEqual(state.lines(80, 20), []);
  assert.equal(state.current(), undefined);
});

test("unchanged inline suggestions are not repainted for a same-row input edit", () => {
  const { Renderer } = loadSource("src/Terminal/renderer.ts");
  let writes = [];
  const renderer = new Renderer(text => writes.push(text));
  renderer.renderWithCursor(["a"], 0, 1, 80, [0], ["main"], ["╭───╮", "│ ● │", "╰───╯"]);
  writes = [];
  renderer.renderWithCursor(["ab"], 0, 2, 80, [0], ["main"], ["╭───╮", "│ ● │", "╰───╯"]);
  const output = writes.join("");
  assert.ok(output.includes("ab"));
  assert.ok(!output.includes("╭───╮"), "stable suggestions must not be repainted");
  assert.ok(!output.includes("●"), "stable choice rows must not be repainted");
  writes = [];
  renderer.renderWithCursor(["ab"], 0, 2, 80, [0], ["main"], ["╭───╮", "│ ◉ │", "╰───╯"]);
  assert.ok(writes.join("").includes("◉"), "changed selection must repaint");
});

test("clearing the last typed character dismisses suggestions and blocks stale results", () => {
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    "./rTerminal/lang": {},
    vscode: { EventEmitter: class {}, workspace: { getConfiguration: () => ({ get: (key) =>
      key === "completionUI" ? "inline" : "typing" }) } },
  });
  const { InputState } = loadSource("src/Terminal/inputState.ts");
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    inputState: new InputState(), mode: "ready", promptReady: true,
    inlineCompletion: new InlineCompletion(unicode),
    lang: { cancelCompletion() {} },
    renderInput() {},
  });
  terminal.inputState.insertText("l");
  terminal.inlineCompletion.set([item("library")], terminal.inlineCompletion.token);
  const pending = terminal.inlineCompletion.token;
  terminal.inputState.deleteBeforeCursor();
  terminal.scheduleInlineCompletion();
  assert.equal(terminal.inputState.text, "");
  assert.equal(terminal.inlineCompletion.visible, false);
  assert.equal(terminal.inlineCompletion.set([item("library")], pending), false);
  assert.equal(terminal.inlineCompletionTimer, undefined);
});

test("whitespace-only input also dismisses pending inline suggestions", () => {
  const { RTerminal } = loadSource("src/Terminal/rTerminal.ts", {
    "./rTerminal/lang": {},
    vscode: { EventEmitter: class {}, workspace: { getConfiguration: () => ({ get: () => "inline" }) } },
  });
  const { InputState } = loadSource("src/Terminal/inputState.ts");
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    inputState: new InputState(), mode: "ready", promptReady: true,
    inlineCompletion: new InlineCompletion(unicode),
    lang: { cancelCompletion() {} },
    renderInput() {},
  });
  terminal.inputState.insertText("   ");
  terminal.inlineCompletion.set([item("library")], terminal.inlineCompletion.token);
  terminal.requestInlineCompletion(true);
  assert.equal(terminal.inlineCompletion.visible, false);
});

test("mouse hit testing maps displayed rows, including scrolled entries and details", () => {
  const state = new InlineCompletion(unicode);
  state.set([
    { label: "Functions" },
    { ...item("alpha"), detail: "details" },
    ...Array.from({ length: 15 }, (_, i) => item("item" + i)),
  ], state.token);
  state.move(9);
  const lines = state.lines(40, 9);
  const strip = line => line.replace(/\x1b\[[0-9;]*m/g, "");
  const target = lines.findIndex(line => strip(line).includes("item8"));
  assert.ok(target > 0);
  assert.equal(state.hitTest(target, 8)?.label, "item8");
  assert.equal(state.hitTest(0, 8), undefined);
  assert.equal(state.hitTest(lines.length - 1, 8), undefined);
  assert.equal(state.hitTest(target, 1), undefined);
  assert.equal(state.hitTest(target, 40), undefined);
  state.clear();
  assert.equal(state.hitTest(target, 8), undefined);

  state.set([{ label: "Functions" }, { ...item("alpha"), detail: "help" }], state.token);
  state.lines(40, 8);
  assert.equal(state.hitTest(1, 8), undefined);
  assert.equal(state.hitTest(2, 8)?.label, "alpha");
  assert.equal(state.hitTest(3, 8)?.label, "alpha");
});

test("scrollbar follows viewport and selection scrolls only at visible edges", () => {
  const state = new InlineCompletion(unicode);
  state.set(Array.from({ length: 12 }, (_, i) => item("entry" + i)), state.token);
  const first = state.lines(40, 8).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(first, /█/);
  assert.ok(first.includes("entry0"));
  assert.ok(first.includes("entry4"));
  state.move(2);
  const middle = state.lines(40, 8).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(middle.includes("entry0"), "moving within the viewport must not scroll");
  state.move(3);
  const edge = state.lines(40, 8).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(!edge.includes("entry0"), "leaving the viewport scrolls by a row");
  state.move(-2);
  const back = state.lines(40, 8).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(!back.includes("entry0"), "moving inside current viewport preserves position");
});

test("first and last choices reach scrollbar endpoints including headings and details", () => {
  for (const withDetails of [false, true]) {
    const state = new InlineCompletion(unicode);
    const count = withDetails ? 6 : 10;
    state.set([
      { label: "Functions" },
      ...Array.from({ length: count }, (_, i) => ({
        ...item("entry" + i),
        detail: withDetails ? "detail" + i : undefined,
      })),
    ], state.token);
    state.lines(60, 13);
    state.move(count - 1);
    const bottom = state.lines(60, 13).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.ok(bottom[bottom.length - 3].endsWith("█│"), "thumb reaches the last content row");
    if (withDetails) assert.ok(bottom.some(line => line.includes("detail5")));
    state.move(-(count - 1));
    const top = state.lines(60, 13).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.ok(top[1].includes("Functions"), "returning to the first choice restores its heading");
    assert.ok(top[1].endsWith("█│"), "thumb reaches the first content row");
    assert.ok(top.some(line => line.includes("entry0")));
  }
});

test("hit-test bounds restrict mouse-wheel navigation to box contents", () => {
  const state = new InlineCompletion(unicode);
  state.set([item("one"), item("two")], state.token);
  const lines = state.lines(40, 7);
  assert.equal(state.contains(1, 8), true);
  assert.equal(state.contains(0, 8), false);
  assert.equal(state.contains(lines.length - 1, 8), false);
  assert.equal(state.contains(1, 1), false);
  assert.equal(state.contains(1, 40), false);
  state.clear();
  assert.equal(state.contains(1, 8), false);
});

test("suggestion panel tracks typed column, clamps near right edge and hit-tests the shifted box", () => {
  const state = new InlineCompletion(unicode);
  state.set([item("library")], state.token, "lib");
  const original = state.lines(80, 8, 15);
  assert.ok(original[0].startsWith(" ".repeat(14) + "\x1b[90m╭"));
  assert.equal(state.hitTest(1, 16)?.label, "library");
  assert.equal(state.hitTest(1, 3), undefined);
  const moved = state.lines(80, 8, 17);
  assert.ok(moved[0].startsWith(" ".repeat(16) + "\x1b[90m╭"));
  const clamped = state.lines(80, 8, 79);
  assert.ok(clamped[0].startsWith(" ".repeat(19) + "\x1b[90m╭"));
});

test("typed matches use theme foreground, selected text has a continuous background, and group backgrounds remain plain", () => {
  const { resolveInlineCompletionColors } = loadSource("src/Terminal/inlineCompletion.ts");
  const colors = resolveInlineCompletionColors(true, {
    "editorSuggestWidget.highlightForeground": "#1379bd",
    "editorSuggestWidget.selectedBackground": "#ddeeff",
  });
  assert.equal(colors.matchForeground, "\x1b[38;2;19;121;189m");
  assert.equal(colors.selectedBackground, "\x1b[48;2;221;238;255m");
  const state = new InlineCompletion(unicode);
  state.set([{ label: "Functions" }, { ...item("$(symbol-function) library"), description: "base" }], state.token, "lib");
  const lines = state.lines(80, 8, 4, colors);
  const heading = lines.find(line => line.includes("Functions"));
  const selected = lines.find(line => line.includes("rary"));
  assert.ok(heading && !heading.includes("\x1b[48;2;"), "group headers have no separate background");
  assert.ok(selected);
  assert.ok(selected.includes("\x1b[38;2;19;121;189mlib\x1b[39mrary"));
  assert.ok(selected.indexOf(colors.selectedBackground) < selected.indexOf("●"),
    "selection background must start before icon and text");
  assert.ok(selected.indexOf("\x1b[49m") > selected.indexOf("rary"),
    "selection background must extend behind all text");
  assert.ok(!selected.includes("\x1b[7m"), "do not invert icon or matched foreground");
});

test("function arguments remain selected ahead of an exact runtime variable", () => {
  const panel = new InlineCompletion(unicode);
  const argument = { ...item("data = "), insertText: "data = " };
  const variable = { ...item("data"), source: "session" };
  const choices = [
    { label: "Fields" }, { ...item("dataset") },
    { label: "Arguments" }, argument,
    { label: "Runtime Variables" }, variable,
  ];
  panel.set(choices, panel.token, "data");
  assert.equal(panel.current(), argument, "argument group takes precedence over an exact runtime match");
  panel.move(1);
  assert.equal(panel.current(), variable);
  panel.set(choices, panel.token, "data");
  assert.equal(panel.current(), variable, "retain an explicit user selection during updates");
  panel.invalidate(true);
  panel.set(choices, panel.token, "data");
  assert.equal(panel.current(), argument, "edits reset selection to the function argument");
  const ordinary = new InlineCompletion(unicode);
  ordinary.set([{ label: "Runtime Variables" }, variable], ordinary.token, "data");
  assert.equal(ordinary.current(), variable, "normal completion without arguments is unchanged");
});

test("scrollbar click changes navigation but cannot accept a suggestion", t => {
  const { terminal, screen } = createTerminal(t, 80, 24);
  terminal.inputState.insertText("a");
  const choices = Array.from({ length: 25 }, (_, i) => ({
    ...item("alpha" + i), snapshotInput: "a", snapshotCursor: 1,
  }));
  terminal.inlineCompletion.set(choices, terminal.inlineCompletion.token);
  terminal.renderInput();
  const left = terminal.inlineCompletion.lines(80, 13, 1)[0].indexOf("╭");
  const barCol = terminal.inlineCompletion.renderedLeft + terminal.inlineCompletion.renderedWidth - 1;
  const boxRow = terminal.inlineBoxTop;
  assert.ok(boxRow !== undefined);
  const start = terminal.inlineCompletion.selected;
  const row = boxRow + 8;
  terminal.applyKeyAction({ type: "mouse", pressed: true, row, col: barCol });
  terminal.applyKeyAction({ type: "mouse", pressed: false, row, col: barCol });
  assert.equal(terminal.accepted, undefined, "scrollbar is never an accept target");
  assert.ok(terminal.inlineCompletion.selected > start, "track click scrolls to lower suggestion");
  assert.equal(terminal.inlineCompletion.hitTest(8, barCol), undefined);
});
