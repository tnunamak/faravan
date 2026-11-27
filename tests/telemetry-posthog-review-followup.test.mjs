import './helpers/no-browser.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createTelemetry} from '../lib/v1/telemetry/index.mjs';
import {telemetryApp} from './helpers/telemetry-app.mjs';
import {parseQueuedRecord} from '../lib/v1/telemetry/posthog.mjs';

test('a contended background telemetry lock leaves the event-loop heartbeat responsive and fences durable OFF',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'posthog-lock-'));let time=Date.now();const requests=[];
 const tel=createTelemetry({dir,base:dir,version:'1.2.3',env:{},now:()=>time,tripwire:async()=>null,transport:async(url,init)=>{
  requests.push(url);return url.includes('/flags/')?{status:200,json:async()=>({flags:{'faravan-telemetry-enabled':{enabled:true}}})}:{status:200,headers:new Headers(),body:{cancel:async()=>{}}};
 }});
 t.after(async()=>{await tel.close();rmSync(dir,{recursive:true,force:true});});
 tel.markNoticeShown();await tel.flushNow();assert.equal(tel.observeFact('app_started',{}),true);tel.tick();
 const script=`import {acquireProcessLockSync} from ${JSON.stringify(new URL('../lib/v1/lock.mjs',import.meta.url).href)};
 import {readFileSync,writeFileSync} from 'node:fs';
 const release=acquireProcessLockSync(${JSON.stringify(join(dir,'consent.lock'))},{durable:false});process.stdout.write('locked\\n');
 setTimeout(()=>{const file=${JSON.stringify(join(dir,'policy.json'))},policy=JSON.parse(readFileSync(file));policy.level='off';policy.generation++;writeFileSync(file,JSON.stringify(policy));release();},750);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill();});const exited=once(child,'exit');await once(child.stdout,'data');
 const before=requests.length,start=performance.now(),beats=[];const timer=setInterval(()=>beats.push(performance.now()-start),10);
 try{
  time+=300000;tel.tick();await tel.flushNow();await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(beats.length>=3,'unrelated heartbeat kept running');assert.ok(beats[0]<200,`first heartbeat was delayed ${beats[0]} ms`);
  assert.equal(requests.length,before,'no request starts while another holder owns the authority');
 }finally{clearInterval(timer);await exited;}
 await tel.flushNow();assert.equal(tel.bootstrap().consent,'off');assert.equal(requests.length,before,'the newly durable OFF is checked before any later upload');
});

test('the app telemetry helper decodes both queued and sent catalog records',async t=>{
 const h=await telemetryApp(t);h.tel.observe('lender-failure',{code:'sandbox_start_failed',phase:'prepare'});
 const queued=await h.records({close:false}),before=queued.find(record=>record?.name==='problem.observed.readiness');assert.ok(before,'positive control: the queued record exists');
 await h.tel.flushNow();assert.ok(h.transport.requests.length>0,'positive control: an upload was captured');
 const sent=await h.records({close:false}),after=sent.find(record=>record?.name===before.name);
 assert.ok(after,'the sent batch remains inspectable as catalog records');assert.deepEqual(after.attrs,before.attrs);assert.ok(sent.every(Boolean),'no undefined records');
});

test('the second review timestamp examples cannot pass through queue metadata',()=>{
 const record={name:'app_started',origin:'app',properties:{},_posthog:{uuid:'11111111-1111-4111-8111-111111111111',surface:'background',timestamp:'2026-11-06T12:00:00.000Z'}};
 assert.equal(parseQueuedRecord(record)._posthog.timestamp,record._posthog.timestamp);
 const bad=['Fri, 06 Nov 2026 12:00:00 GMT (private-repo-name and prompt excerpt)',['2026-11-06T12:00:00.000Z'],'2026-11-06T12:00:00Z'];
 const accepted=bad.filter(timestamp=>{try{parseQueuedRecord({...record,_posthog:{...record._posthog,timestamp}});return true;}catch{return false;}});
 assert.deepEqual(accepted,[],'all comment, array and non-canonical inputs must be rejected');
});
