const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createConsoleLsp } = require("./helpers/console-lsp.cjs");
const loadSource = require("./helpers/load-source.cjs");
const { runRJson } = require("./helpers/run-r-json.cjs");

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
  assert.ok(logs.some(line => /Saved package metadata: [1-9]/.test(line)));
  assert.ok(logs.some(line => /Restored package metadata: [1-9].*\bstats\b/.test(line)),
    "unchanged package metadata survives the actual LSP restart");
  assert.ok(!logs.some(line => line.includes("Could not export") || line.includes("Could not restore")));
  assert.ok(fs.existsSync(path.join(client.workingDirectory, "package-metadata.rds")));

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

test("package metadata snapshots restore across R processes and reject changed dependencies", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-cache-"));
  const file = path.join(directory, "packages.rds");
  const setup = `
    normalize_character <- function(value) unique(as.character(unlist(value, use.names = FALSE)))
    server <- list(request_handlers = list())
    source("resources/r/completion-cache.R")
    packages <- .packages(all.available = TRUE)
    completion_package_identities <- as.list(setNames(paste0(packages, "-unchanged"), packages))
    workspace <- list(namespaces = collections::dict(),
      member_metadata = languageserver:::MemberMetadataCache$new(32 * 1024^2),
      s3_metadata = languageserver:::S3MetadataCache$new())
    server$workspaces <- collections::dict()
    server$workspaces$set("console", workspace)
  `;
  try {
    const saved = runRJson(setup + `
      for (package in c("stats", "splines", "utils")) {
        workspace$namespaces$set(package, languageserver:::PackageNamespace$new(package))
      }
      namespace <- workspace$namespaces$get("splines")
      invisible(namespace$get_formals("ns"))
      members <- languageserver:::member_prepare_package("splines")
      workspace$member_metadata$set("splines", members)
      s3 <- languageserver:::s3_prepare_namespace("splines")
      workspace$s3_metadata$set("splines", s3)
      result <- console_package_cache_export(server, inputs$file)
      payload <- readRDS(inputs$file)$workspaces$console$splines
      has_reference <- function(value) {
        if (is.environment(value) || is.function(value) || typeof(value) == "externalptr") return(TRUE)
        if (is.list(value) || is.pairlist(value)) return(any(vapply(value, has_reference, logical(1))))
        FALSE
      }
      stopifnot(!has_reference(payload), !is.null(payload$namespace$functions$ns),
        !is.null(payload$members), !is.null(payload$s3))
      cat(jsonlite::toJSON(result, auto_unbox = TRUE))
    `, { file });
    assert.deepEqual(saved.skipped, []);
    assert.deepEqual([...saved.saved].sort(), ["splines", "stats", "utils"]);

    const restored = runRJson(setup + `
      result <- console_package_cache_restore(server, inputs$file)
      namespace <- workspace$namespaces$get("splines")
      payload <- readRDS(inputs$file)$workspaces$console$splines
      stopifnot(inherits(namespace, "ConsoleCachedNamespace"),
        identical(namespace$get_formals("ns"), formals(splines::ns)),
        identical(namespace$get_symbols(), payload$namespace$exported_functs),
        identical(workspace$member_metadata$get("splines")$generation, payload$members$generation),
        identical(workspace$s3_metadata$get("splines")$generation, payload$s3$generation))
      cat(jsonlite::toJSON(result, auto_unbox = TRUE))
    `, { file });
    assert.deepEqual([...restored.restored].sort(), ["splines", "stats", "utils"]);
    assert.deepEqual(restored.skipped, []);

    const changed = runRJson(setup + `
      completion_package_identities$stats <- "stats-updated"
      result <- console_package_cache_restore(server, inputs$file)
      stopifnot(!workspace$namespaces$has("stats"), !workspace$namespaces$has("splines"),
        !workspace$member_metadata$has("splines"), !workspace$s3_metadata$has("splines"))
      cat(jsonlite::toJSON(result, auto_unbox = TRUE))
    `, { file });
    assert.deepEqual(changed.restored, ["utils"]);
    assert.deepEqual([...changed.skipped].sort(), ["splines", "stats"]);

    const removed = runRJson(setup + `
      completion_package_identities$stats <- NULL
      result <- console_package_cache_restore(server, inputs$file)
      cat(jsonlite::toJSON(result, auto_unbox = TRUE))
    `, { file });
    assert.deepEqual(removed.restored, ["utils"]);
    assert.deepEqual([...removed.skipped].sort(), ["splines", "stats"]);

    const incompatible = runRJson(setup + `
      snapshot <- readRDS(inputs$file)
      snapshot$header$schema <- 999L
      saveRDS(snapshot, inputs$file)
      reply <- NULL
      server$deliver <- function(response) reply <<- response$result
      server$request_handlers[["rConsole/restorePackageMetadata"]](server, 1L, inputs)
      stopifnot(workspace$namespaces$size() == 0L)
      cat(jsonlite::toJSON(reply, auto_unbox = TRUE))
    `, { file });
    assert.match(incompatible.error, /incompatible/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

test("real R adds an empty session library without restarting", { timeout: 90000 }, async (t) => {
  const { session, configured } = temporaryLibraries(t);
  let synchronized = false;
  const state = { attachedPackages: ["stats"], libraryPaths: [session] };
  const { client, instances, complete } = createConsoleLsp(t, {
    libraries: [configured],
    afterResponse: async (method) => {
      if (method === "rConsole/libraryPaths" && !synchronized) {
        synchronized = true;
        await client.syncSessionState(state);
      }
    },
  });
  const items = await complete();
  assert.ok(items?.some((item) => item.label === "lm"), "return suggestions for the original Tab request");
  assert.equal(instances.length, 1, "an empty library does not change any selected package");
  assert.equal(instances[0].opened.length, 1, "retain the virtual console document");
  await client.syncSessionState(state);
  assert.ok((await complete())?.some((item) => item.label === "lm"));
  assert.equal(instances.length, 1, "unchanged libraries must not trigger a replacement");
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
  const resolved = await running.sendRequest("rConsole/syncSessionState", {
    attachedPackages: ["stats"], libraryPaths: [configured],
  });
  assert.ok(!resolved.libraryPaths.includes(session.replaceAll(path.sep, "/")), "removed library is not retained as a fallback");
  assert.ok(resolved.libraryPaths.includes(configured.replaceAll(path.sep, "/")));
});
