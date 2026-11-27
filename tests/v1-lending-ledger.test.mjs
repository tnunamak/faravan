import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createLendingLedger, fitKappa, sameAccountCheck, kappaPrior } from '../lib/v1/lending-ledger.mjs';
import { evaluateLending } from '../lib/v1/lending-policy.mjs';

const HOUR = 3600000, WEEK = 7 * 24 * HOUR;
const base = join(homedir(), '.tmp');
mkdirSync(base, { recursive: true });
const scratch = () => mkdtempSync(join(base, 'lending-ledger-test-'));
let clock = Date.parse('2026-10-21T23:00:00Z');
const RESET = clock + 2 * 24 * HOUR;
const week = (used, at = clock, patch = {}) => ({ window_id: 'seven_day', window_minutes: 10080, used_pct: used, resets_at: RESET, observed_at: at, state: 'open', source: 'probe', ...patch });
const five = (used, at = clock) => ({ window_id: 'five_hour', window_minutes: 300, used_pct: used, resets_at: clock + HOUR, observed_at: at, state: 'open', source: 'probe' });
const metered = (units, model = 'claude-opus-5-5') => ({ priced_units: units, unit: 'claude_usd', model, family: 'claude', tokens: null, list_usd_micros: Math.round(units * 1e6), catalog_rev: 'x' });
function withLedger(fn) {
  const dir = scratch();
  try { return fn(createLendingLedger({ file: join(dir, 'ledger.json'), now: () => clock }), dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const CONTRACT = ['window_id', 'window_minutes', 'used_pct', 'owner_used_pct', 'resets_at', 'observed_at', 'state', 'kappa', 'lent_pct', 'reserved_pct', 'lent_last_hour_pct', 'history', 'max_rate_pct_per_hour'];

test('snapshot returns the meter contract and the objective policy refuses without a complete input', () => withLedger(ledger => {
  ledger.recordReadings('claude', [week(29, clock - 2 * HOUR), week(31, clock - 3 * 60000)]);
  const snap = ledger.snapshot('claude', { plan: 'max20' });
  assert.equal(snap.windows.length, 1);
  for (const key of CONTRACT) assert.ok(key in snap.windows[0], key);
  const w = snap.windows[0];
  assert.equal(w.used_pct, 31); assert.equal(w.kappa, 1 / 20); assert.equal(w.kappa_source, 'prior_max20');
  assert.equal(w.max_rate_pct_per_hour, 2 / (117 / 60));
  assert.equal(snap.same_account, 'unknown');
  assert.equal(evaluateLending({windows:snap.windows,now:clock,policy:{accountPlans:{claude:'max20'}}}).reason,
    'objective_evidence_unknown');
  // The legacy ledger's guessed κ is not an objective reservation input.
  assert.equal(ledger.snapshot('claude').windows[0].kappa, null);
  assert.equal(evaluateLending({windows:ledger.snapshot('claude').windows,now:clock}).reason,'objective_evidence_unknown');
}));

test('the pace reserve subtracts only borrower burn proven in the current aggregate', () => withLedger(ledger => {
  const before = clock - HOUR;
  const started = clock - 45 * 60000, ended = clock - 15 * 60000, represented = clock - 10 * 60000;
  ledger.recordReadings('claude', [week(10, before)]);
  const hold = ledger.reserve({account: 'claude', job_digest: 'pace-borrower', attempt_id: 'pace-borrower',
    budget_units: 160, unit: 'claude_usd', plan: 'max20'}).reservation;
  ledger.recordReadings('claude', [week(18, represented)]);
  const [entry] = ledger.reconcile(hold.id, {metered: metered(160), started_at: started, ended_at: ended}).entries;
  assert.equal(entry.lent_lower_pts, 8);
  const window = ledger.snapshot('claude', {plan: 'max20'}).windows[0];
  assert.equal(window.owner_used_pct, 10, 'the proven 8-point borrower charge is removed from the aggregate');
  assert.equal(window.max_rate_pct_per_hour, 10 / 119,
    'the borrower-only 8-point rise does not become the owner trailing maximum');
}));

test('snapshot: an expired window is unknown; not_open stands only on a fresh probe', () => withLedger(ledger => {
  ledger.recordReadings('codex', [{ window_id: 'codex:10080', window_minutes: 10080, used_pct: 0, resets_at: null, observed_at: clock - 60000, state: 'not_open', source: 'probe' }]);
  assert.equal(ledger.snapshot('codex').windows[0].state, 'not_open');
  clock += 20 * 60000;
  assert.equal(ledger.snapshot('codex').windows[0].state, 'unknown');
  ledger.recordReadings('claude', [week(40, clock - 60000, { resets_at: clock - 1000 })]);
  assert.equal(ledger.snapshot('claude').windows[0].state, 'unknown');
  clock -= 20 * 60000;
}));

test('reserve is an atomic check-and-hold; reserved points are visible to the next admission', () => withLedger(ledger => {
  ledger.recordReadings('claude', [week(70, clock - 60000)]);
  const admit = windows => windows.every(w => 100 - w.used_pct - w.reserved_pct > 20);
  const first = ledger.reserve({ account: 'claude', job_digest: 'j1', attempt_id: 'a1', budget_units: 200, unit: 'claude_usd', plan: 'max20', admit,
    requester: { circle: 'c1', keyId: 'k1' } });
  assert.equal(first.ok, true);
  assert.equal(first.reservation.windows[0].est_pts, 10);
  assert.equal(first.windows[0].reserved_pct, 10);
  const second = ledger.reserve({ account: 'claude', job_digest: 'j2', attempt_id: 'a2', budget_units: 200, unit: 'claude_usd', plan: 'max20', admit });
  assert.equal(second.ok, false);
  // Re-reserving the same attempt is idempotent.
  assert.equal(ledger.reserve({ account: 'claude', job_digest: 'j1', attempt_id: 'a1', budget_units: 200, unit: 'claude_usd', plan: 'max20', admit, requester: { circle: 'c1', keyId: 'k1' } }).reservation.id, first.reservation.id);
}));


for (const restart of [false, true]) {
  test('reserve refuses a completed key without a second charge, restart=' + restart, () => withLedger((ledger, dir) => {
    ledger.recordReadings('claude', [week(30, clock - 60000)]);
    const request = { account: 'claude', job_digest: 'replay', attempt_id: 'replay',
      budget_units: 20, unit: 'claude_usd', plan: 'max20', requester: { circle: 'c', keyId: 'k' } };
    const hold = ledger.reserve(request).reservation;
    ledger.reconcile(hold.id, { metered: metered(20), started_at: clock, ended_at: clock + 1, stop_reason: 'done' });
    const current = restart ? createLendingLedger({ file: join(dir, 'ledger.json'), now: () => clock }) : ledger;
    const entries = current.entries(), usage = current.requesterUsage(request.requester);
    for (let i = 0; i < 2; i++) {
      const replay = current.reserve(request);
      assert.equal(replay.ok, false);
      assert.equal(replay.reason, 'reservation_closed');
      assert.equal(current.snapshotReadOnly('claude').holds, 0);
      assert.deepEqual(current.reconcile(hold.id).entries, entries);
      assert.deepEqual(current.entries(), entries);
      assert.deepEqual(current.requesterUsage(request.requester), usage);
    }
  }));

  test('reserve rejects changed active payloads, restart=' + restart, () => withLedger((ledger, dir) => {
    const request = { account: 'claude', job_digest: 'bound', attempt_id: 'bound', budget_units: 20,
      unit: 'claude_usd', model: 'claude-opus-5-5', plan: 'max20',
      requester: { circle: 'c', keyId: 'k' }, max_requester_pct: 20, ttl_ms: HOUR };
    const hold = ledger.reserve(request).reservation;
    const current = restart ? createLendingLedger({ file: join(dir, 'ledger.json'), now: () => clock }) : ledger;
    for (const change of [{ budget_units: 21 }, { job_digest: 'other' }, { unit: 'other' },
      { requester: { circle: 'c', keyId: 'other' } }, { requester: null }]) {
      const conflict = current.reserve({ ...request, ...change });
      assert.equal(conflict.ok, false, JSON.stringify(change));
      assert.equal(conflict.reason, 'reservation_conflict');
      assert.equal(current.snapshotReadOnly('claude').holds, 1);
    }
    assert.deepEqual(current.reserve({ ...request, requester: { keyId: 'k', circle: 'c' } }).reservation, hold);
    // Lender settings and observations a retry may recompute reuse the live hold; it is not orphaned.
    for (const change of [{ model: 'other' }, { plan: 'max5' }, { max_requester_pct: 19 }, { ttl_ms: HOUR + 1 }]) {
      const retry = current.reserve({ ...request, ...change });
      assert.equal(retry.ok, true, JSON.stringify(change));
      assert.deepEqual(retry.reservation, hold);
      assert.equal(current.snapshotReadOnly('claude').holds, 1);
    }
    assert.deepEqual(current.entries(), []);
  }));
}

for (const method of ['reconcile', 'reconcileAttempt', 'recover']) {
  test('closed keys survive release, recovery and history pruning: ' + method, () => withLedger((ledger, dir) => {
    const request = { account: 'claude', job_digest: 'closed', attempt_id: 'closed',
      budget_units: 20, unit: 'claude_usd', plan: 'max20' };
    const hold = ledger.reserve(request).reservation;
    if (method === 'recover') ledger.recover({ liveAttemptIds: [] });
    else ledger[method](method === 'reconcile' ? hold.id : hold.attempt_id, { started: false });
    const current = createLendingLedger({ file: join(dir, 'ledger.json'), now: () => clock + 11 * WEEK });
    current.recordReadings('claude', []);
    assert.deepEqual(current.entries(), []);
    assert.equal(current.reserve(request).reason, 'reservation_closed');
    assert.equal(current.snapshotReadOnly('claude').holds, 0);
  }));
}
for (const markers of ['absent', 'empty']) for (const active of [false, true])
test('legacy known keys fail closed, markers=' + markers + ', active=' + active, () => withLedger((ledger, dir) => {
  const request = { account: 'claude', job_digest: 'legacy', attempt_id: 'legacy',
    budget_units: 20, unit: 'claude_usd', plan: 'max20' };
  const hold = ledger.reserve(request).reservation;
  if (!active) ledger.reconcile(hold.id, { metered: metered(20), started_at: clock, ended_at: clock + 1 });
  const file = join(dir, 'ledger.json'), old = JSON.parse(readFileSync(file, 'utf8'));
  delete old.reserve_requests;
  if (markers === 'empty') old.reserve_requests = [];
  writeFileSync(file, JSON.stringify(old));
  const current = createLendingLedger({ file, now: () => clock + 11 * WEEK });
  current.recordReadings('claude', []);
  assert.deepEqual(current.entries(), []);
  const replay = current.reserve(request);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, active ? 'reservation_conflict' : 'reservation_closed');
  assert.equal(current.snapshotReadOnly('claude').holds, active ? 1 : 0);
}));

test('an admission refusal does not consume the key', () => withLedger(ledger => {
  const request = { account: 'claude', job_digest: 'retry', attempt_id: 'retry',
    budget_units: 20, unit: 'claude_usd', plan: 'max20' };
  assert.equal(ledger.reserve({ ...request, admit: () => false }).reason, 'not_admitted');
  assert.equal(ledger.reserve(request).ok, true);
}));

test('reserve is atomic across processes: of six racing admissions exactly one holds', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'ledger.json');
    createLendingLedger({ file, now: () => clock }).recordReadings('claude', [week(70, clock - 60000)]);
    const script = `import {createLendingLedger} from ${JSON.stringify(new URL('../lib/v1/lending-ledger.mjs', import.meta.url).href)};
const l=createLendingLedger({file:${JSON.stringify(file)},now:()=>${clock},lockWaitMs:20000});
const r=l.reserve({account:'claude',job_digest:'j'+process.argv[1],attempt_id:'a'+process.argv[1],budget_units:200,unit:'claude_usd',plan:'max20',
admit:w=>w.every(x=>x.reserved_pct===0)});process.stdout.write(r.ok?'held':'refused');`;
    const children = Array.from({ length: 6 }, (_, i) => new Promise(resolve => {
      import('node:child_process').then(({ execFile }) => execFile(process.execPath, ['--input-type=module', '-e', script, String(i)], (err, out) => resolve(err ? 'error:' + err.message : out)));
    }));
    return Promise.all(children).then(results => {
      assert.equal(results.filter(r => r === 'held').length, 1, results.join(','));
      assert.equal(results.filter(r => r === 'refused').length, 5, results.join(','));
    });
  } finally { setTimeout(() => rmSync(dir, { recursive: true, force: true }), 5000).unref(); }
});

