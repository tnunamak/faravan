import './helpers/no-browser.mjs';

import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingProbe, createLendingReadings, guestProbeScript} from '../lib/v1/lending-probe.mjs';

import {lendingReadiness} from '../lib/v1/lending-readiness.mjs';
import {LINES} from '../lib/v1/lending-status-copy.mjs';

// A usage reading is as old as its request, not as its runner's completion (cold-start money review 1101, two P2 findings).
// Deterministic clock and stubbed runner only: no sandbox, provider or network.
const T = Date.parse('2026-11-01T12:00:00Z');
const F = 60_000;
const H = {account: '1111222233334444', email: 'aaaa0000bbbb1111', org: '5555666677778888'};
// The guest output's marker key, taken from the shipped guest script so this file does not restate the protocol.
const MARKER = guestProbeScript('claude').match(/out=\{"(\w+)":1/)[1];
const CLAUDE_AUTH = {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'};
const line = ({status = 200, identity = {status: 200, account_sha256_16: H.account, email_sha256_16: H.email, org_sha256_16: H.org},
  attempts = {usage: 1, identity: 1}} = {}) => JSON.stringify({[MARKER]: 1, status, body: status === 200 ? {
  five_hour: {utilization: 40, resets_at: new Date(T + 3 * 3600e3).toISOString()},
  seven_day: {utilization: 20, resets_at: new Date(T + 4 * 86400e3).toISOString()},
  extra_usage: {is_enabled: false}} : {}, attempts, identity, guest_auth: CLAUDE_AUTH}) + '\n';

function fakeTime(start = T) {
  let t = start, seq = 0;
  const timers = new Map();
  const drain = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  return {now: () => t, set: at => { t = at; },
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, {at: t + Math.max(0, ms), fn}); return id; },
    clearTimer: id => { timers.delete(id); },
    async advanceTo(until) {
      for (;;) {
        await drain();
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next || next[1].at > until) break;
        timers.delete(next[0]); t = Math.max(t, next[1].at); next[1].fn(); await drain();
      }
      t = Math.max(t, until); await drain();
    }};
}

function ledgerFor(t, clock) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'probe-fresh-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return createLendingLedger({file: join(directory, 'ledger.json'), now: clock.now});
}

test('a reading is stamped at its request start, not when a slow teardown lets the runner return', async t => {
  const clock = fakeTime();
  const ledger = ledgerFor(t, clock);
  // The usage answer is read at once; Stop, run completion and sandbox removal then take 40 s.
  const probe = createLendingProbe({ledger, now: clock.now, runGuest: async () => { clock.set(clock.now() + 40_000); return {exitCode: 0, stdout: line()}; }});
  const result = await probe.probe('claude');
  assert.equal(result.ok, true);
  assert.equal(clock.now(), T + 40_000);
  assert.ok(result.readings.every(r => r.observed_at === T), 'every reading carries the request start');
  assert.equal(probe.funding('claude').observed_at, T, 'the same-run fact carries the request start');
  assert.equal(ledger.snapshot('claude', {plan: 'unknown'}).read_at, T, 'the ledger records the request start');
});

test('a runner may name a later usage arrival, but never one before the probe began or after it returned', async t => {
  const clock = fakeTime();
  let requestedAt, overridden = false;
  const probe = createLendingProbe({ledger: ledgerFor(t, clock), now: clock.now, runGuest: async () => {
    clock.set(T + 25_000); const at = overridden ? requestedAt : clock.now(); clock.set(T + 40_000);
    return {exitCode: 0, stdout: line(), usage_seen_at: at};
  }});
  assert.equal((await probe.probe('claude')).readings[0].observed_at, T + 25_000, 'the sandbox boot does not age the reading');
  for (const bad of [T - 1, T + 40_001, 'soon', null]) {
    clock.set(T); requestedAt = bad; overridden = true;
    assert.equal((await probe.probe('claude')).readings[0].observed_at, T, `usage_seen_at ${String(bad)} falls back to the probe start`);
  }
});

test('a Claude identity 429 with a usage 200 backs off like a usage 429, and a forced check inside the back-off makes no request', async t => {
  const clock = fakeTime();
  const ledger = ledgerFor(t, clock);
  let runs = 0;
  const probe = createLendingProbe({ledger, now: clock.now, runGuest: async () => {
    runs++; return {exitCode: 0, stdout: line({identity: {status: 429}, attempts: {usage: 1, identity: 3}})};
  }});
  const result = await probe.probe('claude');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rate_limited');
  assert.equal(result.status_class, '4xx');
  assert.equal(result.retry_at, T + 5 * 60_000);
  assert.equal(probe.funding('claude'), null, 'no funding or identity fact is kept from a rate-limited run');
  assert.equal(ledger.snapshot('claude', {plan: 'unknown'}).read_at, null, 'no reading is recorded from a rate-limited run');

  clock.set(T + 60_000);
  assert.equal(probe.due('claude', {force: true}), false, 'a forced check waits out the back-off');
  const readings = createLendingReadings({ledger, probe, now: clock.now});
  const snap = await readings('claude', {forceRefresh: true});
  assert.equal(snap.probe?.reason, 'rate_limited', 'a skip inside the back-off keeps the rate-limit failure');
  assert.equal(snap.probe?.retry_at, T + 5 * 60_000, 'and its retry time');
  assert.equal(runs, 1, 'no request reached the rate-limited endpoint inside the back-off');

  // The back-off doubles on the next identity 429, as it does for usage.
  clock.set(T + 5 * 60_000);
  assert.equal((await probe.probe('claude')).retry_at, T + 5 * 60_000 + 10 * 60_000);
});

