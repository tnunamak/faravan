import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountRegistry, migrateLegacyAccounts } from '../lib/v1/lending-accounts.mjs';
import { acquireProcessLockSync } from '../lib/v1/lock.mjs';

const NOW = 1793376000000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'lending-accounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'accounts.json');
  const open = (options = {}) => createAccountRegistry({ file, now: () => NOW, ...options });
  return { dir, file, open, registry: open() };
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('empty install remains empty and does not invent legacy accounts', t => {
  const { file, registry } = fixture(t);
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.get('missing'), null);
  assert.equal(registry.setEnabled('missing', false), null);
  assert.deepEqual(registry.resolve({ provider: 'claude' }), { ok: false, reason: 'none' });
  assert.deepEqual(migrateLegacyAccounts(registry, { providers: [] }), []);
  assert.equal(fs.existsSync(file), false);
});

test('opaque independent identities, detached metadata and stable ids across reload', t => {
  const { registry, open } = fixture(t);
  const origin = { config: '/private/config', hints: ['local'] };
  const a = registry.add({ provider: 'claude', label: 'First', origin });
  const b = registry.add({ provider: 'claude', label: 'First', origin });
  const future = registry.add({ provider: 'future-provider', label: 'Future' });
  for (const account of [a, b, future]) {
    assert.match(account.id, uuid);
    assert.equal(account.created_at, NOW);
    assert.equal(account.enabled, false, 'a new account starts off until the owner turns it on');
  }
  assert.notEqual(a.id, b.id);
  origin.hints.push('changed'); a.origin.hints.push('also changed'); a.id = 'mutated';
  const before = registry.list();
  assert.deepEqual(before[0].origin.hints, ['local']);
  before[0].origin.hints.push('list mutation');
  assert.deepEqual(open().list(), registry.list());
  assert.equal(open().get(b.id).id, b.id);
  const second = open();
  second.add({ provider: 'codex', label: 'Second instance' });
  assert.equal(registry.list().length, 4, 'no cached snapshot loses another instance write');
});

test('resolve never guesses; explicit id wins provider, but disabled/missing ids do not fall back', t => {
  const { registry, open } = fixture(t);
  let a = registry.add({ provider: 'claude', label: 'A' });
  assert.deepEqual(registry.resolve({ provider: 'claude' }), { ok: false, reason: 'none' }, 'an account that is off lends nothing');
  a = registry.setEnabled(a.id, true);
  assert.deepEqual(registry.resolve({ provider: 'claude' }), { ok: true, account: a });
  const b = registry.setEnabled(registry.add({ provider: 'claude', label: 'B' }).id, true);
  assert.equal(registry.resolve({ provider: 'claude' }).account.id, a.id, 'with several enabled accounts the first in order is chosen');
  assert.deepEqual(registry.resolve({ provider: 'codex', accountId: a.id }), { ok: true, account: a });
  assert.deepEqual(registry.resolve({ provider: 'claude', accountId: 'missing' }), { ok: false, reason: 'none' });
  registry.setEnabled(b.id, false);
  assert.equal(open().get(b.id).enabled, false);
  assert.equal(registry.resolve({ provider: 'claude' }).account.id, a.id);
  assert.deepEqual(registry.resolve({ provider: 'claude', accountId: b.id }), { ok: false, reason: 'none' });
  registry.setEnabled(a.id, false);
  assert.deepEqual(registry.resolve({ provider: 'claude' }), { ok: false, reason: 'none' });
  registry.setEnabled(b.id, true);
  assert.equal(registry.resolve({ provider: 'claude' }).account.id, b.id);
  assert.deepEqual(registry.resolve(), { ok: false, reason: 'none' });
});

