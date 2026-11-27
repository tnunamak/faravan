import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createPrivateKey,randomBytes} from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import {appFixture} from './helpers/v1-app-fixture.mjs';
import {createJobOperations} from '../lib/v1/cli.mjs';

// The real-app owner-offline witness (design 1119 continuation): the circle's host never sees the
// job. The owner publishes a roster whose lender entry records the lender app's own serving origin;
// the borrower's app hands its unchanged signed intent to that member's real HTTP endpoint, an
// uncertain reply is recovered by replaying the same durable intent to the same store, and only the
// designated member's store dispatches.

const advertisement={harnesses:['claude-code-subscription'],models:[],capabilities:['filtered_git_v1','designated_member_v1'],
  egress:['provider-only','internet'],enforced_limits:['cpu','memory_bytes','disk_bytes','output_bytes','wall_seconds'],
  max_limits:{wall_seconds:1800,cpu:2,memory_bytes:8589934592,disk_bytes:17179869184,output_bytes:33554432}};

test('an unchanged designated member installs an accepted newer roster and keeps its job', {timeout: 180000}, async t => {
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

  const newer=p.signEnvelope('roster',{...roster.payload,epoch:roster.payload.epoch+1},rootKey);
  const body=Buffer.from(p.canonicalize(newer));
  const originalOrigin=circle.origin+'/v1/circles/'+circle.id+'/roster';
  const nextProof=p.buildRequestProof({circle:circle.id,roster_epoch:newer.payload.epoch,method:'PUT',
    target:originalOrigin,body,content_type:'application/json',artifact_media_type:'',idempotency_key:'',
    created:Math.floor(Date.now()/1000),nonce:randomBytes(24).toString('base64url')},
    owner.app.device.deviceKey.privateKey??owner.app.device.deviceKey);
  const published=await fetch(originalOrigin,{method:'PUT',
    headers:{'content-type':'application/json','faravan-proof':nextProof},body});
  assert.equal(published.status,200,'the incumbent has already accepted the valid newer signed roster');
  await owner.app.device.refreshRoster(circle.id);
  await lender.app.device.refreshRoster(circle.id);
  for(const app of [owner.app,lender.app])
    assert.equal((await app.device.rosterCache(circle.id).get()).current.payload.epoch,newer.payload.epoch);

  const target=memberOrigin+'/v1/circles/'+circle.id+'/jobs/'+digest.slice(7);
  const staleProof=p.buildRequestProof({circle:circle.id,roster_epoch:roster.payload.epoch,method:'GET',
    target,body:Buffer.alloc(0),created:Math.floor(Date.now()/1000),nonce:randomBytes(24).toString('base64url')},
    owner.app.device.deviceKey.privateKey??owner.app.device.deviceKey);
  const oldRead=await fetch(target,{headers:{'faravan-proof':staleProof}});
  await oldRead.text();
  assert.ok(oldRead.status >= 400,'an old-epoch request cannot read the retained job');

  const currentClient=await owner.app.device.memberClient(circle.id,lenderId);
  const kept=await currentClient.getJob(digest);
  assert.equal(kept.job_digest,digest,'a fresh request reads the exact retained job at the same member origin');
  assert.equal(kept.state,'queued');
  assert.equal(kept.attempts_started,0);
});
