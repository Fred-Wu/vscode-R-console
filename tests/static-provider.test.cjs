const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createConsoleLsp } = require('./helpers/console-lsp.cjs');
const loadSource = require('./helpers/load-source.cjs');
const { createGuardedBindingResolver } = loadSource('src/Language/completion/bindings.ts');
const { requestStaticCompletion } = loadSource('src/Language/completion/staticProvider.ts');
const { retryStaticCompletion } = require('./helpers/static-completion.cjs');

test('a cold native reply can exceed one provider deadline and resolve on a fresh request', { timeout: 60000 }, async t => {
  class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
  const { collectStaticFallbackEntries } = loadSource('src/Language/completion/service.ts', {
    vscode: { Position, CompletionItemKind: { Text: 0, Function: 2, Field: 4, Snippet: 14 } },
  });
  const { getCompletionContext } = loadSource('src/Language/completion/syntax.ts');
  let delayed = false;
  const { client } = createConsoleLsp(t, { afterResponse: async method => {
    if (method.method === 'textDocument/completion' && !delayed) {
      delayed = true;
      await new Promise(resolve => setTimeout(resolve, 11000));
    }
  } });
  const input = 'obj <- list(stored=1)\nobj$';
  const position = new Position(1, 4);
  const context = getCompletionContext('obj$', 4, input);
  const results = [];
  const entries = await retryStaticCompletion(async () => {
    const result = await collectStaticFallbackEntries(context,
      { version: 1, getText: () => input, uri: client.inputDocument.uri }, position, ['obj <- list(stored=1)'], client);
    results.push(result);
    return result;
  });
  assert.equal(results[0].staticUnavailableReason, 'analysis-limit');
  assert.deepEqual([...results[0]], [], 'a timed out reply cannot publish candidates');
  assert.equal(results.length, 2);
  assert.equal(entries.staticResolved, true);
  assert.deepEqual(entries.map(item => item.label), ['stored']);
});

test('general static contract uses the real languageserver adapter and preserves binding barriers', { timeout: 60000 }, async t => {
  const { client } = createConsoleLsp(t);
  await client.start();
  const calls = [];
  let snapshot = { status: 'source', text: 'function() list(alpha=1)' };
  const complete = async text => {
    const position = { line: 0, character: text.length };
    return requestStaticCompletion(client, {
      input: text, cursor: text.length, position, contextPosition: position, requestScope: {},
      document: { getText: () => text, version: 1 },
      bindings: createGuardedBindingResolver(async (name, lookup) => { calls.push([name, lookup]); return snapshot; }),
    });
  };
  let result = await complete('factory()$');
  assert.equal(result.staticStatus, 'resolved');
  assert.ok(result.items.some(item => item.label === 'alpha'));
  assert.deepEqual(calls, [['factory', 'source']]);
  snapshot = { status: 'source', text: 'function() list(beta=1)' };
  result = await complete('factory()$');
  assert.ok(result.items.some(item => item.label === 'beta'));
  assert.ok(!result.items.some(item => item.label === 'alpha'), 'a new request reads the current definition');
  for (const refusal of [{ status: 'opaque' }, { status: 'suppressed', reason: 'active-binding' }, { status: 'unavailable' }]) {
    snapshot = refusal;
    result = await complete('factory()$');
    assert.deepEqual(result.items, [], refusal.status);
    assert.equal(result.staticStatus, 'unresolved', refusal.status);
  }
  snapshot = { status: 'missing' };
  result = await complete('factory <- function() list(draft=1); factory()$');
  assert.ok(result.items.some(item => item.label === 'draft'));
  result = await complete('f <- function(alpha) NULL; f(');
  assert.ok(result.items.some(item => item.label === 'alpha'));
  for (const text of ['g <- function(f) { f(me', 'g <- function(f) { f(x = me',
    'f <- unknown_factory(); f(me']) {
    result = await complete(text);
    assert.equal(result.staticStatus, 'resolved', text);
    assert.equal(result.rConsoleArgumentsResolved, false, text);
    assert.ok(result.items.some(item => item.label === 'mean'), text);
    assert.ok(!result.items.some(item => item.detail === 'parameter'), text);
  }
  result = await complete('stats::lm(');
  assert.deepEqual(result.items.filter(item => item.detail === 'parameter').slice(0, 4).map(item => item.label),
    ['formula', 'data', 'subset', 'weights']);
  result = await complete('df <- data.frame(alpha=1); subset(df, ');
  assert.ok(result.items.some(item => item.label === 'drop'), JSON.stringify(result));
  for (const text of ['factory()[, co', 'factory()[1, "co']) {
    const before = calls.length;
    result = await complete(text);
    assert.equal(result.staticStatus, 'unresolved');
    assert.equal(result.rConsoleStaticUnavailableReason, 'unsupported-context');
    assert.deepEqual(result.items, []);
    assert.equal(calls.length, before, 'unsupported adapter contexts do not inspect runtime bindings');
  }
});

