const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { parseRuntimeMemberQuery } = loadSource("src/Language/completion/runtimeMembers.ts");
const completion = loadSource("src/Language/completion.ts", { vscode: {
  CompletionItemKind: { Field: 4, Property: 9, Variable: 5, Function: 2, Text: 0 }, SnippetString: class {},
} });

test("workspace members and slots retain cached fallback when native inspection is unavailable", async () => {
  const workspace = { globalenv: { obj: {
    type: "list", class: ["tracked", "list"], names: ["inner", "field"], slots: ["slot"], length: 2,
  } } };
  for (const [input, expected] of [
    ["obj$", ["inner", "field"]],
    ["obj@", ["slot"]],
    ["obj[[", ["inner", "field"]],
  ]) {
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      workspace, [], [], undefined);
    assert.deepEqual(entries.filter(item => item.detail === "obj").map(item => item.label),
      expected, input);
  }
});

test("nested objects cannot trigger live extraction or hover", async () => {
  const workspace = { globalenv: { obj: { type: "list", names: ["inner"] } } };
  const unavailable = async () => undefined; // No safe inspector available.
  for (const input of ["obj$inner$", "obj$inner[[", 'obj[["inner"]]$', "obj[[1]][[", "obj$inner@"]) {
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      workspace, [], [], undefined, unavailable);
    assert.deepEqual(entries.filter(item => item.source === "session"), [], input);
  }
});

test("stored environment fields complete through the guarded double-bracket path", async () => {
  const text = "env[[";
  const requested = [];
  const entries = await completion.collectCompletionEntries(
    completion.getCompletionContext(text, text.length), undefined, undefined,
    undefined, [], [], undefined, async (receiver, target) => {
      requested.push([receiver, target]);
      return { status: "available", names: ["child", "a b"], kinds: [0, 0] };
    });
  assert.deepEqual(requested, [["env", "[["]]);
  assert.deepEqual(entries.map(item => [item.label, item.insertText]), [
    ["child", '"child"'], ["a b", '"a b"'],
  ]);
});

test("LSP source-inferred nested members remain available in opt-in static mode", async () => {
  const input = "obj$inner$";
  const entries = await completion.collectCompletionEntries(
    completion.getCompletionContext(input, input.length),
    { getText: () => input }, { line: 0, character: input.length },
    { globalenv: { obj: { type: "list", names: ["inner"] } } }, [], [],
    { provideCompletionItems: async () => ({
      rConsoleMemberResolved: true,
      items: [{ label: "alpha", kind: 4, data: { type: "member" } }],
    }) }, async () => assert.fail("must not request live members"));
  assert.deepEqual(entries.map(item => item.label), ["alpha"]);
});

test("truncated workspace cache remains bounded if guarded member inspection is unavailable", async () => {
  const names = Array.from({ length: 1501 }, (_, i) => "field" + String(i).padStart(4, "0"));
  const workspace = { globalenv: { df: {
    class: ["data.frame"], type: "list", length: names.length, names: names.slice(0, 1000),
  } } };
  const requested = [];
  for (const [input, label, present] of [
    ["df[[field000", "field0000", true],
    ["df[[field1500", "field1500", false],
  ]) {
    const entries = await completion.collectCompletionEntries(
      completion.getCompletionContext(input, input.length), undefined, undefined,
      workspace, [], [], undefined, async (expression, target) => {
        requested.push([expression, target]);
        return { status: "unavailable" };
      });
    assert.equal(entries.some(item => item.label === label), present, input);
  }
  assert.deepEqual(requested, [["df", "[["], ["df", "[["]]);
});

test("safe existing-session nested members override runtime-only LSP and retain quoting", async () => {
  const input = "obj$inner$";
  const workspace = { globalenv: { obj: { type: "list", names: ["inner"] } } };
  const requested = [];
  const entries = await completion.collectCompletionEntries(
    completion.getCompletionContext(input, input.length),
    { getText: () => input }, { line: 0, character: input.length },
    workspace, [], [],
    { provideCompletionItems: async () => ({ rConsoleRuntimeOnly: true,
      items: [{ label: "source_only", kind: 4, data: { type: "member" } }] }) },
    async (expression, operator) => {
      requested.push([expression, operator]);
      return { status: "available", names: ["alpha", "a b"] };
    });
  assert.deepEqual(requested, [["obj$inner", "$"]]);
  assert.deepEqual(entries.map(item => item.label), ["alpha", "a b"]);
  assert.deepEqual(entries.map(item => item.insertText), ["alpha", "`a b`"]);
  assert.ok(entries.every(item => item.source === "session"));
});

