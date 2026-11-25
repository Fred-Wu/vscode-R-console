const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { PackageInventory } = loadSource("src/Language/packageInventory.ts");

function sameExistingDirectory(left, right) {
  // Windows can refer to a directory by both its 8.3 short alias and long
  // spelling. Compare the underlying directory, not its textual path.
  try {
    const actual = fs.statSync(left), expected = fs.statSync(right);
    return actual.isDirectory() && expected.isDirectory() &&
      actual.dev === expected.dev && actual.ino === expected.ino &&
      actual.birthtimeMs === expected.birthtimeMs;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

function fixture(t, notificationDelay = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-inventory-"));
  const libraries = ["first", "second"].map(name => path.join(root, name));
  libraries.forEach(library => fs.mkdirSync(library));
  const changes = [], logs = [];
  const notifications = new Set();
  const Inventory = notificationDelay ? loadSource("src/Language/packageInventory.ts", { fs: {
    ...fs,
    watch: (file, options, callback) => fs.watch(file, options, (...args) => {
      const timer = setTimeout(() => { notifications.delete(timer); callback(...args); }, notificationDelay);
      notifications.add(timer);
    }),
  } }).PackageInventory : PackageInventory;
  const inventory = new Inventory(async change => changes.push(change), line => logs.push(line));
  t.after(() => {
    inventory.dispose();
    for (const timer of notifications) clearTimeout(timer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const install = (library, version = "1.0") => {
    const directory = path.join(library, "example");
    fs.mkdirSync(path.join(directory, "Meta"), { recursive: true });
    fs.writeFileSync(path.join(directory, "DESCRIPTION"), `Package: example\nVersion: ${version}\n`);
    fs.writeFileSync(path.join(directory, "Meta", "package.rds"), version);
    return directory;
  };
  const settle = async (observed = () => true, description = "inventory settles after pending filesystem events") => {
    const deadline = Date.now() + 10000;
    do {
      await new Promise(resolve => setTimeout(resolve, 20));
      if (observed() && (inventory.disposed || (inventory.initialized && !inventory.timer && !inventory.retryTimer && !inventory.pending && !inventory.dirtyLibraries.size && !inventory.unconfirmedLibraries.size))) return;
      assert.ok(Date.now() < deadline, description);
    } while (true);
  };
  // OS notifications can arrive after an idle check. Observe the effect of
  // each mutation before checking that its resulting work has settled.
  const waitForLog = message => settle(() => logs.some(line => line.includes(message)),
    `inventory must report: ${message}`);
  return { root, libraries, inventory, changes, logs, install, settle, waitForLog };
}

test("inventory preserves effective copies across duplicate additions, removals and library order changes", async t => {
  const { libraries: [first, second], inventory, changes, logs, install, settle, waitForLog } = fixture(t);
  install(first, "2.0");
  install(second);
  inventory.setLibraryPaths([first, second]);
  await settle();
  assert.equal(changes.at(-1).packages.get("example").path, path.join(first, "example"));
  assert.ok(logs.some(line => line.includes("2 installations; 1 unique")));

  // An idle inventory does not imply that the OS has delivered an fs.watch
  // notification. Wait for each observable publication before asserting state.
  logs.length = 0;
  fs.rmSync(path.join(second, "example"), { recursive: true });
  await waitForLog("Active package copies unchanged");
  assert.deepEqual(changes.at(-1).changed, []);
  logs.length = 0;
  install(second);
  await waitForLog("Added: example 1.0");
  assert.deepEqual(changes.at(-1).changed, []);

  inventory.setLibraryPaths([second, first]);
  await settle();
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.equal(changes.at(-1).packages.get("example").version, "1.0");
  logs.length = 0;
  fs.rmSync(path.join(second, "example"), { recursive: true });
  await waitForLog("Using remaining copy: example 2.0");
  assert.equal(changes.at(-1).packages.get("example").version, "2.0");
  logs.length = 0;
  fs.rmSync(path.join(first, "example"), { recursive: true });
  await waitForLog("no copies remain");
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.equal(changes.at(-1).packages.size, 0);
});

test("library search-order changes preserve retained watches and scan only added libraries", async t => {
  const { root, libraries: [first, second], inventory, changes, logs, install, settle } = fixture(t);
  install(first, "2.0");
  install(second);
  inventory.setLibraryPaths([first, second]);
  await settle();
  const firstWatcher = inventory.watchers.get(first);
  const firstParent = inventory.parentWatchers.get(first);
  const secondWatcher = inventory.watchers.get(second);
  const secondParent = inventory.parentWatchers.get(second);
  assert.ok(firstWatcher && secondWatcher && firstParent && secondParent);

  logs.length = 0;
  inventory.setLibraryPaths([second, first]);
  await settle();
  assert.equal(inventory.watchers.get(first), firstWatcher);
  assert.equal(inventory.watchers.get(second), secondWatcher);
  assert.equal(inventory.parentWatchers.get(first), firstParent);
  assert.equal(inventory.parentWatchers.get(second), secondParent);
  assert.ok(!logs.some(line => line.includes("Scanning folder:")),
    "changing search precedence must reuse existing package inventories");
  assert.equal(changes.at(-1).packages.get("example").path, path.join(second, "example"));

  const third = path.join(root, "third");
  fs.mkdirSync(third);
  logs.length = 0;
  inventory.setLibraryPaths([first, third]);
  await settle();
  assert.equal(inventory.watchers.get(first), firstWatcher);
  assert.equal(inventory.parentWatchers.get(first), firstParent);
  assert.equal(inventory.watchers.has(second), false);
  assert.equal(inventory.parentWatchers.has(second), false);
  assert.ok(inventory.watchers.has(third) && inventory.parentWatchers.has(third));
  const scans = logs.filter(line => line.includes("Scanning folder:"));
  assert.ok(scans.length > 0);
  assert.ok(scans.every(line => line.endsWith(third)),
    "only the newly added library should be scanned");
  assert.equal(changes.at(-1).packages.get("example").path, path.join(first, "example"));
});

test("reorders paths even when an older inventory scan is still in flight", async t => {
  const { libraries: [first, second], inventory, changes, settle } = fixture(t);
  inventory.setLibraryPaths([first, second]);
  await settle();
  let begin, release;
  const begun = new Promise(resolve => { begin = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const originalScan = inventory.scan.bind(inventory);
  inventory.scan = async (...args) => {
    begin();
    await blocked;
    return originalScan(...args);
  };
  t.after(() => release());
  const pending = inventory.refresh();
  await begun;
  inventory.setLibraryPaths([second, first]);
  release();
  await pending;
  await settle();
  assert.deepEqual(changes.at(-1).libraries.map(library => library.path), [second, first],
    "the newer library order must publish after the earlier scan completes");
});

for (const queue of ["dirty", "unconfirmed"]) {
  test(`reordering replays ${queue} package changes from an interrupted inventory scan`, async t => {
    const { libraries: [first, second], inventory, changes, install, settle } = fixture(t);
    install(first, "1.0");
    inventory.setLibraryPaths([first, second]);
    await settle();
    assert.equal(changes.at(-1).packages.get("example").version, "1.0");

    // Model a new installation identity without an extra filesystem event.
    // This proves the pending notification itself survives a search-order edit.
    const readPackage = inventory.readPackage.bind(inventory);
    inventory.readPackage = async (library, name, previous) => {
      const item = await readPackage(library, name, previous);
      return library === first && item
        ? { ...item, version: "2.0", identity: item.identity + "-updated" }
        : item;
    };
    if (queue === "dirty") {
      inventory.dirtyLibraries.add(first);
    } else {
      inventory.hasInstalledPackagesChanged = async library => library === first;
      inventory.unconfirmedLibraries.add(first);
    }

    let release, started;
    const blocked = new Promise(resolve => { release = resolve; });
    const begun = new Promise(resolve => { started = resolve; });
    const scan = inventory.scan.bind(inventory);
    inventory.scan = async (...args) => {
      started();
      await blocked;
      return scan(...args);
    };
    t.after(() => release());
    const pending = inventory.refresh();
    await begun;
    assert.equal(inventory.dirtyLibraries.size, 0);
    assert.equal(inventory.unconfirmedLibraries.size, 0);
    inventory.setLibraryPaths([second, first]);
    release();
    await pending;

    const deadline = Date.now() + 10000;
    while (inventory.libraries.find(item => item.path === first)?.packages.get("example")?.version !== "2.0") {
      assert.ok(Date.now() < deadline, `${queue} update must survive library reordering`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await settle();
    assert.deepEqual(changes.at(-1).libraries.map(item => item.path), [second, first]);
    assert.equal(changes.at(-1).packages.get("example").version, "2.0");
    assert.deepEqual(changes.at(-1).changed, ["example"]);
  });
}

for (const notificationDelay of [0, 100]) {
  test(`inventory defers locked installations with ${notificationDelay}ms watcher delivery delay`, async t => {
    // Delayed delivery leaves the inventory idle across several settle polls.
    const { libraries: [library], inventory, changes, logs, install, settle, waitForLog } = fixture(t, notificationDelay);
    inventory.setLibraryPaths([library]);
    await settle();
    const count = changes.length;
    const lock = path.join(library, "00LOCK-example");
    logs.length = 0;
    fs.mkdirSync(lock);
    await waitForLog(`[Libraries] Scan deferred: installation lock present - ${library}`);
    assert.equal(changes.length, count + 1, "publish lock state without publishing a partial installation");
    assert.deepEqual(changes.at(-1).changed, []);
    assert.equal(changes.at(-1).packages.size, 0);
    assert.deepEqual(changes.at(-1).libraries[0].deferred.get("example"), [path.join(library, "example")]);
    assert.ok(logs.includes(`[Libraries] Scan deferred: installation lock present - ${library}`));
    logs.length = 0;
    install(library);
    await waitForLog(`[Libraries] Scan deferred: installation lock present - ${library}`);
    assert.equal(changes.length, count + 1);
    fs.rmdirSync(lock);
    await settle(() => changes.at(-1).packages.has("example"), "unlocking must publish the installed package");
    assert.deepEqual(changes.at(-1).changed, ["example"]);
  });
}

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
  const deadline = Date.now() + 10000;
  while (changes.at(-1)?.packages.get("example")?.version !== "2.0") {
    assert.ok(Date.now() < deadline, "package link replacement must publish");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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
  // Filesystem events can arrive after the first explicit scan finishes.
  // Wait for the observed publication instead of treating idle as settled
  // before the OS has delivered its watcher notification.
  const deadline = Date.now() + 10000;
  while (changes.length === count) {
    assert.ok(Date.now() < deadline, "replacement notification arrives");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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
  assert.equal(changes.at(-1).packages.get("example").path, path.join(first, "example"));
  fs.unlinkSync(path.join(first, "example"));
  // Idle can precede delivery of the filesystem notification. Wait for the
  // surviving link to be published, then check that metadata was retained.
  const deadline = Date.now() + 10000;
  while (changes.at(-1).packages.get("example")?.path !== path.join(second, "example")) {
    assert.ok(Date.now() < deadline, "remaining package link must be published");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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
  const { libraries: [library], inventory, changes, logs, install, settle } = fixture(t);
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
  // Idle is not proof that an OS watcher event has arrived. This test is
  // about scan failure and recovery; explicitly queue the changed library
  // instead of relying on macOS/Linux/Windows filesystem event timing.
  inventory.dirtyLibraries.add(library);
  await inventory.refresh();
  assert.ok(failed, "the first scan must exercise the injected read failure");
  assert.ok(logs.some(line => line.includes("Could not refresh package inventory: Error: Temporary read failure")));
  assert.ok(logs.includes("[Libraries] Recovery retry scheduled in 1s"),
    "a failed scan must schedule recovery without losing the changed library");
  await settle();
  assert.ok(changes.at(-1).packages.has("example"),
    "the pending installation is published once the retry succeeds");
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

test("directory timestamp touches do not rescan unchanged installed packages", async t => {
  const { libraries: [library], inventory, changes, logs, install, settle } = fixture(t);
  install(library);
  inventory.setLibraryPaths([library]);
  await settle();
  const watcher = inventory.watchers.get(library);
  assert.ok(watcher);
  const published = changes.length;

  logs.length = 0;
  // Touching the library directory changes metadata, not its package entries.
  // Exercise both fs.watch formats, including filename-less macOS events.
  const touch = new Date(Date.now() - 5000);
  fs.utimesSync(library, touch, touch);
  for (let i = 0; i < 12; i++) {
    watcher.emit("change", "change", undefined);
    watcher.emit("change", "rename", undefined);
    watcher.emit("change", "change", path.basename(library));
  }
  await settle();
  assert.equal(inventory.watchers.get(library), watcher,
    "metadata updates must not re-arm the directory watcher");
  assert.equal(changes.length, published,
    "metadata-only events must not publish package inventories");
  assert.ok(!logs.some(line => line.includes("Scanning folder:") ||
    line.includes("Package inventory unchanged")),
  "metadata touches must not trigger full scans or unchanged-inventory logs");

  // Ambiguous events must still detect a replacement with the same package name.
  fs.rmSync(path.join(library, "example"), { recursive: true });
  install(library, "2.0");
  watcher.emit("change", "change", undefined);
  const deadline = Date.now() + 10000;
  while (changes.at(-1).packages.get("example")?.version !== "2.0") {
    assert.ok(Date.now() < deadline, "same-name package replacement must be detected");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await settle();
  assert.equal(changes.at(-1).packages.get("example")?.version, "2.0");
});

test("unchanged parent events do not repeatedly restore renv-style library watchers", async t => {
  const { libraries: [library], inventory, changes, logs, install, settle } = fixture(t);
  install(library);
  inventory.setLibraryPaths([library]);
  await settle();
  const childWatcher = inventory.watchers.get(library);
  const parentWatcher = inventory.parentWatchers.get(library);
  const count = changes.length;
  assert.ok(childWatcher && parentWatcher);

  logs.length = 0;
  // macOS may not supply a filename; Windows and Linux commonly do.
  for (let n = 0; n < 8; n++) {
    parentWatcher.emit("change", "rename", undefined);
    parentWatcher.emit("change", "rename", path.basename(library));
    parentWatcher.emit("change", "rename", Buffer.from(path.basename(library)));
    parentWatcher.emit("change", "rename", "unrelated-folder");
  }
  await settle();
  assert.equal(inventory.watchers.get(library), childWatcher);
  assert.equal(inventory.parentWatchers.get(library), parentWatcher);
  assert.equal(changes.length, count);
  assert.ok(!logs.some(line => line.includes("Watcher restored") ||
    line.includes("Scanning folder:")),
  "unchanged parent events must not rewatch or rescan the library");

  // Unrelated parent notifications must not suppress real child changes.
  fs.rmSync(path.join(library, "example"), { recursive: true });
  install(library, "2.0");
  const deadline = Date.now() + 10000;
  while (changes.at(-1).packages.get("example")?.version !== "2.0") {
    assert.ok(Date.now() < deadline, "package updates remain observable");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await settle();
  assert.equal(inventory.watchers.get(library), childWatcher,
    "normal package updates do not re-arm the directory watcher");
});

test("a symlinked library retargets its watcher while ignoring unchanged parent events", async t => {
  const { root, inventory, changes, install, settle } = fixture(t);
  const first = path.join(root, "original-target");
  const second = path.join(root, "replacement-target");
  const library = path.join(root, "active-library");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  install(first);
  install(second, "2.0");
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(first, library, type);
  inventory.setLibraryPaths([library]);
  await settle();
  assert.equal(changes.at(-1).packages.get("example")?.version, "1.0");
  const previous = inventory.watchers.get(library);

  fs.unlinkSync(library);
  fs.symlinkSync(second, library, type);
  const deadline = Date.now() + 10000;
  while (changes.at(-1).packages.get("example")?.version !== "2.0") {
    assert.ok(Date.now() < deadline, "symlink target replacement must be detected");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await settle();
  const restored = inventory.watchers.get(library);
  assert.ok(restored);
  assert.notEqual(restored, previous);

  // Duplicate / filename-less parent notifications must retain the new watch.
  const parent = inventory.parentWatchers.get(library);
  parent.emit("change", "rename", undefined);
  parent.emit("change", "rename", path.basename(library));
  await settle();
  assert.equal(inventory.watchers.get(library), restored);

  fs.rmSync(path.join(second, "example"), { recursive: true });
  install(second, "3.0");
  const nextDeadline = Date.now() + 10000;
  while (changes.at(-1).packages.get("example")?.version !== "3.0") {
    assert.ok(Date.now() < nextDeadline, "new symlink target must still receive package events");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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

test("package locks preserve only their own installation, including on initial discovery", async t => {
  const { libraries: [library], inventory, changes, install, settle } = fixture(t);
  const example = install(library);
  fs.mkdirSync(path.join(library, "00LOCK-other"));
  inventory.setLibraryPaths([library]);
  await settle();
  assert.ok(changes.at(-1).packages.has("example"), "unrelated package locks must not hide installed packages");
  fs.rmSync(example, { recursive: true });
  await settle(() => !changes.at(-1).packages.has("example"));
  install(library, "2.0");
  await settle(() => changes.at(-1).packages.get("example")?.version === "2.0");
  fs.mkdirSync(path.join(library, "00LOCK"));
  const lock = path.join(library, "00LOCK", "example");
  fs.renameSync(example, lock);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(changes.at(-1).packages.get("example").version, "2.0", "generic lock backups retain the previous copy");
  install(library, "3.0");
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(changes.at(-1).packages.get("example").version, "2.0");
  fs.rmSync(path.join(library, "00LOCK"), { recursive: true });
  await settle(() => changes.at(-1).packages.get("example")?.version === "3.0");
});

test("linked targets refresh across cache removal, replacement, locks and recreation", async t => {
  const { root, libraries: [library], inventory, changes, install, settle } = fixture(t);
  const cache = path.join(root, "external-cache");
  fs.mkdirSync(cache);
  const target = install(cache);
  fs.symlinkSync(target, path.join(library, "example"), process.platform === "win32" ? "junction" : "dir");
  inventory.setLibraryPaths([library]);
  await settle();
  assert.equal(changes.at(-1).packages.get("example").version, "1.0");
  fs.rmSync(target, { recursive: true });
  await settle(() => !changes.at(-1).packages.has("example"), "a dangling package link must remove stale metadata");
  install(cache, "2.0");
  await settle(() => changes.at(-1).packages.get("example")?.version === "2.0");
  fs.mkdirSync(path.join(cache, "00LOCK-example"));
  fs.rmSync(target, { recursive: true });
  install(cache, "3.0");
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal(changes.at(-1).packages.get("example").version, "2.0", "cache installations remain protected by their own lock");
  fs.rmdirSync(path.join(cache, "00LOCK-example"));
  await settle(() => changes.at(-1).packages.get("example")?.version === "3.0");
  inventory.setLibraryPaths([]);
  await settle(() => changes.at(-1).libraries.length === 0);
  assert.equal(inventory.linkedWatches.size, 0, "removed libraries release linked target subscriptions");
  inventory.setLibraryPaths([library]);
  await settle(() => changes.at(-1).packages.has("example"));
  inventory.dispose();
  assert.equal(inventory.linkedWatches.size, 0, "disposal releases all linked target subscriptions");
});

for (const lockName of ["00LOCK-example", "00LOCK"]) {
  for (const initiallyMissing of [false, true]) {
    test(`chained links retain ${lockName} protection with an ${initiallyMissing ? "initially absent" : "existing"} target`, async t => {
      const { root, libraries: [library], inventory, changes, install, settle } = fixture(t);
      const alias = path.join(root, "alias"), cache = path.join(root, "cache");
      fs.mkdirSync(alias); fs.mkdirSync(cache);
      const target = install(cache), intermediate = path.join(alias, "example");
      const link = (destination, file) => fs.symlinkSync(process.platform === "win32"
        ? destination : path.relative(path.dirname(file), destination), file,
      process.platform === "win32" ? "junction" : "dir");
      link(target, intermediate);
      link(intermediate, path.join(library, "example"));
      const lock = path.join(cache, lockName);
      const holdInstallation = () => {
        fs.mkdirSync(lock);
        fs.renameSync(target, path.join(lock, "example"));
      };
      if (initiallyMissing) holdInstallation();
      inventory.setLibraryPaths([library]);
      await settle();
      if (!initiallyMissing) {
        holdInstallation();
        inventory.dirtyLibraries.add(library);
        await inventory.refresh();
        await settle();
      }
      const current = changes.at(-1);
      assert.equal(current.packages.has("example"), !initiallyMissing);
      const deferredPaths = current.libraries[0].deferred.get("example") ?? [];
      assert.ok(deferredPaths.some(file =>
        path.basename(file) === path.basename(target) &&
        sameExistingDirectory(path.join(path.dirname(file), lockName), lock)),
        `the missing final target must keep its cache lock and watch location: ${JSON.stringify(deferredPaths)}`);
      const count = changes.length;
      install(cache, "2.0");
      await new Promise(resolve => setTimeout(resolve, 1800));
      assert.equal(changes.length, count, "a replacement remains deferred while the external lock is held");
      fs.rmSync(lock, { recursive: true });
      await settle(() => changes.at(-1).packages.get("example")?.version === "2.0",
        "the cache parent watch must detect unlock without touching either link");
      assert.equal(changes.at(-1).libraries[0].deferred.size, 0);
    });
  }
}

test("a versioned cache target honors its package's named installation lock", async t => {
  const { root, libraries: [library], inventory, changes, install, settle } = fixture(t);
  const cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  const original = install(cache);
  const target = path.join(cache, "release-1");
  fs.renameSync(original, target);
  fs.symlinkSync(target, path.join(library, "example"),
    process.platform === "win32" ? "junction" : "dir");
  inventory.setLibraryPaths([library]);
  await settle();
  const before = changes.at(-1).packages.get("example").identity;

  const lock = path.join(cache, "00LOCK-example");
  fs.mkdirSync(lock);
  fs.rmSync(target, { recursive: true });
  fs.renameSync(install(cache, "2.0"), target);
  inventory.dirtyLibraries.add(library);
  await inventory.refresh();
  await settle();
  assert.equal(changes.at(-1).packages.get("example").identity, before,
    "the logical package lock must defer an updated versioned target");
  fs.rmdirSync(lock);
  inventory.dirtyLibraries.add(library);
  await inventory.refresh();
  await settle(() => changes.at(-1).packages.get("example")?.version === "2.0",
    "unlocking a named package lock must publish the replacement");
});

// Binary and non-staged installs can copy a new package directly into the
// library while 00LOCK is still empty: it must retain its library-wide scope.
test("a whole-library lock protects new installations before a backup or staging directory exists", async t => {
  const { libraries: [library], inventory, changes, install, settle } = fixture(t);
  inventory.setLibraryPaths([library]);
  await settle();
  fs.mkdirSync(path.join(library, "00LOCK"));
  install(library);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.ok(!changes.at(-1).packages.has("example"));
  fs.rmdirSync(path.join(library, "00LOCK"));
  await settle(() => changes.at(-1).packages.has("example"));
});

test("relative package links resolve parent traversal through directory aliases", {
  skip: process.platform === "win32" && "junction creation normalizes its destination",
}, async t => {
  const { root, libraries: [library], inventory, changes, install, settle } = fixture(t);
  const cache = path.join(root, "cache");
  fs.mkdirSync(path.join(cache, "nested"), { recursive: true });
  fs.symlinkSync(path.join(cache, "nested"), path.join(library, "alias"), "dir");
  // The operating system resolves alias before applying '..'.
  const target = install(cache);
  fs.symlinkSync("alias/../example", path.join(library, "example"), "dir");
  const lock = path.join(cache, "00LOCK-example");
  fs.mkdirSync(lock);
  fs.renameSync(target, path.join(lock, "example"));
  inventory.setLibraryPaths([library]);
  await settle();
  assert.ok(changes.at(-1).libraries[0].deferred.get("example")?.includes(
    path.join(fs.realpathSync(cache), "example")));
});

test("cyclic package links fail resolution promptly and recover when repaired", { timeout: 10000 }, async t => {
  const { root, libraries: [library], inventory, changes, install, settle } = fixture(t);
  const alias = path.join(root, "alias"), cache = path.join(root, "cache");
  fs.mkdirSync(alias); fs.mkdirSync(cache);
  const link = path.join(library, "example"), intermediate = path.join(alias, "example");
  const kind = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(intermediate, link, kind);
  fs.symlinkSync(link, intermediate, kind);
  await assert.rejects(inventory.resolvePackageLink(link, new Set()), { code: "ELOOP" });
  fs.unlinkSync(intermediate);
  fs.symlinkSync(install(cache), intermediate, kind);
  inventory.setLibraryPaths([library]);
  await settle();
  assert.equal(changes.at(-1).packages.get("example").version, "1.0");
});

for (const lockName of ["00LOCK-example", "00LOCK"]) {
  test(`${lockName} retains the resolved path of an initially deferred package link while it is absent`, async t => {
    const { root, libraries: [library], inventory, changes, install, settle } = fixture(t);
    const cache = path.join(root, "cache");
    fs.mkdirSync(cache);
    const target = path.join(cache, "versioned-installation");
    fs.renameSync(install(cache), target);
    const link = path.join(library, "example"), lock = path.join(library, lockName);
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    fs.mkdirSync(lock);
    inventory.setLibraryPaths([library]);
    await settle();
    assert.equal(changes.length, 1);
    fs.unlinkSync(link);
    inventory.dirtyLibraries.add(library);
    await inventory.refresh();
    await settle();
    assert.equal(changes.length, 1, "a missing link must retain the locked namespace's resolved path");
    fs.rmdirSync(lock);
    await settle(() => changes.length === 2);
    assert.deepEqual(changes[1].changed, []);
  });

  test(`releasing ${lockName} republishes initially deferred removals and retries failed reconciliation`, async t => {
    const { libraries: [library], inventory, changes, install, settle } = fixture(t);
    const directory = install(library), lock = path.join(library, lockName);
    fs.mkdirSync(lock);
    inventory.setLibraryPaths([library]);
    await settle();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].packages.size, 0);
    assert.ok(changes[0].libraries[0].deferred.get("example").includes(directory));
    fs.rmSync(directory, { recursive: true });
    inventory.dirtyLibraries.add(library);
    await inventory.refresh();
    await settle();
    assert.equal(changes.length, 1, "retain the initial deferral while the lock is held");

    let attempts = 0;
    inventory.onChange = async change => {
      attempts++;
      if (attempts === 1) throw new Error("Temporary server failure");
      changes.push(change);
    };
    fs.rmdirSync(lock);
    // A filename-less/change event must also rescan a deferred empty inventory.
    inventory.unconfirmedLibraries.add(library);
    await inventory.refresh();
    await settle(() => changes.length === 2);
    assert.equal(attempts, 2);
    assert.deepEqual(changes[1].changed, [], "package identities remain unchanged");
    assert.equal(changes[1].libraries[0].deferred.size, 0, "successful reconciliation publishes the release");
    assert.equal(changes[1].packages.size, 0);
  });
}
