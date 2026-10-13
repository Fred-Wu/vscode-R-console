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

test("history caps existing files and appends at 20000 commands", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-bounded-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "history");
  fs.writeFileSync(file, Array.from({ length: 20005 }, (_, i) =>
    "\\n# time: 2026-10-14 00:00 UTC\\n+command-" + i + "\\n"
  ).join("").replaceAll("\\n", "\n"));
  const first = new HistoryManager(file);
  first.load();
  assert.equal(first.getEntries().length, 20000);
  assert.equal(first.getEntries()[0], "command-5");
  assert.equal((fs.readFileSync(file, "utf8").match(/^# time:/gm) || []).length, 20000);
  const second = new HistoryManager(file);
  second.load();
  first.push("new <- 1");
  second.push("second <- 2");
  const restored = new HistoryManager(file);
  restored.load();
  assert.deepEqual(restored.getEntries().slice(-2), ["new <- 1", "second <- 2"]);
  assert.ok(restored.getEntries().length <= 20000);
  assert.ok((fs.readFileSync(file, "utf8").match(/^# time:/gm) || []).length <= 20000);
  assert.equal(restored.getEntries().includes("command-5"), false);
});

test("another console's compaction preserves an older history cursor", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-cursor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "history");
  // A duplicate near the cursor ensures we preserve the entry's position,
  // rather than simply searching for matching command text after compaction.
  fs.writeFileSync(file, Array.from({ length: 20000 }, (_, i) =>
    "\n# time: 2026-10-14 00:00 UTC\n+" +
    (i === 5001 || i === 15001 ? "repeat()" : "command-" + i) + "\n"
  ).join(""));
  const browsing = new HistoryManager(file);
  const trimmed = new HistoryManager(file);
  const writer = new HistoryManager(file);
  browsing.load();
  trimmed.load();
  writer.load();

  browsing.selectEntry("command-5000");
  assert.equal(browsing.navigate(1), "repeat()");
  trimmed.selectEntry("command-100");

  // The writer removes the oldest 1000 entries and appends another.
  writer.push("latest()");
  assert.equal(browsing.navigate(0), "repeat()");
  assert.equal(browsing.navigate(1), "command-5002");
  assert.equal(browsing.navigate(-1), "repeat()");

  // An entry that was actually pruned clamps to the oldest retained entry.
  assert.equal(trimmed.navigate(0), "command-1000");
  assert.equal(trimmed.navigate(-1), undefined);

  // Reopen the history to verify that the compaction marker is persistent.
  const restored = new HistoryManager(file);
  restored.load();
  assert.equal(restored.getEntries().length, 19001);
  assert.equal(restored.getEntries()[0], "command-1000");
  assert.match(fs.readFileSync(file, "utf8"), /^# r-console-history-base: 1000\n/);
});
