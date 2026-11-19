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
  const text = 'df |> subset(method = "a")';
  const context = contextAt('df |> subset(method = "a│")');
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
    ['df |> print(│)', undefined], ['df %>% mean(│)', undefined],
    ['df |> stats::filter(│)', undefined], ['df |> obj$filter(│)', undefined],
    ['stats::filter(df, │)', undefined], ['obj$filter(df, │)', undefined],
    ['dplyr::filter(df, │)', 'df'], ['df |> dplyr::filter(│)', 'df'],
    ['with(outer_df, df |> print(│))', 'outer_df'],
    ['with(outer_df, stats::filter(df, │))', 'outer_df'],
    ['with(data = df, │)', 'df'], ['subset(x = df, │)', 'df'],
    ['transform(`_data` = df, │)', 'df'], ['dplyr::filter(.data = df, │)', 'df'],
    ['with(obj$data, │)', 'obj$data'], ['with(data = obj$data, │)', 'obj$data'],
    ['with(expr = df, │)', undefined],
    ['with(factory(), │)', undefined],
    ['with(a + a, │)', undefined], ['with(data = factory(), df, │)', undefined],
    ['with(expr = ignored, data = df, │)', 'df'],
    ['with(obj $ # receiver\n data, │)', 'obj$data'],
    ['with(`a $ b`, │)', '`a $ b`'], ['with(df[rows, ], │)', 'df'],
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

