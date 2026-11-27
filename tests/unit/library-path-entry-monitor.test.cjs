const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { captureLibraryPin, checkLibraryPin } = loadSource("src/Language/libraryLocationPin.ts");
const { LibraryPathEntryMonitor } = loadSource("src/Language/libraryPathEntryMonitor.ts");

const linkKind = process.platform === "win32" ? "junction" : "dir";
function fakeClock() {
  let now = 0, sequence = 0;
  const tasks = new Map();
  return {
    now: () => now,
    after(callback, delay) {
      const token = { id: ++sequence, unref() {} };
      tasks.set(token, { due: now + delay, callback });
      return token;
    },
    cancel(token) { tasks.delete(token); },
    pending: () => tasks.size,
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...tasks].sort((a, b) => a[1].due - b[1].due).find(([, task]) => task.due <= target);
        if (!next) break;
        now = next[1].due;
        tasks.delete(next[0]);
        next[1].callback();
      }
      now = target;
    },
  };
}

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-entry-")));
  const clock = fakeClock(), watchers = new Map(), attempts = new Map(), failures = new Map();
  const pins = new Map(), changes = [], checked = [], logs = [];
  const io = {
    lstatSync: fs.lstatSync,
    watch(parent, options, callback) {
      assert.deepEqual(options, { persistent: false, recursive: false, encoding: "utf8" });
      attempts.set(parent, (attempts.get(parent) ?? 0) + 1);
      const remaining = failures.get(parent) ?? 0;
      if (remaining) { failures.set(parent, remaining - 1); throw new Error("notification unavailable"); }
      assert.ok(fs.lstatSync(parent).isDirectory());
      assert.equal(watchers.has(parent), false);
      const watcher = new EventEmitter();
      watcher.close = () => { if (watchers.get(parent) === watcher) watchers.delete(parent); };
      watcher.notify = name => callback("rename", name);
      watchers.set(parent, watcher);
      return watcher;
    },
  };
  const monitor = new LibraryPathEntryMonitor(library => {
    checked.push(library);
    const pin = pins.get(library);
    if (!pin) return false;
    const change = checkLibraryPin(pin);
    if (!change) return true;
    changes.push({ library, ...change });
    pins.delete(library);
    monitor.remove(library);
    return false;
  }, message => logs.push(message), io, clock);
  const add = library => { const pin = captureLibraryPin(library); pins.set(library, pin); monitor.add(library, pin); return pin; };
  const make = name => { const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
  t.after(() => { monitor.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, clock, watchers, attempts, failures, monitor, pins, changes, checked, logs, add, make };
}

test("pins ordinary directory identities without treating package writes as replacements", t => {
  const f = fixture(t), library = f.make("library");
  const pin = f.add(library);
  fs.mkdirSync(path.join(library, "package"));
  fs.writeFileSync(path.join(library, "package", "DESCRIPTION"), "Package: package\n");
  f.watchers.get(f.base).notify("library");
  assert.equal(checkLibraryPin(pin), undefined);
  assert.deepEqual(f.changes, []);
  const count = f.attempts.get(f.base);
  f.monitor.add(library, pin);
  assert.equal(f.attempts.get(f.base), count, "unchanged parent watches are reused");
});

test("retargeting a configured directory link never subscribes to its new destination", t => {
  const f = fixture(t), first = f.make("first"), second = f.make("second");
  const alias = path.join(f.base, "alias");
  fs.symlinkSync(first, alias, linkKind);
  f.add(alias);
  fs.unlinkSync(alias); fs.symlinkSync(second, alias, linkKind);
  f.watchers.get(f.base).notify("alias");
  assert.deepEqual(f.changes.map(({ entry, kind, state }) => [entry, kind, state]), [[alias, "configured", "link"]]);
  assert.equal(f.watchers.has(second), false);
  assert.equal(f.watchers.size, 0, "suspended library releases all entry subscriptions");
});

for (const level of ["library", "ancestor"]) {
  for (const replacement of ["directory", "link", "missing", "file"]) {
    test(`a pinned ${level} replaced by ${replacement} is never adopted by a watcher`, t => {
      const f = fixture(t), library = f.make("parent/library"), outside = f.make("outside");
      const target = level === "library" ? library : path.dirname(library);
      f.add(library);
      const old = f.watchers.get(path.dirname(target));
      fs.renameSync(target, target + "-old");
      if (replacement === "directory") fs.mkdirSync(target);
      if (replacement === "link") fs.symlinkSync(outside, target, linkKind);
      if (replacement === "file") fs.writeFileSync(target, "replacement");
      old.notify(path.basename(target));
      assert.deepEqual(f.changes.map(({ entry, kind, state }) => [entry, kind, state]),
        [[target, "physical", replacement === "file" ? "other" : replacement]]);
      assert.equal(f.watchers.size, 0);
      assert.equal(f.clock.pending(), 0);
      old.notify(path.basename(target));
      assert.equal(f.changes.length, 1, "queued stale notifications cannot revive monitoring");
    });
  }
}

test("a shared ancestor is validated for every affected library and both stop", t => {
  const f = fixture(t), first = f.make("parent/first"), second = f.make("parent/second"), third = f.make("unrelated");
  f.add(first); f.add(second); f.add(third);
  const parent = path.dirname(first), unaffected = f.watchers.get(f.base);
  fs.renameSync(parent, parent + "-old"); fs.mkdirSync(parent);
  unaffected.notify("parent");
  assert.deepEqual(f.changes.map(item => item.library).sort(), [first, second].sort());
  assert.equal(f.watchers.get(f.base), unaffected, "shared healthy parent handle is retained");
  assert.equal(f.watchers.has(parent), false);
  assert.equal(f.pins.has(third), true);
});

test("a failed parent watcher recovers without changing its library pin", t => {
  const f = fixture(t), library = f.make("library");
  const pin = f.add(library), ancestor = f.watchers.get(path.dirname(f.base));
  f.watchers.get(f.base).emit("error", new Error("lost notifications"));
  assert.equal(f.watchers.has(f.base), false);
  assert.equal(f.watchers.get(path.dirname(f.base)), ancestor);
  assert.equal(f.clock.pending(), 1);
  f.clock.advance(1000);
  assert.equal(f.attempts.get(f.base), 2);
  assert.equal(f.pins.get(library), pin);
  assert.equal(f.clock.pending(), 0);
  assert.equal(f.logs.filter(line => line.includes("Monitoring degraded:")).length, 1);
  assert.equal(f.logs.filter(line => line.includes("Monitoring restored:")).length, 1);
});

test("five scheduled attempts are bounded; only relevant events retry after ten seconds", t => {
  const f = fixture(t), library = f.make("library");
  f.failures.set(f.base, 6);
  f.add(library);
  for (const [i, wait] of [1000, 2000, 4000, 8000, 16000].entries()) {
    f.clock.advance(wait);
    assert.equal(f.attempts.get(f.base), i + 2);
  }
  assert.equal(f.clock.pending(), 0);
  f.clock.advance(9999); f.monitor.onLibraryEvent(library);
  assert.equal(f.attempts.get(f.base), 6);
  f.clock.advance(1);
  f.watchers.get(path.dirname(f.base)).notify("unrelated");
  assert.equal(f.attempts.get(f.base), 6);
  f.watchers.get(path.dirname(f.base)).notify(path.basename(f.base));
  assert.equal(f.attempts.get(f.base), 7);
  assert.equal(f.watchers.has(f.base), true);
  assert.equal(f.clock.pending(), 0);
});

test("a replacement during a parent watcher outage suspends before the retry registers anything", t => {
  const f = fixture(t), library = f.make("parent/library"), parent = path.dirname(library);
  f.add(library);
  f.watchers.get(parent).emit("error", new Error("lost notifications"));
  fs.renameSync(parent, parent + "-old"); fs.mkdirSync(library, { recursive: true });
  f.clock.advance(1000);
  assert.equal(f.attempts.get(parent), 1);
  assert.equal(f.changes[0].entry, parent);
  assert.equal(f.watchers.has(parent), false);
  assert.equal(f.clock.pending(), 0);
});

test("watcher errors validate libraries added after the shared watcher was registered", t => {
  const f = fixture(t), first = f.make("first"), second = f.make("second");
  f.add(first); const shared = f.watchers.get(f.base); f.add(second);
  fs.renameSync(second, second + "-old"); fs.mkdirSync(second);
  f.checked.length = 0;
  shared.emit("error", new Error("lost notifications"));
  assert.ok(f.checked.includes(first) && f.checked.includes(second));
  assert.equal(f.changes[0].library, second);
  f.clock.advance(1000);
  assert.ok(f.watchers.has(f.base));
  assert.equal(f.pins.has(second), false);
});

test("an inaccessible pin cannot register a watcher until its original identity is verified", t => {
  const f = fixture(t), library = f.make("library"), pin = f.add(library);
  f.watchers.get(f.base).emit("error", new Error("lost notifications"));
  f.pins.delete(library); // Simulate a temporary verification failure, not removal.
  f.clock.advance(1000);
  assert.equal(f.attempts.get(f.base), 1);
  f.pins.set(library, pin);
  f.clock.advance(2000);
  assert.equal(f.attempts.get(f.base), 2);
  assert.equal(f.pins.get(library), pin);
});

test("removing and disposing a library cancels its scheduled parent recovery", t => {
  const f = fixture(t), library = f.make("library");
  f.add(library); f.watchers.get(f.base).emit("error", new Error("lost notifications"));
  assert.equal(f.clock.pending(), 1);
  f.monitor.remove(library);
  assert.equal(f.clock.pending(), 0);
  f.add(library); f.watchers.get(f.base).emit("error", new Error("lost notifications"));
  f.monitor.dispose();
  assert.equal(f.clock.pending(), 0);
  assert.equal(f.watchers.size, 0);
});
