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
  const clients = [];
  t.after(async () => {
    // Windows holds the server's working directory open until the process exits.
    await Promise.all(clients.map(client => client.dispose()));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const session = path.join(directory, "session");
  const configured = path.join(directory, "configured");
  fs.mkdirSync(session);
  fs.mkdirSync(configured);
  const createClient = options => {
    const result = createConsoleLsp(t, options);
    clients.push(result.client);
    return result;
  };
  return { session, configured, createClient };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test("installed package chain signatures also supply arguments without running the chain", { timeout: 90000 }, async t => {
  const { session, createClient } = temporaryLibraries(t);
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
  const { client } = createClient({ libraries: [session],
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
  const { session, configured, createClient } = temporaryLibraries(t);
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
  const { client, complete, instances, logs } = createClient({ libraries: [session, configured] });
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
  const { session, configured, createClient } = temporaryLibraries(t);
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
  const { client, complete, instances, logs } = createClient({ libraries: [session] });
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


test("real console library-path IPC updates completion without filesystem monitoring", { timeout: 120000 }, async t => {
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
  let loseSyncReply = true;
  const { client, instances, complete, logs } = createConsoleLsp(t, { cwd: root,
    afterResponse: method => {
      if (method === "rConsole/syncLibraryPaths" && loseSyncReply) {
        loseSyncReply = false;
        throw new Error("Simulated lost library synchronization reply");
      }
    },
  });
  client.packageInventory.dispose();
  client.packageInventory.setLibraryPaths = () => {};
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
  await client.start();
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
  await check(async () => (await complete(packageName + "::"))?.some(item => item.label === "fromFirstLibrary"),
    "first library completion");
  await submitPaths([first, second], "SECOND_LIBRARY_ACTIVE");
  await client.libraryPathsSyncPromise;
  assert.deepEqual(await instances.at(-1).sendRequest("rConsole/libraryPaths", {}), snapshots.at(-1));
  await submitPaths([second, first], "REORDERED_LIBRARIES");
  await check(async () => {
    const items = await complete(packageName + "::");
    return items?.some(item => item.label === "fromSecondLibrary") &&
      !items.some(item => item.label === "fromFirstLibrary");
  }, "reordered library completion precedence");
  client.setStaticAnalysis(false);
  assert.ok((await complete(packageName + "::"))?.some(item => item.label === "fromSecondLibrary"),
    "live-mode namespace completion also uses the synchronized library order");
  await submitPaths([], "REMOVED_LIBRARIES");
  await check(async () => {
    const items = await complete(packageName + "::");
    return !items?.some(item => item.label === "fromFirstLibrary" || item.label === "fromSecondLibrary");
  }, "removed library must not complete");
  assert.deepEqual(snapshots.at(-1), basePaths,
    "removing both libraries restores exactly the original console search order");
  assert.ok(!instances.flatMap(instance => instance.requests)
    .some(request => request.method === "rConsole/refreshPackages"),
    "path synchronization must not depend on an inventory refresh");
  assert.equal(loseSyncReply, false, "exercise retry after R applies paths but the reply is lost");
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

// Windows R.exe launches Rterm.exe, so the launcher PID cannot identify the
// server. Its entry-point argument also distinguishes native metadata workers.
function recordServerEvent(file, event) {
  return `if (any(basename(commandArgs(TRUE)) == "console-language-server.R"))
    cat(${JSON.stringify(event + "\n")}, file=${JSON.stringify(file)}, append=TRUE)`;
}

function lifecycleFixture(t) {
  const { session: first, configured: second, createClient } = temporaryLibraries(t);
  const root = path.dirname(first), pkg = "rconsolelifecycleprobe", source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "R"), { recursive: true });
  const install = (library, exported, startup = "", packageName = pkg) => {
    fs.writeFileSync(path.join(source, "DESCRIPTION"), [
      `Package: ${packageName}`, "Version: 1.0", "Title: Lifecycle Probe", "Description: A test package.",
      "Author: Test", "Maintainer: Test <test@example.org>", "License: MIT", "",
    ].join("\n"));
    fs.writeFileSync(path.join(source, "NAMESPACE"), `export(${exported})\n`);
    fs.writeFileSync(path.join(source, "R", "f.R"), `${exported} <- function() NULL\n${startup}\n`);
    execFileSync(process.env.R_TEST_EXECUTABLE || "R", ["CMD", "INSTALL", "--no-byte-compile",
      "--no-test-load", "-l", library, source], { stdio: "pipe" });
  };
  const defaults = execFileSync("Rscript", ["--vanilla", "-e", 'cat(.libPaths(), sep="\\n")'],
    { encoding: "utf8" }).trim().split(/\r?\n/);
  return { first, second, root, pkg, install, defaults, createClient };
}

test("replacement restores startup options with the new package copy before loading namespaces", { timeout: 90000 }, async t => {
  const { first, second, root, pkg, install, defaults, createClient } = lifecycleFixture(t);
  const startupHook = '.onLoad <- function(...) stopifnot(identical(getOption("rconsole.lifecycle.option"), "ready"))';
  install(first, "originalExport", startupHook); install(second, "replacementExport", startupHook);
  const marker = path.join(root, "profile-runs");
  fs.writeFileSync(path.join(root, ".Renviron"), `R_DEFAULT_PACKAGES=datasets,utils,grDevices,graphics,stats,methods,${pkg}\nR_LIBS_USER="${first.replaceAll("\\", "/")}"\n`);
  fs.writeFileSync(path.join(root, ".Rprofile"), [
    `.libPaths(c(${JSON.stringify(first)}, .libPaths()))`,
    'options(defaultPackages = character(), languageserver.max_completions = 7L, rconsole.lifecycle.option = "ready")',
    `library(${pkg})`,
    'library(utils)',
    recordServerEvent(marker, "profile"),
  ].join("\n") + "\n");
  const env = { ...process.env }; delete env.R_PROFILE_USER; delete env.R_ENVIRON_USER;
  const { client, instances, complete, logs } = createClient({ cwd: root, args: [], env });
  client.updateRuntimeLibraryPaths([first, second, ...defaults]);
  await client.start();
  await waitFor(() => client.packageInventory.initialized, "initial inventory");
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "profile",
    "the initial server must execute the complete profile");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(client.workingDirectory).mode & 0o077, 0,
      "the language-server working directory must be private");
  }
  assert.ok(Buffer.isBuffer(client.startupState), "startup state stays in the client memory");
  assert.deepEqual(fs.readdirSync(client.workingDirectory), [], "startup must not persist a snapshot");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "originalExport"));
  client.updateRuntimeLibraryPaths([second, first, ...defaults]);
  await waitFor(() => logs.some(line => line.includes("Selected copy changed: " + pkg)), "confirmed switch");
  const items = await complete(pkg + "::");
  assert.ok(items.some(item => item.label === "replacementExport"));
  assert.ok(!items.some(item => item.label === "originalExport"));
  assert.equal(instances.length, 2);
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "profile",
    "replacement must not re-execute profiles that preload stale namespaces");
  assert.equal((await complete("stats::")).length, 7, "profile completion options survive a clean restart");
});

