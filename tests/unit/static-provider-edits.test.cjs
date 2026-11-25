const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadSource = require('../helpers/load-source.cjs');

class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
const vscode = {
  Position, EventEmitter: class {},
  CompletionItemKind: { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Value: 11, Snippet: 14 },
  QuickPickItemKind: { Separator: -1 },
};
const { InputState } = loadSource('src/Terminal/inputState.ts');
const { RTerminal } = loadSource('src/Terminal/rTerminal.ts', { vscode, './rTerminal/lang': {} });
const { provideNativeStaticCompletion } = loadSource('src/Language/completion/staticProvider.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
const pending = () => ({ status: 'pending', reason: 'analysis-pending' });
const resolved = items => ({ status: 'resolved', completion: { items } });

// Exercise provider validation, preview composition and actual terminal insertion.
async function openStaticPicker(t, marked, provide, options = {}) {
  const cursor = marked.indexOf('│'), text = marked.replace('│', '');
  const before = text.slice(0, cursor), lines = text.split('\n');
  const cursorRow = before.split('\n').length - 1;
  const input = { text, lines, textBeforeCursor: before, cursorRow,
    cursorCol: before.split('\n').at(-1).length, currentLine: lines[cursorRow] };
  const picks = [], requests = [], showing = [];
  const { RTermLang } = loadSource('src/Terminal/rTerminal/lang.ts', {
    vscode: { ...vscode, window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createQuickPick: () => {
        let hidden = false;
        const pick = { value: '', items: [], activeItems: [], selectedItems: [],
          onDidChangeValue(fn) { this.change = fn; }, onDidAccept(fn) { this.accept = fn; },
          onDidHide(fn) { this.onHide = fn; }, show() {}, dispose() {},
          hide() { if (!hidden) { hidden = true; this.onHide(); } },
        };
        picks.push(pick);
        return pick;
      },
    } },
    '../../Language/consoleLspClient': { ConsoleLspClient: class {} },
    '../../Language/virtualRDocument': { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({ extensionPath: '', rPath: 'R', env: {},
    getStaticAnalysisEnabled: () => true, requestRuntimeFunctionSource: options.requestSource });
  lang.getOrOpenCompletionDocument = async value => ({ version: 1, getText: () => value,
    uri: { toString: () => 'r-console://provider-edits/console.R' } });
  let acquisitions = 0;
  lang.getCompletionProvider = async () => options.unavailableFirst && ++acquisitions === 1 ? undefined : ({ provideStaticCompletion: request => {
    requests.push(request);
    return provide(request);
  } });
  const terminal = Object.assign(Object.create(RTerminal.prototype), {
    inputState: new InputState(), lang, renderInput() {}, scheduleInlineCompletion() {},
  });
  terminal.inputState.text = text;
  terminal.inputState.cursorPosition = cursor;
  const start = () => {
    const result = lang.handleAutocomplete({ input, force: true, getCurrentInput: () => input,
      getWorkspaceData: () => options.workspace, applyCompletion: selection => terminal.applyCompletion(selection) });
    showing.push(result);
    return result;
  };
  t.after(async () => { lang.cancelCompletion(); for (const pick of picks) pick.hide(); await Promise.all(showing); });
  start();
  await tick();
  return { input, terminal, lang, requests, start,
    get pick() { return picks.at(-1); },
    async type(value) { this.pick.value = value; this.pick.change(value); await tick(); },
    async accept() {
      assert.ok(this.pick.activeItems.length, 'a candidate is available for acceptance');
      this.pick.selectedItems = [this.pick.activeItems[0]];
      this.pick.accept();
      await Promise.all(showing);
    },
    async hide() { this.pick.hide(); await Promise.all(showing); },
  };
}

test('blank expression pickers retain live symbols through preview refinement and acceptance', async t => {
  for (const marked of ['result <- │', '1 + │', 'result <- (│)', 'f <- function() { │}',
    'first <- 1\nresult <- │']) {
    for (const refine of [false, true]) {
      const h = await openStaticPicker(t, marked, async () => resolved([]), {
        workspace: { globalenv: { my_value: { type: 'double' } } },
      });
      assert.ok(h.pick.items.some(item => item.insertText === 'my_value'), marked);
      if (refine) await h.type('my');
      await h.accept();
      assert.equal(h.terminal.inputState.text, marked.replace('│', 'my_value'), marked);
    }
  }
});

test('symbol and argument pickers retry timed-out providers when search grows', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const marked of ['co│', 'f(co│)']) {
    let calls = 0;
    const h = await openStaticPicker(t, marked, async () => ++calls === 1
      ? new Promise(() => {})
      : resolved([{ label: 'column', insertText: 'column', role: 'symbol', kind: 5 }]));
    t.mock.timers.tick(10000);
    await tick();
    assert.ok(h.pick, marked);
    await h.type('colu');
    assert.ok(calls >= 2, 'search must retry after the provider deadline');
    await h.accept();
    assert.equal(h.terminal.inputState.text, marked.startsWith('f(') ? 'f(column)' : 'column');
  }
});

test('growing picker searches recover from provider exceptions and unavailable startup', async t => {
  for (const marked of ['co│', 'f(co│)']) {
    for (const failure of ['throw', 'reject', 'unavailable', 'request-failed', 'document-unavailable']) {
      let calls = 0;
      const h = await openStaticPicker(t, marked, () => {
        if (++calls === 1 && failure !== 'unavailable') {
          if (failure === 'throw') throw new Error('temporary provider failure');
          if (failure === 'reject') return Promise.reject(new Error('temporary provider failure'));
          return { status: 'unresolved', reason: failure };
        }
        return resolved([{ label: 'column', insertText: 'column', role: 'symbol', kind: 5 }]);
      }, { unavailableFirst: failure === 'unavailable' });
      assert.deepEqual(h.pick.items, [], failure);
      await h.type('col');
      assert.equal(calls, failure === 'unavailable' ? 1 : 2, failure);
      await h.accept();
      assert.equal(h.terminal.inputState.text, marked.startsWith('f(') ? 'f(column)' : 'column', failure);
    }
  }
});

test('Quick Pick composes provider edits across prefix growth, shrinking, quoting and multiline suffixes', async t => {
  for (const fixture of [
    { marked: 'factory()[, c│]', query: 'col', insertion: 'umn', expected: 'factory()[, column]' },
    { marked: 'factory()[, colu│]', query: 'co', insertion: 'lumn', expected: 'factory()[, column]' },
    { marked: 'factory()[, c│]', query: 'col', back: 1, insertion: 'lumn', expected: 'factory()[, column]' },
    { marked: 'factory()[, c│olumn]', query: 'col', back: 1, forward: 5,
      insertion: 'lumn', expected: 'factory()[, column]' },
    { marked: 'factory()[, c│]', query: 'col', start: 0, insertion: 'other[, column', expected: 'other[, column]' },
    { marked: 'factory()[1, "a│"]', query: 'a"b', label: 'a"btail', insertion: 'tail',
      expected: 'factory()[1, "a\\"btail"]' },
    { marked: 'factory()[1, "z│"]', query: 'a😀', label: 'a😀tail', insertion: 'tail',
      expected: 'factory()[1, "a😀tail"]' },
    { marked: 'head <- 1\nfactory()[, c│ol\numn]\ntail <- 2', query: 'col', back: 1,
      end: new Position(2, 3), insertion: 'lumn', expected: 'head <- 1\nfactory()[, column]\ntail <- 2' },
    { marked: 'pkg::co│lumn', query: 'column', insertion: 'column', noRange: true, expected: 'pkg::column' },
  ]) {
    const original = fixture.marked.replace('│', '');
    const h = await openStaticPicker(t, fixture.marked, async request => {
      if (request.input === original) return pending();
      const position = request.contextPosition;
      return resolved([{ label: fixture.label ?? 'column', insertText: fixture.insertion,
        role: fixture.noRange ? 'symbol' : 'member', kind: 4,
        ...(fixture.noRange ? {} : { range: {
          start: new Position(position.line, fixture.start ?? position.character - (fixture.back ?? 0)),
          end: fixture.end ?? new Position(position.line, position.character + (fixture.forward ?? 0)),
        } }),
      }]);
    });
    await h.type(fixture.query);
    const selection = h.pick.activeItems[0];
    assert.ok(selection, fixture.marked);
    assert.ok(selection.replaceStart <= h.input.cursorCol, fixture.marked);
    assert.ok(selection.replaceEnd >= h.input.cursorCol, fixture.marked);
    await h.accept();
    assert.equal(h.terminal.inputState.text, fixture.expected, fixture.marked + ' -> ' + fixture.query);
  }
});

test('range-free static value candidates preserve explicit R expressions and snippets on acceptance', async t => {
  for (const [insertText, expected] of [
    ['TRUE', 'TRUE'], ['42L', '42L'], ['letters[1]', 'letters[1]'],
    ['"$1${2:x}"', '"$1${2:x}"'], [{ value: '${1:TRUE}$0' }, 'TRUE'],
  ]) {
    const h = await openStaticPicker(t, 'f(flag = │)', async () => resolved([
      { label: 'choice', role: 'value', kind: 11, insertText },
    ]));
    await h.accept();
    assert.equal(h.terminal.inputState.text, `f(flag = ${expected})`);
  }
});

test('native literal choices preserve quoting and dollar signs after adapter normalization', async t => {
  for (const [marked, expected] of [
    ['f(flag = │)', 'f(flag = "$1${2:x}")'],
    ['f(flag = "│")', 'f(flag = "$1${2:x}")'],
    ["f(flag = '│')", "f(flag = '$1${2:x}')"],
  ]) {
    const h = await openStaticPicker(t, marked, request => provideNativeStaticCompletion(async () => ({ items: [
      { label: '$1${2:x}', kind: 11, detail: 'value for flag', insertText: { value: '$1${2:x}' }, insertTextFormat: 2 },
    ] }), request));
    await h.accept();
    assert.equal(h.terminal.inputState.text, expected, marked);
  }
});

test('closing Quick Pick revokes pending provider capabilities and immediately cancels binding reads', async t => {
  for (const action of ['hide', 'accept']) {
    for (const readBeforeClose of [false, true]) {
      let read, reads = 0;
      const h = await openStaticPicker(t, action === 'accept' ? 'fa│' : 'factory()$│', request => {
        if (readBeforeClose) read = request.bindings.resolve({ name: 'factory', lookup: 'function' });
        return new Promise(() => {});
      }, {
        workspace: { globalenv: { factory: { type: 'closure' } } },
        requestSource: () => { reads++; return new Promise(() => {}); },
      });
      const bindings = h.requests[0].bindings;
      await h[action]();
      assert.equal(bindings.signal.aborted, true, action);
      assert.equal(bindings.isCurrent(), false, action);
      read ??= bindings.resolve({ name: 'factory', lookup: 'function' });
      assert.deepEqual(await Promise.race([read, tick().then(() => 'still pending')]),
        { status: 'unavailable', reason: 'cancelled' }, action);
      assert.equal(reads, Number(readBeforeClose), 'a dismissed provider cannot start another native inspection');
    }
  }
});

test('dismissing a pending refinement cancels its capability', async t => {
  const original = 'factory()$';
  const h = await openStaticPicker(t, original + '│', async request => request.input === original
    ? { status: 'resolved', completion: { items: [{ label: 'alpha', role: 'member', kind: 4 }], isIncomplete: true } }
    : new Promise(() => {}));
  await h.type('al');
  assert.equal(h.requests.length, 2);
  const bindings = h.requests[1].bindings;
  assert.equal(bindings.isCurrent(), true);
  await h.hide();
  assert.equal(bindings.signal.aborted, true);
  assert.equal(bindings.isCurrent(), false);
});

test('clearing or invalidating a pending picker refinement revokes its capability', async t => {
  for (const [original, nextQuery] of [['factory()$', ''], ['obj$', '(']]) {
    let read, reads = 0;
    const h = await openStaticPicker(t, original + '│', async request => {
      if (request.input === original) return { status: 'resolved', completion: {
        items: [{ label: 'alpha', role: 'member', kind: 4 }], isIncomplete: true,
      } };
      read = request.bindings.resolve({ name: 'factory', lookup: 'function' });
      return new Promise(() => {});
    }, { requestSource: () => { reads++; return new Promise(() => {}); } });
    await h.type('al');
    const bindings = h.requests[1].bindings;
    assert.equal(bindings.isCurrent(), true);
    await h.type(nextQuery);
    assert.equal(bindings.signal.aborted, true);
    assert.equal(bindings.isCurrent(), false);
    assert.deepEqual(await Promise.race([read, tick().then(() => 'still pending')]),
      { status: 'unavailable', reason: 'cancelled' });
    assert.deepEqual(await bindings.resolve({ name: 'other', lookup: 'function' }),
      { status: 'unavailable', reason: 'cancelled' });
    assert.equal(reads, 1);
    if (nextQuery === '') {
      await h.accept();
      assert.equal(h.terminal.inputState.text, 'factory()$alpha');
    } else await h.hide();
  }
});

test('an older picker closing cannot cancel a newer provider invocation', async t => {
  const h = await openStaticPicker(t, 'factory()$│', () => new Promise(() => {}));
  h.start();
  await tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].bindings.isCurrent(), false);
  assert.equal(h.requests[1].bindings.isCurrent(), true);
  assert.equal(h.requests[1].bindings.signal.aborted, false);
  await h.hide();
  assert.equal(h.requests[1].bindings.signal.aborted, true);
});