test('attribution: exact, below resolution, overlapped, unknown; never negative', () => withLedger(ledger => {
  const hold = (n) => ledger.reserve({ account: 'claude', job_digest: 'j' + n, attempt_id: 'a' + n, budget_units: 1, unit: 'claude_usd', plan: 'max20' }).reservation;
  ledger.recordReadings('claude', [week(30, clock - 10 * 60000)]);
  let h = hold(1);
  ledger.recordReadings('claude', [week(34, clock + 20 * 60000)]);
  let [e] = ledger.reconcile(h.id, { metered: metered(60), started_at: clock - 5 * 60000, ended_at: clock + 15 * 60000 }).entries;
  assert.equal(e.attribution, 'exact'); assert.equal(e.delta_pct, 4); assert.equal(e.lent_pts, 4);
  assert.equal(e.lent_lower_pts, 4, 'exact meter attribution is a proven lower bound');
  assert.equal(e.represented_at, clock + 20 * 60000, 'the lower bound records the aggregate reading that proves inclusion');
  assert.deepEqual(ledger.reconcile(h.id, {}).already, true);
  clock += HOUR;
  h = hold(2);
  ledger.recordReadings('claude', [week(35, clock + 20 * 60000)]);
  [e] = ledger.reconcile(h.id, { metered: metered(10), started_at: clock - 5 * 60000, ended_at: clock + 15 * 60000 }).entries;
  assert.equal(e.attribution, 'below_resolution'); assert.equal(e.lent_pts, 10 / 20);
  assert.equal(e.lent_lower_pts, 0, 'a sub-resolution estimate is not proven borrower burn');
  clock += HOUR;
  h = hold(3);
  ledger.recordReadings('claude', [week(39, clock + 20 * 60000)]);
  [e] = ledger.reconcile(h.id, { metered: metered(20), started_at: clock - 5 * 60000, ended_at: clock + 15 * 60000, owner_active: true }).entries;
  assert.equal(e.attribution, 'overlapped'); assert.equal(e.lent_pts, 1);
  assert.equal(e.lent_lower_pts, 0, 'overlapped meter movement may include owner burn');
  clock += HOUR;
  h = hold(4);
  ledger.recordReadings('claude', [week(37, clock + 20 * 60000)]);
  [e] = ledger.reconcile(h.id, { metered: null, started_at: clock - 5 * 60000, ended_at: clock + 15 * 60000 }).entries;
  assert.equal(e.lent_pts, 0.05, 'missing measurement retains its full hold even when the reading falls');
  assert.equal(e.lent_lower_pts, 0);
  const snap = ledger.snapshot('claude', { plan: 'max20' });
  assert.equal(snap.windows[0].lent_pct, 4 + 0.5 + 1 + 0.05);
  clock -= 3 * HOUR;
}));

