const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const loadSource = require("./helpers/load-source.cjs");
const { createTerminal, runtime, parser } = require("./helpers/submission-terminal.cjs");
const { RustSidecarRuntimeBackend, getBundledRustSidecarPath } = loadSource("src/Runtime/runtimeBackend.ts");

test("frontend continuations execute in order with real R parsing and evaluation", { timeout: 60000 }, async t => {
  const root = path.resolve(__dirname, "..");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-continuations-"));
  const rHome = execFileSync(process.env.R_TEST_EXECUTABLE || "R", ["RHOME"], { encoding: "utf8" }).trim();
  const rPath = path.join(rHome, "bin", process.platform === "win32" ? "R.exe" : "R");
  const settings = {
    executablePath: rPath, sessionWatcher: false,
    consoleArgs: ["--quiet", "--no-save", "--no-restore", "--no-site-file", "--no-environ"],
  };
  const { resolveRTerminalOptions } = loadSource("src/Terminal/options.ts", {
    vscode: {
      extensions: { getExtension: () => undefined },
      workspace: {
        getConfiguration: () => ({ get: key => settings[key] }),
        workspaceFolders: [{ uri: { fsPath: cwd } }],
      },
      window: { showErrorMessage: message => { throw new Error(message); } },
    },
  });
  const options = resolveRTerminalOptions();
  assert.ok(options);
  const binary = getBundledRustSidecarPath(root);
  assert.ok(fs.existsSync(binary), "Build and stage the sidecar before running test:runtime");
  const backend = new RustSidecarRuntimeBackend(binary);
  const { terminal, history } = createTerminal();
  const sent = [], checked = [], nativeResults = [];
  let output = "", failure, ready = false;
  const send = backend.sendSessionCommand.bind(backend);
  backend.sendSessionCommand = (session, command) => {
    sent.push(command);
    return send(session, command);
  };
  const session = backend.start([rPath, ...options.rArgs], {
    cwd,
    env: { ...options.env, R_PROFILE_USER: path.join(root, "resources/r/console-profile.R") },
  });
  terminal.runtimeBackend = backend;
  terminal.rProcess = session;
  parser.setNativeParseCallback(code => {
    checked.push(code);
    const result = backend.requestParseStatus(session, code);
    if (!result) {
      failure = new Error("real native parser must be available");
      throw failure;
    }
    return result.then(status => { nativeResults.push({ code, status }); return status; });
  });
  t.after(async () => {
    parser.setNativeParseCallback(null);
    terminal.cancelPendingSubmissions();
    const pid = backend.getPid(session);
    backend.close(session);
    backend.detach(session);
    await delay(100);
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), `r-console-session-${session.sessionId}.json`), { force: true });
  });
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (failure) throw failure;
      assert.ok(Date.now() < deadline,
        `${label}: mode=${terminal.mode}, draft=${JSON.stringify(terminal.inputState.text)}, queue=${JSON.stringify(terminal.submissionQueue)}, sent=${JSON.stringify(sent)}, checked=${JSON.stringify(checked)}\n${output}`);
      await delay(10, undefined, { signal: t.signal });
    }
  };
  const idle = () => terminal.mode === "ready" && !terminal.activeSubmission && terminal.submissionQueue.length === 0;
  const receiveOutput = text => {
    output += text;
    // Match handleRuntimeOutput's execution acknowledgement; rendering is stubbed.
    if (terminal.activeSubmission) terminal.awaitingExecutionStart = false;
  };
  backend.attach(session, {
    onStdout: receiveOutput, onStderr: receiveOutput,
    onError: error => { failure = error; },
    onControl: event => {
      if (event.type === "prompt") {
        runtime.handleBackendPrompt(terminal.runtimeHostAdapter, event.kind);
        ready = true;
      } else if (["busy", "input-request", "input-end"].includes(event.type)) {
        runtime.handleRuntimeControl(terminal.runtimeHostAdapter, event);
      } else if (event.type === "session-state" && event.wait.kind === "top-level") {
        ready = true;
      }
    },
  });
  await waitFor(() => ready && backend.canUseSessionCommands(session), "startup");

  for (const overlap of [true, false]) {
    terminal.inputState.insertText("if");
    const first = terminal.handleEnterKey();
    if (!overlap) await first;
    const marker = `IF_${overlap}_OK`;
    terminal.inputState.insertText(`(TRUE) cat("${marker}\\n")`);
    await Promise.all([first, terminal.handleEnterKey()]);
    await waitFor(() => idle() && output.includes(marker), marker);
    assert.equal(terminal.inputState.text, "");
  }
  assert.ok(nativeResults.some(result => result.code === "if" && result.status === 2),
    "native R, without an injected delay, identifies the incomplete predecessor");

  for (const timing of ["overlap", "parsed", "restored"]) {
    const start = sent.length;
    terminal.handleInput("Sys.sleep(0.2)\nx <- (\n");
    if (timing !== "overlap") await terminal.programmaticSubmissionQueue;
    if (timing === "restored") {
      await waitFor(() => idle() && terminal.inputState.text === "x <- (\n", "restore continuation");
    }
    terminal.handleInput("2)\n");
    await waitFor(() => idle() && sent.length === start + 2, `complete ${timing} continuation`);
    assert.deepEqual(sent.slice(start).map(c => c.code), ["Sys.sleep(0.2)", "x <- (\n2)"]);
    assert.equal(terminal.inputState.text, "");
    const marker = `CONTINUATION_${timing}_OK`;
    terminal.handleInput(`stopifnot(identical(x, 2)); cat("${marker}\\n")\n`);
    await waitFor(() => idle() && output.includes(marker), marker);
  }

  for (const code of [
    'cat("BATCH_FIRST\\n")\nscore <- function(x) {\n  if (x > 0) {\n',
    '    x * 2\n  } else {\n',
    '    -x\n  }\n}\nscore(3)\nanswer <- (\n',
    '  score(-4) +\n  1\n)\nstopifnot(score(3) == 6, answer == 5); cat("BATCH_LAST\\n")\n',
  ]) terminal.handleInput(code);
  await waitFor(() => idle() && output.includes("BATCH_LAST"), "nested batches");
  assert.ok(output.indexOf("BATCH_FIRST") < output.indexOf("BATCH_LAST"));
  assert.ok(history.includes("score(3)"));
  assert.ok(checked.includes("x <- (\n2)"), "combined text reaches the native parser");
  assert.ok(nativeResults.some(result => result.code === "x <- (\n2)" && result.status === 1),
    "native R validates the combined expression when available");

  for (const overlap of [false, true]) {
    terminal.inputState.insertText('  x <- paste("a');
    const first = terminal.handleEnterKey();
    if (!overlap) await first;
    terminal.inputState.insertText('b")');
    await Promise.all([first, terminal.handleEnterKey()]);
    await waitFor(idle, "multiline string assignment");
    const marker = `STRING_${overlap}_OK`;
    terminal.handleInput(`stopifnot(identical(x, "a\\n  b")); cat("${marker}\\n")\n`);
    await waitFor(() => idle() && output.includes(marker), marker);
  }

  for (const [opening, closing, label] of [
    ['x <- "a  ', 'b"', "QUOTED"],
    ['x <- r"(a  ', 'b)"', "RAW"],
  ]) {
    terminal.inputState.insertText(opening);
    await terminal.handleEnterKey();
    await terminal.handleEnterKey();
    terminal.inputState.insertText(closing);
    await terminal.handleEnterKey();
    await waitFor(idle, "literal whitespace assignment");
    const marker = `${label}_WHITESPACE_OK`;
    terminal.handleInput(`stopifnot(identical(x, "a  \\n\\nb")); cat("${marker}\\n")\n`);
    await waitFor(() => idle() && output.includes(marker), marker);
  }

  terminal.inputState.insertText('x <- "a');
  terminal.handleInput("\r\r\r");
  await waitFor(() => idle() && terminal.inputState.text === 'x <- "a\n\n\n', "coalesced continuation Enters");
  terminal.inputState.insertText('b"');
  await terminal.handleEnterKey();
  await waitFor(idle, "coalesced Enter assignment");
  terminal.handleInput('stopifnot(identical(x, "a\\n\\n\\nb")); cat("COALESCED_ENTER_OK\\n")\n');
  await waitFor(() => idle() && output.includes("COALESCED_ENTER_OK"), "coalesced Enter value");

  terminal.inputState.insertText("x <- c(1,2");
  terminal.inputState.cursorPosition = 9;
  await terminal.handleEnterKey();
  assert.equal(terminal.inputState.text, "x <- c(1,\n2");
  assert.equal(terminal.inputState.cursorPosition, 10);
  terminal.inputState.insertText("3,");
  terminal.inputState.cursorToEnd();
  terminal.inputState.insertText(")");
  await terminal.handleEnterKey();
  await waitFor(idle, "cursor edit assignment");
  terminal.handleInput('stopifnot(identical(x, c(1, 3, 2))); cat("CURSOR_EDIT_OK\\n")\n');
  await waitFor(() => idle() && output.includes("CURSOR_EDIT_OK"), "cursor edit value");

  const historyStart = history.length;
  terminal.handleInput('cat("HISTORY_KEEP\\n")\nSys.sleep(30)\n42\n');
  const interruptedBatch = terminal.programmaticSubmissionQueue;
  await waitFor(() => output.includes("HISTORY_KEEP") &&
    terminal.activeSubmission?.code === "Sys.sleep(30)" && !terminal.awaitingExecutionStart, "sleep before interrupt");
  terminal.handleInput("\x03");
  await interruptedBatch;
  await waitFor(idle, "interrupt recovery");
  // If a busy CI runner processes the 150 ms fallback before Ctrl+C, 42 may
  // already have been accepted too. Earlier entries must survive either timing;
  // the unit test gates the later check to cover cancellation while it is pending.
  assert.deepEqual(history.slice(historyStart, historyStart + 2), ['cat("HISTORY_KEEP\\n")', "Sys.sleep(30)"]);
  assert.equal(history.filter(code => code === 'cat("HISTORY_KEEP\\n")').length, 1);
  assert.doesNotMatch(output, /Error/);
});