test('clearing a refinement reloads an unfinished baseline with its exact input and edits', async t => {
  for (const finishRefinement of [false, true]) {
    for (const marked of ['factory()$al│', 'head <- 1\nfactory()$al│ + 2', 'factory()[["\\u0061│"]]']) {
      const pendingRequests = [];
      const h = await openStaticPicker(t, marked, request => new Promise(resolve => pendingRequests.push({ request, resolve })));
      await h.type('be');
      assert.equal(pendingRequests.length, 2);
      assert.equal(pendingRequests[0].request.bindings.signal.aborted, true);
      const member = label => resolved([{ label, insertText: label, role: 'member', kind: 4 }]);
      if (finishRefinement) {
        pendingRequests[1].resolve(member('beta'));
        await tick();
      }
      await h.type('');
      assert.equal(pendingRequests.length, 3, 'clearing starts a fresh baseline request');
      assert.equal(pendingRequests[1].request.bindings.signal.aborted, true);
      assert.equal(pendingRequests[2].request.input, h.input.text);
      assert.equal(pendingRequests[2].request.cursor, h.input.textBeforeCursor.length);
      pendingRequests[2].resolve(member('alpha'));
      await tick();
      pendingRequests[0].resolve(member('ancient'));
      pendingRequests[1].resolve(member('beta'));
      await tick();
      assert.deepEqual(h.pick.items.filter(item => 'insertText' in item).map(item => item.insertText), ['alpha']);
      await h.accept();
      assert.equal(h.terminal.inputState.text, marked.replace(/(?:al|\\u0061)│/, 'alpha'), marked);
    }
  }
});

