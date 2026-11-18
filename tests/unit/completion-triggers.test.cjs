const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { createTerminal } = require("../helpers/inline-terminal.cjs");
const completion = loadSource("src/Language/completion.ts", { vscode: {
  CompletionItemKind: { Text: 0, Function: 2, Field: 4, Variable: 5, Value: 11 },
  SnippetString: class {},
} });

function contextAt(marked) {
  const cursor = marked.indexOf("│");
  const text = marked.replace("│", "");
  const before = text.slice(0, cursor);
  const line = before.split("\n").length - 1;
  return completion.getCompletionContext(text.split("\n")[line], before.split("\n").at(-1).length,
    before, text.slice(cursor));
}

test("bracket contexts retain the complete object, active dimension and quoted prefix", () => {
  for (const [marked, object, prefix, dimension, dimensions] of [
    ["obj[[│]]", "obj", "", 0, 1], ["obj[[\"a b│\"]]", "obj", "a b", 0, 1],
    ["obj[['a b│']]", "obj", "a b", 0, 1], ["df[, │]", "df", "", 1, 2],
    ["df[│, ]", "df", "", 0, 2], ["obj$data[[│]]", "obj$data", "", 0, 1],
    ["obj[[1]][[│]]", "obj[[1]]", "", 0, 1], ["obj[['nested']][│]", "obj[['nested']]", "", 0, 1],
    ["outer(obj$data[[\n  │]])", "obj$data", "", 0, 1],
    ["`a b`[[│]]", "`a b`", "", 0, 1], ["变量[[│]]", "变量", "", 0, 1],
  ]) {
    const context = contextAt(marked);
    assert.equal(context.kind, "bracket", marked);
    assert.equal(context.objectName, object, marked);
    assert.equal(context.prefix, prefix, marked);
    assert.equal(context.bracketDimension, dimension, marked);
    assert.equal(context.bracketDimensions, dimensions, marked);
    assert.equal(context.autoTrigger, true, marked);
    assert.ok(context.replaceStart >= 0, marked);
  }
  for (const marked of ['"obj[[│', "# obj[[│", "obj[[stop('must not run')]][[│]]", "factory()[[│]]"]) {
    assert.notEqual(contextAt(marked)?.kind, "bracket", marked);
  }
});

test("bracket insertions distinguish ordinary indexing, data.table expressions and existing quotes", async () => {
  for (const [marked, classes, expected] of [
    ["df[│]", ["data.frame"], '"a b"'], ["df[, │]", ["data.frame"], '"a b"'],
    ["df[[│]]", ["data.frame"], '"a b"'], ["df[[\"│\"]]", ["data.frame"], "a b"],
    ["df[, │]", ["data.table", "data.frame"], "`a b`"],
    ["df[, '│']", ["data.table", "data.frame"], "a b"],
  ]) {
    const entries = await completion.collectCompletionEntries(contextAt(marked), undefined, undefined,
      { globalenv: { df: { class: classes, names: ["a b"] } } }, []);
    assert.equal(entries.find(item => item.label === "a b").insertText, expected, marked);
  }
});

test("quoted completions replace the existing value through its closing quote", async t => {
  for (const [marked, label, expected] of [
    ['stats::cor(method = "sp│ear")', "spearman", 'stats::cor(method = "spearman")'],
    ["stats::cor(method = 'sp│ear')", "spearman", "stats::cor(method = 'spearman')"],
    ['stats::cor(\n method = "sp│ear", x = 1)', "spearman", 'stats::cor(\n method = "spearman", x = 1)'],
    ['stats::cor(method = "sp│ear\nold", x = 1)', "spearman", 'stats::cor(method = "spearman", x = 1)'],
    ['stats::cor(method = "sp│ear', "spearman", 'stats::cor(method = "spearman'],
    ['obj[["al│pha"]]', "alpha", 'obj[["alpha"]]'],
    ["obj[['a│old']]", "a'b", "obj[['a\\'b']]"],
    ['obj[["a│old\\\"tail"]]', 'a"b', 'obj[["a\\"b"]]'],
    ['obj[["a│old\\\\tail"]]', 'a\\b', 'obj[["a\\\\b"]]'],
  ]) {
    const { terminal } = createTerminal(t, 80, 24, "tab");
    delete terminal.applyCompletion;
    terminal.lang.recordCompletion = () => {};
    const context = contextAt(marked);
    const text = marked.replace("│", "");
    const cursor = marked.indexOf("│");
    const entries = await completion.collectCompletionEntries(context, { getText: () => text },
      { line: text.slice(0, cursor).split("\n").length - 1, character: context.snapshotCursor },
      { globalenv: { obj: { names: [label] } } }, [], [], {
        provideCompletionItems: async () => [{ label, insertText: `"${label}"`, kind: 11, detail: "value for method" }],
      });
    const selection = completion.toCompletionPick(entries.find(entry => entry.label === label), context);
    terminal.inputState.text = text;
    terminal.inputState.cursorPosition = cursor;
    terminal.applyCompletion(selection);
    assert.equal(terminal.inputState.text, expected, marked);
    assert.equal(terminal.inputState.cursorPosition,
      text.lastIndexOf("\n", cursor - 1) + 1 + context.replaceStart + selection.insertText.length, marked);
  }
});

