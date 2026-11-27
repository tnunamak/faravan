import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate, lendableModelsFor} from '../lib/v1/lender-pace50.mjs';
import {createRealPace50Source, readingAgeReserve} from '../lib/v1/lending-pace50-source.mjs';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';
import {createOwnerSettings} from '../lib/v1/owner-settings.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK, HOUR_MS} from './helpers/pace50-fixtures.mjs';
// Replays of spec/tla/Admission.tla paths against the real source, candidate, policy and durable adapter.
// Each failed on a9f7bdf7 and passes since 73cab697 (spec/tla/README.md, Admission).
const job = {requirements:{limits:{wall_seconds:300}}, expires_at:new Date(NOW + 86400e3).toISOString()};
const adapters = new Map();
function dir(t) {
  const d = fs.mkdtempSync(join(homedir(), '.tmp', 'statechart-replay-'));
  adapters.set(d, []);
  t.after(async () => {
    for (const a of adapters.get(d)) {await a.close();}
    adapters.delete(d);
    fs.rmSync(d, {recursive:true, force:true});
  });
  return d;
}
function open(t, directory, source, clock, extra = {}) {
  const pace = createPace50Candidate({directory, source, now:() => clock.at, account:ACCOUNT, account_week_id:WEEK, ...extra});
  adapters.get(directory).push(pace.adapter);
  return pace;
}
const reserve = (pace, id, model = 'claude-haiku-5-5') => pace.candidate.reserve({attemptId:id, jobId:id,
  provider:'claude', model, job:id === 'cap' ? job : {...job, budget_v1:{max_list_usd:2}}, automatic:true, ownerAbsent:true});

test('probe path: good reading -> aging -> failed refresh -> admission retains usable quota', async () => {
  const identity = {status:200, account_sha256_16:'1111222233334444', email_sha256_16:'aaaabbbbccccdddd'};
  let snapshot = {refresh_succeeded:true, windows:[{window_id:'codex:10080', window_minutes:10080,
    used_pct:14, resets_at:NOW + 72 * HOUR_MS, observed_at:NOW, state:'open'}]};
  const readings = async () => snapshot;
  readings.cached = () => snapshot;
  const source = createRealPace50Source({readings,
    funding:() => ({observed_at:NOW, identity, codex_plan:{plan_type:'pro', limit_reached:false}}),
    expectedIdentity:() => ({email_sha256_16:identity.email_sha256_16})});
  const good = await source.observe({provider:'codex', admissionOnly:true});
  assert.equal(good.refresh_succeeded, true);
  const at = NOW + 2 * 60_000;
  const r = good.resources[0];
  assert.ok(r.used_micro + r.uncertainty_micro + readingAgeReserve(r, at) < 100_000_000);
  snapshot = {...snapshot, refresh_succeeded:false, probe:{reason:'guest_failed'}};
  const after = await source.observe({provider:'codex', admissionOnly:true});
  assert.equal(after.refresh_succeeded, true, 'failed refresh must not erase the last successful reading');
  assert.equal(after.identity.verified, true);
  assert.equal(after.resources[0].observed_at, NOW);
});

test('cap path: unset owner setting -> expensive priced model -> next job can reserve', async t => {
  const directory = dir(t), clock = {at:NOW};
  const source = createSyntheticPace50Source({start:NOW, kappa:{weekly:10_000, short:10_000}});
  const original = source.objectiveInputFor.bind(source);
  source.objectiveInputFor = args => {
    const input = original(args);
    input.job.worstCallUsdMicro = Math.ceil(claudeCallHeadroomUsd(args.request.model) * 1e6);
    return input;
  };
  const settings = createOwnerSettings({directory:join(directory, 'owner')});
  const pace = open(t, directory, source, clock, {ownerSettings:settings});
  const model = lendableModelsFor('claude').find(m => claudeCallHeadroomUsd(m) > 4);
  assert.ok(model, 'priced model exceeds the old default');
  const grant = await reserve(pace, 'cap', model);
  assert.equal(grant.ok, true, JSON.stringify(grant));
});

for (const scenario of ['multiple','partial','all-reset']) test(`${scenario} path: aggregate sweeps retain exposure until reset`, async t => {
  const directory = dir(t), clock = {at:NOW};
  let scopeChanged = false;
  const source = createSyntheticPace50Source({start:NOW, override:({base, now}) => ({...base,
    resources:base.resources.map(r => scopeChanged && r.kind === 'short'
      ? {...r, instance:'new-short', anchor_at:now, resets_at:now + 5 * HOUR_MS, used_micro:0} : r)})});
  let pace = open(t, directory, source, clock);
  const ids = scenario === 'multiple' ? ['hold-a','hold-b'] : ['hold-a'];
  for (const id of ids) {
    assert.equal((await reserve(pace, id)).ok, true);
    await pace.candidate.started(id, {ok:true});
    await pace.candidate.recordCleanup(id, {removed:true});
    // Persist unknown usage without finish's immediate probe; this is the
    // crash/recovery boundary between durable facts and the next timer sweep.
    const out = await pace.adapter.transition({type:'usage_unknown', event_id:`${id}:unknown`, at:clock.at,
      attempt_id:id, provider:'claude'}, {expectedRevision:pace.adapter.state().revision});
    assert.equal(out.applied, true, JSON.stringify(out));
  }
  assert.ok(pace.adapter.state().attempts.every(a => a.cleanup_proven && a.hold_closed === false));
  const rows = pace.adapter.state().attempts;
  const envelopes = new Map(rows.map(a => [a.id,a.resources.map(r => r.initial_micro)]));
  for (const kind of ['weekly','short']) source.state.used[kind] += rows.reduce((sum,a) =>
    sum + a.resources.find(r => r.kind === kind).held_micro, 0);
  await pace.adapter.close();
  pace = open(t, directory, source, clock);
  if (scenario === 'all-reset') {clock.at = NOW + 42 * HOUR_MS + 1000;}
  else if (scenario === 'partial') {clock.at = NOW + 1.25 * HOUR_MS + 1000; scopeChanged = true;}
  else clock.at += 1000;
  await pace.candidate.probeHeld();
  clock.at += 1000;
  await pace.candidate.probeHeld();
  if (scenario === 'all-reset') {
    assert.ok(pace.adapter.state().attempts.every(a => a.hold_closed === true));
    assert.ok(pace.adapter.state().attempts.every(a => a.resources.every(r => r.held_micro===0&&r.unrepresented_micro===0)));
  } else {
    for (const a of pace.adapter.state().attempts) {
      assert.equal(a.hold_closed,false);
      for (const [index,r] of a.resources.entries()) {
        if (r.resets_at<=clock.at) {
          assert.equal(r.held_micro+r.unrepresented_micro,0,'a reset settles its own resource');
          assert.equal(r.spent_micro+r.settled_micro,r.initial_micro);
        } else {
          assert.equal(r.held_micro+r.unrepresented_micro,envelopes.get(a.id)[index],
            'aggregate movement does not reduce an open resource');
          assert.equal(r.released_micro,0);
        }
      }
    }
    const next = await reserve(pace, 'next-job');
    assert.equal(next.ok, true, JSON.stringify(next));
  }
});

test('older schema is rejected loudly without replacing the file', async t => {
  const directory = dir(t);
  const file = join(directory, 'lending-pace50-state.json');
  const bytes = JSON.stringify({version:'older-schema', attempts:[{id:'unsettled'}]});
  fs.writeFileSync(file, bytes);
  assert.throws(() => open(t, directory, createSyntheticPace50Source({start:NOW}), {at:NOW}));
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});
