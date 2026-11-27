import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {lendingStatus} from '../lib/v1/lending-status-copy.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK, MICRO as M} from './helpers/pace50-fixtures.mjs';

for (const native of [true, false]) test(`owner usage protects the reserve during a ${native ? 'native' : 'converted'} running job`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'owner-quota-'));
  let at = NOW, seq = 0, presenceReads = 0;
  const timers = new Map(), stops = [];
  const setTimer = (fn, ms) => {const id = ++seq; timers.set(id, {fn, at:at+ms}); return id;};
  const clearTimer = id => timers.delete(id);
  const flush = async () => {for(let i=0;i<30;i++)await new Promise(resolve => setImmediate(resolve));};
  const advance = async ms => {
    const end = at + ms;
    for (;;) {
      await flush();
      const next = [...timers].sort((a,b) => a[1].at-b[1].at)[0];
      if(!next || next[1].at>end)break;
      at=next[1].at;timers.delete(next[0]);next[1].fn();
    }
    at=end;await flush();
  };
  const policy = normalizeLendingPolicy({strategy:'fixed_share',strategyParams:{fixedSharePct:100,keepPct:30,perJobPct:100},
    providerConsent:{claude:true},accountPlans:{claude:'max20'}});
  const source = createSyntheticPace50Source({start:NOW, override:({base}) => ({...base,
    resources:base.resources.map(r => native ? {...r,conversion:'native_window',kappa_micro:null,kappa_lower_micro:null} : r)})});
  const objective = source.objectiveInputFor;
  source.objectiveInputFor = args => ({...objective(args),strategy:policy.strategy,strategyParams:policy.strategyParams});
  let idle;
  const runtime = createLendingRuntime({directory,now:() => at,
    settings:() => ({intent:'on',limits:{idleOnly:false,lendingPolicy:policy}}),
    presence:() => {presenceReads++;return true;},pace50:{source,account:ACCOUNT,account_week_id:WEEK,
      ownerSettings:{limit:() => ({state:'set',maxJobUsd:10})},nativeGuard:{setTimer,clearTimer}}});
  t.after(async () => {await idle?.adapter.close();await runtime.close();await rm(directory,{recursive:true,force:true});});
  const candidate = runtime.candidate;
  const job = {requirements:{limits:{wall_seconds:300}},expires_at:new Date(NOW+3600e3).toISOString()};
  const grant = await candidate.reserve({attemptId:'running',jobId:'first',provider:'claude',model:'claude-haiku-5-5',
    job,automatic:true,ownerAbsent:true});
  assert.equal(grant.ok,true,JSON.stringify(grant));
  await candidate.started('running',{ok:true});
  candidate.registry.bind('running',{stop:reason => stops.push(reason)});
  await runtime.readings('claude');
  await runtime.samplePresence();
  // Only the owner's provider meter rises. The lent agent emits no token or usage events.
  source.state.used.weekly=70*M;
  await advance(30_000);
  assert.deepEqual(stops,[native?'allowance_reached':'provider_limit'],'the existing quota stop path handles concurrent owner use');
  assert.equal(candidate.nativeGuard.status('running').stop_reason,'allowance_reached');
  assert.match(lendingStatus({reason:'native_guard_allowance_reached'}).line,/allowance/);
  const held = await candidate.gate({provider:'claude',job,model:'claude-haiku-5-5',automatic:true,ownerAbsent:true});
  assert.ok(held,'no second job is admitted at the reserve floor');
  // A free execution slot still refuses: this is the quota floor, not just the running-job concurrency guard.
  idle = createPace50Candidate({directory:join(directory,'admission'),source,account:ACCOUNT,account_week_id:WEEK,
    now:() => at,contextFor:() => ({consent:true,ownerAbsent:true,strategy:policy.strategy,strategyParams:policy.strategyParams}),
    ownerSettings:{limit:() => ({state:'set',maxJobUsd:10})}});
  const admission = await idle.candidate.reserve({attemptId:'next',jobId:'second',provider:'claude',model:'claude-haiku-5-5',
    job,automatic:true,ownerAbsent:true});
  assert.equal(admission.ok,false);
  assert.equal(admission.reason,'quota_reserve');
  assert.equal(idle.adapter.state().attempts.length,0);
  assert.equal(presenceReads,0,'quota guarding does not depend on presence');
});

test('a quota guard stop uses the lender stop control and explains the result to the borrower', {timeout:60000}, async t => {
  const {createLender}=await import('../lib/v1/lender.mjs');
  const {lenderFixture,until}=await import('./helpers/v1-lender-fixture.mjs');
  const f=await lenderFixture(t,{hold:true,run:{model:'gpt-6-sol'},
    mutateJob:payload => {payload.requirements.limits.wall_seconds=300;},
    policy:{mode:'auto',idleOnly:false,lendingPolicy:normalizeLendingPolicy(),userActive:() => assert.fail('presence is off')}});
  const source=createSyntheticPace50Source({start:f.clock.now()});
  const runtime=createLendingRuntime({directory:join(f.root,'quota'),now:() => f.clock.now(),
    settings:() => ({intent:'on',limits:{idleOnly:false,lendingPolicy:normalizeLendingPolicy({providerConsent:{codex:true}})}}),
    presence:() => assert.fail('presence is off'),pace50:{source,account:ACCOUNT,account_week_id:WEEK,
      nativeGuard:{setTimer:f.clock.setTimeout,clearTimer:f.clock.clearTimeout}}});
  f.policy.lendingRuntime=runtime;
  const stops=[];
  f.backend.requestStop=async (handle,reason) => {stops.push(reason);f.execution.resolve();return {delivered:true};};
  const start=f.backend.start.bind(f.backend);
  f.backend.start=async (handle,options) => {
    const result=await start(handle,{...options,onMeter:() => {}});
    return stops.length && !handle._bookkeeping ? {...result,stop:{stop_reason:stops[0]}} : result;
  };
  const controller=new AbortController();
  const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
    onEvent:event => f.events.push(event)});
  const running=lender.start(controller.signal);
  f.stop=async () => {controller.abort();await running;};
  await f.entered.promise;
  source.state.used.weekly=100*M;
  f.clock.advance(30_000);
  await until(() => stops.length || f.events.some(event=>event.status==='stopped'), 'quota stop reaches the execution');
  assert.deepEqual(stops,['provider_limit']);
  await until(() => f.count('/complete')===1,'stopped work is returned');
  assert.ok([...f.artifacts.values()].some(bytes=>Buffer.isBuffer(bytes)&&bytes.toString().includes('Stopped at the provider limit.')));
  await f.stop();
});
