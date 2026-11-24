const loadSource = require('./load-source.cjs');
const { createGuardedBindingResolver } = loadSource('src/Language/completion/bindings.ts');
const { requestStaticCompletion } = loadSource('src/Language/completion/staticProvider.ts');

// A cold native metadata task can outlive one bounded provider invocation.
// Model a later user request; permanent inference failures still fail assertions.
async function retryStaticCompletion(collect, { attempts = 3, delayMs = 100 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const entries = await collect();
    if (attempt >= attempts || !entries.isIncomplete ||
        !['analysis-pending', 'analysis-limit', 'no-response'].includes(entries.staticUnavailableReason)) return entries;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

function staticFixtureAccess() {
  // These document fixtures have no embedded session. Tests of live binding
  // identity supply their own resolver backed by the native inspector.
  return { bindings: createGuardedBindingResolver(async () => ({ status: 'missing' })) };
}

function staticFixtureProvider(client) {
  return {
    getCallContext: client.getCallContext.bind(client),
    async provideStaticCompletion(request) {
      const outcome = await client.provideStaticCompletion(request);
      if (!outcome.completion) return outcome;
      // The socket test adapter retains LSP's one-based kind values.
      return { ...outcome, completion: { ...outcome.completion, items: outcome.completion.items.map(item => ({
        ...item, kind: item.kind === undefined ? undefined : item.kind - 1,
      })) } };
    },
  };
}

async function completeStatic(client, doc, position, triggerCharacter, contextPosition = position) {
  const input = doc.getText();
  const document = { version: 1, uri: client.inputDocument.uri, ...doc };
  const cursor = input.split('\n').slice(0, contextPosition.line).reduce((offset, line) => offset + line.length + 1, 0) +
    contextPosition.character;
  return requestStaticCompletion(client, { document, input, cursor, position, contextPosition, triggerCharacter,
    requestScope: {}, ...staticFixtureAccess() });
}

module.exports = { retryStaticCompletion, staticFixtureAccess, staticFixtureProvider, completeStatic };
