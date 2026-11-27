import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {LINES, REASON_LINE} from '../lib/v1/lending-status-copy.mjs';

const reading = at => ({windows:[{window_id:'five_hour',window_minutes:300,used_pct:10,
  observed_at:at,resets_at:at+3600000,state:'open'}]});

test('view uses explicit local snapshots without sampling presence or probing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-runtime-view-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const at = Date.now(), sequence = [];
  let backendTouches = 0;
  const backend = new Proxy({}, {get() { backendTouches++; return async () => null; }});
  const settings = {intent:'off', limits:{lendingPolicy:normalizeLendingPolicy({accountPlans:{claude:'max20'}})}};
  const runtime = createLendingRuntime({directory, backend, settings:() => settings, now:() => at,
    presence:async () => { sequence.push('presence'); return true; },
    statusRead:async provider => { sequence.push(`snapshot:${provider}`); return reading(at); }});
  t.after(async () => runtime.close());

  const view = await runtime.view();

  assert.deepEqual(sequence, ['snapshot:claude','snapshot:codex']);
  assert.deepEqual(view.accounts.map(account => account.provider), ['claude','codex']);
  assert.deepEqual(view.accounts[0].readings, reading(at).windows);
  assert.deepEqual(view.accounts[0].decision.windows, reading(at).windows);
  assert.equal(backendTouches, 0, 'a status snapshot must not invoke a provider backend');
});

test('runtime status follows reserve, finish, and release lifecycle', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-runtime-lifecycle-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const at = Date.now();
  const settings = {enabled:true, intent:'on', limits:{lendingPolicy:normalizeLendingPolicy({accountPlans:{claude:'max20'}})}};
  const runtime = createLendingRuntime({directory, backend:{}, settings:() => settings, now:() => at,
    presence:async () => false, readOverride:async () => reading(at)});
  t.after(async () => runtime.close());

  // Exercise only runtime lifecycle bookkeeping. The durable candidate remains unavailable, so no provider work can run.
  let currentProjection = {admitted:true, reason:'admitted', objective:{schemaVersion:1,
    policyVersion:'objective/m1', admission:'allowed', reasonCode:'ready',
    reasonText:'The request fits the available capacity.', protectionSource:'weekly_upper_band',
    observedAt:new Date(at).toISOString(), usedPoints:{seven_day:10,five_hour:10},
    resetsAt:{seven_day:new Date(at + 3600000).toISOString(),five_hour:new Date(at + 3600000).toISOString()}}};
  runtime.candidate.reserve = async args => ({ok:true, reservation:{attemptId:args.attemptId, provider:args.provider}});
  runtime.candidate.finish = async args => ({finished:args.attemptId});
  runtime.candidate.release = async (attemptId, args) => ({applied:true, attemptId, prepared:args.prepared});
  runtime.candidate.projectStatus = async () => currentProjection;
  runtime.candidate.decisionFor = () => ({admitted:true, reason:'admitted', objective:{schemaVersion:1,
    policyVersion:'objective/m1', admission:'admitted', reasonCode:'ready',
    reasonText:'The request fits the available capacity.', protectionSource:'weekly_upper_band',
    observedAt:new Date(at - 1000).toISOString(), usedPoints:{seven_day:10,five_hour:10},
    resetsAt:{seven_day:new Date(at + 3600000).toISOString(),five_hour:new Date(at + 3600000).toISOString()}}});

  const reserved = await runtime.reserve({attemptId:'running-attempt', provider:'claude'});
  assert.equal(reserved.ok, true);
  assert.equal(runtime.busy('claude'), true);
  let view = await runtime.view();
  assert.equal(view.accounts[0].decision.status.id, 'lend');

  await runtime.finish({attemptId:'running-attempt', provider:'claude'});
  assert.equal(runtime.busy('claude'), false);
  view = await runtime.view();
  assert.equal(view.accounts[0].decision.status.id, 'ready');

  currentProjection = {admitted:false, reason:'exceeds_spare', objective:{schemaVersion:1,
    policyVersion:'objective/m1', admission:'held', reasonCode:'objective_exceeds_spare',
    reasonText:'The request is larger than the spare quota.', protectionSource:'weekly_upper_band',
    requestedUsd:4, maximumExposureUsd:2, observedAt:new Date(at).toISOString(),
    usedPoints:{seven_day:11,five_hour:10},
    resetsAt:{seven_day:new Date(at + 3600000).toISOString(),five_hour:new Date(at + 3600000).toISOString()}}};
  view = await runtime.view();
  assert.equal(view.accounts[0].decision.reason, 'exceeds_spare');
  assert.equal(view.accounts[0].decision.status.id, 'spare');
  assert.match(view.accounts[0].decision.status.line, /needs \$4\.00, and \$2\.00 is spare now/);

  await runtime.reserve({attemptId:'released-attempt', provider:'claude'});
  assert.equal(runtime.busy('claude'), true);
  const released = await runtime.release('released-attempt', {prepared:false});
  assert.equal(released.applied, true);
  assert.equal(released.prepared, false);
  assert.equal(runtime.busy('claude'), false);
});

