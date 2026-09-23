const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const loadSource = require("./helpers/load-source.cjs");

test("real R evaluates, handles nested input and interrupts, reconnects, and shuts down", { timeout: 60000 }, async (t) => {
  const root = path.resolve(__dirname, "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-smoke-"));
  let backend;
  let session;
  let pid;
  const alive = () => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  t.after(() => {
    try {
      if (session) {
        pid ??= backend.getPid(session);
        backend.close(session);
        backend.detach(session);
        if (alive()) process.kill(pid, "SIGKILL");
        fs.rmSync(path.join(os.tmpdir(), `r-console-session-${session.sessionId}.json`), { force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const profile = path.join(dir, "profile.R");
  fs.writeFileSync(profile, "options(r.console.smoke.profile = TRUE)\n");
  const rHome = execFileSync(process.env.R_TEST_EXECUTABLE || "R", ["RHOME"], { encoding: "utf8" }).trim();
  const rPath = path.join(rHome, "bin", process.platform === "win32" ? "R.exe" : "R");
  const settings = {
    executablePath: rPath,
    sessionWatcher: false,
    "rterm.option": ["--quiet", "--no-save", "--no-restore", "--no-site-file", "--no-environ"],
  };
  const { resolveRTerminalOptions } = loadSource("src/Terminal/options.ts", {
    vscode: {
      extensions: { getExtension: () => undefined },
      workspace: {
        getConfiguration: () => ({ get: (key) => settings[key] }),
        workspaceFolders: [{ uri: { fsPath: dir } }],
      },
      window: { showErrorMessage: (message) => { throw new Error(message); } },
    },
  });
  const options = resolveRTerminalOptions();
  assert.ok(options);
  const { RustSidecarRuntimeBackend, getBundledRustSidecarPath } = loadSource("src/Runtime/runtimeBackend.ts");
  const binary = getBundledRustSidecarPath(root);
  assert.ok(fs.existsSync(binary), "Build and stage the sidecar before running test:runtime");
  backend = new RustSidecarRuntimeBackend(binary);
  let output = "";
  let failure;
  const events = [];
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (failure) throw failure;
      assert.ok(Date.now() < deadline, `${label}\n${output.slice(-2000)}`);
      await delay(20, undefined, { signal: t.signal });
    }
  };
  const handlers = {
    onStdout: (text) => { output += text; },
    onStderr: (text) => { output += text; },
    onControl: (event) => { events.push(event); },
    onError: (error) => { failure = error; },
  };
  const isPrompt = (event) => event.type === "prompt" && event.kind === "main";
  const submit = async (code, expected) => {
    const start = events.length;
    output = "";
    assert.equal(backend.sendSessionCommand(session, { type: "submit", code }), true);
    await waitFor(() => output.includes(expected) && events.slice(start).some(isPrompt), expected);
  };
  session = backend.start([rPath, ...options.rArgs], {
    cwd: dir,
    env: {
      ...options.env,
      R_PROFILE_USER: path.join(root, "resources/r/console-profile.R"),
      R_PROFILE_USER_OLD: profile,
    },
  });
  backend.attach(session, handlers);
  await waitFor(() => backend.canUseSessionCommands(session) && events.some((event) =>
    isPrompt(event) || (event.type === "session-state" && event.wait.kind === "top-level")), "startup");
  pid = backend.getPid(session);
  assert.ok(pid);
  assert.equal(await backend.requestParseStatus(session, "x <- ("), 2);
  await submit('stopifnot(isTRUE(getOption("r.console.smoke.profile")), getOption("prompt") == "> "); answer <- 6 * 7; cat("ANSWER:", answer, "\\n")', "ANSWER: 42");
  await submit('stop("EXPECTED_SMOKE_ERROR")', "EXPECTED_SMOKE_ERROR");

  const inputStart = events.length;
  assert.equal(backend.sendSessionCommand(session, { type: "submit", code: 'reply <- readline("SMOKE_INPUT>"); cat("REPLY:", reply, "\\n")' }), true);
  await waitFor(() => events.slice(inputStart).some((event) => event.type === "input-request"), "nested input");
  assert.equal(backend.sendSessionCommand(session, { type: "reply-input", text: "hello" }), true);
  await waitFor(() => output.includes("REPLY: hello") && events.slice(inputStart).some(isPrompt), "nested reply");

  const busyStart = events.length;
  assert.equal(backend.sendSessionCommand(session, { type: "submit", code: "Sys.sleep(30)" }), true);
  await waitFor(() => events.slice(busyStart).some((event) => event.type === "busy" && event.value), "busy state");
  assert.equal(backend.sendSessionCommand(session, { type: "interrupt" }), true);
  await waitFor(() => events.slice(busyStart).some(isPrompt), "interrupt recovery");

  const reconnect = backend.getReconnectInfo(session);
  assert.ok(reconnect);
  backend.detach(session);
  assert.equal(alive(), true, "detach must preserve the R process");
  backend = new RustSidecarRuntimeBackend(binary);
  session = backend.reconnect(reconnect);
  events.length = 0;
  backend.attach(session, handlers);
  await waitFor(() => backend.canUseSessionCommands(session) && events.some((event) =>
    event.type === "session-state" && event.wait.kind === "top-level"), "reconnect");
  await submit('cat("RESTORED:", answer, "\\n")', "RESTORED: 42");
  backend.close(session);
  await waitFor(() => !alive(), "shutdown must terminate R");
});
