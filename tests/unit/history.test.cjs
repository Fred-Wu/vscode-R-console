const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const loadSource = require("../helpers/load-source.cjs");

const { EncryptedStorage, StorageEncryptionError, encryptSessionUi, decryptSessionUi, loadEncryptedStorage } =
  loadSource("src/Runtime/encryptedStorage.ts");
const { HistoryManager, getHistoryFile } = loadSource("src/Terminal/history.ts");

test("encrypted history isolates workspaces and shares global fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-"));
  try {
    const a = getHistoryFile(root, "workspace", path.join(root, "project-a"));
    const a2 = getHistoryFile(root, "workspace", path.join(root, "project-a"));
    const b = getHistoryFile(root, "workspace", path.join(root, "project-b"));
    const global = getHistoryFile(root, "global", path.join(root, "project-a"));
    assert.equal(a, a2);
    assert.notEqual(a, b);
    assert.equal(global, getHistoryFile(root, "workspace"));
    const crypto = new EncryptedStorage(randomBytes(32));
    const first = new HistoryManager(a, crypto);
    const second = new HistoryManager(a, crypto);
    const other = new HistoryManager(b, crypto);
    first.load();
    second.load();
    other.load();
    first.push('message("SECRET value")');
    second.push("2 + 2");
    assert.equal(first.navigate(-1), "2 + 2");
    assert.equal(first.navigate(-1), 'message("SECRET value")');
    assert.equal(other.navigate(-1), undefined);
    assert.ok(!fs.readFileSync(a, "utf8").includes("SECRET"));
    assert.deepEqual(second.getRecentSessionEntries(), ["2 + 2"]);
    assert.deepEqual(first.getEntries(), [
      'message("SECRET value")', "2 + 2",
    ]);
    first.selectEntry("2 + 2");
    assert.equal(first.navigate(-1), 'message("SECRET value")');
    first.save();
    const reopened = new HistoryManager(a, crypto);
    reopened.load();
    assert.equal(reopened.navigate(-1), "2 + 2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ciphertext is authenticated and context separated", () => {
  const crypto = new EncryptedStorage(randomBytes(32));
  const token = crypto.encrypt("secret", "history:a");
  assert.equal(crypto.decrypt(token, "history:a"), "secret");
  assert.throws(() => crypto.decrypt(token, "history:b"), StorageEncryptionError);
  const corrupted = token.slice(0, -2) + "zz";
  assert.throws(() => crypto.decrypt(corrupted, "history:a"), StorageEncryptionError);
});

test("persisted UI encrypts replay and preserves reconnect metadata", () => {
  const crypto = new EncryptedStorage(randomBytes(32));
  const terminal = {
    runtime: { sessionId: "session-a", port: 42 },
    options: { cwd: "/project" },
    ui: { replay: { lines: ["secret command"] }, inputText: "token <- 1" },
  };
  const stored = encryptSessionUi(terminal, crypto);
  assert.ok(!JSON.stringify(stored).includes("secret command"));
  assert.ok(!JSON.stringify(stored).includes("token <- 1"));
  assert.deepEqual(decryptSessionUi(stored, crypto), terminal);
  assert.deepEqual(decryptSessionUi(terminal, crypto), terminal);
  assert.throws(() => decryptSessionUi({
    ...stored, runtime: { sessionId: "other" },
  }, crypto), StorageEncryptionError);
});

test("missing SecretStorage key does not overwrite encrypted history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-key-"));
  try {
    const values = new Map();
    const secrets = {
      get: async (key) => values.get(key),
      store: async (key, value) => { values.set(key, value); },
    };
    const persisted = path.join(root, "persistent-sessions.json");
    const key = await loadEncryptedStorage(secrets, root, persisted);
    const file = getHistoryFile(root, "global");
    const history = new HistoryManager(file, key);
    history.load();
    history.push("sensitive");
    values.clear();
    await assert.rejects(loadEncryptedStorage(secrets, root, persisted), StorageEncryptionError);
    assert.ok(fs.readFileSync(file, "utf8").length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("history refuses an incomplete encrypted record without overwriting it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-partial-"));
  try {
    const crypto = new EncryptedStorage(randomBytes(32));
    const file = getHistoryFile(root, "global");
    const history = new HistoryManager(file, crypto);
    history.load();
    history.push("valid");
    fs.appendFileSync(file, "v1.partial");
    const current = fs.readFileSync(file, "utf8");
    const reopened = new HistoryManager(file, crypto);
    assert.throws(() => reopened.load(), /incomplete final record/);
    assert.equal(fs.readFileSync(file, "utf8"), current);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resetting history navigation after clear restores Up and prefix Ctrl+R", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-history-reset-"));
  try {
    const file = getHistoryFile(root, "global");
    const history = new HistoryManager(file, new EncryptedStorage(randomBytes(32)));
    history.load();
    history.push("alpha <- 1");
    history.push("beta <- 2");
    history.push("alpha <- 3");

    // Repeated reverse searches reach the oldest match and exhaust the cursor.
    assert.equal(history.searchBackward("alpha"), "alpha <- 3");
    assert.equal(history.searchBackward("alpha"), "alpha <- 1");
    assert.equal(history.searchBackward("alpha"), null);
    assert.equal(history.navigate(-1), undefined);

    // Ctrl+L / a new search sequence restores access without R executing.
    history.resetIndex();
    assert.equal(history.navigate(-1), "alpha <- 3");
    history.resetIndex();
    assert.equal(history.searchBackward("alpha"), "alpha <- 3");
    assert.equal(history.searchBackward("alpha"), "alpha <- 1");

    // A new typed prefix is a new search sequence, not an old exhausted cursor.
    history.resetIndex();
    assert.equal(history.searchBackward("beta"), "beta <- 2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
