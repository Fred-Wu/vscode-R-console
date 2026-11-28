const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

function fixture(t, overrides = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-identity-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = directory => {
    fs.mkdirSync(path.join(directory, "Meta"), { recursive: true });
    // The monitor does not interpret file contents, even when they are invalid.
    fs.writeFileSync(path.join(directory, "DESCRIPTION"), "opaque metadata");
    fs.writeFileSync(path.join(directory, "Meta", "package.rds"), "opaque R metadata");
    return directory;
  };
  const forbidden = method => () => assert.fail(`package inspection must not use ${method}`);
  const calls = [];
  const promises = { ...fs.promises };
  for (const method of ["open", "readFile", "realpath", "stat", "readlink", "access", "readdir"])
    promises[method] = forbidden(method);
  promises.lstat = async (file, ...args) => {
    calls.push(file);
    return (overrides.lstat ?? fs.promises.lstat)(file, ...args);
  };
  const { inspectInstallation } = loadSource("src/Language/packageInstallationIdentity.ts", { fs: {
    ...fs, promises, openSync: forbidden("openSync"), readFileSync: forbidden("readFileSync"),
    realpathSync: forbidden("realpathSync"), statSync: forbidden("statSync"), readlinkSync: forbidden("readlinkSync"),
  } });
  return { root, install, calls, inspect: inspectInstallation };
}

test("ordinary installations use only metadata; same-version and in-place changes invalidate identity", async t => {
  const { root, install, inspect } = fixture(t);
  const directory = install(path.join(root, "example"));
  const before = await inspect(directory, () => true);
  assert.ok(before?.identity);
  assert.deepEqual(await inspect(directory, () => true), before);
  fs.writeFileSync(path.join(directory, "DESCRIPTION"), "opaque metadata, updated");
  const updated = await inspect(directory, () => true);
  assert.notEqual(updated.identity, before.identity);
  fs.writeFileSync(path.join(directory, "Meta", "package.rds"), "new metadata contents");
  const reinstalled = await inspect(directory, () => true);
  assert.notEqual(reinstalled.identity, updated.identity);
  assert.equal(await inspect(fs.mkdirSync(path.join(root, "not-a-package"), { recursive: true }), () => true), undefined);
  fs.rmSync(directory, { recursive: true });
  assert.equal(await inspect(directory, () => true), undefined);
});

test("symlink entries are tracked without inspecting their destinations", async t => {
  const { root, install, inspect, calls } = fixture(t);
  const directory = path.join(root, "example");
  const first = install(path.join(root, "cache1")), second = install(path.join(root, "cache2"));
  const kind = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(first, directory, kind);
  const before = await inspect(directory, () => true);
  assert.equal(before.linked, true);
  assert.deepEqual(calls, [directory]);
  fs.writeFileSync(path.join(first, "DESCRIPTION"), "updated cache metadata");
  assert.deepEqual(await inspect(directory, () => true), before);
  fs.unlinkSync(directory);
  fs.symlinkSync(second, directory, kind);
  const after = await inspect(directory, () => true);
  assert.equal(after.linked, true);
  assert.notEqual(after.identity, before.identity);
  assert.ok(calls.every(file => file === directory));
});

for (const component of ["package", "Meta", "root"]) {
  test(`a ${component} replacement during inspection stops nested metadata access`, async t => {
    let directory, target, swapped = false, valid = true;
    const { root, install, inspect, calls } = fixture(t, { lstat: async (file, ...args) => {
      const result = await fs.promises.lstat(file, ...args);
      const replace = component === "Meta" ? path.join(directory, "Meta") : directory;
      if (!swapped && file === replace) {
        swapped = true;
        if (component === "root") valid = false;
        else {
          fs.renameSync(replace, replace + "-old");
          fs.symlinkSync(component === "Meta" ? path.join(target, "Meta") : target, replace,
            process.platform === "win32" ? "junction" : "dir");
        }
      }
      return result;
    } });
    directory = install(path.join(root, "example"));
    target = install(path.join(root, "external"));
    if (component === "root") assert.equal(await inspect(directory, () => valid), undefined);
    else await assert.rejects(inspect(directory, () => valid), { code: "ESTALE" });
    assert.ok(swapped);
    assert.deepEqual(calls, component === "Meta" ? [directory, path.join(directory, "Meta")] : [directory]);
  });
}
