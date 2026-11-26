const assert = require("node:assert/strict");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");
const { requestStaticCompletion, STATIC_COMPLETION_REQUEST_TIMEOUT_MS } =
  loadSource("src/Language/completion/staticProvider.ts");

function request(signal) {
  const document = { version: 1, getText: () => "iris$" };
  return {
    document, input: document.getText(),
    bindings: { isCurrent: () => true, signal, resolve: async () => ({ status: "missing" }) },
  };
}

test("native static completion allows 20 seconds on every OS, then remains retryable", async t => {
  let timeout, fire, cancelled = 0, liveBindings, resolveSlow;
  t.mock.method(global, "setTimeout", (callback, ms) => {
    fire = callback;
    timeout = ms;
    return { mocked: true };
  });
  t.mock.method(global, "clearTimeout", () => { cancelled++; });
  const provider = {
    provideStaticCompletion({ bindings }) {
      liveBindings = bindings;
      return new Promise(resolve => { resolveSlow = resolve; });
    },
  };
  const completion = requestStaticCompletion(provider, request());
  await Promise.resolve();
  assert.equal(STATIC_COMPLETION_REQUEST_TIMEOUT_MS, 20_000);
  assert.equal(timeout, STATIC_COMPLETION_REQUEST_TIMEOUT_MS);
  assert.equal(liveBindings.signal.aborted, false);
  fire();
  const result = await completion;
  assert.equal(result.staticStatus, "pending");
  assert.equal(result.rConsoleStaticUnavailableReason, "analysis-limit");
  assert.equal(result.isIncomplete, true);
  assert.deepEqual(result.items, []);
  assert.equal(liveBindings.signal.aborted, true, "deadline releases outstanding binding readers");
  assert.equal(cancelled, 1);
  resolveSlow({ status: "resolved", completion: { items: [{ label: "stale" }] } });
  await Promise.resolve();
  assert.deepEqual(result.items, [], "a late reply cannot resurrect a timed-out request");
});

test("cancelling a static completion settles without waiting for the deadline", async t => {
  let fire, liveBindings;
  t.mock.method(global, "setTimeout", callback => { fire = callback; return { mocked: true }; });
  t.mock.method(global, "clearTimeout", () => {});
  const controller = new AbortController();
  const provider = {
    provideStaticCompletion({ bindings }) {
      liveBindings = bindings;
      return new Promise(() => {});
    },
  };
  const completion = requestStaticCompletion(provider, request(controller.signal));
  await Promise.resolve();
  controller.abort();
  const result = await completion;
  assert.equal(result.staticStatus, "pending");
  assert.equal(result.rConsoleStaticUnavailableReason, "analysis-pending");
  assert.equal(liveBindings.signal.aborted, true);
  fire();
  assert.equal(result.isIncomplete, true);
});

test("successful static completion resolves normally before the deadline", async t => {
  let delay, cleared = 0;
  t.mock.method(global, "setTimeout", (_callback, ms) => { delay = ms; return { mocked: true }; });
  t.mock.method(global, "clearTimeout", () => { cleared++; });
  const expected = [{ label: "Sepal.Length" }];
  const result = await requestStaticCompletion({
    async provideStaticCompletion() { return { status: "resolved", completion: { items: expected } }; },
  }, request());
  assert.equal(delay, 20_000);
  assert.equal(result.staticStatus, "resolved");
  assert.deepEqual(result.items, expected);
  assert.equal(result.isIncomplete, false);
  assert.equal(cleared, 1);
});
