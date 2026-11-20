const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createConsoleLsp } = require("./helpers/console-lsp.cjs");
const loadSource = require("./helpers/load-source.cjs");

test("real R supplies abbreviation candidates with correct replacement ranges", { timeout: 60000 }, async t => {
  class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
  const completion = loadSource("src/Language/completion.ts", { vscode: {
    Position, Range: class {}, SnippetString: class {},
    CompletionItemKind: { Function: 3, Text: 1, Snippet: 15 },
  } });
  const { client } = createConsoleLsp(t);
  for (const query of ["rdcsv", "utils::rdcsv"]) {
    const context = completion.getCompletionContext(query, query.length, query);
    const entries = await completion.collectCompletionEntries(context, { getText: () => query },
      new Position(0, query.length), undefined, [], [], client);
    const entry = entries.find(entry => entry.label === "read.csv");
    assert.ok(entry, query);
    const pick = completion.toCompletionPick(entry, context);
    assert.equal(pick.replaceStart, query.indexOf("rdcsv"));
    assert.equal(pick.snapshotCursor, query.length);
    assert.match(pick.insertText, /^read\.csv\(/);
  }
});

function temporaryLibraries(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-lsp-libraries-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const session = path.join(directory, "session");
  const configured = path.join(directory, "configured");
  fs.mkdirSync(session);
  fs.mkdirSync(configured);
  return { session, configured };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test("project startup supplies package libraries without session path probes", { timeout: 120000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-project-"));
  let projectClient;
  t.after(async () => {
    await projectClient?.dispose();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const library = path.join(directory, ".uvr", "library");
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(directory, ".Rprofile"), '.libPaths(c(".uvr/library", .libPaths()))\n');
  const pkg = "ggprojecttest";
  const source = path.join(directory, pkg);
  fs.mkdirSync(path.join(source, "R"), { recursive: true });
  fs.writeFileSync(path.join(source, "DESCRIPTION"), [
    "Package: " + pkg, "Version: 1.0", "Title: Project Completion Test", "Description: A test package.",
    "Author: Test", "Maintainer: Test <test@example.org>", "License: MIT", "",
  ].join("\n"));
  fs.writeFileSync(path.join(source, "NAMESPACE"), "export(projectFunction)\n");
  fs.writeFileSync(path.join(source, "R", "f.R"), "projectFunction <- function() NULL\n");
  execFileSync(process.env.R_TEST_EXECUTABLE || "R", [
    "CMD", "INSTALL", "--no-byte-compile", "--no-test-load", "-l", library, source,
  ], { stdio: "pipe" });
  const env = { ...process.env };
  delete env.R_PROFILE_USER;
  const { client, complete, instances, logs } = createConsoleLsp(t, { cwd: directory, args: [], env });
  projectClient = client;
  assert.ok((await complete("ggp")).some(item => item.label === pkg), "bare prefixes find project packages");
  assert.ok((await complete(pkg + "::proj")).some(item => item.label === "projectFunction"));
  await waitFor(() => logs.some(line => line.includes(library.replaceAll(path.sep, "/"))),
    "the output channel lists the project library");
  assert.notEqual(client.workingDirectory, directory, "project startup must not enable project indexing");
  assert.ok(!instances[0].requests.some(request => request.method === "rConsole/syncSessionState"),
    "library discovery works without any session information");
  fs.rmSync(path.join(library, pkg), { recursive: true });
  await waitFor(() => logs.some(line => line.includes("Removed: " + pkg)), "project package removal");
  assert.ok(!(await complete("ggp")).some(item => item.label === pkg));
  await client.dispose();
  assert.ok(fs.existsSync(path.join(directory, ".Rprofile")), "disposal must preserve the project");
});

test("background package refresh preserves unaffected libraries and switches remaining copies", { timeout: 120000 }, async t => {
  const { session, configured } = temporaryLibraries(t);
  const pkg = "rconsoleinstalltest";
  const source = path.join(path.dirname(session), pkg);
  fs.mkdirSync(path.join(source, "R"), { recursive: true });
  fs.writeFileSync(path.join(source, "DESCRIPTION"), [
    "Package: " + pkg, "Version: 1.0", "Title: Completion Test", "Description: A test package.",
    "Author: Test", "Maintainer: Test <test@example.org>", "License: MIT", "",
  ].join("\n"));
  function install(library, name) {
    fs.writeFileSync(path.join(source, "R", "f.R"), name + " <- function() NULL\n");
    fs.writeFileSync(path.join(source, "NAMESPACE"), "export(" + name + ")\n");
    execFileSync(process.env.R_TEST_EXECUTABLE || "R", [
      "CMD", "INSTALL", "--no-byte-compile", "--no-test-load", "-l", library, source,
    ], { stdio: "pipe" });
  }
  const { client, complete, instances, logs } = createConsoleLsp(t, { libraries: [session, configured] });
  await client.start();
  await waitFor(() => logs.some(line => line.includes("unique package names")), "initial library inventory");
  fs.mkdirSync(path.join(session, "00LOCK-test"));
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.ok((await complete("stats::l")).some(item => item.label === "lm"));
  assert.equal(instances.length, 1, "lock-only changes must not restart the server");
  fs.rmdirSync(path.join(session, "00LOCK-test"));
  assert.ok(!(await complete(pkg + "::")).some(item => item.label === "probeOriginal"));

  install(configured, "probeOriginal");
  await waitFor(() => logs.some(line => line.includes("Added: " + pkg)), "installation notification without typing");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "probeOriginal"), "refresh a previously missing namespace without editing its input");
  const names = await complete(pkg.slice(0, -2));
  assert.equal(names.filter(item => item.label === pkg && item.data?.type === "package").length, 1);
  assert.equal(instances.length, 1, "adding an unloaded package retains the server");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "probeOriginal"));

  logs.length = 0;
  install(session, "probeReplacement");
  await waitFor(() => logs.some(line => line.includes("Selected copy changed: " + pkg)), "higher-priority copy refresh");
  const items = await complete(pkg + "::probe");
  assert.ok(items.some(item => item.label === "probeReplacement"));
  assert.ok(!items.some(item => item.label === "probeOriginal"));
  assert.equal(instances.length, 2, "changing the selected loaded namespace needs one replacement");
  assert.ok((await complete("stats::l")).some(item => item.label === "lm"),
    "the replacement language server rebuilds its own completion metadata");
  assert.ok(!fs.existsSync(path.join(client.workingDirectory, "package-metadata.rds")));

  logs.length = 0;
  fs.rmSync(path.join(configured, pkg), { recursive: true });
  await waitFor(() => logs.some(line => line.includes("Active package copies unchanged")), "inactive-copy removal");
  assert.equal(instances.length, 2);
  install(configured, "probeFallback");
  logs.length = 0;
  await waitFor(() => logs.some(line => line.includes("Added: " + pkg)), "inactive-copy installation");
  assert.equal(instances.length, 2);

  logs.length = 0;
  install(session, "probeUpdated");
  await waitFor(() => logs.some(line => line.includes("Updated: " + pkg)), "same-version replacement");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "probeUpdated"));
  assert.equal(instances.length, 3);

  logs.length = 0;
  fs.rmSync(path.join(session, pkg), { recursive: true });
  await waitFor(() => logs.some(line => line.includes("Using remaining copy: " + pkg)), "remaining library copy");
  const fallback = await complete(pkg + "::");
  assert.ok(fallback.some(item => item.label === "probeFallback"));
  assert.ok(!fallback.some(item => item.label === "probeUpdated"));
  assert.equal(instances.length, 4);

  logs.length = 0;
  fs.rmSync(path.join(configured, pkg), { recursive: true });
  await waitFor(() => logs.some(line => line.includes("no copies remain")), "last-copy removal");
  assert.ok(!(await complete(pkg.slice(0, -2))).some(item => item.label === pkg));
  assert.ok(!(await complete(pkg + "::")).some(item => item.label === "probeFallback"));
  assert.equal(instances.length, 5);
  assert.ok(instances.every(instance => !instance.requests.some(request => request.method === "rConsole/checkPackageChanges")));
});

