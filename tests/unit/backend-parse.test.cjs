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

  const fallback = parser.isExpressionCompleteAsync("42", code => backend.requestParseStatus(session, code));
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

test("detached socket frames cannot settle a reattached session's native parse or change its state", async () => {
  const { EventEmitter } = require("node:events");
  const backend = new RustSidecarRuntimeBackend("unused");
  const session = { sessionId: "reattach" };
  const sockets = [];
  backend.resolveReconnectInfo = async () => ({ sessionId: session.sessionId });
  backend.connectSocketWithRetry = async () => {
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false, resume() {}, destroy() { this.destroyed = true; },
    });
    sockets.push(socket);
    return socket;
  };
  backend.writeFrame = () => true;
  const events = [];
  const attach = async () => {
    backend.attach(session, { onControl: event => events.push(event), onError: error => { throw error; } });
    await new Promise(resolve => setImmediate(resolve));
  };
  await attach();
  const old = sockets[0];
  backend.detach(session);
  await attach();
  const state = backend.sessionStates.get(session);
  state.hostConnected = true;
  state.capabilities.add("parse-status");
  let settled = false;
  const pending = backend.requestParseStatus(session, "if").then(result => { settled = true; return result; });
  const frame = Buffer.alloc(16);
  frame.writeUInt32LE(4, 0);
  frame.writeUInt16LE(11, 4); // ParseStatusResult
  frame.writeUInt32LE(state.nextRequestId, 8);
  frame[12] = 1;
  old.emit("data", frame);
  // Partial old frames must not corrupt the new connection's frame assembly either.
  old.emit("data", frame.subarray(0, 6));
  old.emit("close");
  old.emit("error", new Error("late socket error"));
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(state.hostConnected, true);
  assert.equal(state.socketCarry.length, 0);
  assert.deepEqual(events, []);
  frame[12] = 2;
  sockets[1].emit("data", frame);
  assert.equal(await pending, 2);
  assert.equal(events.length, 1);
  backend.detach(session);
});