test("nested bracket completion queries the complete object instead of an unrelated global", async () => {
  const context = contextAt("obj$data[[│]]");
  const entries = await completion.collectCompletionEntries(context, undefined, undefined,
    { globalenv: { data: { names: ["wrong_global"] } } }, [], [], undefined, async expression => {
      assert.ok(expression.includes(".obj <- (obj$data)"));
      return [{ name: "quoted:correct" }];
    });
  assert.deepEqual(entries.filter(item => item.kind === 4).map(item => item.insertText), ['"correct"']);
  assert.ok(entries.some(item => item.insertText === "data" && item.kind === 5),
    "global variables remain available as index expressions");
});

test("named values and pipe destinations have distinct completion contexts", () => {
  for (const marked of ["fun(│)", "fun(x, │)", "outer(fun(\n│))", "subset(df, │)", "df |> filter(│)"]) {
    const context = contextAt(marked);
    assert.equal(context.autoTrigger, true, marked);
    assert.ok(context.argumentTags, marked);
  }
  for (const [marked, prefix, quote] of [
    ["fun(method = │)", "", undefined], ["fun(method = sp│)", "sp", undefined],
    ['fun(method = "sp│")', "sp", '"'], ["fun(method = 'sp│')", "sp", "'"],
    ["outer(fun(\n method = │))", "", undefined],
  ]) {
    const context = contextAt(marked);
    assert.equal(context.argumentTags, undefined, marked);
    assert.equal(context.argumentValue.name, "method", marked);
    assert.equal(context.argumentValue.quote, quote, marked);
    assert.equal(context.prefix, prefix, marked);
    assert.equal(context.autoTrigger, true, marked);
  }
  for (const marked of ["df |> │", "df %>% │", "df |> # continue\n│", "df |> su│"]) {
    assert.equal(contextAt(marked)?.pipe, true, marked);
  }
});

test("typing opens every contextual popup without a prefix and manual mode stays manual", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const text of ["obj[[", 'obj[["', "df[", "df[, ", "obj$data[[", "obj[[1]][[",
    "fun(", "fun(x, ", "fun(method = ", 'fun(method = "', "subset(df, ", "df |> filter(", "df |> ", "df %>% "]) {
    for (const [mode, trigger] of [["inline", "typing"], ["inline", "tab"], ["quickPick", "typing"]]) {
      const automatic = mode === "inline" && trigger === "typing";
      const { terminal } = createTerminal(t, 80, 24, trigger,
        { completionUI: mode, "inlineCompletion.minCharacters": 99 });
      const requests = [];
      terminal.lang.handleAutocomplete = request => {
        requests.push(request.input.textBeforeCursor);
        request.onInlineEntries?.([{ label: "candidate", insertText: "candidate", replaceStart: request.input.cursorCol,
          snapshotInput: request.input.currentLine, snapshotCursor: request.input.cursorCol, source: "session" }]);
      };
      terminal.applyKeyAction({ type: "text", text });
      t.mock.timers.tick(150);
      assert.equal(requests.length, automatic ? 1 : 0, `${mode}/${trigger}: ${text}`);
      assert.equal(terminal.inlineCompletion.visible, automatic, text);
      if (!automatic) {
        terminal.applyKeyAction({ type: "tab" });
        assert.equal(requests.length, 1, `explicit Tab: ${mode}/${text}`);
        assert.equal(terminal.inlineCompletion.visible, mode === "inline", text);
      }
      terminal.dismissInlineCompletion(false);
    }
  }
});

test("auto-paired double brackets and quotes open suggestions at the actual caret", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { terminal } = createTerminal(t);
  terminal.autoMatch = true;
  const requests = [];
  terminal.lang.handleAutocomplete = request => { requests.push(request.input); };
  terminal.inputState.insertText("obj");
  for (const text of "[[") terminal.applyKeyAction({ type: "text", text });
  t.mock.timers.tick(150);
  assert.equal(requests.at(-1).text, "obj[[]]");
  assert.equal(requests.at(-1).textBeforeCursor, "obj[[");
  terminal.applyKeyAction({ type: "text", text: '"' });
  t.mock.timers.tick(150);
  assert.equal(requests.at(-1).text, 'obj[[""]]');
  assert.equal(requests.at(-1).textBeforeCursor, 'obj[["');
});

