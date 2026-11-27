import './helpers/no-browser.mjs';
import {settlePaceAtBound} from './helpers/lending-settle-at-bound.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {parseClaudeUsage} from '../lib/v1/lending-meter.mjs';
import {createRealPace50Source, paceInputFromObservation} from './helpers/real-source.mjs';
import {createEstimatedPace50State, evaluateEstimatedPace50} from '../lib/v1/lending-policy.mjs';
import {createNativeGuard} from '../lib/v1/lending-native-guard.mjs';
import {withWindowOrigins} from '../lib/v1/lender-pace50.mjs';
import {createWindowOriginStore} from '../lib/v1/window-origin.mjs';
import {lendingStatus} from '../lib/v1/lending-status-copy.mjs';
import {NATIVE_WINDOW_WEIGHTS} from '../lib/v1/quota-registry.mjs';
import {ordinaryInput, request, WEEK, MICRO as M} from './helpers/pace50-fixtures.mjs';

// An idle owner: no five-hour session open, so the provider answers `"five_hour": null`, with a fresh seven-day reading.
// Synthetic evidence only. The readings go through the production parser, ledger, source and policy. No provider, browser,
// network or Docker.
const T = Date.parse('2026-11-01T17:40:00.250Z');
const H = 3_600_000, FIVE_H = 5 * H;
const HASH = {account: '1111222233334444', email: 'aaaa0000bbbb1111'};
const AUTH = {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'};
const weeklyBody = {utilization: 20, resets_at: new Date(T + 42 * H).toISOString()};
const idleBody = {five_hour: null, seven_day: weeklyBody, extra_usage: {is_enabled: false}};

// One ledger that the probe writes, read the way the app reads it.
function ledgerAt(t, clock) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'cold-short-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return createLendingLedger({file: join(directory, 'ledger.json'), now: () => clock.at});
}
const record = (ledger, body, at) => ledger.recordReadings('claude', parseClaudeUsage(body, at).readings);

// The real source over that ledger. `factAt` is the time of the run that read the identity, funding, executor and stop.
function sourceOver(ledger, {factAt, refresh = async () => {}}) {
  return createRealPace50Source({
    readings: async (provider, options) => { await refresh(options); return ledger.snapshot('claude'); },
    funding: () => ({extra_usage: 'disabled', observed_at: factAt(), guest_auth: AUTH,
      identity: {account_sha256_16: HASH.account, email_sha256_16: HASH.email},
      executor: {backend_id: 'docker-sbx', sbx_version: 'sbx version v0.49.2'},
      stop: {delivered: true, fallback: null, latency_ms: 1, removed: true}}),
    expectedIdentity: () => ({email_sha256_16: HASH.email}),
    expectedExecutor: {backend_id: 'docker-sbx', accepts: () => true}, stopBoundMs: 1000, stopAnswerMs: 500,
    windowOrigin: () => new Map(),
  });
}

