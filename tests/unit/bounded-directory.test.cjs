const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

function fixture({ count = 1, opening = async () => {}, reading = async () => {} } = {}) {
  let opens = 0, reads = 0, closes = 0;
  const api = loadSource("src/Language/boundedDirectory.ts", {
    fs: { promises: { opendir: async (_directory, options) => {
      opens++;
      assert.equal(options.bufferSize, 32, "native read-ahead stays bounded");
      await opening();
      return {
        read: async () => {
          reads++;
          await reading(reads);
          return reads <= count ? { name: "entry" + reads } : null;
        },
        close: async () => { closes++; },
      };
    } } },
  });
  return { ...api, counts: () => ({ opens, reads, closes }) };
}

for (const count of [0, 4096, 4097, 1000000]) {
  test(`directory enumeration bounds reads and closes its handle (${count} entries)`, async () => {
    const f = fixture({ count });
    if (count > 4096) {
      await assert.rejects(f.readBoundedDirectory("library", () => true), f.DirectoryEntryLimitError);
    } else {
      const entries = await f.readBoundedDirectory("library", () => true);
      assert.equal(entries.length, count);
    }
    assert.deepEqual(f.counts(), { opens: 1, reads: Math.min(count + 1, 4097), closes: 1 });
  });
}

test("cancelled enumeration does not open a directory", async () => {
  const f = fixture();
  assert.equal(await f.readBoundedDirectory("library", () => false), undefined);
  assert.deepEqual(f.counts(), { opens: 0, reads: 0, closes: 0 });
});

for (const stage of ["opening", "reading"]) {
  test(`cancellation during ${stage} closes the handle and discards partial results`, async () => {
    let current = true, entered, release;
    const begun = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const f = fixture({ count: 20, [stage]: async () => { entered(); await blocked; } });
    const pending = f.readBoundedDirectory("library", () => current);
    await begun;
    current = false;
    release();
    assert.equal(await pending, undefined);
    assert.deepEqual(f.counts(), { opens: 1, reads: stage === "opening" ? 0 : 1, closes: 1 });
  });
}

for (const stage of ["reading", "validation"]) {
  test(`an error during ${stage} closes the directory without returning a partial listing`, async () => {
    const error = new Error("directory unavailable");
    let invalid = false;
    const f = fixture({ count: 20, reading: async count => {
      if (count !== 3) return;
      if (stage === "reading") throw error;
      invalid = true;
    } });
    await assert.rejects(f.readBoundedDirectory("library", () => {
      if (invalid) throw error;
      return true;
    }), value => value === error);
    assert.deepEqual(f.counts(), { opens: 1, reads: 3, closes: 1 });
  });
}

test("a failed directory open propagates its error", async () => {
  const error = Object.assign(new Error("offline"), { code: "EIO" });
  const f = fixture({ opening: async () => { throw error; } });
  await assert.rejects(f.readBoundedDirectory("library", () => true), value => value === error);
  assert.deepEqual(f.counts(), { opens: 1, reads: 0, closes: 0 });
});

test("asynchronous validation bounds filesystem checks to batches and validates the final EOF", async () => {
  const f = fixture({ count: 4096 });
  let validations = 0;
  const entries = await f.readBoundedDirectory("library", () => true, async () => { validations++; return true; });
  assert.equal(entries.length, 4096);
  assert.equal(validations, 131, "before/after open, 128 batches, and the EOF batch");
  assert.equal(f.counts().closes, 1);
});

for (const stage of ["before open", "after open", "after batch"]) {
  test(`cancellation during asynchronous validation ${stage} prevents further reads`, async () => {
    let current = true, entered, release, calls = 0;
    const begun = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const target = { "before open": 1, "after open": 2, "after batch": 3 }[stage];
    const f = fixture({ count: 100 });
    const pending = f.readBoundedDirectory("library", () => current, async () => {
      if (++calls === target) { entered(); await gate; }
      return true;
    });
    await begun;
    current = false;
    release();
    assert.equal(await pending, undefined);
    assert.deepEqual(f.counts(), { opens: target === 1 ? 0 : 1, reads: target === 3 ? 32 : 0, closes: target === 1 ? 0 : 1 });
  });
}

test("a changed pin during a batch discards every entry and stops before the next batch", async () => {
  let valid = true;
  const f = fixture({ count: 100, reading: async count => { if (count === 3) valid = false; } });
  assert.equal(await f.readBoundedDirectory("library", () => true, async () => valid), undefined);
  assert.deepEqual(f.counts(), { opens: 1, reads: 32, closes: 1 });
});

test("asynchronous validation failure closes an open handle", async () => {
  const f = fixture({ count: 100 });
  let calls = 0;
  await assert.rejects(f.readBoundedDirectory("library", () => true, async () => {
    if (++calls === 3) throw new Error("validation I/O failure");
    return true;
  }), /validation I\/O failure/);
  assert.deepEqual(f.counts(), { opens: 1, reads: 32, closes: 1 });
});

test("real directory iteration lists immediate entries without descending", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-bounded-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "package"));
  fs.writeFileSync(path.join(root, "package", "DESCRIPTION"), "metadata");
  fs.writeFileSync(path.join(root, "file"), "");
  const { readBoundedDirectory } = loadSource("src/Language/boundedDirectory.ts");
  const entries = await readBoundedDirectory(root, () => true);
  assert.deepEqual(entries.map(entry => entry.name).sort(), ["file", "package"]);
  assert.equal(entries.find(entry => entry.name === "package").isDirectory(), true);
});
