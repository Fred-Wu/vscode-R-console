const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadSource = require('../helpers/load-source.cjs');

function harness(t) {
  const logs = [];
  const vscode = {
    Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
    EventEmitter: class {},
    CompletionItemKind: { Text: 0, Method: 1, Function: 2, Field: 4, Variable: 5, Snippet: 14 },
    QuickPickItemKind: { Separator: -1 },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => ({
      completionUI: 'inline', 'inlineCompletion.trigger': 'typing', 'completion.staticAnalysis': true,
    })[key] ?? fallback }) },
    window: { createOutputChannel: () => ({ appendLine: line => logs.push(line), dispose() {} }) },
  };
  // Share the production diagnostics state across both separately bundled hosts.
  const diagnostics = loadSource('src/Language/completion/outputChannel.ts', { vscode });
  const { RTermLang } = loadSource('src/Terminal/rTerminal/lang.ts', {
    vscode,
    '../../Language/completion/outputChannel': diagnostics,
    '../../Language/consoleLspClient': { ConsoleLspClient: class {} },
    '../../Language/virtualRDocument': { VirtualRDocument: class {} },
  });
  const { RTerminal } = loadSource('src/Terminal/rTerminal.ts', {
    vscode, './rTerminal/lang': {}, './rTerminal/runtime': { getCachedRuntimeWorkspaceData: () => undefined },
    '../Language/completion/outputChannel': diagnostics,
  });
  const { provideNativeStaticCompletion } = loadSource('src/Language/completion/staticProvider.ts');
  const lang = new RTermLang({ extensionPath: '', rPath: 'R', env: {}, getStaticAnalysisEnabled: () => true });
  let nativeCalls = 0, requests = 0;
  const provider = { provideStaticCompletion: request => {
    requests++;
    return provideNativeStaticCompletion(async () => {
      nativeCalls++;
      return { items: [], rConsoleArgumentsResolved: false, rConsoleStaticUnavailableReason: 'method-arguments-unavailable' };
    }, request);
  } };
  lang.getCompletionProvider = async () => provider;
  lang.getOrOpenCompletionDocument = async text => ({ version: 1, getText: () => text });
  let input, pending;
  const handle = lang.handleAutocomplete.bind(lang);
  lang.handleAutocomplete = (...args) => pending = handle(...args);
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    lang, mode: 'ready', promptReady: true, inputState: {},
    getInputSnapshot: () => input, runtimeHost: () => ({}), renderInput() {},
    inlineCompletion: { token: 0, visible: false, setQuery() {}, clear() {},
      invalidate() { return ++this.token; }, set() { return false; } },
  });
  t.after(() => { clearTimeout(terminal.inlineCompletionTimer); lang.cancelCompletion(); });
  return { logs, provider, get requests() { return requests; }, get nativeCalls() { return nativeCalls; },
    async type(before, suffix = '') {
      const text = before + suffix, lines = text.split('\n'), prior = before.split('\n');
      input = { text, lines, textBeforeCursor: before, cursorRow: prior.length - 1,
        cursorCol: prior.at(-1).length, currentLine: lines[prior.length - 1] };
      terminal.inputState.text = text;
      terminal.scheduleInlineCompletion();
      terminal.requestInlineCompletion(false);
      await pending;
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('unsupported literal and comment typing remains quiet through scheduling and collection', async t => {
  const h = harness(t);
  for (const prefix of ['g', 'gg', 'ggp', 'ggpl', 'ggplo', 'ggplot', 'ggplot2']) {
    await h.type('renv::install("' + prefix, '")');
    await h.type('# ' + prefix);
  }
  assert.equal(h.requests, 14, 'the general provider still receives unclassified contexts');
  assert.equal(h.nativeCalls, 0, 'the native adapter declines these contexts before LSP');
  assert.deepEqual(h.logs, []);
});

test('method diagnostics retain one identity across scheduling and result delivery', async t => {
  const h = harness(t);
  for (const prefix of ['', 'co', 'col', 'column']) await h.type('obj$fun(' + prefix);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /method's arguments/);
  await h.type('other$fun(');
  assert.equal(h.logs.length, 2, 'a different target has its own diagnostic');
  h.provider.provideStaticCompletion = async () => ({ status: 'unresolved', reason: 'request-failed' });
  await h.type('other$fun(co');
  assert.equal(h.logs.length, 3, 'a changed failure remains visible');
  assert.match(h.logs[2], /request failed/);
});

test('generic provider failures deduplicate growing literal prefixes without logging input', async t => {
  const h = harness(t);
  h.provider.provideStaticCompletion = async () => ({ status: 'pending', reason: 'no-response' });
  for (const prefix of ['secret', 'secret2', 'secret23']) await h.type('fn("' + prefix, '")');
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /returned no completion result/);
  assert.doesNotMatch(h.logs[0], /secret|fn\(/);
});