test("namespace-valued startup options deserialize after the environment and library order are restored", { timeout: 90000 }, async t => {
  const { first, second, root, pkg, install, defaults, createClient } = lifecycleFixture(t);
  const marker = path.join(root, "namespace-loads");
  const events = () => fs.readFileSync(marker, "utf8").trim().split(/\r?\n/);
  const startup = label => `.onLoad <- function(...) {
    ${recordServerEvent(marker, label)}
    stopifnot(Sys.getenv("RCONSOLE_OPTION_ENV") == "ready",
      identical(getOption("rconsole.lifecycle.option"), list(value = "ready")))
  }
  .onAttach <- function(...) {
    callback <- getOption("rconsole.callback")
    stopifnot(is.function(callback), isNamespace(environment(callback)),
      identical(environment(attr(getOption("rconsole.attributed"), "callback")), environment(callback)),
      identical(normalizePath(getNamespaceInfo(environment(callback), "path")),
        normalizePath(file.path(.libPaths()[[1L]], "${pkg}"))))
    ${recordServerEvent(marker, "callback-restored")}
  }`;
  install(first, "originalExport", startup("original"));
  install(second, "replacementExport", startup("replacement"));
  const profile = path.join(root, ".Rprofile");
  fs.writeFileSync(profile, [
    'Sys.setenv(RCONSOLE_OPTION_ENV = "ready")',
    `.libPaths(c(${JSON.stringify(first)}, .libPaths()))`,
    'options(rconsole.lifecycle.option = list(value = "ready"))',
    `options(rconsole.attributed = structure("value", callback = ${pkg}::originalExport))`,
    `options(rconsole.callback = ${pkg}::originalExport, languageserver.max_completions = 7L)`,
    `library(${pkg})`,
  ].join("\n") + "\n");
  // Inherited paths still select the old copy when the replacement begins.
  const env = { ...process.env, R_PROFILE_USER: profile,
    R_LIBS_USER: [first, ...defaults].join(path.delimiter), RCONSOLE_OPTION_ENV: "inherited" };
  const { client, instances, complete, logs } = createClient({ cwd: root, args: [], env });
  client.updateRuntimeLibraryPaths([first, second, ...defaults]);
  await client.start();
  await waitFor(() => client.packageInventory.initialized, "initial inventory");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "originalExport"));
  assert.equal((await complete("stats::")).length, 7, "the initial server must apply the profile options");
  assert.deepEqual(events(), ["original", "callback-restored"]);
  fs.writeFileSync(marker, "");
  client.updateRuntimeLibraryPaths([second, first, ...defaults]);
  await waitFor(() => logs.some(line => line.includes("Selected copy changed: " + pkg)),
    "namespace-valued options must not retain the old installation");
  const items = await complete(pkg + "::");
  assert.ok(items.some(item => item.label === "replacementExport"));
  assert.ok(!items.some(item => item.label === "originalExport"));
  assert.equal(instances.length, 2, "the library switch requires exactly one replacement");
  assert.deepEqual(events(), ["replacement", "callback-restored"],
    "deserialization loads only the selected namespace with its restored environment");
  assert.equal((await complete("stats::")).length, 7);
});

