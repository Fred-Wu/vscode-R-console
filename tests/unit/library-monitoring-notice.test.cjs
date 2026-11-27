const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { LibraryMonitoringNotices } = loadSource("src/Language/libraryMonitoringNotice.ts");
const linkKind = process.platform === "win32" ? "junction" : "dir";

function fixture(t, overrides = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-pin-")));
  const watches = [], resolutions = [], scans = [], changes = [], reviews = [], logs = [];
  const realpathSync = Object.assign((...args) => fs.realpathSync(...args), {
    native: (file, ...args) => { resolutions.push(file); return fs.realpathSync.native(file, ...args); },
  });
  const { PackageInventory } = loadSource("src/Language/packageInventory.ts", { fs: {
    ...fs, realpathSync,
    promises: { ...fs.promises, readdir: async (file, ...args) => {
      scans.push(file); return fs.promises.readdir(file, ...args);
    }, ...overrides.promises },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "promises")),
    watch(file, options, callback) {
      const watcher = new EventEmitter();
      const record = { file, options, watcher, notify: name => callback("rename", name), closed: false };
      watcher.close = () => { record.closed = true; };
      watches.push(record);
      return watcher;
    },
  } });
  const inventory = new PackageInventory(async change => changes.push(change), line => logs.push(line), review => reviews.push(review));
  const mkdir = name => { const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
  const install = (library, version = "1.0", name = "example") => {
    const pkg = path.join(library, name); fs.mkdirSync(path.join(pkg, "Meta"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "DESCRIPTION"), `Package: ${name}\nVersion: ${version}\n`);
    fs.writeFileSync(path.join(pkg, "Meta", "package.rds"), version);
  };
  const notify = (parent, name, entry = true) => {
    const record = watches.findLast(w => !w.closed && w.file === parent && (w.options.encoding === "utf8") === entry);
    assert.ok(record, `active watcher for ${parent}`); record.notify(name);
  };
  const settle = async (observed = () => true) => {
    const deadline = Date.now() + 10000;
    do {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (observed() && inventory.initialized && !inventory.timer && !inventory.retryTimer && !inventory.pending && !inventory.dirtyLibraries.size && !inventory.unconfirmedLibraries.size) return;
      assert.ok(Date.now() < deadline, "inventory settles: " + logs.join("\n"));
    } while (true);
  };
  t.after(() => { inventory.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, watches, resolutions, scans, changes, reviews, logs, inventory, mkdir, install, notify, settle };
}

test("an ordinary replacement suspends before warning and resumes only after a reviewed pin is accepted", async t => {
  const f = fixture(t), library = f.mkdir("library"); f.install(library);
  f.inventory.setLibraryPaths([library]); await f.settle();
  const old = f.inventory.pins.get(library), previous = f.changes.at(-1);
  fs.renameSync(library, library + "-old"); f.install(library, "2.0");
  const oldScans = f.scans.length, oldWatches = f.watches.length;
  f.notify(f.base, "library");
  assert.equal(f.inventory.watchers.has(library), false);
  assert.equal(previous.isCurrent(), false, "suspension invalidates an outstanding publication");
  assert.equal(f.reviews.length, 1);
  assert.equal(f.reviews[0].reason, "Pinned library replaced");
  assert.equal(f.reviews[0].entry, library);
  assert.equal(f.inventory.pins.get(library), old);
  await f.settle(() => f.changes.at(-1).libraries[0].suspended);
  assert.deepEqual(f.resolutions, [library]);
  assert.equal(f.scans.length, oldScans); assert.equal(f.watches.length, oldWatches);
  assert.equal(f.changes.at(-1).packages.get("example").version, "1.0");
  assert.deepEqual(f.changes.at(-1).unmonitored, ["example"]);
  assert.ok(f.changes.at(-1).unmonitoredRoots.includes(library));
  const proposal = f.reviews[0].review();
  assert.equal(proposal.root, old.root);
  assert.notDeepEqual(proposal, old);
  assert.equal(f.watches.length, oldWatches, "review alone opens no watches");
  assert.equal(f.scans.length, oldScans, "review alone reads no package inventory");
  assert.equal(f.reviews[0].approve(proposal), true);
  await f.settle(() => f.changes.at(-1).packages.get("example").version === "2.0");
  assert.equal(f.reviews[0].isCurrent(), false);
  assert.deepEqual(f.changes.at(-1).unmonitored, []);
  assert.equal(f.inventory.watchers.has(library), true);
});

test("a symlink replacement reports the exact path, and an outdated review cannot approve another destination", async t => {
  const f = fixture(t), library = f.mkdir("library"), first = f.mkdir("first"), second = f.mkdir("second");
  f.install(library); f.install(first, "2.0"); f.install(second, "3.0");
  f.inventory.setLibraryPaths([library]); await f.settle();
  fs.renameSync(library, library + "-old"); fs.symlinkSync(first, library, linkKind);
  f.notify(f.base, "library");
  const review = f.reviews[0];
  assert.equal(review.reason, "Pinned library replaced by a symlink");
  assert.equal(review.entry, library);
  assert.deepEqual(f.resolutions, [library], "warning does not resolve the new link");
  const proposal = review.review(); assert.equal(proposal.root, first);
  fs.unlinkSync(library); fs.symlinkSync(second, library, linkKind);
  assert.equal(review.approve(proposal), false);
  assert.equal(f.inventory.watchers.has(library), false);
  assert.ok(!f.watches.some(w => w.file === first || w.file === second));
  assert.ok(!f.scans.includes(first) && !f.scans.includes(second));
  assert.equal(review.approve(review.review()), true);
  await f.settle(() => f.changes.at(-1).packages.get("example").version === "3.0");
  assert.equal(f.inventory.pins.get(library).root, second);
  assert.ok(!f.scans.includes(first));
});

test("missing or renamed libraries are not accepted on recreation or on search-order changes", async t => {
  const f = fixture(t), library = f.mkdir("library"), healthy = f.mkdir("healthy"); f.install(library);
  f.inventory.setLibraryPaths([library, healthy]); await f.settle();
  fs.renameSync(library, library + "-old"); f.notify(f.base, "library");
  const review = f.reviews[0]; assert.equal(review.reason, "Pinned library missing or renamed");
  assert.throws(() => review.review());
  review.reject();
  f.install(library, "2.0"); f.notify(f.base, "library");
  f.inventory.setLibraryPaths([healthy, library]); await f.settle();
  assert.equal(f.inventory.watchers.has(library), false);
  assert.equal(review.isCurrent(), false);
  assert.deepEqual(f.resolutions, [library, healthy]);
  assert.equal(f.reviews.length, 1);
  f.inventory.setLibraryPaths([healthy]); f.inventory.setLibraryPaths([healthy, library]);
  await f.settle(() => f.changes.at(-1).packages.get("example").version === "2.0");
  assert.equal(f.inventory.watchers.has(library), true);
  assert.deepEqual(f.resolutions, [library, healthy, library]);
});

test("a missing initial path has no authorised identity until a user reviews it", async t => {
  const f = fixture(t), library = path.join(f.base, "missing");
  f.inventory.setLibraryPaths([library]); await f.settle();
  assert.equal(f.reviews[0].previousRoot, undefined);
  assert.equal(f.reviews[0].reason, "Configured library path missing or renamed");
  assert.equal(f.watches.length, 0); assert.equal(f.scans.length, 0);
  f.install(library); await f.inventory.refresh();
  assert.equal(f.inventory.watchers.has(library), false);
  const review = f.reviews[0]; assert.equal(review.approve(review.review()), true);
  await f.settle(() => f.changes.at(-1).packages.has("example"));
});

test("an approved shared ancestor replacement grants no trust to another suspended library", async t => {
  const f = fixture(t), first = f.mkdir("parent/first"), second = f.mkdir("parent/second");
  f.install(first, "1.0", "one"); f.install(second, "1.0", "two");
  f.inventory.setLibraryPaths([first, second]); await f.settle();
  const parent = path.dirname(first);
  fs.renameSync(parent, parent + "-old"); f.install(first, "2.0", "one"); f.install(second, "2.0", "two");
  f.notify(f.base, "parent");
  assert.equal(f.reviews.length, 2); assert.ok(f.reviews.every(r => r.reason === "Pinned library ancestor replaced" && r.entry === parent));
  const review = f.reviews.find(r => r.library === first);
  assert.equal(review.approve(review.review()), true);
  await f.settle(() => f.changes.at(-1).packages.get("one").version === "2.0");
  assert.equal(f.inventory.watchers.has(second), false);
  assert.equal(f.changes.at(-1).packages.get("two").version, "1.0");
  assert.deepEqual(f.changes.at(-1).unmonitored, ["two"]);
});

test("a temporary lstat failure preserves the original pin and does not show a security warning", async t => {
  let library, unavailable = false;
  const f = fixture(t, { lstatSync: (file, ...args) => {
    if (unavailable && file === library) throw Object.assign(new Error("temporarily unavailable"), { code: "EACCES" });
    return fs.lstatSync(file, ...args);
  } });
  library = f.mkdir("library"); f.install(library); f.inventory.setLibraryPaths([library]); await f.settle();
  const pin = f.inventory.pins.get(library);
  unavailable = true; f.notify(f.base, "library");
  const deadline = Date.now() + 5000;
  while (!f.changes.at(-1).libraries[0].unavailable) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)); }
  unavailable = false; f.install(library, "2.0");
  f.notify(library, "example", false); await f.settle(() => f.changes.at(-1).packages.get("example").version === "2.0");
  assert.equal(f.inventory.pins.get(library), pin);
  assert.equal(f.reviews.length, 0);
  assert.deepEqual(f.resolutions, [library]);
});

