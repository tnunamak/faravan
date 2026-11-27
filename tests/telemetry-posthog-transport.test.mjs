import './helpers/no-browser.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {createTelemetry} from '../lib/v1/telemetry/index.mjs';
import {POSTHOG_HOST,POSTHOG_TOKEN,parseFact,PERSON_PROPERTIES} from '../lib/v1/telemetry/contract.mjs';
import {catalogToPosthog} from '../lib/v1/telemetry/posthog.mjs';
import {CATALOG,parseRecord} from '../lib/v1/telemetry/catalog.mjs';
import {readFileSync} from 'node:fs';
function setup(t,{status=200}={}){
 const dir=mkdtempSync(join(tmpdir(),'posthog-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let clock=Date.UTC(2026,10,6),flag=true,response=status,headers={};const requests=[];
 const transport=async(url,init)=>{
  requests.push({url,init});
  if(url.includes('/flags/'))return {status:200,json:async()=>({flags:{'faravan-telemetry-enabled':{enabled:flag}}})};
  return {status:response,headers:new Headers(headers),body:{cancel:async()=>{}}};
 };
 const options={dir,base:dir,version:'1.2.3',env:{},transport,now:()=>clock,random:()=>0,tripwire:async()=>null};
 const tel=createTelemetry(options);tel.markNoticeShown();
 return {tel,options,requests,advance:ms=>clock+=ms,setFlag:v=>flag=v,setResponse:v=>response=v,setHeaders:v=>headers=v,batches:()=>requests.filter(x=>x.url.endsWith('/batch/')).map(x=>JSON.parse(gunzipSync(x.init.body)))};
}
test('closed facts reject identities/free text and person properties are allow-listed',()=>{
 assert.throws(()=>parseFact('job_requested',{distinct_id:'bad'}));
 assert.throws(()=>parseFact('job_requested',{requested_model:'my-private-model'}));
 assert.throws(()=>parseFact('app_started',{$set:{email:'private'}}));
 assert.deepEqual(parseFact('account_plan_observed',{source:'user_selected',subscription_verified:false}),{source:'user_selected',subscription_verified:false});
 assert.ok(PERSON_PROPERTIES.surfaces_used);
});
test('fact delivery uses install identity, stable UUID/time retries and no profile suppression or GeoIP',async t=>{
 const h=setup(t,{status:503});await h.tel.flushNow();
 assert.equal(h.tel.observeFact('job_requested',{requested_model:'custom',$set:{os_type:'linux'}},{surface:'cli'}),true);
 await h.tel.flushNow();const first=h.batches()[0].batch[0];
 assert.equal(first.distinct_id,h.tel.bootstrap().installId);assert.equal(first.properties.surface,'cli');assert.equal(first.properties.$geoip_disable,true);assert.equal(first.properties.$process_person_profile,undefined);
 assert.equal(h.batches()[0].api_key,POSTHOG_TOKEN);assert.equal(h.requests.at(-1).url,POSTHOG_HOST+'/batch/');
 h.advance(60000);h.setResponse(200);await h.tel.flushNow();assert.deepEqual(h.batches()[1].batch[0],first);await h.tel.close();
});
test('remote false, expiry and OFF stop both capture and upload; true never overrides OFF',async t=>{
 const h=setup(t);assert.equal(h.tel.observeFact('app_started',{}),false);await h.tel.flushNow();assert.equal(h.tel.bootstrap().remoteEnabled,true);
 h.setFlag(false);h.advance(300000);await h.tel.flushNow();assert.equal(h.tel.bootstrap().remoteEnabled,false);assert.equal(h.tel.observeFact('app_started',{}),false);
 h.setFlag(true);h.advance(300000);await h.tel.flushNow();h.advance(900000);assert.equal(h.tel.bootstrap().remoteEnabled,false);
 h.tel.restrict();const n=h.requests.length;await h.tel.flushNow();assert.equal(h.requests.length,n);await h.tel.close();
});
test('heartbeat/profile and raw-memory/day caps are enforced before disk work',async t=>{
 const h=setup(t);await h.tel.flushNow();assert.equal(h.tel.observeFact('app_heartbeat',{}),true);assert.equal(h.tel.observeFact('app_heartbeat',{}),false);
 assert.equal(h.tel.observeFact('system_profile_observed',{os_type:'linux'}),true);assert.equal(h.tel.observeFact('system_profile_observed',{os_type:'linux'}),false);
 let accepted=2;for(let n=0;n<11000;n++)if(h.tel.observeFact('app_started',{}))accepted++;
 assert.ok(accepted<10000);await h.tel.flushNow();assert.equal(h.tel.observeFact('app_heartbeat',{}, {headers:{'sec-gpc':'1'}}),false);await h.tel.close();
});
test('every current catalog entry maps once and preserves all count/histogram/span fields',()=>{
 for(const [name,entry] of Object.entries(CATALOG.entries)){
  if(entry.until)continue;
  const file=new URL('./telemetry/golden/'+name+'.record.json',import.meta.url);
  const raw=JSON.parse(readFileSync(file,'utf8'));
  if(name==='install.run')Object.assign(raw,{rid:'r-AAAAAAAAAAAAAAAAAAAA',epoch:'e-AAAAAAAAAAAAAAAAAAAA',session:'s-AAAAAAAAAAAAAAAAAAAA',trace:'t-AAAAAAAAAAAAAAAAAAAA',seq:1});
  const record=parseRecord(raw,{origin:raw.origin??entry.origins[0]});
  const event=catalogToPosthog(record,{installId:'install',version:'1.2.3'});
  assert.equal(event.event,name);
  for(const key of ['value','buckets','counts','duration_ms','status','period','hour'])if(record[key]!==undefined)assert.deepEqual(event.properties[key],record[key]);
  for(const key of ['epoch','session','trace','rid','seq'])assert.equal(event.properties[key],undefined);
 }
});
test('restart reuses queued event UUID and original time without waiting for Cloud in observation',async t=>{
 const h=setup(t,{status:503});await h.tel.flushNow();h.tel.observeFact('app_started',{});await h.tel.flushNow();const first=h.batches()[0].batch[0];await h.tel.close();
 h.setResponse(200);h.advance(60000);const restarted=createTelemetry(h.options);await restarted.flushNow();assert.deepEqual(h.batches().at(-1).batch[0],first);await restarted.close();
});
test('OFF aborts upload and no response or retry repopulates a purged queue',async t=>{
 const h=setup(t);await h.tel.flushNow();
 let begin,finish;const started=new Promise(resolve=>begin=resolve),reply=new Promise(resolve=>finish=resolve);let signal;
 const transport=async(url,init)=>{
  if(url.includes('/flags/'))return {status:200,json:async()=>({flags:{'faravan-telemetry-enabled':{enabled:true}}})};
  signal=init.signal;begin();return reply;
 };
 const tel=createTelemetry({...h.options,transport});await tel.flushNow();assert.equal(tel.observeFact('app_started',{}),true);const upload=tel.flushNow();await started;
 tel.restrict();assert.equal(signal.aborted,true);finish({status:200,headers:new Headers(),body:{cancel:async()=>{}}});await upload;
 assert.equal(tel.preview().items.length,0);assert.equal(tel.bootstrap().installId,null);await tel.close();await h.tel.close();
});
test('a stale process cannot upload after another process completes OFF during tripwire',async t=>{
 const h=setup(t);let begin,finish;const started=new Promise(r=>begin=r),wait=new Promise(r=>finish=r);
 const first=createTelemetry({...h.options,tripwire:async()=>{begin();await wait;return null;}});
 await first.flushNow();first.observeFact('app_started',{});const upload=first.flushNow();await started;
 const second=createTelemetry(h.options);second.restrict();finish();await upload;assert.equal(h.batches().length,0);await first.close();await second.close();await h.tel.close();
});
test('rejected payloads quarantine, unauthorized uploads halt, and all batches meet byte/event bounds',async t=>{
 for(const status of [400,413,422,401,403]) {
  const h=setup(t,{status});await h.tel.flushNow();h.tel.observeFact('app_started',{});await h.tel.flushNow();
  assert.equal(h.tel.status().upload.halted,[401,403].includes(status));
  if(status<401||status>403)assert.ok(h.tel.preview().items.some(item=>item.state==='rejected'));
  for(const batch of h.batches()){assert.ok(batch.batch.length<=50);assert.ok(Buffer.byteLength(JSON.stringify(batch))<=65536);}
  await h.tel.close();
 }
});
test('remote stop uses the documented v2 boolean response and refuses variants/errors',async t=>{
 const h=setup(t);let body={flags:{'faravan-telemetry-enabled':{key:'faravan-telemetry-enabled',enabled:true}},errorsWhileComputingFlags:false};
 const transport=async(url,init)=>{assert.ok(url.endsWith('/flags/?v=2'));assert.equal(JSON.parse(init.body).api_key,POSTHOG_TOKEN);return {status:200,json:async()=>body};};
 const tel=createTelemetry({...h.options,transport});await tel.flushNow();assert.equal(tel.bootstrap().remoteEnabled,true);
 body={flags:{'faravan-telemetry-enabled':{enabled:true,variant:'something'}}};h.advance(300000);await tel.flushNow();assert.equal(tel.bootstrap().remoteEnabled,false);await tel.close();await h.tel.close();
});
test('app, CLI, MCP, UI and paired app facts share the host ID; UI accepts at most twenty facts',async t=>{
 const h=setup(t);await h.tel.flushNow();
 for(const surface of ['background','cli','mcp','ui','phone'])assert.equal(h.tel.observeFact('app_resumed',{}, {surface}),true);
 h.tel.ui(Array.from({length:25},()=>({name:'ui_presence_changed',properties:{visible:true}})),{origin:'ui',headers:{}});
 await h.tel.flushNow();const events=h.batches().flatMap(b=>b.batch).filter(e=>['app_resumed','ui_presence_changed'].includes(e.event));
 assert.equal(events.length,25);assert.equal(new Set(events.map(e=>e.distinct_id)).size,1);assert.equal(events[0].distinct_id,h.tel.bootstrap().installId);await h.tel.close();
});
test('observer never waits for Cloud and strict daily cap survives restart',async t=>{
 const h=setup(t);await h.tel.flushNow();let accepted=0;
 for(let round=0;round<4;round++){
  for(let n=0;n<6000;n++)if(h.tel.observeFact('app_started',{}))accepted++;
  h.tel.tick();
 }
 assert.equal(accepted,10000);assert.equal(h.tel.observeFact('app_started',{}),false);
 const restarted=createTelemetry(h.options);await restarted.flushNow();assert.equal(restarted.observeFact('app_started',{}),false);await restarted.close();await h.tel.close();
});

test('429 Retry-After is honored, bounded to six hours, and a network failure retries',async t=>{
 const h=setup(t,{status:429});h.setHeaders({'retry-after':'999999999'});await h.tel.flushNow();h.tel.observeFact('app_started',{});await h.tel.flushNow();const n=h.batches().length;
 assert.equal(h.tel.status().upload.backoffUntil,h.options.now()+6*3600000);h.advance(6*3600000-1);await h.tel.flushNow();assert.equal(h.batches().length,n);
 h.advance(1);h.setResponse(200);await h.tel.flushNow();assert.equal(h.batches().length,n+1);await h.tel.close();
});
test('unwritable cap storage cannot throw into observers or upload unreserved events',async t=>{
 const h=setup(t);await h.tel.flushNow();mkdirSync(join(h.options.dir,'caps.json'));
 assert.equal(h.tel.observeFact('app_started',{}),true);assert.doesNotThrow(()=>h.tel.tick());await h.tel.flushNow();assert.equal(h.batches().length,0);
 rmSync(join(h.options.dir,'caps.json'),{recursive:true});await h.tel.flushNow();assert.equal(h.batches()[0].batch[0].event,'app_started');await h.tel.close();
});
test('flag failures, missing booleans, errors and expiry fail closed and discard stale queues',async t=>{
 const h=setup(t,{status:503});let mode='on';
 const transport=async(url,init)=>{
  if(!url.includes('/flags/'))return {status:503,headers:new Headers(),body:{cancel:async()=>{}}};
  if(mode==='network')throw new Error('offline');
  if(mode==='invalid')return {status:200,json:async()=>{throw new Error('bad JSON');}};
  return {status:200,json:async()=>mode==='on'?{flags:{'faravan-telemetry-enabled':{enabled:true}}}:mode==='error'?{flags:{'faravan-telemetry-enabled':{enabled:true}},errorsWhileComputingFlags:true}:{}};
 };
 const tel=createTelemetry({...h.options,transport});await tel.flushNow();tel.observeFact('app_started',{});await tel.flushNow();assert.ok(tel.preview().items.length>0);
 for(const failure of ['network','invalid','error','missing']){mode=failure;h.advance(300000);await tel.flushNow();assert.equal(tel.bootstrap().remoteEnabled,false);assert.equal(tel.preview().items.length,0);}
 await tel.close();await h.tel.close();
});
test('retired compatibility records retain their original event fields without becoming new producers',()=>{
 const ids={rid:'r-AAAAAAAAAAAAAAAAAAAA',epoch:'e-AAAAAAAAAAAAAAAAAAAA',session:'s-AAAAAAAAAAAAAAAAAAAA',seq:1};
 const records=[{name:'problem.observed',kind:'event',hour:'2026-10-21T19',attrs:{'error.type':'unknown','problem.registry':'problem',component:'app',phase:'none',outcome:'failed',surface:'http'},...ids},
 {name:'setup.run',kind:'span',hour:'2026-10-21T19',attrs:{checks:[]},duration_ms:100,status:'ok',trace:'t-AAAAAAAAAAAAAAAAAAAA',...ids}];
 for(const record of records){assert.throws(()=>catalogToPosthog(record,{installId:'install',version:'1.2.3'}));const event=catalogToPosthog(record,{installId:'install',version:'1.2.3',schemaVersion:45});assert.equal(event.event,record.name);assert.equal(event.properties.hour,record.hour);if(record.duration_ms)assert.equal(event.properties.duration_ms,record.duration_ms);}
});
test('prototype names do not bypass the event or property allow-lists',()=>{
 for(const name of ['__proto__','constructor','toString','not_an_event'])assert.throws(()=>parseFact(name,{}));
 assert.throws(()=>parseFact('app_started',JSON.parse('{"__proto__":{}}')));
});
test('startup markers obey the same remote capture gate as facts',async t=>{
 const {existsSync}=await import('node:fs');const h=setup(t);h.tel.start();assert.equal(existsSync(join(h.options.dir,'running.json')),false);
 await h.tel.flushNow();assert.equal(existsSync(join(h.options.dir,'running.json')),true);
 h.setFlag(false);h.advance(300000);await h.tel.flushNow();assert.equal(existsSync(join(h.options.dir,'running.json')),false);await h.tel.close();
});