// The policy input the lender builds from the observation, with the normal rule at the dial: no stubbed decision.
function policyInput(observation, now) {
  const input = paceInputFromObservation(observation, {now, context: {consent: true, people: true, agents: true, schedule: true,
    unexpired: true, intent: 'on', ownerAbsent: true}});
  if (input.refuse) return input;
  const provider = 'claude', model = 'claude-sonnet-5-5';
  const p = ordinaryInput({now, windows: input.windows});
  Object.assign(p, {account: input.account, account_week_id: WEEK, weekly_resource_id: input.weekly_resource_id, epoch: input.epoch, controls: input.controls,
    evidence: {...p.evidence, ...input.evidence}});
  p.state = createEstimatedPace50State({account: input.account, account_week_id: WEEK});
  p.request = request({requested_usd_micro: 3 * M, provider, model, expires_at: now + 7 * 24 * H});
  p.objective.ruleDial = .5;
  p.objective.job = {...p.objective.job, provider, model, requestedUsdMicro: 3 * M, nativeCostBounds: {unit: 'usd', lower: 3, upper: 3}};
  p.objective.ruleEvidence = {
    snapshot: {account: input.account, windows: p.windows.map(w => ({window_id: w.id, window_minutes: w.duration_ms / 60_000,
      used_pct: w.used_micro / M, resets_at: w.resets_at, observed_at: w.observed_at, state: 'open', lent_pct: 0, reserved_pct: 0}))},
    applicableResources: {account: input.account, provider, model, complete: true, ids: p.windows.map(w => w.id)},
    entries: [], history: [], roundingPoints: Object.fromEntries(p.windows.map(w => [w.id, 0])),
    lagBounds: Object.fromEntries(p.windows.map(w => [w.id, {providerLagMs: 0, maxPointsPerHour: 0,
      provenance: 'Synthetic synchronous bounded account.'}])),
    quotaRegistry: {version: 'synthetic/1', complete: true, limits: p.windows.map(w => ({id: w.id, provider, unit: 'quota_percent',
      capacity: 100, durationMs: w.duration_ms, reset: {kind: 'first-use'}, scope: {kind: 'account'},
      weights: {version: NATIVE_WINDOW_WEIGHTS, nativeUnit: 'quota_percent', byModel: {}}}))}};
  return p;
}

// The ledger shape seen on 2026-11-01: the last five-hour row is a session that closed the day before, and the seven-day row
// is read every 15 minutes since.
function lastSessionClosed(ledger) {
  record(ledger, {five_hour: {utilization: 31, resets_at: new Date(T - 25 * H).toISOString()}, seven_day: weeklyBody,
    extra_usage: {is_enabled: false}}, T - 25.5 * H);
}

// The real lender, from admission on a cold window to a settlement read of the window the job opened.
async function coldLender(t, {phase, configureSource = () => {}}) {
  const {createPace50Candidate} = await import('../lib/v1/lender-pace50.mjs');
  const {createSyntheticPace50Source} = await import('./helpers/pace50-synthetic-source.mjs');
  const {ACCOUNT, NOW} = await import('./helpers/pace50-fixtures.mjs');
  let at = NOW;
  const timers = new Map();
  let seq = 0;
  const setTimer = (fn, ms) => { timers.set(++seq, {due: at + ms, fn}); return seq; };
  const clearTimer = id => timers.delete(id);
  const drain = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  const advanceTo = async until => {
    for (;;) {
      await drain();
      const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > until) break;
      timers.delete(next[0]); at = next[1].due; next[1].fn(); await drain();
    }
    at = until; await drain();
  };
  const synthetic = createSyntheticPace50Source({start: NOW, account: ACCOUNT, accountWeek: WEEK, override: ({base, now}) => ({...base,
    ...(phase.provenUntil ? {stop: {...base.stop, proven_until: phase.provenUntil}} : {}),
    resources: base.resources.map(r => {
      const native = {...r, conversion: 'native_window', kappa_micro: null, kappa_lower_micro: null};
      if (r.id !== 'five_hour') return {...native, used_micro: native.used_micro + phase.weeklyRise};
      if (phase.open === null) {
        const reset = Math.floor((now + FIVE_H) / 1000) * 1000;
        return {...native, instance: `five_hour@${reset}`, anchor_at: reset - FIVE_H, resets_at: reset, used_micro: 0, owner_used_micro: 0,
          origin: 'cold', cold_open: true};
      }
      return {...native, instance: `five_hour@${phase.open + FIVE_H}`, anchor_at: phase.open, resets_at: phase.open + FIVE_H,
        used_micro: phase.used, owner_used_micro: phase.used, origin: null};
    })})});
  configureSource(synthetic);
  const directory = fs.mkdtempSync(join(tmpdir(), 'cold-lender-'));
  const windowOrigins = createWindowOriginStore({directory: join(directory, 'window-origin')});
  const pace = createPace50Candidate({postingLagBoundMs:120000,directory, now: () => at, account: ACCOUNT, account_week_id: WEEK, source: synthetic, windowOrigins,
    ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 10})}, pendingRecords: () => [], nativeGuard: {setTimer, clearTimer}});
  t.after(async () => { await pace.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  return {pace, source: synthetic, NOW, advanceTo, windowOrigins, set: v => { at = v; },
    closeAtBound:()=>settlePaceAtBound(pace,v=>{at=v;}),
    async finishAndSweepAfterLag(args) {
      await pace.candidate.finish(args);
      at += 120_000;
      await pace.candidate.probeHeld();
      return pace.candidate.finish(args);
    }};
}

test('through the lender: a job whose window still shows as not open retains blind use', async t => {
  const phase = {open: null, used: 0, weeklyRise: M};
  const s = await coldLender(t, {phase});
  const job = {requirements: {limits: {wall_seconds: 600}}, expires_at: new Date(s.NOW + 3600e3).toISOString()};
  assert.equal((await s.pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: 'claude-sonnet-5-5',
    job, automatic: true, ownerAbsent: true})).ok, true);
  await s.pace.candidate.started('attempt-1', {ok: true});
  await s.advanceTo(s.NOW + 45_000);
  assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, null);
  s.pace.candidate.recordCleanup('attempt-1', {removed: true});
  await s.finishAndSweepAfterLag({attemptId: 'attempt-1', provider: 'claude', model: 'claude-sonnet-5-5',
    execution: {stdout: '', lending_meter: {final: true, cost_usd: 0.5}}});
  const attempt = s.pace.adapter.state().attempts[0];
  assert.equal(attempt.hold_closed, false);
  assert.ok(attempt.resources.filter(r=>!r.cold_open).every(r=>r.spent_micro>=M));
  assert.ok(attempt.resources.filter(r=>r.cold_open).every(r=>r.spent_micro===0&&r.held_micro===r.initial_micro));
  await s.closeAtBound();
});

