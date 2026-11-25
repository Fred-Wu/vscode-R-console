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
  if (input === "paste") {
    terminal.handleInput(`\x1b[200~${code}\n\x1b[201~`);
    assert.equal(terminal.submissionQueue.length, 0, "paste waits for Enter");
    return terminal.handleEnterKey();
  }
  terminal.handleInput(code + "\n");
  return terminal.programmaticSubmissionQueue;
}

for (const input of ["Enter", "editor", "paste"]) {
  for (const order of ["AB", "BA"]) {
    test(`${input === "paste" ? "paste + Enter" : input} uses its own ready R while the other console executes (connect ${order})`, async () => {
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

for (const target of ['members', 'arguments', 'source', 'binding']) test(`native ${target} completion cannot enter the parse-to-submit gap`, async () => {
  const a = consoleSession();
  a.connect();
  const { terminal } = a;
  const inspected = [];
  const expected = target === 'source' ? { status: "source", text: "function() list(leaf = 1)" } :
    target === 'binding' ? { status: "opaque" } :
    { status: target === 'arguments' ? "arguments" : "available", names: ["leaf"] };
  terminal.runtimeBackend.inspectMemberNames = (session, query) => {
    assert.equal(session, terminal.rProcess);
    inspected.push(query);
    assert.equal(query.target, target === 'members' ? '$' : target);
    return Promise.resolve(expected);
  };
  const inspect = () => target === 'arguments' ? terminal.requestStoredFunctionArguments('obj$method') :
    target === 'source' || target === 'binding' ? terminal.requestStoredFunctionSource("make_data", target) :
    terminal.requestStoredMemberCompletions("obj$inner", "$");
  assert.deepEqual(await inspect(), expected, "idle R still supports completion");

  const parse = deferred();
  let checked = 0;
  terminal.runtimeBackend.requestParseStatus = () => { checked++; return parse.promise; };
  terminal.inputState.insertText("answer <- 42");
  const pending = terminal.handleEnterKey();
  assert.equal(terminal.submissionQueue.at(-1)?.kind, "parse");
  assert.equal(inspect(), undefined, "accepted input suppresses new native inspection");
  await settle();
  assert.equal(checked, 1);
  assert.equal(inspect(), undefined, "native parsing must not allow completion to race");

  const originalSend = terminal.runtimeBackend.sendSessionCommand;
  terminal.runtimeBackend.sendSessionCommand = (session, command) => {
    if (command.type === "submit") {
      assert.equal(inspect(), undefined, "inspection remains blocked after parsing and before Submit");
    }
    return originalSend(session, command);
  };
  parse.resolve(1);
  await pending;
  assert.deepEqual(a.commands.map(command => command.code), ["answer <- 42"]);
  assert.equal(inspect(), undefined, "inspection remains blocked while code executes");
  assert.equal(inspected.length, 1, "no extra native calls during submission");

  nextPrompt(terminal);
  assert.deepEqual(await inspect(), expected, "completion resumes at the next idle prompt");
  assert.equal(inspected.length, 2);
});

test("an incomplete parse releases native inspection for the restored input", async () => {
  const a = consoleSession();
  a.connect();
  const { terminal } = a;
  const parse = deferred();
  terminal.runtimeBackend.requestParseStatus = () => parse.promise;
  let inspected = 0;
  terminal.runtimeBackend.inspectMemberNames = () => {
    inspected++;
    return Promise.resolve({ status: "available", names: ["child"] });
  };
  terminal.inputState.insertText("if");
  const pending = terminal.handleEnterKey();
  assert.equal(terminal.requestStoredMemberCompletions("obj", "$"), undefined);
  parse.resolve(2);
  await pending;
  assert.deepEqual(a.commands, []);
  assert.equal(terminal.submissionQueue.length, 0);
  assert.equal(terminal.activeSubmission, null);
  assert.equal((await terminal.requestStoredMemberCompletions("obj", "$"))?.status, "available");
  assert.equal(inspected, 1);
});

for (const input of ["editor", "paste"]) {
  test(`${input === "paste" ? "paste + Enter" : input} reserves parsing before native completion can start`, async () => {
    const a = consoleSession();
    a.connect();
    const parse = deferred();
    a.terminal.runtimeBackend.requestParseStatus = () => parse.promise;
    a.terminal.runtimeBackend.inspectMemberNames = () => {
      assert.fail("reserved input must not reach the inspector");
    };
    const pending = submit(a.terminal, input, "42");
    assert.equal(a.terminal.submissionQueue.at(-1)?.kind, "parse");
    assert.equal(a.terminal.requestStoredMemberCompletions("obj", "$"), undefined);
    parse.resolve(1);
    await pending;
    assert.deepEqual(a.commands.map(command => command.code), ["42"]);
  });
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
