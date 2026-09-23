const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { canSubmitRuntimeHiddenCommand, submitRuntimeHiddenCommand } =
  loadSource("src/Terminal/rTerminal/runtime.ts", { vscode: {} });

function readyHost() {
  const calls = [];
  return {
    calls,
    mode: "ready", promptReady: true, promptKind: "main",
    activeSubmission: null, submissionPending: false,
    inputState: { text: "" }, promptVisible: true, pendingPromptToken: true,
    rProcess: { sessionId: "session" },
    runtimeBackend: {
      canUseSessionCommands: () => true,
      sendSessionCommand: (session, command) => { calls.push({ session, command }); return true; },
    },
    clearPromptRenderTimer: () => calls.push("clear timer"),
    clearInputRender: () => calls.push("clear input"),
  };
}

test("hidden commands require an idle main prompt, empty input, and a usable session", () => {
  assert.equal(canSubmitRuntimeHiddenCommand(readyHost()), true);
  for (const blocked of [
    { mode: "starting" }, { mode: "executing" }, { mode: "reply" }, { mode: "closed" },
    { promptReady: false }, { promptKind: "cont" },
    { activeSubmission: { code: "1 + 1" } }, { submissionPending: true },
    { inputState: { text: "x" } }, { runtimeBackend: undefined },
    { runtimeBackend: { canUseSessionCommands: () => false } },
  ]) {
    const host = Object.assign(readyHost(), blocked);
    assert.equal(canSubmitRuntimeHiddenCommand(host), false);
    assert.deepEqual(host.calls, []);
  }
});

test("accepted hidden commands clear the prompt after sending and enter executing mode", () => {
  const host = readyHost();
  assert.equal(submitRuntimeHiddenCommand(host, "sess::connect()"), true);
  assert.deepEqual(host.calls, [
    { session: host.rProcess, command: { type: "submit", code: "sess::connect()" } },
    "clear timer", "clear input",
  ]);
  assert.equal(host.promptVisible, false);
  assert.equal(host.pendingPromptToken, false);
  assert.equal(host.mode, "executing");
});

test("failed hidden submissions leave prompt and execution state intact", () => {
  for (const backend of [undefined, { sendSessionCommand: () => false }]) {
    const host = readyHost();
    host.runtimeBackend = backend;
    assert.equal(submitRuntimeHiddenCommand(host, "sess::connect()"), false);
    assert.deepEqual(host.calls, []);
    assert.equal(host.promptVisible, true);
    assert.equal(host.pendingPromptToken, true);
    assert.equal(host.mode, "ready");
  }
});

test("hidden submissions preserve closed mode and do not erase an invisible prompt", () => {
  const host = readyHost();
  host.mode = "closed";
  host.promptVisible = false;
  assert.equal(submitRuntimeHiddenCommand(host, "invisible(NULL)"), true);
  assert.equal(host.mode, "closed");
  assert.equal(host.calls.includes("clear input"), false);
  assert.equal(host.pendingPromptToken, false);
});
