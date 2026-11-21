const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { PackageInventory } = loadSource("src/Language/packageInventory.ts");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-inventory-"));
  const libraries = ["first", "second"].map(name => path.join(root, name));
  libraries.forEach(library => fs.mkdirSync(library));
  const changes = [], logs = [];
  const inventory = new PackageInventory(async change => changes.push(change), line => logs.push(line));
  t.after(() => {
    inventory.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const install = (library, version = "1.0") => {
    const directory = path.join(library, "example");
    fs.mkdirSync(path.join(directory, "Meta"), { recursive: true });
    fs.writeFileSync(path.join(directory, "DESCRIPTION"), `Package: example\nVersion: ${version}\n`);
    fs.writeFileSync(path.join(directory, "Meta", "package.rds"), version);
    return directory;
  };
  const settle = async () => {
    const deadline = Date.now() + 10000;
    do {
      await new Promise(resolve => setTimeout(resolve, 20));
      if (inventory.disposed || (inventory.initialized && !inventory.timer && !inventory.retryTimer && !inventory.pending && !inventory.dirtyLibraries.size)) return;
      assert.ok(Date.now() < deadline, "inventory settles after pending filesystem events");
    } while (true);
  };
  return { root, libraries, inventory, changes, logs, install, settle };
}

test("inventory preserves effective copies across duplicate additions, removals and library order changes", async t => {
  const { libraries: [first, second], inventory, changes, logs, install, settle } = fixture(t);
  install(first, "2.0");
  install(second);
  inventory.setLibraryPaths([first, second]);
  await settle();
  assert.equal(changes.at(-1).packages.get("example").path, path.join(first, "example"));
  assert.ok(logs.some(line => line.includes("2 installations; 1 unique")));

  fs.rmSync(path.join(second, "example"), { recursive: true });
  await settle();
  assert.deepEqual(changes.at(-1).changed, []);
  assert.ok(logs.some(line => line.includes("Active package copies unchanged")));
  install(second);
  await settle();
  assert.deepEqual(changes.at(-1).changed, []);

  inventory.setLibraryPaths([second, first]);
  await settle();
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.equal(changes.at(-1).packages.get("example").version, "1.0");
  fs.rmSync(path.join(second, "example"), { recursive: true });
  await settle();
  assert.equal(changes.at(-1).packages.get("example").version, "2.0");
  assert.ok(logs.some(line => line.includes("Using remaining copy: example 2.0")));
  fs.rmSync(path.join(first, "example"), { recursive: true });
  await settle();
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.equal(changes.at(-1).packages.size, 0);
  assert.ok(logs.some(line => line.includes("no copies remain")));
});

test("inventory ignores lock-only changes and defers packages while installation is locked", async t => {
  const { libraries: [library], inventory, changes, logs, install, settle } = fixture(t);
  inventory.setLibraryPaths([library]);
  await settle();
  const count = changes.length;
  const lock = path.join(library, "00LOCK-example");
  fs.mkdirSync(lock);
  await settle();
  assert.equal(changes.length, count);
  assert.ok(logs.some(line => line.includes("Filesystem event:") && line.includes(library)));
  assert.ok(logs.includes(`[Libraries] Scan deferred: installation lock present - ${library}`));
  assert.ok(logs.includes("[Libraries] Package inventory unchanged"));
  install(library);
  await settle();
  assert.equal(changes.length, count);
  fs.rmdirSync(lock);
  await settle();
  assert.deepEqual(changes.at(-1).changed, ["example"]);
});

test("inventory detects same-version package replacement from folder events", async t => {
  const { libraries: [library], inventory, changes, logs, install, settle } = fixture(t);
  const directory = install(library);
  inventory.setLibraryPaths([library]);
  await settle();
  const identity = changes.at(-1).packages.get("example").identity;
  fs.rmSync(directory, { recursive: true });
  install(library);
  // Filesystem notifications are asynchronous. "Settled" can be true
  // before the first event arrives, so wait for the actual replacement.
  const deadline = Date.now() + 10000;
  while (changes.at(-1).packages.get("example")?.identity === identity) {
    assert.ok(Date.now() < deadline, "same-version replacement must be observed");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await settle();
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.notEqual(changes.at(-1).packages.get("example").identity, identity);
  assert.ok(logs.some(line => line.includes("Updated: example 1.0 -> 1.0")));
});

test("inventory detects package link replacement from folder events", async t => {
  const { root, libraries: [library], inventory, changes, install, settle } = fixture(t);
  const cache = path.join(root, "cache");
  const directory = install(cache);
  const link = path.join(library, "example");
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(directory, link, type);
  inventory.setLibraryPaths([library]);
  await settle();
  assert.equal(changes.at(-1).packages.get("example").version, "1.0");
  const replacement = install(path.join(root, "replacement"), "2.0");
  fs.unlinkSync(link);
  fs.symlinkSync(replacement, link, type);
  await settle();
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.equal(changes.at(-1).packages.get("example").version, "2.0");
});

test("inventory stops scanning after events settle and coalesces concurrent scans", async t => {
  const { libraries: [library], inventory, changes, install, settle } = fixture(t);
  install(library);
  inventory.setLibraryPaths([library]);
  await settle();
  const count = changes.length;
  assert.equal(inventory.timer, undefined, "no periodic fallback is scheduled");
  fs.rmSync(path.join(library, "example"), { recursive: true });
  install(library, "2.0");
  const first = inventory.refresh();
  const second = inventory.refresh();
  assert.equal(first, second);
  await first;
  await settle();
  assert.equal(changes.length, count + 1);
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.equal(inventory.timer, undefined, "no periodic fallback after a package change");
  inventory.dispose();
  fs.rmSync(path.join(library, "example"), { recursive: true });
  await settle();
  assert.equal(changes.length, count + 1);
});

test("two library links to the same installation retain its completion metadata", async t => {
  const { root, libraries: [first, second], inventory, changes, install, settle } = fixture(t);
  const target = install(path.join(root, "cache"));
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(target, path.join(first, "example"), type);
  fs.symlinkSync(target, path.join(second, "example"), type);
  inventory.setLibraryPaths([first, second]);
  await settle();
  fs.unlinkSync(path.join(first, "example"));
  await settle();
  assert.deepEqual(changes.at(-1).changed, []);
  assert.equal(changes.at(-1).packages.get("example").path, path.join(second, "example"));
});

test("a failed refresh retries only dirty libraries and publishes the latest installation", async t => {
  const { libraries: [first, second], inventory, changes, logs, install, settle } = fixture(t);
  install(first);
  install(second);
  inventory.setLibraryPaths([first, second]);
  await settle();
  const original = changes.at(-1);
  assert.ok(!logs.some(line => line.includes("Recovery complete")));
  const publish = inventory.onChange;
  let fail;
  const failed = new Promise(resolve => { fail = resolve; });
  inventory.onChange = async () => {
    fail();
    throw new Error("Language server connection closed");
  };
  fs.rmSync(path.join(first, "example"), { recursive: true });
  install(first, "2.0");
  await failed;
  await inventory.pending;
  assert.equal(changes.at(-1), original, "retain the last successful inventory");
  assert.ok(inventory.dirtyLibraries.has(first));
  assert.ok(inventory.retryTimer);
  assert.equal(inventory.timer, undefined, "failure recovery uses the slower retry timer");
  inventory.onChange = publish;
  fs.rmSync(path.join(first, "example"), { recursive: true });
  install(first, "3.0");
  await settle();
  assert.equal(changes.at(-1).packages.get("example").version, "3.0");
  assert.equal(changes.at(-1).libraries[1], original.libraries[1], "reuse the unaffected library");
  assert.equal(inventory.retryDelay, 1000);
  assert.equal(inventory.retryTimer, undefined);
  assert.ok(logs.includes("[Libraries] Recovery retry scheduled in 1s"));
  // A fresh filesystem event can now recover before the delayed retry fires.
  // Both paths must settle the inventory and cancel the backoff timer.
  assert.equal(logs.filter(line => line.includes("Recovery complete; retries stopped")).length, 1);
});

test("watcher recovery reconciles additions and removals made while watching was unavailable", async t => {
  const { libraries: [library], inventory, changes, logs, install, settle } = fixture(t);
  inventory.setLibraryPaths([library]);
  await settle();
  const firstWatcher = inventory.watchers.get(library);
  firstWatcher.emit("error", new Error("Watch unavailable"));
  assert.ok(!inventory.watchers.has(library));
  install(library);
  await settle();
  assert.ok(changes.at(-1).packages.has("example"));
  const secondWatcher = inventory.watchers.get(library);
  assert.ok(secondWatcher);
  assert.notEqual(secondWatcher, firstWatcher);
  assert.ok(logs.includes(`[Libraries] Watcher restored: ${library}`));
  secondWatcher.emit("error", new Error("Watch unavailable"));
  fs.rmSync(path.join(library, "example"), { recursive: true });
  await settle();
  assert.equal(changes.at(-1).packages.size, 0);
  assert.equal(inventory.retryTimer, undefined);
});

test("a library scan failure keeps its changes pending for retry", async t => {
  const { libraries: [library], inventory, changes, install, settle } = fixture(t);
  inventory.setLibraryPaths([library]);
  await settle();
  const readPackage = inventory.readPackage.bind(inventory);
  let failed = false;
  inventory.readPackage = (...args) => {
    if (!failed) {
      failed = true;
      return Promise.reject(new Error("Temporary read failure"));
    }
    return readPackage(...args);
  };
  install(library);
  await settle();
  assert.ok(failed);
  assert.ok(changes.at(-1).packages.has("example"));
  assert.equal(inventory.retryTimer, undefined);
});

test("a watcher that could not be created recovers when its library becomes available", async t => {
  const { libraries: [library], inventory, changes, install, settle } = fixture(t);
  fs.rmdirSync(library);
  inventory.setLibraryPaths([library]);
  assert.equal(inventory.watchers.size, 0);
  assert.ok(inventory.retryTimer);
  install(library);
  await settle();
  assert.ok(inventory.watchers.has(library));
  assert.ok(changes.at(-1).packages.has("example"));
  assert.equal(inventory.retryTimer, undefined);
});

test("repeated failures back off and disposal cancels recovery", async t => {
  const { libraries: [library], inventory, logs, install, settle } = fixture(t);
  inventory.setLibraryPaths([library]);
  await settle();
  let attempts = 0;
  let secondFailure;
  const failedTwice = new Promise(resolve => { secondFailure = resolve; });
  inventory.onChange = async () => {
    if (++attempts === 2) secondFailure();
    throw new Error("Language server unavailable");
  };
  install(library);
  await failedTwice;
  await inventory.pending;
  assert.equal(inventory.retryDelay, 4000, "the next delay doubles after each failure");
  assert.ok(logs.includes("[Libraries] Recovery retry scheduled in 2s"));
  assert.ok(inventory.retryTimer);
  inventory.watchers.get(library).emit("error", new Error("Watch unavailable"));
  inventory.dispose();
  assert.equal(inventory.retryTimer, undefined);
  assert.equal(inventory.timer, undefined);
  assert.equal(inventory.watchers.size, 0);
  await inventory.refresh();
  assert.equal(attempts, 2);
  assert.ok(!logs.some(line => line.includes("Recovery complete")), "disposal is not successful recovery");
});

test("replacing an existing library directory re-arms its watcher without an error event", async t => {
  const { libraries: [library], inventory, changes, install, settle } = fixture(t);
  install(library);
  inventory.setLibraryPaths([library]);
  await settle();
  const previous = inventory.watchers.get(library);
  const moved = library + "-old";
  fs.renameSync(library, moved);
  fs.mkdirSync(library);
  install(library, "2.0");
  const deadline = Date.now() + 10000;
  while (changes.at(-1)?.packages.get("example")?.version !== "2.0") {
    assert.ok(Date.now() < deadline, "replacement directory must be detected");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await settle();
  assert.notEqual(inventory.watchers.get(library), previous);
  assert.deepEqual(changes.at(-1).changed, ["example"]);

  // The newly created watcher must keep observing subsequent installations.
  fs.rmSync(path.join(library, "example"), { recursive: true });
  install(library, "3.0");
  const nextDeadline = Date.now() + 10000;
  while (changes.at(-1)?.packages.get("example")?.version !== "3.0") {
    assert.ok(Date.now() < nextDeadline, "rearmed watcher must receive later package changes");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await settle();
});

test("healthy library events refresh during a different library's recovery backoff", async t => {
  const { libraries: [first, second], inventory, changes, install, settle } = fixture(t);
  install(first);
  install(second);
  inventory.setLibraryPaths([first, second]);
  await settle();
  // Keep the recovery timer well beyond the normal two-pass 250ms scan.
  inventory.retryDelay = 10000;
  inventory.watchers.get(first).emit("error", new Error("Watcher unavailable"));
  assert.ok(inventory.retryTimer);
  fs.rmSync(path.join(second, "example"), { recursive: true });
  install(second, "2.0");
  const deadline = Date.now() + 3000;
  while (changes.at(-1).libraries[1].packages.get("example")?.version !== "2.0") {
    assert.ok(Date.now() < deadline, "healthy library must refresh before recovery retry");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(inventory.retryTimer, "failed library is still backing off");
  assert.equal(changes.at(-1).libraries[1].packages.get("example").version, "2.0");
});

test("a queued healthy scan is not cancelled by another library's watcher failure", async t => {
  const { libraries: [first, second], inventory, changes, install, settle } = fixture(t);
  install(first);
  install(second);
  inventory.setLibraryPaths([first, second]);
  await settle();
  inventory.retryDelay = 10000;
  fs.rmSync(path.join(second, "example"), { recursive: true });
  install(second, "2.0");
  const eventDeadline = Date.now() + 2000;
  while (!inventory.timer) {
    assert.ok(Date.now() < eventDeadline, "healthy library must schedule a scan");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  inventory.watchers.get(first).emit("error", new Error("Unrelated watcher failure"));
  assert.ok(inventory.timer, "queued healthy scan must survive retry scheduling");
  const deadline = Date.now() + 3000;
  while (changes.at(-1).libraries[1].packages.get("example")?.version !== "2.0") {
    assert.ok(Date.now() < deadline, "healthy library change must publish without retry");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(inventory.retryTimer, "failed watcher still backs off independently");
});

test("removing and readding an entire runtime library closes and restores its watcher", async t => {
  const { libraries: [first, second], inventory, changes, logs, install, settle } = fixture(t);
  install(first, "1.0");
  install(second, "2.0");
  inventory.setLibraryPaths([first, second]);
  await settle();
  assert.equal(changes.at(-1).packages.get("example").version, "1.0");

  inventory.setLibraryPaths([second]);
  await settle();
  assert.equal(inventory.watchers.has(first), false, "removed libraries must stop being watched");
  assert.equal(inventory.parentWatchers.has(first), false);
  assert.equal(changes.at(-1).packages.get("example").version, "2.0");
  assert.ok(logs.some(line => line.includes("Selected copy changed") ||
    line.includes("Using remaining copy")));

  inventory.setLibraryPaths([first, second]);
  await settle();
  assert.equal(inventory.watchers.has(first), true, "readded libraries resume monitoring");
  assert.equal(changes.at(-1).packages.get("example").version, "1.0");
});
