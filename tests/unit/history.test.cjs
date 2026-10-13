const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const loadSource = require("../helpers/load-source.cjs");

const { EncryptedStorage, StorageEncryptionError, encryptSessionUi, decryptSessionUi, loadEncryptedStorage } =
  loadSource("src/Runtime/encryptedStorage.ts");
const { HistoryManager, getHistoryFile, getHistoryPickerEntries } = loadSource("src/Terminal/history.ts");

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

test("unusable keys and envelopes do not overwrite encrypted history", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-key-"));
  try {
    const values = new Map();
    const secrets = {
      get: async (key) => values.get(key),
      store: async (key, value) => { values.set(key, value); },
      delete: async (key) => { values.delete(key); },
    };
    const persisted = path.join(root, "persistent-sessions.json");
    const key = await loadEncryptedStorage(secrets, root, persisted);
    const file = getHistoryFile(root, "global");
    const history = new HistoryManager(file, key);
    history.load();
    history.push("sensitive");
    const saved = fs.readFileSync(file, "utf8");
    const envelopeFile = path.join(root, "encrypted-storage-keys.json");
    const envelope = fs.readFileSync(envelopeFile, "utf8");
    for (const name of values.keys()) values.set(name, "invalid key");
    await assert.rejects(loadEncryptedStorage(secrets, root, persisted), StorageEncryptionError);
    values.clear();
    let now = Date.now();
    t.mock.method(Date, "now", () => { now += 60000; return now; });
    await assert.rejects(loadEncryptedStorage(secrets, root, persisted), StorageEncryptionError);
    assert.equal(fs.readFileSync(file, "utf8"), saved);
    assert.equal(fs.readFileSync(envelopeFile, "utf8"), envelope);
    fs.writeFileSync(envelopeFile, "{damaged");
    await assert.rejects(loadEncryptedStorage(secrets, root, persisted), /Invalid stored R Console data-key envelope/);
    assert.equal(fs.readFileSync(file, "utf8"), saved);
    assert.equal(fs.readFileSync(envelopeFile, "utf8"), "{damaged");
    assert.equal(values.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("simultaneous initialization retains one envelope for history and persisted UI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-key-race-"));
  try {
    const values = new Map();
    const secrets = {
      get: async (key) => values.get(key),
      store: async (key, value) => { values.set(key, value); },
      delete: async (key) => { values.delete(key); },
    };
    const keys = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      loadEncryptedStorage(secrets, root, path.join(root, "session-" + i + ".json"))
    ));
    assert.equal(values.size, 5);
    assert.deepEqual(fs.readdirSync(root), ["encrypted-storage-keys.json"]);
    const history = new HistoryManager(getHistoryFile(root, "global"), keys[0]);
    history.load();
    history.push("sensitive command");
    const terminal = {
      runtime: { sessionId: "session-a" },
      ui: { replay: { lines: ["sensitive output"] }, inputText: "unfinished <-" },
    };
    const saved = encryptSessionUi(terminal, keys[0]);
    for (const key of keys) {
      const restored = new HistoryManager(getHistoryFile(root, "global"), key);
      restored.load();
      assert.deepEqual(restored.getEntries(), ["sensitive command"]);
      assert.deepEqual(decryptSessionUi(saved, key), terminal);
    }
    const reopened = await loadEncryptedStorage(secrets, root, path.join(root, "reopened.json"));
    assert.deepEqual(decryptSessionUi(saved, reopened), terminal);
    const envelope = fs.readFileSync(path.join(root, "encrypted-storage-keys.json"), "utf8");
    for (const slot of JSON.parse(envelope).keys) {
      assert.ok(values.has(slot.name));
      assert.ok(!envelope.includes(values.get(slot.name)));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("published key waits for another window's SecretStorage update", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-key-update-"));
  try {
    const values = new Map();
    const secrets = {
      get: async (key) => values.get(key),
      store: async (key, value) => { values.set(key, value); },
      delete: async (key) => { values.delete(key); },
    };
    const persisted = path.join(root, "persistent-sessions.json");
    const first = await loadEncryptedStorage(secrets, root, persisted);
    let reads = 0;
    const delayedSecrets = {
      ...secrets,
      get: async (key) => ++reads <= 5 ? undefined : values.get(key),
      store: async () => { assert.fail("Must not replace the published key"); },
    };
    const second = await loadEncryptedStorage(delayedSecrets, root, persisted);
    assert.equal(second.decrypt(first.encrypt("sensitive", "history:a"), "history:a"), "sensitive");
    assert.equal(values.size, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const namedKey of [false, true]) test(`an existing ${namedKey ? "named" : "fixed"} key is wrapped without replacing saved data`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-existing-key-"));
  try {
    const bytes = randomBytes(32);
    const crypto = new EncryptedStorage(bytes);
    const history = new HistoryManager(getHistoryFile(root, "global"), crypto);
    history.load();
    history.push("previously saved command");
    const file = getHistoryFile(root, "global");
    const saved = fs.readFileSync(file, "utf8");
    const name = "r-console.encrypted-storage-key.v1" + (namedKey ? "." + "a".repeat(32) : "");
    const values = new Map([[name, bytes.toString("base64")]]);
    if (namedKey) fs.writeFileSync(path.join(root, "encrypted-storage-key-id"), name);
    const secrets = {
      get: async (key) => values.get(key),
      store: async (key, value) => { values.set(key, value); },
      delete: async (key) => { values.delete(key); },
    };
    const restoredKey = await loadEncryptedStorage(secrets, root, path.join(root, "persistent-sessions.json"));
    const restored = new HistoryManager(getHistoryFile(root, "global"), restoredKey);
    restored.load();
    assert.deepEqual(restored.getEntries(), ["previously saved command"]);
    assert.equal(fs.readFileSync(file, "utf8"), saved);
    assert.equal(values.size, namedKey ? 5 : 6);
    assert.equal(values.has(name), !namedKey);
    assert.ok(!fs.existsSync(path.join(root, "encrypted-storage-key-id")));
    if (!namedKey) {
      const otherRoot = path.join(root, "other-storage");
      const other = new HistoryManager(getHistoryFile(otherRoot, "global"), crypto);
      other.load();
      other.push("other existing history");
      const recovered = await loadEncryptedStorage(secrets, otherRoot, path.join(otherRoot, "sessions.json"));
      const reopened = new HistoryManager(getHistoryFile(otherRoot, "global"), recovered);
      reopened.load();
      assert.deepEqual(reopened.getEntries(), ["other existing history"]);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("any one of five keys recovers the same history and persisted UI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-recovery-"));
  try {
    const values = new Map();
    const secrets = {
      get: async (key) => values.get(key),
      store: async (key, value) => { values.set(key, value); },
      delete: async (key) => { values.delete(key); },
    };
    const persisted = path.join(root, "persistent-sessions.json");
    const first = await loadEncryptedStorage(secrets, root, persisted);
    const historyFiles = [getHistoryFile(root, "global"), getHistoryFile(root, "workspace", root)];
    for (const file of historyFiles) {
      const history = new HistoryManager(file, first);
      history.load();
      history.push("sensitive command");
    }
    const terminal = {
      runtime: { sessionId: "session-a" },
      ui: { replay: { lines: ["sensitive output"] }, inputText: "unfinished <-" },
    };
    const saved = encryptSessionUi(terminal, first);
    for (const [name, value] of values) {
      const recovered = await loadEncryptedStorage({
        ...secrets,
        get: async (key) => key === name ? value : undefined,
        store: async () => { assert.fail("Must not replace surviving recovery keys"); },
      }, root, persisted);
      for (const file of historyFiles) {
        const history = new HistoryManager(file, recovered);
        history.load();
        assert.deepEqual(history.getEntries(), ["sensitive command"]);
      }
      assert.deepEqual(decryptSessionUi(saved, recovered), terminal);
    }
    assert.equal(fs.readdirSync(path.join(root, "history")).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("each console load randomly selects its first recovery key with fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-random-key-"));
  try {
    let choice = 0;
    const crypto = require("node:crypto");
    const loader = loadSource("src/Runtime/encryptedStorage.ts", {
      crypto: { ...crypto, randomInt: (count) => choice++ % count },
    }).loadEncryptedStorage;
    const values = new Map();
    const reads = [];
    const secrets = {
      get: async (key) => { reads.push(key); return values.get(key); },
      store: async (key, value) => { values.set(key, value); },
      delete: async (key) => { values.delete(key); },
    };
    const persisted = path.join(root, "persistent-sessions.json");
    const first = await loader(secrets, root, persisted);
    const envelopeFile = path.join(root, "encrypted-storage-keys.json");
    const envelope = JSON.parse(fs.readFileSync(envelopeFile, "utf8"));
    for (let i = 0; i < 5; i++) {
      reads.length = 0;
      const recovered = await loader(secrets, root, persisted);
      assert.deepEqual(reads, [envelope.keys[i].name]);
      assert.equal(recovered.decrypt(first.encrypt("secret", "history:a"), "history:a"), "secret");
    }
    values.delete(envelope.keys[0].name);
    values.set(envelope.keys[1].name, "invalid key");
    envelope.keys[2].encryptedKey = "damaged envelope";
    fs.writeFileSync(envelopeFile, JSON.stringify(envelope));
    reads.length = 0;
    const recovered = await loader({
      ...secrets,
      get: async (name) => {
        if (name === envelope.keys[3].name) { reads.push(name); throw new Error("Unreadable secret"); }
        return secrets.get(name);
      },
    }, root, persisted);
    assert.deepEqual(reads, envelope.keys.map((slot) => slot.name));
    assert.equal(recovered.decrypt(first.encrypt("secret", "history:a"), "history:a"), "secret");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed recovery-key creation removes only its unpublished candidates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-key-failure-"));
  try {
    const values = new Map();
    let writes = 0;
    const secrets = {
      get: async (key) => values.get(key),
      store: async (key, value) => {
        values.set(key, value);
        if (++writes === 3) throw new Error("Storage failed");
      },
      delete: async (key) => { values.delete(key); },
    };
    await assert.rejects(loadEncryptedStorage(secrets, root, path.join(root, "sessions.json")), /Storage failed/);
    assert.equal(values.size, 0);
    assert.deepEqual(fs.readdirSync(root), []);
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

test("picker collapses exact repeats only in its displayed list, newest first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-picker-"));
  try {
    const file = getHistoryFile(root, "global");
    const history = new HistoryManager(file, new EncryptedStorage(randomBytes(32)));
    history.load();
    const indented = "result <- x |>" + "\n  head(1)";
    const unindented = "result <- x |> head(1)";
    const stored = ["a <- 1", "a <- 1", "b <- 2", indented, unindented, "a <- 1"];
    stored.forEach((entry) => history.push(entry));

    assert.deepEqual(getHistoryPickerEntries(history.getEntries(), false), [...stored].reverse());
    assert.deepEqual(getHistoryPickerEntries(history.getEntries(), true), [
      "a <- 1", unindented, indented, "b <- 2",
    ]);
    // No truncation or rewriting of the encrypted history journal.
    assert.equal(history.getEntries().length, stored.length);
    assert.equal(fs.readFileSync(file, "utf8").trimEnd().split("\n").length, stored.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Up and Down skip consecutive identical commands in both directions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-navigation-"));
  try {
    const history = new HistoryManager(getHistoryFile(root, "global"), new EncryptedStorage(randomBytes(32)));
    history.load();
    ["a", "a", "b", "a", "a", "c"].forEach((entry) => history.push(entry));
    history.setSearchNoDuplicates(true);

    assert.equal(history.navigate(-1), "c");
    assert.equal(history.navigate(-1), "a");
    assert.equal(history.navigate(-1), "b");
    assert.equal(history.navigate(-1), "a");
    assert.equal(history.navigate(-1), undefined);
    assert.equal(history.navigate(1), "b");
    assert.equal(history.navigate(1), "a");
    assert.equal(history.navigate(1), "c");
    assert.equal(history.navigate(1), null);
    assert.equal(history.navigate(1), undefined);
    history.resetIndex();
    assert.equal(history.searchBackward("a"), "a");
    assert.equal(history.searchBackward("a"), "a");
    assert.deepEqual(history.getEntries(), ["a", "a", "b", "a", "a", "c"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