// Round 3 (the money review of 2d55d4a2): who opened the window, a late first use, and reset jitter.
const longJob = NOW => ({requirements: {limits: {wall_seconds: 1800}}, expires_at: new Date(NOW + 3600e3).toISOString()});
async function runCold(t, phase, {openAt, used, advance}) {
  const s = await coldLender(t, {phase});
  const job = longJob(s.NOW);
  assert.equal((await s.pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: 'claude-sonnet-5-5',
    job, automatic: true, ownerAbsent: true})).ok, true);
  await s.pace.candidate.started('attempt-1', {ok: true});
  const reserved = s.pace.adapter.state().attempts[0].resources.find(r => r.id === 'five_hour');
  await s.advanceTo(s.NOW + Math.max(0, openAt - s.NOW - 1));
  Object.assign(phase, {open: openAt, used, weeklyRise: M});
  await s.advanceTo(s.NOW + advance);
  return {s, job, reserved};
}
const finishAndSettle = async s => {
  s.pace.candidate.recordCleanup('attempt-1', {removed: true});
  await s.finishAndSweepAfterLag({attemptId: 'attempt-1', provider: 'claude', model: 'claude-sonnet-5-5',
    execution: {stdout: '', lending_meter: {final: true, cost_usd: 0.5}}});
  return s.pace.adapter.state().attempts[0];
};


