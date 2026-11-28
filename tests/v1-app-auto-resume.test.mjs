import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, waitFor } from './helpers/v1-lifecycle-fixture.mjs';

const lendingOn = async (app, circle) => {
  await api(app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
};
const signedIn = {providers: [{harness_id: 'codex', installed: true, signedIn: true}]};
const cold = () => [{spec:legacyProxyHarness('codex')}]; // no sign-in evidence yet, as after a real restart
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Off pressed while the pause-end resume waits in the lane is not undone by that resume', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  let gate, held = false;
  const {lender, circle} = await f.connect({identityProbe: async () => {
    if (held) await new Promise(resolve => { gate = resolve; });
    return signedIn;
  }});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  const until = Date.now() + 700;
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {until}});
  held = true; // a network mutation now holds the serialized lane
  const refresh = api(lender.app, '/api/agents/refresh', {method: 'POST', body: {}});
  await waitFor(() => gate, 'the lane is held');
  await settle(Math.max(0, until - Date.now()) + 300); // the pause timer fires and queues its resume behind the lane
  await api(lender.app, '/api/lending/off', {method: 'POST', body: {}});
  assert.equal((await api(lender.app, '/api/status')).state, 'off');
  gate(); await refresh;
  await settle(600);
  const status = await api(lender.app, '/api/status');
  assert.equal(status.state, 'off', 'the queued automatic resume must not turn lending back on');
  assert.equal(status.intent.state, 'off');
});

test('a second pause replaces the first: the first pause-end resume does nothing', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  let gate, held = false;
  const {lender, circle} = await f.connect({identityProbe: async () => {
    if (held) await new Promise(resolve => { gate = resolve; });
    return signedIn;
  }});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  const first = Date.now() + 600;
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {until: first}});
  held = true;
  const refresh = api(lender.app, '/api/agents/refresh', {method: 'POST', body: {}});
  await waitFor(() => gate, 'the lane is held');
  await settle(Math.max(0, first - Date.now()) + 300);
  const later = Date.now() + 60000;
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {until: later}});
  gate(); await refresh;
  await settle(600);
  const status = await api(lender.app, '/api/status');
  assert.deepEqual([status.state, status.until], ['paused', later]);
});

test('a timed pause that survives a restart checks the agents before it resumes, and shows a failed resume', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  const until = Date.now() + 30000;
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {until}});
  await lender.app.close();
  let probes = 0;
  const restarted = await f.start('lender', {adapters: cold(), identityProbe: async () => { probes++; return signedIn; }});
  assert.equal((await api(restarted.app, '/api/status')).state, 'paused');
  assert.equal(probes, 0, 'a future pause skips the startup check');
  await waitFor(async () => (await api(restarted.app, '/api/status')).state === 'ready', 'lending resumed after the restart pause', 40000);
  assert.ok(probes > 0, 'the agents were checked before lending came back');
});

test('a pause-end resume that cannot start says why instead of silently staying stopped', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {until: Date.now() + 1500}});
  await lender.app.close();
  const restarted = await f.start('lender', {adapters: cold(), identityProbe: async () => ({providers: [{harness_id: 'codex', installed: true, signedIn: false}]})});
  const status = await waitFor(async () => { const s = await api(restarted.app, '/api/status'); return s.state === 'blocked' && s.reason === 'no_accounts' && s; }, 'the final agent check failure', 20000);
  assert.equal(status.reason, 'no_accounts');
});

test('Off pressed during the restart check is not undone when the check ends', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  await lender.app.close();
  let gate, entered = false;
  const restarted = await f.start('lender', {adapters: cold(), identityProbe: async () => { entered = true; await new Promise(resolve => { gate = resolve; }); return signedIn; }});
  await waitFor(() => entered, 'the startup check is running');
  await api(restarted.app, '/api/lending/off', {method: 'POST', body: {}});
  gate();
  await settle(800);
  const status = await api(restarted.app, '/api/status');
  assert.equal(status.state, 'off', 'the restart resume must stand down after an explicit Off');
});

