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
  const inspect = (root, steps, slots = false) => backend.requestMemberNames(session, { root, steps, slots });
  await submit('obj <- list(inner = list(alpha = 1, beta = 2), df = data.frame("a b" = 1, check.names = FALSE))');
  assert.deepEqual(await inspect("obj", [{ kind: "field", name: "inner" }]), ["alpha", "beta"]);
  assert.deepEqual(await inspect("obj", [{ kind: "index", index: 2 }]), ["a b"]);
  assert.equal(await inspect("obj", [{ kind: "field", name: "missing" }]), undefined);
  await submit('obj$inner <- list(changed = TRUE)');
  assert.deepEqual(await inspect("obj", [{ kind: "field", name: "inner" }]), ["changed"]);

  await submit('hits <- 0L; makeActiveBinding("active_root", function() { hits <<- hits + 1L; list(inner = list(secret = 1)) }, .GlobalEnv); classed <- structure(list(inner = list(secret = 2)), class = "custom"); `$.custom` <- function(x, name) { hits <<- hits + 1L; x[[name]] }; delayedAssign("lazy_root", { hits <<- hits + 1L; list(inner = list(secret = 3)) })');
  for (const root of ["active_root", "classed", "lazy_root"]) {
    assert.equal(await inspect(root, [{ kind: "field", name: "inner" }]), undefined, root);
  }
  output = "";
  await submit('cat("SAFE_HITS:", hits, "\\n")');
  await until(() => /SAFE_HITS:\s*0/.test(output), "counter output");
  assert.match(output, /SAFE_HITS:\s*0/);
});
