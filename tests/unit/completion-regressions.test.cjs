const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const parser = loadSource("src/Language/parser.ts");
const completion = loadSource("src/Language/completion.ts", { vscode: {
  CompletionItemKind: { Text: 0, Function: 2, Field: 4, Variable: 5, Value: 11 },
  SnippetString: class {},
} });
const { createTerminal } = require("../helpers/inline-terminal.cjs");
const contextAt = marked => {
  const cursor = marked.indexOf("│"), text = marked.replace("│", "");
  return completion.getCompletionContext(text, cursor);
};

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
  for (const code of ['r"(foo)"', 'r"---(foo)---"', '1e+3', 'stats:::lm(', 'x[[1]]', 'df %>% f(']) {
    for (let cursor = 1; cursor <= code.length; cursor++) {
      const input = code.slice(0, cursor), shared = parser.getCompletionSyntax(input);
      assert.equal(shared.inLiteral, parser.isCompletionInLiteral(input), input);
      assert.deepEqual(shared.call, parser.getEnclosingCall(input), input);
      assert.deepEqual(shared.member, parser.getQualifiedCompletionContext(input), input);
      assert.deepEqual(shared.bracket, parser.getBracketCompletionContext(input), input);
    }
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
