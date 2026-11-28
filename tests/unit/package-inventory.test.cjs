const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

// Assert the observed metadata of the actual installation, not a parsed version.
// Include its physical path so that precedence/alias regressions cannot pass.
function matchesDescription(item, directory) {
  if (!item || item.linked || item.target !== directory) return false;
  let stat;
  try { stat = fs.lstatSync(path.join(directory, "DESCRIPTION")); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
  const expected = [stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size];
  return JSON.stringify(JSON.parse(item.identity)[3]) === JSON.stringify(expected);
}

function fixture(t, notificationDelay = 0, overrides = {}) {
  // Use the same canonical representation as PackageInventory.rootFor().
  // On Windows realpathSync can yield RUNNER~1 while .native returns the
  // long path; comparing those as strings misidentifies the same directory.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-inventory-")));
  const libraries = ["first", "second"].map(name => path.join(root, name));
  libraries.forEach(library => fs.mkdirSync(library));
  const changes = [], logs = [], reviews = [];
  const notifications = new Set();
  const watches = [], entryWatches = [];
  const Inventory = loadSource("src/Language/packageInventory.ts", { fs: {
    ...fs,
    readdirSync: () => { throw new Error("Monitoring must not enumerate synchronously"); },
    ...overrides,
    watch: (file, options, callback) => {
      if (options.encoding === "utf8") {
        entryWatches.push({ file, options, trigger: (event, filename) => callback(event, filename) });
      } else {
        watches.push({ file, options });
      }
      return (overrides.watch ?? fs.watch)(file, options, (...args) => {
        const timer = setTimeout(() => { notifications.delete(timer); callback(...args); }, notificationDelay);
        notifications.add(timer);
      });
    },
  } }).PackageInventory;
  const inventory = new Inventory(async change => changes.push(change), line => logs.push(line), review => reviews.push(review));
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
      if (observed() && (inventory.disposed || (inventory.initialized && !inventory.timer && !inventory.retryTimer && !inventory.pending && [...inventory.watchers.values()].every(w => !w.timer && !w.refreshPromise && !w.refreshPending) && !inventory.dirtyLibraries.size && !inventory.unconfirmedLibraries.size))) return;
      assert.ok(Date.now() < deadline, description);
    } while (true);
  };
  // OS notifications can arrive after an idle check. Observe the effect of
  // each mutation before checking that its resulting work has settled.
  const waitForLog = message => settle(() => logs.some(line => line.includes(message)),
    `inventory must report: ${message}`);
  return { root, libraries, inventory, changes, logs, reviews, install, settle, waitForLog, watches, entryWatches };
}

/** Windows cannot rename a directory while fs.watch holds its handle.
 * Release only the OS handles; keep the inventory's logical watcher state so
 * a synthetic rename notification still exercises replacement and re-arming. */
