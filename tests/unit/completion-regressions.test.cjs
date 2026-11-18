const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const parser = loadSource("src/Language/parser.ts");
const completion = loadSource("src/Language/completion.ts", { vscode: {
  CompletionItemKind: { Text: 0, Function: 2, Field: 4, Variable: 5, Value: 11 },
  Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
  SnippetString: class {},
} });
const { createTerminal } = require("../helpers/inline-terminal.cjs");
const contextAt = marked => {
  const cursor = marked.indexOf("│"), text = marked.replace("│", "");
  return completion.getCompletionContext(text, cursor);
};

test("quoted argument values do not request irrelevant runtime columns", async () => {
  const text = 'df |> choose(method = "a")';
  const context = contextAt('df |> choose(method = "a│")');
  assert.equal(context.dataObjectName, 'df');
  let columnRequests = 0;
  const entries = await completion.collectCompletionEntries(context, { getText: () => text },
    { line: 0, character: context.snapshotCursor }, undefined, [], [], {
      provideCompletionItems: async () => [{ label: 'auto', kind: 11, detail: 'value for method' }],
    }, async () => { columnRequests++; return []; });
  assert.equal(columnRequests, 0);
  assert.deepEqual(entries.map(entry => entry.insertText), ['auto']);
});

test("large inputs retain the active data context after many completed calls", () => {
  const history = 'with(old_data, value)\n'.repeat(5000);
  for (const [line, expected] of [['lib', undefined], ['with(current_data, va', 'current_data'],
    ['with(outer_data, with(inner_data, value), va', 'outer_data']]) {
    const context = completion.getCompletionContext(line, line.length, history + line);
    assert.equal(context.dataObjectName, expected);
  }
});

test("data completion follows active lexical scopes and the current pipe", () => {
  for (const [marked, expected] of [
    ['with(old_df, x)\nnew_fun(│)', undefined],
    ['with(old_df, x); new_fun(│)', undefined],
    ['old_df |> identity()\nnew_df |> subset(│)', 'new_df'],
    ['old_df %>% identity(); new_df %>% subset(│)', 'new_df'],
    ['new_df |> subset(x) |> transform(│)', 'new_df'],
    ['with(outer_df, subset(inner_df, │))', 'inner_df'],
    ['subset(outer_df, with(inner_df, │))', 'inner_df'],
    ['with(df, text = ")", │)', 'df'],
    ['with(df, # )\n│)', 'df'],
    ['"with(old_df, "; fun(│)', undefined],
    ['# old_df |>\nnew_df |> subset(│)', 'new_df'],
    ['fun(old_df |> identity(), new_df |> subset(│))', 'new_df'],
    ['fun(old_df |> identity(), new_fun(│))', undefined],
    ['old_df |> identity(); new_df |> _[│]', 'new_df'],
    ['old_df %>% identity(); new_df %>% .[│]', 'new_df'],
    ['with(df, { first <- 1; nested(│) })', 'df'],
    ['with(df, { "not ) a delimiter"; nested(│) })', 'df'],
    ['with(df, x)\n(│)', undefined],
    ['with(df, x)\n{ nested(│) }', undefined],
    ['with\n(df, │)', undefined],
    ['base::with(df, │)', 'df'],
    ['with(`a b`, │)', '`a b`'],
    ['obj$data |> subset(│)', 'obj$data'],
    ['obj$data[x + │]', 'obj$data'],
    ['df[rows, ] |> subset(│)', 'df'],
    ['with(outer_df, factory() |> subset(│))', undefined],
    ['outer_df |> fun(factory() |> subset(│))', undefined],
    ['with(outer_df, factory()[x + │])', undefined],
    ['old_df |> subset(new_df, │)', 'old_df'],
    ['old_df %>% subset(., │)', 'old_df'],
    ['old_df |> base::subset(new_df, │)', 'old_df'],
    ['old_df |> fun(subset(new_df, │))', 'new_df'],
    ['old_df |> subset(new_df |> subset(│))', 'new_df'],
  ]) {
    const text = marked.replace('│', ''), before = marked.split('│')[0];
    const lines = text.split('\n'), row = before.split('\n').length - 1;
    const context = completion.getCompletionContext(lines[row], before.split('\n').at(-1).length,
      before, text.slice(before.length));
    assert.equal(context?.dataObjectName, expected, marked);
  }
});