test('source method arguments retain call-site provenance across statement layouts and shadowing', { timeout: 60000 }, async t => {
  const { client } = createConsoleLsp(t);
  for (const separator of ['; ', '\n']) {
    for (const [definition, call, expected] of [
      ['obj <- list(fun=function(arg) NULL)', 'obj$fun(', ['arg']],
      ['obj <- list(fun=function(arg) NULL); alias <- obj', 'alias$fun(', ['arg']],
      ['obj <- list(fun=function(arg) NULL); obj <- unknown_factory()', 'obj$fun(', []],
      ['obj <- list(fun=function(arg) NULL); g <- function(obj) {', 'obj$fun(', []],
    ]) {
      const input = definition + separator + call;
      const lines = input.split('\n');
      const position = { line: lines.length - 1, character: lines.at(-1).length };
      const result = await requestStaticCompletion(client, {
        document: { version: 1, getText: () => input }, input, cursor: input.length,
        position, contextPosition: position, requestScope: {},
        bindings: createGuardedBindingResolver(async () => ({ status: 'missing' })),
      });
      assert.deepEqual(result.items.filter(item => item.detail === 'parameter').map(item => item.label), expected, input);
    }
  }
});

test('fuzzy method completion reuses its snapshot after a slow native response', { timeout: 60000 }, async t => {
  class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
  const { getLanguageServerCompletions } = loadSource('src/Language/completion/languageServer.ts', {
    vscode: { Position, CompletionItemKind: { Text: 0, Function: 2, Field: 4, Snippet: 14 } },
  });
  const { getCompletionContext } = loadSource('src/Language/completion/syntax.ts');
  const { client } = createConsoleLsp(t);
  const complete = client.provideCompletionItems.bind(client);
  let requests = 0, reads = 0;
  client.provideCompletionItems = async (...args) => {
    const result = await complete(...args);
    if (++requests === 1) await new Promise(resolve => setTimeout(resolve, 1600));
    return result;
  };
  const input = 'factory()$method(qqux';
  const result = await getLanguageServerCompletions(getCompletionContext(input, input.length),
    { version: 1, getText: () => input }, new Position(0, input.length), [], client, undefined, 'static', {
      bindings: createGuardedBindingResolver(async () => {
        reads++; return { status: 'source', text: 'function() list(method=function(q_quux, zebra) NULL)' };
      }),
    });
  assert.equal(requests, 2);
  assert.equal(reads, 1);
  assert.ok(result.entries.some(item => item.label === 'q_quux'));
});

test('real static provider broadens independent symbols with unknown callable parameters', { timeout: 60000 }, async t => {
  class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
  const { getLanguageServerCompletions } = loadSource('src/Language/completion/languageServer.ts', {
    vscode: { Position, CompletionItemKind: { Text: 0, Function: 2, Field: 4, Snippet: 14 } },
  });
  const { getCompletionContext } = loadSource('src/Language/completion/syntax.ts');
  const { client, instances } = createConsoleLsp(t);
  for (const input of ['g <- function(f) { f(qnrm', 'g <- function(f) { f(x = qnrm']) {
    const result = await getLanguageServerCompletions(getCompletionContext(input, input.length),
      { version: 1, getText: () => input }, new Position(0, input.length), [], client, undefined, 'static');
    assert.ok(result.entries.some(item => item.label === 'qnorm'), input);
    assert.equal(result.argumentsResolved, false);
    assert.ok(result.entries.every(item => item.role !== 'argument' && item.role !== 'value'));
    const queries = instances.at(-1).requests.filter(r => r.params?.position).slice(-2);
    assert.deepEqual(queries.map(r => r.params.position.character), [input.length, input.length - 3]);
  }
});
