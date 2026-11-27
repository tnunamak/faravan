import './helpers/no-browser.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createTelemetry} from '../lib/v1/telemetry/index.mjs';
import {writeInboxRecord} from '../lib/v1/telemetry/crash.mjs';
import {parseQueuedRecord} from '../lib/v1/telemetry/posthog.mjs';
function rig(t){
 const dir=mkdtempSync(join(tmpdir(),'posthog-review-'));let time=Date.UTC(2026,10,6,23,40),flag=false;const events=[];
 const transport=async(url,init)=>url.includes('/flags/')?{status:200,json:async()=>({flags:{'faravan-telemetry-enabled':{enabled:flag}}})}:
  (events.push(...JSON.parse(gunzipSync(init.body)).batch),{status:200,headers:new Headers(),body:{cancel:async()=>{}}});
 const tel=createTelemetry({dir,base:dir,version:'1.2.3',env:{},now:()=>time,random:()=>0,transport,tripwire:async()=>null});tel.markNoticeShown();
 t.after(async()=>{await tel.close();rmSync(dir,{recursive:true,force:true});});
 return {dir,tel,events,now:()=>time,advance:ms=>time+=ms,flag:value=>flag=value};
}
function job(h,digest,outcome){
 h.tel.observe('event:job',{job_digest:digest,state:'queued',job:{payload:{created_at:new Date(h.now()).toISOString(),expires_at:new Date(h.now()+3600000).toISOString(),requirements:{harness:['codex']}}}});
 h.tel.observe('event:job',{job_digest:digest,state:outcome==='finished'?'result-accepted':'failed',attempts_started:1,job:{payload:{requirements:{harness:['codex']}}}});
}
for(const initial of ['unknown','false'])for(const headers of [{'faravan-telemetry':'off'},{'sec-gpc':'1'}]){
 test(`request ${Object.keys(headers)[0]} suppresses its job across remote ${initial} and cleanup`,async t=>{
  const h=rig(t);if(initial==='false')await h.tel.flushNow();
  const hidden='sha256:'+'a'.repeat(64);h.tel.response({writer:'app',req:{url:'/api/jobs',headers},status:200,body:{job_digest:hidden}});
  await h.tel.flushNow();h.advance(300000);await h.tel.flushNow(); // a false result purges capture state again
  h.flag(true);h.advance(300000);await h.tel.flushNow();
  job(h,hidden,'failed');job(h,'sha256:'+'b'.repeat(64),'finished');h.advance(600001);await h.tel.flushNow();
  const spans=h.events.filter(event=>event.event==='job.run');assert.ok(spans.some(event=>event.properties.outcome==='finished'),'positive control: unrestricted job was captured');
  assert.deepEqual(spans.map(event=>event.properties.outcome),['finished'],'request opt-out survives the disabled interval');
  assert.equal(h.events.filter(event=>event.event==='job.outcome.count'&&event.properties.outcome==='failed').length,0);
 });
}
const edgeRecord=h=>({name:'health.state',period:new Date(h.now()).toISOString().slice(0,13),value:1,attrs:{check:'coordinator_tunnel',state:'blocked',reason:'network_error'}});
for(const state of ['unknown','false','expired']){
 test(`edge capture fails closed while the remote lease is ${state}`,async t=>{
  const h=rig(t);
  if(state==='false')await h.tel.flushNow();
  if(state==='expired'){h.flag(true);await h.tel.flushNow();h.advance(900000);}
  const captured=writeInboxRecord({dir:h.dir,env:{},origin:'coordinator',record:edgeRecord(h),now:h.now});
  h.flag(true);h.advance(300000);await h.tel.flushNow();h.tel.ingestInbox();h.advance(300000);await h.tel.flushNow();
  assert.equal(captured,false,'the producer must not capture outside a live remote lease');
  assert.equal(h.events.filter(event=>event.event==='health.state'&&event.properties.check==='coordinator_tunnel').length,0,'disabled-interval records never upload after re-enable');
 });
}
test('ingest rejects a record from a revoked lease even when restored after cleanup',async t=>{
 const h=rig(t);h.flag(true);await h.tel.flushNow();assert.equal(writeInboxRecord({dir:h.dir,env:{},origin:'coordinator',record:edgeRecord(h),now:h.now}),true);
 const inbox=join(h.dir,'inbox'),name=readdirSync(inbox)[0],saved=readFileSync(join(inbox,name),'utf8');
 h.flag(false);h.advance(300000);await h.tel.flushNow();mkdirSync(inbox,{recursive:true});writeFileSync(join(inbox,name),saved);
 h.flag(true);h.advance(300000);await h.tel.flushNow();h.tel.ingestInbox();h.advance(600001);await h.tel.flushNow();
 assert.equal(h.events.filter(event=>event.event==='health.state'&&event.properties.check==='coordinator_tunnel').length,0,'a restored old-lease record is not revived');
});
test('queued metadata rejects parseable timestamps carrying private text',()=>{
 const record={name:'app_started',origin:'app',properties:{},_posthog:{uuid:'11111111-1111-4111-8111-111111111111',surface:'background',timestamp:'2026-01-01 (confidential project name)'}};
 assert.throws(()=>parseQueuedRecord(record),'Date.parse acceptance alone is not timestamp validation');
});
test('valid edge capture survives uninterrupted lease renewals and never sends its local proof',async t=>{
 const h=rig(t);h.flag(true);await h.tel.flushNow();
 assert.equal(writeInboxRecord({dir:h.dir,env:{},origin:'coordinator',record:edgeRecord(h),now:h.now}),true);
 const lease=JSON.parse(readFileSync(join(h.dir,'remote-lease.json'),'utf8'));
 h.advance(300000);await h.tel.flushNow();h.tel.ingestInbox();
 for(let n=0;n<3;n++){h.advance(300000);await h.tel.flushNow();}
 assert.equal(h.events.filter(event=>event.event==='health.state'&&event.properties.check==='coordinator_tunnel').length,1);
 assert.equal(JSON.stringify(h.events).includes(lease.id),false,'local lease nonce must never enter Cloud properties');
});
test('edge capture rejects other-generation, false, future and corrupt lease evidence',async t=>{
 const h=rig(t);h.flag(true);await h.tel.flushNow();const file=join(h.dir,'remote-lease.json'),valid=JSON.parse(readFileSync(file,'utf8'));
 for(const lease of [{...valid,generation:valid.generation+1},{...valid,enabled:false},{...valid,checkedAt:h.now()+1},null]){
  writeFileSync(file,JSON.stringify(lease));assert.equal(writeInboxRecord({dir:h.dir,env:{},origin:'coordinator',record:edgeRecord(h),now:h.now}),false);
 }
 writeFileSync(file,'broken');assert.equal(writeInboxRecord({dir:h.dir,env:{},origin:'coordinator',record:edgeRecord(h),now:h.now}),false);
});
test('ingest rejects missing proof and capture times outside the uninterrupted lease',async t=>{
 const h=rig(t);h.flag(true);await h.tel.flushNow();
 assert.equal(writeInboxRecord({dir:h.dir,env:{},origin:'coordinator',record:edgeRecord(h),now:h.now}),true);
 const inbox=join(h.dir,'inbox'),name=readdirSync(inbox)[0],valid=JSON.parse(readFileSync(join(inbox,name),'utf8'));
 for(const [n,capture] of [undefined,{...valid.capture,captured_at:h.now()-1},{...valid.capture,captured_at:h.now()+1}].entries()){
  const file={...valid};if(capture===undefined)delete file.capture;else file.capture=capture;
  writeFileSync(join(inbox,name),JSON.stringify(file));h.tel.ingestInbox();assert.equal(readdirSync(inbox).length,0,`invalid proof ${n} is removed`);
 }
 for(let n=0;n<4;n++){h.advance(300000);await h.tel.flushNow();}
 assert.equal(h.events.filter(event=>event.event==='health.state'&&event.properties.check==='coordinator_tunnel').length,0);
});
test('queue timestamps require canonical UTC strings with exact calendar round trips',()=>{
 const record={name:'app_started',origin:'app',properties:{},_posthog:{uuid:'11111111-1111-4111-8111-111111111111',surface:'background',timestamp:'2026-01-01T00:00:00.000Z'}};
 assert.equal(parseQueuedRecord(record)._posthog.timestamp,record._posthog.timestamp);
 for(const timestamp of ['2026-01-01T00:00:00Z','2026-01-01T01:00:00.000+01:00','2026-02-30T00:00:00.000Z','2026-01-01 (private note)',1767225600000,['2026-01-01T00:00:00.000Z']])assert.throws(()=>parseQueuedRecord({...record,_posthog:{...record._posthog,timestamp}}));
});
