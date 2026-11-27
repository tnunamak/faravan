import fs from 'node:fs';
import {join} from 'node:path';
import {lenderFixture} from './v1-lender-fixture.mjs';
import {createClient} from '../../lib/v1/client.mjs';
import {createLender,createLenderCounterStorage} from '../../lib/v1/lender.mjs';
import * as p from '../../lib/protocol/index.mjs';
import {barrier} from './crash-process.mjs';
import {openDevice} from '../../lib/v1/device.mjs';
import {startApp} from '../../lib/v1/app.mjs';
import {createLendingRuntime} from '../../lib/v1/lending-runtime.mjs';
import {normalizeLendingPolicy} from '../../lib/v1/lending-policy.mjs';
import {createSyntheticPace50Source} from './pace50-synthetic-source.mjs';

const [directory,selected,mode]=process.argv.slice(2);
const config=JSON.parse(fs.readFileSync(join(directory,'crash-config.json'),'utf8'));
const fixture=await lenderFixture({after(){}},{hold:config.liveStop==='cancel',run:{model:'gpt-6-sol'},
  ...(config.liveStop==='failure'?{runError:Object.assign(new Error('synthetic execution failure'),{code:'execution_failed'})}:{})});
const vectors=JSON.parse(fs.readFileSync(new URL('../../docs/protocol/vectors/golden.json',import.meta.url)));
const roster=vectors.objects.roster.envelope;
const clock={now:()=>config.now};
const client=createClient({origin:config.origin,circle:roster.payload.circle,
  deviceKey:p.privateKeyFromSeed(Buffer.from(vectors.keys[1].seed_hex,'hex')),
  pinnedRootFingerprint:vectors.keys[2].fingerprint,
  rosterCache:{get:async()=>({current:roster,history:[],highestAcceptedEpoch:7,highestAcceptedDigest:p.digest(roster.payload)}),set:async()=>{}},
  clock:()=>Math.floor(config.now/1000),retry:{maxAttempts:1}});
delete client.listJobs;
const home=join(directory,'app-home'),stateDir=join(home,'v1');
if(mode==='run') {
  fs.mkdirSync(join(stateDir,'circles',roster.payload.circle),{recursive:true});
  fs.writeFileSync(join(stateDir,'device.pem'),p.privateKeyFromSeed(Buffer.from(vectors.keys[1].seed_hex,'hex')).export({format:'pem',type:'pkcs8'}));
  fs.writeFileSync(join(stateDir,'state.json'),JSON.stringify({version:1,activeCircle:roster.payload.circle,circles:[{
    id:roster.payload.circle,origin:config.origin,pinnedRootFingerprint:vectors.keys[2].fingerprint,name:'Crash fixture',rosterMembershipVerified:true}]}));
  fs.writeFileSync(join(stateDir,'circles',roster.payload.circle,'roster.json'),JSON.stringify({current:roster,history:[],highestAcceptedEpoch:7,highestAcceptedDigest:p.digest(roster.payload)}));
  fs.writeFileSync(join(stateDir,'app-settings.json'),JSON.stringify({version:1,intent:config.intent==='paused'?'on':'off',
    paused:config.intent==='paused',enabled:false,activeCircle:roster.payload.circle,agents:{},modes:{},limits:{}}));
}
// The app restart must recover the same durable candidate used by the original
// run; a fake admission with no ledger cannot stand in for unknown usage.
const quotaSource=createSyntheticPace50Source({start:config.now});
fixture.policy.userActive=async()=>false;
if(mode!=='app-recover')fixture.policy.lendingRuntime=createLendingRuntime({directory:stateDir,
  settings:()=>({intent:'on',limits:{lendingPolicy:normalizeLendingPolicy({providerConsent:{codex:true}})}}),
  backend:fixture.backend,presence:()=>false,lastActiveAt:()=>null,selfKey:()=>null,now:clock.now,
  pace50:{account:vectors.keys[1].fingerprint,account_week_id:'synthetic-week-1',source:quotaSource}});
