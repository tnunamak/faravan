import './helpers/no-browser.mjs';
import {settlePaceAtBound} from './helpers/lending-settle-at-bound.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {rig} from './helpers/lending-soak.mjs';

test('soak harness drives reserve, start, finish and durable reopen offline', async t => {
  const f = rig(t), args = f.args();
  assert.equal((await f.reserve(args)).ok, true);
  assert.equal((await f.pace.candidate.admitStart(args.attemptId)).ok, true);
  await f.pace.candidate.started(args.attemptId, {ok:true});
  await f.pace.candidate.recordCleanup(args.attemptId, {removed:true});
  await f.pace.candidate.finish({...args, execution:{stdout:'', lending_meter:{final:true, cost_usd:0,
    model:args.model, tokens:{input:0, output:0, cached_input:0, cache_write:0, reasoning_output:0}}}});
  await f.restart();
  assert.equal(f.pace.adapter.state().attempts[0].hold_closed, false,
    'a borrower-side zero report cannot release exposure across a restart');
  assert.ok(f.pace.adapter.state().attempts[0].resources.every(r => r.held_micro > 0));
});

import fs from 'node:fs';
import {join} from 'node:path';
import {holdOpen, invariant, HOUR, MINUTE} from './helpers/lending-soak.mjs';
import {minimumMaxJobUsdForModel} from '../lib/v1/lender-pace50.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingProbe, createLendingReadings} from '../lib/v1/lending-probe.mjs';
import {createRealPace50Source} from '../lib/v1/lending-pace50-source.mjs';
import {NOW, ordinaryInput, request} from './helpers/pace50-fixtures.mjs';
import {createEstimatedPace50State, evaluateEstimatedPace50} from '../lib/v1/lending-policy.mjs';

test('I1/I2/I9 incident 3: fifteen stopped cleanup-proven holds close under a covering weekly meter', async t => {
  const f = rig(t,{candidate:{postingLagBoundMs:120000}}), ids = [];
  f.meter.native = false;
  const observe = f.source.observe;
  f.source.observe = async args => {const out = await observe(args); return {...out, resources:out.resources.filter(r => r.kind === 'weekly')};};
  for (let i = 0; i < 1; i++) {
    const args = f.args(`stale-${i}`);
    const grant = await f.reserve(args);
    assert.equal(grant.ok, true, JSON.stringify(grant));
    await f.pace.candidate.started(args.attemptId, {ok:true});
    ids.push(args.attemptId);
  }
  for (const id of ids) {
    await f.pace.candidate.ownerStop({attemptId:id, event_id:`stop-${id}`, at:f.clock.at});
    await f.pace.candidate.recordCleanup(id, {removed:true});
  }
  // Seed a durable incident snapshot from a priced job; no live registry survives.
  await f.pace.adapter.close();
  const file = join(f.directory,'lending-pace50-state.json');
  const state = JSON.parse(fs.readFileSync(file));
  state.attempts = Array.from({length:15}, (_, i) => (JSON.parse(JSON.stringify(state.attempts[0]).replaceAll('stale-0', `stale-${i}`))));
  for (const row of state.attempts) {row.usage_unknown = 'claude'; for (const resource of row.resources) resource.initial_micro = resource.held_micro = 100_000;}
  state.event_ids = [...new Set(Array.from({length:15}, (_, i) => state.event_ids.map(id => id.replaceAll("stale-0", `stale-${i}`))).flat())];
  state.revision = state.event_ids.length + 100;
  fs.writeFileSync(file, JSON.stringify(state));
  await f.restart();
  f.clock.at += 24 * HOUR;
  f.meter.used += 15 * 100_000;
  await f.pace.candidate.probeHeld();
  f.meter.used+=f.pace.adapter.state().attempts.flatMap(a=>a.resources).reduce((sum,r)=>sum+r.unrepresented_micro,0);
  await f.pace.candidate.probeHeld();
  await invariant(t, 'stale_holds', 'incident 3', () => {
    assert.equal(f.pace.adapter.state().attempts.filter(holdOpen).length, 0,
      'incident 3: cleanup-proven stopped holds still block after two recovery cycles');
  });
});