function releaseWindowsWatcherHandles(watcher) {
  if (process.platform !== "win32") return;
  for (const { watcher: nativeWatcher } of watcher.directories.values()) nativeWatcher.close();
}
function releaseWindowsEntryWatcherHandles(inventory) {
  if (process.platform !== "win32") return;
  for (const { watcher } of inventory.entryMonitor.watches.values()) watcher.close();
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
  await waitForLog("First library copies unchanged");
  assert.deepEqual(changes.at(-1).changed, []);
  logs.length = 0;
  install(second);
  await waitForLog("Added: example -");
  assert.deepEqual(changes.at(-1).changed, []);
  assert.deepEqual(changes.at(-1).changedInstallationPaths, [path.join(second, "example")],
    "R receives later-copy changes even when the first observed entry is unchanged");

  inventory.setLibraryPaths([second, first]);
  await settle();
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.deepEqual(changes.at(-1).changedInstallationPaths, [],
    "selecting an already observed copy does not replace that installation");
  assert.equal(changes.at(-1).packages.get("example").path, path.join(second, "example"));
  logs.length = 0;
  fs.rmSync(path.join(second, "example"), { recursive: true });
  await waitForLog("Remaining library copy: example -");
  assert.equal(changes.at(-1).packages.get("example").path, path.join(first, "example"));
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
    const before = changes.at(-1).packages.get("example");
    assert.ok(matchesDescription(before, path.join(first, "example")));

    // Model a new installation identity without an extra filesystem event.
    // This proves the pending notification itself survives a search-order edit.
    const observePackage = inventory.observePackage.bind(inventory);
    inventory.observePackage = async (library, name, previous, isCurrent) => {
      const item = await observePackage(library, name, previous, isCurrent);
      return library === first && item
        ? { ...item, identity: before.identity + "-updated" }
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
    while (inventory.libraries.find(item => item.path === first)?.packages.get("example")?.identity !== before.identity + "-updated") {
      assert.ok(Date.now() < deadline, `${queue} update must survive library reordering`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await settle();
    assert.deepEqual(changes.at(-1).libraries.map(item => item.path), [second, first]);
    assert.equal(changes.at(-1).packages.get("example").identity, before.identity + "-updated");
    assert.deepEqual(changes.at(-1).changed, ["example"]);
  });
}

for (const notificationDelay of [0, 100]) {
  test(`inventory defers locked installations with ${notificationDelay}ms watcher delivery delay`, async t => {
    // Delayed delivery leaves the inventory idle across several settle polls.
    const { libraries: [library], inventory, changes, logs, install, settle, waitForLog } = fixture(t, notificationDelay);
    let lockChecks = 0;
    const checkLocks = inventory.installationLocks.bind(inventory);
    inventory.installationLocks = (...args) => { lockChecks++; return checkLocks(...args); };
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
    const before = lockChecks;
    install(library);
    await settle(() => lockChecks > before, "the locked installation is checked after its filesystem event");
    assert.ok(!logs.some(line => line.includes("Scan deferred:")), "the same lock is logged once");
    assert.equal(changes.length, count + 1);
    fs.rmdirSync(lock);
    await settle(() => changes.at(-1).packages.has("example"), "unlocking must publish the installed package");
    assert.deepEqual(changes.at(-1).changed, ["example"]);
  });
}

test("one R evaluation consolidates sequential package changes and watcher reconciliation", async t => {
  let reads = 0;
  const f = fixture(t, 0, {
    promises: { ...fs.promises, opendir: (...args) => { reads++; return fs.promises.opendir(...args); } },
  });
  const [first, second] = f.libraries;
  f.install(first, "1", "alpha");
  f.install(second, "1", "beta");
  f.install(second, "1", "removed");
  f.inventory.setLibraryPaths(f.libraries);
  await f.settle();
  const before = f.changes.length, watched = f.watches.length;
  f.logs.length = 0;
  f.inventory.setRuntimeBusy(true);
  reads = 0;
  for (const [library, name] of [[first, "alpha"], [second, "beta"], [first, "added"]]) {
    const lock = path.join(library, "00LOCK-" + name);
    fs.mkdirSync(lock);
    f.install(library, "2", name);
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.rmdirSync(lock);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  fs.rmSync(path.join(second, "removed"), { recursive: true });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(reads, 0, "evaluation queues changes without inventory scans or watch-set enumeration");
  assert.equal(f.watches.length, watched);
  assert.equal(f.changes.length, before);
  assert.deepEqual(f.logs, [], "intermediate lock/scan states stay out of the lifecycle log");
  f.inventory.setRuntimeBusy(false);
  await f.settle(() => f.changes.at(-1).packages.has("added"));
  assert.equal(f.changes.length, before + 1, "one final inventory reaches the language server");
  assert.deepEqual(f.changes.at(-1).changed.sort(), ["added", "alpha", "beta", "removed"]);
  assert.ok(matchesDescription(f.changes.at(-1).packages.get("alpha"), path.join(first, "alpha")));
  assert.ok(matchesDescription(f.changes.at(-1).packages.get("beta"), path.join(second, "beta")));
  assert.equal(f.inventory.watchers.get(first).directories.has(path.join(first, "added")), true);
  assert.ok(!f.logs.some(line => /Scanning folder|inventory changed|inventory unchanged|Search order:/.test(line)));
  assert.equal(f.logs.filter(line => line.includes("unique package names")).length, 1);
});

test("evaluation invalidates an in-flight scan and resumes its uncommitted changes", async t => {
  const f = fixture(t);
  const [library] = f.libraries;
  f.install(library);
  f.inventory.setLibraryPaths([library]);
  await f.settle();
  const before = f.changes.length;
  let entered, release, once = true;
  const begun = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  const inspect = f.inventory.observePackage.bind(f.inventory);
  f.inventory.observePackage = async (...args) => {
    if (once) { once = false; entered(); await gate; }
    return inspect(...args);
  };
  f.inventory.dirtyLibraries.add(library);
  const pending = f.inventory.refresh();
  await begun;
  f.inventory.setRuntimeBusy(true);
  f.install(library, "2");
  release();
  await pending;
  assert.equal(f.changes.length, before);
  assert.equal(f.inventory.timer, undefined);
  f.inventory.setRuntimeBusy(false);
  await f.settle(() => f.changes.length > before);
  assert.equal(f.changes.length, before + 1);
  assert.ok(matchesDescription(f.changes.at(-1).packages.get("example"), path.join(library, "example")));
});

test("evaluation batching preserves immediate pinned-library security checks", async t => {
  const f = fixture(t);
  const [library] = f.libraries;
  f.install(library);
  f.inventory.setLibraryPaths([library]);
  await f.settle();
  f.inventory.setRuntimeBusy(true);
  releaseWindowsWatcherHandles(f.inventory.watchers.get(library));
  releaseWindowsEntryWatcherHandles(f.inventory);
  fs.renameSync(library, library + "-old");
  fs.mkdirSync(library);
  assert.equal(f.inventory.validateForEvent(library), false);
  assert.equal(f.inventory.suspended.has(library), true);
  assert.equal(f.inventory.watchers.has(library), false);
  assert.equal(f.reviews.length, 1, "replacement is reported before the evaluation completes");
  f.inventory.setRuntimeBusy(false);
  await f.settle(() => f.changes.at(-1).libraries[0].suspended);
  assert.ok(f.changes.at(-1).unmonitored.includes("example"));
});

test("evaluation preserves both queued and newly requested library-order changes", async t => {
  const f = fixture(t);
  const [first, second] = f.libraries;
  f.install(first, "1");
  f.install(second, "2");
  f.inventory.setLibraryPaths([first, second]);
  await f.settle();
  for (const requestedWhileBusy of [true, false]) {
    const paths = requestedWhileBusy ? [second, first] : [first, second];
    if (requestedWhileBusy) f.inventory.setRuntimeBusy(true);
    f.inventory.setLibraryPaths(paths);
    if (!requestedWhileBusy) f.inventory.setRuntimeBusy(true);
    f.inventory.setRuntimeBusy(false);
    await f.settle(() => f.changes.at(-1).libraries[0].path === paths[0], "queued library order survives the evaluation hold");
    assert.equal(f.changes.at(-1).packages.get("example").path, path.join(paths[0], "example"));
  }
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
  assert.deepEqual(changes.at(-1).changedInstallationPaths, [path.join(library, "example")],
    "replacing files at the selected path must still invalidate a loaded namespace");
  assert.ok(logs.some(line => line.includes("Updated: example -")));
});

test("an ordinary package replaced by an renv-style link is tracked without watching the target", async t => {
  const { root, libraries: [library], inventory, changes, install, settle, logs } = fixture(t);
  const directory = install(library);
  const target = install(path.join(root, "cache"), "2.0");
  inventory.setLibraryPaths([library]);
  await settle();
  fs.rmSync(directory, { recursive: true });
  fs.symlinkSync(target, directory, process.platform === "win32" ? "junction" : "dir");
  await settle(() => changes.at(-1).packages.get("example")?.linked === true);
  assert.equal(changes.at(-1).packages.get("example").target, directory);
  assert.ok(!logs.some(line => line.includes("Linked installation observed")),
    "renv package links must not create per-package location logs");
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.deepEqual(changes.at(-1).unmonitored, []);
  fs.unlinkSync(directory);
  install(library, "3.0");
  await settle(() => matchesDescription(changes.at(-1).packages.get("example"), directory));
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
  // This test owns notification timing. Native macOS events from fixture setup
  // can otherwise rescan the second library after the initial idle check.
  const control = controlledWatches();
  const { libraries: [first, second], inventory, changes, logs, install, settle } = fixture(t, 0, { watch: control.watch });
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
  control.handles.get(first).trigger("rename", "example");
  await failed;
  await inventory.pending;
  assert.equal(changes.at(-1), original, "retain the last successful inventory");
  assert.ok(inventory.dirtyLibraries.has(first));
  assert.ok(inventory.retryTimer);
  assert.equal(inventory.timer, undefined, "failure recovery uses the slower retry timer");
  inventory.onChange = publish;
  fs.rmSync(path.join(first, "example"), { recursive: true });
  install(first, "3.0");
  control.handles.get(first).trigger("rename", "example");
  await settle(() => changes.at(-1) !== original);
  assert.ok(matchesDescription(changes.at(-1).packages.get("example"), path.join(first, "example")));
  assert.equal(changes.at(-1).libraries[1], original.libraries[1], "reuse the unaffected library");
  assert.equal(inventory.retryDelay, 1000);
  assert.equal(inventory.retryTimer, undefined);
  assert.ok(logs.includes("[Libraries] Recovery retry scheduled in 1s"));
  // A fresh filesystem event can now recover before the delayed retry fires.
  // Both paths must settle the inventory and cancel the backoff timer.
  assert.equal(logs.filter(line => line.includes("Recovery complete; retries stopped")).length, 1);
});

test("a later alias change suspends inventory until its full new path is approved", async t => {
  const { root, libraries: [first, second], inventory, changes, install, reviews, settle } = fixture(t);
  install(first); install(second, "2.0");
  const parent = path.join(root, "parent"), alias = path.join(root, "alias");
  fs.mkdirSync(parent);
  const middle = path.join(parent, "library"), kind = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(first, middle, kind); fs.symlinkSync(parent, alias, kind);
  const library = path.join(alias, "library");
  inventory.setLibraryPaths([library]);
  await settle();
  const previous = changes.at(-1).packages.get("example");
  fs.unlinkSync(middle); fs.symlinkSync(second, middle, kind);
  await settle(() => inventory.suspended.has(library) && changes.at(-1).libraries[0].suspended);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].entry, middle);
  assert.equal(changes.at(-1).packages.get("example"), previous);
  assert.equal(inventory.watchers.size, 0);
  const proposal = reviews[0].review();
  assert.equal(proposal.root, second);
  assert.equal(inventory.watchers.size, 0, "review alone cannot start monitoring");
  assert.equal(reviews[0].approve(proposal), true);
  await settle(() => changes.at(-1).packages.get("example").target === path.join(second, "example"));
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
  let library, failNext = false, failed = false;
  const f = fixture(t, 0, {
    promises: { ...fs.promises, opendir: async (file, ...args) => {
      if (file === library && failNext) {
        failNext = false;
        failed = true;
        throw Object.assign(new Error("Temporary read failure"), { code: "EIO" });
      }
      return fs.promises.opendir(file, ...args);
    } },
  });
  ({ libraries: [library] } = f);
  const { inventory, changes, logs, install, settle } = f;
  inventory.setLibraryPaths([library]);
  await settle();
  install(library);
  failNext = true;
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

test("a missing initial library is not watched until explicitly reviewed and trusted", async t => {
  const { libraries: [library], inventory, changes, install, settle, reviews, watches, entryWatches } = fixture(t);
  fs.rmdirSync(library);
  inventory.setLibraryPaths([library]);
  await settle();
  assert.equal(inventory.watchers.size, 0);
  assert.equal(inventory.retryTimer, undefined);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reason, "Configured library path missing or renamed");
  assert.equal(reviews[0].previousRoot, undefined);
  assert.equal(watches.length + entryWatches.length, 0);
  install(library);
  await inventory.refresh();
  assert.equal(inventory.watchers.size, 0);
  assert.equal(reviews[0].approve(reviews[0].review()), true);
  await settle(() => inventory.watchers.has(library) && changes.at(-1).packages.has("example"));
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
  while (!matchesDescription(changes.at(-1).packages.get("example"), path.join(library, "example"))) {
    assert.ok(Date.now() < deadline, "same-name package replacement must be detected");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await settle();
  assert.ok(matchesDescription(changes.at(-1).packages.get("example"), path.join(library, "example")));
});

test("ordinary physical libraries log one canonical path, with no alias arrow", async t => {
  const { libraries: [library], inventory, changes, logs, settle } = fixture(t);
  inventory.setLibraryPaths([library]);
  await settle();
  assert.ok(logs.includes(`[Libraries] Pinned library: ${library}`));
  assert.ok(!logs.some(line => line.startsWith("[Libraries] Library alias:")));
  assert.ok(!logs.some(line => line.startsWith("[Libraries] Pinned library:") && line.includes(" -> ")));
  assert.deepEqual(changes.at(-1).libraries.map(item => item.path), [library],
    "pinning for monitoring must not change the R search order");
  inventory.setLibraryPaths([library]);
  await settle();
  assert.equal(logs.filter(line => line.startsWith("[Libraries] Pinned library:")).length, 1,
    "unchanged libraries must not log their initial pin repeatedly");
});

test("canonical spelling differences without a symlink are not logged as aliases", async t => {
  let configured;
  const physical = [];
  const realpathSync = Object.assign((...args) => fs.realpathSync(...args), {
    native: (file, ...args) => file === configured ? physical[0] : fs.realpathSync.native(file, ...args),
  });
  const { root, inventory, changes, logs, reviews, settle, entryWatches } = fixture(t, 0, {
    realpathSync,
    // Model two spellings of the same directory, including its file identity.
    lstatSync: (file, ...args) => fs.lstatSync(file === configured ? physical[0] : file, ...args),
  });
  configured = path.join(root, "displayed-library");
  physical[0] = path.join(root, "canonical-library");
  fs.mkdirSync(configured);
  fs.mkdirSync(physical[0]);
  inventory.setLibraryPaths([configured]);
  await settle();
  assert.ok(logs.includes(`[Libraries] Pinned library: ${physical[0]}`));
  assert.ok(!logs.some(line => line.startsWith("[Libraries] Library alias:")),
    "different canonical strings are not proof that a symlink exists");
  entryWatches.find(watch => watch.file === root).trigger("rename", path.basename(configured));
  await settle();
  assert.equal(reviews.length, 0, "unchanged canonical spelling is not an identity change");
  assert.deepEqual(changes.at(-1).libraries.map(item => item.path), [configured]);
});

test("an alias replaced by an ordinary directory suspends without retargeting", async t => {
  const { root, inventory, reviews, settle, install, entryWatches, changes } = fixture(t);
  const first = path.join(root, "pinned-destination"), alias = path.join(root, "configured-alias");
  install(first);
  fs.symlinkSync(first, alias, process.platform === "win32" ? "junction" : "dir");
  inventory.setLibraryPaths([alias]);
  await settle();
  fs.unlinkSync(alias);
  fs.mkdirSync(alias);
  const entryWatch = entryWatches.find(watch => watch.file === root);
  assert.ok(entryWatch);
  entryWatch.trigger("rename", path.basename(alias));
  await settle(() => changes.at(-1).libraries[0].suspended);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reason, "Configured library alias replaced by an ordinary directory");
  assert.equal(reviews[0].entry, alias);
  assert.equal(inventory.watchers.has(alias), false);
  assert.equal(changes.at(-1).packages.get("example").target, path.join(first, "example"),
    "removing an alias cannot change the retained pinned package destination");
  assert.deepEqual(changes.at(-1).unmonitored, ["example"]);
  reviews[0].reject();
});

test("a symlinked ancestor is identified as a library alias", async t => {
  const { root, inventory, logs, install, settle } = fixture(t);
  const realParent = path.join(root, "real-parent");
  const aliasParent = path.join(root, "alias-parent");
  const physicalLibrary = install(path.join(realParent, "library"));
  fs.symlinkSync(realParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
  const configured = path.join(aliasParent, "library");
  inventory.setLibraryPaths([configured]);
  await settle();
  assert.ok(logs.includes(`[Libraries] Library alias: ${configured} -> ${path.dirname(physicalLibrary)}`),
    "a link in the configured library ancestry must be classified as an alias");
});

test("configured library alias retargeting suspends until the new location is trusted", async t => {
  const { root, inventory, changes, install, settle, watches, entryWatches, reviews, logs } = fixture(t);
  const first = path.join(root, "original-target"), second = path.join(root, "replacement-target");
  const library = path.join(root, "active-library");
  install(first);
  install(second, "2.0");
  const kind = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(first, library, kind);
  inventory.setLibraryPaths([library]);
  await settle();
  const previousInstallation = changes.at(-1).packages.get("example");
  assert.ok(matchesDescription(previousInstallation, path.join(first, "example")));
  assert.ok(logs.includes(`[Libraries] Library alias: ${library} -> ${first}`));
  assert.deepEqual(watches.map(watch => watch.file).sort(), [first, path.join(first, "example")].sort());
  assert.ok(watches.every(watch => watch.options.recursive === false));
  fs.unlinkSync(library);
  fs.symlinkSync(second, library, kind);
  const aliasWatch = entryWatches.find(watch => watch.file === root);
  assert.ok(aliasWatch);
  aliasWatch.trigger("rename", path.basename(library));
  await settle(() => changes.at(-1).libraries[0].suspended);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reason, "Configured library alias changed");
  assert.equal(reviews[0].entry, library);
  fs.rmSync(path.join(second, "example"), { recursive: true });
  install(second, "3.0");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(inventory.watchers.has(library), false);
  assert.equal(changes.at(-1).packages.get("example"), previousInstallation);
  assert.equal(changes.at(-1).packages.get("example").target, path.join(first, "example"));
  assert.equal(watches.length, 2);
  const proposal = reviews[0].review();
  assert.equal(proposal.root, second);
  assert.equal(watches.length, 2, "review does not watch the destination");
  assert.equal(reviews[0].approve(proposal), true);
  await settle(() => matchesDescription(changes.at(-1).packages.get("example"), path.join(second, "example")));
  assert.ok(watches.some(watch => watch.file === second));
});

for (const replaceAncestor of [false, true]) {
  test(`a pinned library ${replaceAncestor ? "ancestor" : "root"} replaced by a link suspends monitoring`, async t => {
    const { root, inventory, changes, install, settle, watches, entryWatches, reviews, logs } = fixture(t);
    const parent = path.join(root, "configured"), library = path.join(parent, "library");
    const external = path.join(root, "external");
    install(library);
    install(replaceAncestor ? path.join(external, "library") : external, "2.0");
    inventory.setLibraryPaths([library]);
    await settle();
    const watcher = inventory.watchers.get(library);
    const replaced = replaceAncestor ? parent : library;
    releaseWindowsWatcherHandles(watcher);
    releaseWindowsEntryWatcherHandles(inventory);
    fs.renameSync(replaced, replaced + "-original");
    fs.symlinkSync(external, replaced, process.platform === "win32" ? "junction" : "dir");
    // Deliver the ancestor-entry event independently of the root watcher.
    const parentWatch = entryWatches.find(watch => watch.file === path.dirname(replaced));
    assert.ok(parentWatch, "pinned root parent entries must be monitored");
    parentWatch.trigger("rename", path.basename(replaced));
    await settle(() => changes.at(-1).unmonitoredRoots.includes(library));
    const reason = replaceAncestor ? "Pinned library ancestor replaced by a symlink" : "Pinned library replaced by a symlink";
    const expected = `[Libraries] Monitoring suspended: ${library} - ${reason}: ${replaced}`;
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].reason, reason);
    assert.equal(reviews[0].entry, replaced);
    assert.ok(logs.includes(expected), "symlink replacement should report suspension, not intermediate validation");
    assert.equal(logs.filter(line => line === expected).length, 1);
    assert.ok(!logs.some(line => line.includes("; verifying ")));
    assert.equal(changes.at(-1).packages.size, 1, "suspension retains verified metadata");
    assert.deepEqual(changes.at(-1).changed, []);
    assert.deepEqual(changes.at(-1).unmonitored, ["example"]);
    assert.equal(inventory.watchers.size, 0);
    assert.equal(inventory.retryTimer, undefined, "a changed link is not retried automatically");
    assert.equal(watches.length, 2, "no watch is opened on the replacement target");
  });
}

