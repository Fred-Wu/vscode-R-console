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

test("inline suggestions paginate and never emit candidate ANSI escapes", () => {
  const state = new InlineCompletion();
  state.set(Array.from({ length: 20 }, (_, i) => item("item" + i)), state.token);
  state.move(14);
  const lines = state.lines(28, 5);
  assert.equal(lines.length, 5);
  assert.match(lines[4], /\x1b\[2m\d+-\d+\/20/);
  assert.ok(lines.some(line => line.includes("item14")));
  assert.ok(lines.every(line => !line.includes("item0\x1b[7m")));
  state.clear();
  state.set([item("bad\x1b[31m red")], state.token);
  assert.equal(state.lines(30, 5)[0].includes("bad\x1b[31m"), false);
  assert.deepEqual(state.lines(10, 5), []);
});

test("empty completion lists do not reserve terminal rows", () => {
  const state = new InlineCompletion();
  assert.deepEqual(state.lines(80, 20), []);
  assert.equal(state.current(), undefined);
});
