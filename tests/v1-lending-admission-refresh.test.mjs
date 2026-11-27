import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingProbe, createLendingReadings} from '../lib/v1/lending-probe.mjs';
import {createRealPace50Source} from '../lib/v1/lending-pace50-source.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

const T = Date.parse('2026-11-02T12:00:00Z');
const identity = {status:200, account_sha256_16:'1111222233334444', email_sha256_16:'aaaabbbbccccdddd'};
function output(provider, at) {
  const body = provider === 'claude' ? {
    five_hour:{utilization:14, resets_at:new Date(T + 3 * 3600e3).toISOString()},
    seven_day:{utilization:14, resets_at:new Date(T + 4 * 86400e3).toISOString()}, extra_usage:{is_enabled:false},
  } : {plan_type:'pro', credits:{has_credits:false}, rate_limit:{allowed:true, limit_reached:false,
    primary_window:{used_percent:14, limit_window_seconds:604800, reset_at:(T + 4 * 86400e3) / 1000}}};
  return {stdout:JSON.stringify({faravan_probe:1, status:200, body, identity,
    guest_auth:{loggedIn:true, authMethod:'claude.ai', apiProvider:'firstParty'}}), usage_seen_at:at};
}
function fixture(t, provider, runner) {
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'admission-refresh-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const clock = {at:T};
  const ledger = createLendingLedger({file:join(directory, 'ledger.json'), now:() => clock.at});
  const probe = createLendingProbe({ledger, now:() => clock.at, runGuest:args => runner(args, clock)});
  t.after(() => probe.close());
  const readings = createLendingReadings({ledger, probe, now:() => clock.at});
  const source = createRealPace50Source({readings, funding:p => probe.funding(p),
    expectedIdentity:() => ({email_sha256_16:identity.email_sha256_16})});
  return {clock, probe, readings, source};
}

import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';

for (const provider of ['claude', 'codex']) for (const inFlight of [false, true])
  test(`${provider} 20 admission reads use cached quota without starting or waiting for a probe (${inFlight ? 'in flight' : 'idle'})`, async t => {
    let runs = 0, complete;
    const f = fixture(t, provider, async (args, clock) => {
      runs++;
      if (runs > 1) await new Promise(resolve => {complete = resolve;});
      return output(provider, clock.at);
    });
    await f.source.observe({provider});
    f.clock.at += 12 * 60_000;
    const background = inFlight ? f.probe.probe(provider) : null;
    let completed = 0;
    const pending = Array.from({length:20}, () => f.source.observe({provider, admissionOnly:true,
      maxAgeMs:30 * 60_000}).then(value => {completed++; return value;}));
    await new Promise(resolve => setImmediate(resolve));
    const completedBeforeProbeFinished = completed;
    if (inFlight) { complete(); await background; }
    const reads = await Promise.all(pending);
    assert.equal(completedBeforeProbeFinished, 20, 'admission never waits for the refresher');
    assert.equal(runs, inFlight ? 2 : 1, 'the burst adds zero probe calls');
    assert.ok(reads.every(row => row.refresh_succeeded === true));
    assert.ok(reads.every(row => row.resources.every(resource => resource.observed_at === T)));
  });