test('a reset during a job splits its ledger across both windows', () => withLedger(ledger => {
  const reset = clock + 10 * 60000;
  ledger.recordReadings('claude', [week(60, clock - 5 * 60000, { resets_at: reset })]);
  const h = ledger.reserve({ account: 'claude', job_digest: 'j', attempt_id: 'a', budget_units: 40, unit: 'claude_usd', plan: 'max20' }).reservation;
  ledger.recordReadings('claude', [week(62, clock + 9 * 60000, { resets_at: reset }), week(1, clock + 21 * 60000, { resets_at: reset + WEEK })]);
  const { entries } = ledger.reconcile(h.id, { metered: metered(40), started_at: clock, ended_at: clock + 20 * 60000 });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.attribution), ['reset_split', 'reset_split']);
  assert.equal(entries[0].resets_at, reset); assert.equal(entries[1].resets_at, reset + WEEK);
  assert.equal(entries[0].units_share, 0.5); assert.equal(entries[0].priced_units, 20);
  assert.deepEqual(entries.map(e => e.lent_pts), [1, 1]);
}));

test('crash recovery charges orphaned and expired holds at their full reservation; unstarted jobs release free', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'ledger.json');
    const before = createLendingLedger({ file, now: () => clock });
    before.recordReadings('claude', [week(50, clock - 60000)]);
    const live = before.reserve({ account: 'claude', job_digest: 'j1', attempt_id: 'live', budget_units: 20, unit: 'claude_usd', plan: 'max20' });
    before.reserve({ account: 'claude', job_digest: 'j2', attempt_id: 'dead', budget_units: 20, unit: 'claude_usd', plan: 'max20' });
    const unstarted = before.reserve({ account: 'claude', job_digest: 'j3', attempt_id: 'unstarted', budget_units: 20, unit: 'claude_usd', plan: 'max20' });
    assert.deepEqual(before.reconcile(unstarted.reservation.id, { started: false }), { entries: [], released: true });
    // A fresh process (after a crash) recovers from the file alone.
    const after = createLendingLedger({ file, now: () => clock });
    assert.deepEqual(after.recover({ liveAttemptIds: ['live'] }).recovered, ['dead']);
    const [e] = after.entries({ attempt_id: 'dead' });
    assert.equal(e.attribution, 'unknown'); assert.equal(e.lent_pts, 1); assert.equal(e.recovered, true); assert.equal(e.stop_reason, 'error');
    assert.equal(after.snapshot('claude', { plan: 'max20' }).windows[0].reserved_pct, 1);
    clock += 3 * HOUR;
    assert.deepEqual(after.recover().recovered, ['live']);
    clock -= 3 * HOUR;
    assert.equal(after.entries({ attempt_id: 'unstarted' }).length, 0);
    // A corrupt file fails closed rather than forgetting holds.
    writeFileSync(file, '{not json');
    assert.throws(() => after.snapshot('claude'), e => e.code === 'ledger_corrupt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pending sandbox recovery: a hold kept live by recover() is settled by attempt once cessation is proven', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'ledger.json');
    const before = createLendingLedger({ file, now: () => clock });
    before.recordReadings('claude', [week(50, clock - 60000)]);
    for (const id of ['ran', 'never-started', 'expired'])
      before.reserve({ account: 'claude', job_digest: 'j-' + id, attempt_id: id, budget_units: 20, unit: 'claude_usd', plan: 'max20', ttl_ms: id === 'expired' ? 1000 : 2 * HOUR });
    // The runtime restarts with all three still pending sandbox recovery, so recover() keeps the unexpired ones.
    const after = createLendingLedger({ file, now: () => clock });
    assert.deepEqual(after.recover({ liveAttemptIds: ['ran', 'never-started', 'expired'] }).recovered, []);
    assert.equal(after.snapshot('claude', { plan: 'max20' }).windows[0].reserved_pct, 3);
    // The lender proves cessation, then settles each attempt before clearing its pending record.
    const ran = after.reconcileAttempt('ran', { started: true });
    assert.equal(ran.entries.length, 1);
    assert.deepEqual([ran.entries[0].stop_reason, ran.entries[0].recovered, ran.entries[0].lent_pts, ran.entries[0].attribution], ['error', true, 1, 'unknown']);
    assert.deepEqual(after.reconcileAttempt('never-started', { started: false }), { entries: [], released: true, attempt_id: 'never-started' });
    clock += 2000;
    assert.equal(after.reconcileAttempt('expired', { started: true }).entries[0].lent_pts, 1, 'an expired retained hold is charged, not left reserved');
    clock -= 2000;
    assert.equal(after.snapshot('claude', { plan: 'max20' }).windows[0].reserved_pct, 0, 'no hold outlives proven cleanup');
    // Idempotent: repeating returns what was recorded and charges nothing more.
    const again = after.reconcileAttempt('ran', { started: true });
    assert.equal(again.already, true); assert.equal(again.entries.length, 1);
    assert.deepEqual(after.reconcileAttempt('never-started', { started: false }), { entries: [], already: true, attempt_id: 'never-started' });
    assert.equal(after.entries({ account: 'claude' }).length, 2);
    // Unknown "started" is treated as started: spent is spent.
    after.reserve({ account: 'claude', job_digest: 'j-u', attempt_id: 'unsure', budget_units: 20, unit: 'claude_usd', plan: 'max20' });
    assert.equal(after.reconcileAttempt('unsure').entries[0].lent_pts, 1);
    // With metered usage the normal attribution is used.
    after.reserve({ account: 'claude', job_digest: 'j-m', attempt_id: 'metered', budget_units: 20, unit: 'claude_usd', plan: 'max20' });
    const m = after.reconcileAttempt('metered', { started: true, metered: metered(10), started_at: clock - 1000, ended_at: clock, stop_reason: 'budget' });
    assert.equal(m.entries[0].stop_reason, 'budget'); assert.equal(m.entries[0].recovered, false);
    assert.throws(() => after.reconcileAttempt(''), TypeError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('requester usage: lent points always count; charged excludes lender-side failures', () => withLedger(ledger => {
  ledger.recordReadings('claude', [week(30, clock - 60000)]);
  const sam = { circle: 'c1', keyId: 'sam' };
  for (const [n, stop] of [[1, 'done'], [2, 'budget'], [3, 'owner'], [4, 'error'], [5, 'time']]) {
    const h = ledger.reserve({ account: 'claude', job_digest: 'j' + n, attempt_id: 'a' + n, budget_units: 20, unit: 'claude_usd', plan: 'max20', requester: sam }).reservation;
    ledger.reconcile(h.id, { metered: metered(20), started_at: clock, ended_at: clock + 1, stop_reason: stop, owner_active: true });
  }
  const [row] = ledger.requesterUsage(sam);
  assert.equal(row.window_id, 'seven_day'); assert.equal(row.jobs, 5);
  assert.equal(row.lent_pts, 5); assert.equal(row.charged_pts, 3);
  assert.equal(ledger.requesterUsage({ circle: 'c1', keyId: 'ana' }).length, 0);
  assert.equal(ledger.entries({ keyId: 'sam', stop_reason: 'owner' }).length, 1);
  assert.deepEqual(ledger.entries({ attempt_id: 'a1' })[0].requester, sam);
}));

test('per-person ceiling is checked atomically with charged points, own holds and this reservation', () => withLedger(ledger => {
  ledger.recordReadings('claude', [week(30, clock - 60000)]);
  const sam = { circle: 'c1', keyId: 'sam' }, ana = { circle: 'c1', keyId: 'ana' };
  const go = (n, who, units = 40) => ledger.reserve({ account: 'claude', job_digest: 'j' + n, attempt_id: 'a' + n, budget_units: units, unit: 'claude_usd', plan: 'max20',
    requester: who, max_requester_pct: 5 });
  const first = go(1, sam);
  ledger.reconcile(first.reservation.id, { metered: metered(40), started_at: clock, ended_at: clock + 1, stop_reason: 'done', owner_active: true });
  assert.equal(go(2, sam).ok, true, '2 charged + 2 reserved <= 5');
  const third = go(3, sam);
  assert.equal(third.ok, false); assert.equal(third.reason, 'requester_limit'); assert.equal(third.window_id, 'seven_day');
  assert.equal(go(4, ana).ok, true, 'another person has their own ceiling');
  // A refunded (lender-side) failure does not count against the person.
  const owner = go(5, ana, 40);
  ledger.reconcile(owner.reservation.id, { metered: metered(40), started_at: clock, ended_at: clock + 1, stop_reason: 'owner', owner_active: true });
  assert.equal(go(6, ana, 20).ok, true);
}));

test('a job run with no known window keeps its metered usage in an unwindowed entry that moves no %', () => withLedger(ledger => {
  const h = ledger.reserve({ account: 'codex', job_digest: 'j', attempt_id: 'a', budget_units: 50, unit: 'codex_credits', model: 'gpt-6-sol', plan: 'pro' }).reservation;
  assert.deepEqual(h.windows, []);
  const [e] = ledger.reconcile(h.id, { metered: { priced_units: 42, unit: 'codex_credits', model: 'gpt-6-sol', family: 'gpt-6', tokens: { output: 1 }, list_usd_micros: 9 }, started_at: clock, ended_at: clock + 1 }).entries;
  assert.equal(e.window_id, 'unknown'); assert.equal(e.attribution, 'unwindowed'); assert.equal(e.priced_units, 42); assert.equal(e.lent_pts, 0);
  ledger.recordReadings('codex', [{ window_id: 'codex:10080', window_minutes: 10080, used_pct: 20, resets_at: clock + WEEK, observed_at: clock + 2, state: 'open', source: 'probe' }]);
  const w = ledger.snapshot('codex', { plan: 'pro' }).windows;
  assert.equal(w.length, 1); assert.equal(w[0].lent_pct, 0);
}));

test('NNLS fit recovers planted per-family constants and never goes negative', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const a = (i * 7) % 11 + 1, b = (i * 3) % 5;
    rows.push({ y: 0.004 * a + 0.002 * b, x: { 'gpt-6': a, 'gpt-5': b }, w: 1 });
  }
  const fit = fitKappa(rows, ['gpt-6', 'gpt-5']);
  assert.ok(Math.abs(fit.kappa['gpt-6'] - 0.004) < 1e-9); assert.ok(Math.abs(fit.kappa['gpt-5'] - 0.002) < 1e-9);
  assert.ok(fit.r2 > 0.999);
  const negative = fitKappa(rows.map(r => ({ ...r, y: 0.004 * r.x['gpt-6'] - 0.001 * r.x['gpt-5'] })), ['gpt-6', 'gpt-5']);
  assert.equal(negative.kappa['gpt-5'], 0);
});

