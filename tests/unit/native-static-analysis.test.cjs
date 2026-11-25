const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadSource = require('../helpers/load-source.cjs');

function adapter() {
  const parser = loadSource('src/Language/completion/contextParser.ts');
  const receivers = loadSource('src/Language/completion/sourceReceiver.ts');
  const scans = [], discoveries = [];
  const { provideNativeStaticCompletion } = loadSource('src/Language/completion/nativeStaticProvider.ts', {
    './contextParser': { ...parser, getCompletionSyntax: (...args) => {
      scans.push(args);
      return parser.getCompletionSyntax(...args);
    } },
    './sourceReceiver': { storedCompletionReceiver: (...args) => {
      discoveries.push(args.slice(1, 3));
      return receivers.storedCompletionReceiver(...args);
    } },
  });
  return { provideNativeStaticCompletion, scans, discoveries };
}

test('native fuzzy retries reuse analysis while new collections read fresh stored source', async () => {
  const h = adapter();
  const vscode = { Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
    CompletionItemKind: { Text: 0, Method: 1, Function: 2, Field: 4, Snippet: 14 } };
  const { getLanguageServerCompletions } = loadSource('src/Language/completion/languageServer.ts', { vscode });
  const { getCompletionContext } = loadSource('src/Language/completion/syntax.ts');
  const { createGuardedBindingResolver } = loadSource('src/Language/completion/bindings.ts');
  const heading = 'heading <- "😀"\n', line = 'factory()$method(apa)';
  const input = heading + line, column = line.length - 1, cursor = heading.length + column;
  const context = getCompletionContext(line, column, input.slice(0, cursor), input.slice(cursor));
  const document = { version: 1, getText: () => input, uri: { toString: () => 'r-console://retry/console.R' } };
  const position = new vscode.Position(1, column);
  let source = 'function() list(method = function(alpha) NULL)';
  const queries = [], reads = [], projections = [];
  const provider = { provideStaticCompletion: request => {
    queries.push(request);
    return h.provideNativeStaticCompletion(async binding => {
      projections.push(binding);
      return { items: request.position.character === column ? [] : [
        { label: 'alpha', detail: 'parameter', insertText: 'alpha = ' },
      ] };
    }, request);
  } };
  for (let collection = 1; collection <= 2; collection++) {
    const bindings = createGuardedBindingResolver(async (name, target) => {
      reads.push([name, target]);
      return { status: 'source', text: source };
    });
    const result = await getLanguageServerCompletions(context, document, position, [heading.slice(0, -1)],
      provider, undefined, 'static', { bindings });
    assert.deepEqual(result.entries.map(item => [item.insertText, item.replaceStart]), [['alpha = ', context.replaceStart]]);
    assert.equal(h.scans.length, collection, 'one analysis per collection, including its fuzzy retry');
    assert.equal(h.discoveries.length, collection, 'receiver discovery is shared with the retry');
    assert.equal(reads.length, collection, 'guarded source reads remain request-local');
    assert.deepEqual(projections.slice(-2), [0, 1].map(() => ({ name: 'factory', body: source })));
    const [initial, retry] = queries.slice(-2);
    assert.equal(initial.requestScope, retry.requestScope);
    assert.equal(initial.cursor, cursor);
    assert.equal(retry.cursor, cursor);
    assert.equal(retry.position.character, context.replaceStart + 1);
    source = 'function() list(method = function(alpha, beta) NULL)';
  }
  assert.notEqual(queries[0].requestScope, queries[2].requestScope);
});

test('cached native syntax preserves cancellation, current bindings and runtime refusals', async () => {
  const h = adapter();
  const input = 'factory()$al';
  let current = true, source = 'function() list(alpha=1)';
  const reads = [], projections = [];
  const request = { input, cursor: input.length, requestScope: {}, bindings: {
    isCurrent: () => current,
    resolve: async query => { reads.push(query); return { status: 'source', source }; },
  } };
  const complete = async binding => { projections.push(binding); return { items: [] }; };
  await h.provideNativeStaticCompletion(complete, request);
  source = 'function() list(beta=1)';
  await h.provideNativeStaticCompletion(complete, request);
  assert.deepEqual(projections.at(-1), { name: 'factory', body: source }, 'analysis never captures a binding result');
  current = false;
  assert.equal((await h.provideNativeStaticCompletion(complete, request)).status, 'pending');
  assert.equal(projections.length, 2);
  assert.equal(reads.length, 2);
  current = true;
  await h.provideNativeStaticCompletion(complete, { ...request,
    runtimeRefusal: { expression: 'factory', reason: 'active-binding' } });
  assert.deepEqual(projections.at(-1), { name: 'factory', opaqueReceiver: true });
  assert.equal(reads.length, 2, 'refusal bypasses dependency lookup even with cached analysis');
  await h.provideNativeStaticCompletion(complete, { ...request, bindings: {
    isCurrent: () => true, resolve: async () => ({ status: 'missing' }),
  } });
  assert.equal(projections.at(-1), undefined, 'the current invocation owns binding eligibility');
  assert.equal(h.scans.length, 1);
  assert.equal(h.discoveries.length, 1);
});

test('native analysis checks input and actual cursor and caches absent contexts and receivers', async () => {
  const h = adapter(), scope = {}, names = [];
  const bindings = { isCurrent: () => true, resolve: async query => { names.push(query.name); return { status: 'missing' }; } };
  const run = (input, cursor = input.length, requestScope = scope) => h.provideNativeStaticCompletion(
    async () => ({ items: [] }), { input, cursor, requestScope, bindings });
  await run('factory()$alpha', 12);
  await run('factory()$alpha', 13);
  await run('builder()$alpha', 13);
  assert.equal(h.scans.length, 3, 'cursor moves and same-length edits each invalidate analysis');
  assert.deepEqual(names, ['factory', 'factory', 'builder']);
  await run('builder()$alpha', 13, {});
  assert.equal(h.scans.length, 4, 'independent requests do not share analysis');
  const before = h.discoveries.length;
  for (const input of ['', 'ordinary', '# comment']) {
    const count = h.scans.length;
    await run(input);
    await run(input);
    assert.equal(h.scans.length, count + 1, input);
  }
  assert.equal(h.discoveries.length, before + 1, 'an absent receiver is discovered once; absent and suppressed contexts skip discovery');
});
