const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { LibraryPathEntryMonitor } = require('../helpers/load-source.cjs')('src/Language/libraryPathEntryMonitor.ts');

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-entry-')));
  const watchers = new Map(), events = [], logs = [], watchCounts = new Map();
  const io = {
    lstatSync: fs.lstatSync,
    watch(parent, options, callback) {
      assert.equal(options.recursive, false);
      assert.equal(options.persistent, false);
      assert.equal(options.encoding, 'utf8');
      assert.ok(fs.lstatSync(parent).isDirectory());
      assert.ok(!fs.lstatSync(parent).isSymbolicLink());
      const watcher = new EventEmitter();
      watcher.close = () => { watcher.closed = true; watchers.delete(parent); };
      watcher.emitChange = (name, type = 'rename') => callback(type, name);
      assert.equal(watchers.has(parent), false, `only one watcher per parent: ${parent}`);
      watchCounts.set(parent, (watchCounts.get(parent) ?? 0) + 1);
      watchers.set(parent, watcher);
      return watcher;
    },
  };
  const monitor = new LibraryPathEntryMonitor(event => events.push(event), message => logs.push(message), io);
  t.after(() => { monitor.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
  const notify = (entry, name = path.basename(entry)) => {
    const parent = path.dirname(entry);
    assert.ok(watchers.get(parent), `missing parent-entry watcher: ${parent}`);
    watchers.get(parent).emitChange(name);
  };
  return { base, monitor, events, logs, watchers, watchCounts, notify };
}

const linkKind = process.platform === 'win32' ? 'junction' : 'dir';
const unlinkDirectoryLink = link => fs.unlinkSync(link);

test('configured symlink alias reports retargeting but never subscribes to either target as a discovered root', t => {
  const { base, monitor, events, watchers, notify } = fixture(t);
  const first = path.join(base, 'first'), second = path.join(base, 'second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  const alias = path.join(base, 'renv-library');
  fs.symlinkSync(first, alias, linkKind);
  monitor.add(alias, first);
  assert.equal(events.length, 0);
  unlinkDirectoryLink(alias);
  fs.symlinkSync(second, alias, linkKind);
  notify(alias);
  assert.deepEqual(events.map(e => [e.kind, e.entry, e.pinnedRoot, e.state]),
    [['alias', alias, first, 'link']]);
  assert.equal(watchers.has(second), false, 'do not watch a retargeted alias destination');
  assert.equal(watchers.has(first), false, 'entry watcher must not recurse into package/cache targets');
  notify(alias);
  assert.equal(events.length, 1, 'duplicate notifications must not produce repeated logs');
});

test('replacing a pinned physical root with a link is reported through its parent watcher', t => {
  const { base, monitor, events, watchers, notify } = fixture(t);
  const root = path.join(base, 'physical-library');
  const external = path.join(base, 'external');
  fs.mkdirSync(root); fs.mkdirSync(external);
  monitor.add(root, root);
  fs.renameSync(root, `${root}-old`);
  fs.symlinkSync(external, root, linkKind);
  notify(root);
  assert.deepEqual(events.map(e => [e.kind, e.entry, e.state]), [['physical', root, 'link']]);
  assert.equal(watchers.has(root), false);
  assert.equal(watchers.has(external), false);
});

test('replacing an ancestor with a link is reported without following it', t => {
  const { base, monitor, events, watchers, notify } = fixture(t);
  const ancestor = path.join(base, 'parent');
  const root = path.join(ancestor, 'library');
  const external = path.join(base, 'external');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(external, 'library'), { recursive: true });
  monitor.add(root, root);
  fs.renameSync(ancestor, `${ancestor}-old`);
  fs.symlinkSync(external, ancestor, linkKind);
  notify(ancestor);
  assert.ok(events.some(e => e.kind === 'physical' && e.entry === ancestor && e.state === 'link'));
  assert.equal(watchers.has(ancestor), false, 'do not follow replacement ancestor links');
  assert.equal(watchers.has(external), false);
});

test('root-entry notifications reactivate monitoring of newly created ordinary ancestor components', t => {
  const { base, monitor, events, watchers, notify } = fixture(t);
  const ancestor = path.join(base, 'new-parent'), root = path.join(ancestor, 'library');
  monitor.add(root, root);
  assert.equal(monitor.hasPhysicalEntryWatch(root), true);
  assert.equal(watchers.has(ancestor), false);
  fs.mkdirSync(ancestor);
  notify(ancestor);
  assert.equal(watchers.has(ancestor), true, 'new ancestor receives a filtered entry watcher');
  fs.mkdirSync(root);
  notify(root);
  assert.ok(events.some(e => e.entry === root && e.state === 'directory'));
});

test('unrelated events, filename-less events, and package metadata touches do not generate false replacement events', t => {
  const { base, monitor, events, watchers, notify, watchCounts } = fixture(t);
  const root = path.join(base, 'library');
  fs.mkdirSync(root);
  monitor.add(root, root);
  fs.mkdirSync(path.join(root, 'package'));
  notify(root, 'unrelated');
  watchers.get(base).emitChange(undefined, 'change');
  notify(root);
  assert.deepEqual(events, []);
  monitor.add(root, root);
  assert.equal(watchCounts.get(base), 1, 'unchanged config does not re-arm watchers');
});

test('root and aliases share ancestor watchers and cleanup removes all subscriptions', t => {
  const { base, monitor, watchers, events } = fixture(t);
  const first = path.join(base, 'first'), second = path.join(base, 'second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  monitor.add(first, first);
  monitor.add(second, second);
  assert.ok(watchers.has(base));
  const count = watchers.size;
  monitor.remove(first);
  assert.equal(watchers.size, count, 'common ancestors remain attached to the other library');
  monitor.remove(second);
  assert.equal(monitor.hasPhysicalEntryWatch(second), false);
  assert.equal(watchers.size, 0);
  monitor.dispose();
  assert.deepEqual(events, []);
});

test('ancestor watcher errors close that watcher without scheduling polling or blocking other libraries', t => {
  const { base, monitor, watchers, logs, events } = fixture(t);
  const root = path.join(base, 'library'); fs.mkdirSync(root);
  monitor.add(root, root);
  const watch = watchers.get(base);
  watch.emit('error', new Error('notification unavailable'));
  assert.equal(watchers.has(base), false);
  assert.ok(logs.some(line => line.includes('Root-entry watcher unavailable')));
  assert.deepEqual(events, []);
});