// Jitter: the provider's reset for one window moves by a few seconds between reads. The guard matches within 60 s, and the stop
// deadline never moves later.
function jitterGuard() {
  let at = T;
  const stops = [];
  const guard = createNativeGuard({now: () => at, setTimer: () => 0, clearTimer: () => {}, read: async () => null,
    stop: (id, reason) => stops.push(reason)});
  const reset = Math.floor((T + FIVE_H) / 1000) * 1000;
  const reading = (when, resetsAt) => ({refresh_succeeded: true, complete: true, observed_at: when, epoch: 'e',
    identity: {verified: true, account_id: HASH.account}, funding: {subscription_only: 'proven'},
    resources: [{id: 'seven_day', instance: 'w', resets_at: T + 42 * H, used_micro: 20 * M},
      {id: 'five_hour', instance: `five_hour@${resetsAt}`, state: 'open', resets_at: resetsAt, anchor_at: resetsAt - FIVE_H, used_micro: M}]});
  guard.watch({attemptId: 'j', provider: 'claude', accountId: HASH.account, epoch: 'e', lastFreshAt: T, cold: ['five_hour'],
    resources: [{id: 'seven_day', instance: 'w', resets_at: T + 42 * H, baseline_used_micro: 20 * M, initial_micro: 5 * M},
      {id: 'five_hour', instance: `five_hour@${reset}`, resets_at: reset, baseline_used_micro: 0, initial_micro: 5 * M}]});
  return {guard, stops, reset, reading, at: v => { at = v; }};
}

