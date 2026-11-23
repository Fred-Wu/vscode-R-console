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
    ['obj[["\\U{1F642}"]]', "🙂"],
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

test("stored argument snapshots validate bounded names and preserve zero-argument functions", () => {
  const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
  const encode = names => Buffer.concat([Buffer.from([11]), u32(names.length), ...names.flatMap(name => {
    const bytes = Buffer.from(name); return [u32(bytes.length), bytes];
  })]);
  const parse = payload => {
    const header = Buffer.alloc(12);
    header.writeUInt32LE(payload.length); header.writeUInt16LE(26, 4);
    return parseBackendFrames(Buffer.concat([header, payload]));
  };
  for (const names of [[], ['cols'], ['first', '...', 'after dots', '中文'], ['a'.repeat(128)]]) {
    assert.deepEqual(parse(encode(names)).events[0].result, { status: 'arguments', names });
  }
  for (const payload of [encode(['']), encode(['x', 'x']), encode(['x\0y']), encode(['x'.repeat(4097)]),
    encode(Array.from({ length: 129 }, (_, i) => 'arg' + i)), encode([Buffer.from([255])]),
    Buffer.concat([encode(['cols']), Buffer.from([0])]), encode(['cols']).subarray(0, 6)]) {
    assert.ok(parse(payload).error, 'malformed signatures must not produce suggestions');
  }
  const query = parseRuntimeMemberQuery('task$levels', 'arguments');
  assert.equal(encodeMemberNamesRequestFrame(1, query)[12], 5);
});

test("stored argument requests require the negotiated capability on persistent backends", async () => {
  const { RustSidecarRuntimeBackend } = loadSource('src/Runtime/runtimeBackend.ts');
  const backend = new RustSidecarRuntimeBackend('unused');
  const session = { sessionId: 'method-arguments' };
  const state = { hostConnected: true, capabilities: new Set(['member-inspection']),
    pendingMemberRequests: new Map(), nextRequestId: 0 };
  backend.sessionStates.set(session, state);
  const frames = [];
  backend.writeFrame = (_, frame) => { frames.push(frame); return true; };
  const query = parseRuntimeMemberQuery('task$levels', 'arguments');
  assert.equal(backend.inspectMemberNames(session, query), undefined);
  assert.equal(frames.length, 0);
  state.capabilities.add('function-arguments');
  const pending = backend.inspectMemberNames(session, query);
  backend.handleSessionControlEvent(state, { type: 'member-names-result', requestId: 1,
    result: { status: 'arguments', names: ['cols'] } });
  assert.deepEqual(await pending, { status: 'arguments', names: ['cols'] });
});

test("search-path outcomes are negotiated and older absence results remain unknown", async () => {
  const { RustSidecarRuntimeBackend } = loadSource('src/Runtime/runtimeBackend.ts');
  const backend = new RustSidecarRuntimeBackend('unused');
  const session = { sessionId: 'search-path' };
  const state = { hostConnected: true, capabilities: new Set(['member-inspection', 'function-source']),
    pendingMemberRequests: new Map(), nextRequestId: 0 };
  backend.sessionStates.set(session, state);
  const frames = [];
  backend.writeFrame = (_, frame) => { frames.push(frame); return true; };
  for (const status of ['missing', 'not-callable']) {
    const request = backend.inspectMemberNames(session, { root: 'factory', steps: [], target: 'source' });
    assert.equal(frames.at(-1)[12], 4);
    backend.handleSessionControlEvent(state, { type: 'member-names-result', requestId: state.nextRequestId,
      result: { status } });
    assert.deepEqual(await request, { status: 'unavailable' }, 'older backends checked only .GlobalEnv');
  }
  state.capabilities.add('member-inspection-search-path');
  for (const status of ['missing', 'package', 'opaque']) {
    const request = backend.inspectMemberNames(session, { root: 'factory', steps: [], target: 'source' });
    assert.equal(frames.at(-1)[12], 0x44);
    backend.handleSessionControlEvent(state, { type: 'member-names-result', requestId: state.nextRequestId,
      result: { status } });
    assert.deepEqual(await request, { status });
  }
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
  assert.deepEqual(parseBackendFrames(frame(Buffer.from([9]))).events, [{
    type: "member-names-result", requestId: 42, result: { status: "missing" },
  }], "code 9 is a proven absent root, not a stored object with no members");
  assert.match(parseBackendFrames(frame(Buffer.from([9, 0]))).error,
    /invalid member inspection status/);
  assert.deepEqual(parseBackendFrames(frame(Buffer.from([12]))).events[0].result,
    { status: "not-callable" });
  assert.match(parseBackendFrames(frame(Buffer.from([12, 0]))).error,
    /invalid member inspection status/);
  for (const [code, status] of [[13, 'package'], [14, 'opaque']]) {
    assert.deepEqual(parseBackendFrames(frame(Buffer.from([code]))).events[0].result, { status });
    assert.match(parseBackendFrames(frame(Buffer.from([code, 0]))).error, /invalid member inspection status/);
  }
  assert.match(parseBackendFrames(frame(Buffer.from([15]))).error,
    /invalid member inspection result/);
  assert.match(parseBackendFrames(frame(Buffer.from([10]))).error,
    /invalid function source length/);
  const source = "function() list(alpha = 1)";
  assert.deepEqual(parseBackendFrames(frame(Buffer.concat([
    Buffer.from([10]), Buffer.from(source, "utf8")
  ]))).events, [{ type: "member-names-result", requestId: 42,
    result: { status: "source", text: source } }]);
  for (const bytes of [Buffer.from([10, 0]), Buffer.from([10, 0xff]),
    Buffer.concat([Buffer.from([10]), Buffer.alloc(64 * 1024 + 1, 97)])]) {
    assert.ok(parseBackendFrames(frame(bytes)).error, "invalid function text must be rejected");
  }
  const sourceQuery = encodeMemberNamesRequestFrame(43,
    { root: "make_data", steps: [], target: "source" });
  assert.equal(sourceQuery.subarray(12)[0], 4);
  assert.throws(() => encodeMemberNamesRequestFrame(44, {
    root: "make_data", steps: [{ kind: "field", name: "x" }], target: "source",
  }), /invalid member inspection request/);
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
  for (const [kind, bracketKind] of [[7, "data.frame"], [8, "data.table"]]) {
    const decorated = Buffer.from(typed);
    decorated[0] = kind;
    assert.deepEqual(parseBackendFrames(frame(decorated)).events, [{
      type: "member-names-result", requestId: 42,
      result: { status: "available", names: ["method", "value"], kinds: [1, 0], bracketKind },
    }]);
  }
  const labels = ["active-binding", "deferred-binding", "unsafe-dispatch",
    "unsafe-altrep", "unsafe-environment"];
  for (let byte = 2; byte <= 6; byte++) {
    assert.deepEqual(parseBackendFrames(frame(Buffer.from([byte]))).events, [{
      type: "member-names-result", requestId: 42,
      result: { status: "suppressed", reason: labels[byte - 2] },
    }]);
  }
});


