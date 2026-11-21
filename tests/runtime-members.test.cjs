const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const loadSource = require("./helpers/load-source.cjs");
const { RustSidecarRuntimeBackend, getBundledRustSidecarPath } = loadSource("src/Runtime/runtimeBackend.ts");

test("real embedded R completion inspects nested storage without running user code", { timeout: 60000 }, async t => {
  const root = path.resolve(__dirname, "..");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-member-inspection-"));
  const rHome = execFileSync(process.env.R_TEST_EXECUTABLE || "R", ["RHOME"], { encoding: "utf8" }).trim();
  const rPath = path.join(rHome, "bin", process.platform === "win32" ? "R.exe" : "R");
  const backend = new RustSidecarRuntimeBackend(getBundledRustSidecarPath(root));
  const session = backend.start([rPath, "--vanilla", "--quiet"], { cwd, env: { ...process.env, R_HOME: rHome } });
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
  await submit('plain <- list(inner = list(alpha = 1), empty = list(), scalar = 1); named <- c(alpha = 10, beta = 20); idx <- 1L; nm <- "inner"; env <- new.env(parent = emptyenv()); env$inner <- list(value = TRUE); env$empty <- list(); s4name <- "CompletionInspect"; methods::setClass(s4name, slots = c(inner = "list")); s4 <- methods::new(s4name, inner = list(slot_value = TRUE))');
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
  await submit('duplicate <- setNames(list(1, 2), c("same", "same")); cat("DUPLICATE_READY\\n")');
  await until(() => output.includes("DUPLICATE_READY"), "duplicated-name fixture ready");
  assert.deepEqual(await inspect("duplicate", [], "$"), available(["same"]));
  assert.deepEqual(await inspect("duplicate", [{ kind: "slice-index", index: 2 }]), available(["same"]));
  assert.deepEqual((await inspect("env", [], "$")).names.sort(), ["empty", "inner"]);
  assert.deepEqual(await inspect("env", [{ kind: "field", name: "inner" }]), available(["value"]));
  assert.deepEqual(await inspect("env", [{ kind: "field", name: "empty" }]), available([]));
  assert.deepEqual(await inspect("s4", [], "@"), available(["inner"]));
  assert.deepEqual(await inspect("s4", [{ kind: "slot", name: "inner" }]), available(["slot_value"]));
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
  output = "";
  await submit('cat("SAFE_HITS:", hits, "\\n")');
  await until(() => /SAFE_HITS:\s*0/.test(output), "counter output");
  assert.match(output, /SAFE_HITS:\s*0/);
});
