const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { session } = require("../helpers/persistent-session.cjs");

function fixture({ answer, selection, failClose = false } = {}) {
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
      showQuickPick: async (items, options) => {
        calls.push(["pick", items, options]);
        if (selection === -1) return undefined;
        if (selection === undefined) return items.filter(item => item.picked);
        return (Array.isArray(selection) ? selection : [selection]).map(index => items[index]);
      },
      showErrorMessage: (message) => { calls.push(["error", message]); },
      createTerminal: () => { throw new Error("must not create a replacement console"); },
    },
  };
  const api = loadSource("src/Terminal/legacySessionNotice.ts", {
    vscode,
    "../Runtime/legacySession": {
      closeLegacySession: async (entry) => {
        calls.push(["close", entry]);
        if (typeof failClose === "function" ? failClose(entry, old) : failClose) throw new Error("not stopped");
      },
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

test("multiple old sessions are all preselected and confirmation closes them all", async () => {
  const f = fixture({ answer: () => "Close Old Session" });
  await f.showLegacySessionNotice(f.state, f.registry);
  const [, items, options] = f.calls.find(([kind]) => kind === "pick");
  assert.equal(options.canPickMany, true);
  assert.equal(items.length, 2);
  assert.ok(items.every(item => item.picked === true));
  assert.deepEqual(f.calls.filter(([kind]) => kind === "close" || kind === "forget"),
    f.old.flatMap(entry => [["close", entry], ["forget", entry]]));
});

test("unchecking every session closes nothing", async () => {
  const f = fixture({ selection: [], answer: () => "Close Old Session" });
  await f.manageLegacySessions(f.registry);
  assert.equal(f.calls.some(([kind]) => kind === "close" || kind === "forget"), false);
});

test("one failed shutdown retains that record and does not prevent closing the other selections", async () => {
  const f = fixture({ answer: () => "Close Old Session", failClose: (entry, old) => entry === old[0] });
  await f.manageLegacySessions(f.registry);
  assert.deepEqual(f.calls.filter(([kind]) => kind === "close" || kind === "forget"),
    [["close", f.old[0]], ["close", f.old[1]], ["forget", f.old[1]]]);
  assert.equal(f.calls.filter(([kind]) => kind === "error").length, 1);
});

test("a newly detected session opens a picker including previously dismissed old sessions", async () => {
  let close = false;
  const f = fixture({ answer: () => close ? "Close Old Session" : "Cancel" });
  await f.showLegacySessionNotice(f.state, f.registry);
  f.old.push(session({ legacy: true }));
  close = true;
  await f.showLegacySessionNotice(f.state, f.registry);
  assert.equal(f.calls.find(([kind]) => kind === "pick")[1].length, 3);
  assert.equal(f.calls.filter(([kind]) => kind === "close").length, 3);
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

test("an authenticated older session gets the same one-time popup and close action", async () => {
  const f = fixture({ answer: () => "Close Old Session" });
  const old = session({ protocolVersion: 2 });
  f.registry.legacySessions = [old];
  await f.showLegacySessionNotice(f.state, f.registry);
  await f.showLegacySessionNotice(f.state, f.registry);
  assert.equal(f.calls.filter(([kind]) => kind === "warning").length, 1);
  assert.deepEqual(f.calls.find(([kind]) => kind === "warning").slice(2), ["Close Old Session", "Cancel"]);
  assert.deepEqual(f.calls.filter(([kind]) => kind === "close" || kind === "forget"), [["close", old], ["forget", old]]);
});