test('a jobless status preview does not erase an assessed evidence hold', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-runtime-held-status-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const at = Date.now();
  const settings = {enabled:true, intent:'on', limits:{lendingPolicy:normalizeLendingPolicy({accountPlans:{claude:'max20'}})}};
  const runtime = createLendingRuntime({directory, backend:{}, settings:() => settings, now:() => at,
    presence:async () => false, readOverride:async () => reading(at)});
  t.after(async () => runtime.close());
  const windows = {seven_day:10,five_hour:10};
  const resets = {seven_day:new Date(at + 3600000).toISOString(),five_hour:new Date(at + 3600000).toISOString()};
  const availability = {admitted:true, reason:'objective_lend', objective:{
    schemaVersion:1, policyVersion:'objective/m1', admission:'allowed', reasonCode:'objective_lend',
    reasonText:'The status preview is missing the job demand model.', protectionSource:'model',
    strategyId:'manual_approval', observedAt:new Date(at).toISOString(), usedPoints:{seven_day:11,five_hour:10}, resetsAt:resets}};
  const assessedHold = {admitted:false, reason:'objective_evidence_unknown', objective:{
    schemaVersion:1, policyVersion:'objective/m1', admission:'held', reasonCode:'objective_evidence_unknown',
    reasonText:'The assessed request has no trusted objective evidence.', protectionSource:'unknown',
    observedAt:new Date(at - 1000).toISOString(), usedPoints:windows, resetsAt:resets}};
  runtime.candidate.projectStatus = async () => availability;
  runtime.candidate.decisionFor = () => assessedHold;
  runtime.candidate.lastJobDecisionFor = () => null;

  const unassessed = (await runtime.view()).accounts[0].decision;
  assert.equal(unassessed.reason, 'objective_lend', 'the sentinel is not a real assessed request hold');
  assert.equal(unassessed.availability.reason, 'objective_lend');
  assert.equal(unassessed.lastJobDecision, null);

  runtime.candidate.lastJobDecisionFor = () => assessedHold;
  const assessed = (await runtime.view()).accounts[0].decision;
  assert.equal(assessed.reason, 'objective_evidence_unknown', 'the manual availability preview cannot replace an assessed request hold');
  assert.equal(assessed.admitted, false);
  assert.equal(assessed.objective.reasonCode, 'objective_evidence_unknown');
  assert.equal(assessed.availability.reason, 'objective_lend', 'fresh jobless capacity remains a separate projection');
  assert.deepEqual(assessed.lastJobDecision, assessedHold);
});

test('runtime passes previously sampled desktop activity without resampling in view', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-runtime-presence-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const at = Date.now(), sequence = [];
  const settings = {enabled:true, intent:'on', limits:{idleOnly:true,lendingPolicy:normalizeLendingPolicy({accountPlans:{claude:'max20'}})}};
  const runtime = createLendingRuntime({directory, settings:() => settings, backend:{},
    presence:async () => { sequence.push('presence'); return true; }, now:() => at,
    readOverride:async () => ({windows:[{window_id:'five_hour',window_minutes:300,state:'open',used_pct:10,
      observed_at:at,resets_at:at + 3600000}]})});
  t.after(() => runtime.close());
  runtime.candidate.projectStatus = async ({ownerAbsent}) => {
    sequence.push(['projectStatus', ownerAbsent]);
    return {admitted:false, reason:'owner_present', objective:null};
  };
  await runtime.samplePresence();
  const view = await runtime.view();
  assert.deepEqual(sequence.slice(0, 2), ['presence', ['projectStatus', false]]);
  assert.equal(view.accounts[0].decision.reason, 'owner_present');
  assert.equal(view.accounts[0].decision.status.id, 'recent_use');
});