for (const providers of [['claude'], ['codex'], ['claude', 'codex']]) {
  test('legacy migration is idempotent: ' + providers.join(', '), t => {
    const { file, registry, open, dir } = fixture(t);
    const legacyFile = join(dir, 'legacy.json');
    const legacyBytes = '{"accounts":{"claude":{"meter":42}}}';
    fs.writeFileSync(legacyFile, legacyBytes);
    const modern = registry.add({ provider: 'claude', label: 'Already modern' });
    const migrated = migrateLegacyAccounts(registry, { providers: [...providers, ...providers] });
    assert.deepEqual(migrated.map(a => a.provider), providers);
    assert.equal(new Set(migrated.map(a => a.id)).size, providers.length);
    assert.ok(migrated.every(a => a.legacy_provider === a.provider && a.id !== modern.id));
    const bytes = fs.readFileSync(file, 'utf8');
    assert.deepEqual(migrateLegacyAccounts(open(), { providers: [...providers].reverse() }), migrated);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'repeat performs no rewrite');
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), legacyBytes, 'legacy data is untouched');
    registry.setEnabled(migrated[0].id, false);
    const again = migrateLegacyAccounts(open(), { providers });
    assert.equal(again[0].id, migrated[0].id);
    assert.equal(again[0].enabled, false, 'migration never re-enables an existing identity');
    assert.deepEqual(registry.get(modern.id), modern);
    assert.ok(read(file).migrations.every(j => j.phase === 'complete'));
  });
}

// Inject a failed rename before publication, or an error immediately after
// publication (an uncertain durable-write outcome). This tests both disk states
// possible at each journal boundary without sleep, subprocesses or a test-only API.
// These are deterministic fault simulations, not claims of power-loss testing.
for (const provider of ['claude', 'codex']) {
  for (const phase of ['prepared', 'installed', 'complete']) {
    for (const when of ['before', 'after']) {
      test('recover ' + when + ' ' + provider + ' ' + phase + ' publication', t => {
        const { registry, file, open } = fixture(t);
        const modern = registry.add({ provider: 'claude', label: 'Preserve', origin: { path: '/same' } });
        const originalRename = fs.renameSync;
        const failure = Object.assign(new Error('simulated interruption'), { code: 'EIO' });
        let hit = false;
        const mock = t.mock.method(fs, 'renameSync', (source, target) => {
          if (target === file && !hit) {
            const pending = read(source);
            if (pending.migrations.some(j => j.provider === provider && j.phase === phase)) {
              hit = true;
              if (when === 'after') originalRename(source, target);
              throw failure;
            }
          }
          return originalRename(source, target);
        });
        assert.throws(() => migrateLegacyAccounts(registry, { providers: ['claude', 'codex'] }), e => e === failure);
        mock.mock.restore();
        assert.equal(hit, true, 'the requested boundary was reached');
        const interrupted = read(file);
        const reserved = new Map(interrupted.migrations.map(j => [j.provider, j.id]));
        // Pending intents resume even without the provider in the next input.
        migrateLegacyAccounts(open(), { providers: [] });
        const recovered = migrateLegacyAccounts(open(), { providers: ['claude', 'codex'] });
        assert.equal(recovered.length, 2);
        assert.equal(new Set(recovered.map(a => a.id)).size, 2);
        for (const [name, id] of reserved) assert.equal(recovered.find(a => a.provider === name).id, id);
        assert.deepEqual(open().get(modern.id), modern);
        assert.equal(open().list().length, 3);
        assert.ok(read(file).migrations.every(j => j.phase === 'complete'));
        const bytes = fs.readFileSync(file, 'utf8');
        assert.deepEqual(migrateLegacyAccounts(open(), { providers: ['codex', 'claude'] }), recovered);
        assert.equal(fs.readFileSync(file, 'utf8'), bytes);
      });
    }
  }
}

