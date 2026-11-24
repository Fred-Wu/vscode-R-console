const assert = require('node:assert/strict');
const { test } = require('node:test');
const { retryStaticCompletion } = require('../helpers/static-completion.cjs');

test('static integration retries only bounded transient analysis results', async () => {
  for (const reason of ['analysis-pending', 'analysis-limit', 'no-response']) {
    let calls = 0;
    const ready = Object.assign([], { staticResolved: true });
    const result = await retryStaticCompletion(async () => ++calls === 1
      ? Object.assign([], { isIncomplete: true, staticUnavailableReason: reason }) : ready, { delayMs: 0 });
    assert.equal(result, ready);
    assert.equal(calls, 2);
  }
  for (const reason of ['receiver-unresolved', 'unsupported-context', 'request-failed', undefined]) {
    let calls = 0;
    const unresolved = Object.assign([], { isIncomplete: true, staticUnavailableReason: reason });
    assert.equal(await retryStaticCompletion(async () => { calls++; return unresolved; }), unresolved);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const limited = Object.assign([], { isIncomplete: true, staticUnavailableReason: 'analysis-limit' });
  assert.equal(await retryStaticCompletion(async () => { calls++; return limited; }, { delayMs: 0 }), limited);
  assert.equal(calls, 3, 'persistent limits remain visible after a bounded number of requests');
  await assert.rejects(retryStaticCompletion(async () => { throw Error('transport failed'); }), /transport failed/);
});
