const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadSource = require('../helpers/load-source.cjs');
const vscode = { QuickPickItemKind: { Separator: -1 }, CompletionItemKind: { Text: 0, Function: 2, Field: 4, Variable: 5 } };
const completion = loadSource('src/Language/completion.ts', { vscode });
const tick = () => new Promise(resolve => setImmediate(resolve));
const entries = (labels, incomplete = false) => Object.assign(labels.map(label => ({
  label, insertText: label, source: 'lsp', kind: 5,
})), { isIncomplete: incomplete });

async function openPicker(t, text, initialEntries, collect, delayedEntries, cursor = text.length) {
  let change, hide;
  const pick = { items: [], value: '', activeItems: [],
    onDidChangeValue(fn) { change = fn; }, onDidAccept() {}, onDidHide(fn) { hide = fn; },
    show() {}, hide() { hide(); }, dispose() {} };
  const { pickCompletion } = loadSource('src/Terminal/rTerminal/completionPicker.ts', {
    vscode: { ...vscode, window: { createQuickPick: () => pick } },
  });
  const context = completion.getStaticFallbackContext(text, cursor) ?? completion.getCompletionContext(text, cursor) ?? {
    kind: 'default', prefix: '', replaceStart: 0, snapshotInput: text, snapshotCursor: text.length,
  };
  const showing = pickCompletion({ context, initialEntries, delayedEntries, force: true, isCurrent: () => true, collect,
    latestInput: { text, currentLine: text, lines: [text], cursorRow: 0, cursorCol: cursor, textBeforeCursor: text.slice(0, cursor) },
  });
  t.after(async () => { pick.hide(); await showing; });
  return { pick, async type(value) { pick.value = value; change(value); await tick(); },
    labels() { return pick.items.filter(item => 'insertText' in item).map(item => item.insertText); } };
}

test('Quick Pick re-queries incomplete results in every completion context', async t => {
  for (const text of ['f(', 'obj$', 'df[[', 'al', 'pkg::']) {
    const calls = [];
    const picker = await openPicker(t, text, entries(['alpha'], true), async context => {
      calls.push(context.prefix);
      return context.prefix === 'al' ? entries(['alpine']) : entries(['alpha'], true);
    });
    await picker.type('a');
    await picker.type('al');
    assert.deepEqual(calls, ['a', 'al'], text);
    assert.ok(picker.labels().includes('alpine'), text);
  }
});

test('member Quick Pick ranks the console prefix on initial, delayed and cleared results', async t => {
  for (const operator of ['$', '@']) {
    for (const delayed of [false, true]) {
      const candidates = entries(['alphabetagamma', 'beta']);
      const picker = await openPicker(t, `obj${operator}beta`, delayed ? [] : candidates,
        async () => candidates, delayed ? Promise.resolve(candidates) : undefined);
      await tick();
      assert.deepEqual(picker.labels(), ['beta', 'alphabetagamma']);
      assert.equal(picker.pick.activeItems[0].insertText, 'beta');
      await picker.type('alphabetagamma');
      assert.deepEqual(picker.labels(), ['alphabetagamma']);
      await picker.type('');
      assert.deepEqual(picker.labels(), ['beta', 'alphabetagamma']);
      assert.equal(picker.pick.activeItems[0].insertText, 'beta');
    }
  }
});

test('member Quick Pick keeps exact matches selected across field and function groups', async t => {
  for (const operator of ['$', '@']) {
    for (const delayed of [false, true]) {
      for (const exactKind of [vscode.CompletionItemKind.Field, vscode.CompletionItemKind.Function]) {
        const fuzzyKind = exactKind === vscode.CompletionItemKind.Field
          ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Field;
        const candidates = [
          { label: 'alphabetagamma', insertText: 'alphabetagamma', source: 'session', kind: fuzzyKind },
          { label: 'beta', insertText: exactKind === 2 ? 'beta()' : 'beta', source: 'session', kind: exactKind },
        ];
        const expected = candidates[1].insertText;
        const picker = await openPicker(t, `obj${operator}beta`, delayed ? [] : candidates,
          async () => candidates, delayed ? Promise.resolve(candidates) : undefined);
        await tick();
        assert.equal(picker.labels()[0], expected);
        assert.equal(picker.pick.activeItems[0].insertText, expected);
        await picker.type('alphabetagamma');
        assert.equal(picker.pick.activeItems[0].insertText, 'alphabetagamma');
        await picker.type('');
        assert.equal(picker.labels()[0], expected);
        assert.equal(picker.pick.activeItems[0].insertText, expected);
      }
    }
  }
});