function plantBins(ledger, { kappa, bins = 14, model = 'gpt-6-sol', plan = 'pro', start = clock - 5 * 24 * HOUR }) {
  const reset = start + 6 * 24 * HOUR;
  let used = 10;
  const r = (u, at) => ({ window_id: 'codex:10080', window_minutes: 10080, used_pct: u, resets_at: reset, observed_at: at, state: 'open', source: 'probe' });
  for (let i = 0; i < bins; i++) {
    const bin = Math.floor(start / (6 * HOUR)) * 6 * HOUR + i * 6 * HOUR;
    const t = clock;
    clock = bin + HOUR;
    ledger.recordReadings('codex', [r(used, bin - 10 * 60000)]);
    const units = 600 + 300 * (i % 4);
    const h = ledger.reserve({ account: 'codex', job_digest: 'j' + i, attempt_id: 'a' + i + ':' + start, budget_units: 1, unit: 'codex_credits', model, plan }).reservation;
    used += kappa * units;
    ledger.recordReadings('codex', [r(used, bin + 5 * HOUR)]);
    ledger.reconcile(h.id, { metered: { priced_units: units, unit: 'codex_credits', model, family: 'gpt-6' }, started_at: bin + HOUR, ended_at: bin + 2 * HOUR });
    clock = t;
  }
}

