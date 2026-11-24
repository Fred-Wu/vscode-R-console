const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadSource = require('../helpers/load-source.cjs');
const { createCompletionParams } = loadSource('src/Language/completion/protocol.ts');

test('static requests leave unfinished syntax recovery to languageserver', () => {
  for (const text of ['{ f <- function(alpha) NULL; f(', 'f <- function() { x |>',
    'g <- function(f = function(alpha) NULL) { f(', 'make_data()[["al']) {
    const position = { line: 0, character: text.length };
    const document = { getText: () => text, offsetAt: p => p.character };
    const projection = { document, toServerPosition: p => p };
    const client = { code2ProtocolConverter: { asCompletionParams: (_doc, pos, context) => ({
      textDocument: { uri: 'r-console://static/console.R' }, position: pos, context,
    }) } };
    const params = createCompletionParams(client, projection, position, position, {}, true);
    assert.equal(params.rConsoleStaticAnalysis, true);
    assert.equal(Object.hasOwn(params, 'rConsoleParseSuffix'), false, text);
    assert.equal(Object.hasOwn(params, 'rConsoleParseInsertion'), false, text);
    assert.equal(document.getText(), text);
  }
});
