import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/triage-small-app-fixture.mjs';
import {summarizeContributions} from '../lib/v1/app.mjs';
import * as p from '../lib/protocol/index.mjs';
test('person names reach members, requests, Devices and history through signed member profiles',async t=>{
 const f=await appFixture(t),{owner,lender,circle}=await f.realConnect();
 await owner.app.device.setOwnerName('Alex Example');await lender.app.device.setOwnerName('Maya Okafor');
 await owner.app.device.refreshRoster(circle.id);
 await api(lender.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
 for(const app of [owner.app,lender.app]){
  const members=(await api(app,'/api/devices')).circles.find(c=>c.circle===circle.id).members;
  assert.equal(members.find(m=>m.key_id===owner.app.device.keyId).personName,'Alex Example');
  assert.equal(members.find(m=>m.key_id===lender.app.device.keyId).personName,'Maya Okafor');
 }
 const people=await api(owner.app,'/api/circles/'+circle.id+'/people');
 assert.equal(people.find(p=>p.personId===lender.app.device.keyId).name,'Maya Okafor');
 await api(owner.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 await api(owner.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
 await api(owner.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 const submitted=await api(lender.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic named request',harness:'codex'}});
 const card=await waitFor(async()=>(await api(owner.app,'/api/approvals'))[0],'named request',15000);
 assert.equal(card.identity.personName,'Maya Okafor');
 await api(owner.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
 const view=await waitFor(async()=>{const v=await api(lender.app,'/api/jobs/'+submitted.jobDigest+'?circle='+circle.id);return v.state==='result-accepted'&&v;},'named completion',15000);
 assert.equal(view.historyIdentity.personName,'Maya Okafor');
 const contribution=await api(owner.app,'/api/contributions');
 assert.equal(contribution.windows[7].rows.find(r=>r.keyId===lender.app.device.keyId).personName,'Maya Okafor');
 const proof=p.createEnrollmentProof({circle:circle.id,invite_id:'11111111-1111-4111-8111-111111111111',device_public_key:owner.app.device.publicKey,person_name:'Alex Example'},p.generateDeviceKeyPair().privateKey);
 assert.equal(proof.payload.person_name,'Alex Example');
 for(const person_name of ['bad\nname','bad\u202ename','x'.repeat(65),''])assert.throws(()=>p.createEnrollmentProof({circle:circle.id,invite_id:'11111111-1111-4111-8111-111111111111',device_public_key:owner.app.device.publicKey,person_name},p.generateDeviceKeyPair().privateKey),{code:'invalid_device_name'});
 const key=p.generateDeviceKeyPair().privateKey;
 const signed=p.createEnrollmentProof({circle:circle.id,invite_id:'11111111-1111-4111-8111-111111111111',device_public_key:owner.app.device.publicKey,person_name:'Alex Example'},key);
 const input={circle:circle.id,invite_id:signed.payload.invite_id,device_public_key:owner.app.device.publicKey,invitePublicKey:p.exportPublicKey(key)};
 assert.equal(p.verifyEnrollmentProof(signed,input).ok,true);signed.payload.person_name='Someone else';assert.equal(p.verifyEnrollmentProof(signed,input).ok,false);
});
test('contribution aggregate excludes own runs at source',()=>{
 const at=Date.now(),keyId='sha256:'+'a'.repeat(64),jobDigest='sha256:'+'b'.repeat(64);
 const log={events:[{circle:'friends',keyId,jobDigest,attemptId:'attempt',kind:'run',at},{circle:'friends',keyId,jobDigest,attemptId:'attempt',kind:'delivered',at}]};
 const result=summarizeContributions(log,at,keyId);assert.equal(result.windows[7].jobs,0);assert.equal(result.windows[7].devices,0);assert.deepEqual(result.windows[7].rows,[]);
});
test('acceptance refuses a card when its daily limit changed after review',async t=>{
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();
 await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic request',harness:'codex'}});
 await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'request');
 const limits=await api(lender.app,'/api/lending');
 // The full remaining time cannot be reserved after this edit, even though today's minutes are below the cap.
 await api(lender.app,'/api/lending/limits',{method:'POST',body:{...limits.limits,dailyMinutes:5,version:limits.configVersion}});
 const refused=await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{},status:409});
 assert.equal(refused.code,'daily_limit');assert.equal(lender.backend.calls.some(([kind])=>kind==='run'),false);
});
test('creating a second circle preserves the saved lending target',async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 await api(owner.app,'/api/lending/circle',{method:'POST',body:{circle:circle.id}});
 await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Book club'}});
 assert.equal((await api(owner.app,'/api/lending')).circle,circle.id);
});
test('creating a circle preserves the selected recipient for a new composer',async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 const before=(await api(owner.app,'/api/circles')).find(c=>c.selected)?.id;
 assert.equal(before,circle.id);
 await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Another circle'}});
 assert.equal((await api(owner.app,'/api/circles')).find(c=>c.selected)?.id,before);
});
test('an own job is marked as local and is absent from contribution totals',async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 await api(owner.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 await api(owner.app,'/api/lending/limits',{method:'POST',body:{lendingPolicy:{providerConsent:{codex:true}}}});
 await api(owner.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'My own synthetic task',harness:'codex'}});
 const view=await waitFor(async()=>{const view=await api(owner.app,'/api/jobs/'+submitted.jobDigest+'?circle='+circle.id);return view.state==='result-accepted'&&view;},'own completion',15000);
 assert.equal(view.ranHere,true);
 const contributions=await api(owner.app,'/api/contributions');assert.equal(contributions.windows[7].jobs,0);assert.deepEqual(contributions.windows[7].rows,[]);
});
