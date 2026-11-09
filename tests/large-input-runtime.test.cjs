const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const loadSource = require("./helpers/load-source.cjs");
const { RustSidecarRuntimeBackend, getBundledRustSidecarPath } = loadSource("src/Runtime/runtimeBackend.ts");

test("real R consumes large input and recovers from interrupted submissions", { timeout: 60000 }, async t => {
  const root = path.resolve(__dirname, "..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-large-input-"));
  const rHome = execFileSync(process.env.R_TEST_EXECUTABLE || "R", ["RHOME"], { encoding: "utf8" }).trim();
  const rPath = path.join(rHome, "bin", process.platform === "win32" ? "R.exe" : "R");
  const backend = new RustSidecarRuntimeBackend(getBundledRustSidecarPath(root));
  const session = backend.start([rPath, "--vanilla", "--quiet"], {
    cwd: directory, env: { ...process.env, R_HOME: rHome },
  });
  let failure, output = "";
  const events = [];
  backend.attach(session, {
    onStdout: text => { output += text; },
    onStderr: text => { output += text; },
    onControl: event => { events.push(event); },
    onError: error => { failure = error; },
  });
  t.after(async () => {
    const pid = backend.getPid(session);
    backend.close(session);
    backend.detach(session);
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(path.join(os.tmpdir(), `r-console-session-${session.sessionId}.json`), { force: true });
  });
  const waitFor = async (predicate, label, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (failure) throw failure;
      assert.ok(Date.now() < deadline, `${label}\n${output.slice(-2000)}`);
      await delay(10, undefined, { signal: t.signal });
    }
  };
  const prompted = start => events.slice(start).some(event => event.type === "prompt" && event.kind === "main");
  const send = code => {
    const start = events.length;
    output = "";
    assert.equal(backend.sendSessionCommand(session, { type: "submit", code }), true);
    return start;
  };
  const submit = async code => {
    const start = send(code);
    await waitFor(() => prompted(start), "submission must return a prompt");
    assert.doesNotMatch(output, /Error/);
  };
  const verify = async code => {
    await submit(`${code}; cat("VERIFIED\\n")`);
    assert.match(output, /VERIFIED/);
  };
  const interrupt = async () => {
    const start = events.length;
    assert.equal(backend.sendSessionCommand(session, { type: "interrupt" }), true);
    await waitFor(() => prompted(start), "interrupt must restore the prompt", 5000);
    assert.doesNotMatch(output, /UNREAD_INPUT_EXECUTED/);
  };
  await waitFor(() => backend.canUseSessionCommands(session) && events.some(event =>
    event.type === "prompt" || (event.type === "session-state" && event.wait.kind === "top-level")), "startup");

  await t.test("assignments crossing R buffer boundaries preserve their values", async () => {
    // Include exact and adjacent chunk boundaries, plus a real 1 MiB string.
    for (const bytes of [4094, 4095, 4096, 8190, 1024 * 1024]) {
      const prefix = 'chunk <- "';
      const length = bytes - prefix.length - 1;
      await submit(prefix + "a".repeat(length) + '"');
      await verify(`stopifnot(identical(chunk, strrep("a", ${length})))`);
    }
  });

  await t.test("a full 16 MiB submission executes and accepts the next command", async () => {
    const size = 16 * 1024 * 1024;
    const prefix = "large_total <- 42\n";
    const line = "#" + "a".repeat(1022) + "\n";
    const padding = size - prefix.length;
    const code = prefix + line.repeat(Math.floor(padding / line.length)) + "#".repeat(padding % line.length);
    assert.equal(Buffer.byteLength(code), size);
    await submit(code);
    await verify("stopifnot(identical(large_total, 42))");
  });

  await t.test("interrupting a long line discards its unread remainder and later lines", async () => {
    await submit('interrupted <- "unchanged"');
    const prefix = 'interrupted <- "';
    const suffix = '"\nstop("UNREAD_INPUT_EXECUTED")';
    const code = prefix + "a".repeat(16 * 1024 * 1024 - prefix.length - suffix.length) + suffix;
    const start = send(code);
    // R reports not-busy before each read. Wait for refills, not transport acceptance.
    await waitFor(() => events.slice(start).filter(event => event.type === "busy" && !event.value).length >= 4,
      "R must start reading the long line");
    assert.equal(prompted(start), false);
    await interrupt();
    await verify('stopifnot(identical(interrupted, "unchanged"))');
    assert.equal(await backend.requestParseStatus(session, "1 + 1"), 1);
  });

  await t.test("interrupting evaluation discards later lines of the active submission", async () => {
    const start = send('Sys.sleep(30)\nstop("UNREAD_INPUT_EXECUTED")');
    await waitFor(() => events.slice(start).some(event => event.type === "busy" && event.value), "busy evaluation");
    assert.equal(backend.sendSessionCommand(session, {
      type: "submit", code: 'stop("UNREAD_INPUT_EXECUTED")',
    }), true);
    await interrupt();
    await verify("stopifnot(6 * 7 == 42)");
  });

  await t.test("nested input spanning buffers ends once and preserves its value", async () => {
    const start = send('reply <- scan(what = character(), nlines = 1, quiet = TRUE)');
    await waitFor(() => events.slice(start).some(event => event.type === "input-request"), "nested input");
    assert.equal(backend.sendSessionCommand(session, { type: "reply-input", text: "a".repeat(65536) }), true);
    await waitFor(() => prompted(start), "nested reply must return a prompt");
    assert.equal(events.slice(start).filter(event => event.type === "input-end").length, 1);
    await verify('stopifnot(identical(reply, strrep("a", 65536)))');
  });

  await t.test("interrupting nested input leaves the session usable", async () => {
    const start = send('readline("CANCEL_REPLY>")');
    await waitFor(() => events.slice(start).some(event => event.type === "input-request"), "nested input");
    await interrupt();
    await verify("stopifnot(6 * 7 == 42)");
  });
});
