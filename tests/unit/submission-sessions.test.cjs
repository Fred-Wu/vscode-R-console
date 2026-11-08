const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createTerminal, nextPrompt, deferred, runtime } = require("../helpers/submission-terminal.cjs");
const settle = () => new Promise(resolve => setImmediate(resolve));

function consoleSession() {
  const fixture = createTerminal();
  const { terminal } = fixture;
  const checked = [], closed = [], detached = [];
  let handlers;
  Object.assign(terminal.runtimeBackend, {
    hasCapability: () => true,
    requestParseStatus(session, code) {
      assert.equal(session, terminal.rProcess);
      checked.push(code);
      return Promise.resolve(code === "if" ? 2 : 1);
    },
    attach(_session, callbacks) { handlers = callbacks; },
    detach(session) { detached.push(session); },
    close(session) { closed.push(session); },
    getPid() {},
  });
  terminal.rHistory.dispose = () => {};
  terminal.syntax.dispose = () => {};
  terminal.lang.dispose = async () => {};
  terminal.terminalState = { dispose() {} };
  terminal.exportPersistentState = () => ({ sessionId: "test" });
  function connect() {
    runtime.attachRuntimeSession(terminal.runtimeHostAdapter);
    handlers.onControl({ type: "host-connected" });
  }
  return { ...fixture, checked, closed, detached, connect, get handlers() { return handlers; } };
}

function submit(terminal, input, code) {
  if (input === "Enter") {
    terminal.inputState.insertText(code);
    return terminal.handleEnterKey();
  }
  terminal.handleInput(input === "editor" ? code + "\n" : `\x1b[200~${code}\n\x1b[201~`);
  return terminal.programmaticSubmissionQueue;
}

for (const input of ["Enter", "editor", "paste"]) {
  for (const order of ["AB", "BA"]) {
    test(`${input} uses its own ready R while the other console executes (connect ${order})`, async () => {
      const a = consoleSession(), b = consoleSession();
      for (const fixture of order === "AB" ? [a, b] : [b, a]) fixture.connect();
      await b.terminal.handleProgrammaticSubmission("Sys.sleep(30)\n");
      await submit(a.terminal, input, "42");
      await settle();
      assert.deepEqual(a.checked, ["42"]);
      assert.deepEqual(a.commands.map(c => c.code), ["42"]);
      assert.deepEqual(b.checked, ["Sys.sleep(30)"]);
      assert.equal(b.terminal.mode, "executing");
    });
  }
}

const lifecycle = {
  "connect without parse capability": b => {
    b.terminal.runtimeBackend.hasCapability = () => false;
    b.connect();
  },
  "busy session snapshot": b => b.handlers.onControl({ type: "session-state", busy: true, wait: { kind: "none" } }),
  "interrupt": b => b.terminal.interruptR(),
  "exit": b => b.handlers.onExit(0),
  "error": b => b.handlers.onError(new Error("connection failed")),
  "detach": b => b.terminal.detachPersistentSession(),
  "close": b => b.terminal.forceClose(),
};
for (const [name, action] of Object.entries(lifecycle)) {
  test(`another console's ${name} cannot release or disable an owned native check`, async () => {
    const a = consoleSession(), b = consoleSession();
    a.connect(); b.connect();
    a.terminal.mode = "executing";
    a.terminal.promptReady = false;
    const pending = a.terminal.handleProgrammaticSubmission("if\n");
    await settle();
    await action(b);
    await settle();
    assert.deepEqual(a.checked, [], "A still waits for its own prompt");
    assert.deepEqual(a.commands, []);
    nextPrompt(a.terminal);
    await pending;
    assert.ok(a.checked.length > 0 && a.checked.every(code => code === "if"));
    assert.deepEqual(a.commands, [], "native incomplete result is respected");
    assert.equal(a.terminal.inputState.text, "if\n");
    a.terminal.inputState.insertText("(TRUE) 42");
    await a.terminal.handleEnterKey();
    assert.deepEqual(a.commands.map(c => c.code), ["if\n(TRUE) 42"]);
  });
}

for (const name of ["exit", "error", "detach", "close"]) {
  for (const phase of ["waiting", "in flight"]) {
    test(`${name} cancels its own ${phase} parse without leaking source into a replacement session`, async () => {
      const a = consoleSession();
      a.connect();
      const check = deferred();
      if (phase === "waiting") {
        a.terminal.mode = "executing";
        a.terminal.promptReady = false;
      } else {
        a.terminal.runtimeBackend.requestParseStatus = () => check.promise;
      }
      const pending = a.terminal.handleProgrammaticSubmission("if\n");
      await settle();
      await lifecycle[name](a);
      if (phase === "waiting") await pending; // Cancellation must wake without an R event.
      a.terminal.rProcess = {};
      a.terminal.mode = "ready";
      a.terminal.promptReady = true;
      a.terminal.runtimeBackend.requestParseStatus = () => Promise.resolve(1);
      a.connect();
      check.resolve(2);
      await pending;
      assert.deepEqual(a.commands, []);
      assert.equal(a.terminal.inputState.text, "");
      await a.terminal.handleProgrammaticSubmission("42\n");
      assert.deepEqual(a.commands.map(c => c.code), ["42"]);
    });
  }
}

test("late callbacks from a replaced session cannot mutate or close its replacement", async () => {
  const a = consoleSession();
  a.connect();
  const stale = a.handlers;
  a.terminal.cancelPendingSubmissions();
  a.terminal.rProcess = {};
  a.connect();
  const generation = a.terminal.submissionGeneration;
  stale.onStdout("stale output");
  stale.onStderr("stale error");
  stale.onControl({ type: "input-request", prompt: "stale reply" });
  stale.onControl({ type: "busy", value: true });
  stale.onExit(1);
  stale.onError(new Error("stale failure"));
  assert.equal(a.terminal.mode, "ready");
  assert.equal(a.terminal.promptReady, true);
  assert.equal(a.terminal.submissionGeneration, generation);
  assert.deepEqual(a.closed, []);
  assert.deepEqual(a.output, []);
  await a.terminal.handleProgrammaticSubmission("42\n");
  assert.deepEqual(a.checked, ["42"]);
});

test("losing parser availability uses the local fallback, not a fabricated native complete result", async () => {
  const a = consoleSession();
  a.connect();
  a.terminal.runtimeBackend.requestParseStatus = () => undefined;
  await a.terminal.handleProgrammaticSubmission("if\n");
  assert.deepEqual(a.commands, []);
  assert.equal(a.terminal.inputState.text, "if\n");
});