test("subscript options do not change the indexing dimensions", () => {
  for (const marked of ["df[│, drop = FALSE]", "df[drop = FALSE, │]",
    'df[│, "drop" = FALSE]', "df[[│, exact = TRUE]]", "df[[exact = TRUE, │]]"]) {
    const context = contextAt(marked);
    assert.equal(context.kind, "bracket", marked);
    assert.equal(context.bracketDimension, 0, marked);
    assert.equal(context.bracketDimensions, 1, marked);
  }
  assert.equal(contextAt("df[, │, drop = FALSE]").bracketDimensions, 2);
  assert.equal(contextAt("df[exact = 1, │]").bracketDimensions, 2, "index names are positional except supported options");
  assert.notEqual(contextAt("df[, drop = F│]")?.kind, "bracket");
});

test("accepting inside an identifier replaces its suffix and preserves existing calls", t => {
  for (const [marked, inserted, kind, expected, caret] of [
    ["lib│rary(123)", "library()", 2, "library(123)", 8],
    ["stats::l│m(123)", "lm()", 2, "stats::lm(123)", 10],
    ["obj$l│m(123)", "lm()", 2, "obj$lm(123)", 7],
    ["x |> lib│rary(123)", "library()", 2, "x |> library(123)", 13],
    ["df[[al│pha]]", '"alpha"', 4, 'df[["alpha"]]', 11],
    ["f(method = al│pha)", '"alpha"', 11, 'f(method = "alpha")', 18],
    ["f(met│hod)", "method = ", 5, "f(method = )", 11],
    ["x <- al│pha + 1", "alpha", 5, "x <- alpha + 1", 10],
  ]) {
    const context = contextAt(marked), text = marked.replace("│", "");
    assert.ok(context.replaceEnd > context.snapshotCursor, marked);
    if (marked.startsWith("f(met│")) assert.deepEqual(context.argumentTags, [null]);
    if (marked.startsWith("f(method")) assert.equal(context.argumentValue.prefix, "al");
    const { terminal } = createTerminal(t);
    delete terminal.applyCompletion;
    terminal.lang.recordCompletion = () => {};
    terminal.inputState.text = text;
    terminal.inputState.cursorPosition = marked.indexOf("│");
    terminal.applyCompletion(completion.toCompletionPick({ label: inserted, insertText: inserted, kind, source: "lsp" }, context));
    assert.equal(terminal.inputState.text, expected, marked);
    assert.equal(terminal.inputState.cursorPosition, caret, marked);
  }
});

test("literal callable names survive language-server snippet expansion", async () => {
  for (const name of ["foo$1", "foo${2:text}", "foo bar", "a`b", "foo\\bar"]) {
    const input = "foo", context = completion.getCompletionContext(input, input.length);
    context.prefix = "";
    const entries = await completion.collectCompletionEntries(context, { getText: () => input },
      { line: 0, character: input.length }, undefined, [], [], {
        provideCompletionItems: async () => [{ label: name, kind: 2, insertText: `${name}($0)` }],
      });
    assert.equal(entries[0].insertText, '`' + name.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + '`()');
  }
});

test("R completion identities preserve case and session variables use valid R names", async () => {
  const input = "a", context = completion.getCompletionContext(input, input.length);
  const entries = await completion.collectCompletionEntries(context, undefined, undefined,
    { globalenv: { alpha: {}, Alpha: {}, "a b": {}, "a$1": {} } }, []);
  assert.deepEqual(entries.map(entry => entry.insertText), ["alpha", "Alpha", "`a b`", "`a$1`"]);
  const member = completion.getCompletionContext("obj$", 4);
  const fields = await completion.collectCompletionEntries(member, undefined, undefined,
    { globalenv: { obj: { names: ["alpha", "Alpha"] } } }, []);
  assert.deepEqual(fields.map(entry => entry.insertText), ["alpha", "Alpha"]);
  assert.equal(completion.rankCompletionEntries(entries, "alpha")[0].label, "alpha");
  assert.equal(completion.rankCompletionEntries(entries, "Alpha")[0].label, "Alpha");
});