test('automatic rules survive restart checks without renewal and expiry prevents a second execution', {timeout: 120000}, async t => {
  const realNow = Date.now.bind(Date);
  let appOffset = 0, allowanceOffset = 0;
  const appClock = () => (realNow() + appOffset) / 1000;
  const allowanceNow = () => realNow() + allowanceOffset;
  const reset = realNow() + 86400000;
  const harness = 'claude-code-subscription';
  const warm = () => [{spec:legacyProxyHarness(harness),installed:true,signedIn:true,
    harnessVersion:'synthetic-only',models:['claude-haiku-5-5'],capabilities:[]}];
  const common = {syntheticAccounts:'claude',clock:appClock,adapters:warm(),
    quotaReader:async()=>({provider:'claude',remaining:100,observedAt:allowanceNow()}),
    lendingNow:allowanceNow,
    lendingReadings:async()=>({windows:[{window_id:'seven_day',window_minutes:10080,
      state:'open',used_pct:5,observed_at:allowanceNow(),resets_at:reset}]})};
  const f = await appFixture(t);
  const {owner,lender,circle} = await f.connect(common);
  await api(lender.app,'/api/agents/'+harness+'/run',{method:'POST',body:{model:'claude-haiku-5-5',effort:null}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{
    dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false,
    lendingPolicy:{strategy:'fixed_share',strategyParams:{fixedSharePct:20,keepPct:30},
      providerConsent:{claude:true},accountPlans:{claude:'max20'}}}});
  await api(lender.app,'/api/agents/'+harness,{method:'POST',body:{useForLending:true}});
  const rule = {id:'restart-expiry',circle:circle.id,people:[owner.app.device.keyId],agents:[harness],
    maxWallSeconds:1200,dailyJobs:3,weeklyJobs:12,dailyMinutes:60,weeklyMinutes:240,
    expiresAt:realNow()+300000};
  await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:[rule]}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const savedRules = (await api(lender.app,'/api/lending')).standingRules;
  await lender.app.close();
  let release, entered = false, probes = 0;
  const gate = new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  const restarted = await f.start('lender',{...common,
    adapters:[{spec:legacyProxyHarness(harness),models:['claude-haiku-5-5']}],
    identityProbe:async()=>{probes++;entered=true;await gate;return {providers:[
      {harness_id:harness,installed:true,signedIn:true}]};}});
  await waitFor(()=>entered,'fresh restart identity check');
  const submit = prompt => api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{
    circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt,harness}});
  const first = await submit('Synthetic restart positive control');
  assert.equal(restarted.backend.calls.filter(([kind])=>kind==='run').length,0);
  assert.notEqual(f.jobs.get(first.jobDigest).state,'result-accepted');
  release();
  // Continuous lending starts on day one: completing this job needs no legacy ten-minute warm-up.
  assert.ok(appClock()*1000<rule.expiresAt,'the positive control is still within the frozen rule');
  await waitFor(()=>f.jobs.get(first.jobDigest).state==='result-accepted','actual synthetic borrower completion',30000);
  assert.ok(probes>0);
  const runs = restarted.backend.calls.filter(([kind])=>kind==='run').length;
  assert.equal(runs,1,'positive control actually executed once');
  assert.deepEqual((await api(restarted.app,'/api/lending')).standingRules,savedRules);
  appOffset += 300001;
  allowanceOffset += 300001;
  assert.ok(appClock()*1000>rule.expiresAt,'standing-rule clock, not only allowance clock, passed expiry');
  const second = await submit('Synthetic expired rule refusal');
  await waitFor(async()=>{
    const pending=await api(restarted.app,'/api/approvals');
    return JSON.stringify(pending).includes(second.jobDigest);
  },'expired rule requires manual approval instead of automatic execution',20000);
  assert.equal(restarted.backend.calls.filter(([kind])=>kind==='run').length,runs);
  assert.equal(f.jobs.get(second.jobDigest).state,'queued');
  assert.deepEqual((await api(restarted.app,'/api/lending')).standingRules,savedRules,
    'restart and expiry never renew or widen the frozen rule');
});
