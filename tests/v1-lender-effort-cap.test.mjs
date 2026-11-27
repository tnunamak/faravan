import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender,lendableModelEfforts} from '../lib/v1/lender.mjs';
import {until} from './helpers/v1-lender-fixture.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK} from './helpers/pace50-fixtures.mjs';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';

// The lender's saved "highest effort" decides which model and effort pairs friends can ask for.
const harness={harness_id:'codex'};
const pairs=['low','medium','high'].map(effort=>({model:'example-model',effort}));
const adapterWith=run=>({spec:harness,run});
const runtimeWith=cap=>({candidate:{},effortMax:()=>cap});
function launch(t,f,approve){const c=new AbortController();const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,approve,onEvent:e=>f.events.push(e)});const loop=lender.start(c.signal);f.stop=async()=>{c.abort();await loop;};return lender;}
// The real candidate returns the saved cap in its decision; the fixture candidate returns null, so mirror the real one.
function capFromRuntime(f,cap){
  f.policy.lendingRuntime.effortMax=()=>cap;
  const candidate=f.policy.lendingRuntime.candidate,reserve=candidate.reserve.bind(candidate);
  candidate.reserve=async args=>{const out=await reserve(args);return out.ok?{...out,decision:{effort_max:cap}}:out;};
}
const jobOptions=(run,extra={})=>({offers:true,run,mutateJob:job=>{
  job.expires_at=new Date(Date.parse(job.created_at)+3600000).toISOString().replace('.000Z','Z');
  job.requirements.harness=['codex'];job.requirements.model={any_of:['example-model']};
  job.requirements.capabilities=[...new Set([...job.requirements.capabilities,'budget_v1'])];
  Object.assign(job,extra);
}});

test('a cap of low advertises only the low pair',()=>{
  const out=lendableModelEfforts(adapterWith({model:null,effort:null,model_efforts:pairs}),{lendingRuntime:runtimeWith('low')});
  assert.deepEqual(out.pairs,[pairs[0]]);
});

test('a cap of medium advertises low and medium, and an explicit pair is never lowered',()=>{
  const out=lendableModelEfforts(adapterWith({model:null,effort:null,model_efforts:[pairs[2]]}),{lendingRuntime:runtimeWith('medium')});
  assert.deepEqual(out.pairs,[]);
  assert.deepEqual(lendableModelEfforts(adapterWith({model:null,effort:null,model_efforts:pairs}),{lendingRuntime:runtimeWith('medium')}).pairs,pairs.slice(0,2));
});

test('the lender default effort above the cap is advertised at the cap',()=>{
  const out=lendableModelEfforts(adapterWith({model:'example-model',effort:'high'}),{lendingRuntime:runtimeWith('medium')});
  assert.deepEqual(out.pairs,[{model:'example-model',effort:'medium'}]);
});

test('the default cap of high changes nothing, with or without a saved cap',()=>{
  const run={model:null,effort:null,model_efforts:pairs};
  for(const runtime of [runtimeWith('high'),runtimeWith('xhigh'),runtimeWith('max'),{candidate:{}},null])
    assert.deepEqual(lendableModelEfforts(adapterWith(run),{lendingRuntime:runtime}).pairs,pairs);
  assert.deepEqual(lendableModelEfforts(adapterWith({model:'example-model',effort:'high'}),{lendingRuntime:runtimeWith('high')}).pairs,[pairs[2]]);
});

test('a job that asks for more effort than the cap is not run',async t=>{
  const f=await realLenderFixture(t,jobOptions({model:null,effort:null,model_efforts:[pairs[1],pairs[2]]},{budget_v1:{max_list_usd:2,effort:'high'}}));
  // The job is offered and claimed while the cap is high. The cap drops right after the claim, so the claim-time check decides.
  capFromRuntime(f,'high');
  for(const name of ['claimJob','claimNext']){
    const claim=f.client[name].bind(f.client);
    f.client[name]=async(...args)=>{const out=await claim(...args);f.policy.lendingRuntime.effortMax=()=>'medium';return out;};
  }
  await f.client.heartbeat({boot:'cap-decline',seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],
    agents:[{adapter:'codex',readiness:'ready',models:['example-model'],per_job_max_minutes:2,model_efforts:[pairs[1],pairs[2]]}],capabilities:['budget_v1','model_effort_pairs_v1']});
  f.backend.requestStop=async()=>({compute_stopped:true});
  launch(t,f,async()=>true);
  await until(()=>f.events.some(e=>e.status==='declined'),'the claim was declined',8000);
  assert.equal(f.events.find(e=>e.status==='declined').reason,'requirements_unsupported');
  assert.equal((await f.owner.getJob(f.jobDigest)).attempts_started,0);
  assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
});