test("contextual lists keep filtering after one and two characters below the threshold", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const text of ["df[[", 'df[["', "df[, ", "fun(", "fun(method = ", 'fun(method = "',
    "subset(df, ", "df |> subset(", "df |> ", "df %>% "]) {
    const { terminal } = createTerminal(t, 80, 24, "typing", { "inlineCompletion.minCharacters": 99 });
    const requests = [];
    terminal.lang.handleAutocomplete = request => {
      requests.push(request.input.textBeforeCursor);
      request.onInlineEntries([{ label: "alpha", insertText: "alpha", replaceStart: text.length,
        snapshotInput: request.input.currentLine, snapshotCursor: request.input.cursorCol, source: "session" }]);
    };
    terminal.applyKeyAction({ type: "text", text });
    t.mock.timers.tick(150);
    for (const character of "al") {
      terminal.applyKeyAction({ type: "text", text: character });
      t.mock.timers.tick(150);
      assert.equal(terminal.inlineCompletion.visible, true, text);
    }
    assert.deepEqual(requests, [text, text + "a", text + "al"]);
  }
});

test("moving into brackets and recalling history never opens automatic suggestions", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const text of ["df[[]]", "fun()", "stats::", "df |> "]) {
    const { terminal } = createTerminal(t);
    let requests = 0;
    terminal.lang.handleAutocomplete = () => { requests++; };
    terminal.inputState.insertText(text);
    terminal.applyKeyAction({ type: "arrow", dir: "left" });
    terminal.applyKeyAction({ type: "arrow", dir: "right" });
    terminal.rHistory = { resetIndex() {}, navigate: () => text };
    terminal.applyKeyAction({ type: "arrow", dir: "up" });
    t.mock.timers.tick(150);
    assert.equal(terminal.inputState.text, text);
    assert.equal(requests, 0, text);
    assert.equal(terminal.inlineCompletion.visible, false, text);
  }
});

test("accepting a named argument and the pipe shortcut request follow-up suggestions", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const trigger of ["typing", "tab"]) {
    const { terminal } = createTerminal(t, 80, 24, trigger);
    delete terminal.applyCompletion;
    terminal.lang.recordCompletion = () => {};
    const requests = [];
    terminal.lang.handleAutocomplete = request => { requests.push(request.input.textBeforeCursor); };
    terminal.inputState.insertText("fun()");
    terminal.inputState.cursorPosition = 4;
    terminal.applyCompletion({ insertText: "method = ", replaceStart: 4 });
    t.mock.timers.tick(150);
    assert.deepEqual(requests, trigger === "typing" ? ["fun(method = "] : []);
    terminal.dismissInlineCompletion(false);
    terminal.inputState.text = "df";
    terminal.inputState.cursorPosition = 2;
    terminal.pipeOperator = "|>";
    terminal.insertPipeOperator();
    t.mock.timers.tick(150);
    assert.equal(requests.at(-1), trigger === "typing" ? "df |> " : undefined);
  }
});

test("comments, unrelated literals and grouping syntax do not trigger empty-prefix popups", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const text of ['"obj[[', "# obj[[", 'fun("abc', "fun(# abc", "fun(x = # abc", 'r"(abc',
    "(", "if (", "x <- ", "fun(x + ", "fun(x = 1 + "]) {
    const { terminal } = createTerminal(t);
    let requests = 0;
    terminal.lang.handleAutocomplete = () => { requests++; };
    terminal.applyKeyAction({ type: "text", text });
    t.mock.timers.tick(150);
    assert.equal(requests, 0, text);
  }
});

test("Escape cancels contextual lookups before and after their request starts", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const text of ["df[[", "fun(", "fun(x, ", "fun(method = ", "df |> "]) {
    for (const started of [false, true]) {
      const { terminal } = createTerminal(t);
      let publish;
      terminal.lang.handleAutocomplete = request => { publish = request.onInlineEntries; };
      terminal.applyKeyAction({ type: "text", text });
      if (started) t.mock.timers.tick(150);
      terminal.applyKeyAction({ type: "escape" });
      t.mock.timers.tick(150);
      if (started) publish([{ label: "late", insertText: "late", replaceStart: text.length,
        snapshotInput: text, snapshotCursor: text.length, source: "session" }]);
      else assert.equal(publish, undefined, text);
      assert.equal(terminal.inlineCompletion.visible, false, text);
    }
  }
});

test("pipe completion excludes variables and gives runtime functions callable insertions", async () => {
  const context = contextAt("df |> │");
  const entries = await completion.collectCompletionEntries(context, { getText: () => "df |> " },
    { line: 0, character: 6 }, { globalenv: { local_fn: { type: "closure" }, value: { type: "double" } } },
    [], [], { provideCompletionItems: async () => [
      { label: "sum", insertText: "sum()", kind: 2 }, { label: "wrong_variable", kind: 5 },
    ] });
  assert.deepEqual(entries.map(item => item.insertText), ["sum()", "local_fn()"]);
});
