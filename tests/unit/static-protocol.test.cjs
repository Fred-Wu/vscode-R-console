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

test('native array replies normalize member provenance before static filtering', () => {
  const { adaptNativeCompletionResult } = loadSource('src/Language/completion/nativeMetadata.ts');
  const input = Object.freeze(Object.assign([
    Object.freeze({ label: 'alpha', data: { type: 'member' } }),
    Object.freeze({ label: 'ambient', data: { type: 'scope' } }),
  ], { rConsoleMemberResolved: true }));
  const result = adaptNativeCompletionResult(input);
  assert.equal(Array.isArray(result), false);
  assert.equal(Object.hasOwn(result, "0"), false, "raw candidates must exist only in the validated items list");
  assert.equal(result.isIncomplete, false);
  assert.equal(result.rConsoleMemberResolved, true);
  assert.deepEqual(result.items.map(item => item.role), ['member', 'scope']);
  result.items.pop();
  assert.equal(input.length, 2);
});
