import fs from 'node:fs';
import {join} from 'node:path';
import {openDevice} from '../../lib/v1/device.mjs';
import {startApp} from '../../lib/v1/app.mjs';
import * as p from '../../lib/protocol/index.mjs';
import {barrier} from './crash-process.mjs';

const [root,phase,boundary]=process.argv.slice(2);
const config=JSON.parse(fs.readFileSync(join(root,'outbox-config.json'),'utf8'));
const vectors=JSON.parse(fs.readFileSync(new URL('../../docs/protocol/vectors/golden.json',import.meta.url)));
const roster=vectors.objects.roster.envelope,home=join(root,'outbox-home'),directory=join(home,'v1');
if(phase==='create') {
  fs.mkdirSync(join(directory,'circles',roster.payload.circle),{recursive:true});
  fs.writeFileSync(join(directory,'device.pem'),p.privateKeyFromSeed(Buffer.from(vectors.keys[0].seed_hex,'hex')).export({format:'pem',type:'pkcs8'}));
  fs.writeFileSync(join(directory,'state.json'),JSON.stringify({version:1,activeCircle:roster.payload.circle,circles:[{
    id:roster.payload.circle,origin:config.origin,pinnedRootFingerprint:vectors.keys[2].fingerprint,name:'Crash fixture',rosterMembershipVerified:true}]}));
  fs.writeFileSync(join(directory,'circles',roster.payload.circle,'roster.json'),JSON.stringify({current:roster,history:[],highestAcceptedEpoch:7,highestAcceptedDigest:p.digest(roster.payload)}));
}
const device=await openDevice({home,origin:null,ensureDefault:false,clock:()=>Math.floor(config.now/1000),clientOptions:{retry:{maxAttempts:1}}});
const store=device.intentStore(roster.payload.circle);
if(phase==='recover-first-pass') {
  const intentStore=device.intentStore;
  device.intentStore=id=>{
    const value=intentStore(id),set=value.set;
    value.set=async(slot,intent)=>{
      await set(slot,intent);
      if(intent.kind==='cancel'&&intent.recoveryFailures===1)
        await barrier('early-cancel-saved','early-cancel-saved');
    };
    return value;
  };
}
if(phase==='create') {
  const payload=config.payload,digest=p.digest(payload);
  await store.set('submit:original',{kind:'submit',state:'pending',payload,operationKey:'original-submit-key',jobDigest:digest,
    artifacts:{source:null,prompt:Buffer.from(config.prompt).toString('base64')}});
  await store.set('cancel:original',{kind:'cancel',state:'pending',operationKey:'original-cancel-key',payload:{
    schema:'faravan.cancellation.v1',circle:payload.circle,author:payload.author,job_digest:digest,roster_epoch:payload.roster_epoch,
    created_at:new Date(config.now).toISOString().replace('.000Z','Z'),reason:'cancelled'}});
  await barrier('intent-saved',boundary);
  for(const factory of ['client','jobReadClient','authorityClient']) {
    const client=device[factory];
    device[factory]=async(...args)=>{
      const value=await client(...args);
      for(const [method,point] of [['uploadArtifact','prompt-uploaded'],['submitJob','published'],['cancelJob','cancelled']]) {
        const original=value[method];value[method]=async(...args)=>{const result=await original(...args);await barrier(point,boundary);return result;};
      }
      return value;
    };
  }
}
await startApp({home,sessionHomeDir:home,device,origin:null,freshLending:'off',port:0,openBrowser:false,clock:{now:()=>config.now},backendFactory:()=>({lenderCapabilities:()=>({available:false,enforced_limits:[]})}),adapters:[],autoApprove:false,joinWaitMs:0,quotaReader:async()=>({remaining:100,observedAt:config.now}),idleReader:async()=>false,signInProbe:async()=>({signedIn:null}),identityProbe:async()=>({providers:[]}),pollMs:20,blockerRecheckMs:50});
if(phase==='recover'||phase==='recover-settled') {
  const poll=setInterval(async()=>{
    const intents=await store.list();
    if(intents.filter(row=>['submit','cancel'].includes(row.kind)).every(row=>row.state==='complete'||(phase==='recover-settled'&&row.state==='refused'))) {
      clearInterval(poll);await barrier('outbox-drained','outbox-drained');
    }
  },30);
}
