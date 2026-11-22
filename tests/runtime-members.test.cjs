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
    fs.rmSync(cwd, { recursive: true, force: true });
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
  await submit('obj <- list(inner = list(alpha = 1, beta = 2), df = data.frame("a b" = 1, check.names = FALSE))');
  assert.deepEqual(await inspect("obj", [{ kind: "field", name: "inner" }]), available(["alpha", "beta"]));
  assert.deepEqual(await inspect("obj", [{ kind: "index", index: 2 }]), available(["a b"]));
  const frameBracket = await inspectTyped("obj", [{ kind: "field", name: "df" }], "[");
  assert.equal(frameBracket.status, "available");
  assert.equal(frameBracket.bracketKind, "data.frame");
  assert.deepEqual(frameBracket.names, ["a b"]);
  assert.deepEqual(await inspect("obj", [{ kind: "field", name: "missing" }]), available([]));
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
  assert.deepEqual(await inspect("plain", [{ kind: "variable-index", name: "nm" }]), available(["alpha"]));
  assert.deepEqual(await inspect("plain", [{ kind: "variable-index", name: "idx" }]), available(["alpha"]));
  assert.deepEqual(await inspect("plain", [{ kind: "slice-index", index: 1 }]), available(["inner"]));
  assert.deepEqual(await inspect("plain", [{ kind: "field", name: "empty" }]), available([]));
  assert.deepEqual(await inspect("plain", [{ kind: "field", name: "scalar" }]), available([]));
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
  assert.deepEqual(await inspect("env", [{ kind: "field", name: "inner" }]), available(["value"]));
  assert.deepEqual(await inspect("env", [{ kind: "field", name: "empty" }]), available([]));
  output = "";
  await submit('cat("S4_READY:", exists("s4", envir = .GlobalEnv, inherits = FALSE), if (exists("s4", envir = .GlobalEnv, inherits = FALSE)) isS4(s4) else FALSE, if (exists("s4", envir = .GlobalEnv, inherits = FALSE)) paste(names(attributes(s4)), collapse = ",") else "", "\\n")');
  await until(() => output.includes("S4_READY:"), "S4 fixture state");
  assert.match(output, /S4_READY:\s*TRUE\s+TRUE/, "S4 object must exist before native inspection");
  assert.deepEqual(await inspect("s4", [], "@"), available(["inner"]), output);
  assert.deepEqual(await inspect("s4", [{ kind: "slot", name: "inner" }]), available(["slot_value"]));
  await submit('methods::setClass("CompletionDotSlot", slots = c(.hidden = "list"), where = .GlobalEnv); s4dot <- methods::new("CompletionDotSlot", .hidden = list(child = TRUE))');
  assert.deepEqual(await inspect("s4dot", [], "@"), available([".hidden"]));
  assert.deepEqual(await inspect("s4dot", [{ kind: "slot", name: ".hidden" }]),
    available(["child"]));
  await submit('makeActiveBinding("active_child", function() { hits <<- hits + 1L; list(secret = 1) }, env); delayedAssign("pending_idx", { hits <<- hits + 1L; 1L })');
  assert.deepEqual((await inspect("env", [], "$")).names.sort(), ["active_child", "empty", "inner"]);
  assert.deepEqual(await inspect("env", [{ kind: "field", name: "active_child" }]),
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
  assert.deepEqual(await inspect("large_pair", [{ kind: "field", name: "late" }]), available([]));
  await submit('wide_limit <- as.list(seq_len(1001L)); names(wide_limit) <- paste0("column", seq_len(1001L))');
  assert.deepEqual(await inspect("wide_limit"), { status: "unavailable" });
  // A single oversized label must be rejected before allocating a translated
  // UTF-8 string; completion may still report the other bounded labels.
  await submit('long_label <- setNames(list(1L, 2L), c(strrep("é", 6000L), "short"))');
  assert.deepEqual(await inspect("long_label"), available(["short"]));
  assert.deepEqual(await inspect("long_label", [{ kind: "field", name: "short" }]),
    available([]));
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
  await submit('submission_priority <- list(ready = TRUE)');
  await Promise.all(obsolete);
  assert.deepEqual(await inspect("submission_priority"), available(["ready"]));
  // Parse-status requests belong to submission and must beat queued member
  // completions, even before the executable Submit frame is sent.
  const pendingCompletion = Array.from({ length: 12 }, () => inspectTyped("wide"));
  assert.equal(await backend.requestParseStatus(session, 'submission_priority$ready <- TRUE'), 1);
  await Promise.all(pendingCompletion);

  // Ordinary safe environments still complete within the preflight budget.
  assert.ok((await inspect("env")).names.includes("inner"));
  await submit('nested_dt <- list(tbl = data.table::data.table(amount = 1, code = "a"))');
  const tableBracket = await inspectTyped("nested_dt", [{ kind: "field", name: "tbl" }], "[");
  assert.equal(tableBracket.status, "available");
  assert.equal(tableBracket.bracketKind, "data.table");
  assert.deepEqual(tableBracket.names, ["amount", "code"]);
  await submit('escaped <- list(); escaped[["a\\\"b"]] <- list(inner = TRUE)');
  const escapedQuery = parseRuntimeMemberQuery('escaped[["a\\"b"]]', "$");
  assert.equal(escapedQuery.steps[0].name, 'a"b');
  assert.deepEqual(await inspect(escapedQuery.root, escapedQuery.steps), available(["inner"]));
  output = "";
  await submit('cat("SAFE_HITS:", hits, "\\n")');
  await until(() => /SAFE_HITS:\s*0/.test(output), "counter output");
  assert.match(output, /SAFE_HITS:\s*0/);
});
