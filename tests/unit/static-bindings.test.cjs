const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadSource = require('../helpers/load-source.cjs');
const { createGuardedBindingResolver } = loadSource('src/Language/completion/bindings.ts');
const query = (name, lookup = 'function', extra = {}) => ({ name, lookup, ...extra });

test('binding capability preserves lookup identity and caches only within one request', async () => {
  const calls = [];
  let source = 'function() list(alpha=1)';
  const inspect = async (name, target) => {
    calls.push([name, target]);
    return target === 'source' ? { status: 'source', text: source } : { status: 'not-callable' };
  };
  const first = createGuardedBindingResolver(inspect);
  const [a, b] = await Promise.all([first.resolve(query('factory')), first.resolve(query('factory'))]);
  assert.equal(a.status, 'source');
  assert.equal(a.source, source);
  assert.deepEqual(a, b);
  assert.equal((await first.resolve(query('factory', 'value'))).status, 'not-callable');
  assert.equal((await first.resolve(query('factory', 'identity'))).status, 'not-callable');
  assert.deepEqual(calls, [['factory', 'source'], ['factory', 'source-value'], ['factory', 'binding']]);
  source = 'function() list(beta=1)';
  assert.equal((await first.resolve(query('factory'))).source, a.source);
  assert.equal((await createGuardedBindingResolver(inspect).resolve(query('factory'))).source, source);
});

test('binding queries reject unsupported scopes and options without inspecting a namesake', async () => {
  const resolver = createGuardedBindingResolver(async () => assert.fail('invalid query must not inspect R'));
  const inheritedScope = Object.assign(Object.create({ scope: { kind: 'closure' } }), query('factory'));
  assert.equal((await resolver.resolve(inheritedScope)).reason, 'invalid-request');
  for (const extra of [{ scope: { kind: 'closure', bindingId: 'captured' } }, { depth: 1 }]) {
    assert.deepEqual(await resolver.resolve(query('factory', 'function', extra)),
      { status: 'unavailable', reason: 'invalid-request' });
  }
});

test('binding limits cover concurrent source reads, lookups and invalid requests', async () => {
  const calls = [];
  const resolver = createGuardedBindingResolver(async name => {
    calls.push(name); return { status: 'source', text: 'function() 1' };
  }, { limits: { lookups: 3, sourceBytes: 16, totalBytes: 16 } });
  const results = await Promise.all(['a', 'b', 'c', 'd'].map(name => resolver.resolve(query(name))));
  assert.equal(results.filter(x => x.status === 'source').length, 1);
  assert.equal(results.filter(x => x.reason === 'analysis-limit').length, 3);
  assert.deepEqual(calls, ['a', 'b', 'c']);
  for (const q of [query(''), query('bad\0name'), query('a', 'evaluate'), query('a', 'function', { depth: -1 })]) {
    assert.equal((await resolver.resolve(q)).reason, 'invalid-request');
  }
  const oversized = createGuardedBindingResolver(async () => ({ status: 'source', text: 'é'.repeat(10) }),
    { limits: { sourceBytes: 19 } });
  assert.equal((await oversized.resolve(query('wide'))).reason, 'analysis-limit');
});

test('binding cancellation, timeout and changed runtime invalidate pending and cached reads', async () => {
  let release;
  const controller = new AbortController();
  const resolver = createGuardedBindingResolver(() => new Promise(resolve => { release = resolve; }), { signal: controller.signal });
  const pending = resolver.resolve(query('factory'));
  await Promise.resolve();
  controller.abort();
  assert.equal((await pending).reason, 'cancelled');
  release({ status: 'source', text: 'function() 1' });
  assert.equal((await resolver.resolve(query('factory'))).reason, 'cancelled');
  const timed = createGuardedBindingResolver(() => new Promise(() => {}), { limits: { timeoutMs: 10 } });
  assert.equal((await timed.resolve(query('factory'))).reason, 'analysis-limit');
  let current = true;
  const changed = createGuardedBindingResolver(async () => ({ status: 'missing' }), { isCurrent: () => current });
  assert.equal((await changed.resolve(query('factory'))).status, 'missing');
  current = false;
  assert.equal((await changed.resolve(query('factory'))).reason, 'cancelled');
});

test('native refusals and unavailable inspection never become missing bindings', async () => {
  for (const result of [{ status: 'opaque' }, { status: 'package' }, { status: 'missing' },
    { status: 'suppressed', reason: 'active-binding' }, { status: 'suppressed', reason: 'deferred-binding' }]) {
    assert.deepEqual(await createGuardedBindingResolver(async () => result).resolve(query('factory')), result);
  }
  for (const inspect of [undefined, () => undefined, () => { throw Error('failed'); }]) {
    assert.deepEqual(await createGuardedBindingResolver(inspect).resolve(query('factory')),
      { status: 'unavailable', reason: 'runtime-unavailable' });
  }
});

test('queued binding reads snapshot query identity before callers can reuse the query object', async () => {
  const calls = [];
  const resolver = createGuardedBindingResolver(async (name, target) => { calls.push([name, target]); return { status: 'missing' }; });
  const request = query('original');
  const pending = resolver.resolve(request);
  request.name = 'different';
  request.lookup = 'value';
  await pending;
  assert.deepEqual(calls, [['original', 'source']]);
});