test("real R refreshes linked project libraries when package links are added, replaced or removed", { timeout: 120000 }, async t => {
  const { session, configured } = temporaryLibraries(t);
  const root = path.dirname(session);
  const cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  const pkg = "rconsolelinkedtest";
  const source = path.join(root, pkg);
  fs.mkdirSync(path.join(source, "R"), { recursive: true });
  fs.writeFileSync(path.join(source, "DESCRIPTION"), [
    "Package: " + pkg, "Version: 1.0", "Title: Completion Test", "Description: A test package.",
    "Author: Test", "Maintainer: Test <test@example.org>", "License: MIT", "",
  ].join("\n"));
  function install(library, exported) {
    fs.writeFileSync(path.join(source, "R", "f.R"), exported + " <- function() NULL\n");
    fs.writeFileSync(path.join(source, "NAMESPACE"), "export(" + exported + ")\n");
    execFileSync(process.env.R_TEST_EXECUTABLE || "R", ["CMD", "INSTALL", "--no-byte-compile",
      "--no-test-load", "-l", library, source], { stdio: "pipe" });
  }
  install(configured, "originalExport");
  install(cache, "replacementExport");
  const { client, complete, instances, logs } = createConsoleLsp(t, { libraries: [session] });
  await client.start();
  await waitFor(() => logs.some(line => line.includes("unique package names")), "initial inventory");
  const link = path.join(session, pkg);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(path.join(configured, pkg), link, linkType);
  await waitFor(() => logs.some(line => line.includes("Added: " + pkg)), "linked package installation");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "originalExport"));
  assert.equal(instances.length, 1);

  logs.length = 0;
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(cache, pkg), link, linkType);
  await waitFor(() => logs.some(line => line.includes("Updated: " + pkg)), "linked package replacement");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "replacementExport"));
  assert.equal(instances.length, 2);

  logs.length = 0;
  fs.unlinkSync(link);
  await waitFor(() => logs.some(line => line.includes("no copies remain")), "linked package removal");
  assert.ok(!(await complete(pkg + "::")).some(item => item.label === "replacementExport"));
  assert.equal(instances.length, 3);
});

test("real R keeps startup completion working while the first session snapshot arrives", { timeout: 90000 }, async (t) => {
  let synchronized = false;
  const { client, instances, complete, logs } = createConsoleLsp(t, {
    afterResponse: async (method) => {
      if (method === "rConsole/libraryPaths" && !synchronized) {
        synchronized = true;
        await client.syncSessionState({ attachedPackages: ["stats"] });
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
