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
      if (inventory.disposed || (inventory.initialized && !inventory.timer && !inventory.pending && !inventory.dirtyLibraries.size)) return;
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
  const { libraries: [library], inventory, changes, install, settle } = fixture(t);
  inventory.setLibraryPaths([library]);
  await settle();
  const count = changes.length;
  const lock = path.join(library, "00LOCK-example");
  fs.mkdirSync(lock);
  await settle();
  assert.equal(changes.length, count);
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
