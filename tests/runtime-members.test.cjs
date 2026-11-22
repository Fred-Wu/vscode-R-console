const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const loadSource = require("./helpers/load-source.cjs");
const { RustSidecarRuntimeBackend, getBundledRustSidecarPath } = loadSource("src/Runtime/runtimeBackend.ts");
const { parseRuntimeMemberQuery } = loadSource("src/Language/completion/runtimeMembers.ts");
const completion = loadSource("src/Language/completion.ts", { vscode: {
  CompletionItemKind: { Field: 4, Property: 9, Variable: 5, Function: 2, Text: 0 },
  SnippetString: class {},
} });

test("real embedded R completion inspects nested storage without running user code", { timeout: 60000 }, async t => {
  const root = path.resolve(__dirname, "..");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-member-inspection-"));
  const rHome = execFileSync(process.env.R_TEST_EXECUTABLE || "R", ["RHOME"], { encoding: "utf8" }).trim();
  const rPath = path.join(rHome, "bin", process.platform === "win32" ? "R.exe" : "R");
  const backend = new RustSidecarRuntimeBackend(getBundledRustSidecarPath(root));
  // The direct sidecar launch bypasses the normal R Console launcher, which
  // configures the dynamic loader path before starting embedded R.
  const env = { ...process.env, R_HOME: rHome };
  if (process.platform === "linux") {
    env.LD_LIBRARY_PATH = [path.join(rHome, "lib"), env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }
  const session = backend.start([rPath, "--vanilla", "--quiet"], { cwd, env });
  let mainPrompts = 0;
  let output = "";
  let failure;
  t.after(async () => {
    const pid = backend.getPid(session);
    backend.close(session);
    backend.detach(session);
    await delay(100);
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(path.join(os.tmpdir(), `r-console-session-${session.sessionId}.json`), { force: true });
  });
  backend.attach(session, {
    onStdout: text => { output += text; },
    onStderr: text => { output += text; },
    onControl: event => {
      if (event.type === "prompt" && event.kind === "main") mainPrompts++;
    },
    onError: error => { failure = error; },
  });
  const until = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (failure) throw failure;
      assert.ok(Date.now() < deadline, label + ": " + output);
      await delay(20, undefined, { signal: t.signal });
    }
  };
  await until(() => mainPrompts > 0, "initial R prompt");
  assert.equal(backend.hasCapability(session, "member-inspection"), true,
    "supported R installations must provide native guarded binding inspection");

  const submit = async code => {
    const previous = mainPrompts;
    assert.equal(backend.sendSessionCommand(session, { type: "submit", code }), true);
    await until(() => mainPrompts > previous, "main prompt after execution");
  };
  const inspectTyped = (root, steps = [], target = "$") =>
    backend.inspectMemberNames(session, { root, steps, target });
  const inspect = async (root, steps = [], target = "$") => {
    const result = await inspectTyped(root, steps, target);
    return result?.status === "available" ? { status: "available", names: result.names } : result;
  };
  const available = (names) => ({ status: "available", names });
  // Compile against this installation of R. CI installs Rtools on Windows;
  // missing compilers or callback support fail the safety test, never skip it.
  const fixture = `member_safety${process.platform === "win32" ? ".dll" : ".so"}`;
  fs.copyFileSync(path.join(__dirname, "fixtures", "member_safety.c"), path.join(cwd, "member_safety.c"));
  fs.copyFileSync(path.join(root, "sidecar", "pty-host", "src", "member_guard.c"), path.join(cwd, "member_guard.c"));
  execFileSync(rPath, ["CMD", "SHLIB", "-o", fixture, "member_safety.c"],
    { cwd, env, encoding: "utf8", timeout: 60000 });
  await submit(`dyn.load(${JSON.stringify(path.join(cwd, fixture).replaceAll("\\", "/"))}); native_safety <- .Call("member_safety_objects"); alt_index <- native_safety$index; native_database <- attach(native_safety$database, name = "member_safety_database", warn.conflicts = FALSE); detach("member_safety_database"); native_holder <- list(db = native_database); .Call("member_safety_reset")`);
  for (const expression of ["native_safety$names", "native_safety$class$inner",
    "native_safety$list", "native_safety$list[[1]]", "native_safety[[alt_index]]"]) {
    assert.deepEqual(await backend.inspectMemberNames(session, parseRuntimeMemberQuery(expression)),
      { status: "suppressed", reason: "unsafe-altrep" }, expression);
  }
  for (const expression of ["native_database", "native_database$inner",
    'native_database[["inner"]]', "native_holder$db", "native_holder$db$inner"]) {
    for (const target of ["$", "[["]) {
      assert.deepEqual(await backend.inspectMemberNames(session, parseRuntimeMemberQuery(expression, target)),
        { status: "suppressed", reason: "unsafe-environment" }, expression + target);
    }
  }
  await submit('cat("NATIVE_SAFETY_COUNTS:", paste(.Call("member_safety_counts"), collapse = ","), "\\n")');
  await until(() => output.includes("NATIVE_SAFETY_COUNTS:"), "native safety counters");
  assert.match(output, /NATIVE_SAFETY_COUNTS:\s*0,0,0,0,0/,
    "inspection must not run ALTREP length/element or database exists/get/objects callbacks");
  // Positive controls prove these are live callbacks, not inert class labels.
  await submit('invisible(length(alt_index)); invisible(alt_index[[1]]); invisible(exists("inner", envir = native_database, inherits = FALSE)); invisible(get("inner", envir = native_database, inherits = FALSE)); invisible(ls(native_database)); cat("NATIVE_CALLBACKS_LIVE:", all(.Call("member_safety_counts") > 0L), "\\n")');
  await until(() => output.includes("NATIVE_CALLBACKS_LIVE:"), "native callback positive controls");
  assert.match(output, /NATIVE_CALLBACKS_LIVE:\s*TRUE/);
  // R_ToplevelExec alone catches jumps only after options(error) has run.
  // Both invalid selectors and untranslatable names must remain inert, and
  // an unexpected API error must be caught before either global error hook.
  await submit('error_hits <- 0L; global_error_hits <- 0L; options(error = function() { error_hits <<- error_hits + 1L }); globalCallingHandlers(error = function(e) { global_error_hits <<- global_error_hits + 1L }); index_obj <- list(inner = list(alpha = 1)); null_index <- NULL; function_index <- function() 1; environment_index <- new.env(); symbol_index <- quote(inner); call_index <- quote(f(x)); bytes_name <- rawToChar(as.raw(255)); Encoding(bytes_name) <- "bytes"; bytes_obj <- setNames(list(1, 2), c(bytes_name, "safe"))');
  output = "";
  for (const name of ["null_index", "function_index", "environment_index", "symbol_index", "call_index"]) {
    assert.deepEqual(await inspect("index_obj", [{ kind: "variable-index", name }]), available([]), name);
  }
  assert.deepEqual(await inspect("bytes_obj"), available(["safe"]));
  await submit('cat("ERROR_GUARD:", .Call("member_safety_error_guard"), error_hits, global_error_hits, "\\n")');
  assert.match(output, /ERROR_GUARD:\s*TRUE\s+0\s+0/);
  assert.doesNotMatch(output, /Error:|native guard test error|LENGTH or similar|translating strings/);
  await submit('stop("error hook positive control")');
  await submit('cat("ERROR_HOOKS_LIVE:", error_hits, global_error_hits, "\\n"); options(error = NULL); globalCallingHandlers(NULL)');
  assert.match(output, /ERROR_HOOKS_LIVE:\s*1\s+1/);
  await submit('obj <- list(inner = list(alpha = 1, beta = 2), df = data.frame("a b" = 1, check.names = FALSE))');
  assert.deepEqual(await inspect("obj", [{ kind: "field", name: "inner" }]), available(["alpha", "beta"]));
  assert.deepEqual(await inspect("obj", [{ kind: "index", index: 2 }]), available(["a b"]));
  const frameBracket = await inspectTyped("obj", [{ kind: "field", name: "df" }], "[");
  assert.equal(frameBracket.status, "available");
  assert.equal(frameBracket.bracketKind, "data.frame");
  assert.deepEqual(frameBracket.names, ["a b"]);
  assert.deepEqual(await inspect("obj", [{ kind: "field", name: "missing" }]), available([]));
  await submit('missing_names <- setNames(list(list(wrong = 1), list(right = 2), list(child = 3)), c(NA_character_, "NA", "inner")); missing_index <- NA_character_; literal_index <- "NA"; stopifnot(identical(names(missing_names[["NA"]]), "right"), is.null(missing_names[[missing_index]]), identical(names(missing_names$inn), "child"))');
  assert.deepEqual(await inspect("missing_names"), available(["NA", "inner"]));
  for (const step of [{ kind: "named-index", name: "NA" }, { kind: "field", name: "NA" },
    { kind: "variable-index", name: "literal_index" }]) {
    assert.deepEqual(await inspect("missing_names", [step]), available(["right"]));
  }
  for (const kind of ["variable-index", "variable-slice"]) {
    assert.deepEqual(await inspect("missing_names", [{ kind, name: "missing_index" }]), available([]));
  }
  assert.deepEqual(await inspect("missing_names", [{ kind: "field", name: "inn" }]), available(["child"]));
  assert.deepEqual(await inspect("missing_names", [{ kind: "slice-index", index: 1 }]), available([]));
  await submit('obj$inner <- list(changed = TRUE)');
  assert.deepEqual(await inspect("obj", [{ kind: "field", name: "inner" }]), available(["changed"]));

  await submit('hits <- 0L; makeActiveBinding("active_root", function() { hits <<- hits + 1L; list(inner = list(secret = 1)) }, .GlobalEnv); classed <- structure(list(inner = list(secret = 2)), class = "custom"); `$.custom` <- function(x, name) { hits <<- hits + 1L; x[[name]] }; delayedAssign("lazy_root", { hits <<- hits + 1L; list(inner = list(secret = 3)) })');
  for (const [root, expected] of [
    ["active_root", "active-binding"],
    ["classed", "unsafe-dispatch"],
    ["lazy_root", "deferred-binding"],
  ]) {
    const query = { root, steps: [{ kind: "field", name: "inner" }], target: "$" };
    assert.deepEqual(await backend.inspectMemberNames(session, query),
      { status: "suppressed", reason: expected }, root);
    assert.deepEqual(await inspect(root, query.steps),
      { status: "suppressed", reason: expected }, root);
  }
  output = "";
  await submit('plain <- list(inner = list(alpha = 1), empty = list(), scalar = 1); named <- c(alpha = 10, beta = 20); idx <- 1L; nm <- "inner"; env <- new.env(parent = emptyenv()); env$inner <- list(value = TRUE); env$empty <- list(); s4name <- "CompletionInspect"; methods::setClass(s4name, slots = c(inner = "list"), where = .GlobalEnv); s4 <- methods::new(s4name, inner = list(slot_value = TRUE)); cat("S4_CONSTRUCTED:", exists("s4", envir = .GlobalEnv, inherits = FALSE), "\\n")');
  await until(() => output.includes("S4_CONSTRUCTED:"), "R fixture construction");
  assert.match(output, /S4_CONSTRUCTED:\s*TRUE/, "S4 creation must finish before inspection");
  assert.deepEqual(await inspect("plain", [{ kind: "field", name: "inner" }]), available(["alpha"]));
  assert.deepEqual(await inspect("plain", [{ kind: "named-index", name: "inner" }]), available(["alpha"]));
  await submit('partial <- list(inner = list(alpha = 1)); partial_pair <- as.pairlist(partial); partial_frame <- structure(partial, class = "data.frame", row.names = 1L); ambiguous <- list(inner = list(alpha = 1), innate = list(beta = 2)); exact_first <- list(inner = list(alpha = 1), inn = list(exact = 2)); duplicate_partial <- structure(list(list(alpha = 1), list(beta = 2)), names = c("inner", "inner")); stopifnot(identical(names(partial$inn), "alpha"), identical(names(partial_pair$inn), "alpha"), identical(names(partial_frame$inn), "alpha"), is.null(ambiguous$inn), is.null(duplicate_partial$inn), identical(names(exact_first$inn), "exact")); cat("PARTIAL_MATCH_READY\\n")');
  assert.match(output, /PARTIAL_MATCH_READY/);
  for (const root of ["partial", "partial_pair", "partial_frame"]) {
    assert.deepEqual(await inspect(root, [{ kind: "field", name: "inn" }]), available(["alpha"]), root);
    assert.deepEqual(await inspect(root, [{ kind: "named-index", name: "inn" }]), available([]), root);
  }
  assert.deepEqual(await inspect("partial", [{ kind: "slice-index", index: 1 },
    { kind: "field", name: "inn" }]), available(["alpha"]));
  assert.deepEqual(await inspect("partial", [{ kind: "slice-index", index: 1 },
    { kind: "named-index", name: "inn" }]), available([]));
  assert.deepEqual(await inspect("exact_first", [{ kind: "field", name: "inn" }]), available(["exact"]));
  for (const root of ["ambiguous", "duplicate_partial"]) {
    assert.deepEqual(await inspect(root, [{ kind: "field", name: "inn" }]), available([]), root);
  }
  assert.deepEqual(await inspect("plain", [{ kind: "variable-index", name: "nm" }]), available(["alpha"]));
  assert.deepEqual(await inspect("plain", [{ kind: "variable-index", name: "idx" }]), available(["alpha"]));
  assert.deepEqual(await inspect("plain", [{ kind: "slice-index", index: 1 }]), available(["inner"]));
  assert.deepEqual(await inspect("plain", [{ kind: "field", name: "empty" }]), available([]));
  assert.deepEqual(await inspect("plain", [{ kind: "field", name: "scalar" }]), available([]));
  assert.deepEqual(await inspect("plain", [{ kind: "field", name: "scalar" },
    { kind: "field", name: "further" }]), available([]));
  assert.deepEqual(await inspect("plain", [{ kind: "field", name: "missing" }]), available([]));
  assert.deepEqual(await inspect("named", [], "$"), available([]));
  assert.deepEqual(await inspect("named", [], "[["), available(["alpha", "beta"]));
  assert.deepEqual(await inspect("named", [{ kind: "slice-index", index: 1 }], "$"), available([]));
  output = "";
  await submit('duplicate <- structure(list(1, 2), names = c("same", "same")); cat("DUPLICATE_READY\\n")');
  await until(() => output.includes("DUPLICATE_READY"), "duplicated-name fixture ready");
  assert.deepEqual(await inspect("duplicate", [], "$"), available(["same"]));
  assert.deepEqual(await inspect("duplicate", [{ kind: "slice-index", index: 2 }]), available(["same"]));
  assert.deepEqual((await inspect("env", [], "$")).names.sort(), ["empty", "inner"]);
  const envBracket = await inspectTyped("env", [], "[[");
  assert.equal(envBracket.status, "available");
  assert.deepEqual([...envBracket.names].sort(), ["empty", "inner"]);
  assert.deepEqual(await inspect("env", [{ kind: "field", name: "inner" }]), available(["value"]));
  assert.deepEqual(await inspect("env", [{ kind: "field", name: "inn" }]), available([]),
    "environment access never partially matches bindings");
  assert.deepEqual(await inspect("env", [{ kind: "named-index", name: "inner" }]), available(["value"]));
  assert.deepEqual(await inspect("env", [{ kind: "field", name: "empty" }]), available([]));
  await submit('dispatch_hits <- 0L; custom_env <- new.env(parent = emptyenv()); custom_env$inner <- list(storage = 1); class(custom_env) <- c("child_env", "completion_custom_env")');
  const fieldStep = [{ kind: "field", name: "inner" }];
  const indexStep = [{ kind: "named-index", name: "inner" }];
  const unsafeDispatch = { status: "suppressed", reason: "unsafe-dispatch" };
  // A class alone is not a reason to disable ordinary environment/R6 access.
  assert.deepEqual(await inspect("custom_env", fieldStep), available(["storage"]));
  assert.deepEqual(await inspect("custom_env", indexStep), available(["storage"]));
  await submit('`$.completion_custom_env` <- function(x, name) { dispatch_hits <<- dispatch_hits + 1L; list(actual = 2) }; registerS3method("[[", "completion_custom_env", function(x, ...) { dispatch_hits <<- dispatch_hits + 1L; list(actual_index = 3) }, envir = asNamespace("base"))');
  assert.deepEqual(await inspect("custom_env", fieldStep), unsafeDispatch);
  assert.deepEqual(await inspect("custom_env", indexStep), unsafeDispatch);
  await submit('assign("callable", function() NULL, envir = custom_env)');
  const customEnvNames = await inspectTyped("custom_env");
  assert.equal(customEnvNames.status, "available");
  assert.equal(customEnvNames.kinds[customEnvNames.names.indexOf("callable")], 0,
    "custom accessors cannot promise the callable kind of a stored binding");
  await submit('stopifnot(dispatch_hits == 0L, identical(names(custom_env$inner), "actual"), identical(names(custom_env[["inner"]]), "actual_index"), dispatch_hits == 2L); dispatch_hits <- 0L; rm("$.completion_custom_env"); rm(list = "[[.completion_custom_env", envir = get(".__S3MethodsTable__.", asNamespace("base"))); cat("ENV_DISPATCH_VERIFIED\\n")');
  assert.match(output, /ENV_DISPATCH_VERIFIED/);
  await submit('attach(setNames(list(function(x, name) { dispatch_hits <<- dispatch_hits + 1L; list(attached = 1) }), "$.completion_custom_env"), name = "completion_method_fixture")');
  assert.deepEqual(await inspect("custom_env", fieldStep), unsafeDispatch);
  assert.deepEqual(await inspect("custom_env", indexStep), available(["storage"]));
  await submit('detach("completion_method_fixture"); delayedAssign("$.completion_custom_env", { dispatch_hits <<- dispatch_hits + 1L; function(x, name) NULL })');
  assert.deepEqual(await inspect("custom_env", fieldStep), unsafeDispatch);
  await submit('rm("$.completion_custom_env"); makeActiveBinding("$.completion_custom_env", function() { dispatch_hits <<- dispatch_hits + 1L; function(x, name) NULL }, .GlobalEnv)');
  assert.deepEqual(await inspect("custom_env", fieldStep), unsafeDispatch);
  await submit('rm("$.completion_custom_env"); `$.default` <- function(x, name) { dispatch_hits <<- dispatch_hits + 1L; list(default = 1) }');
  assert.deepEqual(await inspect("custom_env", fieldStep), unsafeDispatch);
  await submit('rm("$.default"); stopifnot(dispatch_hits == 0L); cat("ENV_METHODS_NOT_FORCED\\n")');
  assert.match(output, /ENV_METHODS_NOT_FORCED/);
  assert.deepEqual(await inspect("custom_env", fieldStep), available(["storage"]));
  output = "";
  await submit('cat("S4_READY:", exists("s4", envir = .GlobalEnv, inherits = FALSE), if (exists("s4", envir = .GlobalEnv, inherits = FALSE)) isS4(s4) else FALSE, if (exists("s4", envir = .GlobalEnv, inherits = FALSE)) paste(names(attributes(s4)), collapse = ",") else "", "\\n")');
  await until(() => output.includes("S4_READY:"), "S4 fixture state");
  assert.match(output, /S4_READY:\s*TRUE\s+TRUE/, "S4 object must exist before native inspection");
  assert.deepEqual(await inspect("s4", [], "@"), available(["inner"]), output);
  assert.deepEqual(await inspect("s4", [{ kind: "slot", name: "inner" }]), available(["slot_value"]));
  await submit('methods::setClass("CompletionNumeric", contains = "numeric", slots = c(inner = "list")); s4data <- methods::new("CompletionNumeric", 1:3, inner = list(child = 1)); cat("DATA_SLOTS:", paste(methods::slotNames(s4data), collapse = ","), "\\n")');
  assert.match(output, /DATA_SLOTS:\s*\.Data,inner/);
  assert.deepEqual(await inspect("s4data", [], "@"), { status: "unavailable" },
    "raw attributes must not masquerade as the complete schema of a data-bearing S4 class");
  const s4input = "s4data@";
  const s4entries = await completion.collectCompletionEntries(
    completion.getCompletionContext(s4input, s4input.length), undefined, undefined,
    { globalenv: { s4data: { slots: [".Data", "inner"] } } }, [], [], undefined,
    (expression, target) => backend.inspectMemberNames(session, parseRuntimeMemberQuery(expression, target)));
  assert.deepEqual(s4entries.map(entry => entry.label), [".Data", "inner"]);
  await submit('methods::setClass("CompletionDotSlot", slots = c(.hidden = "list"), where = .GlobalEnv); s4dot <- methods::new("CompletionDotSlot", .hidden = list(child = TRUE))');
  assert.deepEqual(await inspect("s4dot", [], "@"), available([".hidden"]));
  assert.deepEqual(await inspect("s4dot", [{ kind: "slot", name: ".hidden" }]),
    available(["child"]));
  await submit('makeActiveBinding("active_child", function() { hits <<- hits + 1L; list(secret = 1) }, env); delayedAssign("pending_idx", { hits <<- hits + 1L; 1L })');
  assert.deepEqual((await inspect("env", [], "$")).names.sort(), ["active_child", "empty", "inner"]);
  assert.deepEqual(await inspect("env", [{ kind: "field", name: "active_child" }]),
    { status: "suppressed", reason: "active-binding" });
  const envBracketActive = await inspectTyped("env", [], "[[");
  assert.equal(envBracketActive.status, "available");
  assert.equal(envBracketActive.kinds[envBracketActive.names.indexOf("active_child")], 2);
  assert.deepEqual(await inspect("env", [{ kind: "named-index", name: "active_child" }]),
    { status: "suppressed", reason: "active-binding" });
  assert.deepEqual(await inspect("plain", [{ kind: "variable-index", name: "pending_idx" }]),
    { status: "suppressed", reason: "deferred-binding" });
  await submit('R6Foo <- R6::R6Class("R6Foo", public = list(inner = list(item = 1), method = function() stop("must not call")), active = list(active = function(value) { hits <<- hits + 1L; 1L })); r6 <- R6Foo$new()');
  const r6names = await inspect("r6", [], "$");
  assert.equal(r6names.status, "available");
  for (const name of ["inner", "method", "active"]) assert.ok(r6names.names.includes(name));
  assert.deepEqual(await inspect("r6", [{ kind: "field", name: "inner" }]), available(["item"]));
  assert.deepEqual(await inspect("r6", [{ kind: "field", name: "active" }]),
    { status: "suppressed", reason: "active-binding" });
  assert.deepEqual(await inspect("r6", [{ kind: "field", name: "method" }]), available([]));
  assert.deepEqual(await inspect("classed", [], "$"), available(["inner"]));
  await submit('virtual_hits <- 0L; virtual_obj <- structure(list(storage = 1), class = "completion_virtual"); .DollarNames.completion_virtual <- function(x, pattern) { virtual_hits <<- virtual_hits + 1L; "public" }; `$.completion_virtual` <- function(x, name) { stop("must not execute") }; stopifnot(identical(utils::.DollarNames(virtual_obj), "public")); virtual_hits <- 0L');
  const virtualInput = "virtual_obj$";
  const virtualEntries = await completion.collectCompletionEntries(
    completion.getCompletionContext(virtualInput, virtualInput.length), undefined, undefined,
    { globalenv: { virtual_obj: { type: "list", class: ["completion_virtual"], names: ["public"] } } },
    [], [], undefined, (expression, target) =>
      backend.inspectMemberNames(session, parseRuntimeMemberQuery(expression, target)));
  assert.deepEqual(virtualEntries.map(entry => entry.label), ["public"]);
  await submit('cat("VIRTUAL_HITS:", virtual_hits, "\\n")');
  assert.match(output, /VIRTUAL_HITS:\s*0/);
  await submit('typed <- list(method = function() { hits <<- hits + 1L }, value = list(child = 1), constant = TRUE); env$method <- function() { hits <<- hits + 1L }; env$pending <- 1L; s4function <- "CompletionInspectFunction"; methods::setClass(s4function, slots = c(method = "function", value = "numeric")); sf <- methods::new(s4function, method = function() { hits <<- hits + 1L }, value = 1)');
  const classify = result => Object.fromEntries(result.names.map((name, index) => [name, result.kinds[index]]));
  const listMembers = await inspectTyped("typed");
  assert.equal(listMembers.status, "available");
  assert.equal(classify(listMembers).method, 1);
  assert.equal(classify(listMembers).value, 0);
  assert.equal(classify(listMembers).constant, 0);
  const envMembers = await inspectTyped("env");
  assert.equal(envMembers.status, "available");
  assert.equal(classify(envMembers).method, 1);
  assert.equal(classify(envMembers).active_child, 2);
  assert.equal(classify(envMembers).inner, 0);
  const r6Members = await inspectTyped("r6");
  assert.equal(r6Members.status, "available");
  assert.equal(classify(r6Members).method, 1);
  assert.equal(classify(r6Members).active, 2);
  assert.equal(classify(r6Members).inner, 0);
  const slotMembers = await inspectTyped("sf", [], "@");
  assert.equal(slotMembers.status, "available");
  assert.equal(classify(slotMembers).method, 1);
  assert.equal(classify(slotMembers).value, 0);
  await submit('delayedAssign("pending_member", { hits <<- hits + 1L; function() NULL }, assign.env = env)');
  const deferredMembers = await inspectTyped("env");
  assert.equal(classify(deferredMembers).pending_member, 3);
  // A nested promise must be suppressed without running its initializer.
  await submit('delayedAssign("lazy", { hits <<- hits + 1L; list(inner = 42) }, assign.env = env)');
  assert.deepEqual(await inspect("env", [{ kind: "field", name: "lazy" }]),
    { status: "suppressed", reason: "deferred-binding" });
  assert.deepEqual(await inspect("env", [{ kind: "named-index", name: "lazy" }]),
    { status: "suppressed", reason: "deferred-binding" });
  // Test the native response and frontend logging together for the exact
  // nested delayed-value scenario that previously produced no log.
  const logLines = [];
  const { logConsoleCompletionDecision } = loadSource("src/Language/completion/outputChannel.ts", {
    vscode: { window: { createOutputChannel: () => ({
      appendLine: line => logLines.push(line), dispose() {},
    }) } },
  });
  const nestedInput = "env$lazy$";
  const nested = completion.getCompletionContext(nestedInput, nestedInput.length);
  assert.equal(nested?.objectName, "env$lazy");
  const entries = await completion.collectCompletionEntries(nested, undefined, undefined,
    undefined, [], [], undefined, async (expression, operator) => {
      const query = parseRuntimeMemberQuery(expression, operator);
      assert.deepEqual(query, { root: "env",
        steps: [{ kind: "field", name: "lazy" }], target: "$" });
      const result = await backend.inspectMemberNames(session, query);
      if (result.status === "suppressed") {
        logConsoleCompletionDecision({ kind: "Suppressed", reason: result.reason },
          expression + operator);
      }
      return result;
    });
  assert.deepEqual(entries, []);
  assert.equal(logLines.length, 1, "native suppression must be visible in completion diagnostics");
  assert.match(logLines[0], /Request completion could run R code delayed until this value is first used/);
  assert.match(logLines[0], /Inspection stopped without evaluating it/);

  // Exercise the R-owned names vector across repeated allocations and GC.
  // The enumeration result must be protected inside its C callback before
  // control returns to Rust (the next R API call is too late).
  await submit('gc_env <- new.env(parent = emptyenv()); for (i in seq_len(200L)) assign(sprintf("entry_%03d", i), i, envir = gc_env)');
  for (let iteration = 0; iteration < 12; iteration++) {
    const result = await inspect("gc_env");
    assert.equal(result?.status, "available");
    assert.equal(result.names.length, 200);
    assert.ok(result.names.includes("entry_001"));
    assert.ok(result.names.includes("entry_200"));
    if (iteration % 4 === 3) await submit('invisible(gc())');
  }
  await submit('gc_env_limit <- new.env(parent = emptyenv()); for (i in seq_len(1001L)) assign(paste0("member", i), i, envir = gc_env_limit)');
  assert.deepEqual(await inspect("gc_env_limit"), { status: "unavailable" },
    "avoid sorting more environment names than the protocol can return");

  // Bound native work before allocating names for large environments and
  // before traversing long, mostly unnamed pairlists.
  await submit('large_env <- new.env(hash = TRUE, size = 8192L); for (i in seq_len(4200L)) assign(paste0("entry", i), i, envir = large_env); large_pair <- as.pairlist(setNames(rep(list(1L), 4200L), c(rep("", 4199L), "late"))); cat("LARGE_READY\\n")');
  await until(() => output.includes("LARGE_READY"), "large-object fixtures ready");
  assert.deepEqual(await inspect("large_env"), { status: "unavailable" });
  assert.deepEqual(await inspect("large_pair"), { status: "unavailable" });
  assert.deepEqual(await inspect("large_pair", [{ kind: "field", name: "late" }]), { status: "unavailable" });
  await submit('partial_limit <- setNames(rep(list(list(alpha = 1)), 4097L), c("inner", rep("unrelated", 4095L), "innate")); partial_unknown <- setNames(list(list(alpha = 1), list(beta = 2)), c("inner", bytes_name))');
  for (const root of ["partial_limit", "partial_unknown"]) {
    assert.deepEqual(await inspect(root, [{ kind: "field", name: "inn" }]), { status: "unavailable" },
      "do not claim a unique partial match when not every name can be checked");
    assert.deepEqual(await inspect(root, [{ kind: "field", name: "inner" }]), available(["alpha"]),
      "an exact match does not require checking later names");
  }
  await submit('wide_limit <- as.list(seq_len(1001L)); names(wide_limit) <- paste0("column", seq_len(1001L))');
  assert.deepEqual(await inspect("wide_limit"), { status: "unavailable" });
  // A single oversized label must be rejected before allocating a translated
  // UTF-8 string; completion may still report the other bounded labels.
  await submit('long_label <- setNames(list(1L, 2L), c(strrep("é", 6000L), "short"))');
  assert.deepEqual(await inspect("long_label"), available(["short"]));
  assert.deepEqual(await inspect("long_label", [{ kind: "field", name: "short" }]),
    available([]));
  // Latin-1 CHARSXPs require R_alloc-backed UTF-8 conversion. Repeated idle
  // completion must copy their names before resetting transient R storage.
  await submit('latin_names <- iconv(sprintf("caf\\u00e9_%03d", seq_len(80L)), from = "UTF-8", to = "latin1"); Encoding(latin_names) <- "latin1"; latin <- as.list(seq_along(latin_names)); names(latin) <- latin_names; rm(latin_names)');
  for (let iteration = 0; iteration < 80; ++iteration) {
    const names = await inspect("latin");
    assert.equal(names.status, "available");
    assert.equal(names.names.length, 80);
    assert.ok(names.names.includes("café_001"));
    assert.ok(names.names.includes("café_080"));
  }
  // A wide list must classify each member in a single pass, without repeatedly
  // looking up each name in the R thread. Include a callable at the last index.
  await submit('wide <- as.list(seq_len(999L)); names(wide) <- sprintf("column_%04d", seq_len(999L)); wide$method <- function() TRUE');
  const wideMembers = await inspectTyped("wide");
  assert.equal(wideMembers.status, "available");
  assert.equal(wideMembers.names.length, 1000);
  assert.equal(wideMembers.kinds[wideMembers.names.indexOf("method")], 1);
  assert.ok(wideMembers.names.includes("column_0999"));

  // Submitting R code invalidates stale completion work; inspecting the new
  // state must not be delayed by requests queued for the previous state.
  const obsolete = Array.from({ length: 12 }, () => inspectTyped("wide"));
  // Give the R thread an opportunity to enter the native inspector before
  // submission, then measure its impact on code execution. The R inspector
  // deadline is 450 ms; allow ample CI scheduling margin on slower hosts.
  await delay(5);
  const submissionStarted = Date.now();
  await submit('submission_priority <- list(ready = TRUE)');
  const submissionLatency = Date.now() - submissionStarted;
  assert.ok(submissionLatency < 3000,
    `in-flight inspection delayed code submission by ${submissionLatency} ms`);
  await Promise.all(obsolete);
  assert.deepEqual(await inspect("submission_priority"), available(["ready"]));
  // Parse-status requests belong to submission and must beat queued member
  // completions, even before the executable Submit frame is sent.
  const pendingCompletion = Array.from({ length: 12 }, () => inspectTyped("wide"));
  assert.equal(await backend.requestParseStatus(session, 'submission_priority$ready <- TRUE'), 1);
  await Promise.all(pendingCompletion);

  // Ordinary safe environments still complete within the preflight budget.
  assert.ok((await inspect("env")).names.includes("inner"));
  await submit('test <- data.table::data.table(xtest = 1:100); test2 <- as.data.frame(test)');
  assert.deepEqual(await inspect("test", [{ kind: "field", name: "xtest" }], "$"), available([]),
    "data.table stored scalar fields exhaust completion without suppression");
  assert.deepEqual(await inspect("test2", [{ kind: "field", name: "xtest" }], "$"), available([]),
    "data.frame stored scalar fields exhaust completion without suppression");
  assert.deepEqual(await inspect("test", [{ kind: "field", name: "xtest" },
    { kind: "field", name: "other" }], "$"), available([]),
    "further access on a scalar leaf exhausts completion without suppression");
  await submit('nested_table <- list(inner = data.table::data.table(value = 1L)); classed_table <- structure(list(value = 1L), class = c("custom", "data.table", "data.frame"))');
  assert.deepEqual(await inspect("nested_table", [{ kind: "field", name: "inner" },
    { kind: "field", name: "value" }], "$"), available([]),
    "nested stored scalar fields exhaust silently");
  assert.deepEqual(await inspect("classed_table", [{ kind: "field", name: "value" }], "$"),
    { status: "suppressed", reason: "unsafe-dispatch" },
    "custom-class accessor dispatch remains suppressed");
  const customBracket = await inspectTyped("classed_table", [], "[");
  assert.equal(customBracket.status, "available");
  assert.equal(customBracket.bracketKind, undefined,
    "custom classes must not masquerade as built-in method providers");
  // Native scalar exhaustion and the frontend decision log are both checked:
  // available-but-empty is not an unsafe completion rejection.
  const priorDiagnostics = logLines.length;
  for (const expression of ["plain$scalar", "test$xtest", "test2$xtest",
    "nested_table$inner$value"]) {
    const context = completion.getCompletionContext(expression + "$", expression.length + 1);
    assert.equal(context?.kind, "member", expression);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      undefined, [], [], undefined, async (receiver, operator) => {
        assert.equal(receiver, expression);
        const result = await backend.inspectMemberNames(session,
          parseRuntimeMemberQuery(receiver, operator));
        if (result.status === "suppressed") {
          logConsoleCompletionDecision({ kind: "Suppressed", reason: result.reason },
            receiver + operator);
        }
        return result;
      });
    assert.deepEqual(entries, [], expression);
  }
  assert.equal(logLines.length, priorDiagnostics,
    "proven scalar leaves never log suppression");

  const realTable = await inspectTyped("test", [], "[");
  assert.equal(realTable.status, "available");
  assert.equal(realTable.bracketKind, "data.table");
  assert.deepEqual(realTable.names, ["xtest"]);
  await submit('nested_dt <- list(tbl = data.table::data.table(amount = 1, code = "a"))');
  const tableBracket = await inspectTyped("nested_dt", [{ kind: "field", name: "tbl" }], "[");
  assert.equal(tableBracket.status, "available");
  assert.equal(tableBracket.bracketKind, "data.table");
  assert.deepEqual(tableBracket.names, ["amount", "code"]);
  for (const [marked, expected] of [
    ['nested_dt$tbl[1, mult = "│"]', undefined],
    ['nested_dt$tbl[1, roll = │]', undefined],
    ['nested_dt$tbl[, by = │]', 'code'],
    ['nested_dt$tbl[, .SDcols = │]', '"code"'],
    ['nested_dt$tbl[1, on = │]', '"code"'],
    ['test2[i = │]', '"xtest"'], ['test2[j = │]', undefined],
    ['test2[, j = │]', '"xtest"'], ['test2[i = │, ]', undefined],
  ]) {
    const cursor = marked.indexOf("│"), input = marked.replace("│", "");
    const entries = await completion.collectCompletionEntries(
      completion.getCompletionContext(input, cursor), undefined, undefined, undefined, [], [], undefined,
      (receiver, target) => backend.inspectMemberNames(session, parseRuntimeMemberQuery(receiver, target)));
    const column = marked.startsWith("test2") ? "xtest" : "code";
    assert.equal(entries.find(entry => entry.label === column)?.insertText, expected, marked);
  }
  await submit('stopifnot(identical(names(nested_dt$tbl[, .SD, .SDcols = "code"]), "code"), identical(names(nested_dt$tbl[, .N, by = code]), c("code", "N")), nrow(nested_dt$tbl[list("a"), on = "code"]) == 1L); cat("COLUMN_ARGUMENTS_VERIFIED\\n")');
  assert.match(output, /COLUMN_ARGUMENTS_VERIFIED/);
  await submit('stopifnot(identical(test2[i = "xtest"], test2["xtest"]), identical(test2[, j = "xtest"], test2[["xtest"]])); cat("FRAME_ARGUMENTS_VERIFIED\\n")');
  assert.match(output, /FRAME_ARGUMENTS_VERIFIED/);
  // [ on data.table selects rows (or joins); it cannot use a list-column view.
  await submit('slice_dt <- data.table::data.table(alpha = 1:3, beta = 4:6); slice_df <- as.data.frame(slice_dt); slice_list <- list(alpha = list(child = 1), beta = 2); slice_nested <- list(tbl = slice_dt); slice_index <- 2L; slice_name <- "alpha"; stopifnot(identical(names(slice_dt[1]), c("alpha", "beta")), identical(names(slice_dt[2]), c("alpha", "beta")))');
  for (const expression of ["slice_dt[1]", "slice_dt[2]", "slice_dt[3]",
    'slice_dt["alpha"]', "slice_dt[slice_index]", "slice_dt[slice_name]",
    "slice_nested$tbl[1]", "slice_dt[1][[1]]"]) {
    for (const target of ["$", "[", "[["]) {
      const result = await backend.inspectMemberNames(session, parseRuntimeMemberQuery(expression, target));
      assert.deepEqual(result, { status: "suppressed", reason: "unsafe-dispatch" }, expression + target);
      const input = expression + target;
      const context = completion.getCompletionContext(input, input.length);
      const items = await completion.collectCompletionEntries(context, undefined, undefined,
        undefined, [], [], undefined, (receiver, operator) =>
          backend.inspectMemberNames(session, parseRuntimeMemberQuery(receiver, operator)));
      assert.deepEqual(items, [], "suppressed rows must not become cached columns: " + input);
    }
  }
  for (const expression of ["slice_df[1]", "slice_list[1]"]) {
    assert.deepEqual(await backend.requestMemberNames(session, parseRuntimeMemberQuery(expression)), ["alpha"]);
  }
  assert.deepEqual(await backend.requestMemberNames(session, parseRuntimeMemberQuery("slice_dt")), ["alpha", "beta"]);
  assert.deepEqual(await backend.requestMemberNames(session, parseRuntimeMemberQuery("slice_dt[[1]]")), []);
  assert.deepEqual(await backend.requestMemberNames(session, parseRuntimeMemberQuery("slice_list[1][[1]]")), ["child"]);
  await submit('escaped <- list(); escaped[["a\\\"b"]] <- list(inner = TRUE)');
  const escapedQuery = parseRuntimeMemberQuery('escaped[["a\\"b"]]', "$");
  assert.equal(escapedQuery.steps[0].name, 'a"b');
  assert.deepEqual(await inspect(escapedQuery.root, escapedQuery.steps), available(["inner"]));
  output = "";
  await submit('cat("SAFE_HITS:", hits, "\\n")');
  await until(() => /SAFE_HITS:\s*0/.test(output), "counter output");
  assert.match(output, /SAFE_HITS:\s*0/);
});
