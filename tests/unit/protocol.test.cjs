const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const protocol = loadSource("src/Runtime/backendProtocol.ts");

function frame(kind, payload, id = 0) {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(payload.length);
  header.writeUInt16LE(kind, 4);
  header.writeUInt32LE(id, 8);
  return Buffer.concat([header, payload]);
}

test("backend frames survive every socket split boundary", () => {
  const bytes = Buffer.concat([
    frame(8, Buffer.from([0, ...Buffer.from("日本語\n")])),
    frame(8, Buffer.from([1, ...Buffer.from("error\n")])),
    frame(4, Buffer.from([0])),
    frame(11, Buffer.from([2, 0, 0, 0]), 42),
    frame(20, Buffer.from([123, 0, 0, 0, 1, 0])),
  ]);
  const expected = protocol.parseBackendFrames(bytes);
  assert.deepEqual(expected.events, [
    { type: "prompt", kind: "main" },
    { type: "parse-status-result", requestId: 42, status: 2 },
    { type: "session-state", pid: 123, busy: true, wait: { kind: "none" } },
  ]);
  assert.equal(expected.output[0].data.toString(), "日本語\n");
  assert.equal(expected.output[1].stream, "stderr");
  for (let split = 0; split <= bytes.length; split++) {
    const first = protocol.parseBackendFrames(bytes.subarray(0, split));
    const second = protocol.parseBackendFrames(bytes.subarray(split), first.carry);
    assert.equal(first.error ?? second.error, undefined);
    assert.equal(second.carry.length, 0);
    assert.deepEqual([...first.events, ...second.events], expected.events);
    assert.deepEqual([...first.output, ...second.output], expected.output);
  }
});

test("invalid frames report errors; incomplete frames remain buffered", () => {
  assert.match(protocol.parseBackendFrames(frame(65535, Buffer.alloc(0))).error, /Unknown/);
  assert.match(protocol.parseBackendFrames(frame(4, Buffer.alloc(0))).error, /Invalid/);
  assert.match(protocol.parseBackendFrames(frame(16, Buffer.from([2]))).error, /truncated/);
  const partial = frame(8, Buffer.from("output")).subarray(0, 14);
  assert.deepEqual(protocol.parseBackendFrames(partial).carry, partial);
});

test("commands use the Rust wire format and UTF-8 byte lengths", () => {
  assert.deepEqual(protocol.encodeSubmitFrame("日本語"), frame(12, Buffer.from("日本語")));
  assert.deepEqual(protocol.encodeReplyInputFrame("yes"), frame(13, Buffer.from("yes")));
  assert.deepEqual(protocol.encodeParseStatusRequestFrame(42, "x["), frame(10, Buffer.from("x["), 42));
  assert.deepEqual(protocol.encodeSetWidthFrame(80), frame(15, Buffer.from([80, 0, 0, 0])));
  assert.deepEqual(protocol.encodeInterruptFrame(), frame(14, Buffer.alloc(0)));
  assert.deepEqual(protocol.encodeShutdownFrame(), frame(17, Buffer.alloc(0)));
  assert.deepEqual(protocol.encodeDialogResultFrame({ kind: "choose-file" }), frame(18, Buffer.from([0, 0])));
});