test("emitted UTF-8 byte escapes round-trip without aliasing malformed names", () => {
  const { backtickRName, quoteCompletionValue } = loadSource("src/Language/completion/candidates.ts", { vscode: {} });
  for (const name of ["line\u2028name", "para\u2029name", "bidi\u202ename", "c1\u0085name", "\ufeff", "🙂", "`\\'\"\n"]) {
    for (const [spelling, steps] of [
      [backtickRName(name), []],
      ["obj$" + backtickRName(name), [{ kind: "field", name }]],
      ["obj[[" + quoteCompletionValue(name) + "]]", [{ kind: "named-index", name }]],
    ]) {
      const query = parseRuntimeMemberQuery(spelling);
      assert.ok(query, spelling);
      assert.equal(query.root, steps.length ? "obj" : name);
      assert.deepEqual(query.steps, steps);
      assert.equal(query.utf8ByteEscapes === true, /\\x(?:[89a-f])/i.test(spelling));
    }
  }
  const query = parseRuntimeMemberQuery('obj[["\\342\\x80\\250"]]');
  assert.deepEqual(query, {root: "obj", steps: [{kind: "named-index", name: "\u2028"}],
    target: "$", utf8ByteEscapes: true});
  assert.equal(encodeMemberNamesRequestFrame(1, query)[12], 0x80);
  for (const receiver of [
    'obj[["\\xc0\\xaf"]]', 'obj[["\\xe2\\x80"]]', 'obj[["\\xed\\xa0\\x80"]]',
    'obj[["\\xf4\\x90\\x80\\x80"]]', 'obj[["\\777"]]', 'obj[["\\x61\\u0062"]]',
    'obj$`\\u0061`', 'obj[["\\u{1F642}"]]', 'obj[["\ud800"]]',
  ]) assert.equal(parseRuntimeMemberQuery(receiver), undefined, receiver);
});

test("UTF-8 escape requests never reach an older persistent backend", async () => {
  const { RustSidecarRuntimeBackend } = loadSource("src/Runtime/runtimeBackend.ts");
  const backend = new RustSidecarRuntimeBackend("unused");
  const session = {sessionId: "escaped-names"};
  const state = {hostConnected: true, capabilities: new Set(["member-inspection"]),
    pendingMemberRequests: new Map(), nextRequestId: 0};
  backend.sessionStates.set(session, state);
  const frames = [];
  backend.writeFrame = (_, frame) => { frames.push(frame); return true; };
  const query = parseRuntimeMemberQuery('obj[["\\xe2\\x80\\xa8"]]');
  assert.equal(backend.inspectMemberNames(session, query), undefined);
  assert.equal(frames.length, 0);
  state.capabilities.add("member-inspection-utf8-escapes");
  const pending = backend.inspectMemberNames(session, query);
  assert.equal(frames[0][12], 0x80);
  backend.handleSessionControlEvent(state, {type: "member-names-result", requestId: 1,
    result: {status: "available", names: ["child"]}});
  assert.deepEqual(await pending, {status: "available", names: ["child"]});
});


test("escaped root metadata cannot bypass the native locale check", async () => {
  const completion = loadSource("src/Language/completion.ts", { vscode: {
    CompletionItemKind: {Field:4, Function:2, Property:9}, SnippetString: class {},
  } });
  const input = '`line\\xe2\\x80\\xa8name`$';
  const context = completion.getCompletionContext(input, input.length);
  const workspace = {globalenv: {['line\u2028name']: {names:["wrong_locale"]}}};
  const entries = await completion.collectCompletionEntries(context, undefined, undefined,
    workspace, [], [], undefined, async () => ({status:"unavailable"}));
  assert.equal(entries.length, 0);
  assert.equal(entries.isIncomplete, true);
});