test("site libraries excluded by a live snapshot stay excluded on startup and refresh", { timeout: 90000 }, async t => {
  const { first, pkg, install, defaults, createClient } = lifecycleFixture(t);
  install(first, "siteExport");
  const env = { ...process.env, R_LIBS_SITE: first };
  const { client, complete, instances } = createClient({ env, args: [] });
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

for (const useStdio of [false, true]) {
test(`replacement restores in-memory profile state over ${useStdio ? "stdio" : "authenticated TCP"}`, {
  timeout: 90000, skip: useStdio && process.platform === "win32",
}, async t => {
  const { first, second, root, pkg, install, defaults, createClient } = lifecycleFixture(t);
  const marker = path.join(root, "profile-runs");
  const startup = `.onLoad <- function(...) {
    stopifnot(Sys.getenv("RCONSOLE_TEST_PROFILE_VALUE") == "profile value",
      Sys.getenv("RCONSOLE_TEST_ENVIRON_VALUE") == "environ value",
      is.na(Sys.getenv("RCONSOLE_TEST_UNSET", unset = NA_character_)),
      Sys.getenv("RCONSOLE_TEST_EMPTY") == "", dir.exists(tempdir()))
    stopifnot(identical(getOption("rconsole.test.raw"), as.raw(rep(0:255, 1024L))),
      identical(getOption("rconsole.test.credential"), Sys.getenv("RCONSOLE_TEST_CREDENTIAL")))
    session_tmp <- Sys.getenv("R_SESSION_TMPDIR")
    if (nzchar(session_tmp)) stopifnot(normalizePath(session_tmp) == normalizePath(tempdir()))
  }`;
  install(first, "originalExport", startup);
  install(second, "replacementExport", startup);
  const profile = path.join(root, ".Rprofile"), environ = path.join(root, ".Renviron");
  fs.writeFileSync(environ, 'RCONSOLE_TEST_ENVIRON_VALUE="environ value"\n');
  fs.writeFileSync(profile, [
    'Sys.setenv(RCONSOLE_TEST_PROFILE_VALUE = "profile value", RCONSOLE_TEST_EMPTY = "")',
    'Sys.unsetenv("RCONSOLE_TEST_UNSET")',
    'options(rconsole.test.credential = Sys.getenv("RCONSOLE_TEST_CREDENTIAL"))',
    'options(rconsole.test.raw = as.raw(rep(0:255, 1024L)))',
    `.libPaths(c(${JSON.stringify(first)}, .libPaths()))`,
    `library(${pkg})`,
    recordServerEvent(marker, "profile"),
  ].join("\n") + "\n");
  const env = { ...process.env, R_PROFILE_USER: profile, R_ENVIRON_USER: environ,
    VSCR_LSP_HOST: "127.0.0.1", VSCR_LSP_PORT: "1", VSCR_LSP_AUTH_TOKEN: "stale-token",
    RCONSOLE_TEST_CREDENTIAL: "synthetic-startup-secret-do-not-persist",
    RCONSOLE_TEST_PROFILE_VALUE: "inherited", RCONSOLE_TEST_UNSET: "inherited", RCONSOLE_TEST_EMPTY: "inherited" };
  const { client, instances, complete, logs } = createClient({ cwd: root, args: [], env, useStdio });
  client.updateRuntimeLibraryPaths([first, second, ...defaults]);
  await client.start();
  await waitFor(() => client.packageInventory.initialized, "initial inventory");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "originalExport"));
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "profile",
    "the initial server must execute the complete profile");
  const state = client.startupState;
  assert.ok(state.includes(Buffer.from(env.RCONSOLE_TEST_CREDENTIAL)), "fixture contains sensitive startup data");
  assert.deepEqual(fs.readdirSync(client.workingDirectory), [], "startup data must stay out of the workspace");
  assert.equal(await client.client.sendRequest("rConsole/takeStartupState", {}), null,
    "the R process releases the startup envelope after the first transfer");
  const snapshotKeys = execFileSync("Rscript", ["--vanilla", "-e",
    `cat(names(unserialize(readBin(file("stdin", "rb"), "raw", n=${client.startupState.length}))$environment), sep="\\n")`],
    { input: client.startupState, encoding: "utf8" }).trim().split(/\r?\n/);
  assert.ok(!snapshotKeys.some(key => key.startsWith("VSCR_") || key === "R_SESSION_TMPDIR"),
    "the startup snapshot must exclude transport secrets and the old temporary directory");
  for (const [libraries, exported] of [[[second, first, ...defaults], "replacementExport"],
    [[first, second, ...defaults], "originalExport"]]) {
    logs.length = 0;
    client.updateRuntimeLibraryPaths(libraries);
    await waitFor(() => logs.some(line => line.includes("Selected copy changed: " + pkg)), "confirmed switch");
    assert.ok((await complete(pkg + "::")).some(item => item.label === exported),
      "profile-dependent packages must load in every replacement server");
    assert.equal(fs.readFileSync(marker, "utf8").trim(), "profile",
      "replacement restores state without replaying the profile");
  }
  assert.equal(instances.length, 3, "both replacements authenticate with fresh transport state");
  assert.ok(client.startupState === state, "replacements reuse the original in-memory configuration");
  assert.deepEqual(fs.readdirSync(client.workingDirectory), [], "restarts must not create state files");
  assert.ok(!logs.join("\n").includes(env.RCONSOLE_TEST_CREDENTIAL), "the state transfer must not log its payload");
  await client.dispose();
  assert.equal(client.startupState, undefined);
  assert.ok(state.every(byte => byte === 0));
});
}

