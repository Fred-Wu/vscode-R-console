const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createConsoleLsp } = require('./helpers/console-lsp.cjs');
const loadSource = require('./helpers/load-source.cjs');
const { createGuardedBindingResolver } = loadSource('src/Language/completion/bindings.ts');
const { requestStaticCompletion } = loadSource('src/Language/completion/staticProvider.ts');

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
  assert.equal(result.rConsoleStaticStatus, 'resolved');
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
    assert.equal(result.rConsoleStaticStatus, 'unresolved', refusal.status);
  }
  snapshot = { status: 'missing' };
  result = await complete('factory <- function() list(draft=1); factory()$');
  assert.ok(result.items.some(item => item.label === 'draft'));
  result = await complete('f <- function(alpha) NULL; f(');
  assert.ok(result.items.some(item => item.label === 'alpha'));
  result = await complete('stats::lm(');
  assert.deepEqual(result.items.filter(item => item.detail === 'parameter').slice(0, 4).map(item => item.label),
    ['formula', 'data', 'subset', 'weights']);
  result = await complete('df <- data.frame(alpha=1); subset(df, ');
  assert.ok(result.items.some(item => item.label === 'drop'), JSON.stringify(result));
  for (const text of ['factory()[, co', 'factory()[1, "co']) {
    const before = calls.length;
    result = await complete(text);
    assert.equal(result.rConsoleStaticStatus, 'unresolved');
    assert.equal(result.rConsoleStaticUnavailableReason, 'unsupported-context');
    assert.deepEqual(result.items, []);
    assert.equal(calls.length, before, 'unsupported adapter contexts do not inspect runtime bindings');
  }
});