test('a probe already running during invalidation cannot restore the older facts', async t => {
  let release;
  const clock = fakeTime();
  const probe = createLendingProbe({ledger:ledgerFor(t, clock), now:clock.now, runGuest:async () => {
    await new Promise(resolve=>{release=resolve;});
    return {stdout:line(),executor:{backend_id:'test',sbx_version:'A'}};
  }});
  t.after(() => { release(); return probe.close(); });
  const running = probe.probe('claude');
  assert.equal(probe.outcome('claude').outcome, 'pending');
  probe.invalidateFacts('executor_changed');
  assert.equal(probe.outcome('claude'), null);
  assert.equal(probe.latestAttempt('claude'), null);
  assert.equal(probe.lastResult('claude'), null);
  assert.equal(probe.inFlight('claude'), true, 'the old transport still owns its sandbox while draining');
  release();
  assert.equal((await running).ok, false);
  assert.equal(probe.funding('claude'), null);
  assert.equal(probe.successfulResult('claude'), null);
  assert.equal(probe.outcome('claude'), null);
  assert.equal(probe.latestAttempt('claude'), null);
  assert.equal(probe.lastResult('claude'), null);
  assert.equal(probe.inFlight('claude'), false);
});

for (const status of [401, 429]) test(`invalidation clears a completed HTTP ${status} outcome from readiness`, async t => {
  const clock = fakeTime();
  const ledger = ledgerFor(t, clock);
  const probe = createLendingProbe({ledger, now:clock.now,
    runGuest:async () => ({stdout:line({status})})});
  t.after(() => probe.close());
  await probe.probe('claude');
  const readiness = () => lendingReadiness({provider:'claude', signedIn:true,
    observation:{evidence_pending:true, probe_outcome:probe.outcome('claude')}}).filter(row => row.id !== 'signed_in');
  assert.equal(probe.outcome('claude').outcome, 'failed');
  assert.ok(readiness().every(row => row.line !== LINES.evidence));
  const backoff = probe.backoffUntil('claude');

  probe.invalidateFacts('executor_changed');

  assert.equal(probe.outcome('claude'), null);
  assert.equal(probe.latestAttempt('claude'), null);
  assert.equal(probe.lastResult('claude'), null);
  assert.equal(probe.inFlight('claude'), false);
  assert.ok(readiness().every(row => row.line === LINES.evidence));
  assert.equal(probe.backoffUntil('claude'), backoff);
  if (status === 429) {
    assert.equal(backoff, T + 5 * F);
    assert.equal(probe.due('claude', {force:true}), false);
  }
});

test('an invalidated probe rejection cannot restore an obsolete failure', async t => {
  const clock = fakeTime();
  const failure = new Error('ledger write failed');
  const probe = createLendingProbe({now:clock.now,
    ledger:{recordReadings() { probe.invalidateFacts('executor_changed'); throw failure; }},
    runGuest:async () => ({stdout:line()})});
  t.after(() => probe.close());

  await assert.rejects(probe.probe('claude'), error => error === failure);

  assert.equal(probe.outcome('claude'), null);
  assert.equal(probe.latestAttempt('claude'), null);
  assert.equal(probe.lastResult('claude'), null);
  assert.equal(probe.inFlight('claude'), false);
});

// After a restart the process has no probe fact, so the first reserve holds with pending evidence and requests a probe. The
// owner already accepted the job, so reserve waits for that probe once instead of declining and asking again after the re-offer
// delay. A probe slower than the bound still declines with the same reason as before.

// An approved job's claim previews against the saved reading. When that reading is older than the freshness bound and its
// 5-hour window is not open, the window reads as unknown and the claim used to release the job at once. The gate now waits for
// the probe it already requested, inside the same bound reserve uses, and decides on the fresh reading. A probe that outlasts
// the bound still refuses with the same reason.

// The stop receipt is independent of the reading: it stands for 0 <= age < 24 h and is not tied to the 15-minute reading age. A
// reading that is old by the reading rule does not weaken it, and a fresh reading does not extend it.

// Upgrade from .73: readings saved before the upgrade carried stop and executor facts in memory only. After a restart no account
// reads as proven, a receipt is never made from old readings, and a fresh host read for one account rebinds that account only.