test('provider lifetime closes pending reads and invalidates stale document responses', async () => {
  const { requestStaticCompletion } = loadSource('src/Language/completion/staticProvider.ts');
  let release, pendingRead, capability;
  const document = { version: 1, getText: () => 'factory()$' };
  const bindings = createGuardedBindingResolver(() => new Promise(resolve => { release = resolve; }));
  const request = { document, input: document.getText(), cursor: 10, position: { line: 0, character: 10 },
    contextPosition: { line: 0, character: 10 }, bindings, requestScope: {} };
  await requestStaticCompletion({ provideStaticCompletion: async r => {
    capability = r.bindings;
    pendingRead = r.bindings.resolve(query('factory'));
    await Promise.resolve();
    return { status: 'resolved-empty', completion: { items: [] } };
  } }, request);
  assert.equal(capability.signal.aborted, true);
  assert.deepEqual(await Promise.race([
    pendingRead, new Promise(resolve => setImmediate(() => resolve('still pending'))),
  ]), { status: 'unavailable', reason: 'cancelled' });
  release({ status: 'source', text: 'function() list(secret=1)' });
  assert.equal((await pendingRead).reason, 'cancelled');
  let retryBinding;
  await requestStaticCompletion({ provideStaticCompletion: async r => {
    retryBinding = await r.bindings.resolve(query('factory'));
    return { status: 'resolved-empty', completion: { items: [] } };
  } }, request);
  assert.equal(retryBinding.status, 'source');
  assert.equal(retryBinding.source, 'function() list(secret=1)', 'prefix retries retain the shared snapshot');
  const stale = await requestStaticCompletion({ provideStaticCompletion: async () => {
    document.version++;
    return { status: 'resolved', completion: { items: [{ label: 'stale' }] } };
  } }, request);
  assert.equal(stale.staticStatus, 'pending');
  assert.deepEqual(stale.items, []);
});

test('failed and cancelled providers immediately settle their outstanding binding reads', async () => {
  const { requestStaticCompletion } = loadSource('src/Language/completion/staticProvider.ts');
  for (const end of ['failure', 'cancellation']) {
    const controller = new AbortController();
    const input = 'factory()$';
    const position = { line: 0, character: input.length };
    let read;
    const result = await requestStaticCompletion({ provideStaticCompletion: async r => {
      read = r.bindings.resolve(query('factory'));
      if (end === 'failure') throw new Error('provider failed');
      controller.abort();
      return new Promise(() => {});
    } }, {
      document: { version: 1, getText: () => input }, input, cursor: input.length,
      position, contextPosition: position, requestScope: {},
      bindings: { signal: controller.signal, isCurrent: () => !controller.signal.aborted,
        resolve: () => new Promise(() => {}) },
    });
    assert.equal(result.staticStatus, end === 'failure' ? 'unresolved' : 'pending');
    assert.deepEqual(await Promise.race([
      read, new Promise(resolve => setImmediate(() => resolve('still pending'))),
    ]), { status: 'unavailable', reason: 'cancelled' }, end);
  }
});

test('runtime-only providers cannot silently supply static completion', async () => {
  const { requestStaticCompletion } = loadSource('src/Language/completion/staticProvider.ts');
  const input = 'factory()$';
  const position = { line: 0, character: input.length };
  const result = await requestStaticCompletion({
    provideCompletionItems: async () => assert.fail('static requests require an explicit provider method'),
  }, {
    document: { version: 1, getText: () => input }, input, cursor: input.length,
    position, contextPosition: position, requestScope: {},
    bindings: createGuardedBindingResolver(async () => assert.fail('no binding lookup without static support')),
  });
  assert.equal(result.staticStatus, 'unresolved');
  assert.equal(result.rConsoleStaticUnavailableReason, 'provider-unavailable');
  assert.deepEqual(result.items, []);
});

test('settled binding snapshots survive the lookup deadline while new reads and cancelled reuse remain blocked', async () => {
  const controller = new AbortController();
  const calls = [];
  const resolver = createGuardedBindingResolver(async name => {
    calls.push(name); return { status: 'source', text: 'function() list(alpha=1)' };
  }, { signal: controller.signal, limits: { timeoutMs: 10 } });
  const first = await resolver.resolve(query('factory'));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(await resolver.resolve(query('factory')), first);
  assert.equal((await resolver.resolve(query('another'))).reason, 'analysis-limit');
  controller.abort();
  assert.equal((await resolver.resolve(query('factory'))).reason, 'cancelled');
  assert.deepEqual(calls, ['factory']);
});

test('provider outcomes preserve evidence without publishing refused candidates or mutating provider lists', async () => {
  const { requestStaticCompletion } = loadSource('src/Language/completion/staticProvider.ts');
  const input = 'factory()$';
  const completion = Object.freeze({ items: Object.freeze([{ label: 'alpha', role: 'member' }]),
    isIncomplete: true, rConsoleArgumentsResolved: false });
  for (const status of ['resolved', 'resolved-empty', 'unresolved', 'pending']) {
    const reply = await requestStaticCompletion({ provideStaticCompletion: async () => ({
      status, completion, reason: 'receiver-unresolved',
    }) }, { document: { version: 1, getText: () => input }, input,
      bindings: createGuardedBindingResolver() });
    assert.equal(reply.staticStatus, status);
    assert.deepEqual(reply.items.map(item => item.label), status === 'resolved' ? ['alpha'] : []);
    assert.equal(reply.rConsoleArgumentsResolved, false, 'signature barriers survive empty results');
    assert.equal(reply.isIncomplete, status !== 'resolved-empty');
    reply.items.push({ label: 'local' });
    assert.equal(completion.items.length, 1, 'presentation cannot mutate a provider snapshot');
  }
});
