import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {settleOwnResets} from './helpers/pace50-reset-assertions.mjs';
import {NOW, ACCOUNT, WEEK} from './helpers/pace50-fixtures.mjs';

const deferred = () => {let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve};};
const job = {budget_v1:{max_list_usd:10},requirements:{limits:{wall_seconds:60}},expires_at:new Date(NOW+3600000).toISOString()};
function fixture(t) {
  const directory=mkdtempSync(join(homedir(),'.tmp','admission-feedback-'));
  const resets={weekly:42*3600000,short:1.25*3600000};
  const source=createSyntheticPace50Source({start:NOW,resets,used:{weekly:20e6,short:20e6},kappa:{weekly:100000,short:100000}});
  const clock={at:NOW}, opened=[],stops=[];
  const open=()=>{
    const runtime=createLendingRuntime({directory,now:()=>clock.at,settings:()=>({limits:{lendingPolicy:{}}}),
      pace50:{account:ACCOUNT,account_week_id:WEEK,source,contextFor:()=>({consent:true,ownerAbsent:true})}});
    opened.push(runtime);return runtime;
  };
  t.after(async()=>{for(const runtime of opened)await runtime.close();rmSync(directory,{recursive:true,force:true});});
  const reserve=(r,id='job')=>r.candidate.reserve({attemptId:id,jobId:id,provider:'claude',model:'claude-haiku-5-5',ownerAbsent:true,job:{...job,expires_at:new Date(clock.at+3600000).toISOString()}});
  return {source,clock,open,reserve,stops,resets};
}
const rows = r => r.pace50.state().attempts[0].resources;
// Oracle uses integer ratios directly, never production repricing/coverage helpers.
function assertLiability(r, before, numerator, denominator) {
  for (const row of rows(r)) {
    const old=before.find(b=>b.id===row.id);
    const expected=Number((BigInt(old.held_micro+old.unrepresented_micro)*BigInt(numerator)+BigInt(denominator-1))/BigInt(denominator));
    assert.equal(row.held_micro+row.unrepresented_micro,expected,row.id);
    assert.equal(row.spent_micro,old.spent_micro);
    assert.deepEqual(row.burns,old.burns);
  }
}

test('AdmissionFeedback: deferred same-spend generations drain without renewing blind exposure', {timeout:15000}, async t=>{
  const f=fixture(t),r=f.open();
  r.candidate.registry.bind('job',{stop:why=>f.stops.push(why)});
  assert.equal((await f.reserve(r)).ok,true);
  await r.candidate.started('job',{ok:true});
  const before=rows(r),check=r.candidate.registry.entry('job').liveCheck,exposure=check.exposure;
  const observe=f.source.observe, entered=deferred(),release=deferred();let reads=0;
  t.after(()=>release.resolve());
  f.source.observe=async args=>{const snapshot=await observe(args);if(++reads===1){entered.resolve();await release.promise;}return snapshot;};
  const first=r.candidate.recheck({attemptId:'job',usd:5});await entered.promise;
  assertLiability(r,before,1,1);
  assert.equal(check.spent,5);
  const second=r.candidate.recheck({attemptId:'job',usd:5});
  const third=r.candidate.recheck({attemptId:'job',usd:2});
  assert.equal(check.spent,5,'lower or duplicate native totals cannot reduce cumulative spend');
  assert.equal(r.candidate.registry.entry('job').pendingMeter,true);
  release.resolve();
  const outcomes=await Promise.all([first,second,third]);
  assert.ok(outcomes.every(o=>o.deferred&&o.reason==='meter_coverage_pending'));
  assert.equal(reads,2,'coalesced same-spend triggers require a second fresh response');
  assert.equal(r.candidate.registry.entry('job').pendingMeter,false);
  assert.equal(r.candidate.registry.entry('job').rechecking,null);
  assert.equal(check.exposure,exposure);
  assertLiability(r,before,1,1);
  assert.deepEqual(f.stops,[]);
  // A further cycle with a rate surprise preserves all prior liability.
  f.source.state.used.weekly+=1.5e6;f.source.state.used.short+=1.5e6;
  const surprise=await r.candidate.recheck({attemptId:'job',usd:5});
  assert.equal(surprise.reason,'meter_rate_surprise');
  assertLiability(r,before,3,1);
  assert.equal(check.exposure,exposure,'rate feedback cannot replenish the original native budget');
  assert.equal(r.pace50.state().rate_feedback.blocked,true);
  assert.deepEqual(f.stops,['provider_limit']);
  assert.equal((await f.reserve(r,'blocked')).ok,false);
  assert.equal(r.pace50.state().attempts.length,1);
});

