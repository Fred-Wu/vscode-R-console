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
  assert.match(rendered, /\\x1b\[38;5;75m\{\}/);
  assert.doesNotMatch(rendered, /\$\(symbol-module\)/);
});

test("empty completion lists do not reserve terminal rows", () => {
  const state = new InlineCompletion();
  assert.deepEqual(state.lines(80, 20), []);
  assert.equal(state.current(), undefined);
});
