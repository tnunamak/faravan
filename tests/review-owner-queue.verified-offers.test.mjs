import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as p from '../lib/protocol/index.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {resolveSelection} from '../lib/v1/run-request.mjs';
import {resolveHarness} from '../lib/executor.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';

const vectors=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));

// Adapted from review-owner-queue.test.mjs: verified offers replace its legacy blind claim-next route.
function verifiedOffers(f,{forge=false}={}) {
  let claimed=false,selection;
  f.override=async({route,res,body})=>{
    if(route.startsWith('/offers?')) {
      let job=structuredClone(f.job);
      if(forge) {
        job.payload.author=f.policy.ownKeyId;
        // A valid signature from another member must not authenticate an owner author field.
        job=p.signEnvelope('job',job.payload,p.privateKeyFromSeed(Buffer.from(vectors.keys[0].seed_hex,'hex')));
      }
      f.json(res,{items:claimed?[]:[{job_digest:p.digest(job.payload),job,state:'queued',attempts_started:0,current_attempt:null,result_digest:null,published_at:job.payload.created_at}],next_cursor:null,revision:0});
      return true;
    }
    if(route.endsWith('/claim')) {claimed=true;selection=resolveSelection({runRequest:f.job.payload.runRequest,accounts:body.advertisement.accounts}).value;f.json(res,{job_digest:f.jobDigest,job:f.job,attempt:{...f.attempt(),selection}});return true;}
    if(selection&&route==='/attempts/'+f.attempt().attempt_id){f.json(res,{...f.attempt(),selection});return true;}
    return false;
  };
}
function launch(f) {
  f.diagnostics=[];
  const controller=new AbortController();
  const worker=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,
    clock:f.clock,onDiagnostic:event=>f.diagnostics.push(event),onEvent:event=>f.events.push(event),approve:async()=>true});
  const running=worker.start(controller.signal);
  f.stop=async()=>{controller.abort();await running;};
  return worker;
}
for(const provider of ['codex','claude-code-subscription'])test('verified owner queue runs with native '+provider,{timeout:45000},async t=>{
  const f=await lenderFixture(t,{authorIndex:1,offers:true,harness:provider});
  f.policy.ownKeyId=f.job.payload.author;
  assert.equal(f.policy.ownKeyId,(await f.client.resultContext()).keyId);
  f.adapters[0].spec=resolveHarness(provider);
  f.adapters[0].enabled=false; // Owner eligibility must not require opting this credential into lending.
  verifiedOffers(f);launch(f);
  await until(()=>f.events.some(e=>e.reason==='cannot_run_here'||e.status==='finished'||e.status==='declined'),'native owner outcome').catch(error=>{throw new Error(error.message+' '+JSON.stringify({events:f.events.map(e=>({status:e.status,reason:e.reason})),calls:f.calls.map(row=>row[0])}),{cause:error});});
  await f.stop();
  assert.equal(f.events.some(e=>e.status==='finished'),true);
  assert.equal(f.count('/claim'),1);
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.equal(f.calls.filter(([kind])=>kind==='run').length,1);
  assert.equal(f.calls.find(([kind])=>kind==='prepare')[1].execution_scope,'owner');
});
for(const mode of ['another author','forged author','wrong local key','missing local key'])test('native queue refuses '+mode+' before claiming',{timeout:45000},async t=>{
  const f=await lenderFixture(t,{offers:true,authorIndex:mode==='missing local key'?1:0});
  f.policy.ownKeyId=mode==='wrong local key'?f.job.payload.author:mode==='missing local key'?undefined:(await f.client.resultContext()).keyId;
  f.adapters[0].spec=resolveHarness('codex');
  verifiedOffers(f,{forge:mode==='forged author'});launch(f);
  await until(()=>f.events.some(e=>e.reason==='cannot_run_here'||e.status==='failed'),'refusal');
  await f.stop();
  if(mode!=='missing local key')assert.ok(f.requests.some(r=>r.route.startsWith('/offers?')),'the real client examined offered envelopes before refusing');
  if(mode==='forged author')assert.ok(f.diagnostics.some(e=>e.code==='author_mismatch'),'the signer, not the supplied author field, determines ownership');
  assert.equal(f.count('/claim'),0);
  assert.equal(f.count('/jobs/claim-next'),0);
  assert.equal(f.calls.some(([kind])=>kind==='prepare'||kind==='run'),false);
});
test('legacy owner queue stays blocked without verified discovery',async t=>{
  const f=await lenderFixture(t,{authorIndex:1});f.policy.ownKeyId=f.job.payload.author;
  f.adapters[0].spec=resolveHarness('codex');launch(f);
  await until(()=>f.events.some(e=>e.reason==='cannot_run_here'));
  await f.stop();assert.equal(f.count('/jobs/claim-next'),0);
});

test('a saved native claim stays blocked even for the authenticated owner',async t=>{
  const f=await lenderFixture(t,{authorIndex:1,offers:true});
  f.policy.ownKeyId=f.job.payload.author;f.adapters[0].spec=resolveHarness('codex');
  const intent={jobDigest:f.jobDigest,advertisement:{harnesses:['codex'],models:[]},idempotencyKey:'saved-native-owner'};
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,claimPending:intent});
  verifiedOffers(f);launch(f);await until(()=>f.events.some(e=>e.reason==='cannot_run_here'));
  await f.stop();assert.equal(f.count('/claim'),0);assert.equal(f.count('/jobs/claim-next'),0);
  assert.deepEqual(f.saved().claimPending,{...intent,state:'created-unsent'});
});