for (const provider of ['claude', 'codex']) for (const [minutes, used, allowed] of [[12, 14, true], [30, 14, true], [31, 14, true], [360, 14, false], [1, 90, true], [30, 90, false], [12, 100, false]])
  test(`${provider} admission uses ${minutes}-minute quota at ${used} percent without a probe`, async t => {
    const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'admission-cached-'));
    const at = T + minutes * 60_000;
    const source = createSyntheticPace50Source({start:T, used:{weekly:used * 1_000_000, short:14_000_000},
      override:({base}) => ({...base, observed_at:T, resources:base.resources.map(row => ({...row, observed_at:T}))})});
    const observe = source.observe;
    const calls = [];
    source.observe = args => {calls.push(args); assert.equal(args.admissionOnly, true); return observe(args);};
    const pace = createPace50Candidate({directory, now:() => at, source,
      account:'synthetic-account', account_week_id:'synthetic-week-1'});
    t.after(async () => {await pace.candidate.cancelObservations(); await pace.adapter.close(); fs.rmSync(directory, {recursive:true, force:true});});
    const grant = await pace.candidate.reserve({attemptId:'cached', jobId:'job-cached', provider,
      model:provider === 'claude' ? 'claude-haiku-5-5' : 'gpt-6-sol', automatic:false, ownerAbsent:true,
      job:{budget_v1:{max_list_usd:10}, requirements:{limits:{wall_seconds:300}},
        expires_at:new Date(T + 86400e3).toISOString()}});
    assert.equal(grant.ok, allowed, JSON.stringify(grant));
    if (allowed) assert.equal((await pace.candidate.admitStart('cached')).ok, true);
    assert.ok(calls.length <= 2, 'one saved observation per admission boundary');
  });

for (const provider of ['claude', 'codex']) test(`${provider} admission with no saved reading makes no probe call`, async t => {
  let runs = 0;
  const f = fixture(t, provider, async (args, clock) => {runs++; return output(provider, clock.at);});
  const observed = await f.source.observe({provider, admissionOnly:true});
  assert.equal(observed.refresh_succeeded, false);
  assert.equal(runs, 0);
});

import {readingAgeReserve, readingHeadroomMs} from '../lib/v1/lending-pace50-source.mjs';
import {createNativeGuard} from '../lib/v1/lending-native-guard.mjs';

test('age allowance uses the meter history high rate with the existing margin and cold-start fallback', () => {
  const row = {observed_at:T, used_micro:90_000_000, uncertainty_micro:1_000_000};
  assert.equal(readingAgeReserve({...row, max_rate_pct_per_hour:4}, T + 30 * 60_000), 3_000_000);
  assert.equal(readingAgeReserve({...row, max_rate_pct_per_hour:40}, T + 30 * 60_000), 30_000_000);
  assert.equal(readingAgeReserve(row, T + 30 * 60_000), 10_000_000);
});

test('cached reads report age without writing a plan or invoking the refresher', () => {
  let reads = 0;
  const readings = createLendingReadings({now:() => T + 30 * 60_000,
    ledger:{snapshotReadOnly:() => {reads++; return {read_at:T, windows:[]};},
      snapshot:() => assert.fail('admission cannot use the mutating snapshot')},
    probe:{due:() => assert.fail('cache reads do not schedule probes')}});
  assert.equal(readings.cached('claude').age_ms, 30 * 60_000);
  assert.equal(reads, 1);
});

test('a native guard accepts a recent cached baseline with ample headroom', () => {
  const row = {observed_at:T, used_micro:14_000_000, uncertainty_micro:1_000_000};
  const stops = [], timers = [];
  const guard = createNativeGuard({now:() => T + 30 * 60_000,
    setTimer:(fn, ms) => {timers.push(ms); return timers.length;}, clearTimer:() => {},
    read:async () => null, stop:(id, reason) => stops.push(reason)});
  guard.watch({attemptId:'cached-native', provider:'claude', accountId:'account', epoch:'epoch', lastFreshAt:T,
    freshnessMs:readingHeadroomMs(row), resources:[]});
  assert.deepEqual(stops, []);
  assert.ok(timers.some(ms => ms > 0), 'the stale deadline retains its initial grace');
  assert.ok(timers.some(ms => ms <= 30_000), 'polling keeps the normal cadence');
  guard.unwatch('cached-native');
});