test("replacement preserves profile-defined base and site library roots across repeated restarts", { timeout: 120000 }, async t => {
  const { first, second, root, pkg, install, defaults, createClient } = lifecycleFixture(t);
  const baseRoot = path.join(root, "project-base"), siteRoot = path.join(root, "excluded-site");
  const canonical = value => fs.realpathSync.native(value).replaceAll("\\", "/");
  const systemBase = execFileSync("Rscript", ["--vanilla", "-e", "cat(.Library)"],
    { encoding: "utf8" }).trim();
  const otherLibraries = defaults.filter(library => canonical(library) !== canonical(systemBase));
  fs.mkdirSync(baseRoot);
  fs.mkdirSync(siteRoot);
  // Keep the standard R packages available through a distinct root without
  // copying or modifying the installed R distribution. On Windows use junctions.
  // Where present, leave an optional recommended package exclusively in the
  // original system library to detect accidental fallback to that library.
  const excludedSystem = ["spatial", "KernSmooth", "foreign"].find(name =>
    fs.existsSync(path.join(systemBase, name, "DESCRIPTION")) &&
    otherLibraries.every(library => !fs.existsSync(path.join(library, name, "DESCRIPTION"))));
  for (const name of fs.readdirSync(systemBase)) {
    const directory = path.join(systemBase, name);
    if (name !== excludedSystem && fs.existsSync(path.join(directory, "DESCRIPTION"))) {
      fs.symlinkSync(directory, path.join(baseRoot, name), process.platform === "win32" ? "junction" : "dir");
    }
  }
  const excludedSite = "rconsoleexcludedsiteprobe";
  install(siteRoot, "excludedExport", "", excludedSite);
  const originalOrder = [first, second, ...otherLibraries, baseRoot].map(canonical);
  const replacementOrder = [originalOrder[1], originalOrder[0], ...originalOrder.slice(2)];
  const rBase = JSON.stringify(canonical(baseRoot)), rSite = JSON.stringify(canonical(siteRoot));
  const marker = path.join(root, "profile-runs");
  const startup = `.onLoad <- function(...) {
    if (any(basename(commandArgs(TRUE)) == "console-language-server.R")) {
      stopifnot(identical(get(".Library", baseenv(), inherits = FALSE), ${rBase}),
        identical(get(".Library.site", baseenv(), inherits = FALSE), ${rSite}),
        identical(Sys.getenv("RCONSOLE_LIBRARY_ROOT_TEST"), "ready"),
        identical(getOption("rconsole.lifecycle.option"), "ready"))
    }
  }
  .onAttach <- function(...) {
    if (any(basename(commandArgs(TRUE)) == "console-language-server.R")) {
      callback <- getOption("rconsole.lifecycle.callback")
      stopifnot(is.function(callback), isNamespace(environment(callback)),
        identical(normalizePath(getNamespaceInfo(environment(callback), "path")),
          normalizePath(file.path(.libPaths()[[1L]], "${pkg}"))))
    }
  }`;
  install(first, "originalExport", startup);
  install(second, "replacementExport", startup);
  const profile = path.join(root, ".Rprofile");
  fs.writeFileSync(profile, [
    `local({
      roots <- list(.Library = ${rBase}, .Library.site = ${rSite})
      for (name in names(roots)) {
        locked <- bindingIsLocked(name, baseenv())
        if (locked) unlockBinding(name, baseenv())
        assign(name, roots[[name]], envir = baseenv())
        if (locked) lockBinding(name, baseenv())
      }
    })`,
    `.libPaths(c(${originalOrder.map(value => JSON.stringify(value)).join(", ")}), include.site = FALSE)`,
    'Sys.setenv(RCONSOLE_LIBRARY_ROOT_TEST = "ready")',
    'options(rconsole.lifecycle.option = "ready", languageserver.max_completions = 7L)',
    `options(rconsole.lifecycle.callback = ${pkg}::originalExport)`,
    `library(${pkg})`,
    recordServerEvent(marker, "profile"),
  ].join("\n") + "\n");
  const env = { ...process.env, R_PROFILE_USER: profile, RCONSOLE_LIBRARY_ROOT_TEST: "inherited" };
  const { client, instances, complete, logs } = createClient({ cwd: root, args: [], env });
  const inventory = client.packageInventory;
  const assertState = async (order, exported, instanceCount) => {
    await waitFor(() => inventory.initialized && !client.packageRefreshPromise &&
      JSON.stringify(inventory.libraries.map(library => canonical(library.path))) === JSON.stringify(order),
    "reconcile and publish the exact console library order");
    assert.equal(instances.length, instanceCount);
    const paths = await instances.at(-1).sendRequest("rConsole/libraryPaths", {});
    assert.deepEqual(paths.map(canonical), order, "no automatic system or site root may be appended");
    const items = await complete(pkg + "::");
    assert.ok(items.some(item => item.label === exported));
    assert.ok(!items.some(item => item.label === (exported === "originalExport" ? "replacementExport" : "originalExport")));
    assert.equal((await complete("stats::")).length, 7, "startup completion options survive replacement");
    for (const name of [excludedSite, excludedSystem].filter(Boolean)) {
      assert.ok(!inventory.packages.has(name), "excluded package is absent from the inventory: " + name);
      assert.ok(!(await complete(name)).some(item => item.label === name && item.data?.type === "package"),
        "excluded package is not offered for completion: " + name);
    }
    assert.ok(!(await complete(excludedSite + "::")).some(item => item.label === "excludedExport"));
    assert.equal(fs.readFileSync(marker, "utf8").trim(), "profile", "the initial profile must run only once");
    // Include the first retry interval, so a successful completion cannot hide
    // a reconciliation failure waiting to restart the server again.
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(instances.length, instanceCount, "successful reconciliation must not restart again");
    assert.equal(inventory.retryTimer, undefined, "no reconciliation retry remains scheduled");
    assert.ok(!logs.some(line => /Recovery retry scheduled|Replacement language server retained stale packages/.test(line)));
  };
  client.updateRuntimeLibraryPaths(originalOrder);
  await client.start();
  await assertState(originalOrder, "originalExport", 1);
  client.updateRuntimeLibraryPaths(replacementOrder);
  await assertState(replacementOrder, "replacementExport", 2);
  client.updateRuntimeLibraryPaths(originalOrder);
  await assertState(originalOrder, "originalExport", 3);
});