test('invalid input is rejected without changing durable accounts', t => {
  const { registry, file, open } = fixture(t);
  registry.add({ provider: '__proto__', label: 'Future names are not object keys' });
  const bytes = fs.readFileSync(file, 'utf8');
  const cycle = {}; cycle.self = cycle;
  for (const input of [
    { provider: '' }, { provider: 1 }, { provider: 'claude', label: null },
    ...[NaN, undefined, () => {}, 1n, new Date(), cycle].map(value => ({ provider: 'claude', origin: { value } })),
  ]) assert.throws(() => registry.add(input), TypeError);
  assert.throws(() => registry.setEnabled('missing', 1), TypeError);
  for (const providers of [null, 'claude', ['claude', null], ['']])
    assert.throws(() => migrateLegacyAccounts(registry, { providers }), TypeError);
  assert.throws(() => migrateLegacyAccounts({}, { providers: [] }), TypeError);
  assert.throws(() => open({ now: () => NaN }).add({ provider: 'claude' }), TypeError);
  assert.throws(() => createAccountRegistry({ file: 'relative.json' }), TypeError);
  assert.throws(() => open({ lockWaitMs: Infinity }), TypeError);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('corrupt, partial, duplicate and inconsistent journals fail closed without data loss', t => {
  const { registry, file, open } = fixture(t);
  migrateLegacyAccounts(registry, { providers: ['claude'] });
  const valid = fs.readFileSync(file, 'utf8');
  const mutations = [
    d => { delete d.migrations; },
    d => { d.schema_version = 2; },
    d => { d.accounts = null; },
    d => { d.accounts[0].enabled = 'yes'; },
    d => { d.accounts[0].id = 'claude'; },
    d => { delete d.accounts[0].created_at; },
    d => { d.accounts.push({ ...d.accounts[0] }); },
    d => { d.accounts[0].legacy_provider = 'codex'; },
    d => { d.migrations.push({ ...d.migrations[0] }); },
    d => { d.migrations[0] = null; },
    d => { d.migrations[0].phase = 'unknown'; },
    d => { d.migrations[0].id = '00000000-0000-4000-8000-000000000000'; },
    d => { d.migrations[0].phase = 'prepared'; },
    d => { d.migrations = []; },
    d => { d.accounts = []; },
    d => { d.migrations[0].phase = 'prepared'; d.migrations[0].account = d.accounts[0]; },
    d => { d.migrations[0].phase = 'prepared'; d.migrations[0].account = d.accounts.pop(); d.migrations[0].account.provider = 'codex'; },
  ];
  const bad = ['{', '', 'null', '[]', '{}', ...mutations.map(mutate => {
    const data = JSON.parse(valid); mutate(data); return JSON.stringify(data);
  })];
  for (const bytes of bad) {
    fs.writeFileSync(file, bytes);
    const reopened = open();
    for (const operation of [
      () => reopened.list(), () => reopened.get('missing'), () => reopened.resolve({ provider: 'claude' }),
      () => reopened.add({ provider: 'codex' }), () => reopened.setEnabled('missing', false),
      () => migrateLegacyAccounts(reopened, { providers: ['codex'] }),
    ]) {
      assert.throws(operation, e => e.code === 'account_registry_corrupt');
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    }
  }
  fs.writeFileSync(file, valid);
  assert.deepEqual(migrateLegacyAccounts(open(), { providers: ['claude'] }), JSON.parse(valid).accounts);
});

test('registry refuses an active writer lock instead of racing or overwriting', t => {
  const { registry, file, open } = fixture(t);
  registry.add({ provider: 'claude' });
  const bytes = fs.readFileSync(file, 'utf8');
  const release = acquireProcessLockSync(file + '.lock');
  try {
    assert.throws(() => open({ lockWaitMs: 0 }).add({ provider: 'codex' }), e => e.code === 'lock_busy');
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  } finally { release(); }
  assert.equal(open().list().length, 1);
});

test('restart after an interrupted migration shows the reserved account to ordinary access', t => {
  const { registry, file, open } = fixture(t);
  const originalRename = fs.renameSync;
  const failure = Object.assign(new Error('simulated interruption'), { code: 'EIO' });
  let hit = false;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === file && !hit && read(source).migrations.some(j => j.phase === 'installed')) { hit = true; throw failure; }
    return originalRename(source, target);
  });
  assert.throws(() => migrateLegacyAccounts(registry, { providers: ['claude'] }), e => e === failure);
  t.mock.restoreAll();
  assert.equal(read(file).accounts.length, 0, 'the crash left only a prepared intent on disk');
  const reserved = read(file).migrations[0].id;
  // No migrate call: list, get and resolve must all recover first.
  assert.deepEqual(open().list().map(a => a.id), [reserved]);
  assert.equal(open().get(reserved).provider, 'claude');
  assert.equal(open().resolve({ provider: 'claude' }).account.id, reserved);
  assert.ok(read(file).migrations.every(j => j.phase === 'complete'));
});

