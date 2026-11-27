import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import {openV1Store} from '../lib/v1/store.mjs';
import {createV1Handler} from '../lib/v1/server.mjs';
import {createClient} from '../lib/v1/client.mjs';
import {resultArchive} from './helpers/v1-journey.mjs';

// The smallest end-to-end fixture of the amended owner-offline topology (product owner, 11-19): the owner is
// offline; a signed roster (no single coordinator, existing root signing authority) carries each
// member's origin; the borrower sends a job that names its designated member through a third online
// member; that member's store preserves the exact signed submission and so does any other member a
// retry reaches after an uncertain acknowledgement, while neither may dispatch it; only the designated
// member's store claims, and after the relaying peer goes offline the lender and the borrower finish
// and read the result through the one authority that holds the job.

const vectors=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
const iso=ms=>new Date(Math.floor(ms/1000)*1000).toISOString().replace('.000Z','Z');

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'designated-member-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const {privateKey:rootKey}=generateKeyPairSync('ed25519');
  const rootFingerprint=p.fingerprint(p.exportPublicKey(rootKey));
  const circle=randomUUID();
  const members=['borrower','relay','other','lender'].map(name=>{
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');
    return {name,privateKey,publicKey,keyId:p.fingerprint(publicKey)};
  });
  return {dir,rootKey,rootFingerprint,circle,members,
    borrower:members[0],relay:members[1],other:members[2],lender:members[3]};
}
async function memberServer(t,dir,name) {
  const server=createServer();
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {server,origin:'http://127.0.0.1:'+server.address().port,path:join(dir,name+'.sqlite')};
}
const rosterFor=(f,{origins={}}={})=>{
  const members=f.members.map(m=>({key_id:m.keyId,public_key:p.exportPublicKey(m.privateKey),joined_epoch:1,
    ...(origins[m.name]?{origin:origins[m.name]}:{})}));
  return p.createRoster({circle:f.circle,epoch:1,members,issued_at:iso(Date.now())},f.rootKey);
};
function clientFor(f,device,origin,roster) {
  let saved={current:roster,history:[],highestAcceptedEpoch:roster.payload.epoch,highestAcceptedDigest:p.digest(roster.payload)};
  return createClient({origin,circle:f.circle,deviceKey:device.privateKey,pinnedRootFingerprint:f.rootFingerprint,
    rosterCache:{get:async()=>saved,set:async value=>{saved=value;}},
    clock:()=>f.clock?.()??Math.floor(Date.now()/1000)});
}
function openStore(f,{server,origin,path},roster) {
  const store=openV1Store({path,origin,circle:f.circle,rootFingerprint:f.rootFingerprint,
    initialRoster:roster,clock:()=>f.clock?.()??Math.floor(Date.now()/1000)});
  return {store,attach(blobDir){
    server.on('request',createV1Handler({store,blobDir,clock:()=>f.clock?.()??Math.floor(Date.now()/1000)}));
    return store;
  }};
}
function jobPayloadFor(f,{designated,rosterEpoch=1}={}){
  const payload=structuredClone(vectors.objects.job.envelope.payload);
  payload.circle=f.circle;payload.author=f.borrower.keyId;payload.roster_epoch=rosterEpoch;
  payload.intent_id=randomUUID();
  payload.created_at=iso(Date.now());payload.expires_at=iso(Date.now()+6*3600000);
  payload.source={kind:'none'};
  payload.result={kind:'message'};
  payload.requirements=structuredClone(payload.requirements);
  payload.requirements.capabilities=['results_v1','designated_member_v1'];
  payload.requirements.egress='provider-only';
  payload.requirements.limits.wall_seconds=120;
  delete payload.requirements.model;
  payload.designated_member=designated;
  return payload;
}
const advertisement={harnesses:['codex'],models:[],capabilities:['results_v1','designated_member_v1'],
  egress:['provider-only'],enforced_limits:['wall_seconds','cpu','memory_bytes','disk_bytes','output_bytes'],
  max_limits:{wall_seconds:600,cpu:2,memory_bytes:10737483648,disk_bytes:10737483648,output_bytes:10485760}};