test('runtime preserves the known identity hold when no account candidate is available', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-runtime-identity-'));
  const settings = {enabled:true, intent:'on', limits:{lendingPolicy:normalizeLendingPolicy()}};
  const runtime = createLendingRuntime({directory, settings:() => settings, backend:{}, presence:() => false,
    pace50:{account:'', account_week_id:'unobserved'}});
  t.after(async () => { await runtime.close(); await rm(directory, {recursive:true, force:true}); });
  const view = await runtime.view();
  const claude = view.accounts.find(account => account.id === 'claude');
  assert.equal(claude.decision.reason, 'identity_unknown');
  assert.equal(claude.decision.status.id, 'identity');
  assert.equal(claude.decision.status.line, LINES.identity);
  assert.equal(claude.decision.availability.reason, 'identity_unknown');
  assert.equal(claude.decision.lastJobDecision, null);
});

function heldValue() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return {promise, release};
}

test('cold status never invokes held presence, probing reader, or candidate source', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-status-snapshot-'));
  const held = heldValue(), calls = [];
  const runtime = createLendingRuntime({directory, settings:() => ({enabled:false, intent:'off'}),
    presence:() => { calls.push('presence'); return held.promise; },
    readOverride:() => { calls.push('probe-reader'); return held.promise; },
    statusRead:provider => { calls.push('snapshot:'+provider); return reading(100); },
    pace50:{account:'snapshot-test', account_week_id:'snapshot-week',
      source:{observe:() => { calls.push('source'); return held.promise; }}}});
  let pending;
  t.after(async () => { held.release(null); await pending; await runtime.close();
    await rm(directory, {recursive:true, force:true}); });
  let settled = false;
  pending = runtime.view().then(value => { settled = true; return value; });
  await new Promise(setImmediate);
  assert.equal(settled, true, 'status must not join external work');
  assert.deepEqual(calls, ['snapshot:claude','snapshot:codex']);
  const view = await pending;
  assert.ok(view.accounts.every(a => !a.decision.admitted));
  assert.ok(view.accounts.every(a => a.decision.reason === 'objective_evidence_unknown'));
  assert.deepEqual(view.accounts[0].readings, reading(100).windows);
});

test('cold identity status uses only explicitly local snapshot, never probing readOverride', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-status-identity-'));
  let probes = 0;
  const runtime = createLendingRuntime({directory, settings:() => ({enabled:false, intent:'off'}),
    pace50:{account:''}, readOverride:async () => { probes++; return reading(100); }});
  t.after(async () => { await runtime.close(); await rm(directory, {recursive:true, force:true}); });
  const view = await runtime.view();
  assert.equal(probes, 0);
  assert.ok(view.accounts.every(a => a.decision.reason === 'identity_unknown'));
  assert.deepEqual(view.accounts[0].readings, []);
});

