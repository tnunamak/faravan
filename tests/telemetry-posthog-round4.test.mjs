import './helpers/no-browser.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {gunzipSync} from 'node:zlib';
import {telemetryApp} from './helpers/telemetry-app.mjs';
import {api} from './helpers/v1-app-fixture.mjs';
import {createTelemetry} from '../lib/v1/telemetry/index.mjs';
import {makeTelemetry} from './helpers/telemetry-harness.mjs';
function failPrivacyWrites(){
 const open=fs.openSync,mkdir=fs.mkdirSync;let records=0,latches=0;
 fs.openSync=(file,...args)=>{if(String(file).includes('.request-privacy.json.')){records++;throw Object.assign(new Error('injected privacy write failure'),{code:'ENOSPC'});}return open(file,...args);};
 fs.mkdirSync=(file,...args)=>{if(String(file).endsWith('request-privacy-uncertain')){latches++;throw Object.assign(new Error('injected refusal write failure'),{code:'ENOSPC'});}return mkdir(file,...args);};
 syncBuiltinESMExports();return {counts:()=>({records,latches}),restore(){fs.openSync=open;fs.mkdirSync=mkdir;syncBuiltinESMExports();}};
}
for(const headers of [{'faravan-telemetry':'off'},{'sec-gpc':'1'}])test(`a job is refused when both opt-out writes fail (${Object.keys(headers)[0]})`,async t=>{
 const h=await telemetryApp(t);await h.f.provisionFromHome('owner');const circle=await api(h.app,'/api/circles',{method:'POST',body:{origin:h.f.origin,name:'Synthetic'}});
 const body={circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic task',harness:'codex'};
 const fault=failPrivacyWrites();let accepted;
 try{
  const response=await fetch(h.app.origin+'/api/jobs',{method:'POST',headers:{'x-faravan-session-token':h.app.token,'content-type':'application/json',...headers},body:JSON.stringify(body)}),value=await response.json();
  assert.ok(fault.counts().records>0&&fault.counts().latches>0,'both durable writes were attempted');
  assert.equal(response.status,503,'an unwritten opt-out must not acknowledge job acceptance');assert.equal(value.code,'telemetry_privacy_unavailable');assert.equal(h.f.jobs.size,0,'no opted-out job was admitted');
  accepted=await api(h.app,'/api/jobs',{method:'POST',body});
 }finally{fault.restore();}
 assert.ok(h.f.jobs.has(accepted.jobDigest),'ordinary requests work even while privacy writes fail');
 await h.tel.close();const dir=join(await h.f.home('owner'),'v1','telemetry'),events=[];let now=Date.now();
 fs.rmSync(join(dir,'rollup.json'),{force:true}); // a crash leaves no shutdown snapshot of the process-local refusal
 const tel=createTelemetry({dir,base:dir,version:'1.2.3',env:{},now:()=>now,random:()=>0,tripwire:async()=>null,transport:async(url,init)=>url.includes('/flags/')?{status:200,json:async()=>({flags:{'faravan-telemetry-enabled':{enabled:true}}})}:(events.push(...JSON.parse(gunzipSync(init.body)).batch),{status:200,headers:new Headers(),body:{cancel:async()=>{}}})});t.after(()=>tel.close());
 await tel.flushNow();for(const digest of h.f.jobs.keys())tel.observe('event:job',{job_digest:digest,state:'result-accepted',attempts_started:1,job:{payload:{requirements:{harness:['codex']}}}});now+=600001;await tel.flushNow();
 assert.deepEqual(events.filter(e=>e.event==='job.run').map(e=>e.properties.outcome),['finished'],'after restart only the admitted positive-control job uploads');
});
test('a stop callback during public Off contention does not block the heartbeat',async t=>{
 let stop=false,allowed=true;
 const h=makeTelemetry({remoteFactory:({onStop})=>({allowed:()=>allowed,poll:async()=>{if(stop){allowed=false;if(onStop()!==false)stop=false;}},reset(){allowed=false;},cancel(){}})});t.after(()=>h.cleanup());allowed=true;
 const script=`import {acquireProcessLockSync} from ${JSON.stringify(new URL('../lib/v1/lock.mjs',import.meta.url).href)};const release=acquireProcessLockSync(${JSON.stringify(join(h.dir,'consent.lock'))},{durable:false});process.stdout.write('locked');setTimeout(()=>release(),750);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});const exited=once(child,'exit');t.after(()=>{if(child.exitCode===null)child.kill();});await once(child.stdout,'data');
 const start=performance.now(),beats=[];const timer=setInterval(()=>beats.push(performance.now()-start),10);const off=h.tel.restrict();
 try{stop=true;h.tel.tick();await new Promise(resolve=>setTimeout(resolve,100));assert.ok(beats.length>=3&&beats[0]<200,`heartbeat delayed ${beats[0]} ms`);assert.equal(h.tel.observeFact('app_started',{}),false,'capture stays off while cleanup cannot acquire authority');}finally{clearInterval(timer);await exited;await off;}
 h.tel.tick();assert.equal(h.tel.status().effective,'off');await h.tel.close();
});
for(const failBinding of [false,true])test(`an admitted opt-out survives restart with ${failBinding?'failed':'completed'} digest binding`,async t=>{
 const h=await telemetryApp(t);await h.f.provisionFromHome('owner');const circle=await api(h.app,'/api/circles',{method:'POST',body:{origin:h.f.origin,name:'Synthetic'}});
 let writes=0;const original=fs.openSync,mkdir=fs.mkdirSync;
 if(failBinding){fs.openSync=(file,...args)=>{if(String(file).includes('.request-privacy.json.')&&++writes>1)throw Object.assign(new Error('binding write failed'),{code:'ENOSPC'});return original(file,...args);};fs.mkdirSync=(file,...args)=>{if(String(file).endsWith('request-privacy-uncertain'))throw Object.assign(new Error('binding latch failed'),{code:'ENOSPC'});return mkdir(file,...args);};syncBuiltinESMExports();}
 let accepted;
 try{accepted=await api(h.app,'/api/jobs',{method:'POST',headers:{'sec-gpc':'1'},body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic task',harness:'codex'}});}finally{fs.openSync=original;fs.mkdirSync=mkdir;syncBuiltinESMExports();}
 assert.ok(h.f.jobs.has(accepted.jobDigest));const dir=join(await h.f.home('owner'),'v1','telemetry');
 const state=JSON.parse(fs.readFileSync(join(dir,'request-privacy.json')));assert.equal(state.suppressed.some(([key])=>key.startsWith('pending:')),failBinding,'a failed binding retains the earlier durable reservation');
 await h.tel.close();fs.rmSync(join(dir,'rollup.json'),{force:true});const events=[];let time=Date.now();
 const tel=createTelemetry({dir,base:dir,version:'1.2.3',env:{},now:()=>time,random:()=>0,tripwire:async()=>null,transport:async(url,init)=>url.includes('/flags/')?{status:200,json:async()=>({flags:{'faravan-telemetry-enabled':{enabled:true}}})}:(events.push(...JSON.parse(gunzipSync(init.body)).batch),{status:200,headers:new Headers(),body:{cancel:async()=>{}}})});t.after(()=>tel.close());await tel.flushNow();assert.equal(tel.bootstrap().remoteEnabled,true);
 for(const [digest,state] of [[accepted.jobDigest,'failed'],['sha256:'+'b'.repeat(64),'result-accepted']])tel.observe('event:job',{job_digest:digest,state,attempts_started:1,job:{payload:{requirements:{harness:['codex']}}}});
 time+=600001;await tel.flushNow();assert.deepEqual(events.filter(e=>e.event==='job.run').map(e=>e.properties.outcome),failBinding?[]:['finished'],'the opted-out lifecycle never uploads; a completed binding permits an unrelated positive-control job');
});
for(const headers of [{'faravan-telemetry':'off'},{'sec-gpc':'1'}])test(`an opted-out request rejected before submit leaves no reservation (${Object.keys(headers)[0]})`,async t=>{
 const h=await telemetryApp(t);await h.f.provisionFromHome('owner');const circle=await api(h.app,'/api/circles',{method:'POST',body:{origin:h.f.origin,name:'Synthetic'}});
 const response=await fetch(h.app.origin+'/api/jobs',{method:'POST',headers:{'x-faravan-session-token':h.app.token,'content-type':'application/json',...headers},body:JSON.stringify({circle:circle.id,promptFile:'/tmp/x',git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic task',harness:'codex'})});
 assert.equal(response.status,400);assert.equal(h.f.jobs.size,0);
 await h.tel.close();const dir=join(await h.f.home('owner'),'v1','telemetry');
 let state={suppressed:[]};try{state=JSON.parse(fs.readFileSync(join(dir,'request-privacy.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}assert.equal(state.suppressed.some(([key])=>key.startsWith('pending:')),false,'a request proven not submitted keeps no reservation');
 fs.rmSync(join(dir,'rollup.json'),{force:true});const events=[];let time=Date.now();
 const tel=createTelemetry({dir,base:dir,version:'1.2.3',env:{},now:()=>time,random:()=>0,tripwire:async()=>null,transport:async(url,init)=>url.includes('/flags/')?{status:200,json:async()=>({flags:{'faravan-telemetry-enabled':{enabled:true}}})}:(events.push(...JSON.parse(gunzipSync(init.body)).batch),{status:200,headers:new Headers(),body:{cancel:async()=>{}}})});t.after(()=>tel.close());await tel.flushNow();
 tel.observe('event:job',{job_digest:'sha256:'+'c'.repeat(64),state:'result-accepted',attempts_started:1,job:{payload:{requirements:{harness:['codex']}}}});
 time+=600001;await tel.flushNow();
 assert.deepEqual(events.filter(e=>e.event==='job.run').map(e=>e.properties.outcome),['finished'],'an unrelated job still drains after restart');
});