test('a retried add with the same key never duplicates after an uncertain commit', t => {
  const { registry, file, open } = fixture(t);
  const originalRename = fs.renameSync;
  const failure = Object.assign(new Error('barrier failed after rename'), { code: 'EIO' });
  let hit = false;
  t.mock.method(fs, 'renameSync', (source, target) => {
    originalRename(source, target);
    if (target === file && !hit) { hit = true; throw failure; }
  });
  const input = { provider: 'claude', label: 'Same', key: 'enroll-op-1' };
  assert.throws(() => registry.add(input), e => e === failure);
  t.mock.restoreAll();
  const retried = open().add(input);
  assert.equal(open().list().length, 1);
  assert.equal(retried.operation_key, 'enroll-op-1');
  assert.deepEqual(open().add(input), retried, 'a third attempt is a no-op');
  assert.throws(() => open().add({ provider: 'codex', key: 'enroll-op-1' }), { code: 'account_key_conflict' });
  // Without a key, two accounts may share provider and label.
  open().add({ provider: 'claude', label: 'Same' });
  assert.equal(open().list().length, 2);
});

test('unknown creation fields are rejected and duplicate stored keys are corrupt', t => {
  const { registry, file } = fixture(t);
  assert.throws(() => registry.add({ provider: 'claude', credentials: '/secret' }), TypeError);
  assert.throws(() => registry.add({ provider: 'claude', key: '' }), TypeError);
  assert.equal(fs.existsSync(file), false);
  registry.add({ provider: 'claude', key: 'k' });
  const data = read(file);
  data.accounts.push({ ...data.accounts[0], id: '11111111-1111-4111-8111-111111111111' });
  fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => registry.list(), { code: 'account_registry_corrupt' });
});

test('a failing lock release does not mask the original error', t => {
  const { registry, file } = fixture(t);
  registry.add({ provider: 'claude' });
  fs.writeFileSync(file, '{not json');
  const lock = file + '.lock';
  const unlink = fs.unlinkSync;
  let releaseFailed = false;
  t.mock.method(fs, 'unlinkSync', path => {
    if (String(path).startsWith(lock)) { releaseFailed = true; throw new Error('release failed'); }
    return unlink(path);
  });
  assert.throws(() => registry.list(), { code: 'account_registry_corrupt' });
  assert.equal(releaseFailed, true, 'release was attempted and failed');
});

// Fail the registry directory's fsync once, after the file was renamed into place. The new
// bytes are visible but their directory entry is not known to be durable.
function failRegistryDirectorySync(t, dir) {
  const open = fs.openSync;
  const failure = Object.assign(new Error('directory barrier failed'), { code: 'EIO' });
  const state = { failures: 0, attempts: 0, armed: true };
  t.mock.method(fs, 'openSync', (path, flags, ...rest) => {
    if (path === dir && flags === 'r') {
      state.attempts++;
      if (state.armed) { state.armed = false; state.failures++; throw failure; }
    }
    return open(path, flags, ...rest);
  });
  state.failure = failure;
  return state;
}

test('keyed retry reestablishes failed registry directory barrier', t => {
  const { registry, dir, open } = fixture(t);
  const sync = failRegistryDirectorySync(t, dir);
  const input = { provider: 'claude', label: 'A', key: 'op-1' };
  assert.throws(() => registry.add(input), e => e === sync.failure);
  const attemptsAfterFirst = sync.attempts;
  const retried = open().add(input);
  assert.ok(sync.attempts > attemptsAfterFirst, 'the retry redid the directory fsync before acknowledging');
  assert.equal(open().list().length, 1);
  assert.equal(open().list()[0].id, retried.id);
  // A persistent failure is never acknowledged.
  const again = failRegistryDirectorySync(t, dir);
  again.armed = false;
  t.mock.method(fs, 'fsyncSync', () => { throw again.failure; });
  assert.throws(() => open().add(input), e => e === again.failure);
});

