import './helpers/no-browser.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {gunzipSync} from 'node:zlib';
import {createTelemetry} from '../lib/v1/telemetry/index.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';
import {createRequestPrivacy} from '../lib/v1/telemetry/request-privacy.mjs';
import {ROLLUP_LIMITS} from '../lib/v1/telemetry/rollup.mjs';
const START=Date.UTC(2026,10,6,12),hidden='sha256:'+'a'.repeat(64),visible='sha256:'+'b'.repeat(64);
const options=dir=>({dir,base:dir,env:{},version:'1.2.3',random:()=>0,tripwire:async()=>null});
function job(tel,digest,outcome,time){
 tel.observe('event:job',{job_digest:digest,state:'queued',job:{payload:{created_at:new Date(time).toISOString(),expires_at:new Date(time+3600000).toISOString(),requirements:{harness:['codex']}}}});
 tel.observe('event:job',{job_digest:digest,state:outcome==='finished'?'result-accepted':'failed',attempts_started:1,job:{payload:{requirements:{harness:['codex']}}}});
}
for(const state of ['unknown','false','stale'])for(const header of ['faravan-telemetry','sec-gpc']){
 test(`request ${header} survives a crash during remote ${state}`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'posthog-restart-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const script=`import {createTelemetry} from ${JSON.stringify(new URL('../lib/v1/telemetry/index.mjs',import.meta.url).href)};
   let time=${START},flag=${state==='stale'};const tel=createTelemetry({...${JSON.stringify(options(dir))},now:()=>time,tripwire:async()=>null,transport:async()=>({status:200,json:async()=>({flags:{'faravan-telemetry-enabled':{enabled:flag}}})})});
   tel.markNoticeShown();${state==='unknown'?'':'await tel.flushNow();'}${state==='stale'?'time+=900000;':''}
   tel.response({writer:'app',req:{url:'/api/jobs',headers:{${JSON.stringify(header)}:${JSON.stringify(header==='sec-gpc'?'1':'off')}}},status:200,body:{job_digest:${JSON.stringify(hidden)}}});
   flag=false;await tel.flushNow();process.exit(0);`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
  let time=START+1200000;const events=[];const tel=createTelemetry({...options(dir),now:()=>time,transport:async(url,init)=>url.includes('/flags/')?{status:200,json:async()=>({flags:{'faravan-telemetry-enabled':{enabled:true}}})}:(events.push(...JSON.parse(gunzipSync(init.body)).batch),{status:200,headers:new Headers(),body:{cancel:async()=>{}}})});
  t.after(()=>tel.close());await tel.flushNow();job(tel,hidden,'failed',time);job(tel,visible,'finished',time);time+=600001;await tel.flushNow();
  assert.deepEqual(events.filter(e=>e.event==='job.run').map(e=>e.properties.outcome),['finished'],'only the unrestricted positive control may upload after restart');
 });
}
test('overflow refusal survives a crash with the remote flag disabled',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'posthog-overflow-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const script=`import {createTelemetry} from ${JSON.stringify(new URL('../lib/v1/telemetry/index.mjs',import.meta.url).href)};
 const tel=createTelemetry({...${JSON.stringify(options(dir))},now:()=>${START},transport:async()=>({status:200,json:async()=>({flags:{}})})});tel.markNoticeShown();
 for(let n=0;n<${ROLLUP_LIMITS.suppressed+1};n++)tel.response({writer:'app',req:{url:'/api/jobs',headers:{'sec-gpc':'1'}},status:200,body:{job_digest:'sha256:'+n.toString(16).padStart(64,'0')}});
 await tel.flushNow();process.exit(0);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
 const stored=JSON.parse(readFileSync(join(dir,'request-privacy.json')));assert.equal(stored.suppressed.length,ROLLUP_LIMITS.suppressed);assert.ok(stored.refusedUntil>START);
 let time=START+300000;const events=[];const tel=createTelemetry({...options(dir),now:()=>time,transport:async(url,init)=>url.includes('/flags/')?{status:200,json:async()=>({flags:{'faravan-telemetry-enabled':{enabled:true}}})}:(events.push(...JSON.parse(gunzipSync(init.body)).batch),{status:200,headers:new Headers(),body:{cancel:async()=>{}}})});t.after(()=>tel.close());
 await tel.flushNow();assert.equal(tel.observeFact('app_started',{}),true,'non-job positive control is allowed');job(tel,visible,'finished',time);time+=600001;await tel.flushNow();
 assert.equal(events.filter(e=>e.event==='job.run'||e.event==='job.outcome.count').length,0,'overflow must refuse even an unmarked job after restart');assert.ok(events.some(e=>e.event==='app_started'));
});
for(const method of ['restrict','choose','markNoticeShown','resetIdentity'])test(`public ${method} awaits a busy lock without blocking the heartbeat`,async t=>{
 const dir=mkdtempSync(join(tmpdir(),'posthog-public-lock-'));const tel=createTelemetry({...options(dir),transport:async()=>({status:200,json:async()=>({flags:{}})})});tel.markNoticeShown();t.after(async()=>{await tel.close();rmSync(dir,{recursive:true,force:true});});
 const script=`import {acquireProcessLockSync} from ${JSON.stringify(new URL('../lib/v1/lock.mjs',import.meta.url).href)};const release=acquireProcessLockSync(${JSON.stringify(join(dir,'consent.lock'))},{durable:false});process.stdout.write('locked');setTimeout(()=>release(),750);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});const exited=once(child,'exit');t.after(()=>{if(child.exitCode===null)child.kill();});await once(child.stdout,'data');
 const start=performance.now(),beats=[];const timer=setInterval(()=>beats.push(performance.now()-start),10);let result,finished=false;
 try{
  result=Promise.resolve(tel[method](...(method==='choose'?[{level:'off'}]:[]))).then(value=>{finished=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,100));assert.ok(beats.length>=3&&beats[0]<200,`heartbeat was delayed ${beats[0]} ms`);assert.equal(finished,false,'the mutation cannot acknowledge before acquiring authority');
 }finally{clearInterval(timer);await exited;await result;}
 if(method==='restrict'||method==='choose'){assert.equal(JSON.parse(readFileSync(join(dir,'policy.json'))).level,'off');assert.equal(tel.bootstrap().consent,'off');}
});

test('privacy migration, corrupt state and a busy writer preserve restrictions across reopening',()=>{
 const dir=mkdtempSync(join(tmpdir(),'posthog-privacy-'));
 try {
  const initial={suppressed:[[hidden,START+86400000]],refusedUntil:START+900000};
  const store=createRequestPrivacy({dir,base:dir,now:()=>START,initial});assert.deepEqual(store.snapshot(),initial);
  writeFileSync(join(dir,'request-privacy.json'),'broken');assert.ok(createRequestPrivacy({dir,base:dir,now:()=>START}).snapshot().refusedUntil>START);
  writeFileSync(join(dir,'request-privacy.json'),JSON.stringify(initial));
  const release=acquireProcessLockSync(join(dir,'request-privacy.lock'),{durable:false});
  try{store.suppress(visible);}finally{release();}
  assert.ok(createRequestPrivacy({dir,base:dir,now:()=>START}).snapshot().refusedUntil>START+86400000,'a skipped write leaves a durable refusal after reopening');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
