import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createLender} from '../lib/v1/lender.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {until} from './helpers/v1-lender-fixture.mjs';

function launch(f) {
  const controller = new AbortController();
  const lender = createLender({client:f.client, backend:f.backend, adapters:f.adapters, policy:f.policy,
    clock:f.clock, approve:async () => true, onEvent:e => f.events.push(e)});
  const task = lender.start(controller.signal).catch(e => {
    if (e.name !== 'AbortError' && e.code !== 'aborted') throw e;
  });
  f.stop = async () => {controller.abort(); await task;};
}
const runs = f => f.calls.filter(([kind]) => kind === 'run').length;

for (const restart of [false, true])
test('throwing measurement sink during finish preserves delivery and closes the hold', {timeout:15000}, async t => {
  const f = await realLenderFixture(t, {run:{model:'gpt-6-sol'}, guardTokens:{input:100,output:10,cached_input:0,cache_write:0,reasoning_output:0}});
  let failing = false, writes = 0;
  f.policy.userActive = async () => false;
  const source = createSyntheticPace50Source({start:f.clock.now()});
  const runtime = createLendingRuntime({directory:join(f.root, 'quota'), now:() => f.clock.now(),
    settings:() => ({intent:'on', limits:{lendingPolicy:normalizeLendingPolicy({providerConsent:{codex:true}}),
      dailyJobs:10, dailyMinutes:60, maxWallSeconds:300, idleOnly:false}}),
    backend:{}, presence:() => false, lastActiveAt:() => null, selfKey:() => null,
    pace50:{postingLagBoundMs:120000,account:'synthetic-account', account_week_id:'synthetic-week-1',
    source,
    measurementHistory:{record() {if (failing) {writes++; throw new Error('measurement disk write failed');} return 'synthetic-row';}}}});
  f.policy.lendingRuntime = runtime;
  const collect = f.backend.collectDeclaredOutputs;
  f.backend.collectDeclaredOutputs = async (...args) => {const out = await collect(...args); failing = true; source.state.used.weekly += 2_000_000; source.state.used.short += 2_000_000; return out;};
  launch(f);
  await until(() => f.events.some(e => ['finished','failed','declined','reserve','paused'].includes(e.status)), 'finished work delivered', 5000);
  await f.stop();
  assert.ok(writes > 0, JSON.stringify(f.events));
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'result-accepted');
  assert.equal(f.events.some(e => e.status === 'failed'), false);
  f.clock.advance(120000);await runtime.candidate.probeHeld();
  source.state.used.weekly+=1000000;source.state.used.short+=1000000;
  await runtime.candidate.probeHeld();
  assert.equal(runtime.pace50.state().attempts[0].hold_closed, true);
  assert.equal(runtime.candidate.measurementStatus().failedWrites, writes);
});

// Replace every 200 reply to a matching request with an unreadable body.
const unreadableReply = (res) => {
  const head = res.writeHead, end = res.end;
  res.writeHead = function(status, headers) {
    return head.call(this, status, Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'content-length')));
  };
  res.end = function(bytes, ...args) {return end.call(this, this.statusCode === 200 ? '{}' : bytes, ...args);};
};
