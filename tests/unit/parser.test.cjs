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