test('cache-only status preserves fresh holds, isolates keys, expires and never joins pending refresh', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-status-cache-'));
  let at = 100_000, calls = 0, held = null;
  const runtime = createLendingRuntime({directory, now:() => at,
    settings:() => ({limits:{lendingPolicy:{accountPlans:{codex:'plus'}}}}),
    pace50:{account:'cache-test', account_week_id:'cache-week', source:{
      observe:async () => { calls++; return held ? held.promise : {refresh_succeeded:false}; }}}});
  const candidate = runtime.candidate;
  let pending;
  t.after(async () => { held?.release({refresh_succeeded:false}); await pending; await runtime.close();
    await rm(directory, {recursive:true, force:true}); });
  const status = args => candidate.projectStatus({provider:'codex', plan:'plus', snapshotOnly:true, ...args});
  assert.equal((await status()).reason, 'objective_evidence_unknown');
  assert.equal(calls, 0);
  assert.equal(await candidate.preflight({provider:'codex', ownerAbsent:true}), 'refresh_failed');
  assert.equal(calls, 1, 'real admission preflight still refreshes');
  assert.equal((await status()).reason, 'refresh_failed', 'fresh known evidence failure is retained');
  assert.equal((await status({plan:'other'})).reason, 'objective_evidence_unknown');
  assert.equal((await status({model:'other'})).reason, 'objective_evidence_unknown');
  assert.equal(calls, 1);
  await candidate.preflight({provider:'codex', ownerAbsent:true});
  assert.equal(calls, 1, 'fresh admission cache is reused');
  at += 30_001;
  assert.equal((await status()).reason, 'objective_evidence_unknown');
  held = heldValue();
  pending = candidate.observe({provider:'codex', plan:'plus', now:at});
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  let done = false;
  const snapshot = status().then(value => { done = true; return value; });
  await new Promise(setImmediate);
  assert.equal(done, true, 'snapshot does not join a pending real refresh');
  assert.equal((await snapshot).reason, 'objective_evidence_unknown');
  await candidate.release('not-started', {prepared:true});
  held.release({refresh_succeeded:false});
  await pending;
  assert.equal((await status()).reason, 'objective_evidence_unknown', 'invalidated pending result cannot repopulate cache');
  assert.equal(calls, 2);
});

test('cache-only status with no model named uses the model the lender observed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-status-model-'));
  let at = 100_000, calls = 0;
  const runtime = createLendingRuntime({directory, now:() => at, settings:() => ({}),
    pace50:{account:'model-test', account_week_id:'model-week',
      source:{observe:async () => { calls++; return {refresh_succeeded:false}; }}}});
  t.after(async () => { await runtime.close(); await rm(directory, {recursive:true, force:true}); });
  const c = runtime.candidate;
  await c.observe({provider:'claude', model:'claude-sonnet-5-5', plan:'max20', now:at});
  const status = args => c.projectStatus({provider:'claude', plan:'max20', snapshotOnly:true, ...args});
  assert.equal((await status()).reason, 'refresh_failed', 'the observed model answers when none is named');
  assert.equal((await status({model:'claude-opus-5-5'})).reason, 'objective_evidence_unknown', 'a named model keeps its own key');
  assert.equal((await status({plan:'pro'})).reason, 'objective_evidence_unknown', 'another plan is not reused');
  at += 30_001;
  assert.equal((await status()).reason, 'objective_evidence_unknown', 'an expired reading is not reused');
  assert.equal(calls, 1);
});

test('provider probe failure stays in the public and saved lending decision', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-runtime-probe-failure-'));
  let closeRuntime;
  t.after(async () => { await closeRuntime?.(); await rm(directory, {recursive:true, force:true}); });
  let probe = {reason:'provider_error',status_class:'5xx',provider:'claude',failure_class:'other'};
  const saved = [];
  const runtime = createLendingRuntime({directory, now:()=>Date.UTC(2026,9,29),
    settings:()=>({enabled:true,intent:'on',limits:{lendingPolicy:{accountPlans:{claude:'max20'}}}}),
    presence:async()=>false,
    pace50:{measurementHistory:{record:(type,data)=>{saved.push({type,data});return `saved-${saved.length}`;}},
      account:'probe-failure-test',account_week_id:'test-week',source:{
      observe:async()=>({refresh_succeeded:false,complete:false,resources:[],probe})}}});
  closeRuntime = () => runtime.close();

  const refreshed = await runtime.refreshCapacity('claude');
  assert.equal(refreshed.reason,'refresh_failed');
  assert.deepEqual(refreshed.probe,probe);
  const refused = await runtime.reserve({attemptId:'failed-probe',jobId:'failed-probe',provider:'claude',
    model:'claude-haiku-5-5',ownerAbsent:true,
    job:{budget_v1:{max_list_usd:2},requirements:{limits:{wall_seconds:60}},
      expires_at:new Date(Date.UTC(2026,9,29)+3600000).toISOString()}});
  assert.equal(refused.ok,false);
  assert.equal(refused.policyReason,'refresh_failed');
  assert.deepEqual(refused.probe,probe);
  const decision = (await runtime.view()).accounts.find(account=>account.provider==='claude').decision;
  assert.deepEqual(decision.probe,probe);
  assert.deepEqual(decision.lastJobDecision.probe,probe);
  assert.ok(saved.some(event=>event.type==='observation_failed' && event.data.probe?.reason==='provider_error' && event.data.probe?.status_class==='5xx'));
  assert.equal(runtime.pace50.state().attempts.length,0,'a failed reading cannot create a reservation');
  probe = {reason:'',status_class:'4xx',body:'untrusted-body-marker',url:'https://private.invalid/marker'};
  const malformed = await runtime.refreshCapacity('claude');
  assert.equal(malformed.reason,'refresh_failed');
  assert.deepEqual(malformed.probe,{reason:'unreadable'});
  assert.doesNotMatch(JSON.stringify(malformed),/untrusted-body-marker|private\.invalid|4xx/);
});