test('the ledger κ fit recovers a planted constant from 6-hour bins, replacing the prior', () => withLedger(ledger => {
  assert.equal(ledger.calibration('codex', 'codex:10080', { plan: 'pro', model: 'gpt-6-sol' }).source, 'prior_pro_gpt-6');
  plantBins(ledger, { kappa: 1 / 250 });
  const c = ledger.calibration('codex', 'codex:10080', { plan: 'pro', model: 'gpt-6-sol' });
  assert.ok(c.bins >= 10, String(c.bins));
  assert.equal(c.source, 'fit');
  assert.ok(Math.abs(c.kappa - 1 / 250) / (1 / 250) < 1e-6, String(c.kappa));
  // A plan change resets the fit: back to the new plan's prior (none for plus).
  const changed = ledger.calibration('codex', 'codex:10080', { plan: 'plus', model: 'gpt-6-sol' });
  assert.equal(changed.bins, 0); assert.equal(changed.kappa, null);
}));

test('forecast history: remaining owner demand from complete past windows at the current elapsed fraction', () => withLedger(ledger => {
  // Three complete past weeks sampled every 4 h, owner using 0.5 pts/h; the current window is 5/7 elapsed.
  const cur = RESET, rows = [];
  for (let k = 3; k >= 1; k--) {
    const reset = cur - k * WEEK;
    for (let t = reset - WEEK + HOUR; t < reset; t += 4 * HOUR) rows.push(week(Math.min(100, (t - (reset - WEEK)) / HOUR * 0.5), t, { resets_at: reset }));
    rows.push(week(84, reset - 1000, { resets_at: reset }));
  }
  rows.push(week(30, clock - 60000));
  ledger.recordReadings('claude', rows);
  const h = ledger.snapshot('claude', { plan: 'max20' }).windows[0].history;
  assert.equal(h.length, 3);
  for (const d of h) assert.ok(Math.abs(d - (84 - 60)) < 0.6, String(d));
}));

