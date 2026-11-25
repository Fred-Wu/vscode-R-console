const assert = require("node:assert/strict");
const { execFileSync, fork } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { RustSidecarRuntimeBackend, getBundledRustSidecarPath } =
  require("./helpers/load-source.cjs")("src/Runtime/runtimeBackend.ts");

test("persistent R retains the original LSP profile across extension-host death and detach/reattach", { timeout: 90000 }, async t => {
  const root = path.resolve(__dirname, "..");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-persistent-lsp-"));
  const library = path.join(cwd, "original-library");
  fs.mkdirSync(library);
  const profile = path.join(cwd, ".Rprofile"), marker = path.join(cwd, "profile-runs");
  fs.writeFileSync(profile, [
    `cat(if (any(basename(commandArgs(TRUE)) == "console-language-server.R")) "lsp" else as.character(Sys.getpid()), "\n", file=${JSON.stringify(marker)}, append=TRUE)`,
    `options(languageserver.max_completions=7L, rconsole.startup.bytes=as.raw(rep(0:255, 1024L)))`,
    'Sys.setenv(RCONSOLE_STARTUP_TEST="synthetic-persistent-profile-secret")',
    `.libPaths(c(${JSON.stringify(library)}, .libPaths()))`,
  ].join("\n") + "\n");
  const rHome = execFileSync(process.env.R_TEST_EXECUTABLE || "R", ["RHOME"], { encoding: "utf8" }).trim();
  const rPath = path.join(rHome, "bin", process.platform === "win32" ? "R.exe" : "R");
  const sidecar = getBundledRustSidecarPath(root);
  const backend = new RustSidecarRuntimeBackend(sidecar);
  let session = backend.start([rPath, "--quiet", "--no-save", "--no-restore"], {
    cwd, env: { ...process.env, R_HOME: rHome, R_PROFILE_USER: profile },
  });
  let output = "", failure, ready = false, runtimePid;
  const workers = [], servers = [], workspaces = [];
  t.after(async () => {
    for (const worker of workers) worker.kill("SIGKILL");
    for (const pid of servers) { try { process.kill(pid, "SIGKILL"); } catch {} }
    backend.close(session);
    backend.detach(session);
    if (runtimePid) { try { process.kill(runtimePid, "SIGKILL"); } catch {} }
    for (const folder of [...workspaces, cwd]) {
      await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  const wait = async condition => {
    const deadline = Date.now() + 20000;
    while (!condition()) {
      if (failure) throw failure;
      assert.ok(Date.now() < deadline, "persistent runtime operation timed out");
      await delay(20, undefined, { signal: t.signal });
    }
  };
  const attach = () => backend.attach(session, {
    onStdout: text => { output += text; },
    onError: error => { failure = error; },
    onControl: event => {
      if (event.type === "prompt" || (event.type === "session-state" && event.wait.kind === "top-level")) ready = true;
    },
  });
  attach();
  await wait(() => ready);
  const runtime = backend.getReconnectInfo(session);
  runtimePid = runtime.pid;
  assert.equal(await backend.loadLspStartupState(session), undefined);
  backend.sendSessionCommand(session, { type: "submit", code: 'persistent_probe <- 123L; cat(paste0("PROBE", "_READY"), "\\n")' });
  await wait(() => output.includes("PROBE_READY"));
  backend.detach(session);

  const startClient = async () => {
    const worker = fork(path.join(__dirname, "helpers/persistent-lsp-worker.cjs"), [], {
      env: { ...process.env, R_TEST_EXECUTABLE: rPath }, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    workers.push(worker);
    const result = once(worker, "message");
    worker.send({ runtime, cwd, profile, sidecar });
    const [message] = await Promise.race([result,
      once(worker, "exit").then(() => { throw new Error("LSP worker exited before becoming ready"); })]);
    assert.ok(!message.error, message.error);
    servers.push(message.lspPid); workspaces.push(message.workspace);
    assert.equal(message.count, 7, "the original language-server options survive");
    assert.equal(message.runtimePid, runtimePid, "the interactive R process survives");
    assert.equal(message.captured, true);
    assert.equal(message.leaked, false);
    assert.ok(message.libraries.some(value => fs.realpathSync(value) === fs.realpathSync(library)),
      "original library order is restored before live library metadata is supplied");
    assert.deepEqual(fs.readdirSync(message.workspace), []);
    return { worker, message };
  };
  const first = await startClient();
  assert.equal(first.message.captures, 1);
  const originalRuns = fs.readFileSync(marker, "utf8");
  // languageserver can also start its own metadata workers. Count only the
  // interactive process and the console-owned LSP whose lifetime we manage.
  for (const source of [String(runtimePid), "lsp"]) {
    assert.equal(originalRuns.trim().split(/\s+/).filter(value => value === source).length, 1);
  }
  const crashed = once(first.worker, "exit");
  first.worker.kill("SIGKILL");
  await crashed;
  try { process.kill(first.message.lspPid, "SIGKILL"); } catch {}
  fs.writeFileSync(profile, [
    'if (any(basename(commandArgs(TRUE)) == "console-language-server.R")) stop("profile replayed")',
    'options(languageserver.max_completions=1L)',
  ].join("\n") + "\n");
  for (let index = 0; index < 2; index++) {
    const next = await startClient();
    assert.equal(next.message.captures, 0, "reattach must retrieve the persistent snapshot");
    assert.equal(fs.readFileSync(marker, "utf8"), originalRuns);
    const stopped = once(next.worker, "exit");
    next.worker.send("detach");
    assert.equal((await stopped)[0], 0);
  }
  session = backend.reconnect(runtime);
  ready = false;
  attach();
  await wait(() => ready);
  const retained = await backend.loadLspStartupState(session);
  assert.ok(retained.includes(Buffer.from("synthetic-persistent-profile-secret")));
  retained.fill(0);
  backend.sendSessionCommand(session, { type: "submit", code: 'stopifnot(persistent_probe == 123L); cat(paste0("PERSISTENCE", "_OK"), "\\n")' });
  await wait(() => output.includes("PERSISTENCE_OK"));
});