test("trusted symbols suppress duplicate recent-input suggestions without folding case", async () => {
  const input = "df[[alpha]]", cursor = input.indexOf("alpha") + 2;
  const context = completion.getCompletionContext(input, cursor);
  const entries = await completion.collectCompletionEntries(context, undefined, undefined,
    { globalenv: { df: { names: ["alpha"] } } }, [], ["Alpha <- 1"], undefined, undefined, input);
  assert.deepEqual(entries.map(entry => entry.insertText), ['"alpha"', 'Alpha']);
});

test("plain completion text is never expanded as snippet syntax", async () => {
  const input = "pkg::", context = completion.getCompletionContext(input, input.length);
  const texts = ['`foo$1`', '`foo${2:text}`'];
  const entries = await completion.collectCompletionEntries(context, { getText: () => input },
    { line: 0, character: input.length }, undefined, [], [], {
      provideCompletionItems: async () => texts.map(text => ({ label: text, insertText: text, kind: 5 })),
    });
  assert.deepEqual(entries.map(entry => entry.insertText), texts);
});

test("the terminal keeps the parsed quoted and Unicode query through redraws", t => {
  for (const [text, query] of [['f(method = "a b', "a b"], ['obj$变量', "变量"], ['df[["a\\tb', "a\tb"]]) {
    const { terminal } = createTerminal(t);
    terminal.inputState.text = text;
    terminal.inputState.cursorPosition = text.length;
    terminal.lang.handleAutocomplete = ({ onInlineEntries }) => onInlineEntries([
      completion.toCompletionPick({ label: query, insertText: query, source: "session" }, contextAt(text + "│")),
    ]);
    terminal.requestInlineCompletion(true);
    assert.equal(terminal.inlineCompletion.query, query, text);
    terminal.renderInput();
    assert.equal(terminal.inlineCompletion.query, query, text);
  }
});

test("nested subscripts can share closing-bracket tokens with the active subscript", () => {
  for (const tail of ["cols[1]", "cols[[1]]", "cols[rows[1]]", "cols[[rows[[1]]]]"]) {
    const context = contextAt(`df[│, ${tail}]`);
    assert.equal(context.kind, "bracket", tail);
    assert.equal(context.bracketDimension, 0, tail);
    assert.equal(context.bracketDimensions, 2, tail);
    assert.equal(context.autoTrigger, true, tail);
  }
});

test("quoted values ending in parentheses keep the caret after the entire value", async t => {
  for (const marked of ['df[["lit│old"]]', 'f(method = "lit│old")']) {
    const context = contextAt(marked), text = marked.replace("│", "");
    const entries = await completion.collectCompletionEntries(context, { getText: () => text },
      { line: 0, character: context.snapshotCursor }, { globalenv: { df: { names: ["literal()"] } } }, [], [], {
        provideCompletionItems: async () => [{ label: "literal()", kind: 11, detail: "value for method" }],
      });
    const choice = completion.toCompletionPick(entries.find(item => item.label === "literal()"), context);
    assert.equal(choice.isCallable, false);
    const { terminal } = createTerminal(t, 80, 24, "typing");
    delete terminal.applyCompletion;
    terminal.lang.recordCompletion = () => {};
    terminal.inputState.text = text;
    terminal.inputState.cursorPosition = marked.indexOf("│");
    terminal.applyCompletion(choice);
    assert.equal(terminal.inputState.text, text.replace("litold", "literal()"));
    assert.ok(terminal.inputState.textBeforeCursor.endsWith('"literal()'));
    assert.equal(terminal.inlineCompletionTimer, undefined, "a literal must not open function arguments");
  }
});

test("source function completion retains only functions attributed to this console document", async () => {
  const text = "1 %>% fun", uri = "r-console://review/console.R";
  const context = completion.getCompletionContext(text, text.length);
  const entries = await completion.collectCompletionEntries(context, { getText: () => text, uri: { toString: () => uri } },
    { line: 0, character: text.length }, undefined, [], [], {
      provideCompletionItems: async () => [
        { label: "fun_local", kind: 2, insertText: "fun_local()", detail: "[workspace]",
          data: { package: "_workspace_", context_uri: uri } },
        { label: "fun_other", kind: 2, insertText: "fun_other()", detail: "[workspace]",
          data: { package: "_workspace_", context_uri: "file:///other.R" } },
      ],
    });
  assert.deepEqual(entries.map(item => item.insertText), ["fun_local()"]);
});

