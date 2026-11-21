const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { parseRuntimeMemberQuery } = loadSource("src/Language/completion/runtimeMembers.ts");
const { encodeMemberNamesRequestFrame, parseBackendFrames } = loadSource("src/Runtime/backendProtocol.ts");

test("native completion accepts only literal member paths into existing bindings", () => {
  assert.deepEqual(parseRuntimeMemberQuery('obj$inner[["a b"]]$leaf'), {
    root: "obj", steps: [
      { kind: "field", name: "inner" },
      { kind: "field", name: "a b" },
      { kind: "field", name: "leaf" },
    ], slots: false,
  });
  assert.deepEqual(parseRuntimeMemberQuery("obj[[1]]$inner", true), {
    root: "obj", steps: [{ kind: "index", index: 1 }, { kind: "field", name: "inner" }],
    slots: true,
  });
  for (const expression of [
    "make_object()", "obj[[side_effect()]]", "obj[[1+1]]", "obj$inner()",
    "(obj <- f())", "obj[1]", "obj$inner; rm(list=ls())", "obj[[0]]",
    "obj$inner#comment", "obj[[1e3]]", "obj[[999999]]",
  ]) {
    assert.equal(parseRuntimeMemberQuery(expression), undefined, expression);
  }
});

test("member request wire format never includes executable R source", () => {
  const query = parseRuntimeMemberQuery('obj$inner[["a b"]]');
  const frame = encodeMemberNamesRequestFrame(19, query);
  assert.equal(frame.readUInt16LE(4), 25);
  assert.equal(frame.readUInt32LE(8), 19);
  assert.equal(frame.readUInt32LE(0), frame.length - 12);
  assert.equal(frame.subarray(12)[0], 0);
  assert.equal(frame.subarray(12)[1], 2);
  assert.ok(!frame.toString("utf8").includes("eval("));
});

test("native member results distinguish unavailable from an empty object", () => {
  function frame(payload) {
    const header = Buffer.alloc(12);
    header.writeUInt32LE(payload.length, 0);
    header.writeUInt16LE(26, 4);
    header.writeUInt32LE(42, 8);
    return Buffer.concat([header, payload]);
  }
  const unavailable = parseBackendFrames(frame(Buffer.from([0])));
  assert.deepEqual(unavailable.events, [{ type: "member-names-result", requestId: 42, result: { status: "unavailable" } }]);
  const empty = parseBackendFrames(frame(Buffer.from([1, 0, 0, 0, 0])));
  assert.deepEqual(empty.events, [{ type: "member-names-result", requestId: 42, result: { status: "available", names: [] } }]);
  const oversized = Buffer.alloc(5);
  oversized[0] = 1;
  oversized.writeUInt32LE(1001, 1);
  assert.match(parseBackendFrames(frame(oversized)).error, /too many inspected members/);
});

test("native runtime suppression reasons use fixed status bytes and never source", () => {
  const labels = ["active-binding", "deferred-binding", "unsupported-accessor", "unsupported-structure"];
  for (let byte = 2; byte <= 5; byte++) {
    const header = Buffer.alloc(12);
    header.writeUInt32LE(1, 0);
    header.writeUInt16LE(26, 4);
    header.writeUInt32LE(99, 8);
    const result = parseBackendFrames(Buffer.concat([header, Buffer.from([byte])]));
    assert.deepEqual(result.events, [{
      type: "member-names-result", requestId: 99,
      result: { status: "suppressed", reason: labels[byte - 2] },
    }]);
  }
});
