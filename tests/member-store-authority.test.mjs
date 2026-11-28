import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';

// A member's own store (owner-offline topology) may retain and relay the signed bytes of any job, but it only
// dispatches work that names its member. An ordinary job stays on the incumbent authority; a designated job
// runs only at the signed member's store. These are the store-side fences the dual-authority lender relies on.
const advertisement=(job,accounts)=>({harnesses:job.requirements.harness,models:[],capabilities:['results_v1','designated_member_v1','run_request_v1'],accounts,
  egress:['internet','provider-only'],enforced_limits:['wall_seconds','cpu','memory_bytes','disk_bytes','output_bytes'],
  max_limits:{wall_seconds:600,cpu:2,memory_bytes:10737483648,disk_bytes:10737483648,output_bytes:10485760}});
const offered=async client=>{const items=[];for await(const item of client.listOffers({waitSeconds:0}))items.push(item.job_digest);return items;};

test('a member store retains an ordinary job but never offers or claims it; the incumbent still does', async t => {
  const f=await realLenderFixture(t,{memberStore:true,publish:false,offers:true});
  const ordinary=await f.publish({designated:false}),ad=advertisement(f.job.payload,f.runOptions.runAccounts());
  const atMember=f.member.client(1),atIncumbent=f.client;

  assert.equal((await f.member.owner.getJob(ordinary)).state,'queued','the member store retains the signed bytes');
  assert.deepEqual(await offered(atMember),[],'a member store never offers an ordinary job');
  assert.equal(await atMember.claimNext(ad,{waitSeconds:0,leaseSeconds:120}),null,'claim-next skips it');
  await assert.rejects(()=>atMember.claimJob(ordinary,ad,{leaseSeconds:120,idempotencyKey:'member-claim'}),
    error=>error.code==='not_designated','an explicit claim is refused');
  const view=await f.member.owner.getJob(ordinary);
  assert.equal(view.current_attempt,null);assert.equal(view.attempts_started,0,'the member store never turned it into an attempt');

  assert.deepEqual(await offered(atIncumbent),[ordinary],'the incumbent offers the same job');
  const claim=await atIncumbent.claimJob(ordinary,ad,{leaseSeconds:120,idempotencyKey:'incumbent-claim'});
  assert.equal(claim.attempt.job_digest,ordinary);
  assert.equal((await f.member.owner.getJob(ordinary)).attempts_started,0,'the incumbent attempt does not reach the member copy');
});

test('a designated job is offered and claimed only at its member store, never at the incumbent', async t => {
  const f=await realLenderFixture(t,{memberStore:true,publish:false,offers:true});
  const designated=await f.publish({designated:true}),ad=advertisement(f.job.payload,f.runOptions.runAccounts());
  assert.deepEqual(await offered(f.client),[],'the incumbent preserves it and never offers it');
  await assert.rejects(()=>f.client.claimJob(designated,ad,{leaseSeconds:120,idempotencyKey:'incumbent-claim'}),
    error=>error.code==='not_designated');
  assert.equal((await f.owner.getJob(designated)).attempts_started,0);
  const atMember=f.member.client(1);
  assert.deepEqual(await offered(atMember),[designated]);
  const claim=await atMember.claimJob(designated,ad,{leaseSeconds:120,idempotencyKey:'member-claim'});
  assert.equal(claim.attempt.job_digest,designated);
  assert.equal((await f.owner.getJob(designated)).attempts_started,0,'the incumbent copy stays untouched');
});