for (const lockName of ["00LOCK-rconsolelifecycleprobe", "00LOCK"]) {
  test(`a startup namespace removed under ${lockName} is retired when the lock clears`, { timeout: 90000 }, async t => {
    const { first, pkg, install, defaults, createClient } = lifecycleFixture(t);
    install(first, "startupExport");
    const lock = path.join(first, lockName);
    fs.mkdirSync(lock);
    const env = { ...process.env, R_LIBS_USER: [first, ...defaults].join(path.delimiter),
      R_DEFAULT_PACKAGES: `datasets,utils,grDevices,graphics,stats,methods,${pkg}` };
    const { client, instances, complete } = createClient({ env, libraries: [first] });
    await client.start();
    await waitFor(() => client.packageInventory.initialized, "initial locked inventory");
    assert.ok((await complete(pkg + "::")).some(item => item.label === "startupExport"));
    assert.ok(!client.packageInventory.packages.has(pkg));
    fs.rmSync(path.join(first, pkg), { recursive: true });
    // Observe a scan while the package is absent and the lock is still held.
    client.packageInventory.dirtyLibraries.add(first);
    await client.packageInventory.refresh();
    assert.equal(instances.length, 1, "the active lock keeps the startup namespace deferred");
    fs.rmdirSync(lock);
    await waitFor(() => instances.length === 2 && !client.packageRefreshPromise, "unlocked namespace reconciled");
    assert.ok(!(await complete(pkg + "::")).some(item => item.label === "startupExport"));
  });
}

