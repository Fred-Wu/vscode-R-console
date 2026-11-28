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

test("native static completion has a 20-second default and a bounded retryable deadline", async () => {
  let liveBindings, resolveSlow;
  const provider = {
    provideStaticCompletion({ bindings }) {
      liveBindings = bindings;
      return new Promise(resolve => { resolveSlow = resolve; });
    },
  };
  // Test the same timeout mechanism without replacing Node's global timers,
  // which can interfere with the test runner on other platforms.
  assert.equal(STATIC_COMPLETION_REQUEST_TIMEOUT_MS, 20_000);
  const result = await requestStaticCompletion(provider, request(), 15);
  assert.equal(result.staticStatus, "pending");
  assert.equal(result.rConsoleStaticUnavailableReason, "analysis-limit");
  assert.equal(result.isIncomplete, true);
  assert.deepEqual(result.items, []);
  assert.equal(liveBindings.signal.aborted, true, "deadline releases outstanding binding readers");
  resolveSlow({ status: "resolved", completion: { items: [{ label: "stale" }] } });
  await Promise.resolve();
  assert.deepEqual(result.items, [], "late replies cannot republish a timed-out request");
});

test("cancellation settles a static completion independently of the deadline", async () => {
  let liveBindings;
  const controller = new AbortController();
  const provider = {
    provideStaticCompletion({ bindings }) {
      liveBindings = bindings;
      return new Promise(() => {});
    },
  };
  const completion = requestStaticCompletion(provider, request(controller.signal), 200);
  await Promise.resolve();
  controller.abort();
  const result = await completion;
  assert.equal(result.staticStatus, "pending");
  assert.equal(result.rConsoleStaticUnavailableReason, "analysis-pending");
  assert.equal(result.isIncomplete, true);
  assert.equal(liveBindings.signal.aborted, true);
});

test("successful static completion resolves before a shortened test deadline", async () => {
  const expected = [{ label: "Sepal.Length" }];
  const result = await requestStaticCompletion({
    async provideStaticCompletion() { return { status: "resolved", completion: { items: expected } }; },
  }, request(), 200);
  assert.equal(result.staticStatus, "resolved");
  assert.deepEqual(result.items, expected);
  assert.equal(result.isIncomplete, false);
});
