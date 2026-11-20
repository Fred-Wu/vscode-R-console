const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { runtimeCompletionText } = loadSource("src/Language/completion/runtimeDocument.ts");
const pkg = require("../../package.json");

test("static completion is opt-in and disabled by default", () => {
  assert.equal(pkg.contributes.configuration.properties["r.console.completion.staticAnalysis"].default, false);
});

test("runtime document masks completed input definitions without changing offsets", () => {
  for (const [input, expected] of [
    ["f <- function(new_arg) NULL\\nf(", "f("],
    ["obj <- list(alpha = 1); obj$", "obj$"],
    ["{ f <- function(new_arg) NULL; f(", " f("],
    ["obj <- list(alpha = 1)\\nobj$fun(", "obj$fun("],
    ["f <- function(x) \\n  { f(", " f("],
  ]) {
    const actual = runtimeCompletionText(input, input.length);
    assert.equal(actual.length, input.length);
    assert.equal(actual.slice(actual.lastIndexOf(expected.trimStart())), expected.trimStart(), input);
    assert.equal(actual.replace(/[^\\n ]/g, "").length >= input.length - expected.length, true, input);
  }
});

test("runtime document retains active call arguments and masks orphaned block closers", () => {
  const input = "{ f <- function(new_arg) NULL; f(old_arg = 1, │) }".replace("│", "");
  const cursor = "{ f <- function(new_arg) NULL; f(old_arg = 1, ".length;
  const actual = runtimeCompletionText(input, cursor);
  assert.ok(actual.includes("f(old_arg = 1, )"), actual);
  assert.ok(!actual.includes("function(new_arg)"), actual);
  assert.equal(actual.length, input.length);
});

test("runtime document leaves a single current statement unchanged", () => {
  for (const input of ["obj$fun(", "stats::lm(formula = x, ", "f(x = 1, ", "my_fun", "x |> print("]) {
    assert.equal(runtimeCompletionText(input, input.length), input);
  }
});