test("unrelated abandoned locks do not retain removed namespace metadata", { timeout: 90000 }, async t => {
  const { first, pkg, install, createClient } = lifecycleFixture(t);
  install(first, "installedExport");
  const { client, complete } = createClient({ libraries: [first] });
  await client.start();
  await waitFor(() => client.packageInventory.initialized, "initial inventory");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "installedExport"));
  fs.mkdirSync(path.join(first, "00LOCK-unrelated"));
  execFileSync("Rscript", ["--vanilla", "-e", `remove.packages("${pkg}", lib=${JSON.stringify(first)})`], { stdio: "pipe" });
  await waitFor(() => !client.packageInventory.packages.has(pkg), "removal with unrelated locks present");
  assert.ok(!(await complete(pkg + "::")).some(item => item.label === "installedExport"));
});

test("linked cache changes refresh namespace exports without touching the library link", { timeout: 90000 }, async t => {
  const { first, second: cache, pkg, install, createClient } = lifecycleFixture(t);
  install(cache, "originalExport");
  const target = path.join(cache, pkg);
  fs.symlinkSync(target, path.join(first, pkg), process.platform === "win32" ? "junction" : "dir");
  const { client, complete } = createClient({ libraries: [first] });
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

test("a traversable unlistable cache retires removed namespace completions", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
  timeout: 90000,
}, async t => {
  const { first, second: cache, pkg, install, createClient } = lifecycleFixture(t);
  install(cache, "originalExport");
  const target = path.join(cache, pkg);
  fs.symlinkSync(target, path.join(first, pkg), "dir");
  fs.chmodSync(cache, 0o311);
  let client;
  try {
    await assert.rejects(fs.promises.readdir(cache), { code: "EACCES" });
    execFileSync("Rscript", ["--vanilla", "-e", `library(${pkg}, lib.loc=${JSON.stringify(first)})`], { stdio: "pipe" });
    const result = createClient({ libraries: [first] });
    client = result.client;
    await client.start();
    await waitFor(() => client.packageInventory.initialized, "inventory of a traversable unlistable cache");
    assert.ok((await result.complete(pkg + "::")).some(item => item.label === "originalExport"));
    fs.rmSync(target, { recursive: true });
    await waitFor(() => !client.packageInventory.packages.has(pkg), "unlistable cache removal published");
    assert.ok(!(await result.complete(pkg + "::")).some(item => item.label === "originalExport"));
    assert.ok(!result.logs.some(line => line.includes("Could not refresh package inventory")));
  } finally {
    fs.chmodSync(cache, 0o700);
    await client?.dispose();
  }
});

test("a chained package link retains its startup namespace until the cache installation unlocks", { timeout: 90000 }, async t => {
  const { first, second: cache, root, pkg, install, defaults, createClient } = lifecycleFixture(t);
  const alias = path.join(root, "alias"), replacement = path.join(root, "replacement");
  fs.mkdirSync(alias); fs.mkdirSync(replacement);
  install(cache, "originalExport");
  install(replacement, "replacementExport");
  const target = path.join(cache, pkg), intermediate = path.join(alias, pkg);
  fs.symlinkSync(target, intermediate, process.platform === "win32" ? "junction" : "dir");
  fs.symlinkSync(intermediate, path.join(first, pkg), process.platform === "win32" ? "junction" : "dir");
  const env = { ...process.env, R_LIBS_USER: [first, ...defaults].join(path.delimiter),
    R_DEFAULT_PACKAGES: `datasets,utils,grDevices,graphics,stats,methods,${pkg}` };
  const { client, instances, complete, logs } = createClient({ env, libraries: [first] });
  await client.start();
  await waitFor(() => client.packageInventory.initialized, "initial inventory");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "originalExport"));
  const originalIdentity = client.packageInventory.packages.get(pkg).identity;
  const lock = path.join(cache, "00LOCK-" + pkg);
  fs.mkdirSync(lock);
  fs.renameSync(target, path.join(lock, pkg));
  await waitFor(() => client.packageInventory.libraries.some(library => library.deferred?.has(pkg)),
    "the cache lock defers the missing final target");
  assert.equal(client.packageInventory.packages.get(pkg)?.identity, originalIdentity);
  assert.equal(instances.length, 1, "the locked backup must not restart the language server");
  fs.renameSync(path.join(replacement, pkg), target);
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal(client.packageInventory.packages.get(pkg)?.identity, originalIdentity);
  assert.equal(instances.length, 1, "the new copy remains deferred until unlock");
  fs.rmSync(lock, { recursive: true });
  await waitFor(() => logs.some(line => line.includes("Updated: " + pkg)), "unlocked replacement published");
  const items = await complete(pkg + "::");
  assert.ok(items.some(item => item.label === "replacementExport"));
  assert.ok(!items.some(item => item.label === "originalExport"));
  assert.equal(instances.length, 2, "unlock replaces the loaded namespace once");
});