test('AdmissionFeedback: restart, old and partial coverage retain block; settled burn is never repriced', {timeout:15000}, async t=>{
  const f=fixture(t);let r=f.open();
  r.candidate.registry.bind('job',{stop:why=>f.stops.push(why)});
  assert.equal((await f.reserve(r)).ok,true);await r.candidate.started('job',{ok:true});
  const before=rows(r);
  f.source.state.used.weekly+=3e6;f.source.state.used.short+=3e6;
  assert.equal((await r.candidate.recheck({attemptId:'job',usd:10})).reason,'meter_rate_surprise');
  assertLiability(r,before,3,1);
  const durable=r.pace50.state();await r.close();r=f.open();
  assert.deepEqual(r.pace50.state(),durable);
  assert.equal((await f.reserve(r,'restart-blocked')).ok,false);
  const coverage=(id,resources,observed_at=f.clock.at)=>r.pace50.deliver({type:'meter_feedback_covered',event_id:id,
    account:ACCOUNT,at:f.clock.at,observed_at,complete:true,refresh_succeeded:true,resources});
  const feedback=durable.rate_feedback.rates;
  assert.equal((await coverage('live-coverage',feedback)).applied,false,'running liabilities prevent coverage');
  assert.equal(r.pace50.state().rate_feedback.blocked,true);
  await r.candidate.recordCleanup('job',{removed:true});
  const finished=await r.candidate.finish({attemptId:'job',provider:'claude',model:'claude-haiku-5-5',
    execution:{stdout:'',lending_meter:{model:'claude-haiku-5-5',final:true,cost_usd:10,tokens:{}}}});
  assert.equal(finished.cessation.applied,false,JSON.stringify(finished));
  assert.equal(finished.cessation.reason,'usage_unreconciled');
  assert.ok(rows(r).every(row=>row.held_micro+row.unrepresented_micro===3e6&&row.released_micro===0));
  assert.equal((await coverage('aggregate-after-cleanup',feedback)).applied,false);
  await settleOwnResets(r.pace50,'job');
  f.clock.at=Math.max(...rows(r).map(row=>row.resets_at))+1;
  for(const [kind,duration] of [['weekly',7*86400000],['short',5*3600000]])
    while(NOW+f.resets[kind]<=f.clock.at)f.resets[kind]+=duration;
  assert.ok(rows(r).every(row=>row.held_micro===0&&row.unrepresented_micro===0));
  assert.ok(rows(r).every(row=>row.spent_micro===3e6));
  const settled=rows(r);
  f.clock.at+=1000;
  const nextRates=feedback.map(rate=>({...rate,kappa_micro:600000}));
  const next=await r.pace50.deliver({type:'meter_feedback',event_id:'next-generation',account:ACCOUNT,
    at:f.clock.at,observed_at:f.clock.at,resources:nextRates});
  assert.equal(next.applied,true);
  assert.deepEqual(rows(r),settled,'represented burns stay unchanged under a later conversion');
  assert.equal((await coverage('old',nextRates,f.clock.at-1)).applied,false);
  assert.equal(r.pace50.state().rate_feedback.pending.length,2);
  assert.equal((await coverage('subset',[nextRates[0]])).applied,true);
  assert.equal(r.pace50.state().rate_feedback.blocked,true);
  assert.deepEqual(r.pace50.state().rate_feedback.pending.map(p=>p.id),[nextRates[1].id]);
  assert.equal((await f.reserve(r,'subset-blocked')).ok,false);
  assert.equal((await coverage('all',nextRates)).applied,true);
  assert.equal(r.pace50.state().rate_feedback.blocked,false);
  assert.deepEqual(rows(r),settled);
  assert.equal((await f.reserve(r,'permitted')).ok,true,'only reconciled liabilities and complete coverage reopen admission');
});

