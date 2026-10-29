const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { RustSidecarRuntimeBackend } = loadSource("src/Runtime/runtimeBackend.ts");
const parser = loadSource("src/Language/parser.ts");

test("native parse timeout settles the request, permits fallback, and ignores late replies", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const backend = new RustSidecarRuntimeBackend("unused");
  const session = { sessionId: "parse-timeout" };
  const state = {
    hostConnected: true, capabilities: new Set(["parse-status"]),
    nextRequestId: 0, pendingParseRequests: new Map(),
  };
  backend.sessionStates.set(session, state);
  backend.writeFrame = () => true;

  const rejected = assert.rejects(backend.requestParseStatus(session, "if"), /timed out/);
  t.mock.timers.tick(151);
  await rejected;
  assert.equal(state.pendingParseRequests.size, 0);

  parser.setNativeParseCallback(code => backend.requestParseStatus(session, code));
  t.after(() => parser.setNativeParseCallback(null));
  const fallback = parser.isExpressionCompleteAsync("42");
  t.mock.timers.tick(151);
  assert.equal(await fallback, true, "the existing local fallback must be reachable");

  const fresh = backend.requestParseStatus(session, "x <- (\n2)");
  backend.handleSessionControlEvent(state, { type: "parse-status-result", requestId: 1, status: 2 });
  backend.handleSessionControlEvent(state, { type: "parse-status-result", requestId: 2, status: 2 });
  assert.equal(state.pendingParseRequests.size, 1, "late results cannot settle a different request");
  backend.handleSessionControlEvent(state, { type: "parse-status-result", requestId: 3, status: 1 });
  assert.equal(await fresh, 1);
  assert.equal(state.pendingParseRequests.size, 0);
});