test('snapshot projection revalidates freshness and generation after yielding', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-status-race-'));
  let at = 100_000, calls = 0;
  const runtime = createLendingRuntime({directory, now:() => at, settings:() => ({}),
    pace50:{account:'race-test', account_week_id:'race-week',
      source:{observe:async () => { calls++; return {refresh_succeeded:false}; }}}});
  t.after(async () => { await runtime.close(); await rm(directory, {recursive:true, force:true}); });
  const c = runtime.candidate, args = {provider:'codex', plan:null, now:at};
  await c.observe(args);
  const original = runtime.pace50.preview.bind(runtime.pace50);
  runtime.pace50.preview = async options => {
    at += 30_001;
    return original(options);
  };
  assert.equal((await c.projectStatus({provider:'codex', snapshotOnly:true})).reason, 'objective_evidence_unknown');
  assert.equal(calls, 1, 'expiry during preview cannot fall through to observe');
  await c.observe({...args, now:at});
  runtime.pace50.preview = async options => {
    await c.release('not-started', {prepared:true});
    return original(options);
  };
  assert.equal((await c.projectStatus({provider:'codex', snapshotOnly:true})).reason, 'objective_evidence_unknown');
  assert.equal(calls, 2, 'invalidation during preview cannot launch observation');
});

test('unknown or stale presence never claims owner absence in automatic snapshot status', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-status-presence-'));
  let at = 100_000, samples = 0;
  const runtime = createLendingRuntime({directory, now:() => at,
    settings:() => ({activeCircle:'circle', modes:{circle:'auto'}, agents:{'claude-code-subscription':true,codex:true}, limits:{idleOnly:true}}),
    presence:async () => { samples++; return false; }});
  t.after(async () => { await runtime.close(); await rm(directory, {recursive:true, force:true}); });
  const seen = [];
  runtime.candidate.projectStatus = async args => {
    seen.push(args);
    return {admitted:false, reason:'owner_present', objective:null};
  };
  await runtime.view();
  assert.ok(seen.every(args => args.snapshotOnly && args.automatic && !args.ownerAbsent));
  assert.equal(samples, 0);
  await runtime.samplePresence();
  seen.length = 0;
  await runtime.view();
  assert.ok(seen.every(args => args.ownerAbsent));
  at += 30_001;
  seen.length = 0;
  await runtime.view();
  assert.ok(seen.every(args => !args.ownerAbsent));
  assert.equal(samples, 1);
});

test('unreadable owner settings remain a named hold without probing or reading snapshots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-status-owner-hold-'));
  let touches = 0;
  const runtime = createLendingRuntime({directory, settings:() => ({}),
    statusRead:() => { touches++; return null; },
    pace50:{account:'owner-hold', account_week_id:'week',
      ownerSettings:{limit:() => ({state:'unreadable'})},
      source:{observe:async () => { touches++; return null; }}}});
  t.after(async () => { await runtime.close(); await rm(directory, {recursive:true, force:true}); });
  const view = await runtime.view();
  assert.ok(view.accounts.every(a => a.decision.reason === 'owner_settings_unreadable'));
  assert.equal(touches, 0);
});

