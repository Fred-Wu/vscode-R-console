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

test('protocol syntax shares tokenization and preserves the actual cursor on fuzzy requests', () => {
  const lexer = loadSource('src/Language/lexer.ts');
  let tokenizations = 0;
  const { createCompletionParams } = loadSource('src/Language/completion/protocol.ts', {
    '../lexer': { ...lexer, tokenize: (...args) => { tokenizations++; return lexer.tokenize(...args); } },
  });
  for (const [marked, expected] of [
    ['factory()[[1]] |> target(│)', { rConsoleCall: 'target', rConsoleArgumentTags: ['', null] }],
    ['target(df[, col│])', { rConsoleDataObject: 'df', rConsoleSubscriptOperator: '[', rConsoleSubscriptTags: ['', null] }],
    ['target(df[1]) |> fo│obar()', { rConsolePipe: true, rConsolePrefix: 'f' }],
  ]) {
    const cursor = marked.indexOf('│'), text = marked.replace('│', '');
    const position = { line: 0, character: cursor }, query = { line: 0, character: cursor - 1 };
    const document = { getText: () => text, offsetAt: p => p.character };
    const projection = { document, toServerPosition: p => p };
    const client = { code2ProtocolConverter: { asCompletionParams: (_doc, pos) => ({ position: pos }) } };
    const before = tokenizations;
    const params = createCompletionParams(client, projection, query, position, {}, true);
    // A mid-token cursor may require one additional scan of that token fragment.
    assert.ok(tokenizations - before <= 2, `${marked}: ${tokenizations - before} scans`);
    assert.equal(params.position, query);
    for (const [name, value] of Object.entries(expected)) assert.deepEqual(params[name], value, marked + ': ' + name);
  }
});

test('native dependency discovery shares cursor tokens across contexts and keeps requests independent', async () => {
  const lexer = loadSource('src/Language/lexer.ts');
  const scans = [];
  const { provideNativeStaticCompletion } = loadSource('src/Language/completion/nativeStaticProvider.ts', {
    '../lexer': { ...lexer, tokenize: code => { scans.push(code); return lexer.tokenize(code); } },
  });
  for (const [marked, fragment, lookup] of [
    ['factory()$al│pha', 'al', 'function'],
    ['factory()$alp│ha', 'alp', 'function'],
    ['factory()[["al│pha"]]', '"al', 'function'],
    ['factory()$method(al│pha)', 'al', 'function'],
    ['(factory)()$al│pha', 'al', 'value'],
  ]) {
    const before = 'heading <- "😀"\n';
    const input = before + marked.replace('│', '') + '\ntrailing <- TRUE';
    const cursor = before.length + marked.indexOf('│');
    const queries = [];
    scans.length = 0;
    const result = await provideNativeStaticCompletion(async binding => {
      assert.deepEqual(binding, { name: 'factory', body: 'function() list(alpha=1)' });
      return { items: [{ label: 'alpha', data: { type: 'member' } }], rConsoleMemberResolved: true };
    }, { input, cursor, bindings: {
      isCurrent: () => true,
      resolve: async query => { queries.push(query); return { status: 'source', source: 'function() list(alpha=1)' }; },
    } });
    assert.deepEqual(queries, [{ name: 'factory', lookup }], marked);
    assert.equal(result.status, 'resolved', marked);
    assert.deepEqual(result.completion.items.map(item => item.role), ['member']);
    assert.equal(scans.filter(code => code === fragment).length, 1,
      `${marked}: classification, fallback and dependency discovery share the cursor fragment`);
  }
});

test('opaque projected receivers share cursor tokens and retain their projected positions', () => {
  const lexer = loadSource('src/Language/lexer.ts');
  const scans = [];
  const { createCompletionParams } = loadSource('src/Language/completion/protocol.ts', {
    '../lexer': { ...lexer, tokenize: code => { scans.push(code); return lexer.tokenize(code); } },
  });
  for (const [marked, fragment] of [['factory()$al│pha', 'al'], ['factory()[["al│pha"]]', '"al']]) {
    // A preceding selected package function adds a qualifier to this projection.
    const qualifier = 'stats::', visiblePrefix = 'lm(); ', prefix = qualifier + visiblePrefix;
    const text = prefix + marked.replace('│', '');
    const contextPosition = { line: 0, character: visiblePrefix.length + marked.indexOf('│') };
    const query = { line: 0, character: contextPosition.character + qualifier.length - 1 };
    const document = { getText: () => text, offsetAt: p => p.character,
      positionAt: character => ({ line: 0, character }) };
    const projection = { document,
      toServerPosition: p => ({ line: p.line, character: p.character + qualifier.length }) };
    const client = { code2ProtocolConverter: { asCompletionParams: (_doc, position) => ({ position }) } };
    scans.length = 0;
    const params = createCompletionParams(client, projection, query, contextPosition, {}, true, { name: 'factory' });
    assert.equal(params.position, query);
    assert.equal(params.rConsoleOpaqueFunction, 'factory');
    assert.deepEqual(params.rConsoleOpaqueFunctionPosition, { line: 0, character: prefix.length });
    assert.equal(scans.filter(code => code === fragment).length, 1, marked);
  }
});