test('a designated-member job survives an owner-offline relay, uncertain retries and a peer shutdown', {timeout: 120000}, async t => {
  const f=fixture(t);
  const relay=await memberServer(t,f.dir,'relay'), other=await memberServer(t,f.dir,'other'),
    lender=await memberServer(t,f.dir,'lender');
  // The signed roster carries each serving member's origin under the existing root signing
  // authority, and pins no single coordinator: the owner's machine is offline for the whole fixture.
  const roster=rosterFor(f,{origins:{relay:relay.origin,other:other.origin,lender:lender.origin}});
  const relayStore=openStore(f,relay,roster).attach(join(f.dir,'blobs-relay'));
  openStore(f,other,roster).attach(join(f.dir,'blobs-other'));
  const lenderStore=openStore(f,lender,roster).attach(join(f.dir,'blobs-lender'));
  void relayStore;

  const borrowerAt=origin=>clientFor(f,f.borrower,origin,roster);
  const payload=jobPayloadFor(f,{designated:f.lender.keyId});
  // Each member store is its own storage: the borrower carries the same prompt bytes to every store
  // it submits through, and the signed envelope pins the one digest they all hash to.
  const prompt=Buffer.from('Owner-offline designated-member causal fixture');
  for(const origin of [relay.origin,other.origin,lender.origin])
    payload.prompt=await borrowerAt(origin).uploadArtifact(prompt,'text/plain');
  const jobDigest=p.digest(payload);

  // Send through the third online member. The first acknowledgement is uncertain; the borrower's
  // own exact signed intent is the transport, so the retry replays the identical envelope there and
  // also carries it to another member's store. Both preserve it; neither dispatches it.
  const first=await borrowerAt(relay.origin).submitJob(payload,{idempotencyKey:'designated-first'});
  assert.equal(first.jobDigest,jobDigest);
  const replay=await borrowerAt(relay.origin).submitJob(payload,{idempotencyKey:'designated-first'});
  assert.deepEqual(replay,first,'an uncertain acknowledgement replays the exact submission');
  const atOther=await borrowerAt(other.origin).submitJob(payload,{idempotencyKey:'designated-first'});
  assert.equal(atOther.jobDigest,jobDigest);
  // The borrower carries the same intent to the designated member's own store (its origin is in the
  // signed roster); that store is the one that may dispatch.
  const atLender=await borrowerAt(lender.origin).submitJob(payload,{idempotencyKey:'designated-first'});
  assert.equal(atLender.jobDigest,jobDigest);

  // Nobody eligible at the relaying members: the job waits queued with no attempt at either store.
  for(const [name,origin] of [['relay',relay.origin],['other',other.origin]]) {
    const view=await borrowerAt(origin).getJob(jobDigest);
    assert.equal(view.state,'queued',name+' preserves the submission');
    assert.equal(view.current_attempt,null,'no dispatch at a member that is not the designated lender');
  }

  // A retry after the uncertain acknowledgement cannot be accepted for dispatch at a different member.
  await assert.rejects(()=>clientFor(f,f.relay,relay.origin,roster).claimJob(jobDigest,advertisement,{leaseSeconds:120,idempotencyKey:'relay-claim'}),
    error=>error.code==='not_designated');
  await assert.rejects(()=>clientFor(f,f.other,other.origin,roster).claimJob(jobDigest,advertisement,{leaseSeconds:120,idempotencyKey:'other-claim'}),
    error=>error.code==='not_designated');
  assert.equal((await borrowerAt(relay.origin).getJob(jobDigest)).state,'queued');

  // The designated member's own store claims: exactly one dispatch, at the one authority.
  const lenderClient=clientFor(f,f.lender,lender.origin,roster);
  const claim=await lenderClient.claimJob(jobDigest,advertisement,{leaseSeconds:120,idempotencyKey:'lender-claim'});
  assert.equal(claim.attempt.holder,f.lender.keyId);
  const started=await lenderClient.startAttempt(claim.attempt,{idempotencyKey:'lender-start'});
  assert.equal(typeof started.execution_started_at,'string');
  await lenderClient.observeExecutionStart(claim.attempt,{observedAt:iso(Date.now()),idempotencyKey:'observed-start'});
  // Reopen the lender's actual sqlite store after the execution lease expired. A started job
  // cannot launch again, but its original generation may still deliver its completed result.
  lender.server.closeAllConnections();
  for(const handler of lender.server.listeners('request'))handler.close?.();
  lender.server.removeAllListeners('request');lenderStore.close();
  f.clock=()=>Math.floor(Date.now()/1000)+121;
  const reopenedStore=openStore(f,lender,roster).attach(join(f.dir,'blobs-lender'));
  t.after(()=>reopenedStore.close());
  await assert.rejects(()=>lenderClient.startAttempt(claim.attempt),error=>['job_terminal','lease_expired'].includes(error.code));
  await assert.rejects(()=>lenderClient.claimJob(jobDigest,advertisement),error=>['job_terminal','conflict','retry_exhausted'].includes(error.code));
  assert.equal((await lenderClient.getJob(jobDigest)).attempts_started,1);

  // Once the designated lender accepted, the relaying peer goes offline. The lender completes and
  // the borrower reads the result through the designated lender's authority alone.
  relay.server.closeAllConnections();
  await new Promise(resolve=>relay.server.close(resolve));
  const result=resultArchive();
  const reference=(bytes,media_type)=>({digest:p.digestBytes(bytes),bytes:bytes.length,media_type});
  const transcriptBytes=Buffer.from('{"synthetic":true}\n','utf-8');
  for(const [bytes,media_type] of [[result,'application/gzip'],[transcriptBytes,'application/x-ndjson']])
    await lenderClient.uploadArtifact(bytes,media_type);
  const nowIso=iso(f.clock()*1000);
  const resultPayload={schema:'faravan.result.v1',circle:f.circle,job_digest:jobDigest,attempt_id:claim.attempt.attempt_id,
    generation:claim.attempt.generation,executor:f.lender.keyId,roster_epoch:roster.payload.epoch,submitted_at:nowIso,
    output:{kind:'message'},candidate:reference(result,'application/gzip'),
    transcript:reference(transcriptBytes,'application/x-ndjson'),
    receipt:{schema:'faravan.receipt.v1',self_reported:true,harness:'codex',harness_version:'test',model:'test-model',
      backend:'synthetic',candidate_format:'tree',limits_applied:payload.requirements.limits,egress_applied:payload.requirements.egress,
      capabilities_applied:payload.requirements.capabilities,started_at:nowIso,finished_at:nowIso,duration_ms:0,source:payload.source}};
  const ack=await lenderClient.completeAttempt(claim.attempt,resultPayload,{idempotencyKey:'lender-complete'});
  assert.equal(ack.status,'result-accepted');
  const duplicate=await clientFor(f,f.lender,lender.origin,roster).completeAttempt(claim.attempt,resultPayload,{idempotencyKey:'after-restart-complete'});
  assert.deepEqual(duplicate,ack,'a repeated result after lender restart has the original acknowledgement');
  const view=await clientFor(f,f.borrower,lender.origin,roster).getJob(jobDigest);
  assert.equal(view.state,'result-accepted');
  assert.equal(view.current_attempt.attempt_id,claim.attempt.attempt_id);
  assert.equal(view.current_attempt.state,'completed');
  assert.equal(view.result_digest,ack.result_digest);
});

