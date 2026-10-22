const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { InlineCompletion } = loadSource("src/Terminal/inlineCompletion.ts");

const item = label => ({ label, insertText: label, replaceStart: 0, snapshotInput: "", snapshotCursor: 0, source: "session" });

test("inline completion navigates, clamps and accepts selected item", () => {
  const state = new InlineCompletion();
  assert.ok(state.set(["apple", "apricot", "avocado"].map(item), state.token));
  state.move(10);
  assert.equal(state.current().label, "avocado");
  state.move(-20);
  assert.equal(state.current().label, "apple");
  assert.equal(state.visible, true);
});

test("old asynchronous completion results cannot reopen a dismissed list", () => {
  const state = new InlineCompletion();
  const token = state.token;
  state.clear();
  assert.equal(state.set([item("stale")], token), false);
  assert.equal(state.visible, false);
});

test("inline completion draws a border, shows picker metadata, and hides codicon markup", () => {
  const state = new InlineCompletion();
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
  assert.doesNotMatch(lines.join(""), /\x1b\[7m/);
  assert.match(plain, /◉ mtcars/);
  state.move(1);
  assert.equal(state.current().insertText, "$(symbol-function) mean");
});

test("inline scrolling follows selected completion and removes unsafe escapes", () => {
  const state = new InlineCompletion();
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
  const state = new InlineCompletion();
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
  const state = new InlineCompletion();
  state.set([{ ...item("$(symbol-module) stats"), description: "module" }], state.token);
  const rendered = state.lines(40, 7).join("");
  assert.ok(rendered.includes("\x1b[38;5;75m{}"));
  assert.doesNotMatch(rendered, /\$\(symbol-module\)/);
});

test("empty completion lists do not reserve terminal rows", () => {
  const state = new InlineCompletion();
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
    inlineCompletion: new InlineCompletion(),
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
    inlineCompletion: new InlineCompletion(),
    lang: { cancelCompletion() {} },
    renderInput() {},
  });
  terminal.inputState.insertText("   ");
  terminal.inlineCompletion.set([item("library")], terminal.inlineCompletion.token);
  terminal.requestInlineCompletion(true);
  assert.equal(terminal.inlineCompletion.visible, false);
});

test("mouse hit testing maps displayed rows, including scrolled entries and details", () => {
  const state = new InlineCompletion();
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
