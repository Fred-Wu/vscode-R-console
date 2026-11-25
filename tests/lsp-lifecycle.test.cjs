const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createConsoleLsp } = require("./helpers/console-lsp.cjs");
const loadSource = require("./helpers/load-source.cjs");
const { staticFixtureAccess, staticFixtureProvider, completeStatic } = require("./helpers/static-completion.cjs");

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

test("installed package chain signatures also supply arguments without running the chain", { timeout: 90000 }, async t => {
  const { session } = temporaryLibraries(t);
  const pkg = 'rconsolechaintest';
  const source = path.join(path.dirname(session), pkg);
  const marker = path.join(path.dirname(session), 'chain-executed');
  fs.mkdirSync(path.join(source, 'R'), { recursive: true });
  fs.writeFileSync(path.join(source, 'DESCRIPTION'), [
    'Package: ' + pkg, 'Version: 1.0', 'Title: Chain Completion Test', 'Description: A test package.',
    'Author: Test', 'Maintainer: Test <test@example.org>', 'License: MIT', '',
  ].join('\n'));
  fs.writeFileSync(path.join(source, 'NAMESPACE'), 'export(api)\n');
  fs.writeFileSync(path.join(source, 'R', 'api.R'), `collect_impl <- function(engine = c("auto", "streaming"), optimize = TRUE, ...) {
    file.create(${JSON.stringify(marker)})
    NULL
  }
  api <- list(scan = function(path) {
    file.create(${JSON.stringify(marker)})
    list(collect = collect_impl)
  })\n`);
  execFileSync(process.env.R_TEST_EXECUTABLE || 'R', [
    'CMD', 'INSTALL', '--no-byte-compile', '--no-test-load', '-l', session, source,
  ], { stdio: 'pipe' });
  let inspections = 0;
  let inspection = { status: 'unavailable' };
  const cache = path.join(path.dirname(session), 'package-cache');
  const { client } = createConsoleLsp(t, { libraries: [session],
    env: { ...process.env, R_LANGSVR_PACKAGE_CACHE_DIR: cache },
    requestRuntimeFunctionArguments: () => { inspections++; return inspection; } });
  await client.syncSessionState({ attachedPackages: [pkg] });
  await waitFor(() => fs.existsSync(path.join(cache, 'package-metadata')) &&
    fs.readdirSync(path.join(cache, 'package-metadata')).some(name => name.startsWith(pkg + '-members-')),
  'native member metadata must be prepared before the first completion request');
  assert.equal(fs.existsSync(marker), false, 'background preparation must not run receiver expressions');
  const { getCompletionContext, collectCompletionEntries } = loadSource('src/Language/completion.ts', {
    vscode: { CompletionItemKind: { Method: 1, Function: 2, Field: 4, Variable: 5, Text: 0 }, SnippetString: class {} },
  });
  let staticMode = true;
  const collect = async marked => {
    const cursor = marked.indexOf('│'), text = marked.replace('│', '');
    const before = text.slice(0, cursor), lines = text.split('\n'), row = before.split('\n').length - 1;
    const col = before.split('\n').at(-1).length;
    const result = await collectCompletionEntries(getCompletionContext(lines[row], col, before, text.slice(cursor)),
      { version: 1, getText: () => text, uri: client.inputDocument.uri }, { line: row, character: col }, undefined, lines.slice(0, row), [], {
        ...staticFixtureProvider(client),
        provideCompletionItems: async (...args) => {
          const response = await client.provideCompletionItems(...args);
          return { ...response, items: response.items.map(item => ({ ...item, kind: item.kind - 1 })) };
        },
      }, undefined, undefined, undefined, staticMode ? 'static' : 'runtime', staticFixtureAccess());
    assert.equal(fs.existsSync(marker), false, 'completion must not execute constructors or methods');
    return result;
  };
  const deadline = Date.now() + 20000;
  for (;;) {
    const text = pkg + '::api$scan()$collect';
    const members = await completeStatic(client, { getText: () => text },
      { line: 0, character: text.length });
    if (members.items.some(item => item.label === 'collect' && item.detail?.includes('engine'))) break;
    assert.ok(Date.now() < deadline, 'the method popup has a signature supplied by installed package metadata: ' + JSON.stringify(members));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  client.setRuntimeSignatures({ collect: 'function(unrelated_global)' });
  for (const [marked, expected] of [
    ['api$scan()$collect(│)', ['engine', 'optimize', '...']],
    ['api$scan()$collect(engine = "auto", op│)', ['optimize']],
    [pkg + '::api$scan()$collect("auto", │)', ['optimize', '...']],
    ['alias <- ' + pkg + '::api\nalias$scan()$collect(│)', ['engine', 'optimize', '...']],
  ]) {
    const entries = await collect(marked);
    assert.deepEqual(entries.filter(item => item.role === 'argument').map(item => item.label), expected, marked);
    assert.equal(entries.argumentsResolved, true, marked);
  }
  const values = await collect('api$scan()$collect(engine = "st│")');
  assert.ok(values.some(item => item.role === 'value' && item.label === 'streaming'));
  const unknown = await collect('unknown_factory()$collect(│)');
  assert.deepEqual(unknown.filter(item => item.role === 'argument'), []);
  assert.equal(unknown.argumentsResolved, false);
  for (const marked of ['api <- unknown_factory()\napi$scan()$collect(│)',
    'function(api) api$scan()$collect(│)']) {
    assert.deepEqual((await collect(marked)).filter(item => item.role === 'argument'), [], marked);
  }
  await client.syncSessionState({ attachedPackages: [] });
  assert.deepEqual((await collect('api$scan()$collect(│)')).filter(item => item.role === 'argument'), [],
    'preparation must not retain members of a detached package');
  staticMode = false;
  client.setStaticAnalysis(staticMode);
  assert.deepEqual((await collect(pkg + '::api$scan()$collect(│)'))
    .filter(item => item.role === 'argument'), [], 'source inference stays opt-in');
  assert.equal(inspections, 0, 'an executable receiver must not reach runtime inspection');
  await client.syncSessionState({ attachedPackages: [pkg] });
  staticMode = true;
  client.setStaticAnalysis(staticMode);
  inspection = { status: 'arguments', names: ['live_arg'] };
  assert.deepEqual((await collect('api$scan(│)')).filter(item => item.role === 'argument')
    .map(item => item.label), ['live_arg'], 'live global shadows attached package catalog');
  for (const result of [inspection, { status: 'suppressed', reason: 'active-binding' },
    { status: 'unavailable' }, undefined, Promise.resolve(undefined)]) {
    inspection = result;
    assert.deepEqual((await collect('api <- list(scan = function(draft_arg) NULL)\napi$scan(│)'))
      .filter(item => item.role === 'argument').map(item => item.label), ['draft_arg']);
    assert.deepEqual((await collect('api <- unknown_factory()\napi$scan(│)'))
      .filter(item => item.role === 'argument'), []);
    if ((await result)?.status !== 'arguments') {
      assert.deepEqual((await collect('api$scan(│)')).filter(item => item.role === 'argument'), [],
        'a refused or unavailable live binding cannot borrow its package namesake');
    }
    assert.deepEqual((await collect(pkg + '::api$scan(│)')).filter(item => item.role === 'argument')
      .map(item => item.label), ['path'], 'explicit namespace retains package identity');
  }

});

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
  // R canonicalizes Windows library roots; match the unique project folder
  // and inventory count rather than comparing its entire absolute path.
  const projectLibrary = `${path.basename(directory)}/.uvr/library - 1 package`;
  await waitFor(() => logs.some(line =>
    line.replaceAll("\\", "/").toLowerCase().includes(projectLibrary.toLowerCase())),
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


test("real console library-path IPC updates package completion, precedence and removal", { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-live-libpaths-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const packageName = "rconsolelivepaths";
  const source = path.join(root, "source");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.mkdirSync(path.join(source, "R"), { recursive: true });
  fs.writeFileSync(path.join(source, "DESCRIPTION"), [
    "Package: " + packageName, "Version: 1.0", "Title: Runtime Library Test",
    "Description: Test package precedence.", "Author: Test",
    "Maintainer: Test <test@example.org>", "License: MIT", "",
  ].join("\n"));
  const install = (library, exported) => {
    fs.writeFileSync(path.join(source, "NAMESPACE"), "export(" + exported + ")\n");
    fs.writeFileSync(path.join(source, "R", "function.R"), exported + " <- function() NULL\n");
    execFileSync(process.env.R_TEST_EXECUTABLE || "R",
      ["CMD", "INSTALL", "--no-byte-compile", "--no-test-load", "-l", library, source],
      { stdio: "pipe" });
  };
  install(first, "fromFirstLibrary");
  install(second, "fromSecondLibrary");

  const { RustSidecarRuntimeBackend, getBundledRustSidecarPath } =
    loadSource("src/Runtime/runtimeBackend.ts");
  const { client, complete, logs } = createConsoleLsp(t, { cwd: root });
  const { RTermLang } = loadSource("src/Terminal/rTerminal/lang.ts", {
    vscode: {},
    "../../Language/consoleLspClient": { ConsoleLspClient: class { constructor() { return client; } } },
  });
  const { runtime } = require("./helpers/submission-terminal.cjs");
  const rHome = execFileSync(process.env.R_TEST_EXECUTABLE || "R", ["RHOME"],
    { encoding: "utf8" }).trim();
  const rPath = path.join(rHome, "bin", process.platform === "win32" ? "R.exe" : "R");
  const backend = new RustSidecarRuntimeBackend(getBundledRustSidecarPath(path.resolve(__dirname, "..")));
  let session;
  let pid;
  let failure;
  let stdout = "";
  const snapshots = [];
  const prompts = [];
  const lang = new RTermLang({ extensionPath: "", rPath, env: {} });
  // Exercise the production terminal->language bridge, not a direct LSP update.
  lang.consoleLsp = client;
  t.after(async () => {
    if (session) {
      backend.close(session);
      backend.detach(session);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (pid) {
        try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
      }
      fs.rmSync(path.join(os.tmpdir(), `r-console-session-${session.sessionId}.json`), { force: true });
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const check = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (!(await predicate())) {
      if (failure) throw failure;
      assert.ok(Date.now() < deadline,
        `${label}\n${stdout.slice(-500)}\n${logs.slice(-20).join("\n")}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const samePath = (a, b) => fs.realpathSync.native(a).replaceAll("\\", "/").toLowerCase() ===
    fs.realpathSync.native(b).replaceAll("\\", "/").toLowerCase();
  await client.start();
  await check(() => client.packageInventory.initialized, "initial language-server inventory");
  session = backend.start([rPath, "--vanilla", "--quiet"], {
    cwd: root, env: { ...process.env, R_HOME: rHome },
  });
  backend.attach(session, {
    onStdout: text => { stdout += text; },
    onStderr: text => { stdout += text; },
    onControl: event => {
      if (event.type === "library-paths") {
        snapshots.push(event.paths);
        runtime.handleRuntimeControl({ lang }, event);
      } else if (event.type === "prompt" && event.kind === "main") {
        prompts.push(event);
      }
    },
    onError: error => { failure = error; },
  });
  await check(() => backend.canUseSessionCommands(session) && snapshots.length > 0 &&
    prompts.length > 0, "initial authenticated R session and library snapshot");
  pid = backend.getPid(session);
  assert.ok(pid);
  const basePaths = snapshots.at(-1);
  const baselinePrompts = prompts.length;
  assert.equal(backend.sendSessionCommand(session, {
    type: "submit", code: 'baseline_paths <- .libPaths(); cat("BASE_PATHS_READY\\n")',
  }), true);
  await check(() => stdout.includes("BASE_PATHS_READY") && prompts.length > baselinePrompts,
    "baseline library paths assigned");
  const submitPaths = async (libraries, marker) => {
    const before = snapshots.length;
    const beforePrompts = prompts.length;
    const pathValues = [...libraries.map(lib => JSON.stringify(lib)), "baseline_paths"].join(", ");
    const command = `.libPaths(c(${pathValues})); cat("${marker}\\n")`;
    assert.equal(backend.sendSessionCommand(session, { type: "submit", code: command }), true);
    await check(() => snapshots.length > before && prompts.length > beforePrompts &&
      stdout.includes(marker), marker + " library snapshot");
    assert.ok(backend.canUseSessionCommands(session), "library changes must not disconnect R");
  };
  await submitPaths([first], "FIRST_LIBRARY_ACTIVE");
  await check(() => logs.some(line => line.includes("Added: " + packageName)),
    "first package addition observed");
  await check(async () => (await complete(packageName + "::"))?.some(item => item.label === "fromFirstLibrary"),
    "first library completion");
  await submitPaths([first, second], "SECOND_LIBRARY_ACTIVE");
  await check(() => client.packageInventory.libraries.some(lib => samePath(lib.path, second)),
    "second library inventory");
  await submitPaths([second, first], "REORDERED_LIBRARIES");
  await check(async () => {
    const items = await complete(packageName + "::");
    return items?.some(item => item.label === "fromSecondLibrary") &&
      !items.some(item => item.label === "fromFirstLibrary");
  }, "reordered library completion precedence");
  await submitPaths([], "REMOVED_LIBRARIES");
  await check(() => logs.some(line => line.includes("Removed: " + packageName)),
    "removed package inventory");
  await check(async () => {
    const items = await complete(packageName + "::");
    return !items?.some(item => item.label === "fromFirstLibrary" || item.label === "fromSecondLibrary");
  }, "removed library must not complete");
  assert.deepEqual(snapshots.at(-1), basePaths,
    "removing both libraries restores exactly the original console search order");
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

function lifecycleFixture(t) {
  const { session: first, configured: second } = temporaryLibraries(t);
  const root = path.dirname(first), pkg = "rconsolelifecycleprobe", source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "R"), { recursive: true });
  fs.writeFileSync(path.join(source, "DESCRIPTION"), [
    `Package: ${pkg}`, "Version: 1.0", "Title: Lifecycle Probe", "Description: A test package.",
    "Author: Test", "Maintainer: Test <test@example.org>", "License: MIT", "",
  ].join("\n"));
  const install = (library, exported) => {
    fs.writeFileSync(path.join(source, "NAMESPACE"), `export(${exported})\n`);
    fs.writeFileSync(path.join(source, "R", "f.R"), `${exported} <- function() NULL\n`);
    execFileSync(process.env.R_TEST_EXECUTABLE || "R", ["CMD", "INSTALL", "--no-byte-compile",
      "--no-test-load", "-l", library, source], { stdio: "pipe" });
  };
  const defaults = execFileSync("Rscript", ["--vanilla", "-e", 'cat(.libPaths(), sep="\\n")'],
    { encoding: "utf8" }).trim().split(/\r?\n/);
  return { first, second, root, pkg, install, defaults };
}

test("replacement restores startup options with the new package copy before loading namespaces", { timeout: 90000 }, async t => {
  const { first, second, root, pkg, install, defaults } = lifecycleFixture(t);
  install(first, "originalExport"); install(second, "replacementExport");
  const marker = path.join(root, "profile-runs");
  fs.writeFileSync(path.join(root, ".Renviron"), `R_DEFAULT_PACKAGES=datasets,utils,grDevices,graphics,stats,methods,${pkg}\nR_LIBS_USER="${first.replaceAll("\\", "/")}"\n`);
  fs.writeFileSync(path.join(root, ".Rprofile"), [
    `.libPaths(c(${JSON.stringify(first)}, .libPaths()))`,
    `library(${pkg})`,
    'library(utils)',
    'options(defaultPackages = character(), languageserver.max_completions = 7L)',
    `cat(Sys.getpid(), "\\n", file=${JSON.stringify(marker)}, append=TRUE)`,
  ].join("\n"));
  const env = { ...process.env }; delete env.R_PROFILE_USER; delete env.R_ENVIRON_USER;
  const { client, instances, complete, logs } = createConsoleLsp(t, { cwd: root, args: [], env });
  client.updateRuntimeLibraryPaths([first, second, ...defaults]);
  await client.start();
  await waitFor(() => client.packageInventory.initialized, "initial inventory");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "originalExport"));
  client.updateRuntimeLibraryPaths([second, first, ...defaults]);
  await waitFor(() => logs.some(line => line.includes("Selected copy changed: " + pkg)), "confirmed switch");
  const items = await complete(pkg + "::");
  assert.ok(items.some(item => item.label === "replacementExport"));
  assert.ok(!items.some(item => item.label === "originalExport"));
  assert.equal(instances.length, 2);
  assert.ok(!fs.readFileSync(marker, "utf8").trim().split(/\s+/).includes(String(client.spawnedServer.pid)),
    "replacement must not re-execute profiles that preload stale namespaces");
  assert.equal((await complete("stats::")).length, 7, "profile completion options survive a clean restart");
});

test("site libraries excluded by a live snapshot stay excluded on startup and refresh", { timeout: 90000 }, async t => {
  const { first, pkg, install, defaults } = lifecycleFixture(t);
  install(first, "siteExport");
  const env = { ...process.env, R_LIBS_SITE: first };
  const { client, complete, instances } = createConsoleLsp(t, { env, args: [] });
  // A console can produce this snapshot with .libPaths(defaults, include.site=FALSE).
  client.updateRuntimeLibraryPaths(defaults);
  await client.start();
  await waitFor(() => client.packageInventory.initialized, "initial inventory");
  const paths = await instances.at(-1).sendRequest("rConsole/libraryPaths", {});
  assert.ok(!paths.some(value => fs.realpathSync(value) === fs.realpathSync(first)));
  assert.ok(!(await complete(pkg + "::")).some(item => item.label === "siteExport"));
  client.updateRuntimeLibraryPaths([first, ...defaults]);
  await waitFor(() => client.packageInventory.packages.has(pkg), "site library explicitly added");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "siteExport"));
  client.updateRuntimeLibraryPaths(defaults);
  await waitFor(() => !client.packageInventory.packages.has(pkg), "site library removed again");
  assert.ok(!(await complete(pkg + "::")).some(item => item.label === "siteExport"));
});

test("unrelated abandoned locks do not retain removed namespace metadata", { timeout: 90000 }, async t => {
  const { first, pkg, install } = lifecycleFixture(t);
  install(first, "installedExport");
  const { client, complete } = createConsoleLsp(t, { libraries: [first] });
  await client.start();
  await waitFor(() => client.packageInventory.initialized, "initial inventory");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "installedExport"));
  fs.mkdirSync(path.join(first, "00LOCK-unrelated"));
  execFileSync("Rscript", ["--vanilla", "-e", `remove.packages("${pkg}", lib=${JSON.stringify(first)})`], { stdio: "pipe" });
  await waitFor(() => !client.packageInventory.packages.has(pkg), "removal with unrelated locks present");
  assert.ok(!(await complete(pkg + "::")).some(item => item.label === "installedExport"));
});

test("linked cache changes refresh namespace exports without touching the library link", { timeout: 90000 }, async t => {
  const { first, second: cache, pkg, install } = lifecycleFixture(t);
  install(cache, "originalExport");
  const target = path.join(cache, pkg);
  fs.symlinkSync(target, path.join(first, pkg), process.platform === "win32" ? "junction" : "dir");
  const { client, complete } = createConsoleLsp(t, { libraries: [first] });
  await client.start();
  await waitFor(() => client.packageInventory.initialized, "initial inventory");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "originalExport"));
  const originalIdentity = client.packageInventory.packages.get(pkg).identity;
  install(cache, "replacementExport");
  await waitFor(() => client.packageInventory.packages.get(pkg)?.identity !== originalIdentity, "external cache replacement");
  const items = await complete(pkg + "::");
  assert.ok(items.some(item => item.label === "replacementExport"));
  assert.ok(!items.some(item => item.label === "originalExport"));
  fs.rmSync(target, { recursive: true });
  await waitFor(() => !client.packageInventory.packages.has(pkg), "external cache removal");
  assert.ok(!(await complete(pkg + "::")).some(item => item.label === "replacementExport"));
});

test("initial locked namespaces stay usable and an excluded startup namespace is retired", { timeout: 90000 }, async t => {
  const { first, pkg, install, defaults } = lifecycleFixture(t);
  install(first, "startupExport");
  const env = { ...process.env, R_LIBS_USER: first,
    R_DEFAULT_PACKAGES: `datasets,utils,grDevices,graphics,stats,methods,${pkg}` };
  const lock = path.join(first, "00LOCK-" + pkg);
  fs.mkdirSync(lock);
  const { client, instances, complete } = createConsoleLsp(t, { env, libraries: [first] });
  await client.start();
  await waitFor(() => client.packageInventory.initialized, "initial locked inventory");
  assert.equal(instances.length, 1, "a locked startup namespace must not cause a restart loop");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "startupExport"));
  fs.rmdirSync(lock);
  await waitFor(() => client.packageInventory.packages.has(pkg), "unlocked installation");
  await client.dispose();
  // A fresh console snapshot can already exclude a default package loaded by R startup.
  const next = createConsoleLsp(t, { env });
  next.client.updateRuntimeLibraryPaths(defaults);
  await next.client.start();
  await waitFor(() => next.client.packageInventory.initialized, "excluded startup namespace reconciled");
  assert.equal(next.instances.length, 2);
  assert.ok(!(await next.complete(pkg + "::")).some(item => item.label === "startupExport"));
});