test('I5 incident 2: unset owner cap covers supported Claude worst calls', async t => {
  const f = rig(t, {candidate:{ownerSettings:{limit:() => ({state:'unset', maxJobUsd:null})}}});
  const args = f.args('default-cap', {model:'claude-opus-5-5'});
  const out = await f.reserve(args);
  await invariant(t, 'default_cap', 'incident 2', () => assert.equal(out.ok, true,
    `incident 2: unset owner cap refuses a priced model as ${out.policyReason}`));
});

test('I5 explicit low/equal/high caps produce named configuration faults', async t => {
  const model = 'claude-haiku-5-5', above = minimumMaxJobUsdForModel(model);
  for (const cap of [0.01, above - 0.01, above + 1]) {
    const f = rig(t, {candidate:{ownerSettings:{limit:() => ({state:'set', maxJobUsd:cap})}}});
    for (let i = 0; i < 3; i++) {
      const args = f.args();
      args.job.budget_v1.max_list_usd = Math.min(10, cap);
      const out = await f.reserve(args);
      if (cap < above) assert.equal(out.policyReason, 'budget_too_small', 'I5 configuration fault must be named');
      else {assert.equal(out.ok, true, JSON.stringify(out)); await f.pace.candidate.release(f.trace.at(-1)[2], {prepared:false});}
    }
  }
});

for (const sink of ['throw', 'drop']) test(`I6 incident 4: measurement completeness with ${sink} sink`, async t => {
  const f = rig(t, {sink});
  for (let i = 0; i < 30; i++) {
    const args = f.args();
    const out = await f.reserve(args);
    assert.equal(out.ok, true);
    await f.pace.candidate.release(args.attemptId, {prepared:false});
  }
  await invariant(t, `measurement_${sink}`, 'incident 4', () => {
    const admissions = f.rows.filter(row => row.type === 'admission_decided').length;
    const requested = f.rows.filter(row => row.type === 'observation_requested').length;
    const completed = f.rows.filter(row => ['observation_completed','observation_failed','observation_deferred'].includes(row.type)).length;
    assert.deepEqual([admissions, requested - completed], [30, 0], `incident 4: ${sink} sink silently lost measurement rows`);
  });
});

test('I3 incident 1: real provider cache survives a failed background probe', async t => {
  const f = rig(t), identity = {status:200, account_sha256_16:'1111222233334444', email_sha256_16:'aaaabbbbccccdddd'};
  const ledger = createLendingLedger({file:join(f.directory,'probe-ledger.json'), now:() => f.clock.at});
  let runs = 0;
  const probe = createLendingProbe({ledger, now:() => f.clock.at, runGuest:async () => {
    runs++;
    return {stdout:JSON.stringify(runs === 1 ? {faravan_probe:1, status:200, identity,
      guest_auth:{loggedIn:true, authMethod:'claude.ai', apiProvider:'firstParty'},
      body:{seven_day:{utilization:14,resets_at:new Date(NOW+42*HOUR).toISOString()},
        five_hour:{utilization:14,resets_at:new Date(NOW+HOUR).toISOString()},extra_usage:{is_enabled:false}}}
      : {faravan_probe:1,status:429}),usage_seen_at:f.clock.at};
  }});
  t.after(() => probe.close());
  const readings = createLendingReadings({ledger, probe, now:() => f.clock.at});
  const source = createRealPace50Source({readings, funding:p => probe.funding(p),
    expectedIdentity:() => ({email_sha256_16:identity.email_sha256_16})});
  await probe.probe('claude'); f.clock.at += 3 * MINUTE; await probe.probe('claude');
  const out = await source.observe({provider:'claude', admissionOnly:true});
  assert.equal(runs, 2);
  assert.equal(out.refresh_succeeded, true, 'incident 1: failed background probe hid last good reading');
  assert.ok(out.resources.every(row => row.observed_at === NOW));
});

test('I8 old, corrupt and missing state are rejected without genesis recreation', async t => {
  for (const poison of ['old','corrupt','missing']) {
    const f = rig(t), file = join(f.directory,'lending-pace50-state.json');
    await f.pace.adapter.close();
    if (poison === 'missing') fs.unlinkSync(file);
    else if (poison === 'corrupt') fs.writeFileSync(file, '{broken');
    else {const state = JSON.parse(fs.readFileSync(file)); state.version = 'objective-lending/state/3'; fs.writeFileSync(file,JSON.stringify(state));}
    const before = fs.existsSync(file) ? fs.readFileSync(file,'utf8') : null;
    await assert.rejects(f.restart, /pace50_state_(invalid|unreadable|missing)/);
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file,'utf8') : null, before);
  }
});

