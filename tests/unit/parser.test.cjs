const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const parser = loadSource("src/Language/parser.ts");

test("expression completeness handles R syntax and balanced square brackets", async () => {
  for (const code of ["", "# comment", "x[1]", "x[[1]]", "x[x[1]]", '"[not a bracket]"',
    "`a b`", 'r"(a # [ string)"', "function(x) { x + 1 }", "\\(x) x + 1", "x |> sum()"] ) {
    assert.equal(await parser.isExpressionCompleteAsync(code), true, code);
  }
  for (const code of ["x[", "x[[1]", "{ x <- 1", '"unfinished', "`unfinished",
    "function(x)", "\\(x)", "if (TRUE)", "for (x in 1:3)", "x |>", "1 +"]) {
    assert.equal(await parser.isExpressionCompleteAsync(code), false, code);
  }
});

test("comment stripping preserves strings, inline comments, and line endings", () => {
  assert.equal(parser.stripCommentLines('# remove\r\nx <- "# keep" # inline\r\n  # remove\r\nx'),
    'x <- "# keep" # inline\nx');
  assert.equal(parser.stripCommentLines('x <- "first\n# inside string\nlast"'),
    'x <- "first\n# inside string\nlast"');
});

test("native parsing distinguishes incomplete input from errors and falls back on failure", async () => {
  assert.equal(await parser.isExpressionCompleteAsync("x", async () => 2), false);
  assert.equal(await parser.isExpressionCompleteAsync("x", async () => 3), true);
  const unavailable = async () => { throw new Error("timeout"); };
  assert.equal(await parser.isExpressionCompleteAsync("x[1]", unavailable), true);
  assert.equal(await parser.isExpressionCompleteAsync("x[", unavailable), false);
});

test("call context tracks only arguments of the enclosing call on both sides of the cursor", () => {
  for (const [marked, name, supplied] of [
    ["obj$fun(|)", "obj$fun", []],
    ["obj$fun(first = inner(a = 1, b = 2), se|)", "obj$fun", ["first"]],
    ["obj$fun(inner(a = 1, b = 2), se|)", "obj$fun", [""]],
    ["obj$fun(, se|)", "obj$fun", [""]],
    ["obj$fun(`a b` = 1, 'a\\'b' = 2, se|)", "obj$fun", ["`a b`", "'a\\'b'"]],
    ["obj$fun(fi|, second = stop('never evaluate'), third = {a; b})", "obj$fun", ["second", "third"]],
    ["obj$fun(first = 1,\n se|,\n third = 3)", "obj$fun", ["first", "third"]],
    ["obj$fun(other$fn(x = 1, se|), first = 2)", "other$fn", ["x"]],
    ['obj$fun(r"---(a, b = ) # )---", se|)', "obj$fun", [""]],
    ["obj$fun(x[[1]][c(1, 2)], se|)", "obj$fun", [""]],
    ["obj$fun(x %(% y, se|)", "obj$fun", [""]],
    ["obj$fun # ignored (\n (se|)", "obj$fun", []],
  ]) {
    const cursor = marked.indexOf("|");
    const context = parser.getEnclosingCall(marked.replace("|", ""), cursor);
    assert.equal(context?.name, name, marked);
    assert.deepEqual(context.suppliedArguments, supplied, marked);
  }
});

test("call context suppresses argument names in values, literals, comments and existing arguments", () => {
  for (const marked of [
    "obj$fun(first = fir|)", "obj$fun(1 + fir|)", "obj$fun(!fir|)",
    'obj$fun("fir|st")', "obj$fun('fir|st')", 'obj$fun(r"--(fir|st)--")',
    "obj$fun(`fir|st`)", 'obj$fun("escaped\\"fir|st")',
    "obj$fun(# fir|\n)", "obj$fun(first |)", "obj$fun(|first = 1)",
    "obj$fun(fir| = 1)", "obj$fun(fir|st)", "obj$fun(..., fir|)",
  ]) {
    const cursor = marked.indexOf("|");
    const context = parser.getEnclosingCall(marked.replace("|", ""), cursor);
    assert.equal(context?.name, "obj$fun", marked);
    assert.equal(context.suppliedArguments, undefined, marked);
  }
  for (const input of ["obj[[1]]$fun(", "obj$fun()[[1]](", "x] obj$fun("]) {
    assert.equal(parser.getEnclosingCall(input), undefined, input);
  }
});

test("raw literals use matching brackets, dash delimiters and quotes", async () => {
  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    const literal = `r"---${opening}a # , = () \" ${closing}---"`;
    assert.equal(await parser.isExpressionCompleteAsync(literal), true, literal);
    assert.equal(await parser.isExpressionCompleteAsync(literal.slice(0, -1)), false, literal);
    const tokens = parser.tokenizeForHighlighting(literal + "; next_value");
    assert.equal(tokens[0].value, literal);
    assert.equal(tokens[1].value, "next_value");
  }
  assert.equal(await parser.isExpressionCompleteAsync('r"--(not closed--"'), false);
});