test('AdmissionFeedback: queued On cannot overtake later Stop or pending feedback', {timeout:15000}, async t=>{
  for(const type of ['owner_stop','meter_feedback_pending']) {
    const f=fixture(t),r=f.open();
    assert.equal((await f.reserve(r)).ok,true);
    const rates=rows(r).map(row=>({id:row.id,instance:row.instance,epoch:row.epoch,anchor_at:row.anchor_at,
      resets_at:row.resets_at,kappa_micro:row.kappa_micro,used_micro:row.baseline_used_micro}));
    const entered=deferred(),release=deferred();t.after(()=>release.resolve());
    r.candidate.registry.bind('job',{stop:async()=>{entered.resolve();await release.promise;}});
    const on=r.pace50.deliver({type:'on',event_id:`on-${type}`,at:f.clock.at});
    const stop=r.pace50.deliver({type,event_id:`fence-${type}`,at:f.clock.at,account:ACCOUNT,attempt_id:'job',resources:rates});
    const admission=f.reserve(r,`race-${type}`);
    await entered.promise;
    assert.equal((await on).applied,true);
    assert.equal((await admission).ok,false);
    assert.equal(r.pace50.state().attempts.length,1);
    assert.ok(rows(r).every(row=>row.held_micro>0),'requesting Stop never refunds execution liability');
    release.resolve();assert.equal((await stop).applied,true);
  }
});

test('AdmissionFeedback: a delayed old response cannot swallow a newer spend and rate surprise', {timeout:15000}, async t=>{
  const f=fixture(t),r=f.open();
  r.candidate.registry.bind('job',{stop:why=>f.stops.push(why)});
  assert.equal((await f.reserve(r)).ok,true);
  await r.candidate.started('job',{ok:true});
  const before=rows(r),check=r.candidate.registry.entry('job').liveCheck,exposure=check.exposure;
  const observe=f.source.observe,entered=deferred(),release=deferred();let reads=0;
  t.after(()=>release.resolve());
  f.source.observe=async args=>{
    const snapshot=await observe(args);
    if(++reads===1){entered.resolve();await release.promise;}
    return snapshot;
  };
  const old=r.candidate.recheck({attemptId:'job',usd:5});await entered.promise;
  assertLiability(r,before,1,1);
  f.source.state.used.weekly+=3e6;f.source.state.used.short+=3e6;
  const newer=r.candidate.recheck({attemptId:'job',usd:10});
  assert.equal(check.spent,10);
  assert.equal(r.candidate.registry.entry('job').pendingMeter,true);
  assertLiability(r,before,1,1);
  release.resolve();
  const outcomes=await Promise.all([old,newer]);
  assert.ok(outcomes.every(o=>o.reason==='meter_rate_surprise'));
  assert.equal(reads,2);
  assertLiability(r,before,3,1);
  assert.equal(check.spent,10);
  assert.equal(check.exposure,exposure);
  assert.equal(r.candidate.registry.entry('job').pendingMeter,false);
  assert.equal(r.candidate.registry.entry('job').rechecking,null);
  assert.equal(r.pace50.state().rate_feedback.blocked,true);
  assert.deepEqual(f.stops,['provider_limit']);
  assert.equal((await f.reserve(r,'newer-blocked')).ok,false);
});
