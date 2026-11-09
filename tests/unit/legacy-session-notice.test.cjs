const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { session } = require("../helpers/persistent-session.cjs");

function fixture({ answer, selection = 0, failClose = false } = {}) {
  const calls = [];
  const old = [session({ legacy: true, cwd: "/project-a" }), session({ legacy: true, cwd: "/project-b" })];
  const registry = {
    legacySessions: old,
    forgetLegacySession(entry) { calls.push(["forget", entry]); return true; },
  };
  const values = new Map();
  const state = { get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => values.set(key, value) };
  const vscode = {
    window: {
      activeTextEditor: { document: { uri: { fsPath: "/unrelated-project/file.R" } } },
      showWarningMessage: async (...args) => { calls.push(["warning", ...args]); return answer?.(...args); },
      showQuickPick: async (items) => { calls.push(["pick", items]); return items[selection]; },
      showErrorMessage: (message) => { calls.push(["error", message]); },
      createTerminal: () => { throw new Error("must not create a replacement console"); },
    },
  };
  const api = loadSource("src/Terminal/legacySessionNotice.ts", {
    vscode,
    "../Runtime/legacySession": {
      closeLegacySession: async (entry) => { calls.push(["close", entry]); if (failClose) throw new Error("not stopped"); },
    },
  });
  return { ...api, registry, state, calls, old };
}

test("notice is shown once per detected session even when dismissed; new old sessions still notify", async () => {
  const f = fixture();
  await f.showLegacySessionNotice(f.state, f.registry);
  await f.showLegacySessionNotice(f.state, f.registry);
  assert.equal(f.calls.filter(([kind]) => kind === "warning").length, 1);
  assert.equal(f.calls.some(([kind]) => kind === "close" || kind === "forget"), false);
  f.registry.legacySessions.push(session({ legacy: true }));
  await f.showLegacySessionNotice(f.state, f.registry);
  assert.equal(f.calls.filter(([kind]) => kind === "warning").length, 2);
});

test("close selects the saved session regardless of editor focus without a second confirmation", async () => {
  const f = fixture({ selection: 1, answer: () => "Close Old Session" });
  await f.showLegacySessionNotice(f.state, f.registry);
  assert.deepEqual(f.calls.filter(([kind]) => kind === "close" || kind === "forget"), [["close", f.old[1]], ["forget", f.old[1]]]);
  assert.equal(f.calls.filter(([kind]) => kind === "warning").length, 1);
  const items = f.calls.find(([kind]) => kind === "pick")[1];
  assert.match(items[1].detail, /\/project-b/);
  assert.doesNotMatch(items[1].detail, /unrelated-project/);
});

test("Cancel leaves the process and registry alone without opening a picker", async () => {
  const f = fixture({ answer: () => "Cancel" });
  await f.manageLegacySessions(f.registry);
  assert.equal(f.calls.some(([kind]) => ["close", "forget", "pick"].includes(kind)), false);
});

test("cancelling session selection leaves every old session untouched", async () => {
  const f = fixture({ selection: -1, answer: () => "Close Old Session" });
  await f.manageLegacySessions(f.registry);
  assert.equal(f.calls.some(([kind]) => kind === "close" || kind === "forget"), false);
});

test("a failed shutdown retains the record", async () => {
  const f = fixture({ failClose: true, answer: () => "Close Old Session" });
  await f.manageLegacySessions(f.registry);
  assert.equal(f.calls.some(([kind]) => kind === "forget"), false);
  assert.ok(f.calls.some(([kind]) => kind === "error"));
});

test("a single old session needs only the protocol-change popup with Close and Cancel", async () => {
  const f = fixture({ answer: () => "Close Old Session" });
  f.registry.legacySessions = [f.old[0]];
  await f.showLegacySessionNotice(f.state, f.registry);
  const warnings = f.calls.filter(([kind]) => kind === "warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1], "The R Console connection protocol has changed. Sessions started with an older version cannot reconnect. Close the old session and start a new R Console.");
  assert.deepEqual(warnings[0].slice(2), ["Close Old Session", "Cancel"]);
  assert.equal(f.calls.some(([kind]) => kind === "pick"), false);
  assert.deepEqual(f.calls.filter(([kind]) => kind === "close" || kind === "forget"), [["close", f.old[0]], ["forget", f.old[0]]]);
});