test("a pending inventory scan cannot publish or continue metadata access after suspension", async t => {
  let library, block = false, entered, release;
  const begun = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const opened = [];
  const f = fixture(t, { promises: {
    readdir: async (file, ...args) => {
      const entries = await fs.promises.readdir(file, ...args);
      if (block && file === library) { entered(); await blocked; }
      return entries;
    },
    open: async (file, ...args) => { opened.push(file); return fs.promises.open(file, ...args); },
  } });
  t.after(() => release());
  library = f.mkdir("library"); f.install(library); f.inventory.setLibraryPaths([library]); await f.settle();
  opened.length = 0; block = true; f.inventory.dirtyLibraries.add(library);
  const pending = f.inventory.refresh(); await begun;
  fs.renameSync(library, library + "-old"); f.install(library, "2.0"); f.notify(f.base, "library");
  block = false; release(); await pending; await f.settle(() => f.changes.at(-1).libraries[0].suspended);
  assert.deepEqual(opened, []);
  assert.equal(f.changes.at(-1).packages.get("example").version, "1.0");
});

test("removal and disposal invalidate pending review decisions", async t => {
  const f = fixture(t), library = f.mkdir("library"); f.inventory.setLibraryPaths([library]); await f.settle();
  fs.renameSync(library, library + "-old"); fs.mkdirSync(library); f.notify(f.base, "library");
  const review = f.reviews[0], proposal = review.review();
  f.inventory.setLibraryPaths([]); f.inventory.setLibraryPaths([library]);
  assert.equal(review.approve(proposal), false);
  assert.equal(review.review(), undefined);
  fs.renameSync(library, library + "-second"); fs.mkdirSync(library); f.notify(f.base, "library");
  const next = f.reviews[1], newer = next.review(); f.inventory.dispose();
  assert.equal(next.approve(newer), false);
});

