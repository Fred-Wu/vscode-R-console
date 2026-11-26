const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { LibraryPathEntryMonitor } = require('../helpers/load-source.cjs')('src/Language/libraryPathEntryMonitor.ts');

function fixture(t, { failures = new Map(), clock = fakeClock(), validate } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-entry-')));
  const watchers = new Map(), events = [], logs = [], watchCounts = new Map(), attempts = new Map();
  const io = {
    lstatSync: fs.lstatSync,
    watch(parent, options, callback) {
      assert.equal(options.recursive, false);
      assert.equal(options.persistent, false);
      assert.equal(options.encoding, 'utf8');
      attempts.set(parent, (attempts.get(parent) ?? 0) + 1);
      const remaining = failures.get(parent) ?? 0;
      if (remaining > 0) {
        failures.set(parent, remaining - 1);
        throw new Error('temporarily unavailable');
      }
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
  const monitor = new LibraryPathEntryMonitor(event => events.push(event), message => logs.push(message),
    io, validate ?? (() => true), clock);
  t.after(() => { monitor.dispose(); fs.rmSync(base, { recursive: true, force: true }); });
  const notify = (entry, name = path.basename(entry)) => {
    const parent = path.dirname(entry);
    assert.ok(watchers.get(parent), `missing parent-entry watcher: ${parent}`);
    watchers.get(parent).emitChange(name);
  };
  return { base, monitor, events, logs, watchers, watchCounts, attempts, clock, failures, notify };
}

function fakeClock() {
  let now = 0, sequence = 0;
  const tasks = new Map();
  const clock = {
    now: () => now,
    after(callback, delay) {
      const token = { id: ++sequence, unref() {} };
      tasks.set(token, { due: now + delay, callback });
      return token;
    },
    cancel(token) { tasks.delete(token); },
    pending: () => tasks.size,
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...tasks].sort((a, b) => a[1].due - b[1].due)
          .find(([, task]) => task.due <= target);
        if (!due) break;
        now = due[1].due;
        tasks.delete(due[0]);
        due[1].callback();
      }
      now = target;
    },
  };
  return clock;
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

test('a failed parent watcher keeps healthy watchers, then recovers on the first scheduled attempt', t => {
  const { base, monitor, watchers, logs, clock, attempts } = fixture(t);
  const root = path.join(base, 'library'); fs.mkdirSync(root);
  monitor.add(root, root);
  const ancestor = watchers.get(path.dirname(base));
  const watch = watchers.get(base);
  watch.emit('error', new Error('notification unavailable'));
  assert.equal(watchers.has(base), false);
  assert.equal(monitor.hasPhysicalEntryWatch(root), false,
    'a watcher of the grandparent does not cover the library entry');
  assert.equal(monitor.hasPhysicalEntryRecovery(root), true);
  assert.equal(watchers.get(path.dirname(base)), ancestor);
  assert.equal(clock.pending(), 1);
  assert.equal(attempts.get(base), 1);
  clock.advance(1000);
  assert.equal(attempts.get(base), 2);
  assert.equal(monitor.hasPhysicalEntryWatch(root), true);
  assert.equal(monitor.hasPhysicalEntryRecovery(root), false);
  assert.equal(clock.pending(), 0);
  assert.equal(logs.filter(line => line.includes('Monitoring degraded:')).length, 1);
  assert.equal(logs.filter(line => line.includes('Monitoring restored:')).length, 1);
});