test('no-op disable retry confirms durability', t => {
  const { registry, dir, open } = fixture(t);
  const account = registry.add({ provider: 'claude' });
  const sync = failRegistryDirectorySync(t, dir);
  assert.throws(() => registry.setEnabled(account.id, false), e => e === sync.failure);
  assert.equal(open().get(account.id).enabled, false, 'the change is visible');
  const before = sync.attempts;
  assert.equal(open().setEnabled(account.id, false).enabled, false);
  assert.ok(sync.attempts > before, 'the retry redid the directory fsync although nothing changed');
});

test('completed migration retry confirms durability', t => {
  const { registry, dir, open } = fixture(t);
  migrateLegacyAccounts(registry, { providers: ['claude'] });
  const reserved = registry.list()[0].id;
  const sync = failRegistryDirectorySync(t, dir);
  // The next write of identical, complete state fails its barrier, as a final save would.
  assert.throws(() => registry.setEnabled(reserved, false), e => e === sync.failure);
  const before = sync.attempts;
  const retried = migrateLegacyAccounts(open(), { providers: [] });
  assert.ok(sync.attempts > before, 'a completed migration retry redid the barrier');
  assert.deepEqual(retried.map(a => a.id), [reserved]);
});

test('existing-key replay validates the full creation input and rejects a different payload', t => {
  const { registry, file } = fixture(t);
  registry.add({ provider: 'claude', label: 'L', origin: { a: 1, b: 2 }, key: 'k' });
  const bytes = fs.readFileSync(file, 'utf8');
  assert.throws(() => registry.add({ provider: 'claude', label: 'L', key: 'k', credentials: '/new' }), TypeError);
  assert.throws(() => registry.add({ provider: 'claude', label: 3, key: 'k' }), TypeError);
  assert.throws(() => registry.add({ provider: 'claude', label: 'L', key: 'k', origin: { f() {} } }), TypeError);
  for (const other of [{ provider: 'codex', label: 'L', origin: { a: 1, b: 2 } },
    { provider: 'claude', label: 'M', origin: { a: 1, b: 2 } }, { provider: 'claude', label: 'L', origin: { a: 1 } },
    { provider: 'claude', label: 'L' }])
    assert.throws(() => registry.add({ ...other, key: 'k' }), { code: 'account_key_conflict' });
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'rejected replays change nothing');
  // Key order inside origin is not a different payload.
  assert.equal(registry.add({ provider: 'claude', label: 'L', origin: { b: 2, a: 1 }, key: 'k' }).label, 'L');
});

for (const op of ['list', 'get', 'resolve', 'add', 'setEnabled']) {
  test('first operation ' + op + ' independently recovers a prepared intent', t => {
    const { file, registry, open } = fixture(t);
    const id = '0b6f2d3e-6c52-4c2a-8f6e-0c9a8e1d2b3c';
    const account = { id, provider: 'claude', label: 'claude', enabled: true, created_at: NOW, legacy_provider: 'claude' };
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, accounts: [],
      migrations: [{ provider: 'claude', id, phase: 'prepared', account }] }));
    const r = open();
    if (op === 'list') assert.deepEqual(r.list().map(a => a.id), [id]);
    if (op === 'get') assert.equal(r.get(id).id, id);
    if (op === 'resolve') assert.equal(r.resolve({ provider: 'claude' }).account.id, id);
    if (op === 'add') { r.add({ provider: 'codex' }); assert.ok(r.get(id)); }
    if (op === 'setEnabled') assert.equal(r.setEnabled(id, false).enabled, false);
    assert.ok(read(file).migrations.every(j => j.phase === 'complete'));
    assert.ok(read(file).accounts.some(a => a.id === id));
    void registry;
  });
}