test('forecast history skips gappy tails and windows cut short by an early reset', () => withLedger(ledger => {
  const rows = [], gappy = RESET - 2 * WEEK, cut = RESET - WEEK;
  for (let t = gappy - WEEK + HOUR; t < gappy; t += 8 * HOUR) rows.push(week(10, t, { resets_at: gappy }));
  // The window ending at `cut` was replaced early: the current window's first reading comes two days before it.
  for (let t = cut - WEEK + HOUR; t < cut - 2 * 24 * HOUR; t += 4 * HOUR) rows.push(week(10, t, { resets_at: cut }));
  rows.push(week(1, cut - 2 * 24 * HOUR + HOUR, { resets_at: RESET }), week(30, clock - 60000));
  ledger.recordReadings('claude', rows);
  assert.deepEqual(ledger.snapshot('claude', { plan: 'max20' }).windows[0].history, []);
}));

// Isolated cut-short cases, each with a dense tail (readings every 2 h up to the reset), so the gap rule cannot fire.
function denseWeek(reset, usedAt) {
  const rows = [];
  for (let t = reset - WEEK + HOUR; t < reset; t += 2 * HOUR) rows.push(week(usedAt(t), t, { resets_at: reset }));
  return rows;
}
test('forecast history skips a window whose allowance was reset early inside it (reset credit), dense tail', () => withLedger(ledger => {
  const past = RESET - WEEK, credit = past - 2 * 24 * HOUR;
  // Utilisation drops to 0 two days before the scheduled reset; resets_at is unchanged.
  const rows = denseWeek(past, t => t < credit ? (t - (past - WEEK)) / HOUR * 0.5 : (t - credit) / HOUR * 0.1);
  rows.push(week(30, clock - 60000));
  ledger.recordReadings('claude', rows);
  assert.deepEqual(ledger.snapshot('claude', { plan: 'max20' }).windows[0].history, []);
}));
test('forecast history skips a window superseded by the next one before its reset, dense tail', () => withLedger(ledger => {
  const past = RESET - WEEK;
  const rows = denseWeek(past, t => (t - (past - WEEK)) / HOUR * 0.5);
  // The current window's first reading arrives a day before the old window's reset.
  rows.push(week(1, past - 24 * HOUR), week(30, clock - 60000));
  ledger.recordReadings('claude', rows);
  assert.deepEqual(ledger.snapshot('claude', { plan: 'max20' }).windows[0].history, []);
}));
test('a complete dense window is still used (control for the two cut-short cases)', () => withLedger(ledger => {
  const past = RESET - WEEK;
  ledger.recordReadings('claude', [...denseWeek(past, t => (t - (past - WEEK)) / HOUR * 0.5), week(30, clock - 60000)]);
  assert.equal(ledger.snapshot('claude', { plan: 'max20' }).windows[0].history.length, 1);
}));

test('same-account check: snapshot match alone is unknown; two moving readings an hour apart are yes; a new reset invalidates', () => withLedger(ledger => {
  const g = (u, at) => [week(u, at)], hst = (u, at, reset = RESET) => [week(u, at, { resets_at: reset + 700, source: 'host' })];
  assert.equal(ledger.recordSameAccount('claude', { at: clock, guest: g(37, clock), host: hst(37, clock) }), 'unknown');
  assert.equal(ledger.recordSameAccount('claude', { at: clock + 30 * 60000, guest: g(38, clock), host: hst(38, clock) }), 'unknown');
  assert.equal(ledger.recordSameAccount('claude', { at: clock + 2 * HOUR, guest: g(41, clock), host: hst(42, clock) }), 'yes');
  assert.equal(ledger.snapshot('claude').same_account, 'yes');
  ledger.recordReadings('claude', [week(0, clock + 3 * HOUR, { resets_at: RESET + WEEK })]);
  assert.equal(ledger.snapshot('claude').same_account, 'unknown');
  assert.equal(sameAccountCheck([{ at: 0, guest: g(37, 0), host: hst(37, 0, RESET + 3600000) }]), 'no');
  assert.equal(sameAccountCheck([{ at: 0, guest: g(37, 0), host: hst(45, 0) }]), 'no');
  assert.equal(sameAccountCheck([{ at: 0, guest: g(37, 0), host: hst(37, 0) }, { at: 2 * HOUR, guest: g(37, 0), host: hst(37, 0) }]), 'unknown');
}));

test('κ priors: declared plans only; guesses are labeled', () => {
  assert.equal(kappaPrior('claude', 'max5', 'seven_day').kappa, 1 / 7);
  assert.match(kappaPrior('claude', 'max20', 'five_hour').source, /^guess_/);
  assert.equal(kappaPrior('claude', 'pro', 'seven_day'), null);
  assert.equal(kappaPrior('codex', 'pro', 'codex:10080', 'gpt-5').kappa, 1 / 500);
  assert.equal(kappaPrior('codex', 'unknown', 'codex:10080', 'gpt-6'), null);
});

