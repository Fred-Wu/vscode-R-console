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

test("native parsing distinguishes incomplete input from errors and falls back on failure", async (t) => {
  t.after(() => parser.setNativeParseCallback(null));
  parser.setNativeParseCallback(async () => 2);
  assert.equal(await parser.isExpressionCompleteAsync("x"), false);
  parser.setNativeParseCallback(async () => 3);
  assert.equal(await parser.isExpressionCompleteAsync("x"), true);
  parser.setNativeParseCallback(async () => { throw new Error("timeout"); });
  assert.equal(await parser.isExpressionCompleteAsync("x[1]"), true);
  assert.equal(await parser.isExpressionCompleteAsync("x["), false);
});

test("raw strings use the exact bracket, dash count, and quote across all supported delimiters", async () => {
  for (const { literal, incomplete } of require("../helpers/raw-string-cases.cjs")) {
    assert.equal(parser.stripCommentLines(`# outside\ns <- ${literal}\n# outside\ns`), `s <- ${literal}\ns`);
    assert.equal(await parser.isExpressionCompleteAsync(literal), true, literal);
    assert.equal(await parser.isExpressionCompleteAsync(incomplete), false, incomplete);
    assert.equal(await parser.isExpressionCompleteAsync(`${literal}\nx <- (`), false);
    assert.deepEqual(parser.tokenizeForHighlighting(`${literal}\nx`), [
      { kind: "string", value: literal, position: 0 },
      { kind: "identifier", value: "x", position: literal.length + 1 },
    ]);
  }
});

test("unterminated raw strings cannot be made complete by a later ordinary quote", async () => {
  for (const input of ['r"-(abc-"', 'r"--[abc]--\' tail "', 'R\'{abc)\'']) {
    assert.equal(await parser.isExpressionCompleteAsync(input), false, input);
  }
});
