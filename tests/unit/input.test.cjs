const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { KeyProcessor } = loadSource("src/Terminal/keyProcessor.ts");
const { InputState } = loadSource("src/Terminal/inputState.ts");
const { HistoryManager, getHistoryPickerTogglePresentation, historyPickerText } =
  loadSource("src/Terminal/history.ts");

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
  assert.deepEqual(getHistoryPickerEntries(["x", "y", "x"], true), [
    { code: "x", historyIndex: 2 }, { code: "y", historyIndex: 1 },
  ]);
  assert.deepEqual(getHistoryPickerEntries(["x", "y", "x"], false), [
    { code: "x", historyIndex: 2 }, { code: "y", historyIndex: 1 },
    { code: "x", historyIndex: 0 },
  ]);
});


test("F8 selection of an older repeated command keeps its original navigation position", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-picker-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const history = new HistoryManager(path.join(root, "history"));
  const { getHistoryPickerEntries } = loadSource("src/Terminal/history.ts");
  history.load();
  history.setSearchNoDuplicates(true);
  for (const code of ["a()", "repeat()", "b()", "repeat()", "c()"]) history.push(code);

  const picker = getHistoryPickerEntries(history.getEntries(), false);
  const duplicates = picker.filter((item) => item.code === "repeat()");
  assert.deepEqual(duplicates.map((item) => item.historyIndex), [3, 1]);

  history.selectEntryAt(duplicates[1].historyIndex);
  assert.equal(history.navigate(-1), "a()");
  assert.equal(history.navigate(1), "repeat()");
  assert.equal(history.navigate(1), "b()");

  history.selectEntryAt(duplicates[0].historyIndex);
  assert.equal(history.navigate(-1), "b()");
  assert.equal(history.navigate(1), "repeat()");
  assert.equal(history.navigate(1), "c()");

  const collapsed = getHistoryPickerEntries(history.getEntries(), true);
  assert.deepEqual(collapsed.filter((item) => item.code === "repeat()"), [
    { code: "repeat()", historyIndex: 3 },
  ]);
  assert.equal(history.getEntries().length, 5);
});

test("F8 selection keeps an older duplicate through another console's compaction", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-picker-compact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "history");
  fs.writeFileSync(file, Array.from({ length: 20000 }, (_, i) =>
    "\n# time: 2026-10-14 00:00 UTC\n+" +
    (i === 5001 || i === 15001 ? "repeat()" : "command-" + i) + "\n"
  ).join(""));
  const browsing = new HistoryManager(file);
  const writer = new HistoryManager(file);
  const { getHistoryPickerEntries } = loadSource("src/Terminal/history.ts");
  browsing.load();
  writer.load();

  const picker = getHistoryPickerEntries(browsing.getEntries(), false);
  const duplicateIndices = picker.filter((item) => item.code === "repeat()")
    .map((item) => item.historyIndex);
  assert.deepEqual(duplicateIndices, [15001, 5001]);

  // The picker stays open in console A while console B compacts the shared file.
  writer.push("latest()");
  browsing.selectEntryAt(duplicateIndices[1]);
  assert.equal(browsing.navigate(-1), "command-5000");
  assert.equal(browsing.navigate(1), "repeat()");
  assert.equal(browsing.navigate(1), "command-5002");
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

test("separate node processes append to the same history without lost commands", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-processes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "history");
  const loader = path.resolve(__dirname, "../helpers/load-source.cjs");
  const source = path.resolve(__dirname, "../../src/Terminal/history.ts");
  const code = `
    const HistoryManager = require(process.argv[1])(process.argv[2]).HistoryManager;
    const history = new HistoryManager(process.argv[3]);
    history.load();
    for (let i = 0; i < 30; i++) history.push(process.argv[4] + "-" + i);
  `;
  await Promise.all(["A", "B", "C"].map((prefix) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", code, loader, source, file, prefix], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (data) => { errors += data; });
    child.on("error", reject);
    child.on("exit", (status) => status === 0 ? resolve() :
      reject(new Error("Writer exited " + status + ": " + errors)));
  })));
  const restored = new HistoryManager(file);
  restored.load();
  assert.equal(restored.getEntries().length, 90);
  for (const prefix of ["A", "B", "C"]) {
    for (let i = 0; i < 30; i++) {
      assert.ok(restored.getEntries().includes(prefix + "-" + i));
    }
  }
});

test("reads use the shared write lock rather than consuming partially written commands", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-locked-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "history");
  const writer = new HistoryManager(file);
  const reader = new HistoryManager(file);
  writer.load();
  reader.load();
  writer.push("complete()");
  assert.deepEqual(reader.getEntries(), ["complete()"]);
  const lock = file + ".lock";
  fs.writeFileSync(lock, String(process.pid));
  try {
    fs.appendFileSync(file, "\n# time: 2026-10-14 00:00 UTC\n+under-construction()\n");
    assert.deepEqual(reader.getEntries(), ["complete()"]);
  } finally {
    fs.unlinkSync(lock);
  }
  assert.deepEqual(reader.getEntries(), ["complete()", "under-construction()"]);
});

