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

module.exports = { retryStaticCompletion };
