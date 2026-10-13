const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { KeyProcessor } = loadSource("src/Terminal/keyProcessor.ts");
const { InputState } = loadSource("src/Terminal/inputState.ts");
const { HistoryManager } = loadSource("src/Terminal/history.ts");

test("keyboard decoding buffers partial CSI sequences and preserves pasted newlines", () => {
  const keys = new KeyProcessor();
  assert.deepEqual(keys.parseInputChunk("\x1b["), []);
  assert.deepEqual(keys.parseInputChunk("A\x1b[18~\r\n\x03"), [
    { type: "arrow", dir: "up" }, { type: "completion" }, { type: "enter" }, { type: "ctrl_c" },
  ]);
  const actions = keys.parseInputChunk("\x1b[200~x\ny\x1b[201~");
  assert.equal(actions[0].type, "paste-start");
  assert.equal(actions.at(-1).type, "paste-end");
  assert.equal(actions.filter((action) => action.type === "text").map((action) => action.text).join(""), "x\ny");
});

test("editing and wrapped cursor movement preserve input", () => {
  const input = new InputState();
  input.insertText("abcdefghij\nsecond");
  input.cursorPosition = 7;
  const metrics = { columns: 8, promptLen: 3, continuationPromptLen: 3 };
  assert.equal(input.autoUp(metrics), "moved");
  assert.equal(input.autoDown(metrics), "moved");
  assert.equal(input.cursorPosition, 7);
  input.insertText("X");
  assert.equal(input.deleteBeforeCursor(), "X");
  assert.equal(input.text, "abcdefghij\nsecond");
});

test("history persists multiline entries and searches without losing their contents", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "history");
  const history = new HistoryManager(file);
  history.load();
  history.push("x <- 1");
  history.push("{\n  y <- 2\n}");
  const restored = new HistoryManager(file);
  restored.load();
  assert.equal(restored.navigate(-1), "{\n  y <- 2\n}");
  assert.equal(restored.searchBackward("x"), "x <- 1");
  assert.deepEqual(restored.getRecentSessionEntries(), []);
});

test("workspace scope shares within a folder and isolates different folders", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-scopes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { getHistoryFile, getHistoryPickerEntries } = loadSource("src/Terminal/history.ts");
  const a = getHistoryFile(root, "workspace", path.join(root, "a"));
  const b = getHistoryFile(root, "workspace", path.join(root, "b"));
  assert.notEqual(a, b);
  assert.equal(getHistoryFile(root, "global"), getHistoryFile(root, "workspace"));
  const first = new HistoryManager(a);
  const second = new HistoryManager(a);
  const other = new HistoryManager(b);
  first.load();
  second.load();
  other.load();
  first.push("a <- 1");
  second.push("b <- 2");
  assert.deepEqual(first.getEntries(), ["a <- 1", "b <- 2"]);
  assert.deepEqual(other.getEntries(), []);
  assert.deepEqual(getHistoryPickerEntries(["x", "y", "x"], true), ["x", "y"]);
  assert.deepEqual(getHistoryPickerEntries(["x", "y", "x"], false), ["x", "y", "x"]);
});

test("history navigation skips consecutive duplicates in both directions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-nav-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const history = new HistoryManager(path.join(root, "history"));
  history.load();
  history.setSearchNoDuplicates(true);
  for (const item of ["first", "first", "second", "first", "first"]) history.push(item);
  assert.equal(history.navigate(-1), "first");
  assert.equal(history.navigate(-1), "second");
  assert.equal(history.navigate(-1), "first");
  assert.equal(history.navigate(1), "second");
  assert.equal(history.navigate(1), "first");
  assert.equal(history.navigate(1), null);
});

test("Ctrl+R substring search and clearing the navigation position", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const history = new HistoryManager(path.join(root, "history"));
  history.load();
  history.push("one <- 1");
  history.push("someone <- 2");
  history.push("one <- 3");
  assert.equal(history.searchBackward("one"), "one <- 3");
  assert.equal(history.searchBackward("one"), "someone <- 2");
  assert.equal(history.searchBackward("one"), "one <- 1");
  history.resetIndex();
  assert.equal(history.searchBackward("one"), "one <- 3");
});

test("plaintext history with an incomplete tail preserves completed entries", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-tail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "history");
  const history = new HistoryManager(file);
  history.load();
  history.push("finished <- 1");
  fs.appendFileSync(file, "+unfinished");
  const restored = new HistoryManager(file);
  restored.load();
  assert.deepEqual(restored.getEntries(), ["finished <- 1"]);
});
