import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {crashProcess} from './helpers/crash-process.mjs';

const worker=fileURLToPath(new URL('./helpers/recovery-outbox-child.mjs',import.meta.url));
for(const boundary of ['intent-saved','prompt-uploaded','published','cancelled'])test('G06 normal app replays exact HTTP intents after '+boundary,async t=>{
  const f=await realLenderFixture(t,{publish:false});
  const prompt='Durable original prompt '+randomUUID(),bytes=Buffer.from(prompt);
  const payload={...f.job.payload,intent_id:randomUUID(),prompt:{digest:p.digestBytes(bytes),bytes:bytes.length,media_type:'text/plain'}};
  writeFileSync(join(f.root,'outbox-config.json'),JSON.stringify({origin:f.origin,now:f.clock.now(),payload,prompt}));
  await crashProcess(t,worker,[f.root,'create',boundary],boundary);
  await crashProcess(t,worker,[f.root,'recover',boundary],'outbox-drained');
  assert.equal((await f.owner.getJob(p.digest(payload))).state,'cancelled');
  const submits=f.realRequests.filter(row=>row.url.endsWith('/jobs')&&row.key),cancels=f.realRequests.filter(row=>row.url.endsWith('/cancel'));
  assert.deepEqual([...new Set(submits.map(row=>row.key))],['original-submit-key']);
  assert.deepEqual([...new Set(cancels.map(row=>row.key))],['original-cancel-key']);
  assert.equal(new Set(submits.map(row=>row.bodyDigest)).size,1);
  assert.equal(new Set(cancels.map(row=>row.bodyDigest)).size,1);
});

test('G06 a cancellation survives 404 while its submission is unpublished',async t=>{
  const f=await realLenderFixture(t,{publish:false});
  const prompt='Cancel before publication '+randomUUID(),bytes=Buffer.from(prompt);
  const payload={...f.job.payload,intent_id:randomUUID(),prompt:{digest:p.digestBytes(bytes),bytes:bytes.length,media_type:'text/plain'}};
  const digest=p.digest(payload);
  writeFileSync(join(f.root,'outbox-config.json'),JSON.stringify({origin:f.origin,now:f.clock.now(),payload,prompt}));
  await crashProcess(t,worker,[f.root,'create','intent-saved'],'intent-saved');
  const file=join(f.root,'outbox-home','v1','circles',payload.circle,'intents.json');
  const original=JSON.parse(readFileSync(file,'utf8'));
  const publish=f.store.publishJob;let rejected=false;
  f.store.publishJob=(...args)=>{
    if(!rejected){rejected=true;throw new Error('injected pre-commit failure');}
    return publish(...args);
  };
  // Both passes run only from normal app startup; no manual outbox API call.
  await crashProcess(t,worker,[f.root,'recover-first-pass'],'early-cancel-saved');
  const interrupted=JSON.parse(readFileSync(file,'utf8'));
  assert.equal(rejected,true);
  assert.equal(interrupted['submit:original'].state,'pending');
  assert.equal(interrupted['cancel:original'].lastError,'not_found');
  await crashProcess(t,worker,[f.root,'recover-settled'],'outbox-drained');
  const view=await f.owner.getJob(digest);
  assert.equal(view.state,'cancelled');
  assert.equal(view.attempts_started,0);
  const recovered=JSON.parse(readFileSync(file,'utf8'));
  for(const slot of ['submit:original','cancel:original']) {
    assert.equal(recovered[slot].operationKey,original[slot].operationKey);
    assert.deepEqual(recovered[slot].payload,original[slot].payload);
  }
  for(const route of ['/jobs','/cancel']) {
    const requests=f.realRequests.filter(row=>row.url.endsWith(route)&&row.key);
    assert.ok(requests.length>=2);
    assert.equal(new Set(requests.map(row=>row.key)).size,1);
    assert.equal(new Set(requests.map(row=>row.bodyDigest)).size,1);
  }
});

for(const state of ['pending','refused'])test('saved cancellation renews only after the host refuses its old roster epoch: '+state,async t=>{
 const f=await realLenderFixture(t),vectors=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
 const {mkdir,writeFile}=await import('node:fs/promises');
 const {openDevice}=await import('../lib/v1/device.mjs');
 const {createJobOperations}=await import('../lib/v1/cli.mjs');
 const home=join(f.root,'cancel-home'),circle=f.job.payload.circle,roster=vectors.objects.roster.envelope;
 await mkdir(join(home,'v1/circles',circle),{recursive:true});
 await writeFile(join(home,'v1/device.pem'),p.privateKeyFromSeed(Buffer.from(vectors.keys[0].seed_hex,'hex')).export({format:'pem',type:'pkcs8'}));
 await writeFile(join(home,'v1/state.json'),JSON.stringify({version:1,activeCircle:circle,circles:[{id:circle,origin:f.origin,pinnedRootFingerprint:vectors.keys[2].fingerprint,name:'Test',rosterMembershipVerified:true}]}));
 await writeFile(join(home,'v1/circles',circle,'roster.json'),JSON.stringify({current:roster,history:[],highestAcceptedEpoch:roster.payload.epoch,highestAcceptedDigest:p.digest(roster.payload)}));
 const device=await openDevice({home,origin:null,ensureDefault:false,clock:()=>Math.floor(f.clock.now()/1000)}),store=device.intentStore(circle);
 const payload={schema:'faravan.cancellation.v1',circle,author:device.keyId,job_digest:f.jobDigest,roster_epoch:roster.payload.epoch,created_at:new Date(f.clock.now()).toISOString().replace('.000Z','Z'),reason:'cancelled'};
 await store.set('cancel:'+f.jobDigest,{kind:'cancel',state,lastError:state==='refused'?'roster_stale':undefined,payload,operationKey:'old-cancel-key'});
 const next=p.signEnvelope('roster',{...roster.payload,epoch:roster.payload.epoch+1},p.privateKeyFromSeed(Buffer.from(vectors.keys[2].seed_hex,'hex')));
 await f.owner.publishRoster(next);
 const ops=createJobOperations({home,device,clock:()=>Math.floor(f.clock.now()/1000)});
 await ops.recoverPending();
 assert.equal((await f.owner.getJob(f.jobDigest)).state,'cancelled');
 const saved=await store.get('cancel:'+f.jobDigest);
 assert.equal(saved.state,'complete');assert.equal(saved.payload.roster_epoch,next.payload.epoch);assert.notEqual(saved.operationKey,'old-cancel-key');
});