test('delayed and superseded presence samples never freshen old absence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-status-presence-race-'));
  let at = 100_000, delayed = heldValue(), nextValue = delayed.promise;
  const pending = [];
  const runtime = createLendingRuntime({directory, now:() => at,
    settings:() => ({activeCircle:'circle', modes:{circle:'auto'}, agents:{'claude-code-subscription':true,codex:true}, limits:{idleOnly:true}}),
    presence:() => nextValue});
  t.after(async () => { delayed.release(false); await Promise.all(pending); await runtime.close();
    await rm(directory, {recursive:true, force:true}); });
  const seen = [];
  runtime.candidate.projectStatus = async args => { seen.push(args.ownerAbsent);
    return {admitted:false, reason:'owner_present', objective:null}; };
  pending.push(runtime.samplePresence());
  at += 30_001;
  delayed.release(false);
  await pending[0];
  await runtime.view();
  assert.ok(seen.every(value => value === false), 'slow old absence is stale on completion');
  delayed = heldValue();
  nextValue = delayed.promise;
  pending.push(runtime.samplePresence());
  nextValue = true;
  await runtime.samplePresence();
  delayed.release(false);
  await pending[1];
  seen.length = 0;
  await runtime.view();
  assert.ok(seen.every(value => value === false), 'older absence cannot overwrite newer owner-present sample');
});


test('runtime close starts durable cessation before a held quota observation drains', async t => {
  const directory=await mkdtemp(join(tmpdir(),'runtime-close-order-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const runtime=createLendingRuntime({directory,backend:{},settings:()=>({}),
    pace50:{account:'close-order',account_week_id:'close-week',source:{observe:async()=>null}}});
  let release,stopping=false,closed=false;
  const gate=new Promise(resolve=>{release=resolve;});
  const originalClose=runtime.pace50.close.bind(runtime.pace50);
  runtime.pace50.close=async options=>{stopping=true;return originalClose(options);};
  runtime.candidate.cancelObservations=()=>gate;
  const closing=runtime.close().then(()=>{closed=true;});
  try {
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(stopping,true,'durable cessation starts without waiting for quota evidence');
    assert.equal(closed,false,'owned quota work is still drained before close resolves');
  } finally {release();await closing;}
});


test('retained probe hold is dated history, not a current hold or an automatic refresh promise', async t => {
  const directory = await mkdtemp(join(tmpdir(),'runtime-last-job-'));
  let at = Date.parse('2026-11-01T18:54:00Z'), calls = 0;
  const runtime = createLendingRuntime({directory,now:()=>at,
    settings:()=>({enabled:true,intent:'on'}),
    pace50:{account:'synthetic-history',account_week_id:'synthetic-week',
      source:{observe:async()=>{ calls++; return {refresh_succeeded:false,
        probe:{reason:'timeout',provider:'codex',failure_class:'timeout'}}; }}}});
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  assert.equal(await runtime.candidate.preflight({provider:'codex',ownerAbsent:true}),'refresh_failed');
  const assessedAt = at;
  at += 2*60*60_000;
  const decision = (await runtime.view()).accounts.find(account=>account.provider==='codex').decision;
  assert.equal(decision.assessmentSource,'last_job');
  assert.equal(decision.assessedAt,assessedAt);
  assert.equal(Object.hasOwn(decision,'assessmentAgeMs'),false);
  assert.equal(Object.hasOwn(decision.status,'ageMs'),false);
  assert.equal(decision.status.assessedAt,assessedAt);
  assert.match(decision.status.line,/The last job was held at 2026-11-01T18:54:00.000Z because/);
  assert.doesNotMatch(decision.status.line,/ago/);
  assert.match(decision.status.line,/Codex usage check timed out/);
  assert.match(decision.status.line,/The next job is checked again before it can run\./);
  assert.doesNotMatch(decision.status.line,/clears on its own|^Holding|verdict|receipt|attempt|settled|lease/i);
  assert.equal(decision.objective.reasonText,decision.status.line);
  assert.equal(calls,1,'status must not run a fresh provider check');
  assert.equal(decision.admitted,false,'historical copy cannot admit a job');
  assert.equal(await runtime.candidate.preflight({provider:'codex',ownerAbsent:true}),'refresh_failed');
  assert.equal(calls,2,'the next real job still checks the provider');
  assert.equal(runtime.candidate.lastJobDecisionFor('codex').assessedAt,at);
});