test("nested bracket fields use the same safe session result and quote names", async () => {
  const input = "obj$inner[[";
  const entries = await completion.collectCompletionEntries(
    completion.getCompletionContext(input, input.length), undefined, undefined,
    undefined, [], [], undefined, async () => ({ status: "available", names: ["a b"] }));
  assert.deepEqual(entries.filter(item => item.label === "a b").map(item => item.insertText), ['"a b"']);
});

test("nested single brackets use guarded live names with correct data-frame insertion", async () => {
  for (const [input, bracketKind, expected] of [
    ["obj$inner[", "data.frame", '"a b"'],
    ["obj$inner[, ", "data.frame", '"a b"'],
    ["obj$inner[", "data.table", '`a b`'],
    ["obj$inner[, ", "data.table", '`a b`'],
  ]) {
    const context = completion.getCompletionContext(input, input.length);
    assert.equal(context?.kind, "bracket", input);
    const called = [];
    const entries = await completion.collectCompletionEntries(
      context, undefined, undefined, undefined, [], [], undefined,
      async (expression, target) => {
        called.push([expression, target]);
        return { status: "available", names: ["a b"], bracketKind };
      });
    assert.deepEqual(called, [["obj$inner", "["]], input);
    assert.deepEqual(entries.filter(item => item.label === "a b").map(item => item.insertText),
      [expected], input);
  }
});

test("two-dimensional nested data-frame row indexing does not suggest columns", async () => {
  for (const [marked, bracketKind, shouldInclude] of [
    ["obj$inner[│, ]", "data.frame", false],
    ["obj$inner[, │]", "data.frame", true],
    ["obj$inner[│, ]", "data.table", true],
    ["obj$inner[, │]", "data.table", true],
  ]) {
    const position = marked.indexOf("│");
    const input = marked.replace("│", "");
    const context = completion.getCompletionContext(input, position, input.slice(0, position),
      input.slice(position));
    assert.equal(context?.kind, "bracket", marked);
    assert.equal(context.bracketDimensions, 2, marked);
    const entries = await completion.collectCompletionEntries(
      context, undefined, undefined, undefined, [], [], undefined,
      async () => ({ status: "available", names: ["column"], bracketKind }));
    assert.equal(entries.some(entry => entry.label === "column"), shouldInclude, marked);
  }
});

test("static source member resolution remains authoritative without a native probe", async () => {
  const input = "obj$inner$";
  const entries = await completion.collectCompletionEntries(
    completion.getCompletionContext(input, input.length),
    { getText: () => input }, { line: 0, character: input.length },
    undefined, [], [], { provideCompletionItems: async () => ({
      rConsoleMemberResolved: true,
      items: [{ label: "source", kind: 4, data: { type: "member" } }],
    }) }, async () => assert.fail("source inference must not request native inspection"));
  assert.deepEqual(entries.map(item => item.label), ["source"]);
});

test("function-call receivers do not fall back to global names on explicit Tab", async () => {
  const workspace = { globalenv: {
    make_object: { type: "closure" }, secret: { type: "double" },
  } };
  for (const input of ["make_object()$", "make_object()$sec", "make_object()@"]) {
    const context = completion.getCompletionContext(input, input.length);
    assert.equal(context?.kind, "member", input);
    assert.equal(context?.rejectionReason, "executable-receiver", input);
    const entries = await completion.collectCompletionEntries(
      context, undefined, undefined, workspace, [], [],
      { provideCompletionItems: async () => assert.fail("unsupported receiver must not query LSP") },
      async () => assert.fail("unsupported receiver must not inspect the live session"));
    assert.deepEqual(entries, [], input);
  }
  const valid = completion.getCompletionContext("obj$inner$", "obj$inner$".length);
  assert.equal(valid?.kind, "member");
  assert.equal(valid?.suppressAutomatic, undefined);
});

test("unsubmitted object declarations are not a runtime source with static analysis disabled", async () => {
  const input = ["new_obj <- list(inner = list(hidden = 1, unsubmitted = 2))", "new_obj$inner$"].join("\n");
  const lastLine = input.split("\n").at(-1);
  const context = completion.getCompletionContext(lastLine, lastLine.length, input);
  assert.equal(context?.objectName, "new_obj$inner");
  const entries = await completion.collectCompletionEntries(
    context, { getText: () => input }, { line: 1, character: lastLine.length },
    { globalenv: {} }, [], [],
    { provideCompletionItems: async () => ({
      rConsoleRuntimeOnly: true,
      items: ["hidden", "unsubmitted"].map(label => ({ label, kind: 4, data: { type: "member" } })),
    }) },
    async () => undefined, input);
  assert.equal(entries.length, 0);
  assert.equal(entries.isIncomplete, true, "unavailable live inspection may be retried");
});