test('clearing preserves a complete baseline and refreshes incomplete or staged suggestions', async t => {
  for (const baseline of ['complete', 'empty', 'incomplete', 'staged']) {
    let initial;
    const h = await openStaticPicker(t, 'al│', async request => {
      if (request.input !== 'al') return pending();
      if (baseline === 'staged') return new Promise(resolve => { initial = resolve; });
      if (baseline === 'empty') return { status: 'resolved-empty', completion: { items: [] } };
      return { status: 'resolved', completion: {
        items: [{ label: 'alpha', insertText: 'alpha', role: 'symbol', kind: 5 }], isIncomplete: baseline === 'incomplete',
      } };
    }, baseline === 'staged' ? { workspace: { globalenv: { already: { type: 'double' } } } } : {});
    await h.type('be');
    const before = h.requests.length;
    await h.type('');
    assert.equal(h.requests.length - before, Number(baseline === 'incomplete' || baseline === 'staged'), baseline);
    if (baseline === 'complete') {
      assert.ok(h.pick.items.some(item => item.insertText === 'alpha'));
    } else if (baseline === 'empty') {
      assert.equal(h.pick.items.length, 0, 'an authoritative empty baseline needs no retry');
    } else if (baseline === 'staged') {
      assert.ok(h.pick.items.some(item => item.insertText === 'already'), 'staged candidates remain usable during reload');
      initial(resolved([{ label: 'alpha', insertText: 'alpha', role: 'symbol', kind: 5 }]));
      await tick();
      assert.ok(h.pick.items.some(item => item.insertText === 'alpha'));
    }
    await h.hide();
  }
});

test('a restored baseline cannot outlive a newer search or a dismissed picker', async t => {
  for (const next of ['be', 'hide']) {
    const waiting = [];
    const h = await openStaticPicker(t, 'factory()$al│', request => new Promise(resolve => waiting.push({ request, resolve })));
    await h.type('be');
    await h.type('');
    const restored = waiting[2];
    if (next === 'hide') await h.hide();
    else {
      await h.type(next);
      waiting[3].resolve(resolved([{ label: 'beta', insertText: 'beta', role: 'member', kind: 4 }]));
      await tick();
    }
    assert.equal(restored.request.bindings.signal.aborted, true);
    restored.resolve(resolved([{ label: 'alpha', insertText: 'alpha', role: 'member', kind: 4 }]));
    await tick();
    assert.ok(!h.pick.items.some(item => item.insertText === 'alpha'));
    if (next !== 'hide') await h.accept();
  }
});
