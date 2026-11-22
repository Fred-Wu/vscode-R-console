const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { parseRuntimeMemberQuery } = loadSource("src/Language/completion/runtimeMembers.ts");
const { encodeMemberNamesRequestFrame, parseBackendFrames } = loadSource("src/Runtime/backendProtocol.ts");

test("structured receiver parsing supports safe literal and existing scalar indices", () => {
  assert.deepEqual(parseRuntimeMemberQuery('obj$inner[["a b"]]$leaf'), {
    root: "obj", steps: [
      { kind: "field", name: "inner" },
      { kind: "named-index", name: "a b" },
      { kind: "field", name: "leaf" },
    ], target: "$",
  });
  assert.deepEqual(parseRuntimeMemberQuery("obj[[1]]$inner", "@"), {
    root: "obj", steps: [{ kind: "index", index: 1 }, { kind: "field", name: "inner" }],
    target: "@",
  });
  assert.deepEqual(parseRuntimeMemberQuery("obj[1][[i]]", "$"), {
    root: "obj", steps: [{ kind: "slice-index", index: 1 }, { kind: "variable-index", name: "i" }],
    target: "$",
  });
  assert.deepEqual(parseRuntimeMemberQuery('obj[[name]]', "[["), {
    root: "obj", steps: [{ kind: "variable-index", name: "name" }], target: "[[",
  });
  assert.deepEqual(parseRuntimeMemberQuery("task", "$"), {
    root: "task", steps: [], target: "$",
  });
  for (const expression of [
    "make_object()", "obj[[side_effect()]]", "obj[[1+1]]", "obj$inner()",
    "(obj <- f())", "obj$inner; rm(list=ls())", "obj[[0]]",
    "obj$inner#comment", "obj[[1e3]]", "obj[[999999]]", "obj[run()]",
    "obj[c(1,2)]", "obj[[i + 1]]",
  ]) {
    assert.equal(parseRuntimeMemberQuery(expression), undefined, expression);
  }
});

test("quoted member selectors decode R escapes safely and reject invalid expressions", () => {
  const backtick = String.fromCharCode(96);
  const cases = [
    ['obj[["a\\"b"]]', 'a"b'],
    ["obj[['a\\'b']]", "a'b"],
    ['obj[["a\\\\b"]]', "a\\b"],
    ['obj[["a\\u0020b"]]', "a b"],
    ['obj[["line\\nfeed"]]', "line\nfeed"],
    ['obj[["\\u{1F642}"]]', "🙂"],
    ["obj$" + backtick + "a\\" + backtick + "b" + backtick, "a" + backtick + "b"],
  ];
  for (const [receiver, name] of cases) {
    const query = parseRuntimeMemberQuery(receiver);
    assert.ok(query, receiver);
    assert.equal(query.steps.at(-1).name, name, receiver);
  }
  for (const receiver of [
    'obj[["bad\\q"]]', 'obj[["bad\\uZZZZ"]]',
    'obj[["bad\\xFF"]]', 'obj[["bad\\0"]]',
    'obj[["bad\\uD800"]]', 'obj[["broken\\"]]',
  ]) {
    assert.equal(parseRuntimeMemberQuery(receiver), undefined, receiver);
  }
});

test("native request includes only parsed selectors and target operator", () => {
  const query = parseRuntimeMemberQuery('obj$inner[["a b"]]', "[[");
  const frame = encodeMemberNamesRequestFrame(19, query);
  assert.equal(frame.readUInt16LE(4), 25);
  assert.equal(frame.readUInt32LE(8), 19);
  assert.equal(frame.readUInt32LE(0), frame.length - 12);
  assert.equal(frame.subarray(12)[0], 3);
  assert.equal(frame.subarray(12)[1], 2);
  assert.ok(!frame.toString("utf8").includes("eval("));
});

test("native results distinguish silent empty from unavailable and unsafe access", () => {
  function frame(payload) {
    const header = Buffer.alloc(12);
    header.writeUInt32LE(payload.length, 0);
    header.writeUInt16LE(26, 4);
    header.writeUInt32LE(42, 8);
    return Buffer.concat([header, payload]);
  }
  assert.deepEqual(parseBackendFrames(frame(Buffer.from([0]))).events, [{
    type: "member-names-result", requestId: 42, result: { status: "unavailable" },
  }]);
  assert.deepEqual(parseBackendFrames(frame(Buffer.from([1, 0, 0, 0, 0]))).events, [{
    type: "member-names-result", requestId: 42, result: { status: "available", names: [] },
  }]);
  const typed = Buffer.concat([Buffer.from([1, 2, 0, 0, 0]),
    Buffer.from([6, 0, 0, 0]), Buffer.from("method"),
    Buffer.from([5, 0, 0, 0]), Buffer.from("value"), Buffer.from([1, 0])]);
  assert.deepEqual(parseBackendFrames(frame(typed)).events, [{
    type: "member-names-result", requestId: 42,
    result: { status: "available", names: ["method", "value"], kinds: [1, 0] },
  }]);
  assert.match(parseBackendFrames(frame(Buffer.concat([typed, Buffer.from([1])]))).error,
    /invalid inspected member names/);
  const oversized = Buffer.alloc(5);
  oversized[0] = 1;
  oversized.writeUInt32LE(1001, 1);
  assert.match(parseBackendFrames(frame(oversized)).error, /too many inspected members/);
  const labels = ["active-binding", "deferred-binding", "unsafe-dispatch",
    "unsafe-altrep", "unsafe-environment"];
  for (let byte = 2; byte <= 6; byte++) {
    assert.deepEqual(parseBackendFrames(frame(Buffer.from([byte]))).events, [{
      type: "member-names-result", requestId: 42,
      result: { status: "suppressed", reason: labels[byte - 2] },
    }]);
  }
});