function dialogFixture(answers, { unavailable = false, stale = false } = {}) {
  const messages = [], proposal = { root: "/new" };
  let current = true, reviewed = 0, approved = 0, rejected = 0;
  const request = {
    library: "/old", previousRoot: "/old", entry: "/old", reason: "Pinned library replaced by a symlink",
    isCurrent: () => current,
    review() { reviewed++; if (unavailable && reviewed === 1) throw new Error("missing"); return proposal; },
    approve(value) { assert.equal(value, proposal); approved++; if (stale && approved === 1) return false; current = false; return true; },
    reject() { rejected++; current = false; },
  };
  const queue = new LibraryMonitoringNotices(async (message, detail, actions) => {
    messages.push({ message, detail, actions }); return answers.shift();
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { request, queue, messages, flush, counts: () => ({ reviewed, approved, rejected }) };
}

for (const choice of ["Stop Monitoring", undefined]) {
  test(`stage one ${choice ?? "dismissal"} does not resolve a replacement`, async () => {
    const f = dialogFixture([choice]); f.queue.enqueue(f.request); await f.flush();
    assert.equal(f.messages.length, 1); assert.deepEqual(f.counts(), { reviewed: 0, approved: 0, rejected: 1 });
    assert.match(f.messages[0].message, /Pinned library replaced by a symlink: \/old/);
  });
}
for (const choice of ["Reject", undefined, "Trust and Resume"]) {
  test(`stage two ${choice ?? "dismissal"} requires explicit trust`, async () => {
    const f = dialogFixture(["Review New Location", choice]); f.queue.enqueue(f.request); await f.flush();
    assert.equal(f.messages.length, 2);
    assert.deepEqual(f.messages[1].actions, ["Reject", "Trust and Resume"]);
    assert.equal(f.messages[1].message, "R Console: Trust new library location?");
    assert.match(f.messages[1].detail, /Previously pinned: \/old\nNew location: \/new\nReason: Pinned library replaced by a symlink/);
    assert.deepEqual(f.counts(), { reviewed: 1, approved: choice === "Trust and Resume" ? 1 : 0, rejected: choice === "Trust and Resume" ? 0 : 1 });
  });
}
test("unavailable proposals are only checked again on an explicit request", async () => {
  const f = dialogFixture(["Review New Location", "Check Location Again", "Trust and Resume"], { unavailable: true });
  f.queue.enqueue(f.request); await f.flush();
  assert.deepEqual(f.messages[1].actions, ["Check Location Again", "Stop Monitoring"]);
  assert.deepEqual(f.counts(), { reviewed: 2, approved: 1, rejected: 0 });
});
test("a stale confirmation requires another review and explicit acceptance", async () => {
  const f = dialogFixture(["Review New Location", "Trust and Resume", "Review New Location", "Trust and Resume"], { stale: true });
  f.queue.enqueue(f.request); await f.flush();
  assert.equal(f.messages.length, 4);
  assert.match(f.messages[2].message, /changed or is unavailable/);
  assert.deepEqual(f.counts(), { reviewed: 2, approved: 2, rejected: 0 });
});
test("simultaneous shared ancestor changes produce one warning with independent decisions", async () => {
  const f = dialogFixture(["Stop Monitoring"]);
  let otherRejected = false;
  f.queue.enqueue(f.request); f.queue.enqueue({ ...f.request, library: "/another", isCurrent: () => true, reject: () => { otherRejected = true; } });
  await f.flush();
  assert.equal(f.messages.length, 1); assert.match(f.messages[0].message, /Affected libraries: \/old, \/another/);
  assert.equal(otherRejected, true);
});

test("unrelated inventory changes revalidate cached pins before publication", async t => {
  const f = fixture(t), library = f.mkdir("library"), healthy = f.mkdir("healthy");
  f.install(library); f.install(healthy, "1.0", "other");
  f.inventory.setLibraryPaths([library, healthy]); await f.settle();
  fs.renameSync(library, library + "-old"); f.install(library, "2.0");
  // Model a lost/delayed ancestor notification, then a healthy package event.
  f.install(healthy, "2.0", "other"); f.notify(healthy, "other", false);
  await f.settle(() => f.changes.at(-1).libraries[0].suspended &&
    f.changes.at(-1).packages.get("other").version === "2.0");
  assert.equal(f.reviews.length, 1);
  assert.equal(f.changes.at(-1).packages.get("example").version, "1.0");
  assert.ok(f.changes.at(-1).unmonitored.includes("example"));
});
