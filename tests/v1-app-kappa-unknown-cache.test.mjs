import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import {realKappaSource} from './helpers/kappa-real-source.mjs';
import {measureKappa} from '../lib/v1/lending-kappa-measure.mjs';

const adapters = () => [{spec:legacyProxyHarness('claude-code-subscription'), installed:true, signedIn:true,
  harnessVersion:'synthetic-only', models:['claude-haiku-5-5'], capabilities:[]}];

test('saved estimates without an account binding, and old null markers, never convert: lending waits for a measurement', {timeout:120000}, async t => {
  const f = await appFixture(t);
  const home = await f.home('lender');
  const directory = join(home, 'v1');
  const sessionHomeDir = join(f.root, 'sessions');
  await mkdir(directory, {recursive:true});
  await mkdir(sessionHomeDir, {recursive:true});
  await writeFile(join(directory, 'lending-kappa-estimates.json'), JSON.stringify([
    ['claude/claude:seven_day', {account:'claude', resource:'claude:seven_day', upper_micro:null}],
    ['claude/claude:five_hour', {account:'claude', resource:'claude:five_hour', upper_micro:9_000_000,
      provenance:{method:'ratio-of-sums/8-weeks', label:'estimated from your usage'}}],
  ]));

  const observations = [];
  // Invitation resolution does not receive the app clock. Start in its current
  // time range, then freeze the shared app/lending clock for this test.
  const now = Date.now();
  const {owner, lender, circle} = await f.connect({adapters, clock:() => now/1000, lendingNow:() => now, sessionHomeDir, lendingReadings:async () => ({windows:[
    {window_id:'seven_day', window_minutes:10080, state:'open', used_pct:5, observed_at:now, resets_at:now+7*86400000},
    {window_id:'five_hour', window_minutes:300, state:'open', used_pct:5, observed_at:now, resets_at:now+300000},
  ]}), lendingPace50:{measurementHistory:{record(type, data) {
    // A read whose identity is unverified is recorded as observation_failed (batch8a). Either row proves the producer reached the source;
    // only completed rows carry resources, so only they are checked for kappa.
    if (type === 'observation_completed' || type === 'observation_failed') observations.push({type, ...data});
    return null;
  }}}}, {clock:() => now/1000});
  await api(lender.app, '/api/lending/limits', {method:'POST', body:{idleOnly:false,
    lendingPolicy:{accountPlans:{claude:'max20'}}}});
  await api(lender.app, '/api/agents/claude-code-subscription', {method:'POST', body:{useForLending:true}});
  await api(lender.app, '/api/lending/on', {method:'POST', body:{circle:circle.id}});
  await api(lender.app, '/api/lending/mode', {method:'POST', body:{circle:circle.id, mode:'auto'}});
  await api(lender.app, '/api/agents/claude-code-subscription/run', {method:'POST', body:{model:'claude-haiku-5-5', effort:null}});
  await api(owner.app, '/api/jobs', {method:'POST', body:{circle:circle.id,
    git:{url:'https://github.com/example/synthetic.git', commit:'1'.repeat(40)},
    prompt:'Synthetic conversion check; no external execution.', harness:'claude-code-subscription', model:'claude-haiku-5-5'}});
  await api(lender.app, '/api/agents/refresh', {method:'POST', body:{agents:['claude-code-subscription']}});

  // The plan says max20, but neither a plan nor a saved estimate from before account binding supplies a rate.
  assert.ok(observations.length > 0, 'the normal app producer reached the real default source');
  for (const observation of observations) for (const row of observation.resources ?? [])
    assert.equal(row.kappa_micro, null, `${row.id} has no rate before this account is measured`);
  assert.equal(lender.backend.calls.some(([kind]) => kind === 'run'), false, 'the fixture never executes a job');
});

