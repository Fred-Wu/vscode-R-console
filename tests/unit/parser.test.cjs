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
  for (const [marked, name, tags] of [
    ["obj$fun(|)", "obj$fun", [null]],
    ["obj$fun(first = inner(a = 1, b = 2), se|)", "obj$fun", ["first", null]],
    ["obj$fun(inner(a = 1, b = 2), se|)", "obj$fun", ["", null]],
    ["obj$fun(, se|)", "obj$fun", ["", null]],
    ["obj$fun(`a b` = 1, 'a\\'b' = 2, se|)", "obj$fun", ["`a b`", "'a\\'b'", null]],
    ["obj$fun(fi|, second = stop('never evaluate'), third = {a; b})", "obj$fun", [null, "second", "third"]],
    ["obj$fun(first = 1,\n se|,\n third = 3)", "obj$fun", ["first", null, "third"]],
    ["obj$fun(other$fn(x = 1, se|), first = 2)", "other$fn", ["x", null]],
    ['obj$fun(r"---(a, b = ) # )---", se|)', "obj$fun", ["", null]],
    ["obj$fun(x[[1]][c(1, 2)], se|)", "obj$fun", ["", null]],
    ["obj$fun(x %(% y, se|)", "obj$fun", ["", null]],
    ["obj$fun(fi|, 2)", "obj$fun", [null, ""]],
    ["obj$fun(1, se|, 3)", "obj$fun", ["", null, ""]],
    ["obj$fun(fi|, , third = 3)", "obj$fun", [null, "", "third"]],
    ["obj$return(return = 1, ne|)", "obj$return", ["return", null]],
    ["base::toString(x = 1, wi|)", "base::toString", ["x", null]],
    ["obj$constructor(hasOwnProperty = 1, ne|)", "obj$constructor", ["hasOwnProperty", null]],
  ]) {
    const cursor = marked.indexOf("|");
    const context = parser.getEnclosingCall(marked.replace("|", ""), cursor);
    assert.equal(context?.name, name, marked);
    assert.deepEqual(context.argumentTags, tags, marked);
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
    assert.equal(context.argumentTags, undefined, marked);
  }
  for (const input of ["obj[[1]]$fun(", "obj$fun()[[1]](", "x] obj$fun("]) {
    assert.equal(parser.getEnclosingCall(input), undefined, input);
  }
});

test("call context respects statement newlines and nested continuation", () => {
  for (const input of [
    "obj$fun\n(fi)", "obj$fun # end of statement\n(fi)",
    "{ obj$fun\n(fi) }", "outer({ obj$fun\n(fi) })",
    "obj\n$fun(fi)", "obj$nested\n$fun(fi)", "stats\n::lm(fi)",
  ]) {
    assert.equal(parser.getEnclosingCall(input, input.indexOf("fi") + 2), undefined, input);
  }
  for (const [input, name] of [
    ["(obj$fun\n(fi))", "obj$fun"],
    ["outer(obj$fun # continuation\n(fi))", "obj$fun"],
    ["x[obj$fun\n(fi)]", "obj$fun"],
    ["obj$ # member continuation\nfun(fi)", "obj$fun"],
    ["(obj\n$fun(fi))", "obj$fun"],
    ["stats::\nlm(fi)", "stats::lm"],
    ["{ obj$fun\nother$fun(fi) }", "other$fun"],
    ["(obj$fun\r\n(fi))", "obj$fun"],
  ]) {
    const context = parser.getEnclosingCall(input, input.indexOf("fi") + 2);
    assert.equal(context?.name, name, input);
    assert.deepEqual(context.argumentTags, [null], input);
  }
});

test("call identities normalize token separators without changing quoted names", () => {
  for (const [input, expected] of [
    ["outer(stats::\nlm())", "stats::lm"],
    ["outer(stats\n::lm())", "stats::lm"],
    ["outer(`stats` # package\n::: # accessor\n`lm`())", "`stats`:::`lm`"],
    ["outer(obj $ `a # b` @ `c\\` d`())", "obj$`a # b`@`c\\` d`"],
  ]) {
    const call = parser.getEnclosingCall(input, input.lastIndexOf("(") + 1);
    assert.equal(call?.name, expected, input);
    assert.deepEqual(call.argumentTags, [null], input);
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

test("call openings distinguish continuations from separate statements and literals", () => {
  for (const [input, expected] of [
    ["obj$fun (1)", true], ["outer(obj$fun\n(1))", true],
    ["outer(obj$fun # comment\n(1))", true], ["x[obj$fun\r\n(1)]", true],
    ["outer(obj[[1]]$`a b` # comment\n(1))", true],
    ["obj$fun\n(1)", false], ["{ obj$fun # comment\n(1) }", false],
    ["outer({ obj$fun\n(1) })", false], ['"obj$fun (1)"', false],
    ["# obj$fun (1)", false], ['r"(obj$fun (1))"', false],
  ]) {
    const nameEnd = input.includes("`a b`") ? input.indexOf("`a b`") + 5 : input.indexOf("fun") + 3;
    const opening = parser.getCallOpenings(input).get(nameEnd);
    assert.equal(opening !== undefined, expected, input);
    if (expected) assert.equal(input[opening], "(");
  }
});

test("argument tags include pipe inputs and preserve raw-string names", () => {
  for (const [marked, tags] of [
    ["1 |> obj$fun(§)", ["", null]],
    ["x |> obj$fun(1, se§)", ["", "", null]],
    ["x |> obj$fun(second = _, fi§)", ["second", null]],
    ["x |> obj$fun(fi§, second = _)", [null, "second"]],
    ["x |> obj$fun(2 |> other(x = _), th§)", ["", "", null]],
    ["x |> obj$fun(other(fi§))", [null]],
    ["x |> obj$fun(first = `_`, se§)", ["", "first", null]],
    ['x |> obj$fun(r"--(third)--" = _, fi§)', ['r"--(third)--"', null]],
    ['obj$fun(r"(third)" = 1, fi§)', ['r"(third)"', null]],
    ["x %>% obj$fun(§)", ["", null]],
    ["x %>% obj$fun(second = ., fi§)", ["second", null]],
    ["x %>% obj$fun(., se§)", ["", null]],
    ["x %>% obj$fun(`.`, se§)", ["", null]],
    ["x %>% obj$fun(other(.), th§)", ["", "", null]],
    ["x %>% obj$fun(.§)", ["", null]],
    ['obj$fun("x |> obj$fun", se§)', ["", null]],
    ["x |> previous(); obj$fun(fi§)", [null]],
    ["x |> # continuation\n obj$fun(fi§)", ["", null]],
  ]) {
    const cursor = marked.indexOf("§");
    const context = parser.getEnclosingCall(marked.replace("§", ""), cursor);
    assert.deepEqual(context?.argumentTags, tags, marked);
  }
});