test('member groups preserve the strongest match across kinds in both completion UIs', async t => {
  for (const operator of ['$', '@']) {
    for (const [field, callable, expected] of [
      ['beta', 'BETA', 'beta'],
      ['BETA', 'beta', 'beta()'],
      ['alphabetagamma', 'betaMore', 'betaMore()'],
      ['betaMore', 'alphabetagamma', 'betaMore'],
    ]) {
      const text = `obj${operator}beta`;
      const context = completion.getCompletionContext(text, text.length);
      const candidates = [
        { label: field, insertText: field, source: 'session', kind: vscode.CompletionItemKind.Field },
        { label: callable, insertText: callable + '()', source: 'session', kind: vscode.CompletionItemKind.Function },
      ];
      const inline = completion.toCompletionQuickPickItems(
        completion.rankCompletionEntries(candidates, context.prefix, context), context);
      assert.equal(inline.find(item => 'insertText' in item).insertText, expected);
      const picker = await openPicker(t, text, [], async () => candidates, Promise.resolve(candidates));
      await tick();
      assert.equal(picker.pick.activeItems[0].insertText, expected);
      await picker.type('beta');
      assert.equal(picker.pick.activeItems[0].insertText, expected);
      await picker.type('');
      assert.equal(picker.pick.activeItems[0].insertText, expected);
    }
  }
});

test('package invalidation closes Quick Pick and discards delayed suggestions', async () => {
  let onHide, resolveEntries;
  let disposed = false;
  const controller = new AbortController();
  const pick = {
    items: [], value: '', activeItems: [],
    onDidChangeValue() {}, onDidAccept() {}, onDidHide(fn) { onHide = fn; },
    show() {}, hide() { onHide(); }, dispose() { disposed = true; },
  };
  const { pickCompletion } = loadSource('src/Terminal/rTerminal/completionPicker.ts', {
    vscode: { ...vscode, window: { createQuickPick: () => pick } },
  });
  const text = 'pkg::';
  const showing = pickCompletion({
    context: completion.getCompletionContext(text, text.length),
    latestInput: { text, currentLine: text, lines: [text], cursorRow: 0, cursorCol: text.length, textBeforeCursor: text },
    initialEntries: entries(['oldExport']),
    delayedEntries: new Promise(resolve => { resolveEntries = resolve; }),
    force: true, isCurrent: () => !controller.signal.aborted,
    collect: async () => entries([]), signal: controller.signal,
  });
  controller.abort();
  assert.equal(await showing, undefined);
  assert.equal(disposed, true);
  resolveEntries(entries(['lateExport']));
  await tick();
  assert.ok(!pick.items.some(item => item.label === 'lateExport'));
});