test('the roster refuses a forged member origin and the store refuses a foreign designated member', async t => {
  const f=fixture(t);
  // Two members claiming the same origin never validate: an address cannot become membership authority.
  // The refusal happens at signing, so the roster can never even be published.
  assert.throws(()=>rosterFor(f,{origins:{relay:'http://127.0.0.1:9',other:'http://127.0.0.1:9'}}),
    error=>error.code==='origin_conflict');
  // A designated member outside the roster is refused at publish on the relaying member's store.
  const relay=await memberServer(t,f.dir,'relay-forged');
  const goodRoster=rosterFor(f,{origins:{relay:relay.origin}});
  openStore(f,relay,goodRoster).attach(join(f.dir,'blobs-forged'));
  const client=clientFor(f,f.borrower,relay.origin,goodRoster);
  const payload=jobPayloadFor(f,{designated:'sha256:'+'9'.repeat(64)});
  payload.prompt=await client.uploadArtifact(Buffer.from('Foreign designated member'),'text/plain');
  await assert.rejects(()=>client.submitJob(payload,{idempotencyKey:'forged'}),error=>error.code==='forbidden');
});

test('a stale roster epoch is refused at a member store, exactly as at the incumbent host', async t => {
  const f=fixture(t);
  const relay=await memberServer(t,f.dir,'relay-stale');
  const roster=rosterFor(f,{origins:{relay:relay.origin}});
  openStore(f,relay,roster).attach(join(f.dir,'blobs-stale'));
  const client=clientFor(f,f.borrower,relay.origin,roster);
  const payload=jobPayloadFor(f,{designated:f.lender.keyId,rosterEpoch:0});
  payload.prompt=await client.uploadArtifact(Buffer.from('Stale roster'),'text/plain');
  await assert.rejects(()=>client.submitJob(payload,{idempotencyKey:'stale'}),error=>error.code==='roster_stale');
});

test('an invite may carry the signed member-origin list, and a malformed list does not validate', () => {
  const {privateKey:rootKey}=generateKeyPairSync('ed25519');
  const circle=randomUUID(),{publicKey:inviteKey}=generateKeyPairSync('ed25519');
  const base={circle,coordinator:'http://127.0.0.1:9',invite_id:randomUUID(),
    invite_public_key:p.exportPublicKey(inviteKey),created_at:iso(Date.now()),expires_at:iso(Date.now()+3600000)};
  const verify=invite=>p.verifyInvite(invite,{rootFingerprint:p.fingerprint(p.exportPublicKey(rootKey)),
    circle,coordinator:'http://127.0.0.1:9',now:()=>Math.floor(Date.now()/1000)}).ok;
  const {privateKey:memberKey}=generateKeyPairSync('ed25519');
  const member_origins=[{key_id:p.fingerprint(p.exportPublicKey(memberKey)),origin:'http://127.0.0.1:9'}];
  assert.equal(verify(p.createInvite({...base,member_origins},rootKey)),true);
  // An origin with credentials is a syntactically valid URL that still is not an origin: refused cleanly.
  assert.throws(()=>p.createInvite({...base,member_origins:[{key_id:member_origins[0].key_id,
    origin:'https://user:pass@127.0.0.1:9'}]},rootKey),error=>error.code==='invalid_request');
  assert.throws(()=>p.createInvite({...base,member_origins:[{key_id:'not-a-digest',origin:'http://127.0.0.1:9'}]},rootKey),
    error=>error.code==='invalid_request');
});