test("contended history submissions are retried when the lock is released", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "history");
  const writer = new HistoryManager(file);
  writer.load();
  const lock = file + ".lock";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  try {
    writer.push("eventual()");
    assert.ok(writer.getEntries().includes("eventual()"));
  } finally {
    fs.unlinkSync(lock);
  }
  const deadline = Date.now() + 2000;
  let persisted = false;
  while (Date.now() < deadline && !persisted) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const reader = new HistoryManager(file);
    reader.load();
    persisted = reader.getEntries().includes("eventual()");
  }
  assert.ok(persisted, "queued history submission should eventually persist");
});

test("failed history appends keep queued commands visible until retry", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-append-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "history");
  const seeded = new HistoryManager(file);
  seeded.load();
  seeded.push("persisted()");

  let rejectAppend = true;
  const failingFs = {
    ...fs,
    appendFileSync(...args) {
      if (rejectAppend && args[0] === file) {
        const error = new Error("simulated append failure");
        error.code = "EACCES";
        throw error;
      }
      return fs.appendFileSync(...args);
    },
  };
  const { HistoryManager: FailingHistory, getHistoryPickerEntries } = loadSource(
    "src/Terminal/history.ts", { fs: failingFs }
  );
  const history = new FailingHistory(file);
  history.load();
  history.setSearchNoDuplicates(true);
  try {
    history.push("queued-one()");
    assert.deepEqual(history.getEntries(), ["persisted()", "queued-one()"]);
    assert.equal(history.navigate(-1), "queued-one()");

    history.push("queued-two()");
    assert.deepEqual(history.getEntries(), [
      "persisted()", "queued-one()", "queued-two()",
    ]);
    assert.deepEqual(getHistoryPickerEntries(history.getEntries(), false)
      .map((entry) => entry.code), ["queued-two()", "queued-one()", "persisted()"]);
    history.resetIndex();
    assert.equal(history.navigate(-1), "queued-two()");
    assert.equal(history.navigate(-1), "queued-one()");
    history.resetIndex();
    assert.equal(history.searchBackward("queued"), "queued-two()");
    assert.equal(history.searchBackward("queued"), "queued-one()");
    assert.deepEqual(history.getRecentSessionEntries(), ["queued-one()", "queued-two()"]);

    const diskOnly = new HistoryManager(file);
    diskOnly.load();
    assert.deepEqual(diskOnly.getEntries(), ["persisted()"]);

    rejectAppend = false;
    assert.deepEqual(history.getEntries(), [
      "persisted()", "queued-one()", "queued-two()",
    ]);
    const restored = new HistoryManager(file);
    restored.load();
    assert.deepEqual(restored.getEntries(), [
      "persisted()", "queued-one()", "queued-two()",
    ]);
  } finally {
    rejectAppend = false;
    history.getEntries();
  }
});

test("new history directories and files are owner-only on Unix", (t) => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-permissions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const historyDir = path.join(root, "history");
  const file = path.join(historyDir, "workspace.history");
  const history = new HistoryManager(file);
  history.load();
  history.push("first <- 1");

  assert.equal(fs.statSync(historyDir).mode & 0o077, 0,
    "new history directory must exclude group and other users");
  assert.equal(fs.statSync(file).mode & 0o177, 0,
    "new history file must exclude group, other, and execute permissions");

  // Appending to a pre-existing file should not silently chmod it.
  fs.chmodSync(historyDir, 0o755);
  fs.chmodSync(file, 0o644);
  history.push("second <- 2");
  assert.equal(fs.statSync(historyDir).mode & 0o777, 0o755);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.deepEqual(history.getEntries(), ["first <- 1", "second <- 2"]);
});

test("F8 history picker wording, icons, and command label remain consistent", () => {
  assert.equal(historyPickerText.title, "R Console: Command History");
  assert.equal(historyPickerText.placeholder, "Type to filter command history");
  assert.equal(historyPickerText.emptyMessage, "R Console command history is empty.");
  assert.deepEqual(getHistoryPickerTogglePresentation(false), {
    icon: "collapse-all", tooltip: "Collapse duplicate commands",
  });
  assert.deepEqual(getHistoryPickerTogglePresentation(true), {
    icon: "expand-all", tooltip: "Expand duplicate commands",
  });
  const manifest = require("../../package.json");
  assert.equal(manifest.contributes.commands.find(
    (command) => command.command === "r-console.searchHistory"
  ).title, "Show Command History");
  assert.ok(manifest.contributes.keybindings.some(
    (binding) => binding.key === "f8" && binding.command === "r-console.searchHistory"
  ));
});
