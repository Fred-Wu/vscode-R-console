const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createConsoleLsp } = require("./helpers/console-lsp.cjs");

function temporaryLibraries(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-lsp-libraries-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const session = path.join(directory, "session");
  const configured = path.join(directory, "configured");
  fs.mkdirSync(session);
  fs.mkdirSync(configured);
  return { session, configured };
}

test("real R keeps startup completion working while the first session snapshot arrives", { timeout: 90000 }, async (t) => {
  let synchronized = false;
  const { client, instances, complete, logs } = createConsoleLsp(t, {
    afterResponse: async (method) => {
      if (method === "rConsole/checkPackageChanges" && !synchronized) {
        synchronized = true;
        // Empty explicit paths retain the server's normal R libraries.
        await client.syncSessionState({ attachedPackages: ["stats"], libraryPaths: [] });
      }
    },
  });
  const items = await complete();
  assert.ok(synchronized, "deliver the initial snapshot during completion preparation");
  assert.ok(items?.some((item) => item.label === "lm"), "the first completion must succeed");
  assert.equal(instances.length, 1, "the initial snapshot must not replace the server");
  for (const text of ["stats::lm", "stats::l", "stats::lm"]) {
    assert.ok((await complete(text))?.some((item) => item.label === "lm"));
  }
  assert.equal(instances.length, 1, "repeated typing and Tab requests must reuse the server");
  assert.equal(instances[0].requests.filter(({ method }) => method === "rConsole/syncSessionState").length, 1,
    "unchanged session state is synchronized only once");
  assert.ok(!logs.some((line) => /stopped|ECONNRESET/.test(line)), "startup must have no connection reset");
});

test("real R completes the original request across a genuine library-path restart", { timeout: 90000 }, async (t) => {
  const { session, configured } = temporaryLibraries(t);
  let synchronized = false;
  const state = { attachedPackages: ["stats"], libraryPaths: [session] };
  const { client, instances, complete } = createConsoleLsp(t, {
    libraries: [configured],
    afterResponse: async (method) => {
      if (method === "rConsole/checkPackageChanges" && !synchronized) {
        synchronized = true;
        await client.syncSessionState(state);
      }
    },
  });
  const items = await complete();
  assert.ok(items?.some((item) => item.label === "lm"), "return suggestions for the original Tab request");
  assert.equal(instances.length, 2, "a new effective library requires exactly one replacement");
  assert.equal(instances[1].opened.length, 1, "reopen the virtual console document after replacement");
  await client.syncSessionState(state);
  assert.ok((await complete())?.some((item) => item.label === "lm"));
  assert.equal(instances.length, 2, "unchanged libraries must not trigger another replacement");
});

test("real R starts with cached session libraries and recognizes equivalent folder names", { timeout: 90000 }, async (t) => {
  const { session, configured } = temporaryLibraries(t);
  const { client, instances, complete } = createConsoleLsp(t, { libraries: [configured] });
  await client.syncSessionState({ attachedPackages: ["stats"], libraryPaths: [session] });
  assert.ok((await complete())?.some((item) => item.label === "lm"));
  const equivalent = session.replaceAll(path.sep, "/") + "/./";
  await client.syncSessionState({ attachedPackages: ["stats"], libraryPaths: [
    equivalent, session, path.join(session, "does-not-exist"),
  ] });
  assert.ok((await complete())?.some((item) => item.label === "lm"));
  assert.equal(instances.length, 1, "R resolves duplicates, missing folders, and equivalent paths without restarting");
  const running = instances[0];
  assert.deepEqual(await running.sendRequest("rConsole/syncSessionState", {
    attachedPackages: ["stats"], libraryPaths: [configured],
  }), { restartRequired: true }, "removing a session library must not retain it as a fallback");
  assert.equal(await running.sendRequest("rConsole/syncSessionState", {
    attachedPackages: ["stats"], libraryPaths: [session, configured],
  }), true, "checking a changed search order must restore the running server's libraries");
});