test("replacing a physical library requires approval before rearming its watcher", async t => {
  const { libraries: [library], inventory, changes, install, settle, reviews, entryWatches, logs } = fixture(t);
  install(library);
  inventory.setLibraryPaths([library]);
  await settle();
  const previousInstallation = changes.at(-1).packages.get("example");
  const previous = inventory.watchers.get(library);
  const moved = library + "-old";
  releaseWindowsWatcherHandles(previous);
  releaseWindowsEntryWatcherHandles(inventory);
  const parentWatch = entryWatches.find(watch => watch.file === path.dirname(library));
  fs.renameSync(library, moved);
  fs.mkdirSync(library);
  install(library, "2.0");
  if (process.platform === "win32") parentWatch.trigger("rename", path.basename(library));
  await settle(() => changes.at(-1).libraries[0].suspended);
  assert.equal(inventory.watchers.has(library), false);
  assert.equal(reviews.length, 1);
  assert.ok(["Pinned library replaced", "Pinned library missing or renamed"].includes(reviews[0].reason),
    "a native notification may see the missing entry or the completed replacement");
  assert.equal(reviews[0].entry, library);
  assert.equal(changes.at(-1).packages.get("example"), previousInstallation);
  const proposal = reviews[0].review();
  assert.equal(proposal.root, library);
  assert.equal(reviews[0].approve(proposal), true);
  await settle(() => matchesDescription(changes.at(-1).packages.get("example"), path.join(library, "example")));
  assert.notEqual(inventory.watchers.get(library), previous);
  assert.equal(logs.filter(line => line.includes("Monitoring suspended:")).length, 1);
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  fs.rmSync(path.join(library, "example"), { recursive: true });
  install(library, "3.0");
  await settle(() => matchesDescription(changes.at(-1).packages.get("example"), path.join(library, "example")));
});

