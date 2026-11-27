import fs from 'node:fs';
import {join} from 'node:path';
import {openDevice} from '../../lib/v1/device.mjs';
import {startApp} from '../../lib/v1/app.mjs';
import {barrier} from './crash-process.mjs';
import * as p from '../../lib/protocol/index.mjs';
const [root,phase,scenario='lender']=process.argv.slice(2);
const home=join(root,'home'),device=await openDevice({home,ensureDefault:false,origin:null});
const file=join(home,'v1','app-counters.json');
if(phase==='create') {
  const circle=await device.createCircle('http://127.0.0.1:18787',{publish:false});
  fs.mkdirSync(join(home,'v1'),{recursive:true});
  fs.writeFileSync(join(root,'circle.json'),JSON.stringify(circle));
  if(scenario==='outbox') {
    const bytes=Buffer.from('original prompt'),payload={schema:'faravan.job.v1',circle:circle.id,author:device.keyId,roster_epoch:1,
      intent_id:'11111111-1111-4111-8111-111111111111',prompt:{digest:p.digestBytes(bytes),bytes:bytes.length,media_type:'text/plain'}};
    await device.intentStore(circle.id).set('submit:original',{kind:'submit',state:'pending',payload,operationKey:'original-key',jobDigest:p.digest(payload),artifacts:{source:null,prompt:bytes.toString('base64')}});
    await device.intentStore(circle.id).set('cancel:original',{kind:'cancel',state:'pending',payload:{circle:circle.id,author:device.keyId,job_digest:'sha256:'+'a'.repeat(64)},operationKey:'cancel-key'});
    await barrier('journal-saved','journal-saved');
  }
  fs.writeFileSync(file,JSON.stringify({circle:circle.id,jobs:1,milliseconds:1000,pending:{attemptId:'crashed',executionStartRequested:false,...(scenario==='legacy'?{}:{prepare_contract:'create-only'}),reservedMs:1000,jobId:'wf-pull-0123456789abcdef-01234567'},
    accounts:{'codex:0':{jobs:1,milliseconds:1000,pending:{attemptId:'crashed',executionStartRequested:false,...(scenario==='legacy'?{}:{prepare_contract:'create-only'}),reservedMs:1000,jobId:'wf-pull-0123456789abcdef-01234567'}}}}));
  await barrier('journal-saved','journal-saved');
} else {
  let claims=0,submits=0,cancels=0;
  device.client=async()=>({claimNext:async()=>{claims++;return null;},
    uploadArtifact:async()=>{},submitJob:async()=>{submits++;return {};},cancelJob:async()=>{cancels++;return {};}});
  device.authorityClient=device.client;
  device.jobReadClient=device.client;
  const backend={lenderCapabilities:()=>({available:false,enforced_limits:[]}),admitJob:()=>({ok:false}),
    reconcilePending:async row=>({attemptId:row.attemptId,removed:true})};
  const app=await startApp({home,sessionHomeDir:home,device,origin:null,freshLending:'off',port:0,openBrowser:false,backendFactory:()=>backend,adapters:[],autoApprove:false,joinWaitMs:0,quotaReader:async()=>({remaining:100,observedAt:Date.now()}),idleReader:async()=>false,signInProbe:async()=>({signedIn:null}),identityProbe:async()=>({providers:[]}),readiness:async()=>({}),pollMs:20,blockerRecheckMs:50});
  await new Promise(resolve=>setTimeout(resolve,700));
  const counters=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  const settings=JSON.parse(fs.readFileSync(join(home,'v1','app-settings.json'),'utf8'));
  fs.writeFileSync(join(root,'observed.json'),JSON.stringify({pending:counters.pending,jobs:counters.jobs,milliseconds:counters.milliseconds,intent:settings.intent,claims,submits,cancels}));
  await barrier('app-recovered','app-recovered');
}