const storage=createLenderCounterStorage(join(stateDir,'app-counters.json'),{decorate:value=>({...value,circle:roster.payload.circle})});
const collect=fixture.backend.collectDeclaredOutputs;
fixture.backend.collectDeclaredOutputs=async(...args)=>{
  const files=await collect(...args);
  fs.writeFileSync(join(directory,'expected-output'),files[0].bytes_content);
  return files;
};
const start=fixture.backend.start;
fixture.backend.start=async(handle,options)=>{
  const agent=options?.onExecutionStarted && !handle._entrypoint.startsWith('mkdir -p') && !handle._entrypoint.includes('FARAVAN_GIT_');
  if(agent){
    fs.appendFileSync(join(directory,'executions'),'run\n');
    await barrier('running',selected);
    if(config.liveStop==='cancel') {
      const running=start(handle,options);
      running.catch(()=>{});
      await fixture.entered.promise;
      const owner=createClient({origin:config.origin,circle:roster.payload.circle,
        deviceKey:p.privateKeyFromSeed(Buffer.from(vectors.keys[0].seed_hex,'hex')),
        pinnedRootFingerprint:vectors.keys[2].fingerprint,
        rosterCache:{get:async()=>({current:roster,history:[],highestAcceptedEpoch:7,highestAcceptedDigest:p.digest(roster.payload)}),set:async()=>{}},
        clock:()=>Math.floor(config.now/1000),retry:{maxAttempts:1}});
      await owner.cancelJob(config.jobDigest);
      return running;
    }
  }
  return start(handle,options);
};
const destroy=fixture.backend.destroy;
fixture.backend.destroy=async(...args)=>{
  const result=await destroy(...args);
  await barrier('sandbox-removed',selected);
  return result;
};
fixture.backend.reconcilePending=async row=>({attemptId:row.attemptId,removed:true});
const mark=client.startAttempt;
client.startAttempt=async(...args)=>{const result=await mark(...args);await barrier('start-ack',selected);return result;};
const upload=client.uploadResultArtifacts;
client.uploadResultArtifacts=async(...args)=>{await barrier('before-upload',selected);return upload(...args);};
const complete=client.completeAttempt;
client.completeAttempt=async(...args)=>{
  await barrier('completion-saved',selected);
  const result=await complete(...args);
  await barrier('completion-committed',selected);
  return result;
};
const stopped=client.stopped;
client.stopped=async(...args)=>{
  await barrier('stopped-before-send',selected);
  return stopped(...args);
};
const controller=new AbortController();
if(mode==='app-recover') {
  const device=await openDevice({home,origin:null,ensureDefault:false,clock:()=>Math.floor(config.now/1000),clientOptions:{retry:{maxAttempts:1}}});
  const app=await startApp({home,sessionHomeDir:home,device,origin:null,freshLending:'off',lendingPace50:{source:quotaSource,account_week_id:'synthetic-week-1'},port:0,openBrowser:false,clock,backendFactory:()=>fixture.backend,adapters:[],autoApprove:false,joinWaitMs:0,quotaReader:async()=>({remaining:100,observedAt:config.now}),idleReader:async()=>false,signInProbe:async()=>({signedIn:null}),identityProbe:async()=>({providers:[]}),pollMs:20,blockerRecheckMs:50});
  // Read only: startup and the app's resident worker must drive every recovery action.
  const poll=setInterval(async()=>{
    const saved=await storage.get();
    if(saved&&!saved.pending&&!saved.resultPending&&!saved.declinePending&&!saved.stoppedPending&&!saved.outputPending) {
      clearInterval(poll);
      fs.writeFileSync(join(directory,'recovered.json'),JSON.stringify(saved));
      await barrier('recovered',selected);
    }
  },30);
} else {
const lender=createLender({client,backend:fixture.backend,adapters:mode==='recover'?[]:fixture.adapters,
  policy:{...fixture.policy,...(config.liveStop?{renewMs:100}:{}),enabled:mode!=='recover',storage},clock,approve:async()=>true,credentialValues:async()=>[],
  onDiagnostic:event=>process.stderr.write(JSON.stringify(event)+'\n'),
  onEvent:async event=>{
    if(mode==='recover'&&['finished','paused'].includes(event.status)){
      const saved=await storage.get();
      if(!saved.pending&&!saved.resultPending&&!saved.declinePending&&!saved.stoppedPending&&!saved.outputPending){
        fs.writeFileSync(join(directory,'recovered.json'),JSON.stringify(saved));
        await barrier('recovered',selected);
      }
    }
  }});
try {await lender.start(controller.signal);}
catch(error) {
  if(!config.liveStop)throw error;
  fs.writeFileSync(join(directory,'live-cleanup.json'),JSON.stringify(await storage.get()));
  await barrier('live-cleanup',selected);
  throw error;
}
}