test('typing in a pending bracket picker publishes native columns before LSP startup', async t => {
  let change, hide, releaseServer;
  const startup = new Promise(resolve => { releaseServer = resolve; });
  const nativeRequests = [];
  const pick = { items: [], value: '', activeItems: [], selectedItems: [],
    onDidChangeValue(fn) { change = fn; }, onDidAccept() {}, onDidHide(fn) { hide = fn; },
    show() {}, hide() { hide(); }, dispose() {} };
  const { RTermLang } = loadSource('src/Terminal/rTerminal/lang.ts', {
    vscode: { ...vscode, window: { createQuickPick: () => pick },
      Position: class { constructor(line, character) { Object.assign(this, { line, character }); } } },
    '../../Language/consoleLspClient': { ConsoleLspClient: class {} },
    '../../Language/virtualRDocument': { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({ extensionPath: '', rPath: 'R', env: {},
    getStaticAnalysisEnabled: () => false,
    requestRuntimeMemberCompletions: () => new Promise(resolve => nativeRequests.push(resolve)),
  });
  lang.ensureConsoleLspStarted = () => startup;
  lang.getOrOpenCompletionDocument = async text => ({ getText: () => text });
  const text = 'DT[,';
  const input = { text, currentLine: text, lines: [text], cursorRow: 0,
    cursorCol: text.length, textBeforeCursor: text };
  const showing = lang.handleAutocomplete({ input, force: true,
    getCurrentInput: () => input, getWorkspaceData: () => undefined, applyCompletion() {} });
  t.after(async () => { lang.cancelCompletion(); releaseServer(undefined); await showing; });
  await tick();
  pick.value = 'keyb'; change(pick.value);
  await tick();
  assert.equal(nativeRequests.length, 2);
  for (const resolve of nativeRequests) {
    resolve({ status: 'available', names: ['keyboard'], bracketKind: 'data.table' });
  }
  await tick();
  const labels = () => pick.items.filter(item => 'insertText' in item).map(item => item.insertText);
  assert.deepEqual(labels(), ['keyboard'], 'refining the picker must not block native columns on LSP');
  releaseServer({ provideCompletionItems: async () => ({ rConsoleRuntimeOnly: true, items: [
    { label: 'keyby', insertText: 'keyby = ', kind: 5, detail: 'parameter',
      data: { type: 'subscript_parameter' } },
  ] }) });
  await tick();
  assert.deepEqual(labels().sort(), ['keyboard', 'keyby = ']);
});

test('refined staged results cannot replace newer queries or their final merge', async t => {
  const requests = new Map();
  const picker = await openPicker(t, 'df[,', [], (context, text, lines, cursor, stage) =>
    new Promise(resolve => requests.set(context.prefix, { stage, resolve, cursor })));
  await picker.type('a');
  await picker.type('b');
  requests.get('a').stage(entries(['betaStale']));
  assert.deepEqual(picker.labels(), [], 'superseded staged reply is ignored');
  const current = requests.get('b');
  current.stage(entries(['beta']).map(entry => ({ ...entry, replaceEnd: current.cursor })));
  assert.deepEqual(picker.labels(), ['beta']);
  assert.equal(picker.pick.items.find(item => 'insertText' in item).replaceEnd, 4,
    'staged edits target the console input, not the longer picker preview');
  current.resolve(entries(['beta', 'bravo']));
  await tick();
  current.stage(entries(['betaOld']));
  requests.get('a').resolve(entries(['betaStale']));
  await tick();
  assert.deepEqual(picker.labels(), ['beta', 'bravo'], 'final merge remains authoritative');
  await picker.type('c');
  const cleared = requests.get('c');
  await picker.type('');
  cleared.stage(entries(['cancelled']));
  cleared.resolve(entries(['cancelled']));
  await tick();
  assert.deepEqual(picker.labels(), [], 'clearing the query cancels staged and final replies');
});

test('Quick Pick changing the first character refreshes a blank-context query', async t => {
  const calls = [];
  const picker = await openPicker(t, '', entries([]), async context => {
    calls.push(context.prefix);
    return entries([context.prefix === 'a' ? 'alpha' : 'beta']);
  });
  await picker.type('a');
  await picker.type('b');
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(picker.labels(), ['beta']);
  await picker.type('be');
  assert.deepEqual(calls, ['a', 'b'], 'complete results support local prefix refinement');
});

test('Quick Pick widening a completed query refreshes missing candidates', async t => {
  for (const text of ['obj$', 'pkg::', 'al']) {
    const calls = [];
    const picker = await openPicker(t, text, entries(['alpha'], true), async context => {
      calls.push(context.prefix);
      return entries(context.prefix === 'al' ? ['alpha'] : ['alpha', 'apricot']);
    });
    await picker.type('al');
    await picker.type('a');
    assert.deepEqual(calls, ['al', 'a'], text);
    assert.ok(picker.labels().includes('apricot'), text);
  }
});

test('clearing Quick Pick invalidates pending member and symbol results', async t => {
  for (const text of ['obj$', 'al']) {
    let resolve;
    const picker = await openPicker(t, text, entries(['alpha'], true),
      () => new Promise(done => { resolve = done; }));
    await picker.type('az');
    await picker.type('');
    resolve(entries(['azure']));
    await tick();
    assert.deepEqual(picker.labels(), ['alpha'], text);
  }
});

test('late incomplete Quick Pick replies fetch the latest typed prefix', async t => {
  const calls = [];
  let resolve;
  const picker = await openPicker(t, '', entries([]), context => {
    calls.push(context.prefix);
    return context.prefix === 'a' ? new Promise(done => { resolve = done; }) : Promise.resolve(entries(['alpine']));
  });
  await picker.type('a');
  await picker.type('al');
  resolve(entries(['alpha'], true));
  await tick();
  assert.deepEqual(calls, ['a', 'al']);
  assert.ok(picker.labels().includes('alpine'));
});

test('a completed wider query is reused while typing a new prefix', async t => {
  const calls = [];
  const picker = await openPicker(t, 'al', entries(['alpha']), async context => {
    calls.push(context.prefix);
    return entries(['alpha', 'apricot']);
  });
  await picker.type('a');
  await picker.type('ap');
  await picker.type('apr');
  assert.deepEqual(calls, ['a']);
  assert.deepEqual(picker.labels(), ['apricot']);
});

test('Quick Pick rejects acceptance after another input line changes', async () => {
  let accept, hide;
  const pick = { items: [], value: '', activeItems: [], selectedItems: [],
    onDidChangeValue() {}, onDidAccept(fn) { accept = fn; }, onDidHide(fn) { hide = fn; },
    show() {}, hide() { hide(); }, dispose() {} };
  const { RTermLang } = loadSource('src/Terminal/rTerminal/lang.ts', {
    vscode: { ...vscode, Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      window: { createQuickPick: () => pick } },
    '../../Language/completion': { ...completion, collectCompletionEntries: async () => entries(['alpha']) },
    '../../Language/consoleLspClient': { ConsoleLspClient: class {} },
    '../../Language/virtualRDocument': { VirtualRDocument: class {} },
  });
  const lang = new RTermLang({ extensionPath: '', rPath: '', env: {}, requestMemberCompletions: async () => [] });
  const text = 'obj <- first\nobj$';
  const input = { text, currentLine: 'obj$', lines: text.split('\n'), cursorRow: 1, cursorCol: 4, textBeforeCursor: text };
  let current = input, applied = false;
  const showing = lang.handleAutocomplete({ input, getCurrentInput: () => current,
    getWorkspaceData: () => undefined, applyCompletion() { applied = true; } });
  await tick();
  current = { ...input, text: text.replace('first', 'other'), lines: ['obj <- other', 'obj$'] };
  pick.selectedItems = pick.items.filter(item => 'insertText' in item);
  accept();
  await showing;
  assert.equal(applied, false);
});

test('Tab and F7 open bracket Quick Pick while native and LSP results are pending', async () => {
  for (const force of [false, true]) {
    let hide, releaseNative, releaseServer, shown = false;
    const pick = { items: [], value: '', activeItems: [],
      onDidChangeValue() {}, onDidAccept() {}, onDidHide(fn) { hide = fn; },
      show() { shown = true; }, hide() { hide?.(); }, dispose() {} };
    const native = new Promise(resolve => { releaseNative = resolve; });
    const server = new Promise(resolve => { releaseServer = resolve; });
    const { RTermLang } = loadSource('src/Terminal/rTerminal/lang.ts', {
      vscode: { ...vscode, Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
        window: { createQuickPick: () => pick } },
      '../../Language/consoleLspClient': { ConsoleLspClient: class {} },
      '../../Language/virtualRDocument': { VirtualRDocument: class {} },
    });
    const lang = new RTermLang({ extensionPath: '', rPath: '', env: {},
      getStaticAnalysisEnabled: () => false,
      requestRuntimeMemberCompletions: () => native });
    lang.ensureConsoleLspStarted = () => server;
    lang.getOrOpenCompletionDocument = async text => ({ getText: () => text });
    const text = 'DT[, key';
    const input = { text, currentLine: text, lines: [text], cursorRow: 0,
      cursorCol: text.length, textBeforeCursor: text };
    const showing = lang.handleAutocomplete({ input, force, getCurrentInput: () => input,
      getWorkspaceData: () => undefined, applyCompletion() {} });
    try {
      await tick();
      assert.equal(shown, true, `force=${force}: picker opens before either result`);
      releaseNative({ status: 'available', names: ['keyboard'], bracketKind: 'data.table' });
      await tick();
      assert.deepEqual(pick.items.filter(item => 'insertText' in item).map(item => item.insertText), ['keyboard']);
      releaseServer({ provideCompletionItems: async () => ({ items: [
        { label: 'keyby', insertText: 'keyby = ', kind: 5,
          detail: 'parameter', data: { type: 'subscript_parameter' } },
      ] }) });
      await tick();
      assert.deepEqual(pick.items.filter(item => 'insertText' in item).map(item => item.insertText).sort(),
        ['keyboard', 'keyby = ']);
    } finally {
      pick.hide();
      releaseNative(undefined);
      releaseServer(undefined);
      await showing;
    }
  }
});

test('an authoritative empty delayed response clears staged Quick Pick entries', async t => {
  let resolve;
  const delayed = new Promise(done => { resolve = done; });
  const picker = await openPicker(t, 'obj$', entries(['stale']), async () => entries([]), delayed);
  assert.deepEqual(picker.labels(), ['stale']);
  resolve(entries([]));
  await tick();
  assert.deepEqual(picker.labels(), []);
});

test('refined Quick Pick replies replace stale candidates and their edits', async t => {
  for (const reply of [[], [{ label: 'alpha', insertText: 'alpha()', source: 'lsp', kind: 5, replaceEnd: 2 }]]) {
    const picker = await openPicker(t, 'a', entries(['alpha'], true), async () => reply);
    await picker.type('al');
    assert.deepEqual(picker.labels(), reply.map(entry => entry.insertText));
    if (reply.length) {
      assert.equal(picker.pick.items.find(item => 'insertText' in item).replaceEnd, 1,
        'the refreshed edit is rebased from the preview onto the original input');
    }
  }
});

test('Quick Pick refreshes ambient symbols when an empty contextual slot becomes typed', async t => {
  for (const text of ['lst[[', 'lst[', 'fun(', 'fun(arg = ', 'with(lst, ']) {
    const session = { globalenv: { index: { type: 'character' } } };
    const context = completion.getCompletionContext(text, text.length);
    const initial = await completion.collectCompletionEntries(context, undefined, undefined, session, []);
    const calls = [];
    const picker = await openPicker(t, text, initial, async next => {
      calls.push(next.prefix);
      return completion.collectCompletionEntries(next, undefined, undefined, session, []);
    });
    assert.deepEqual(picker.labels(), [], text);
    await picker.type('i');
    assert.deepEqual(picker.labels(), ['index'], text);
    await picker.type('in');
    assert.deepEqual(calls, ['i'], text);
    await picker.type('');
    assert.deepEqual(picker.labels(), [], text);
  }
});

test('Quick Pick preserves namespace groups and ordering while refining and clearing', async t => {
  const candidates = [['setDT', 2], ['setZ', 5], ['setattr', 2], ['setAlpha', 5]]
    .map(([label, kind]) => ({ label, kind, source: 'lsp', insertText: label }));
  for (const operator of ['::', ':::']) {
    const picker = await openPicker(t, `pkg${operator}`, candidates, async () => candidates);
    for (const query of ['', 'set', 'seta', '']) {
      await picker.type(query);
      assert.deepEqual(picker.pick.items.map(item => item.insertText ?? item.label),
        query === 'seta' ? ['Functions', 'setattr', 'Variables', 'setAlpha'] :
          ['Functions', 'setattr', 'setDT', 'Variables', 'setAlpha', 'setZ'], query);
    }
  }
});


test('quoted member picker refinements preserve R spelling and rebase edits', async t => {
  for (const receiver of ['obj', 'make_data()']) {
    for (const query of ['od', 'odd field', 'odd`field', 'odd\\field']) {
      const text = receiver + '$`oddold`';
      const cursor = (receiver + '$`odd').length;
      let requested;
      const picker = await openPicker(t, text, entries(['odd field'], true), async (context, preview, lines, cursorCol) => {
        requested = { context, preview, cursorCol };
        return [{label: query, insertText: '`odd field`', source: 'lsp', kind: 4,
          replaceStart: context.replaceStart, replaceEnd: context.replaceEnd}];
      }, undefined, cursor);
      await picker.type(query);
      assert.equal(requested?.context.kind, 'member', query);
      assert.equal(requested.context.prefix, query);
      assert.equal(requested.context.staticFallback === true, receiver === 'make_data()');
      assert.equal(requested.preview[requested.context.replaceStart], '`');
      const pick = picker.pick.items.find(item => 'insertText' in item);
      assert.ok(pick, query);
      assert.equal(text.slice(0, pick.replaceStart) + pick.insertText + text.slice(pick.replaceEnd ?? cursor),
        receiver + '$`odd field`');
    }
  }
});
