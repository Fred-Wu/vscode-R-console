const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

function fixture(t, notificationDelay = 0, overrides = {}) {
  // Use the same canonical representation as PackageInventory.rootFor().
  // On Windows realpathSync can yield RUNNER~1 while .native returns the
  // long path; comparing those as strings misidentifies the same directory.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-inventory-")));
  const libraries = ["first", "second"].map(name => path.join(root, name));
  libraries.forEach(library => fs.mkdirSync(library));
  const changes = [], logs = [];
  const notifications = new Set();
  const watches = [];
  const Inventory = loadSource("src/Language/packageInventory.ts", { fs: {
    ...fs,
    ...overrides,
    watch: (file, options, callback) => {
      watches.push({ file, options });
      return fs.watch(file, options, (...args) => {
        const timer = setTimeout(() => { notifications.delete(timer); callback(...args); }, notificationDelay);
        notifications.add(timer);
      });
    },
  } }).PackageInventory;
  const inventory = new Inventory(async change => changes.push(change), line => logs.push(line));
  t.after(() => {
    inventory.dispose();
    for (const timer of notifications) clearTimeout(timer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const install = (library, version = "1.0", name = "example") => {
    const directory = path.join(library, name);
    fs.mkdirSync(path.join(directory, "Meta"), { recursive: true });
    fs.writeFileSync(path.join(directory, "DESCRIPTION"), `Package: ${name}\nVersion: ${version}\n`);
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
  return { root, libraries, inventory, changes, logs, install, settle, waitForLog, watches };
}

/** Windows cannot rename a directory while fs.watch holds its handle.
 * Release only the OS handles; keep the inventory's logical watcher state so
 * a synthetic rename notification still exercises replacement and re-arming. */
function releaseWindowsWatcherHandles(watcher) {
  if (process.platform !== "win32") return;
  for (const { watcher: nativeWatcher } of watcher.directories.values()) nativeWatcher.close();
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
  assert.deepEqual(changes.at(-1).changedInstallations, [],
    "selecting an already observed copy does not replace that installation");
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
  const secondWatcher = inventory.watchers.get(second);
  assert.ok(firstWatcher && secondWatcher);

  logs.length = 0;
  inventory.setLibraryPaths([second, first]);
  await settle();
  assert.equal(inventory.watchers.get(first), firstWatcher);
  assert.equal(inventory.watchers.get(second), secondWatcher);
  assert.ok(!logs.some(line => line.includes("Scanning folder:")),
    "changing search precedence must reuse existing package inventories");
  assert.equal(changes.at(-1).packages.get("example").path, path.join(second, "example"));

  const third = path.join(root, "third");
  fs.mkdirSync(third);
  logs.length = 0;
  inventory.setLibraryPaths([first, third]);
  await settle();
  assert.equal(inventory.watchers.get(first), firstWatcher);
  assert.equal(inventory.watchers.has(second), false);
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
    assert.ok(changes.at(-1).libraries[0].deferred.get("example").includes(path.join(library, "example")));
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
  assert.deepEqual(changes.at(-1).changedInstallations, ["example"],
    "replacing files at the selected path must still invalidate a loaded namespace");
  assert.ok(logs.some(line => line.includes("Updated: example 1.0 -> 1.0")));
});

test("an ordinary package replaced by an renv-style link is tracked without watching the target", async t => {
  const { root, libraries: [library], inventory, changes, install, settle } = fixture(t);
  const directory = install(library);
  const target = install(path.join(root, "cache"), "2.0");
  inventory.setLibraryPaths([library]);
  await settle();
  fs.rmSync(directory, { recursive: true });
  fs.symlinkSync(target, directory, process.platform === "win32" ? "junction" : "dir");
  await settle(() => changes.at(-1).packages.get("example")?.linked === true);
  assert.equal(changes.at(-1).packages.get("example").target, directory);
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.deepEqual(changes.at(-1).unmonitored, []);
  fs.unlinkSync(directory);
  install(library, "3.0");
  await settle(() => changes.at(-1).packages.get("example")?.version === "3.0");
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.deepEqual(changes.at(-1).unmonitored, []);
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

test("a tracked higher-priority link selects its own entry rather than a lower-priority package", async t => {
  const { root, libraries: [first, second], inventory, changes, install, settle } = fixture(t);
  const target = install(path.join(root, "cache"));
  const fallback = install(second, "2.0");
  fs.symlinkSync(target, path.join(first, "example"), process.platform === "win32" ? "junction" : "dir");
  inventory.setLibraryPaths([first, second]);
  await settle();
  assert.equal(changes.at(-1).packages.get("example").linked, true);
  assert.equal(changes.at(-1).packages.get("example").path, path.join(first, "example"));
  assert.deepEqual(changes.at(-1).unmonitored, []);
  assert.equal(changes.at(-1).libraries[1].packages.get("example").path, fallback);
  inventory.setLibraryPaths([second, first]);
  await settle(() => changes.at(-1).packages.get("example")?.path === fallback);
  assert.deepEqual(changes.at(-1).unmonitored, []);
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
  assert.ok(logs.some(line => line.includes("Monitoring temporarily unavailable:") &&
    line.includes("Temporary read failure")), "read errors retain the last verified inventory");
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
    watcher.emit("change", "change", path.join("example", "DESCRIPTION"));
    watcher.emit("change", "rename", path.join("example", "Meta"));
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

test("configured library aliases remain pinned when their links are retargeted", async t => {
  const { root, inventory, changes, install, settle, watches } = fixture(t);
  const first = path.join(root, "original-target"), second = path.join(root, "replacement-target");
  const library = path.join(root, "active-library");
  install(first);
  install(second, "2.0");
  const kind = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(first, library, kind);
  inventory.setLibraryPaths([library]);
  await settle();
  assert.equal(changes.at(-1).packages.get("example").version, "1.0");
  const watcher = inventory.watchers.get(library), count = changes.length;
  assert.deepEqual(watches.map(watch => watch.file).sort(), [first, path.join(first, "example")].sort());
  assert.ok(watches.every(watch => watch.options.recursive === false));
  fs.unlinkSync(library);
  fs.symlinkSync(second, library, kind);
  fs.rmSync(path.join(second, "example"), { recursive: true });
  install(second, "3.0");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(changes.length, count);
  assert.equal(inventory.watchers.get(library), watcher);
  // An ambiguous event on the original root must also keep the pinned location.
  watcher.emit("change", "change", undefined);
  await settle();
  assert.equal(changes.at(-1).packages.get("example").version, "1.0");
  assert.equal(changes.at(-1).packages.get("example").target, path.join(first, "example"));
  assert.equal(watches.length, 2);
  inventory.setLibraryPaths([]);
  await settle(() => changes.at(-1).libraries.length === 0);
  inventory.setLibraryPaths([library]);
  await settle(() => changes.at(-1).packages.get("example")?.version === "3.0");
  assert.ok(watches.some(watch => watch.file === second), "explicit reconfiguration can select a new root");
});

for (const replaceAncestor of [false, true]) {
  test(`a pinned library ${replaceAncestor ? "ancestor" : "root"} replaced by a link suspends monitoring`, async t => {
    const { root, inventory, changes, install, settle, watches } = fixture(t);
    const parent = path.join(root, "configured"), library = path.join(parent, "library");
    const external = path.join(root, "external");
    install(library);
    install(replaceAncestor ? path.join(external, "library") : external, "2.0");
    inventory.setLibraryPaths([library]);
    await settle();
    const watcher = inventory.watchers.get(library);
    const replaced = replaceAncestor ? parent : library;
    releaseWindowsWatcherHandles(watcher);
    fs.renameSync(replaced, replaced + "-original");
    fs.symlinkSync(external, replaced, process.platform === "win32" ? "junction" : "dir");
    // Platforms may report a rename differently; deliver the root event too.
    watcher.emit("change", "rename", path.basename(library));
    await settle(() => changes.at(-1).unmonitoredRoots.includes(library));
    assert.equal(changes.at(-1).packages.size, 1, "suspension retains verified metadata");
    assert.deepEqual(changes.at(-1).changed, []);
    assert.equal(changes.at(-1).unmonitored.length, 0);
    assert.equal(inventory.watchers.size, 0);
    assert.equal(inventory.retryTimer, undefined, "a changed link is not retried automatically");
    assert.equal(watches.length, 2, "no watch is opened on the replacement target");
  });
}

test("replacing an existing library directory re-arms its watcher without an error event", async t => {
  const { libraries: [library], inventory, changes, install, settle } = fixture(t);
  install(library);
  inventory.setLibraryPaths([library]);
  await settle();
  const previous = inventory.watchers.get(library);
  const moved = library + "-old";
  releaseWindowsWatcherHandles(previous);
  fs.renameSync(library, moved);
  fs.mkdirSync(library);
  install(library, "2.0");
  // Windows requires closing the old directory watch to permit the rename.
  // Deliver the event which the old OS watcher would otherwise have raised.
  if (process.platform === "win32") previous.emit("change", "rename", undefined);
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

test("linked package entries are tracked without resolving, reading, watching or polling targets", async t => {
  const accesses = [];
  let library;
  const promises = { ...fs.promises };
  for (const method of ["realpath", "readlink", "stat", "access", "readFile", "open", "readdir"]) {
    promises[method] = async (file, ...args) => {
      accesses.push([method, String(file)]);
      return fs.promises[method](file, ...args);
    };
  }
  const context = fixture(t, 0, {
    promises,
    watchFile() { assert.fail("package monitoring must not create stat pollers"); },
  });
  ({ libraries: [library] } = context);
  const { root, inventory, changes, install, settle, watches } = context;
  const cache = path.join(root, "cache"), target = install(cache);
  const link = path.join(library, "example");
  const kind = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(target, link, kind);
  fs.symlinkSync(path.join(cache, "missing"), path.join(library, "missing"), kind);
  fs.symlinkSync(path.join(library, "cycle"), path.join(library, "cycle"), kind);
  inventory.setLibraryPaths([library]);
  await settle();
  assert.deepEqual([...changes.at(-1).packages.keys()].sort(), ["cycle", "example", "missing"]);
  assert.ok([...changes.at(-1).packages.values()].every(item => item.linked),
    "even dangling or cyclic symlinks are only identified as directory entries");
  assert.deepEqual(changes.at(-1).unmonitored, []);
  const count = changes.length;
  fs.rmSync(target, { recursive: true });
  install(cache, "2.0");
  fs.mkdirSync(path.join(cache, "00LOCK-example"));
  await new Promise(resolve => setTimeout(resolve, 1400));
  await settle();
  assert.equal(changes.length, count, "external cache mutations are not inventory events");
  assert.ok(accesses.length > 0);
  assert.ok(accesses.every(([method, file]) => method === "readdir" && file === library),
    JSON.stringify(accesses));
  assert.deepEqual([...inventory.watchers.keys()], [library]);
  assert.deepEqual(watches, [{ file: library, options: { persistent: false, recursive: false } }]);
  assert.equal(inventory.timer, undefined);
  assert.equal(inventory.retryTimer, undefined);
  install(library, "1.0", "ordinary");
  await settle(() => changes.at(-1).packages.has("ordinary"));
  assert.deepEqual(changes.at(-1).changed, ["ordinary"]);
});

for (const component of ["Meta", "Meta/package.rds", "DESCRIPTION"]) {
  test(`linked ${component} is excluded without reading its destination`, async t => {
    const opened = [];
    const { root, libraries: [library], inventory, changes, install, settle } = fixture(t, 0, {
      promises: { ...fs.promises, open: async (file, ...args) => {
        opened.push(file);
        return fs.promises.open(file, ...args);
      } },
    });
    const directory = install(library);
    const external = install(path.join(root, "external"));
    const file = path.join(directory, component);
    fs.rmSync(file, { recursive: true });
    if (process.platform === "win32" && component !== "Meta") {
      // File symlinks need Developer Mode / elevation on Windows.
      try { fs.symlinkSync(path.join(external, component), file, "file"); }
      catch (error) { if (error.code === "EPERM") { t.skip("file symlink permission unavailable"); return; } throw error; }
    } else {
      fs.symlinkSync(path.join(external, component), file,
        component === "Meta" ? process.platform === "win32" ? "junction" : "dir" : "file");
    }
    inventory.setLibraryPaths([library]);
    await settle();
    assert.equal(changes.at(-1).packages.size, 0);
    assert.deepEqual(changes.at(-1).unmonitored, ["example"]);
    assert.deepEqual(opened, [], "linked metadata is never opened");
  });
}

test("a package changed to a link after enumeration is recorded without following it", async t => {
  let link, target, swapped = false;
  const { root, libraries: [library], inventory, changes, install, settle } = fixture(t, 0, {
    promises: { ...fs.promises, readdir: async (file, ...args) => {
      const entries = await fs.promises.readdir(file, ...args);
      if (link && file === path.dirname(link) && !swapped) {
        swapped = true;
        fs.rmSync(link, { recursive: true });
        fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      }
      return entries;
    } },
  });
  link = install(library);
  target = install(path.join(root, "cache"), "2.0");
  inventory.setLibraryPaths([library]);
  await settle();
  assert.equal(changes.at(-1).packages.get("example").linked, true);
  assert.equal(changes.at(-1).packages.get("example").target, link);
  assert.deepEqual(changes.at(-1).unmonitored, []);
});

test("linked installation locks do not defer ordinary package updates", async t => {
  const { root, libraries: [library], inventory, changes, install, settle } = fixture(t);
  const cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  for (const lock of ["00LOCK", "00LOCK-example"]) {
    fs.symlinkSync(cache, path.join(library, lock), process.platform === "win32" ? "junction" : "dir");
  }
  install(library);
  inventory.setLibraryPaths([library]);
  await settle();
  assert.equal(changes.at(-1).packages.get("example").version, "1.0");
  assert.equal(changes.at(-1).libraries[0].deferred.size, 0);
  fs.rmSync(path.join(library, "example"), { recursive: true });
  install(library, "2.0");
  await settle(() => changes.at(-1).packages.get("example")?.version === "2.0");
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

for (const lockName of ["00LOCK-example", "00LOCK"]) {
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

test("a DESCRIPTION replaced by a symlink before open is not read", {
  skip: process.platform === "win32" || !fs.constants.O_NOFOLLOW,
}, async t => {
  let description, target, swapped = false;
  const { root, libraries: [library], inventory, changes, install, settle } = fixture(t, 0, {
    promises: { ...fs.promises, open: async (file, ...args) => {
      if (file === description && !swapped) {
        swapped = true;
        fs.unlinkSync(file);
        fs.symlinkSync(target, file, "file");
      }
      return fs.promises.open(file, ...args);
    } },
  });
  description = path.join(install(library), "DESCRIPTION");
  target = path.join(install(path.join(root, "external"), "2.0"), "DESCRIPTION");
  inventory.setLibraryPaths([library]);
  await settle();
  assert.ok(swapped);
  assert.equal(changes.at(-1).packages.size, 0);
  assert.deepEqual(changes.at(-1).unmonitored, ["example"]);
});

test("whole-library locks inspect ordinary backups and skip linked staging directories", async t => {
  const reads = [];
  const { root, libraries: [library], inventory, changes, install, settle } = fixture(t, 0, {
    promises: { ...fs.promises, readdir: async (file, ...args) => {
      reads.push(file);
      return fs.promises.readdir(file, ...args);
    } },
  });
  const lock = path.join(library, "00LOCK");
  fs.mkdirSync(lock);
  install(lock);
  const external = path.join(root, "external");
  install(external, "1.0", "outside");
  const staging = path.join(lock, "00new");
  fs.symlinkSync(external, staging, process.platform === "win32" ? "junction" : "dir");
  inventory.setLibraryPaths([library]);
  await settle();
  assert.ok(changes.at(-1).libraries[0].deferred.has("example"));
  assert.ok(!changes.at(-1).libraries[0].deferred.has("outside"));
  assert.ok(!reads.includes(staging) && !reads.includes(external));
});


test("monitoring watches only the library and immediate package directories", async t => {
  const { root, libraries: [library], inventory, changes, install, settle, watches } = fixture(t);
  const directory = install(library);
  const nested = path.join(directory, "R", "nested");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "code.R"), "value <- 1");
  const external = install(path.join(root, "external"));
  fs.symlinkSync(external, path.join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
  inventory.setLibraryPaths([library]);
  await settle();
  assert.deepEqual(watches.map(watch => watch.file).sort(), [library, directory].sort());
  assert.ok(watches.every(watch => watch.options.recursive === false));

  // Immediate package-directory notifications refresh the installation.
  fs.writeFileSync(path.join(directory, "DESCRIPTION"), "Package: example\nVersion: 2.0\n");
  await settle(() => changes.at(-1).packages.get("example")?.version === "2.0");
  const count = changes.length;
  fs.writeFileSync(path.join(nested, "code.R"), "value <- 2");
  fs.writeFileSync(path.join(external, "DESCRIPTION"), "Package: example\nVersion: 9.0\n");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(changes.length, count, "deep files and linked targets are outside monitoring scope");
  assert.deepEqual(watches.map(watch => watch.file).sort(), [library, directory].sort());

  const added = install(library, "1.0", "added");
  await settle(() => changes.at(-1).packages.has("added"));
  assert.ok(watches.some(watch => watch.file === added));
  assert.ok(watches.every(watch => watch.file === library || path.dirname(watch.file) === library));
});

test("an interrupted scan cannot resolve a removed configured alias again", async t => {
  const resolutions = [];
  const realpathSync = Object.assign((...args) => fs.realpathSync(...args), {
    native: (file, ...args) => { resolutions.push(file); return fs.realpathSync.native(file, ...args); },
  });
  const { root, inventory, changes, install, settle } = fixture(t, 0, { realpathSync });
  const original = path.join(root, "original"), replacement = path.join(root, "replacement");
  install(original);
  install(replacement, "2.0");
  const alias = path.join(root, "configured");
  const kind = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(original, alias, kind);
  let entered, release;
  const begun = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const locks = inventory.installationLocks.bind(inventory);
  inventory.installationLocks = async (...args) => { entered(); await blocked; return locks(...args); };
  inventory.setLibraryPaths([alias]);
  await begun;
  fs.unlinkSync(alias);
  fs.symlinkSync(replacement, alias, kind);
  inventory.setLibraryPaths([]);
  release();
  await settle(() => changes.at(-1)?.libraries.length === 0);
  assert.deepEqual(resolutions, [alias], "the stale scan cannot follow the retargeted alias");
});

test("renv-style link creation, retargeting and removal update only the pinned library", async t => {
  const { root, libraries: [library], inventory, changes, install, settle, watches } = fixture(t);
  const cache1 = install(path.join(root, "cache-one"));
  const cache2 = install(path.join(root, "cache-two"), "2.0");
  const link = path.join(library, "example");
  const kind = process.platform === "win32" ? "junction" : "dir";
  inventory.setLibraryPaths([library]);
  await settle();
  fs.symlinkSync(cache1, link, kind);
  // Exercise the same root notification path on every OS without relying on
  // the scheduler delivering a native fs.watch event during this assertion.
  inventory.watchers.get(library).emit("change", "rename", "example");
  await settle(() => changes.at(-1).packages.get("example")?.linked === true);
  const first = changes.at(-1).packages.get("example");
  assert.equal(first.path, link);
  assert.equal(first.target, link, "linked entries record their path, not the cache target");
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.deepEqual(watches.map(item => item.file), [library], "do not create package-target watchers");

  fs.unlinkSync(link);
  fs.symlinkSync(cache2, link, kind);
  // Exercise the same root notification path on every OS without relying on
  // the scheduler delivering a native fs.watch event during this assertion.
  inventory.watchers.get(library).emit("change", "rename", "example");
  await settle(() => changes.at(-1).packages.get("example")?.identity !== first.identity);
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  const count = changes.length;
  fs.writeFileSync(path.join(cache2, "DESCRIPTION"), "Package: example\nVersion: 3.0\n");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(changes.length, count, "external cache content changes do not expand monitoring");

  fs.unlinkSync(link);
  // Exercise the same root notification path on every OS without relying on
  // the scheduler delivering a native fs.watch event during this assertion.
  inventory.watchers.get(library).emit("change", "rename", "example");
  await settle(() => !changes.at(-1).packages.has("example"));
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.deepEqual(watches.map(item => item.file), [library]);
});

test("temporary network library failures preserve verified package state until recovery", async t => {
  let unavailable = false, library;
  const promises = { ...fs.promises, readdir: async (file, ...args) => {
    if (unavailable && file === library) {
      throw Object.assign(new Error("network share unavailable"), { code: "EIO" });
    }
    return fs.promises.readdir(file, ...args);
  } };
  const fixtureData = fixture(t, 0, { promises });
  ({ libraries: [library] } = fixtureData);
  const { inventory, changes, logs, install, settle } = fixtureData;
  install(library);
  inventory.setLibraryPaths([library]);
  await settle();
  unavailable = true;
  inventory.dirtyLibraries.add(library);
  await inventory.refresh();
  const deadline = Date.now() + 5000;
  while (!changes.at(-1).libraries[0].unavailable) {
    assert.ok(Date.now() < deadline, "offline status must be reported");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(changes.at(-1).packages.get("example").version, "1.0");
  assert.deepEqual(changes.at(-1).changed, [], "temporary disconnect does not remove installed packages");
  assert.ok(changes.at(-1).unmonitoredRoots.includes(library));
  assert.ok(logs.some(line => line.includes("Monitoring temporarily unavailable:") &&
    line.includes("network share unavailable")));

  unavailable = false;
  fs.rmSync(path.join(library, "example"), { recursive: true });
  install(library, "2.0");
  inventory.dirtyLibraries.add(library);
  await inventory.refresh();
  await settle(() => changes.at(-1).packages.get("example")?.version === "2.0");
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.ok(logs.some(line => line.includes("Monitoring restored:")));
});

test("ordinary package watcher fanout remains bounded without recursive or external watching", async t => {
  const { libraries: [library], inventory, changes, logs, install, settle, watches } = fixture(t);
  for (let i = 0; i < 134; i++) install(library, "1.0", "pkg" + i);
  inventory.setLibraryPaths([library]);
  await settle();
  assert.equal(changes.at(-1).packages.size, 134, "monitoring limits must not hide installed packages");
  assert.ok(watches.length <= 129, "one library watch plus at most 128 shallow package watches");
  assert.ok(watches.every(({ file, options }) =>
    (file === library || path.dirname(file) === library) && options.recursive === false));
  assert.ok(logs.some(line => line.includes("Limited package monitoring:") &&
    line.includes("package watcher budget")));
});

test("an unpinnable configured root fails closed until explicitly reconfigured", async t => {
  let library, resolutions = 0;
  const realpathSync = Object.assign((...args) => fs.realpathSync(...args), {
    native: (file, ...args) => {
      if (file === library) {
        resolutions++;
        throw Object.assign(new Error("untrusted root unavailable"), { code: "EACCES" });
      }
      return fs.realpathSync.native(file, ...args);
    },
  });
  const context = fixture(t, 0, { realpathSync });
  ({ libraries: [library] } = context);
  const { inventory, changes, logs, settle, watches } = context;
  inventory.setLibraryPaths([library]);
  await settle();
  assert.ok(changes.at(-1).libraries[0].suspended);
  assert.equal(resolutions, 1);
  assert.deepEqual(watches, [], "an unpinnable root must never be watched");
  assert.ok(logs.some(line => line.includes("unable to pin the configured root")));
  await inventory.refresh();
  assert.equal(resolutions, 1, "refresh cannot re-resolve an untrusted configured alias");

  inventory.setLibraryPaths([]);
  await settle(() => changes.at(-1).libraries.length === 0);
  inventory.setLibraryPaths([library]);
  await settle(() => changes.at(-1)?.libraries.some(row => row.path === library && row.suspended) === true);
  assert.equal(resolutions, 2, "only explicit reconfiguration permits a new pin attempt");
});

test("oversized configured libraries are suspended without recurrent network scans", async t => {
  let library, listings = 0;
  const oversized = Array.from({ length: 4097 }, (_, i) => ({
    name: "pkg" + i, isDirectory: () => true, isSymbolicLink: () => false,
  }));
  const promises = { ...fs.promises, readdir: async (file, ...args) => {
    if (file === library) { listings++; return oversized; }
    return fs.promises.readdir(file, ...args);
  } };
  const f = fixture(t, 0, { promises });
  ({ libraries: [library] } = f);
  const { inventory, changes, logs, settle } = f;
  inventory.setLibraryPaths([library]);
  await settle();
  assert.ok(changes.at(-1).libraries[0].suspended);
  assert.equal(inventory.watchers.size, 0, "all watchers close on a too-broad root");
  assert.equal(inventory.retryTimer, undefined, "do not repeatedly enumerate large network roots");
  assert.ok(logs.some(line => line.includes("exceeds 4096 entries")));
  await inventory.refresh();
  assert.equal(listings, 1, "suspended roots are not rescanned before reconfiguration");
});