test('no lending module reads or writes a credential or host log (static check plus mtime check)', () => {
  for (const name of ['lending-meter.mjs', 'lending-ledger.mjs', 'lending-probe.mjs']) {
    const src = readFileSync(new URL('../lib/v1/' + name, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(src, /(^|[^A-Za-z0-9_])\.(claude|codex)(?![A-Za-z0-9_])|credentials|auth\.json|homedir|process\.env|sessions/, name);
    if (name !== 'lending-ledger.mjs') assert.doesNotMatch(src, /node:fs/, name);
  }
  const home = scratch();
  try {
    const files = [join(home, '.claude', '.credentials.json'), join(home, '.codex', 'auth.json')];
    for (const f of files) { mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, '{}'); }
    const before = files.map(f => statSync(f).mtimeMs);
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `import {createLendingLedger} from ${JSON.stringify(new URL('../lib/v1/lending-ledger.mjs', import.meta.url).href)};
const l=createLendingLedger({file:${JSON.stringify(join(home, 'state', 'ledger.json'))}});l.snapshot('claude');l.snapshot('codex');l.recover();`], { env: { ...process.env, HOME: home } });
    assert.equal(run.status, 0, String(run.stderr));
    assert.deepEqual(files.map(f => statSync(f).mtimeMs), before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('window movement without a lent job records account activity and survives restart',()=>withLedger((ledger,dir)=>{
 const at=clock;ledger.recordReadings('claude',[week(10,at-60000),week(11,at)]);
 assert.equal(ledger.snapshot('claude',{plan:'max20'}).owner_active_at,at);
 const reopened=createLendingLedger({file:join(dir,'ledger.json'),now:()=>clock});
 assert.equal(reopened.snapshot('claude',{plan:'max20'}).owner_active_at,at);
 ledger.recordReadings('claude',[week(0,at+1000,{resets_at:RESET+WEEK})]);
 assert.equal(ledger.snapshot('claude',{plan:'max20'}).owner_active_at,at,'a reset is not owner activity');
}));

test('lent movement is not mistaken for owner activity after reconciliation',()=>withLedger(ledger=>{
 const at=clock;ledger.recordReadings('claude',[week(10,at-60000)]);
 const held=ledger.reserve({account:'claude',job_digest:'lent',attempt_id:'lent',budget_units:20,unit:'claude_usd',plan:'max20'});
 ledger.recordReadings('claude',[week(11,at+1000)]);
 ledger.reconcile(held.reservation.id,{metered:metered(20),started_at:at,ended_at:at+2000,stop_reason:'done'});
 ledger.recordReadings('claude',[week(12,at+3000)]);
 assert.equal(ledger.snapshot('claude',{plan:'max20'}).owner_active_at,null);
}));

test('read-only status snapshot does not record a plan change', () => withLedger((ledger, dir) => {
  ledger.recordReadings('codex',[week(58)]);
  const file=join(dir,'ledger.json'), before=readFileSync(file,'utf8');
  assert.equal(ledger.snapshotReadOnly('codex',{plan:'pro'}).windows[0].used_pct,58);
  assert.equal(readFileSync(file,'utf8'),before);
}));

// L1: exercise the actual imported ledger, not a copy of its attribution logic.
for (const reverse of [false, true]) test('shared observation bracket is not attributed twice: ' + (reverse ? 'reverse' : 'forward'), () => withLedger((ledger, dir) => {
  const saved = clock, t = clock, requester = { circle: 'shared', keyId: 'borrower' };
  try {
    ledger.recordReadings('claude', [week(10, t)]);
    const holds = [1, 3].map((minute, i) => {
      clock = t + minute * 60000;
      return ledger.reserve({ account: 'claude', job_digest: 'shared-' + i, attempt_id: 'shared-' + i,
        budget_units: 80, unit: 'claude_usd', plan: 'max20', requester }).reservation;
    });
    clock = t + 5 * 60000;
    ledger.recordReadings('claude', [week(18, clock)]);
    let current = ledger;
    for (const i of reverse ? [1, 0] : [0, 1]) {
      current.reconcile(holds[i].id, { metered: metered(80), started_at: t + (1 + i * 2) * 60000,
        ended_at: t + (2 + i * 2) * 60000 });
      current = createLendingLedger({ file: join(dir, 'ledger.json'), now: () => clock });
    }
    const entries = current.entries();
    assert.deepEqual(entries.map(e => e.attribution), ['overlapped', 'overlapped']);
    assert.equal(entries.reduce((sum, e) => sum + e.lent_pts, 0), 8);
    assert.equal(entries.reduce((sum, e) => sum + e.lent_lower_pts, 0), 0);
    assert.equal(current.snapshot('claude', { plan: 'max20' }).windows[0].owner_used_pct, 18,
      'uncertain estimates do not remove proven owner usage');
    assert.equal(current.requesterUsage(requester)[0].charged_pts, 8);
    assert.equal(current.reconcile(holds[0].id).already, true);
    assert.equal(current.entries().length, 2);
    assert.equal(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).schema_version, 1);
  } finally { clock = saved; }
}));

test('adjacent exclusive observation brackets retain exact attribution', () => withLedger(ledger => {
  const saved = clock, t = clock;
  try {
    ledger.recordReadings('claude', [week(10, t)]);
    for (let i = 0; i < 2; i++) {
      clock = t + (1 + i * 3) * 60000;
      const hold = ledger.reserve({ account: 'claude', job_digest: 'exclusive-' + i, attempt_id: 'exclusive-' + i,
        budget_units: 80, unit: 'claude_usd', plan: 'max20' }).reservation;
      ledger.recordReadings('claude', [week(14 + 4 * i, t + (3 + i * 3) * 60000)]);
      const [entry] = ledger.reconcile(hold.id, { metered: metered(80), started_at: clock,
        ended_at: clock + 60000 }).entries;
      assert.equal(entry.attribution, 'exact');
      assert.equal(entry.lent_lower_pts, 4);
    }
    assert.equal(ledger.snapshot('claude', { plan: 'max20' }).windows[0].owner_used_pct, 10);
  } finally { clock = saved; }
}));

for (const method of ['reconcile', 'reconcileAttempt']) test('shared positive usage without kappa remains unresolved: ' + method, () => withLedger((ledger, dir) => {
  const saved = clock, t = clock, requester = { circle: 'shared', keyId: 'no-kappa' };
  const file = join(dir, 'ledger.json');
  try {
    ledger.recordReadings('claude', [week(10, t)]);
    const holds = [1, 3].map((minute, i) => {
      clock = t + minute * 60000;
      return ledger.reserve({ account: 'claude', job_digest: 'no-kappa-' + i, attempt_id: 'no-kappa-' + i,
        budget_units: 80, unit: 'claude_usd', requester }).reservation;
    });
    clock = t + 5 * 60000;
    ledger.recordReadings('claude', [week(18, clock)]);
    const stored = readFileSync(file, 'utf8');
    // Reopen to cover already stored no-kappa holds, not just admission.
    const current = createLendingLedger({ file, now: () => clock });
    const settle = i => current[method](method === 'reconcile' ? holds[i].id : holds[i].attempt_id,
      { metered: metered(80), stop_reason: 'done',
        started_at: t + (1 + i * 2) * 60000, ended_at: t + (2 + i * 2) * 60000 });
    for (const i of [0, 1, 1, 0]) {
      assert.throws(() => settle(i), { code: 'unresolved_attribution',
        reservation_id: holds[i].id, window_id: 'seven_day' });
      assert.equal(readFileSync(file, 'utf8'), stored, 'failed settlement preserves holds, entries and readings');
    }
    assert.equal(current.snapshotReadOnly('claude').holds, 2);
    assert.deepEqual(current.entries(), []);
    assert.deepEqual(current.requesterUsage(requester), []);
    assert.equal(current.snapshotReadOnly('claude').windows[0].owner_used_pct, 18);

    // Independent boundary observations isolate the jobs; no arbitrary split of
    // the shared 8-point aggregate and no mutation of the stored reservation.
    current.recordReadings('claude', [week(10, t + 60000), week(14, t + 2 * 60000),
      week(14, t + 3 * 60000), week(18, t + 4 * 60000)]);
    for (const i of [0, 1]) {
      const [entry] = settle(i).entries;
      assert.equal(entry.attribution, 'exact');
      assert.equal(entry.lent_pts, 4);
      assert.equal(entry.lent_lower_pts, 4);
      assert.equal(entry.priced_units, 80);
      assert.equal(settle(i).already, true);
    }
    assert.equal(current.snapshotReadOnly('claude').holds, 0);
    assert.equal(current.snapshotReadOnly('claude').windows[0].lent_pct, 8);
    assert.equal(current.requesterUsage(requester)[0].charged_pts, 8);
    assert.equal(current.entries().length, 2);
  } finally { clock = saved; }
}));

test('late bracket cannot reuse an earlier aggregate proof after a new interior reading', () => withLedger(ledger => {
  const saved = clock, t = clock;
  try {
    ledger.recordReadings('claude', [week(10, t)]);
    clock = t + 60000;
    const first = ledger.reserve({ account: 'claude', job_digest: 'early-proof', attempt_id: 'early-proof',
      budget_units: 80, unit: 'claude_usd', plan: 'max20' }).reservation;
    ledger.recordReadings('claude', [week(18, t + 5 * 60000)]);
    const [a] = ledger.reconcile(first.id, { metered: metered(80), started_at: clock, ended_at: t + 2 * 60000 }).entries;
    assert.equal(a.lent_lower_pts, 8);
    clock = t + 3 * 60000;
    const second = ledger.reserve({ account: 'claude', job_digest: 'late-proof', attempt_id: 'late-proof',
      budget_units: 80, unit: 'claude_usd', plan: 'max20' }).reservation;
    ledger.recordReadings('claude', [week(14, t + 2.5 * 60000)]);
    const [b] = ledger.reconcile(second.id, { metered: metered(80), started_at: clock, ended_at: t + 4 * 60000 }).entries;
    assert.equal(b.attribution, 'overlapped', 'execution does not overlap, but the previously assigned observation does');
    assert.equal(b.lent_lower_pts, 0);
    assert.equal(ledger.entries().reduce((sum, e) => sum + e.lent_lower_pts, 0), 8);
    assert.equal(ledger.snapshot('claude', { plan: 'max20' }).windows[0].owner_used_pct, 10);
  } finally { clock = saved; }
}));

test("earlier bracket cannot reuse a later job's aggregate proof after an interior reading", () => withLedger(ledger => {
  const saved = clock, t = clock;
  try {
    ledger.recordReadings('claude', [week(10, t)]);
    clock = t + 3 * 60000;
    const first = ledger.reserve({ account: 'claude', job_digest: 'early-proof', attempt_id: 'early-proof',
      budget_units: 80, unit: 'claude_usd', plan: 'max20' }).reservation;
    ledger.recordReadings('claude', [week(18, t + 5 * 60000)]);
    const [a] = ledger.reconcile(first.id, { metered: metered(80), started_at: clock, ended_at: t + 4 * 60000 }).entries;
    assert.equal(a.lent_lower_pts, 8);
    clock = t + 60000;
    const second = ledger.reserve({ account: 'claude', job_digest: 'late-proof', attempt_id: 'late-proof',
      budget_units: 80, unit: 'claude_usd', plan: 'max20' }).reservation;
    ledger.recordReadings('claude', [week(14, t + 2.5 * 60000)]);
    const [b] = ledger.reconcile(second.id, { metered: metered(80), started_at: clock, ended_at: t + 2 * 60000 }).entries;
    assert.equal(b.attribution, 'overlapped', 'execution does not overlap, but the previously assigned observation does');
    assert.equal(b.lent_lower_pts, 0);
    assert.equal(ledger.entries().reduce((sum, e) => sum + e.lent_lower_pts, 0), 8);
    assert.equal(ledger.snapshot('claude', { plan: 'max20' }).windows[0].owner_used_pct, 10);
  } finally { clock = saved; }
}));