for (const provider of ['claude', 'codex']) test(`${provider} a background 429 preserves the cached admission reading and backoff`, async t => {
  let runs = 0;
  const f = fixture(t, provider, async (args, clock) => {
    runs++;
    return runs === 1 ? output(provider, clock.at) : {stdout:JSON.stringify({faravan_probe:1, status:429})};
  });
  await f.probe.probe(provider);
  f.clock.at += 12 * 60_000;
  await f.probe.probe(provider);
  const backoffUntil = f.probe.backoffUntil(provider);
  const observed = await Promise.all(Array.from({length:20}, () => f.source.observe({provider, admissionOnly:true})));
  assert.equal(runs, 2);
  assert.ok(observed.every(row => row.refresh_succeeded === true));
  assert.equal(f.probe.due(provider, {force:true}), false);
  assert.equal(f.probe.backoffUntil(provider), backoffUntil);
});

for (const provider of ['claude', 'codex']) test(`${provider} a native job starts from a 30-minute cache without an immediate stale stop`, async t => {
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'admission-native-cache-'));
  const at = T + 30 * 60_000;
  const source = createSyntheticPace50Source({start:T, used:{weekly:14_000_000, short:14_000_000},
    override:({base}) => ({...base, observed_at:T, resources:base.resources.map(row => ({...row,
      observed_at:T, conversion:'native_window', kappa_micro:null, kappa_lower_micro:null}))})});
  const pace = createPace50Candidate({directory, now:() => at, source,
    account:'synthetic-account', account_week_id:'synthetic-week-1'});
  t.after(async () => {await pace.candidate.cancelObservations(); await pace.adapter.close(); fs.rmSync(directory, {recursive:true, force:true});});
  const grant = await pace.candidate.reserve({attemptId:'native-cache', jobId:'job-native-cache', provider,
    model:provider === 'claude' ? 'claude-haiku-5-5' : 'gpt-6-sol', automatic:false, ownerAbsent:true,
    job:{budget_v1:{max_list_usd:10}, requirements:{limits:{wall_seconds:300}},
      expires_at:new Date(T + 86400e3).toISOString()}});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  assert.equal((await pace.candidate.admitStart('native-cache')).ok, true);
  assert.equal(pace.candidate.nativeGuard.status('native-cache').stop_reason, null);
});

for (const provider of ['claude', 'codex']) test(`${provider} twenty cold job gates nudge one background probe without waiting`, async t => {
  let runs = 0, complete;
  const f = fixture(t, provider, async (args, clock) => {
    runs++;
    await new Promise(resolve => {complete = resolve;});
    return output(provider, clock.at);
  });
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'cold-gate-'));
  const pace = createPace50Candidate({directory, now:() => f.clock.at, source:f.source,
    account:'synthetic-account', account_week_id:'synthetic-week-1'});
  t.after(async () => {complete?.(); await pace.candidate.cancelObservations(); await pace.adapter.close(); fs.rmSync(directory, {recursive:true, force:true});});
  let done = 0;
  const gates = Array.from({length:20}, () => pace.candidate.gate({provider, jobId:'cold-job',
    model:provider === 'claude' ? 'claude-haiku-5-5' : 'gpt-6-sol', automatic:false, ownerAbsent:true,
    job:{budget_v1:{max_list_usd:10}, requirements:{limits:{wall_seconds:300}},
      expires_at:new Date(T + 86400e3).toISOString()}}).then(value => {done++; return value;}));
  await new Promise(resolve => setImmediate(resolve));
  const before = done, probes = runs;
  f.clock.at += 40_000;
  complete?.();
  await Promise.all(gates);
  assert.equal(before, 20, 'decisions do not wait for a cold probe');
  assert.equal(probes, 1, 'a burst requests exactly one background probe');
});

test('status surfaces share one projection for the same cached observation and durable revision', async t => {
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'status-age-'));
  let at = T;
  const source = createSyntheticPace50Source({start:T, override:({base}) => ({...base,
    observed_at:T, resources:base.resources.map(row => ({...row, observed_at:T}))})});
  const pace = createPace50Candidate({directory, now:() => at, source,
    account:'synthetic-account', account_week_id:'synthetic-week-1'});
  t.after(async () => {await pace.candidate.cancelObservations(); await pace.adapter.close(); fs.rmSync(directory, {recursive:true, force:true});});
  const args = {provider:'claude', model:'claude-haiku-5-5', snapshotOnly:true, ownerAbsent:true};
  await pace.candidate.observe({...args, now:at});
  const first = await pace.candidate.projectStatus(args);
  at += 500;
  const second = await pace.candidate.projectStatus(args);
  assert.deepEqual(second, first, 'transport timing cannot change one cached status revision');
});

