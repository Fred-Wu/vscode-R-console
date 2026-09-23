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