test('five automatic retries are bounded; later relevant events allow a recovery attempt after ten seconds', t => {
  const failures = new Map();
  const f = fixture(t, { failures });
  const library = path.join(f.base, 'library'); fs.mkdirSync(library);
  // One initial failed watcher registration, followed by five failed attempts.
  failures.set(f.base, 6);
  f.monitor.add(library, library);
  for (const [i, wait] of [1000, 2000, 4000, 8000, 16000].entries()) {
    f.clock.advance(wait);
    assert.equal(f.attempts.get(f.base), i + 2);
  }
  assert.equal(f.clock.pending(), 0, 'automatic attempts must stop after five failures');
  assert.equal(f.logs.filter(line => line.includes('Monitoring degraded:')).length, 1);
  f.clock.advance(9999);
  f.monitor.onLibraryEvent(library);
  assert.equal(f.attempts.get(f.base), 6);
  f.clock.advance(1);
  f.monitor.onLibraryEvent(library);
  assert.equal(f.attempts.get(f.base), 7);
  assert.equal(f.monitor.hasPhysicalEntryWatch(library), true);
  assert.equal(f.logs.filter(line => line.includes('Monitoring restored:')).length, 1);
  assert.equal(f.clock.pending(), 0);
});

test('recovery compares directory identities and delivers changes missed during the outage', t => {
  const { base, monitor, watchers, clock, events, failures } =
    fixture(t, { failures: new Map() });
  const root = path.join(base, 'library'); fs.mkdirSync(root);
  monitor.add(root, root);
  failures.set(base, 0);
  watchers.get(base).emit('error', new Error('lost notifications'));
  fs.renameSync(root, root + '-old');
  fs.mkdirSync(root);
  clock.advance(1000);
  assert.ok(events.some(event => event.kind === 'physical' && event.entry === root &&
    event.state === 'directory'), 'the replacement must be reported even without an OS event');
  assert.equal(monitor.hasPhysicalEntryWatch(root), true);
});

test('failed parent watchers recover from relevant ancestor events, not unrelated changes', t => {
  const { base, monitor, watchers, clock, attempts, failures } = fixture(t);
  const root = path.join(base, 'library'); fs.mkdirSync(root);
  monitor.add(root, root);
  failures.set(base, 5);
  watchers.get(base).emit('error', new Error('lost notifications'));
  clock.advance(31000);
  assert.equal(attempts.get(base), 6);
  const ancestor = watchers.get(path.dirname(base));
  ancestor.emitChange('unrelated');
  assert.equal(attempts.get(base), 6);
  clock.advance(10000);
  ancestor.emitChange(path.basename(base));
  assert.equal(attempts.get(base), 7);
  assert.equal(monitor.hasPhysicalEntryWatch(root), true);
});

test('symlink replacement during outage is checked before re-registering a parent watcher', t => {
  const baseClock = fakeClock(), failures = new Map(), checked = [];
  let monitor, root;
  const validate = library => {
    checked.push(library);
    if (fs.lstatSync(root).isSymbolicLink()) {
      monitor.remove(library);
      return false;
    }
    return true;
  };
  const f = fixture(t, { failures, clock: baseClock, validate });
  monitor = f.monitor;
  root = path.join(f.base, 'library');
  const external = path.join(f.base, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(external);
  monitor.add(root, root);
  failures.set(f.base, 1);
  f.watchers.get(f.base).emit('error', new Error('failed parent watcher'));
  const watchAttempts = f.attempts.get(f.base);
  fs.renameSync(root, root + '-old');
  fs.symlinkSync(external, root, linkKind);
  baseClock.advance(1000);
  assert.ok(checked.length >= 2, 'validate on watcher error and before retry');
  assert.equal(f.attempts.get(f.base), watchAttempts,
    'no new watcher is registered after the path becomes a symlink');
  assert.equal(f.clock.pending(), 0);
  assert.equal(f.monitor.hasPhysicalEntryWatch(root), false);
});

test('disposing or removing a failed library cancels its scheduled recovery', t => {
  const f = fixture(t);
  const root = path.join(f.base, 'library'); fs.mkdirSync(root);
  f.monitor.add(root, root);
  f.watchers.get(f.base).emit('error', new Error('failed watcher'));
  assert.equal(f.clock.pending(), 1);
  f.monitor.remove(root);
  assert.equal(f.clock.pending(), 0);
  f.clock.advance(60000);
  f.monitor.add(root, root);
  f.watchers.get(f.base).emit('error', new Error('failed again'));
  assert.equal(f.clock.pending(), 1);
  f.monitor.dispose();
  assert.equal(f.clock.pending(), 0);
});

