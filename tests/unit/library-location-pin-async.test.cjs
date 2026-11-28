const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-async-pin-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const library = path.join(base, "parent", "library");
  fs.mkdirSync(library, { recursive: true });
  const { captureLibraryPin } = loadSource("src/Language/libraryLocationPin.ts");
  const calls = [];
  let before = async () => {};
  const { checkLibraryPinAsync } = loadSource("src/Language/libraryLocationPin.ts", { fs: {
    ...fs, lstatSync: () => assert.fail("asynchronous validation must not use synchronous I/O"),
    promises: { ...fs.promises, lstat: async (...args) => {
      calls.push(args[0]); await before(args[0]); return fs.promises.lstat(...args);
    } },
  } });
  return { base, library, captureLibraryPin, checkLibraryPinAsync, calls, before: fn => { before = fn; } };
}

test("async pin validation checks ordinary and configured alias chains without following links", async t => {
  const f = fixture(t), alias = path.join(f.base, "alias");
  fs.symlinkSync(f.library, alias, process.platform === "win32" ? "junction" : "dir");
  const pin = f.captureLibraryPin(alias);
  assert.equal(await f.checkLibraryPinAsync(pin, () => true), undefined);
  assert.ok(f.calls.includes(alias));
  const other = path.join(f.base, "other"); fs.mkdirSync(other);
  fs.unlinkSync(alias); fs.symlinkSync(other, alias, process.platform === "win32" ? "junction" : "dir");
  f.calls.length = 0;
  const changed = await f.checkLibraryPinAsync(pin, () => true);
  assert.equal(changed.entry, alias);
  assert.equal(changed.kind, "configured");
  assert.ok(!f.calls.includes(other));
});

test("async validation stops at a replaced physical ancestor before touching descendants", async t => {
  const f = fixture(t), pin = f.captureLibraryPin(f.library);
  const parent = path.dirname(f.library), other = path.join(f.base, "other");
  fs.renameSync(parent, other);
  fs.symlinkSync(other, parent, process.platform === "win32" ? "junction" : "dir");
  const changed = await f.checkLibraryPinAsync(pin, () => true);
  assert.equal(changed.entry, parent);
  assert.equal(changed.state, "link");
  assert.equal(f.calls.at(-1), parent);
  assert.ok(!f.calls.includes(f.library));
});

test("cancelling a pending ancestor check stops before another filesystem operation", async t => {
  const f = fixture(t), pin = f.captureLibraryPin(f.library);
  let entered, release, current = true;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.before(async () => { entered(); await gate; });
  const checking = f.checkLibraryPinAsync(pin, () => current);
  await started;
  current = false; release();
  assert.equal(await checking, undefined);
  assert.equal(f.calls.length, 1);
});

test("async validation propagates temporary I/O failures without declaring a replacement", async t => {
  const f = fixture(t), pin = f.captureLibraryPin(f.library);
  const error = Object.assign(new Error("offline"), { code: "EIO" });
  f.before(async () => { throw error; });
  await assert.rejects(f.checkLibraryPinAsync(pin, () => true), value => value === error);
  assert.equal(f.calls.length, 1);
});