test("completion lexical snapshots remain correct after arbitrary edits and cursor moves", () => {
  let seed = 42;
  const random = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
  const fragments = ["foo", "$", "::", "[[", "]]", "\n", "# c", '"x"', "`a b`", "(", ")", " = ", ",", "|>", " ", "😀"];
  let code = "  f <- function(x) NULL\nf(";
  for (let edit = 0; edit < 160; edit++) {
    const at = random(code.length + 1);
    code = code.slice(0, at) + fragments[random(fragments.length)] + code.slice(Math.min(code.length, at + random(4)));
    for (const cursor of [code.length, random(code.length + 1)]) {
      const shared = parser.getCompletionSyntax(code, cursor), before = code.slice(0, cursor);
      assert.equal(shared.inLiteral, parser.isCompletionInLiteral(code, cursor));
      assert.deepEqual(shared.member, parser.getQualifiedCompletionContext(before));
      assert.deepEqual(shared.bracket, parser.getBracketCompletionContext(code, cursor));
      assert.deepEqual(shared.pipe, parser.getPipeCompletionContext(before));
      assert.deepEqual(shared.call, parser.getEnclosingCall(code, cursor));
    }
  }
});

test("incremental lexing handles token boundaries that change while typing", () => {
  for (const code of ['r"(foo)"', 'r"---(foo)---"', 'r"(say "hello)"; lib',
    'r"---(say "stats::lm()---"; fun(', "R'--[say 'df[[x]] ]--'; fun(",
    '1e+3', 'stats:::lm(', 'x[[1]]', 'df %>% f(']) {
    for (let cursor = 1; cursor <= code.length; cursor++) {
      const input = code.slice(0, cursor), shared = parser.getCompletionSyntax(input);
      assert.equal(shared.inLiteral, parser.isCompletionInLiteral(input), input);
      assert.deepEqual(shared.call, parser.getEnclosingCall(input), input);
      assert.deepEqual(shared.member, parser.getQualifiedCompletionContext(input), input);
      assert.deepEqual(shared.bracket, parser.getBracketCompletionContext(input), input);
    }
  }
});

test("raw-string edits keep automatic completion outside the literal", () => {
  const code = 'r"(say "stats::lm() and df[[x]])"; lib';
  for (let cursor = 1; cursor <= code.length; cursor++) {
    const input = code.slice(0, cursor);
    const context = completion.getCompletionContext(input, cursor);
    if (parser.isCompletionInLiteral(input) && context) {
      assert.equal(context.suppressAutomatic, true, input);
      assert.notEqual(context.kind, "package", input);
      assert.notEqual(context.kind, "bracket", input);
    }
  }
  assert.equal(completion.getCompletionContext(code, code.length).suppressAutomatic, false);
  // Inserting/removing the delimiter changes the interpretation of earlier tokens.
  for (const input of ['r"text"; lib', 'r"(text"; lib', 'r"(text)"; lib', 'r"text"; lib']) {
    assert.equal(parser.getCompletionSyntax(input).inLiteral, parser.isCompletionInLiteral(input), input);
  }
});

test("native pipe parse repairs finish only the destination without duplicating calls", () => {
  for (const marked of ["1 |> na│me", "1 |> name│", "{ 1 |> name│ }", "1 |> │"]) {
    const text = marked.replace("│", ""), cursor = marked.indexOf("│");
    const repair = parser.getCompletionParseInsertion(text, cursor);
    const repaired = text.slice(0, repair.offset) + repair.text + text.slice(repair.offset);
    assert.ok(repaired.includes(marked.endsWith("|> │") ? "identity()" : "name()"));
  }
  for (const marked of ["1 %>% name│", "1 |> name│()", "1 |> name│ (x)", '"1 |> name│"']) {
    assert.equal(parser.getCompletionParseInsertion(marked.replace("│", ""), marked.indexOf("│")), undefined, marked);
  }
});