// Exercise the app producer with the real source and measurement function.
// The separate default local-log import/bootstrap is not replaced or covered here.
for (const hasUsage of [true, false]) {
  test(`app records ${hasUsage ? 'measured usage' : 'honest unknown without usage'} for a verified account`,
    {timeout:120000}, async t => {
    // Use a current-time seed for invitation resolution; all measurement offsets stay fixed.
    const now = Date.now();
    const clock = {start:now, at:now}, observations = [], measurements = [];
    const {source, used} = realKappaSource(clock, {kappaForUsage: ({account, resource}) => {
      const estimate = measureKappa({account, resource, now:clock.at,
        attribution:{account_sha256_16:'1111222233334444', since:now-3600000},
        usage:hasUsage ? [{account:'claude', attributed_account:'1111222233334444', funding:'subscription',
          at:now-1000, model:'claude-haiku-5-5',
          tokens:{fresh_input:1000000, cache_read:0, cache_write_5m:0, cache_write_1h:0, output:0, reasoning:0}}] : [],
        currentWindows:[{account, resource, start_at:now-3600000, observed_at:clock.at, meter_points:5}],
      });
      measurements.push(estimate);
      return estimate;
    }});
    used.claude = 5;
    const f = await appFixture(t);
    const {owner, lender, circle} = await f.connect({adapters, clock:() => clock.at/1000,
      sessionHomeDir:join(f.root, 'sessions'), lendingNow:() => clock.at,
      lendingPace50:{source,
        // Observations are collected before this refusal; no synthetic job runs.
        objectiveInputFor:() => ({refuse:'fixture_no_execution'}),
        measurementHistory:{record(type, data) {
          if (type === 'observation_completed' || type === 'observation_failed') observations.push({type, ...data});
          return null;
        }},
      }}, {clock:() => clock.at/1000});
    await api(lender.app, '/api/lending/limits', {method:'POST', body:{idleOnly:false}});
    await api(lender.app, '/api/agents/claude-code-subscription', {method:'POST', body:{useForLending:true}});
    await api(lender.app, '/api/agents/claude-code-subscription/run',
      {method:'POST', body:{model:'claude-haiku-5-5', effort:null}});
    await api(lender.app, '/api/lending/on', {method:'POST', body:{circle:circle.id}});
    await api(lender.app, '/api/lending/mode', {method:'POST', body:{circle:circle.id, mode:'auto'}});
    await api(owner.app, '/api/jobs', {method:'POST', body:{circle:circle.id,
      git:{url:'https://github.com/example/synthetic.git', commit:'1'.repeat(40)},
      prompt:'Synthetic conversion check; no external execution.',
      harness:'claude-code-subscription', model:'claude-haiku-5-5'}});
    await api(lender.app, '/api/agents/refresh', {method:'POST', body:{agents:['claude-code-subscription']}});
    await waitFor(() => observations.some(row => row.type === 'observation_completed'), 'completed measurement observation');
    const completed = observations.filter(row => row.type === 'observation_completed');
    assert.ok(completed.length > 0, 'observation_failed alone must never pass');
    assert.ok(measurements.length >= 2, 'the producer calls the real measurement function');
    if (hasUsage) {
      assert.ok(measurements.some(estimate => estimate?.provenance?.method === 'current-window'),
        'a real current-window estimate was produced');
    } else {
      assert.ok(measurements.every(estimate => estimate === null), 'no usage produces only honest unknown estimates');
    }
    for (const observation of completed) {
      assert.equal(observation.resources.length, 2, 'empty resource loops must never pass');
      for (const row of observation.resources) {
        if (hasUsage) {
          assert.ok(Number.isSafeInteger(row.kappa_micro) && row.kappa_micro > 0, row.id + ' has a measured rate');
        } else {
          assert.equal(row.kappa_micro, null, row.id + ' honestly has no measured rate');
        }
      }
    }
    assert.equal(lender.backend.calls.some(([kind]) => kind === 'run'), false);
  });
}
