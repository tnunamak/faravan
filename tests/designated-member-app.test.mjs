import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createPrivateKey,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as p from '../lib/protocol/index.mjs';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
import {createJobOperations} from '../lib/v1/cli.mjs';

// The real-app owner-offline witness (design 1119 continuation): the circle's host never sees the
// job. The owner publishes a roster whose lender entry records the lender app's own serving origin;
// the borrower's app hands its unchanged signed intent to that member's real HTTP endpoint, an
// uncertain reply is recovered by replaying the same durable intent to the same store, and only the
// designated member's store dispatches.

const advertisement={harnesses:['claude-code-subscription'],models:[],capabilities:['filtered_git_v1','designated_member_v1'],
  egress:['provider-only','internet'],enforced_limits:['cpu','memory_bytes','disk_bytes','output_bytes','wall_seconds'],
  max_limits:{wall_seconds:1800,cpu:2,memory_bytes:8589934592,disk_bytes:17179869184,output_bytes:33554432}};

test('the app hands a designated submission to the member\u2019s real endpoint and recovers an uncertain reply', {timeout: 180000}, async t => {
  const f=await appFixture(t);
  const {owner,lender,circle,realRequests}=await f.realConnect({lenderOptions:{}});
  const ownerId=owner.app.device.keyId,lenderId=lender.app.device.keyId;
  // The member serves its protocol on its own app-owned listener, never on the tray port.
  const memberOrigin='http://127.0.0.1:'+(await lender.app.memberListener.start()).port;

  // The owner publishes a roster whose lender entry carries the lender app's own serving origin.
  // The circle's dedicated root key (kept in the owner's home, as the device's own publication uses)
  // signs the roster; the existing profile and members are preserved, only the epoch changes.
  const current=(await owner.app.device.rosterCache(circle.id).get()).current;
  const members=current.payload.members.map(member=>member.key_id===lenderId
    ?{...member,origin:memberOrigin}:member);
  const rootKey=createPrivateKey(await readFile(join(await f.home('owner'),'v1','roots',circle.id+'.pem'),'utf8'));
  const roster=p.signEnvelope('roster',{...current.payload,epoch:current.payload.epoch+1,members},rootKey);
  const installProof={proof:p.buildRequestProof({circle:circle.id,roster_epoch:roster.payload.epoch,method:'PUT',
    target:circle.origin+'/v1/circles/'+circle.id+'/roster',body:Buffer.from(p.canonicalize(roster)),
    content_type:'application/json',artifact_media_type:'',idempotency_key:'',
    created:Math.floor(Date.now()/1000),nonce:randomBytes(24).toString('base64url')},
    owner.app.device.deviceKey.privateKey??owner.app.device.deviceKey)};
  const install=await fetch(circle.origin+'/v1/circles/'+circle.id+'/roster',{method:'PUT',
    headers:{'content-type':'application/json','faravan-proof':installProof.proof},body:p.canonicalize(roster)});
  if(install.status!==200)console.log('INSTALL-BODY',install.status,await install.text());
  assert.equal(install.status,200,'the owner-signed roster installs through the existing route');
  await owner.app.device.rosterCache(circle.id).set({current:roster,history:[],
    highestAcceptedEpoch:roster.payload.epoch,highestAcceptedDigest:p.digest(roster.payload)});
  await lender.app.device.refreshRoster(circle.id);
  assert.equal(p.findMember((await lender.app.device.rosterCache(circle.id).get()).current.payload,lenderId).origin,
    memberOrigin,'the member accepted the roster that names its own serving origin');

  // The borrower's app submits a job that designates the lender. The first send's replies are all
  // lost at the member's own endpoint - the client's bounded retries exhaust and the durable intent
  // stays pending - while the circle's host never sees any of it.
  let dropReplies=true;
  const submissions=[], acceptedBeforeDrop=[];
  lender.app.memberListener.server.prependListener('request',(req,res)=>{
    if(req.method!=='POST'||!req.url.endsWith('/jobs'))return;
    const proof=JSON.parse(Buffer.from(req.headers['faravan-proof'],'base64url')).payload;
    submissions.push({digest:proof.body_digest,key:req.headers['idempotency-key']});
    if(!dropReplies)return;
    const end=res.end.bind(res);
    res.end=(...args)=>{
      if(res.statusCode<200||res.statusCode>=300)return end(...args);
      acceptedBeforeDrop.push(res.statusCode);
      res.destroy();
      return res;
    };
  });
  const operations=createJobOperations({device:owner.app.device,clock:()=>Math.floor(Date.now()/1000)});
  const input={circle:circle.id,prompt:'Owner-offline designated submission',
    git:'https://github.com/example/app.git@'+'a'.repeat(40),harness:'claude-code',send_anyway:true,
    designated_member:lenderId};
  let uncertain=null;
  await assert.rejects(operations.submit(input),error=>{
    uncertain=error;return error.code==='network_error'||error.outcome==='unknown';
  });
  assert.ok(uncertain,'the first reply was uncertain');
  assert.ok(acceptedBeforeDrop.length>0,'the lender accepted the job before its reply was lost');
  const lostSubmissions=submissions.length;
  dropReplies=false;
  assert.equal(realRequests.some(record=>record.route.endsWith('/jobs')&&record.method==='POST'),
    false,'the circle host never saw the submission');

  // The uncertain reply is recovered by replaying the same durable intent: the same envelope bytes
  // and the same operation key, to the same member's store, which accepts it once.
  const recovered=await operations.submit(input);
  assert.ok(recovered.jobDigest,'the durable intent replays the exact signed submission');
  assert.ok(submissions.length>lostSubmissions,'recovery contacted the designated lender again');
  const [firstSubmission]=submissions;
  assert.ok(firstSubmission.digest&&firstSubmission.key,'the request binds a body digest and operation key');
  for(const submission of submissions)assert.deepEqual(submission,firstSubmission,'every submit replays the signed body digest and operation key');
  assert.equal(realRequests.some(record=>record.route.endsWith('/jobs')&&record.method==='POST'),
    false,'the circle host never saw the original submission or its replay');
  const digest=recovered.jobDigest;

  // The member store holds the job and only the designated member may dispatch it.
  const lenderClient=await lender.app.device.memberClient(circle.id,lenderId);
  const view=await lenderClient.getJob(digest);
  assert.equal(view.state,'queued');
  // While the job is still queued, no other member may dispatch it: the borrower's own key at the
  // designated lender's store is refused at the fence.
  const borrowerAtLender=await owner.app.device.memberClient(circle.id,lenderId);
  await assert.rejects(()=>borrowerAtLender.claimJob(digest,advertisement,{leaseSeconds:120,idempotencyKey:'borrower-claim'}),
    error=>error.code==='not_designated','no other member may dispatch the designated job');
  // The designated member's own store claims: one execution authority.
  const claim=await lenderClient.claimJob(digest,advertisement,{leaseSeconds:120,idempotencyKey:'member-claim'});
  assert.equal(claim.attempt.holder,lenderId,'one execution authority: the designated lender');
  const second=await (await owner.app.device.memberClient(circle.id,lenderId)).getJob(digest);
  assert.equal(second.current_attempt.attempt_id,claim.attempt.attempt_id);

  const persisted=new DatabaseSync(join(await f.home('lender'),'v1','member-stores',circle.id+'.sqlite'),{readOnly:true});
  t.after(()=>persisted.close());
  const storedJob=()=>persisted.prepare('SELECT data FROM jobs WHERE id=?').get(digest)?.data;
  const originalJob=storedJob();
  assert.ok(originalJob,'the accepted job is present in the member store');
  const lenderCache=lender.app.device.rosterCache(circle.id);
  let snapshot=await lenderCache.get();
  for(const [label,origin] of [['retired',undefined],['moved','https://moved-member.example'],['newer epoch',memberOrigin]]) {
    const members=roster.payload.members.map(member=>{
      if(member.key_id!==lenderId)return member;
      const {origin:oldOrigin,...identity}=member;
      return origin?{...identity,origin}:identity;
    });
    const newer=p.signEnvelope('roster',{...roster.payload,epoch:snapshot.current.payload.epoch+1,members},rootKey);
    snapshot={...snapshot,current:newer,highestAcceptedEpoch:newer.payload.epoch,highestAcceptedDigest:p.digest(newer.payload)};
    await lenderCache.set(snapshot);
    if(origin===memberOrigin) {
      // The same origin under a newer signed epoch is served from the current roster: the member store
      // installs it, the client adopts it, and the exact retained job is read at that epoch.
      const kept=await borrowerAtLender.getJob(digest);
      assert.equal(kept.job_digest,digest,label+' serving answers from the current roster');
      assert.equal(JSON.parse(persisted.prepare("SELECT data FROM circle WHERE id='config'").get().data).epoch,
        snapshot.current.payload.epoch,'the member store installed the newer epoch');
    } else await assert.rejects(()=>borrowerAtLender.getJob(digest), error=>error.status===404,
      label+' serving must not route through the previous roster');
    assert.equal(storedJob(),originalJob,'withdrawing the serving endpoint preserves the accepted job');
  }
});