async function entrypointFor(t,cap,run={model:'example-model',effort:'high'},advertised=cap==='medium'?'medium':'high'){
  const f=await realLenderFixture(t,{offers:true,run,mutateJob:job=>{
    job.expires_at=new Date(Date.parse(job.created_at)+3600000).toISOString().replace('.000Z','Z');}});
  capFromRuntime(f,cap);
  await f.client.heartbeat({boot:'cap-default',seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],
    agents:[{adapter:'codex',readiness:'ready',models:['example-model'],per_job_max_minutes:2,model_efforts:[{model:'example-model',effort:advertised}]}],capabilities:['budget_v1','model_effort_pairs_v1']});
  f.backend.requestStop=async()=>({compute_stopped:true});
  let entrypoint;const start=f.backend.start;
  f.backend.start=async(handle,opts)=>{if(handle._entrypoint.includes('model_reasoning_effort='))entrypoint=handle._entrypoint;return start(handle,opts);};
  launch(t,f,async()=>true);
  await until(()=>f.calls.some(([kind])=>kind==='run'),'job ran',8000);
  return entrypoint;
}

test('the lender default effort above the cap runs at the cap',async t=>{
  assert.match(await entrypointFor(t,'medium'),/model_reasoning_effort=medium/);
});

test('a lender with no default effort and a low cap runs at the cap',async t=>{
  assert.match(await entrypointFor(t,'low',{model:'example-model',effort:null},'low'),/model_reasoning_effort=low/);
});

test('with the default cap the lender default effort runs unchanged',async t=>{
  assert.match(await entrypointFor(t,'high'),/model_reasoning_effort=high/);
});

test('limits.set with effortMax changes the state the page shows and the pairs the heartbeat offers',{timeout:60000},async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect({heartbeatMs:100});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/agents/codex/run',{method:'POST',body:{model:null,effort:null,model_efforts:[
    {model:'pair-one',effort:'low'},{model:'pair-one',effort:'medium'},{model:'pair-one',effort:'high'}]}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const efforts=beat=>beat.agents?.find(a=>a.adapter==='codex')?.model_efforts?.map(pair=>pair.effort).join();
  await waitFor(()=>f.heartbeats?.findLast(b=>efforts(b)==='low,medium,high'),'all three pairs offered',15000);
  assert.equal((await api(lender.app,'/api/lending')).limits.lendingPolicy.effortMax,'high');
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{lendingPolicy:{effortMax:'medium'}}});
  await waitFor(()=>f.heartbeats?.findLast(b=>efforts(b)==='low,medium'),'capped pairs offered',15000);
  assert.equal((await api(lender.app,'/api/lending')).limits.lendingPolicy.effortMax,'medium');
});

test('the real admission returns the saved cap with its grant',{timeout:30000},async t=>{
  const directory=fs.mkdtempSync(join(tmpdir(),'effort-cap-'));
  const source=createSyntheticPace50Source({start:NOW});
  const objectiveInputFor=source.objectiveInputFor.bind(source);
  source.objectiveInputFor=args=>{const input=objectiveInputFor(args);input.job.worstCallUsdMicro=Math.ceil(claudeCallHeadroomUsd(args.request.model)*1_000_000);return input;};
  const pace=createPace50Candidate({directory,now:()=>NOW,account:ACCOUNT,account_week_id:WEEK,source,contextFor:()=>({effortMax:'medium'})});
  t.after(async()=>{await pace.adapter.close();fs.rmSync(directory,{recursive:true,force:true});});
  const job={requirements:{limits:{wall_seconds:300}},expires_at:new Date(NOW+3600e3).toISOString()};
  const granted=await pace.candidate.reserve({attemptId:'attempt-cap',jobId:'job-cap',provider:'claude',model:'claude-sonnet-5-5',job,automatic:true,ownerAbsent:true});
  assert.equal(granted.ok,true,JSON.stringify(granted));
  assert.equal(granted.decision.effort_max,'medium');
});
