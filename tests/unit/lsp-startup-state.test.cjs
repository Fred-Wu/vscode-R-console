const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { decodeStartupState, readStartupAcknowledgement, writeStartupState, MAX_STARTUP_STATE_BYTES } =
  loadSource("src/Language/lspStartupState.ts");

test("startup envelope decoding rejects malformed and oversized responses without echoing data", () => {
  for (const value of [null, {}, "", "test-secret!", "YQ", "YQ===", "YR==",
    "A".repeat(Math.ceil(MAX_STARTUP_STATE_BYTES / 3) * 4 + 4)]) {
    assert.throws(() => decodeStartupState(value), /^Error: Invalid language server startup state/);
  }
  const payload = Buffer.alloc(MAX_STARTUP_STATE_BYTES, 123);
  assert.deepEqual(decodeStartupState(payload.toString("base64")), payload);
  assert.throws(() => decodeStartupState(Buffer.alloc(MAX_STARTUP_STATE_BYTES + 1).toString("base64")));
});

test("stdio startup acknowledgement handles fragments and preserves subsequent bytes", async () => {
  const output = new PassThrough();
  const ready = readStartupAcknowledgement(output, 1000);
  output.write("RC");
  await nextTurn();
  output.write("S1following bytes");
  await ready;
  assert.equal(output.read().toString(), "following bytes");
  output.destroy();
});

test("stdio startup rejects wrong, closed and stalled acknowledgements", async () => {
  for (const mode of ["wrong", "closed", "destroyed", "stalled"]) {
    const output = new PassThrough();
    const ready = readStartupAcknowledgement(output, 25);
    if (mode === "wrong") output.write("oops");
    if (mode === "closed") output.end();
    if (mode === "destroyed") output.destroy();
    await assert.rejects(ready, /startup pipe/);
    output.destroy();
  }
});

test("private startup pipe frames opaque bytes ahead of following LSP input", async () => {
  const stdin = new PassThrough();
  const state = Buffer.from([0, 10, 13, 26, 255]);
  const errors = [];
  writeStartupState({ stdin }, state, error => errors.push(error));
  stdin.write("Content-Length: 2\r\n\r\n{}");
  await nextTurn();
  const chunks = [];
  for (let chunk; (chunk = stdin.read()) !== null;) chunks.push(chunk);
  const frame = Buffer.concat(chunks);
  assert.equal(frame.readUInt32BE(), state.length);
  assert.deepEqual(frame.subarray(4, 4 + state.length), state);
  assert.equal(frame.subarray(4 + state.length).toString(), "Content-Length: 2\r\n\r\n{}");
  stdin.emit("error", new Error("pipe closed"));
  assert.equal(errors.length, 1);
  assert.throws(() => writeStartupState({}, state, () => {}), /private input pipe/);
  assert.throws(() => writeStartupState({ stdin }, Buffer.alloc(0), () => {}), /state size/);
  stdin.destroy();
});