test("initial locked namespaces stay usable and an excluded startup namespace is retired", { timeout: 90000 }, async t => {
  const { first, pkg, install, defaults, createClient } = lifecycleFixture(t);
  install(first, "startupExport");
  const env = { ...process.env, R_LIBS_USER: [first, ...defaults].join(path.delimiter),
    R_DEFAULT_PACKAGES: `datasets,utils,grDevices,graphics,stats,methods,${pkg}` };
  const lock = path.join(first, "00LOCK-" + pkg);
  fs.mkdirSync(lock);
  const { client, instances, complete } = createClient({ env, libraries: [first] });
  await client.start();
  await waitFor(() => client.packageInventory.initialized, "initial locked inventory");
  assert.equal(instances.length, 1, "a locked startup namespace must not cause a restart loop");
  assert.ok((await complete(pkg + "::")).some(item => item.label === "startupExport"));
  fs.rmdirSync(lock);
  await waitFor(() => client.packageInventory.packages.has(pkg), "unlocked installation");
  await client.dispose();
  // A fresh console snapshot can already exclude a default package loaded by R startup.
  const next = createClient({ env });
  next.client.updateRuntimeLibraryPaths(defaults);
  await next.client.start();
  await waitFor(() => next.client.packageInventory.initialized, "excluded startup namespace reconciled");
  assert.equal(next.instances.length, 2);
  assert.ok(!(await next.complete(pkg + "::")).some(item => item.label === "startupExport"));
});