test('app recovery loop calls the same candidate every thirty seconds', async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const f = rig(t), directory = join(f.directory,'runtime');
  const runtime = createLendingRuntime({directory, settings:() => ({intent:'off'}), backend:{},
    presence:() => false, lastActiveAt:() => null, selfKey:() => null, now:() => f.clock.at,
    pace50:{postingLagBoundMs:120000,account:'soak-runtime', account_week_id:'soak-week', source:f.source}});
  // Close before the parent fixture removes its directory.

  let ticks = 0;
  runtime.candidate.probeHeld = async () => {ticks++;};
  runtime.start(); t.mock.timers.tick(90_000);
  assert.equal(ticks, 3, 'I1 production recovery loop missing');
  await runtime.close();
});

test('I10 exact timing and mode refusals; backward observations cannot reorder state', () => {
  const cases = [
    ['reading_stale', i => {i.windows[0].observed_at = i.now+1;}],
    ['window_timing_unknown', i => {i.windows[0].observed_at = i.windows[0].anchor_at-1;}],
    ['window_not_open', i => {i.windows[0].state = 'not_open';}],
    ['resource_reset_margin', i => {i.request.wall_ms = 2*HOUR;}],
    ['stopped', i => {i.state.mode = 'off';}],
    ['paused', i => {i.state.mode = 'paused';}],
  ];
  for (const [reason, change] of cases) {
    const input = {...ordinaryInput({now:NOW}), state:createEstimatedPace50State({account:'synthetic-account',account_week_id:'synthetic-week-1'}), request:request()};
    change(input);
    assert.equal(evaluateEstimatedPace50(input).reason, reason, reason);
  }
});

test('fifteen stopped cleanup-proven holds remain open under an aggregate weekly meter', async t => {
  const f = rig(t), ids = [];
  f.meter.native = false;
  const observe = f.source.observe;
  f.source.observe = async args => {const out = await observe(args); return {...out, resources:out.resources.filter(r => r.kind === 'weekly')};};
  for (let i = 0; i < 1; i++) {
    const args = f.args(`stale-${i}`);
    const grant = await f.reserve(args);
    assert.equal(grant.ok, true, JSON.stringify(grant));
    await f.pace.candidate.started(args.attemptId, {ok:true});
    ids.push(args.attemptId);
  }
  for (const id of ids) {
    await f.pace.candidate.ownerStop({attemptId:id, event_id:`stop-${id}`, at:f.clock.at});
    await f.pace.candidate.recordCleanup(id, {removed:true});
  }
  // Seed a durable incident snapshot from a priced job; no live registry survives.
  await f.pace.adapter.close();
  const file = join(f.directory,'lending-pace50-state.json');
  const state = JSON.parse(fs.readFileSync(file));
  state.attempts = Array.from({length:15}, (_, i) => (JSON.parse(JSON.stringify(state.attempts[0]).replaceAll('stale-0', `stale-${i}`))));
  for (const row of state.attempts) {row.usage_unknown = 'claude'; for (const resource of row.resources) resource.initial_micro = resource.held_micro = 100_000;}
  state.event_ids = [...new Set(Array.from({length:15}, (_, i) => state.event_ids.map(id => id.replaceAll("stale-0", `stale-${i}`))).flat())];
  state.revision = state.event_ids.length + 100;
  fs.writeFileSync(file, JSON.stringify(state));
  await f.restart();
  f.clock.at += 24 * HOUR;
  f.meter.used += 15 * 100_000;
  await f.pace.candidate.probeHeld();
  await f.pace.candidate.probeHeld();
  await invariant(t, 'stale_holds', 'aggregate weekly exposure', () => {
    const attempts=f.pace.adapter.state().attempts;
    assert.equal(attempts.filter(holdOpen).length, 15,
      'aggregate movement does not prove provider posting is complete');
    assert.ok(attempts.every(attempt=>attempt.resources.every(resource=>
      resource.held_micro+resource.unrepresented_micro===resource.initial_micro&&resource.released_micro===0)));
  });
});
