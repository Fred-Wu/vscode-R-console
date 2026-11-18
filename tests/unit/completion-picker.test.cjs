const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadSource = require('../helpers/load-source.cjs');
const vscode = { QuickPickItemKind: { Separator: -1 }, CompletionItemKind: { Text: 0, Function: 2, Field: 4, Variable: 5 } };
const completion = loadSource('src/Language/completion.ts', { vscode });
const tick = () => new Promise(resolve => setImmediate(resolve));
const entries = (labels, incomplete = false) => Object.assign(labels.map(label => ({
  label, insertText: label, source: 'lsp', kind: 5,
})), { isIncomplete: incomplete });

async function openPicker(t, text, initialEntries, collect, delayedEntries) {
  let change, hide;
  const pick = { items: [], value: '', activeItems: [],
    onDidChangeValue(fn) { change = fn; }, onDidAccept() {}, onDidHide(fn) { hide = fn; },
    show() {}, hide() { hide(); }, dispose() {} };
  const { pickCompletion } = loadSource('src/Terminal/rTerminal/completionPicker.ts', {
    vscode: { ...vscode, window: { createQuickPick: () => pick } },
  });
  const context = completion.getCompletionContext(text, text.length) ?? {
    kind: 'default', prefix: '', replaceStart: 0, snapshotInput: text, snapshotCursor: text.length,
  };
  const showing = pickCompletion({ context, initialEntries, delayedEntries, force: true, isCurrent: () => true, collect,
    latestInput: { text, currentLine: text, lines: [text], cursorRow: 0, cursorCol: text.length, textBeforeCursor: text },
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
