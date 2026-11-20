const assert = require("node:assert/strict");
const test = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { getCompletionParseSuffix } = loadSource("src/Language/completion/contextParser.ts");
const { createCompletionParams } = loadSource("src/Language/completion/protocol.ts");

test("completion recovery retains non-function source bindings in unfinished input", () => {
  for (const [input, suffix] of [
    ["obj <- list(fun = 1)\nobj$fun(", ")"],
    ["obj <- get('unknown')\nobj$fun(", ")"],
    ["obj$fun <- 1\nobj$fun(", ")"],
    ["obj$nested <- list(fun = 1)\nobj$nested$fun(", ")"],
    ["obj$nested$fun <- 1\nobj$nested$fun(", ")"],
    ["obj@fun <- 1\nobj@fun(", ")"],
    ["obj[['fun']] <- 1\nobj$fun(", ")"],
    ["{ obj <- NULL; obj$fun(", ")}"],
    ["obj <<- NULL\nobj$fun(", ")"],
    ["obj = NULL\nobj$fun(", ")"],
    ["NULL -> obj\nobj$fun(", ")"],
    ["NULL ->> obj\nobj$fun(", ")"],
    ["obj <- NULL\nobj$fun( # unfinished call", "\n)"],
    ["obj <- NULL\nobj$fun(name = 'unfinished", "')"],
    ["obj <- list()\nobj[[", "]]"],
    ["obj$fun(); obj <- list(fun = 1)", ""],
    ["g <- function(x) NULL; g(", ")"],
    ["g <- \\(x) NULL; g(", ")"],
  ]) assert.equal(getCompletionParseSuffix(input), suffix, input);
});

test("completion recovery ignores literal assignment text and rejects mismatched delimiters", () => {
  for (const input of [
    "obj$fun(",
    "# obj <- NULL\nobj$fun(",
    "'obj <- NULL'; obj$fun(",
    'r"(obj <<- NULL)"; obj$fun(',
    "`obj=fun`(",
    "'NULL -> obj'; obj$fun(",
    "# NULL ->> obj\nobj$fun(",
    "obj == other; obj$fun(",
    "obj != other; obj$fun(",
    "obj <= other; obj$fun(",
    "obj >= other; obj$fun(",
    "obj <- NULL; obj$fun(]",
    "obj <- NULL; }",
  ]) assert.equal(getCompletionParseSuffix(input), undefined, input);
});

test("member-call requests carry source-binding recovery without moving the cursor", () => {
  for (const [marked, call, suffix] of [
    ["obj <- list(fun = 1)\nobj$fun(│", "obj$fun", ")"],
    ["obj$nested$fun <- 1\nobj$nested$fun(│", "obj$nested$fun", ")"],
    ["obj@fun <- 1\nobj@fun(│", "obj@fun", ")"],
    ["obj$fun(│); obj <- list(fun = 1)", "obj$fun", ""],
    ["other <- 1\nobj$fun(│", "obj$fun", ")"],
    ["obj$fun(│)", "obj$fun", undefined],
  ]) {
    const text = marked.replace("│", "");
    const before = marked.slice(0, marked.indexOf("│")).split("\n");
    const position = { line: before.length - 1, character: before.at(-1).length };
    const document = {
      getText: () => text,
      offsetAt: ({ line, character }) => text.split("\n").slice(0, line)
        .reduce((offset, part) => offset + part.length + 1, character),
    };
    const projection = { document, toServerPosition: point => point };
    const client = { code2ProtocolConverter: {
      asCompletionParams: (_document, point, context) => ({ position: point, context }),
    } };
    const params = createCompletionParams(client, projection, position, position, { triggerKind: 1 });
    assert.equal(params.rConsoleCall, call, marked);
    assert.equal(params.rConsoleParseSuffix, suffix, marked);
    assert.equal(Object.hasOwn(params, "rConsoleParseSuffix"), suffix !== undefined, marked);
    assert.deepEqual(params.rConsoleArgumentTags, [null], marked);
    assert.deepEqual(params.position, position, marked);
    assert.equal(document.getText(), text, "parse recovery must not edit the input");
  }
});
