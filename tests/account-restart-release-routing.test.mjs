import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAccountExecution} from '../lib/v1/account-execution.mjs';
import {createAccountBroker} from '../lib/v1/account-broker.mjs';

// Restart recovery of a pre-start account launch (design 1119, owner-offline topology): the release
// goes to the authority that issued the attempt - the job's signed designated member, resolved on the
// accepted roster - never the incumbent, with the same attempt, generation and operation key on every
// retry. Cleanup precedes release, and only a positive receipt frees the reservation.

const circle='11111111-1111-4111-8111-111111111111', member='sha256:'+'a'.repeat(64);
const adapter={descriptor:{refreshKind:'none',usageKind:'remote',nativeUnits:[{id:'tokens',scale:1}],models:[]}};
const providers={getProvider:()=>({ok:true,value:adapter}),listProviders:()=>[adapter]};
const store={read:()=>({records:{}}),get:()=>null,transaction:async fn=>fn({records:{}}),exclusive:async(id,fn)=>fn(),exclusiveUsage:async(id,fn)=>fn()};
const row=(n,extra={},attempt={})=>({attempt:{attemptId:'attempt-'+n,jobId:'sha256:'+String(n).repeat(64),generation:2,circle,
    leaseProof:{schemaVersion:1,signedEnvelope:'{}'},...attempt},
  selection:{accountId:'a1',providerId:'claude',modelId:'m',effortId:null},receipt:{},enforcement:{},payload:{},
  state:'prepared',operationId:'op-'+n,reservationId:'res-'+n,releaseOperation:'rel-'+n,releaseReason:'preparation_failed',
  preparing:false,backendPending:false,...extra});
function seed(directory,rows) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  writeFileSync(join(directory,'lending.json'),JSON.stringify({schemaVersion:1,offers:{},
    accounts:{a1:{schemaVersion:1,revision:rows.length,accountId:'a1',operations:{},
      resources:[{id:'tokens',instance:null,unit:'tokens',consumed:0,reserved:10*rows.length,unrepresented:0}],
      attempts:rows.map(r=>({attemptId:r.attempt.attemptId,jobId:r.attempt.jobId,state:'prepared',reservationId:r.reservationId,
        resources:[{id:'tokens',instance:null,unit:'tokens',remaining:10}],events:{}}))}},
    launches:Object.fromEntries(rows.map(r=>[r.attempt.attemptId,r]))}));
}
const ledgerState=(directory,id)=>JSON.parse(readFileSync(join(directory,'lending.json'),'utf8')).accounts.a1.attempts
  .find(a=>a.attemptId===id).state;
function harness(t,rows) {
  const directory=mkdtempSync(join(tmpdir(),'faravan-restart-route-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  seed(directory,rows);
  const broker=createAccountBroker({store,clock:Date.now,providers,proxy:{dispatch:async()=>({ok:false,error:{code:'not_used'}})},authority:{verify:async()=>({ok:false})}});
  broker.getAccountUsage=()=>({snapshot:()=>null,requestRead:async()=>null,subscribe:()=>()=>{},close:async()=>{}});
  const execution=createAccountExecution({directory,store,broker,providers,settings:async()=>({schemaVersion:1,enabled:true,revision:1}),clock:Date.now});
  t.after(()=>execution.close());
  const calls=[];
  const clientFor=(answers={})=>async (id,{designatedMember}={})=>{
    const who=designatedMember===undefined?'incumbent':designatedMember;
    if(answers.unresolved&&designatedMember!==undefined)throw Object.assign(new Error('member_origin_required'),{code:'member_origin_required'});
    return {release:async (attempt,reason,{idempotencyKey})=>{
      calls.push({who,circle:id,attempt,reason,idempotencyKey});return {state:answers[who]??'released'};}};
  };
  const backend={remove:async()=>({ok:true})};
  return {directory,execution,calls,clientFor,backend,
    reconcile:answers=>execution.reconcile({backend,recover:true,clientFor:clientFor(answers)})};
}

test('a restart releases a designated attempt at its member and an ordinary one at the incumbent',async t=>{
  const h=harness(t,[row(1,{},{designatedMember:member}),row(2)]);
  await h.reconcile();
  const byAttempt=Object.fromEntries(h.calls.map(c=>[c.attempt.attempt_id,c]));
  assert.equal(h.calls.length,2);
  assert.deepEqual(byAttempt['attempt-1'],{who:member,circle,attempt:{attempt_id:'attempt-1',job_digest:'sha256:'+'1'.repeat(64),generation:2},
    reason:'preparation_failed',idempotencyKey:'rel-1/release'},'the designated attempt goes to its member with its exact identity and operation key');
  assert.equal(byAttempt['attempt-2'].who,'incumbent','an attempt that names no member keeps the incumbent');
  assert.equal(ledgerState(h.directory,'attempt-1'),'ceased');
  assert.equal(ledgerState(h.directory,'attempt-2'),'ceased');
});

test('an uncertain release keeps the reservation and retries the same key at the same member',async t=>{
  const h=harness(t,[row(1,{},{designatedMember:member}),row(2,{},{designatedMember:member})]);
  await h.reconcile({[member]:'pending'});
  assert.equal(ledgerState(h.directory,'attempt-1'),'prepared','no positive receipt, no refund');
  assert.equal(ledgerState(h.directory,'attempt-2'),'prepared');
  const first=h.calls.map(c=>c.idempotencyKey).sort();
  h.calls.length=0;
  await h.reconcile();
  assert.deepEqual(h.calls.map(c=>c.idempotencyKey).sort(),first,'the retry replays the same operation keys');
  assert.ok(h.calls.every(c=>c.who===member&&c.attempt.generation===2));
  assert.equal(ledgerState(h.directory,'attempt-1'),'ceased');
});

test('a designated attempt whose member has no recorded origin stays unresolved and never reaches the incumbent',async t=>{
  const h=harness(t,[row(1,{},{designatedMember:member}),row(2)]);
  await h.reconcile({unresolved:true});
  assert.deepEqual(h.calls.map(c=>c.attempt.attempt_id),['attempt-2'],'only the ordinary attempt was released');
  assert.equal(h.calls[0].who,'incumbent');
  assert.equal(ledgerState(h.directory,'attempt-1'),'prepared','the unresolved obligation keeps its reservation');
  assert.equal(ledgerState(h.directory,'attempt-2'),'ceased');
});

test('failed cleanup blocks the release call and keeps the reservation',async t=>{
  const h=harness(t,[row(1,{sandboxId:'sbx-unknown'},{designatedMember:member})]);
  await h.reconcile();
  assert.equal(h.calls.length,0,'no release is sent before exact cleanup succeeds');
  assert.equal(ledgerState(h.directory,'attempt-1'),'prepared');
});
