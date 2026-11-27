import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../../lib/v1/lender.mjs';
import {realLenderFixture} from '../helpers/v1-real-lender-fixture.mjs';
import {until} from '../helpers/v1-lender-fixture.mjs';

// Authoring-only regression. The real signed store/client/lender path is used;
// prepare throws before returning a handle. No agent or successful run is faked.
const guestContext = Object.freeze({jobId:'guest-job',attemptId:'guest-attempt',generation:999});
async function fixture(t) {
  const pairs = [{model:'gpt-6-luna',effort:'low'}];
  const f = await realLenderFixture(t, {offers:true,
    run:{model:'gpt-6-sol',effort:'high',model_efforts:pairs},
    mutateJob:job => {
      job.expires_at = new Date(Date.parse(job.created_at)+3600000).toISOString().replace('.000Z','Z');
      job.requirements.harness=['codex']; delete job.requirements.model;
      job.requirements.capabilities=[...new Set([...job.requirements.capabilities,'auto_run_v1'])];
      job.auto_run_v1={intent:'cheapest'};
    }});
  f.backend.requestStop=async()=>({compute_stopped:true});
  await f.client.heartbeat({boot:'preparation-binding',seq:0,intent:{state:'ready'},
    execution:{state:'idle'},blockers:[],agents:[{adapter:'codex',readiness:'ready',
      models:['gpt-6-luna'],per_job_max_minutes:2,model_efforts:pairs,auto_run_intents:['cheapest']}],
    capabilities:['budget_v1','model_effort_pairs_v1','auto_run_v1']});
  return f;
}

async function exercise(t,{poisonGuest=false,cancelAccepted=false}={}) {
  const f=await fixture(t), controller=new AbortController(), prepared=[], diagnostics=[];
  const sentinel=Object.assign(new Error('owned preparation-binding stop'),{
    code:'preparation_binding_stop',cleanup_receipt:{removed:true,scratch_removed:true}});
  let starts=0, destroys=0;
  // Keep real allowance reservation, accounting and recovery untouched.
  if(poisonGuest) {
    const admit=f.backend.admitJob.bind(f.backend);
    let admissions=0;
    f.backend.admitJob=async spec=>{
      const result=await admit(spec);
      // Untrusted guest spec must not be promoted into trusted prepare options.
      // Inject only after the executor's second successful admission; do not
      // change the signed job or the lender's first admission decision.
      if(result.ok&&++admissions===2)spec.preparationContext=guestContext;
      return result;
    };
  }
  f.backend.prepare=async(spec,options)=>{
    prepared.push({spec,options,accepted:structuredClone(
      f.saves.findLast(row=>row?.acceptedClaim?.claim?.attempt)?.acceptedClaim),
      pending:structuredClone(f.saves.findLast(row=>row?.pending?.attemptId)?.pending),
      frozen:Object.isFrozen(options.preparationContext)});
    throw sentinel;
  };
  f.backend.start=async()=>{starts++;throw new Error('unexpected backend start');};
  f.backend.destroy=async()=>{destroys++;throw new Error('no handle exists to destroy');};
  const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,
    policy:f.policy,clock:f.clock,approve:async()=>true,credentialValues:async()=>[],
    onDiagnostic:e=>diagnostics.push(e),onEvent:e=>{
      f.events.push(e);
      if(cancelAccepted&&e.status==='offer-accepted')controller.abort();
    }});
  const loop=lender.start(controller.signal);
  // Unlike the launch helper's race, leave no owned timeout behind and await cleanup.
  f.stop=async()=>{controller.abort();await loop;};
  if(cancelAccepted) {
    await until(()=>f.events.some(e=>e.status==='offer-accepted'),'accepted signed attempt',20000);
    await f.stop();
    assert.ok(f.saves.some(row=>row?.acceptedClaim?.claim?.attempt),'acceptance was durably saved');
    assert.equal(prepared.length,0);
  } else {
    await until(()=>diagnostics.some(e=>e.code===sentinel.code),'owned prepare sentinel reached lender',20000);
    await f.stop();
    assert.equal(prepared.length,1,'one preparation for this accepted attempt');
    const row=prepared[0], claim=row.accepted?.claim, attempt=claim?.attempt;
    assert.ok(attempt?.attempt_id,'compare against the actual durable accepted receipt');
    assert.equal(claim.job_digest,f.jobDigest);
    assert.equal(row.pending.attemptId,attempt.attempt_id);
    assert.deepEqual(row.options.preparationContext,{
      jobId:row.pending.jobId,attemptId:attempt.attempt_id,generation:attempt.generation});
    assert.equal(row.pending.jobId,row.spec.job_id);
    assert.equal(row.pending.attempt.job_digest,claim.job_digest);
    assert.equal(row.frozen,true);
    assert.ok(row.options.signal instanceof AbortSignal);
    assert.equal(typeof row.options.wallRemainingMs,'function');
    assert.equal(row.options.accountKey,undefined,
      'the fixture default account requires no added-account routing override');
    if(poisonGuest) {
      assert.deepEqual(row.spec.preparationContext,guestContext);
      assert.notDeepEqual(row.options.preparationContext,guestContext);
    }
    assert.ok(diagnostics.some(e=>e.code===sentinel.code&&e.message===sentinel.message),
      'the exact owned failure, not a later fake successful run, was observed');
  }
  assert.equal(starts,0);
  assert.equal(destroys,0);
  assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
  assert.ok(!f.events.some(e=>e.status==='finished'||e.status==='running'));
  return prepared[0]?.options.preparationContext;
}

test('signed accepted attempts bind trusted preparation context without running an agent',
  {timeout:60000},async t=>{
    let first,second;
    await t.test('first accepted attempt',async t=>{first=await exercise(t);});
    await t.test('distinct accepted attempt ignores guest context',async t=>{second=await exercise(t,{poisonGuest:true});});
    assert.notEqual(first.attemptId,second.attemptId);
    assert.notEqual(first.jobId,second.jobId);
  });
test('cancellation immediately after durable acceptance never prepares or starts',
  {timeout:30000},async t=>{await exercise(t,{cancelAccepted:true});});