// Real parser, ledger, source and durable candidate; only strategy history is fixture evidence.
async function settlementReviewRig(t, {localAccount = HASH.account} = {}) {
  const {createPace50Candidate, NATIVE_SETTLEMENT_DELAY_MS} = await import('../lib/v1/lender-pace50.mjs');
  const {createSyntheticPace50Source} = await import('./helpers/pace50-synthetic-source.mjs');
  const clock = {at: T}, probes = [];
  const ledger = ledgerAt(t, clock);
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-review-'));
  let fact = T, body = idleBody;
  const source = sourceOver(ledger, {factAt: () => fact, refresh: async options => {
    if (!options.forceRefresh) return;
    probes.push(clock.at);
    fact = clock.at; record(ledger, body, fact);
  }});
  const open = () => createPace50Candidate({postingLagBoundMs:120000,directory, now: () => clock.at, source, account: localAccount,
    account_week_id: `${HASH.account}:weekly:${T + 42 * H}`,
    objectiveInputFor: createSyntheticPace50Source({start: T}).objectiveInputFor,
    ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 10})}});
  record(ledger, idleBody, T);
  let pace = open();
  t.after(async () => { await pace.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const attemptId = 'review-job';
  const grant = await pace.candidate.reserve({attemptId, jobId: 'review-job', provider: 'claude', model: 'claude-sonnet-5-5',
    job: {requirements: {limits: {wall_seconds: 1200}}, expires_at: new Date(T + H).toISOString()}, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await pace.candidate.started(attemptId, {ok: true});
  clock.at += 210_000;
  await pace.candidate.recordCleanup(attemptId, {removed: true});
  const cleanupAt = clock.at;
  return {clock, probes, source, cleanupAt, delay: NATIVE_SETTLEMENT_DELAY_MS ?? 120_000,
    get pace() { return pace; }, row: () => pace.adapter.state().attempts.find(a => a.id === attemptId),
    finish: () => pace.candidate.finish({attemptId, provider: 'claude', model: 'claude-sonnet-5-5',
      execution: {lending_meter: {final: true, tokens: {input: 1000, output: 100}}}}),
    restart: async () => { await pace.adapter.close(); pace = open(); },
    reading: value => { body = value; fact = clock.at; record(ledger, body, fact); },
  };
}

test('native settlement rejects a reading ten seconds after cleanup across restart and retains blind use after the lag delay', async t => {
  const rig = await settlementReviewRig(t);
  assert.equal(rig.delay, 120_000);
  await rig.restart();
  rig.clock.at = rig.cleanupAt + 10_000;
  rig.reading(idleBody);
  await rig.pace.candidate.probeHeld();
  assert.equal(rig.row().hold_closed, false);
  assert.ok(rig.row().resources.every(r=>r.spent_micro===0), 'the read delay prevents even the floor charge');
  assert.equal(rig.probes.length, 0, 'the delay also suppresses premature forced probes');
  rig.clock.at = rig.cleanupAt + rig.delay;
  rig.reading(idleBody);
  await rig.pace.candidate.probeHeld();
  assert.equal(rig.row().hold_closed, false);
  assert.ok(rig.row().resources.every(r=>r.cold_open ? r.spent_micro===0&&r.held_micro===r.initial_micro : r.spent_micro>0));
  await settlePaceAtBound(rig.pace,v=>{rig.clock.at=v;});
});

test('native settlement holds for a different account or account week even when the epoch matches', async t => {
  const rig = await settlementReviewRig(t);
  rig.clock.at = rig.cleanupAt + rig.delay;
  rig.reading(idleBody);
  const observe = rig.source.observe.bind(rig.source);
  for (const patch of [{identity: {verified: true, account_id: 'different-account'}, account_week_id: 'different-account:weekly:1'},
    {account_week_id: 'different-week'}]) {
    rig.source.observe = async args => ({...await observe(args), ...patch});
    await rig.pace.candidate.probeHeld();
    assert.equal(rig.row().hold_closed, false, JSON.stringify(patch));
    assert.ok(rig.row().resources.every(r=>r.spent_micro===0), 'a mismatched identity records no charge');
  }
  rig.source.observe = observe;
  await rig.pace.candidate.probeHeld();
  assert.equal(rig.row().hold_closed, false);
  assert.ok(rig.row().resources.every(r=>r.cold_open ? r.spent_micro===0&&r.held_micro===r.initial_micro : r.spent_micro>0));
  await settlePaceAtBound(rig.pace,v=>{rig.clock.at=v;});
});

// The adapter account names the local store (a device key in the app), not the provider account.
test('native settlement matches the provider account week when the local store uses a device identity', async t => {
  const rig = await settlementReviewRig(t, {localAccount: 'local-device-key'});
  rig.clock.at = rig.cleanupAt + rig.delay;
  rig.reading(idleBody);
  await rig.pace.candidate.probeHeld();
  assert.equal(rig.row().hold_closed, false);
  assert.ok(rig.row().resources.every(r=>r.cold_open ? r.spent_micro===0&&r.held_micro===r.initial_micro : r.spent_micro>0));
  await settlePaceAtBound(rig.pace,v=>{rig.clock.at=v;});
});

for (const exhausted of [false, true]) {
  test(`bound recheck retries superseding evidence once (fresh exhausted: ${exhausted})`, async t => {
    const phase = {open:null, used:0, weeklyRise:0};
    let generation = 0, builds = 0;
    const s = await coldLender(t, {phase, configureSource(source) {
      const observe = source.observe.bind(source), builder = source.objectiveInputFor.bind(source);
      source.observe = async args => ({...await observe(args), evidence_generation:generation});
      source.admissionEvidence = observation => ({...observation,
        latest_attempt:observation.evidence_generation === generation ? observation.latest_attempt
          : {outcome:'failed', reason:'evidence_superseded'}});
      source.objectiveInputFor = async args => {
        const out = await builder(args);
        if (phase.open && ++builds === 1) { generation++; if (exhausted) phase.used = 100 * M; }
        return out;
      };
    }});
    assert.equal((await s.pace.candidate.reserve({attemptId:'attempt-1', jobId:'job-1', provider:'claude',
      model:'claude-sonnet-5-5', job:longJob(s.NOW), automatic:true, ownerAbsent:true})).ok, true);
    await s.pace.candidate.started('attempt-1', {ok:true});
    await s.advanceTo(s.NOW + 20 * 60_000 - 1);
    Object.assign(phase, {open:s.NOW + 20 * 60_000, used:2 * M, weeklyRise:M});
    await s.advanceTo(s.NOW + 21 * 60_000);
    const check = s.pace.candidate.registry.entry('attempt-1').boundRecheck;
    assert.equal(check.admitted, !exhausted, JSON.stringify(check));
    assert.equal(s.pace.candidate.nativeGuard.status('attempt-1').stop_reason, exhausted ? 'window_recheck' : null);
    assert.ok(builds <= 2, 'at most one rebuild');
  });
}