test("source function completion keeps console definitions without duplicating runtime functions", async () => {
  const text = "1 %>% fun", uri = "r-console://review/console.R";
  const context = completion.getCompletionContext(text, text.length);
  const entries = await completion.collectCompletionEntries(context, { getText: () => text, uri: { toString: () => uri } },
    { line: 0, character: text.length }, { globalenv: { fun_runtime: { type: "closure" } } }, [], [], {
      provideCompletionItems: async () => [
        { label: "fun_local", kind: 2, insertText: "fun_local()", detail: "[workspace]",
          data: { package: "_workspace_", context_uri: uri } },
        { label: "fun_other", kind: 2, insertText: "fun_other()", detail: "[workspace]",
          data: { package: "_workspace_", context_uri: "file:///other.R" } },
        { label: "fun_runtime", kind: 2, insertText: "fun_runtime()", detail: "[workspace]",
          data: { package: "_workspace_", context_uri: uri } },
        { label: "fun_runtime", kind: 2, insertText: "fun_runtime()", detail: "{pkg}",
          data: { package: "pkg" } },
      ],
    });
  assert.deepEqual(entries.map(item => [item.insertText, item.detail]),
    [["fun_local()", "[workspace]"], ["fun_runtime()", "{pkg}"], ["fun_runtime()", "session"]]);
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

test("Unicode identifiers replace the whole prefix at top level", async () => {
  for (const prefix of ["α", "αfoo", "变量", "变量foo", "𐐀foo"]) {
    const text = `x <- ${prefix}`;
    const context = completion.getCompletionContext(text, text.length);
    assert.equal(context?.prefix, prefix);
    assert.equal(context.replaceStart, 5);
    const name = prefix + "bar";
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      { globalenv: { [name]: {} } }, []);
    const pick = completion.toCompletionPick(entries[0], context);
    assert.equal(text.slice(0, pick.replaceStart) + pick.insertText, `x <- \`${name}\``);
  }
});

test("native bare callable edits enter an existing call and request arguments", t => {
  for (const [marked, inserted] of [['obj$fu│n(123)', 'fun'], ['obj$fu│(123)', '`fun$1`'],
    ['outer(obj$fu│ # comment\n (123))', 'fun']]) {
    const text = marked.replace('│', ''), cursor = marked.indexOf('│');
    const context = completion.getCompletionContext(text.split('\n')[0], cursor, text.slice(0, cursor), text.slice(cursor));
    const { terminal } = createTerminal(t);
    delete terminal.applyCompletion;
    terminal.lang.recordCompletion = () => {};
    let requestedArguments = false;
    terminal.scheduleInlineCompletion = () => { requestedArguments = true; };
    terminal.inputState.text = text;
    terminal.inputState.cursorPosition = cursor;
    terminal.applyCompletion(completion.toCompletionPick({ label: inserted, insertText: inserted,
      kind: 2, source: 'lsp' }, context));
    assert.equal(terminal.inputState.text, text.slice(0, context.replaceStart) + inserted + text.slice(context.replaceEnd ?? cursor));
    assert.equal(terminal.inputState.text.slice(terminal.inputState.cursorPosition, terminal.inputState.cursorPosition + 3), '123');
    assert.equal(requestedArguments, true);
  }
});

test("subscript context excludes generic LSP symbols but preserves native fields and index variables", async () => {
  for (const [text, expected] of [
    ['lst[[ind', ['"indigo"', 'index']],
    ['lst[["ind', ['indigo']],
    ['lst[ind', ['"indigo"', 'find', 'index']],
  ]) {
    const context = completion.getCompletionContext(text, text.length);
    let requests = 0;
    const entries = await completion.collectCompletionEntries(context, { getText: () => text },
      { line: 0, character: text.length }, { globalenv: { index: { type: 'integer' } } }, [], [], {
        provideCompletionItems: async () => {
          requests++;
          return [{ label: 'indigo', kind: 4, data: { type: 'member' },
            insertText: context.bracketQuote ? 'indigo' : '"indigo"' },
          { label: 'find', kind: 2, insertText: 'find', detail: '{base}' }];
        },
      });
    assert.deepEqual(entries.map(item => item.insertText), expected, text);
    assert.equal(requests, 1, 'restricted contexts must not broaden to unrelated global symbols');
  }
});

test("native field edits preserve their quoting and escape literal carriage returns", async () => {
  const field = "total\rUSD";
  for (const [marked, supplied, expected, label = field] of [
    ['sales[["tot│"]]', field, 'total\\rUSD'],
    ['sales[["│"]]', '`total\\rUSD`', '`total\\rUSD`', '`total\rUSD`'],
    ['sales[[tot│]]', '"' + field + '"', '"total\\rUSD"'],
    ['sales$tot│', field, '`total\\rUSD`'],
    ['sales$tot│', '`total\\rUSD`', '`total\\rUSD`'],
  ]) {
    const context = contextAt(marked);
    const text = marked.replace('│', '');
    const entries = await completion.collectCompletionEntries(context, { getText: () => text },
      { line: 0, character: marked.indexOf('│') }, undefined, [], [], {
        provideCompletionItems: async () => [{ label, kind: 4, data: { type: 'member' }, insertText: supplied }],
      });
    assert.deepEqual(entries.map(entry => entry.insertText), [expected], marked);
  }
});

test("unknown or unmatched argument prefixes are not treated as exhausted signatures", async () => {
  const text = 'unknown_function(1,2, run';
  const context = completion.getCompletionContext(text, text.length);
  const session = { globalenv: { runtime_function: { type: 'closure' } } };
  const entries = await completion.collectCompletionEntries(context, { getText: () => text },
    { line: 0, character: text.length }, session, [], [], { provideCompletionItems: async () => ({ items: [] }) });
  assert.ok(entries.some(entry => entry.label === 'runtime_function'));
});

test("outer-call parameters and literal choices cannot leak into other cursor contexts", async () => {
  for (const text of ['plain', 'pkg::', 'obj$', 'outer(lst[', 'outer(lst[ind', 'outer(lst[[', 'outer(lst[["',
    'outer(x + plain', 'outer(method = x + plain']) {
    const context = completion.getCompletionContext(text, text.length);
    const entries = await completion.collectCompletionEntries(context, { getText: () => text },
      { line: 0, character: text.length }, undefined, [], [], {
        provideCompletionItems: async () => [
          { label: 'plain', kind: 5, detail: 'parameter', insertText: 'plain = ' },
          { label: 'plain', kind: 11, detail: 'value for method', insertText: '"plain"' },
        ],
      });
    assert.ok(entries.every(entry => entry.role !== 'argument' && entry.role !== 'value'), text);
  }
});


test("empty contextual tokens never enumerate ambient symbols or history", async () => {
  for (const marked of [
    'lst[[│]]', 'lst[│]', 'lst[, │]', 'lst[[1]][[│]]', 'obj$data[[│]]',
    '`a b`[[│]]', '变量[[│]]', 'fun(│)', 'fun(x, │)', 'fun(arg = │)',
    'with(lst, │)', 'with(lst, { 1 + │ })', 'lst |> subset(│)',
  ]) {
    const context = contextAt(marked), text = marked.replace('│', '');
    const globalenv = new Proxy({ lst: { type: 'list', names: ['alpha', 'lst'] } }, {
      ownKeys() { assert.fail('empty contextual tokens must not enumerate the session: ' + marked); },
    });
    const entries = await completion.collectCompletionEntries(context, { getText: () => text },
      { line: 0, character: context.snapshotCursor }, { globalenv }, [], ['history_value <- 1'], {
        provideCompletionItems: async () => [
          { label: 'unrelated_function', kind: 2 }, { label: 'unrelated_variable', kind: 5 },
          { label: 'alpha', kind: 4, data: { type: 'scope' } },
          { label: 'arg', kind: 5, detail: 'parameter', insertText: 'arg = ' },
        ],
      });
    assert.ok(entries.some(entry => entry.label === 'alpha'), marked);
    assert.ok(entries.every(entry => entry.kind === 4 || entry.role === 'argument'), marked);
    assert.equal(entries.some(entry => entry.role === 'argument'), !!context.argumentTags, marked);
  }
});

test("typed indices preserve expression variables including self references", async () => {
  for (const [marked, name, type] of [
    ['lst[[ind│]]', 'index', 'character'], ['lst[ind│]', 'index', 'integer'],
    ['x[x│]', 'x', 'double'], ['DT[D│]', 'DT', 'list'],
  ]) {
    const entries = await completion.collectCompletionEntries(contextAt(marked), undefined, undefined,
      { globalenv: { [name]: { type } } }, [], ['index_history <- 1']);
    assert.ok(entries.some(entry => entry.label === name && entry.kind === 5), marked);
    if (name === 'index') assert.ok(entries.some(entry => entry.label === 'index_history'), marked);
  }
});

test("member chains never guess fields from unrelated current or recent input", async () => {
  for (const marked of ['lst[[1]]$│', 'lst[[1]]$al│', 'obj$│', 'obj@│']) {
    const entries = await completion.collectCompletionEntries(contextAt(marked), undefined, undefined,
      undefined, [], ['alpha_unrelated <- 1'], undefined, async () => [{ name: 'alpha' }], 'alpha_unrelated');
    assert.deepEqual(entries.map(entry => entry.label), ['alpha'], marked);
  }
});

test("literal and comment contexts cannot request generic code completions", async () => {
  for (const marked of ['# │', '"│', 'r"--(│', '# glo│', '"glo│', 'r"--(glo│', 'fun(# glo│', 'fun(r"--(glo│']) {
    const context = contextAt(marked);
    assert.equal(context.suppressAutomatic, true, marked);
    const entries = await completion.collectCompletionEntries(context, { getText: () => marked },
      { line: 0, character: context.snapshotCursor }, { globalenv: { global_value: {} } }, [], ['global_history'], {
        provideCompletionItems: async () => { assert.fail('no code request inside ' + marked); },
      }, async () => { assert.fail('no runtime probe inside ' + marked); });
    assert.deepEqual(entries, [], marked);
  }
});

test("empty-to-typed refinement refreshes newly eligible sources and then reuses typed results", async () => {
  const { refineCompletionEntries } = loadSource('src/Language/completion/refinement.ts');
  const input = text => ({ text, textBeforeCursor: text, cursorRow: 0 });
  for (const text of ['lst[[', 'lst[', 'fun(', 'fun(arg = ', 'with(lst, ']) {
    const context = completion.getCompletionContext(text, text.length);
    const session = { globalenv: { index: { type: 'character' } } };
    const entries = await completion.collectCompletionEntries(context, undefined, undefined, session, []);
    assert.ok(!entries.some(entry => entry.label === 'index'), text);
    const typedText = text + 'ind', typedContext = completion.getCompletionContext(typedText, typedText.length);
    assert.equal(refineCompletionEntries({ input: input(text), context, entries }, input(typedText), typedContext), undefined);
    const typedEntries = await completion.collectCompletionEntries(typedContext, undefined, undefined, session, []);
    assert.ok(typedEntries.some(entry => entry.label === 'index'), text);
    const nextText = typedText + 'e', nextContext = completion.getCompletionContext(nextText, nextText.length);
    assert.ok(refineCompletionEntries({ input: input(typedText), context: typedContext, entries: typedEntries },
      input(nextText), nextContext).some(entry => entry.label === 'index'), text);
  }
});

test("subscript contexts keep names, values and quoted options distinct", () => {
  for (const [marked, name] of [
    ['DT[, key│]', undefined],
    ['DT[, keyby = al│]', 'keyby'],
    ['DT[, by = "al│"]', 'by'],
    ['DT[, `keyby` = al│]', '`keyby`'],
    ['obj["a\\\"b" = al│]', '"a\\\"b"'],
    ['DT[, │, by = alpha]', undefined],
    ['obj[mode = "a,b", │]', undefined],
    ['obj[..., │]', undefined],
    ['DT |> _[, │]', undefined],
  ]) {
    const context = contextAt(marked);
    assert.equal(context.kind, 'bracket', marked);
    assert.equal(context.bracketArgumentName, name, marked);
  }
});

test("named subscript values do not invent cached columns", async () => {
  for (const marked of ['DT[, mult = │]', 'DT[, mult = "│"]']) {
    const context = contextAt(marked);
    const entries = await completion.collectCompletionEntries(context, undefined, undefined,
      { globalenv: { DT: { class: ['data.table', 'data.frame'], names: ['alpha'] } } }, [], [], undefined,
      async () => assert.fail("bracket completion must not query sess"));
    assert.deepEqual(entries, [], marked);
  }
});

test("successful live member lookups supersede stale cached fields even without matches", async () => {
  const session = { globalenv: { obj: { names: ['alpha'], slots: ['alpha'] } } };
  for (const text of ['obj$', 'obj$al', 'obj@al']) {
    for (const reply of [[], [{ name: 'beta' }]]) {
      const context = completion.getCompletionContext(text, text.length);
      const entries = await completion.collectCompletionEntries(context, undefined, undefined,
        session, [], [], undefined, async () => reply);
      assert.deepEqual(entries.map(entry => entry.label), text === 'obj$' ? reply.map(item => item.name) : [], text);
    }
  }
  for (const request of [undefined, async () => undefined, async () => { throw new Error('unavailable'); }]) {
    const entries = await completion.collectCompletionEntries(completion.getCompletionContext('obj$al', 6),
      undefined, undefined, session, [], [], undefined, request);
    assert.deepEqual(entries.map(entry => entry.label), ['alpha']);
  }
});

test("subscript supplements preserve symbols and fields supplied by the R provider", async () => {
  for (const text of ['DT[.', 'DT[, keyby = .']) {
    const entries = await completion.collectCompletionEntries(completion.getCompletionContext(text, text.length),
      { getText: () => text }, { line: 0, character: text.length }, undefined, [], [], {
        provideCompletionItems: async () => ['.N', '.SD'].map(label => ({ label, kind: 4, detail: '{data.table}' })),
      }, async () => []);
    assert.deepEqual(entries.map(e => e.label), ['.N', '.SD']);
  }
});