for (const minutes of [2, 8, 600]) test(`failed refresh retains 87 percent weekly reading at ${minutes} minutes`, async t => {
  let runs = 0;
  const f = fixture(t, 'codex', async (args, clock) => {
    runs++;
    if (runs > 1) throw new Error('guest unavailable');
    const result = output('codex', clock.at);
    const envelope = JSON.parse(result.stdout);
    envelope.body.spend_control = {reached:false};
    envelope.body.rate_limit.primary_window.used_percent = 87;
    envelope.body.rate_limit.primary_window.reset_at = (T + 72 * 3600e3) / 1000;
    return {...result, stdout:JSON.stringify(envelope)};
  });
  await f.probe.probe('codex');
  f.clock.at += minutes * 60_000;
  await f.probe.probe('codex');
  const observed = await f.source.observe({provider:'codex', admissionOnly:true});
  assert.equal(observed.refresh_succeeded, true);
  assert.equal(observed.identity.verified, true);
  assert.equal(observed.funding.subscription_only, 'proven');
  assert.equal(observed.resources[0].observed_at, T);
  assert.equal(observed.probe, null, 'saved windows retain successful provenance');
  assert.equal(observed.latest_attempt.reason, 'guest_failed', 'the failed attempt remains visible separately');
  const row = observed.resources[0];
  assert.equal(row.used_micro + row.uncertainty_micro + readingAgeReserve(row, f.clock.at) < 100_000_000, minutes < 600);
  for (let i = 0; i < 20; i++) await f.source.observe({provider:'codex', admissionOnly:true});
  assert.equal(runs, 2, 'polling does not retry the probe');
  assert.equal(f.probe.due('codex', {autoLending:true}), false);
});

test('admission can use a failed-refresh snapshot only with matching saved funding and identity', async () => {
  const snapshot = {refresh_succeeded:false, windows:[{window_id:'codex:10080', window_minutes:10080,
    used_pct:87, resets_at:T + 72 * 3600e3, observed_at:T, state:'open'}], probe:{reason:'guest_failed'}};
  const source = createRealPace50Source({readings:async () => snapshot,
    funding:() => ({observed_at:T, identity, codex_plan:{plan_type:'pro', limit_reached:false}}),
    expectedIdentity:() => ({email_sha256_16:identity.email_sha256_16})});
  const saved = await source.observe({provider:'codex', admissionOnly:true});
  assert.equal(saved.refresh_succeeded, true);
  assert.equal(saved.identity.verified, true);
  assert.equal(saved.funding.subscription_only, 'proven');
  assert.equal(saved.probe.reason, 'guest_failed');
  assert.equal((await source.observe({provider:'codex'})).refresh_succeeded, false, 'the live guard still requires a successful read');
  const unbound = createRealPace50Source({readings:async () => snapshot});
  assert.equal((await unbound.observe({provider:'codex', admissionOnly:true})).identity.verified, false);
});

test('admitted status keeps the last refresh failure diagnostic', async t => {
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'status-refresh-failure-'));
  const source = createSyntheticPace50Source({start:T,
    override:({base}) => ({...base, probe:{reason:'guest_failed', provider:'codex'}})});
  const pace = createPace50Candidate({directory, now:() => T, source,
    account:'synthetic-account', account_week_id:'synthetic-week-1'});
  t.after(async () => {await pace.adapter.close(); fs.rmSync(directory, {recursive:true, force:true});});
  await pace.candidate.observe({provider:'codex', now:T});
  const status = await pace.candidate.projectStatus({provider:'codex', snapshotOnly:true});
  assert.equal(status.admitted, true, status.reason);
  assert.equal(status.probe?.reason, 'guest_failed');
});
