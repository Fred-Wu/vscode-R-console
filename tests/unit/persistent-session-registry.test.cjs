const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { session } = require("../helpers/persistent-session.cjs");
const { PersistentSessionRegistry } = loadSource("src/Runtime/persistentSessionRegistry.ts");

function fixture(t, content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-upgrade-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "persistent-sessions.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return { file, registry: new PersistentSessionRegistry(file), read: () => JSON.parse(fs.readFileSync(file, "utf8")) };
}

test("an upgrade retains old records while authenticated sessions remain reconnectable", async (t) => {
  const old = session({ legacy: true });
  const current = session();
  const { registry, read, file } = fixture(t, { sessions: [old, current], futureMetadata: "retain" });
  const loaded = await registry.load();
  assert.deepEqual(loaded, [current]);
  assert.deepEqual(registry.legacySessions, [old]);
  assert.equal(registry.save(loaded), true);
  const reloaded = new PersistentSessionRegistry(file);
  assert.deepEqual(await reloaded.load(), [current]);
  assert.deepEqual(reloaded.legacySessions, [old]);
  assert.equal(read().futureMetadata, "retain");
  assert.equal(read().sessions.length, 2);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("legacy-only records survive startup, heartbeat, and deactivation saves", async (t) => {
  const old = session({ legacy: true });
  const { registry, read } = fixture(t, { sessions: [old] });
  assert.deepEqual(await registry.load(), []);
  for (let i = 0; i < 3; i++) assert.equal(registry.save([]), true);
  assert.deepEqual(read().sessions, [old]);
});

test("only protocol 2 reconnects; old records are distinguished from unsupported or damaged records", async (t) => {
  const old = session({ legacy: true, protocolVersion: 1 });
  const historical = session({ legacy: true });
  const current = session();
  const incompatible = [
    session({ protocolVersion: 1 }),
    session({ protocolVersion: 3 }),
    session({ protocolVersion: undefined }),
    session({ legacy: true, protocolVersion: 2 }),
    session({ legacy: true, protocolVersion: 3 }),
  ];
  const { registry, read } = fixture(t, { sessions: [current, old, historical, ...incompatible] });
  assert.deepEqual(await registry.load(), [current]);
  assert.deepEqual(registry.legacySessions, [old, historical]);
  assert.equal(registry.save([current]), true);
  assert.deepEqual(read().sessions, JSON.parse(JSON.stringify([current, old, historical, ...incompatible])));
});

test("malformed credentials are preserved but never treated as a legacy authentication fallback", async (t) => {
  const malformed = session({ authToken: "invalid" });
  const current = session();
  const { registry, read } = fixture(t, { sessions: [malformed, null, current] });
  assert.deepEqual(await registry.load(), [current]);
  assert.deepEqual(registry.legacySessions, []);
  registry.save([current]);
  assert.deepEqual(read().sessions, [current, malformed, null]);
});

for (const content of ['{"sessions":', '{"futureSchema":true}']) {
  test(`unreadable registry schema is not overwritten: ${content}`, async (t) => {
    const { registry, file } = fixture(t, content);
    assert.deepEqual(await registry.load(), []);
    assert.equal(registry.save([session()]), false);
    assert.equal(fs.readFileSync(file, "utf8"), content);
  });
}

test("closing one old session removes only its record, including across a refresh", async (t) => {
  const first = session({ legacy: true, cwd: "/first" });
  const second = session({ legacy: true, cwd: "/second" });
  const current = session();
  const { registry, read } = fixture(t, { sessions: [first, second, current] });
  await registry.load();
  const selected = registry.legacySessions[0];
  await registry.load();
  assert.equal(registry.forgetLegacySession(selected), true);
  assert.deepEqual(read().sessions, [current, second]);
});