test('fresh readiness stays current while a past refusal has a stable separate history', async t => {
  const directory=await mkdtemp(join(tmpdir(),'runtime-fresh-and-history-'));
  let at=100_000;
  const runtime=createLendingRuntime({directory,backend:{},now:()=>at,
    settings:()=>({enabled:true,intent:'on'})});
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  runtime.candidate.projectStatus=async()=>({admitted:true,reason:'objective_lend'});
  runtime.candidate.lastJobDecisionFor=()=>({admitted:false,reason:'exceeds_spare',assessedAt:50_000});
  const read=async()=>(await runtime.view()).accounts[0].decision;
  const first=await read();
  assert.equal(first.admitted,true);
  assert.equal(first.assessmentSource,'current');
  assert.equal(first.availability.reason,'objective_lend');
  assert.equal(first.lastJobStatus.assessedAt,50_000);
  assert.notEqual(first.status.id,first.lastJobStatus.id);
  at+=3_600_000;
  assert.deepEqual((await read()).lastJobStatus,first.lastJobStatus);
});

test('a current snapshot hold keeps its existing present-tense status', async t => {
  const directory = await mkdtemp(join(tmpdir(),'runtime-current-hold-'));
  const runtime = createLendingRuntime({directory,backend:{},now:()=>100_000,
    settings:()=>({enabled:true,intent:'on'})});
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  runtime.candidate.lastJobDecisionFor = ()=>null;
  runtime.candidate.projectStatus = async()=>({admitted:false,reason:'refresh_failed'});
  const decision = (await runtime.view()).accounts[0].decision;
  assert.equal(decision.assessmentSource,'current');
  assert.equal(decision.status.line,LINES[REASON_LINE.refresh_failed]);
  assert.doesNotMatch(decision.status.line,/last job/);
});


test('current owner holds take precedence over a retained probe failure without probing', async t => {
  const directory = await mkdtemp(join(tmpdir(),'runtime-current-owner-hold-'));
  const saved = {enabled:true,intent:'on'};
  const runtime = createLendingRuntime({directory,backend:{},now:()=>100_000,
    settings:()=>saved,readOverride:()=>assert.fail('status must stay local')});
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  const previous = {admitted:false,reason:'refresh_failed',assessedAt:1,
    probe:{provider:'codex',reason:'timeout',failure_class:'timeout'}};
  runtime.candidate.lastJobDecisionFor = ()=>previous;
  for (const reason of ['owner_settings_unreadable','paused','stopped','owner_present','identity_unknown','budget_too_small']) {
    runtime.candidate.projectStatus = async()=>({admitted:false,reason});
    const decision = (await runtime.view()).accounts[0].decision;
    assert.equal(decision.assessmentSource,'current',reason);
    assert.equal(decision.reason,reason);
    assert.doesNotMatch(decision.status.line,/last job|timed out/);
    assert.equal(decision.lastJobDecision,previous);
  }
  runtime.candidate.projectStatus = async()=>({admitted:false,reason:'refresh_failed'});
  saved.intent = 'off';
  assert.equal((await runtime.view()).accounts[0].decision.status.line,LINES.paused);
  saved.enabled = false;
  assert.equal((await runtime.view()).accounts[0].decision.status.line,LINES.stopped);
});


for (const reason of ['account_busy','probe_deferred']) test('refreshCapacity preserves '+reason+' without changing admission', async t => {
  const directory = await mkdtemp(join(tmpdir(),'runtime-deferral-'));
  const probe = {reason,provider:'claude',failure_class:reason==='account_busy'?'probe_busy':'probe_deferred'};
  const runtime = createLendingRuntime({directory,now:()=>Date.UTC(2026,9,29),settings:()=>({}),presence:async()=>false,
    pace50:{account:'deferral-test',account_week_id:'test-week',source:{observe:async()=>({
      resources:[],complete:false,refresh_succeeded:false,refresh_outcome:'deferred',probe})}}});
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  const result = await runtime.refreshCapacity('claude');
  assert.equal(result.admitted,false);
  assert.equal(result.reason,reason);
  assert.equal(result.reasonCode,reason);
  assert.deepEqual(result.probe,probe);
  assert.equal(runtime.pace50.state().attempts.length,0);
  const reading = await runtime.readings('claude',{forceRefresh:true});
  assert.equal(reading.refresh_outcome,'deferred');
  assert.equal(reading.refresh_succeeded,false);
});