test("a renamed library stays suspended when its original path is recreated", async t => {
  const { libraries: [library], inventory, changes, reviews, install, settle, entryWatches } = fixture(t);
  install(library);
  inventory.setLibraryPaths([library]);
  await settle();
  const previousInstallation = changes.at(-1).packages.get("example");
  releaseWindowsWatcherHandles(inventory.watchers.get(library));
  releaseWindowsEntryWatcherHandles(inventory);
  const parentWatch = entryWatches.find(watch => watch.file === path.dirname(library));
  assert.ok(parentWatch);
  fs.renameSync(library, library + "-old");
  parentWatch.trigger("rename", path.basename(library));
  await settle(() => changes.at(-1).libraries[0].suspended);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reason, "Pinned library missing or renamed");
  assert.throws(() => reviews[0].review());
  fs.mkdirSync(library);
  install(library, "2.0");
  parentWatch.trigger("rename", path.basename(library));
  await inventory.refresh();
  await settle();
  assert.equal(inventory.watchers.has(library), false);
  assert.equal(reviews.length, 1);
  assert.equal(changes.at(-1).packages.get("example"), previousInstallation);
  assert.equal(inventory.retryTimer, undefined);
  assert.equal(reviews[0].approve(reviews[0].review()), true);
  await settle(() => matchesDescription(changes.at(-1).packages.get("example"), path.join(library, "example")));
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
  while (!matchesDescription(changes.at(-1).libraries[1].packages.get("example"), path.join(second, "example"))) {
    assert.ok(Date.now() < deadline, "healthy library must refresh before recovery retry");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(inventory.retryTimer, "failed library is still backing off");
  assert.ok(matchesDescription(changes.at(-1).libraries[1].packages.get("example"), path.join(second, "example")));
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
  while (!matchesDescription(changes.at(-1).libraries[1].packages.get("example"), path.join(second, "example"))) {
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
  assert.equal(changes.at(-1).packages.get("example").path, path.join(first, "example"));

  inventory.setLibraryPaths([second]);
  await settle();
  assert.equal(inventory.watchers.has(first), false, "removed libraries must stop being watched");
  assert.equal(changes.at(-1).packages.get("example").path, path.join(second, "example"));
  assert.ok(logs.some(line => line.includes("First library copy changed") ||
    line.includes("Remaining library copy")));

  inventory.setLibraryPaths([first, second]);
  await settle();
  assert.equal(inventory.watchers.has(first), true, "readded libraries resume monitoring");
  assert.equal(changes.at(-1).packages.get("example").path, path.join(first, "example"));
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
  await settle(() => matchesDescription(changes.at(-1).packages.get("example"), example));
  const previousInstallation = changes.at(-1).packages.get("example");
  fs.mkdirSync(path.join(library, "00LOCK"));
  const lock = path.join(library, "00LOCK", "example");
  fs.renameSync(example, lock);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(changes.at(-1).packages.get("example"), previousInstallation, "generic lock backups retain the previous copy");
  install(library, "3.0");
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(changes.at(-1).packages.get("example"), previousInstallation);
  fs.rmSync(path.join(library, "00LOCK"), { recursive: true });
  await settle(() => matchesDescription(changes.at(-1).packages.get("example"), example));
});

test("linked package entries are tracked without resolving, reading, watching or polling targets", async t => {
  const accesses = [];
  let library;
  const promises = { ...fs.promises };
  for (const method of ["realpath", "readlink", "stat", "access", "readFile", "open", "opendir"]) {
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
  assert.ok(accesses.every(([method, file]) => method === "opendir" && file === library),
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
    promises: { ...fs.promises, opendir: async (file, ...args) => {
      const handle = await fs.promises.opendir(file, ...args);
      return {
        read: () => handle.read(),
        close: async () => {
          await handle.close();
          if (link && file === path.dirname(link) && !swapped) {
            swapped = true;
            fs.rmSync(link, { recursive: true });
            fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
          }
        },
      };
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
  assert.ok(matchesDescription(changes.at(-1).packages.get("example"), path.join(library, "example")));
  assert.equal(changes.at(-1).libraries[0].deferred.size, 0);
  fs.rmSync(path.join(library, "example"), { recursive: true });
  install(library, "2.0");
  await settle(() => matchesDescription(changes.at(-1).packages.get("example"), path.join(library, "example")));
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

test("a DESCRIPTION replaced by a symlink before metadata inspection is excluded", {
  skip: process.platform === "win32",
}, async t => {
  let description, target, swapped = false;
  const { root, libraries: [library], inventory, changes, install, settle } = fixture(t, 0, {
    promises: { ...fs.promises, lstat: async (file, ...args) => {
      if (file === description && !swapped) {
        swapped = true;
        fs.unlinkSync(file);
        fs.symlinkSync(target, file, "file");
      }
      return fs.promises.lstat(file, ...args);
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
    promises: { ...fs.promises, opendir: async (file, ...args) => {
      reads.push(file);
      return fs.promises.opendir(file, ...args);
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
  await settle(() => matchesDescription(changes.at(-1).packages.get("example"), directory));
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
  const promises = { ...fs.promises, opendir: async (file, ...args) => {
    if (unavailable && file === library) {
      throw Object.assign(new Error("network share unavailable"), { code: "EIO" });
    }
    return fs.promises.opendir(file, ...args);
  } };
  const fixtureData = fixture(t, 0, { promises });
  ({ libraries: [library] } = fixtureData);
  const { inventory, changes, logs, install, settle } = fixtureData;
  install(library);
  inventory.setLibraryPaths([library]);
  await settle();
  const previousInstallation = changes.at(-1).packages.get("example");
  unavailable = true;
  inventory.dirtyLibraries.add(library);
  await inventory.refresh();
  const deadline = Date.now() + 5000;
  while (!changes.at(-1).libraries[0].unavailable) {
    assert.ok(Date.now() < deadline, "offline status must be reported");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(changes.at(-1).packages.get("example"), previousInstallation);
  assert.deepEqual(changes.at(-1).changed, [], "temporary disconnect does not remove installed packages");
  assert.ok(changes.at(-1).unmonitoredRoots.includes(library));
  assert.ok(logs.some(line => line.includes("Monitoring temporarily unavailable:") &&
    line.includes("network share unavailable")));

  unavailable = false;
  fs.rmSync(path.join(library, "example"), { recursive: true });
  install(library, "2.0");
  inventory.dirtyLibraries.add(library);
  await inventory.refresh();
  await settle(() => matchesDescription(changes.at(-1).packages.get("example"), path.join(library, "example")));
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

test("oversized configured libraries stop enumeration and suspend without recurrent network scans", async t => {
  let library;
  const listings = [];
  const promises = { ...fs.promises, opendir: async (file, ...args) => {
    if (file === library) {
      const listing = { reads: 0, closed: false };
      listings.push(listing);
      return {
        read: async () => {
          assert.ok(++listing.reads <= 4097, "stop as soon as the entry budget is exceeded");
          return { name: "pkg" + listing.reads, isDirectory: () => true, isSymbolicLink: () => false };
        },
        close: async () => { listing.closed = true; },
      };
    }
    return fs.promises.opendir(file, ...args);
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
  assert.ok(listings.some(listing => listing.reads === 4097));
  assert.ok(listings.every(listing => listing.closed), "overflow and cancelled handles close");
  const count = listings.length;
  await inventory.refresh();
  assert.equal(listings.length, count, "suspended roots are not rescanned before reconfiguration");
});

// Inject deterministic watcher failures without relying on OS limits,
// permissions, notification ordering or Windows directory handle behaviour.
function controlledWatches(beforeWatch = () => {}, afterWatch = () => {}) {
  const { EventEmitter } = require("node:events");
  const attempts = [], handles = new Map();
  const watch = (file, options, callback) => {
    const packageWatch = options.encoding !== "utf8";
    if (packageWatch) {
      attempts.push(file);
      beforeWatch(file);
    }
    const handle = new EventEmitter();
    handle.closed = false;
    handle.close = () => { handle.closed = true; };
    handle.trigger = callback;
    if (packageWatch) {
      handles.set(file, handle);
      afterWatch(file, handle);
    }
    return handle;
  };
  return { watch, attempts, handles };
}

function forcePackageRetry(group, directory) {
  // Advance the due time of the real scheduled retry without waiting for
  // the full 31-second backoff during a unit test.
  assert.ok(group.packageRetryTimer);
  clearTimeout(group.packageRetryTimer);
  group.failedPackages.get(directory).nextAttemptAt = Date.now() - 1;
  group.retryPackages();
}

for (const phase of ["after enumeration", "during registration"]) {
  test(`package watches stop immediately when the pinned root changes ${phase}`, async t => {
    let library, first, root, replaced = false;
    const replace = () => {
      if (replaced) return;
      replaced = true;
      fs.renameSync(library, path.join(root, "original-library"));
      fs.mkdirSync(library);
      for (const name of ["alpha", "beta", "gamma"]) fs.mkdirSync(path.join(library, name));
    };
    const control = controlledWatches(undefined, file => {
      if (phase === "during registration" && file === first) replace();
    });
    let enumerations = 0;
    const f = fixture(t, 0, {
      watch: control.watch,
      promises: { ...fs.promises, opendir: async (file, ...args) => {
        const handle = await fs.promises.opendir(file, ...args);
        return {
          read: async () => {
            const entry = await handle.read();
            if (entry?.name === "alpha" && file === library && phase === "after enumeration") {
              // Inspecting a returned Dirent must still revalidate the pin
              // before registering a package watch or reading its metadata.
              const isDirectory = entry.isDirectory.bind(entry);
              entry.isDirectory = () => { if (++enumerations === 1) replace(); return isDirectory(); };
            }
            return entry;
          },
          close: () => handle.close(),
        };
      } },
    });
    ({ root, libraries: [library] } = f);
    first = f.install(library, "1.0", "alpha");
    f.install(library, "1.0", "beta");
    f.install(library, "1.0", "gamma");
    f.inventory.setLibraryPaths([library]);
    await f.settle(() => f.changes.at(-1)?.libraries[0]?.suspended);
    assert.equal(replaced, true);
    assert.deepEqual(control.attempts, phase === "after enumeration" ? [library] : [library, first]);
    assert.ok([...control.handles.values()].every(handle => handle.closed));
    assert.equal(f.inventory.watchers.size, 0);
  });
}

test("a persistent package registration failure leaves the library and sibling watches active", async t => {
  let broken, fail = true;
  const control = controlledWatches(file => {
    if (file === broken && fail) throw Object.assign(new Error("watch limit"), { code: "ENOSPC" });
  });
  const { libraries: [library], inventory, changes, logs, install, settle } = fixture(t, 0, { watch: control.watch });
  broken = install(library, "1.0", "broken");
  const healthy = install(library, "1.0", "healthy");
  inventory.setLibraryPaths([library]);
  await settle();
  const group = inventory.watchers.get(library);
  assert.ok(group, "a failed package must not prevent library watch registration");
  const rootWatch = group.directories.get(library).watcher;
  const healthyWatch = group.directories.get(healthy).watcher;
  assert.equal(group.directories.has(broken), false);
  assert.equal(inventory.retryTimer, undefined, "no whole-library recovery for a package failure");
  for (let i = 1; i <= 5; i++) {
    forcePackageRetry(group, broken);
    assert.equal(group.failedPackages.get(broken).attempts, i);
  }
  assert.equal(group.packageRetryTimer, undefined, "stop idle retries after five attempts");
  assert.equal(control.attempts.filter(file => file === broken).length, 6);
  await settle();
  assert.deepEqual([...changes.at(-1).packages.keys()], ["broken", "healthy"],
    "watch failures must not remove readable installations from inventory");
  assert.equal(logs.filter(line => line.includes("package watcher unavailable:")).length, 1);

  fs.writeFileSync(path.join(healthy, "DESCRIPTION"), "Package: healthy\nVersion: 2.0\n");
  healthyWatch.trigger("change", "DESCRIPTION");
  await settle(() => matchesDescription(changes.at(-1)?.packages.get("healthy"), healthy));
  const added = install(library, "1.0", "added");
  rootWatch.trigger("rename", "added");
  await settle(() => changes.at(-1)?.packages.has("added"));
  assert.ok(group.directories.has(added));
  assert.equal(group.packageRetryTimer, undefined, "root events do not restart exhausted idle retries");

  fail = false;
  rootWatch.trigger("rename", "broken");
  await settle(() => group.directories.has(broken));
  assert.equal(group.failedPackages.size, 0);
  assert.equal(inventory.watchers.get(library), group);
  assert.equal(group.directories.get(library).watcher, rootWatch);
  assert.equal(group.directories.get(healthy).watcher, healthyWatch);
  assert.equal(rootWatch.closed || healthyWatch.closed, false);
  assert.equal(inventory.retryTimer, undefined);
});

test("a package lstat failure during refresh closes only that package watch and retries it", async t => {
  let broken, fail = false, registering = false;
  const control = controlledWatches();
  const { libraries: [library], inventory, changes, install, settle } = fixture(t, 0, {
    watch: control.watch,
    lstatSync: (file, ...args) => {
      if (file === broken && fail && registering) throw Object.assign(new Error("package unavailable"), { code: "EACCES" });
      return fs.lstatSync(file, ...args);
    },
  });
  broken = install(library, "1.0", "broken");
  const healthy = install(library, "1.0", "healthy");
  inventory.setLibraryPaths([library]);
  await settle();
  const group = inventory.watchers.get(library);
  const rootWatch = group.directories.get(library).watcher;
  const healthyWatch = group.directories.get(healthy).watcher;
  const brokenWatch = group.directories.get(broken).watcher;
  // The metadata-only scanner now also validates directory identities with
  // lstatSync. Inject a registration-specific failure, not a second unrelated
  // metadata failure which would legitimately schedule inventory recovery.
  const watchDirectory = group.watchDirectory.bind(group);
  group.watchDirectory = directory => {
    registering = true;
    try { return watchDirectory(directory); }
    finally { registering = false; }
  };
  fail = true;
  rootWatch.trigger("rename", "broken");
  await settle(() => group.failedPackages.has(broken));
  assert.ok(brokenWatch.closed);
  assert.equal(group.directories.has(broken), false);
  assert.equal(inventory.retryTimer, undefined);
  fail = false;
  // Exercise an actual scheduled retry, not just a synthetic root event.
  await settle(() => group.directories.has(broken));
  assert.equal(group.failedPackages.size, 0);
  assert.equal(group.packageRetryTimer, undefined);
  assert.equal(group.directories.get(library).watcher, rootWatch);
  assert.equal(group.directories.get(healthy).watcher, healthyWatch);
  assert.equal(rootWatch.closed || healthyWatch.closed, false);
  assert.deepEqual(changes.at(-1).changed, []);
});

test("a native package watcher error recovers missed changes without replacing healthy watches", async t => {
  let broken, fail = false;
  const control = controlledWatches(file => {
    if (file === broken && fail) throw new Error("still unavailable");
  });
  const { libraries: [library], inventory, changes, install, settle } = fixture(t, 0, { watch: control.watch });
  broken = install(library, "1.0", "broken");
  const healthy = install(library, "1.0", "healthy");
  inventory.setLibraryPaths([library]);
  await settle();
  const group = inventory.watchers.get(library);
  const rootWatch = group.directories.get(library).watcher;
  const healthyWatch = group.directories.get(healthy).watcher;
  const old = group.directories.get(broken).watcher;
  fail = true;
  old.emit("error", new Error("package watch lost"));
  assert.ok(old.closed);
  assert.equal(group.directories.has(broken), false);
  await settle();
  fs.writeFileSync(path.join(broken, "DESCRIPTION"), "Package: broken\nVersion: 2.0\n");
  fail = false;
  forcePackageRetry(group, broken);
  await settle(() => matchesDescription(changes.at(-1)?.packages.get("broken"), broken));
  const replacement = group.directories.get(broken).watcher;
  assert.notEqual(replacement, old);
  assert.deepEqual(changes.at(-1).changed, ["broken"]);
  assert.equal(group.directories.get(library).watcher, rootWatch);
  assert.equal(group.directories.get(healthy).watcher, healthyWatch);
  assert.equal(rootWatch.closed || healthyWatch.closed, false);
  old.emit("error", new Error("stale error"));
  assert.equal(group.directories.get(broken).watcher, replacement);
  assert.equal(group.failedPackages.size, 0);
  assert.equal(inventory.retryTimer, undefined);

  // Root watcher failure must still use the original library-level recovery.
  rootWatch.emit("error", new Error("root watch lost"));
  assert.equal(inventory.watchers.has(library), false);
  assert.ok(healthyWatch.closed && replacement.closed);
  assert.ok(inventory.retryTimer);
});

test("a package changed into a link during watch setup is rejected without losing the root watch", async t => {
  let broken, target;
  const control = controlledWatches(undefined, file => {
    if (file !== broken) return;
    fs.rmSync(broken, { recursive: true });
    fs.symlinkSync(target, broken, process.platform === "win32" ? "junction" : "dir");
  });
  const { root, libraries: [library], inventory, changes, install, settle } = fixture(t, 0, { watch: control.watch });
  broken = install(library, "1.0", "broken");
  const healthy = install(library, "1.0", "healthy");
  target = install(path.join(root, "cache"), "2.0", "broken");
  inventory.setLibraryPaths([library]);
  await settle();
  const group = inventory.watchers.get(library);
  assert.ok(control.handles.get(broken).closed, "close the watch whose identity check failed");
  assert.equal(group.directories.has(broken), false);
  assert.ok(group.directories.has(library) && group.directories.has(healthy));
  forcePackageRetry(group, broken);
  await settle();
  assert.equal(changes.at(-1).packages.get("broken").linked, true);
  assert.equal(control.attempts.filter(file => file === broken).length, 1);
  assert.ok(!control.attempts.includes(target), "never register a watch on the external target");
  assert.equal(group.failedPackages.size, 0);
  assert.equal(group.packageRetryTimer, undefined);
  assert.equal(inventory.retryTimer, undefined);
});

for (const replaceRoot of [false, true]) {
  test(`package watcher retries stop when the library is ${replaceRoot ? "replaced" : "removed from the search path"}`, async t => {
    let broken;
    const control = controlledWatches(file => {
      if (file === broken) throw new Error("package watch unavailable");
    });
    const { root, libraries: [library], inventory, changes, install, settle } = fixture(t, 0, { watch: control.watch });
    broken = install(library, "1.0", "broken");
    inventory.setLibraryPaths([library]);
    await settle();
    const group = inventory.watchers.get(library);
    assert.ok(group.packageRetryTimer);
    const attempts = control.attempts.length;
    if (replaceRoot) {
      fs.renameSync(library, path.join(root, "old-library"));
      const external = path.join(root, "external");
      install(external, "2.0", "broken");
      fs.symlinkSync(external, library, process.platform === "win32" ? "junction" : "dir");
      // No parent notification: the retry itself must validate the pin.
      forcePackageRetry(group, broken);
      await settle(() => changes.at(-1)?.libraries[0]?.suspended === true);
    } else {
      inventory.setLibraryPaths([]);
      await settle(() => changes.at(-1)?.libraries.length === 0);
    }
    assert.equal(inventory.watchers.has(library), false);
    assert.ok(group.closed);
    assert.equal(group.packageRetryTimer, undefined);
    assert.equal(group.failedPackages.size, 0);
    group.retryPackages();
    assert.equal(control.attempts.length, attempts, "stale retries cannot register new watches");
  });
}

/** A degraded inventory can publish successfully while its independent
 * recovery timer is still armed. Wait for publication, not for all retries. */
async function waitForInventoryPublication(inventory, observed = () => true) {
  const deadline = Date.now() + 10000;
  do {
    await new Promise(resolve => setTimeout(resolve, 20));
    if (observed() && inventory.initialized && !inventory.pending && !inventory.timer &&
        !inventory.dirtyLibraries.size && !inventory.unconfirmedLibraries.size) return;
    assert.ok(Date.now() < deadline, "inventory must publish independently of read recovery");
  } while (true);
}

function forceReadRetry(inventory) {
  assert.ok(inventory.retryTimer);
  clearTimeout(inventory.retryTimer);
  inventory.runRecoveryRetry();
}

test("an initially unreadable higher-priority package blocks fallback but not sibling updates", async t => {
  let broken, fail = true;
  const control = controlledWatches();
  const { libraries: [first, second], inventory, changes, logs, install, settle } = fixture(t, 0, {
    watch: control.watch,
    promises: { ...fs.promises, lstat: async (file, ...args) => {
      if (file === broken && fail) throw Object.assign(new Error("package entry inaccessible"), { code: "EACCES" });
      return fs.promises.lstat(file, ...args);
    } },
  });
  broken = install(first, "1.0", "broken");
  const healthy = install(first, "1.0", "healthy");
  install(second, "9.0", "broken");
  install(second, "1.0", "other");
  inventory.retryDelay = 10000;
  inventory.setLibraryPaths([first, second]);
  await waitForInventoryPublication(inventory);
  const initial = changes.at(-1);
  assert.equal(initial.libraries[0].unavailable, undefined);
  assert.ok(initial.libraries[0].unavailablePackages.has("broken"));
  assert.deepEqual([...initial.packages.keys()].sort(), ["healthy", "other"]);
  assert.deepEqual(initial.unmonitored, ["broken"]);
  assert.deepEqual(initial.unmonitoredRoots, []);
  assert.ok(initial.libraries[0].deferred.get("broken").includes(broken));
  assert.ok(logs.some(line => line.includes("Metadata temporarily unavailable: broken") &&
    line.includes("package entry inaccessible")));
  const rootWatch = control.handles.get(first);
  const siblingWatch = control.handles.get(healthy);

  fs.writeFileSync(path.join(healthy, "DESCRIPTION"), "Package: healthy\nVersion: 2.00\n");
  siblingWatch.trigger("change", "DESCRIPTION");
  await waitForInventoryPublication(inventory, () => matchesDescription(changes.at(-1)?.packages.get("healthy"), healthy));
  assert.deepEqual(changes.at(-1).changed, ["healthy"]);
  assert.equal(changes.at(-1).packages.has("broken"), false);
  assert.equal(control.handles.get(first), rootWatch);
  assert.equal(control.handles.get(healthy), siblingWatch);
  assert.ok(inventory.retryTimer, "healthy publication does not cancel package read recovery");

  for (let remaining = 4; remaining >= 0; remaining--) {
    forceReadRetry(inventory);
    await waitForInventoryPublication(inventory);
    assert.equal(inventory.packageReadRetries.get(first).get("broken"), remaining);
  }
  assert.equal(inventory.retryTimer, undefined, "persistent package read failures do not poll indefinitely");
  assert.equal(logs.filter(line => line.includes("Metadata temporarily unavailable: broken")).length, 1);
  assert.ok(!logs.some(line => line.includes("Recovery complete")), "exhaustion is not successful recovery");

  fail = false;
  rootWatch.trigger("rename", "broken");
  await settle(() => changes.at(-1)?.packages.get("broken")?.path === broken);
  assert.deepEqual(changes.at(-1).unmonitored, []);
  assert.equal(changes.at(-1).libraries[0].unavailablePackages.size, 0);
  assert.equal(inventory.packageReadRetries.size, 0);
  assert.ok(logs.some(line => line.includes("Metadata restored: broken")));
});

test("a previously readable package retains its verified metadata while healthy changes publish", async t => {
  let description, fail = false;
  const control = controlledWatches();
  const { libraries: [library], inventory, changes, logs, install, settle } = fixture(t, 0, {
    watch: control.watch,
    promises: { ...fs.promises, lstat: async (file, ...args) => {
      if (file === description && fail) throw Object.assign(new Error("metadata temporarily unreadable"), { code: "EIO" });
      return fs.promises.lstat(file, ...args);
    } },
  });
  const broken = install(library, "1.0", "broken");
  const healthy = install(library, "1.0", "healthy");
  description = path.join(broken, "DESCRIPTION");
  inventory.setLibraryPaths([library]);
  await settle();
  const previous = changes.at(-1).packages.get("broken");
  fail = true;
  fs.writeFileSync(description, "Package: broken\nVersion: 2.00\n");
  fs.writeFileSync(path.join(healthy, "DESCRIPTION"), "Package: healthy\nVersion: 2.00\n");
  control.handles.get(broken).trigger("change", "DESCRIPTION");
  control.handles.get(healthy).trigger("change", "DESCRIPTION");
  await waitForInventoryPublication(inventory, () => matchesDescription(changes.at(-1)?.packages.get("healthy"), healthy));
  const degraded = changes.at(-1);
  assert.equal(degraded.packages.get("broken"), previous);
  assert.ok(degraded.libraries[0].unavailablePackages.has("broken"));
  assert.deepEqual(degraded.unmonitored, ["broken"]);
  assert.deepEqual(degraded.unmonitoredRoots, []);
  assert.deepEqual(degraded.changed, ["healthy"]);
  assert.deepEqual(degraded.changedInstallationPaths, [healthy]);
  assert.ok(!logs.some(line => line.includes("Removed: broken")));

  fail = false;
  // Let the real recovery timer fire without any new filesystem event.
  await settle(() => matchesDescription(changes.at(-1)?.packages.get("broken"), broken));
  assert.deepEqual(changes.at(-1).changed, ["broken"]);
  assert.deepEqual(changes.at(-1).changedInstallationPaths, [broken]);
  assert.deepEqual(changes.at(-1).unmonitored, []);
  assert.equal(changes.at(-1).libraries[0].deferred.size, 0);
  assert.equal(inventory.packageReadRetries.size, 0);
});

test("an unreadable lower-priority installation does not exclude a healthy selected copy", async t => {
  let metadata;
  const control = controlledWatches();
  const { libraries: [first, second], inventory, changes, install, settle } = fixture(t, 0, {
    watch: control.watch,
    promises: { ...fs.promises, lstat: async (file, ...args) => {
      if (file === metadata) throw Object.assign(new Error("metadata inaccessible"), { code: "EACCES" });
      return fs.promises.lstat(file, ...args);
    } },
  });
  const selected = install(first, "1.0");
  const lower = install(second, "9.0");
  metadata = path.join(lower, "Meta", "package.rds");
  inventory.retryDelay = 10000;
  inventory.setLibraryPaths([first, second]);
  await waitForInventoryPublication(inventory);
  assert.equal(changes.at(-1).packages.get("example").path, selected);
  assert.deepEqual(changes.at(-1).unmonitored, []);
  assert.ok(changes.at(-1).libraries[1].unavailablePackages.has("example"));
  assert.ok(changes.at(-1).libraries[1].deferred.get("example").includes(lower));

  fs.writeFileSync(path.join(selected, "DESCRIPTION"), "Package: example\nVersion: 2.00\n");
  control.handles.get(selected).trigger("change", "DESCRIPTION");
  await waitForInventoryPublication(inventory, () => matchesDescription(changes.at(-1)?.packages.get("example"), selected));
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.deepEqual(changes.at(-1).unmonitored, []);

  inventory.setLibraryPaths([first]);
  await settle(() => changes.at(-1)?.libraries.length === 1);
  assert.equal(inventory.packageReadRetries.size, 0);
  assert.equal(inventory.retryTimer, undefined, "removed library must not retain metadata retries");
});

test("an unreadable higher-priority package remains excluded through installation locks until removal is confirmed", async t => {
  let broken;
  const control = controlledWatches();
  const { libraries: [first, second], inventory, changes, install, settle } = fixture(t, 0, {
    watch: control.watch,
    promises: { ...fs.promises, lstat: async (file, ...args) => {
      if (file === broken) throw Object.assign(new Error("package inaccessible"), { code: "EACCES" });
      return fs.promises.lstat(file, ...args);
    } },
  });
  broken = install(first, "1.0");
  const fallback = install(second, "2.0");
  inventory.retryDelay = 10000;
  inventory.setLibraryPaths([first, second]);
  await waitForInventoryPublication(inventory);
  assert.deepEqual(changes.at(-1).unmonitored, ["example"]);
  install(second, "3.0");
  control.handles.get(fallback).trigger("change", "DESCRIPTION");
  await waitForInventoryPublication(inventory, () =>
    matchesDescription(changes.at(-1).libraries[1].packages.get("example"), fallback));
  assert.deepEqual(changes.at(-1).changedInstallationPaths, [fallback],
    "retain a healthy copy's update while reconciliation of its name is excluded");
  const lock = path.join(first, "00LOCK-example");
  fs.mkdirSync(lock);
  fs.rmSync(broken, { recursive: true });
  control.handles.get(first).trigger("rename", "00LOCK-example");
  // Deliver and settle the resulting scan even when its inventory is unchanged.
  await new Promise(resolve => setTimeout(resolve, 400));
  await waitForInventoryPublication(inventory);
  assert.equal(changes.at(-1).packages.has("example"), false);
  assert.deepEqual(changes.at(-1).unmonitored, ["example"]);
  assert.ok(changes.at(-1).libraries[0].deferred.has("example"));

  fs.rmdirSync(lock);
  control.handles.get(first).trigger("rename", "00LOCK-example");
  await settle(() => changes.at(-1)?.packages.get("example")?.path === fallback);
  assert.deepEqual(changes.at(-1).unmonitored, []);
  assert.deepEqual(changes.at(-1).changedInstallationPaths, [], "the known lower-priority copy itself did not change");
  assert.equal(inventory.packageReadRetries.size, 0);
});

test("metadata recovery cannot traverse a replaced pinned library", async t => {
  let broken, attempts = 0;
  const control = controlledWatches();
  const { root, libraries: [library], inventory, changes, reviews, install, settle } = fixture(t, 0, {
    watch: control.watch,
    promises: { ...fs.promises, lstat: async (file, ...args) => {
      if (file === broken) {
        attempts++;
        throw Object.assign(new Error("package inaccessible"), { code: "EACCES" });
      }
      return fs.promises.lstat(file, ...args);
    } },
  });
  broken = install(library);
  inventory.retryDelay = 10000;
  inventory.setLibraryPaths([library]);
  await waitForInventoryPublication(inventory);
  const before = attempts;
  fs.renameSync(library, path.join(root, "old-library"));
  const external = path.join(root, "external");
  install(external, "2.0");
  fs.symlinkSync(external, library, process.platform === "win32" ? "junction" : "dir");
  // No parent notification: retry must validate the original pin itself.
  forceReadRetry(inventory);
  await settle(() => changes.at(-1)?.libraries[0]?.suspended === true);
  assert.equal(attempts, before, "never inspect packages below the replacement root");
  assert.equal(reviews.length, 1);
  assert.deepEqual(changes.at(-1).unmonitored, ["example"]);
  assert.equal(inventory.packageReadRetries.size, 0);
  assert.equal(inventory.retryTimer, undefined);
  assert.equal(inventory.watchers.has(library), false);
});

// Exercise real scan timers with deterministic filesystem notifications.
// The recovery timer stays armed while the first publication is blocked.
for (const scenario of ["dirty", "unconfirmed", "failed publication"]) {
  test(`pending ${scenario} work uses the correct scan or recovery timer`, async t => {
    let unreadable;
    const control = controlledWatches();
    const { libraries: [library], inventory, changes, install } = fixture(t, 0, {
      watch: control.watch,
      promises: { ...fs.promises, lstat: async (file, ...args) => {
        if (file === unreadable) throw Object.assign(new Error("metadata inaccessible"), { code: "EACCES" });
        return fs.promises.lstat(file, ...args);
      } },
    });
    unreadable = install(library, "1.0", "unreadable");
    const first = install(library, "1.0", "firstPkg");
    const second = install(library, "1.0", "secondPkg");
    // Keep the unrelated recovery well beyond normal event-driven scans.
    inventory.retryDelay = 30000;
    inventory.setLibraryPaths([library]);
    await waitForInventoryPublication(inventory);
    const previousInstallation = changes.at(-1).packages.get("firstPkg");
    const recovery = inventory.retryTimer;
    assert.ok(recovery);
    assert.equal(inventory.packageReadRetries.get(library).get("unreadable"), 5);

    const waitUntil = async (observed, message) => {
      const deadline = Date.now() + 10000;
      while (!observed()) {
        assert.ok(Date.now() < deadline, message);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    let release, entered = false, publications = 0;
    const blocked = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const publish = inventory.onChange;
    inventory.onChange = async change => {
      if (++publications === 1) {
        entered = true;
        await blocked;
        if (scenario === "failed publication") throw new Error("Temporary publication failure");
      }
      return publish(change);
    };
    fs.writeFileSync(path.join(first, "DESCRIPTION"), "Package: firstPkg\nVersion: 2.00\n");
    control.handles.get(first).trigger("change", "DESCRIPTION");
    await waitUntil(() => entered, "the first publication must be in flight");
    const pending = inventory.pending;
    assert.ok(pending);

    const queue = scenario === "unconfirmed" ? inventory.unconfirmedLibraries : inventory.dirtyLibraries;
    if (scenario === "unconfirmed") {
      fs.writeFileSync(path.join(second, "DESCRIPTION"), "Package: secondPkg\nVersion: 2.00\n");
      control.handles.get(second).trigger("change", "DESCRIPTION");
    } else {
      install(library, "1.0", "addedPkg");
      control.handles.get(library).trigger("rename", "addedPkg");
    }
    await waitUntil(() => queue.has(library) && inventory.timer,
      "the second notification must schedule normal work");
    if (scenario !== "failed publication") {
      // The timer fires, but refresh() joins the in-flight publication.
      // No further filesystem notification will rescue the queued update.
      await waitUntil(() => !inventory.timer, "the normal timer must fire during publication");
    }
    assert.equal(inventory.pending, pending);
    assert.equal(inventory.retryTimer, recovery);
    assert.ok(queue.has(library));
    release();
    await pending;

    if (scenario === "failed publication") {
      assert.equal(inventory.timer, undefined, "a failed publication keeps its recovery backoff");
      assert.equal(publications, 1);
      assert.ok(queue.has(library), "failure must retain the queued work");
      assert.equal(changes.at(-1).packages.get("firstPkg"), previousInstallation);
      assert.equal(inventory.retryTimer, recovery);
      forceReadRetry(inventory);
    } else {
      assert.ok(inventory.timer, "successful publication must re-arm the normal scan despite recovery backoff");
    }
    await waitForInventoryPublication(inventory, () =>
      matchesDescription(changes.at(-1)?.packages.get("firstPkg"), first) &&
      (scenario === "unconfirmed"
        ? matchesDescription(changes.at(-1)?.packages.get("secondPkg"), second)
        : changes.at(-1)?.packages.has("addedPkg")));
    assert.equal(inventory.packageReadRetries.get(library).get("unreadable"),
      scenario === "failed publication" ? 4 : 5);
    if (scenario !== "failed publication") assert.equal(inventory.retryTimer, recovery,
      "normal scans do not consume or replace the unrelated recovery retry");
  });
}

test("inventory publishes metadata-only changes without opening package files", async t => {
  const forbidden = [];
  const deny = method => (file, ...args) => {
    forbidden.push([method, String(file)]);
    throw new Error("package content access forbidden");
  };
  const control = controlledWatches();
  const { libraries: [library], inventory, changes, install, settle } = fixture(t, 0, {
    watch: control.watch,
    openSync: deny("openSync"), readFileSync: deny("readFileSync"),
    promises: { ...fs.promises, open: deny("open"), readFile: deny("readFile"),
      access: deny("access"), stat: deny("stat"), realpath: deny("realpath"), readlink: deny("readlink") },
  });
  const directory = install(library);
  const description = path.join(directory, "DESCRIPTION");
  // The monitor observes metadata, not whether the contents parse as DCF.
  fs.writeFileSync(description, "opaque");
  fs.mkdirSync(path.join(library, "notAPackage"));
  inventory.setLibraryPaths([library]);
  await settle();
  assert.deepEqual([...changes.at(-1).packages.keys()], ["example"]);
  const before = changes.at(-1).packages.get("example");
  fs.writeFileSync(description, "opaque updated metadata");
  control.handles.get(directory).trigger("change", "DESCRIPTION");
  await settle(() => matchesDescription(changes.at(-1).packages.get("example"), directory));
  assert.notEqual(changes.at(-1).packages.get("example").identity, before.identity);
  assert.deepEqual(changes.at(-1).changed, ["example"]);
  assert.deepEqual(changes.at(-1).changedInstallationPaths, [directory]);
  assert.deepEqual(forbidden, []);
});

test("delayed initial package watches recheck metadata changed after inventory publication", async t => {
  const control = controlledWatches();
  const { libraries: [library], inventory, changes, install, settle } = fixture(t, 0, { watch: control.watch });
  const directory = install(library);
  inventory.setLibraryPaths([library]);
  const group = inventory.watchers.get(library);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const refresh = group.refresh.bind(group);
  group.refresh = async revision => { await blocked; return refresh(revision); };
  await waitForInventoryPublication(inventory, () => changes.length > 0);
  assert.equal(group.directories.has(directory), false);
  fs.writeFileSync(path.join(directory, "DESCRIPTION"), "Package: example\nVersion: changed during setup\n");
  release();
  await settle(() => matchesDescription(changes.at(-1)?.packages.get("example"), directory),
    "new package watches must catch metadata changes during asynchronous setup");
  assert.equal(group.directories.has(directory), true);
});

for (const operation of ["watcher", "change detection", "00LOCK", "00LOCK/00new"]) {
  test(`${operation} stops oversized enumeration and closes its directory`, async t => {
    let oversizedPath;
    const listings = [];
    const control = controlledWatches();
    const f = fixture(t, 0, { watch: control.watch, promises: { ...fs.promises,
      opendir: async (file, ...args) => {
        if (file !== oversizedPath) return fs.promises.opendir(file, ...args);
        const listing = { reads: 0, closed: false };
        listings.push(listing);
        return {
          read: async () => {
            assert.ok(++listing.reads <= 4097, 'do not enumerate beyond the overflow sentinel');
            return { name: 'entry' + listing.reads, isDirectory: () => false, isSymbolicLink: () => false };
          },
          close: async () => { listing.closed = true; },
        };
      },
    } });
    const [library] = f.libraries;
    const target = operation.startsWith('00LOCK') ? path.join(library, operation) : library;
    fs.mkdirSync(target, { recursive: true });
    f.inventory.setLibraryPaths([library]);
    await f.settle();
    oversizedPath = target;
    if (operation === 'watcher') {
      f.inventory.watchers.get(library).scheduleRefresh();
      await f.settle(() => f.logs.some(line => line.includes('library entry budget')));
      assert.equal(f.inventory.watchers.get(library).directories.size, 1);
    } else {
      if (operation === 'change detection') f.inventory.unconfirmedLibraries.add(library);
      else f.inventory.dirtyLibraries.add(library);
      await f.inventory.refresh();
      await f.settle(() => f.changes.at(-1).libraries[0].suspended);
      assert.equal(f.inventory.watchers.size, 0);
      assert.equal(f.inventory.retryTimer, undefined);
    }
    assert.ok(listings.length > 0);
    assert.ok(listings.every(listing => listing.reads === 4097 && listing.closed));
    const count = listings.length;
    await f.inventory.refresh();
    assert.equal(listings.length, count, 'overflow does not leave a recurring enumeration');
  });
}

for (const action of ['dispose', 'remove', 'pause', 'coalesce events']) {
  test(`in-flight watcher enumeration handles ${action} without overlapping or stale registrations`, async t => {
    const watcherReads = new (require("node:async_hooks").AsyncLocalStorage)();
    let library, block = false, entered, release;
    const begun = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    let opens = 0, active = 0, peak = 0, closes = 0;
    const control = controlledWatches();
    const f = fixture(t, 0, { watch: control.watch, promises: { ...fs.promises,
      opendir: async (file, ...args) => {
        const handle = await fs.promises.opendir(file, ...args);
        if (!block || file !== library || !watcherReads.getStore()) return handle;
        opens++;
        peak = Math.max(peak, ++active);
        let first = true;
        return {
          read: async () => {
            const entry = await handle.read();
            if (first) { first = false; entered(); await blocked; }
            return entry;
          },
          close: async () => { await handle.close(); active--; closes++; },
        };
      },
    } });
    t.after(() => release());
    [library] = f.libraries;
    f.inventory.setLibraryPaths([library]);
    await f.settle();
    const group = f.inventory.watchers.get(library);
    const refresh = group.refresh.bind(group);
    group.refresh = revision => watcherReads.run(true, () => refresh(revision));
    // Registration requests an inventory check. Count only the watcher's
    // reads when asserting that watcher reconciliations cannot overlap.
    const scan = f.inventory.scan.bind(f.inventory);
    f.inventory.scan = (...args) => watcherReads.run(false, () => scan(...args));
    const added = f.install(library, '1', 'added');
    block = true;
    group.scheduleRefresh();
    await begun;
    // The pending filesystem operation must leave the event loop responsive.
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(group.directories.has(added), false);
    if (action === 'dispose') f.inventory.dispose();
    else if (action === 'remove') f.inventory.setLibraryPaths([]);
    else if (action === 'pause') f.inventory.setRuntimeBusy(true);
    else for (let i = 0; i < 20; i++) group.scheduleRefresh();
    release();
    await group.refreshPromise;
    assert.equal(closes, 1);
    if (action !== 'coalesce events') assert.equal(group.directories.has(added), false);
    if (action === 'pause') f.inventory.setRuntimeBusy(false);
    if (action === 'pause' || action === 'coalesce events') {
      await f.settle(() => group.directories.has(added));
      assert.equal(opens, 2, 'one queued reconciliation observes the latest directory');
      assert.equal(closes, 2);
    } else {
      assert.equal(group.closed, true);
      assert.equal(group.timer, undefined);
      assert.equal(opens, 1);
    }
    assert.equal(peak, 1, 'a watcher has at most one directory enumeration in flight');
    assert.equal(active, 0);
  });
}