test("custom class cached names are inert while active bindings have no cached members", async () => {
  const workspace = { globalenv: {
    custom_obj: { class: ["dangerous"], type: "list", names: ["inner"] },
    active_obj: { class: ["active_binding"], type: "active_binding" },
  } };
  for (const [input, expected] of [["custom_obj$", ["inner"]], ["active_obj$", []]]) {
    const context = completion.getCompletionContext(input, input.length);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      workspace, [], [], undefined);
    assert.deepEqual(entries.map(entry => entry.label), expected, input);
  }
});

test("computed receivers are rejected before LSP or native member inspection", async () => {
  const inputs = ["obj[[side_effect()]]$item", "obj[[get_index()]]$", "items[[f()]]$"];
  for (const input of inputs) {
    const context = completion.getCompletionContext(input, input.length);
    assert.equal(context?.rejectionReason, "executable-receiver", input);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      { globalenv: { obj: { type: "list", names: ["unsafe"] } } }, [], [],
      { provideCompletionItems: () => assert.fail("LSP must not receive rejected expression") },
      () => assert.fail("runtime inspector must not receive rejected expression"));
    assert.deepEqual(entries, [], input);
  }
});

test("escaped member selectors reach the native inspection without evaluating code", async () => {
  const slash = String.fromCharCode(92);
  const cases = [
    ['obj[["a' + slash + '"b"]]$', 'a"b'],
    ['obj[["a' + slash + slash + 'b"]]$', "a" + slash + "b"],
  ];
  for (const [input, name] of cases) {
    const context = completion.getCompletionContext(input, input.length);
    assert.equal(context?.kind, "member", input);
    assert.equal(context.objectName, input.slice(0, -1), input);
    assert.equal(context.rejectionReason, undefined, input);
    let calls = 0;
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      undefined, [], [], undefined, async (receiver, operator) => {
        calls++;
        const query = parseRuntimeMemberQuery(receiver, operator);
        assert.equal(query.steps.at(-1).name, name);
        return { status: "available", names: ["inner"] };
      });
    assert.equal(calls, 1, input);
    assert.deepEqual(entries.map(entry => entry.label), ["inner"], input);
  }
});

test("native member kinds distinguish callable, active, and stored bindings generally", async () => {
  for (const receiver of ["r6", "env", "object"]) {
    const input = receiver + "$";
    const entries = await completion.collectCompletionEntries(
      completion.getCompletionContext(input, input.length),
      undefined, undefined, undefined, [], [], undefined,
      async (expression, operator) => {
        assert.deepEqual([expression, operator], [receiver, "$"]);
        return {
          status: "available",
          names: ["method", "field", "active", "deferred"],
          kinds: [1, 0, 2, 3],
        };
      });
    const byName = Object.fromEntries(entries.map(item => [item.label, item]));
    assert.equal(byName.method.kind, 2);
    assert.equal(byName.method.insertText, "method()");
    assert.equal(byName.field.kind, 4);
    assert.equal(byName.field.insertText, "field");
    assert.equal(byName.active.kind, 9);
    assert.equal(byName.active.insertText, "active");
    assert.equal(byName.deferred.kind, 4);
    assert.equal(byName.deferred.insertText, "deferred");
  }
});

test("native classification overrides cached list names without evaluating methods", async () => {
  const input = "obj$";
  const workspace = { globalenv: { obj: { type: "list", names: ["method", "field"] } } };
  const entries = await completion.collectCompletionEntries(
    completion.getCompletionContext(input, input.length),
    undefined, undefined, workspace, [], [], undefined,
    async (expression, operator) => {
      assert.deepEqual([expression, operator], ["obj", "$"]);
      return { status: "available", names: ["method", "field"], kinds: [1, 0] };
    });
  assert.deepEqual(entries.map(entry => [entry.label, entry.insertText, entry.kind]), [
    ["method", "method()", 2], ["field", "field", 4],
  ]);
});

test("member kind metadata remains optional for legacy inspector results", async () => {
  const input = "obj$";
  const entries = await completion.collectCompletionEntries(
    completion.getCompletionContext(input, input.length),
    undefined, undefined, undefined, [], [], undefined,
    async () => ({ status: "available", names: ["field"] }));
  assert.deepEqual(entries.map(entry => [entry.label, entry.kind, entry.insertText]), [
    ["field", 4, "field"],
  ]);
});

test("an unavailable bounded native result keeps cached top-level names", async () => {
  const input = "obj$";
  const workspace = { globalenv: { obj: { type: "list", names: ["cached"] } } };
  const entries = await completion.collectCompletionEntries(
    completion.getCompletionContext(input, input.length),
    undefined, undefined, workspace, [], [], undefined,
    async () => ({ status: "unavailable" }));
  assert.deepEqual(entries.map(entry => entry.label), ["cached"]);
});
