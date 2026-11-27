import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,lstatSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createTelemetry} from '../../lib/v1/telemetry/index.mjs';
import {createConsent} from '../../lib/v1/telemetry/consent.mjs';
import {parseFact,FACT_SCHEMAS} from '../../lib/v1/telemetry/contract.mjs';

function fixture(t){
  const parent=join(homedir(),'.tmp');mkdirSync(parent,{recursive:true,mode:0o700});
  const stat=lstatSync(parent);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());
  assert.equal(stat.mode&0o777,0o700);if(process.getuid)assert.equal(stat.uid,process.getuid());
  const base=mkdtempSync(join(parent,'capture-facade-')),dir=join(base,'telemetry'),instances=[];
  let at=1800000000000,sequence=0,transportCalls=0,timerCalls=0;
  const bytes=size=>Buffer.alloc(size,(++sequence%250)+1);
  const options={base,dir,env:{},version:'1.2.3',enabled:true,now:()=>at,bytes,random:()=>0,
    transport:()=>{transportCalls++;throw new Error('network forbidden in capture test');},
    setTimer:()=>{timerCalls++;throw new Error('timers forbidden in capture test');},
    remoteFactory:()=>({allowed:()=>true,poll:async()=>{},reset:()=>{},cancel:()=>{}})};
  const open=()=>{const api=createTelemetry(options);instances.push(api);assert.equal(api.status().uploadable,true,'must use real available facade');return api;};
  t.after(async()=>{try{for(const api of instances)await api.close();assert.equal(transportCalls,0);assert.equal(timerCalls,0);}
    finally{rmSync(base,{recursive:true,force:true});}});
  return {base,dir,options,open,advance:()=>{at+=10;},quiet:()=>{assert.equal(transportCalls,0);assert.equal(timerCalls,0);}};
}
const records=api=>api.preview().items.filter(item=>item.state==='queued').map(item=>({item,record:JSON.parse(item.body)}));
const named=(api,name)=>records(api).filter(row=>row.record.name===name);
async function on(api){await api.markNoticeShown();await api.choose({level:'on'});assert.equal(api.status().effective,'on');}
function diskContains(root,needle){
  for(const entry of readdirSync(root,{withFileTypes:true})){
    const path=join(root,entry.name);assert.ok(!entry.isSymbolicLink());
    if(entry.isDirectory()){if(diskContains(path,needle))return true;}
    else if(entry.isFile()&&readFileSync(path).includes(Buffer.from(needle)))return true;
  }
  return false;
}

test('actual observeFact tick and preview persist closed facts with real stamping envelope',async t=>{
  const f=fixture(t),api=f.open();assert.equal(api.status().effective,'off');
  assert.equal(api.observeFact('ui_presence_changed',{visible:true}),false);
  assert.deepEqual(api.preview().items,[]);
  await on(api);
  assert.equal(api.observeFact('ui_presence_changed',{}, {surface:'ui'}),true);api.tick();
  const baseline=named(api,'ui_presence_changed');assert.equal(baseline.length,1);
  assert.deepEqual(baseline[0].record.properties,{});
  f.advance();
  const properties={visible:true,browser_online:false,app_connection_state:'connected'};
  assert.deepEqual(parseFact('ui_presence_changed',properties),properties);
  assert.equal(api.observeFact('ui_presence_changed',properties,{surface:'ui'}),true);
  // Acceptance is not persistence: only tick hands the real record to the durable outbox.
  assert.equal(named(api,'ui_presence_changed').length,1);api.tick();
  const rows=named(api,'ui_presence_changed');assert.equal(rows.length,2);
  const found=rows.find(row=>row.record.properties.visible===true);assert.ok(found);
  assert.deepEqual(found.record.properties,properties);
  assert.deepEqual(Object.keys(found.record).sort(),Object.keys(baseline[0].record).sort(),'only actual stamping envelope keys');
  assert.ok(Object.keys(found.record).length>2,'real stamp accompanies name and properties');
  assert.equal(found.item.bytes,Buffer.byteLength(found.item.body));assert.equal(found.item.status,null);
  assert.ok(Number.isFinite(Date.parse(found.item.at)));
  assert.ok(diskContains(join(f.dir,'outbox'),'"app_connection_state":"connected"'),'record bytes actually reached durable outbox');
  const restart=f.open();assert.equal(restart.status().effective,'on');
  assert.ok(named(restart,'ui_presence_changed').some(row=>row.record.properties.visible===true));
  f.quiet();
});

test('valid counters/enums preserve null and absence without synthesizing unknown fields',async t=>{
  const f=fixture(t),api=f.open();await on(api);
  const cases=[
    ['onboarding_step_changed',{step:'kvm',outcome:'completed',duration_ms:42}],
    ['resource_constraints_observed',{slots:3,available_slots:0,reserve_pct:20,idle_only:false}],
    ['job_requested',{requested_provider:null,requested_model:null}],
  ];
  for(const [name,properties]of cases){assert.deepEqual(parseFact(name,properties),properties);assert.equal(api.observeFact(name,properties),true);}
  api.tick();
  for(const [name,properties]of cases){
    const rows=named(api,name);assert.equal(rows.length,1);assert.deepEqual(rows[0].record.properties,properties);
    for(const key of Object.keys(rows[0].record.properties))assert.ok(Object.hasOwn(FACT_SCHEMAS[name],key));
  }
  const job=named(api,'job_requested')[0].record.properties;
  assert.equal(job.requested_provider,null);assert.equal(Object.hasOwn(job,'requested_effort'),false);
  f.quiet();
});

test('sensitive keys and enum values, unknown/accessor properties and request restrictions add no record',async t=>{
  const f=fixture(t),api=f.open();await on(api);api.tick();
  const before=api.preview().items.map(item=>item.body),canary='synthetic-private-canary-490';
  let getters=0;
  const accessor={};Object.defineProperty(accessor,'visible',{enumerable:true,get(){getters++;return true;}});
  const invalid=[
    ['ui_presence_changed',{visible:true,prompt:canary},{}],
    ['ui_presence_changed',{app_connection_state:canary},{}],
    ['ui_presence_changed',{authorization:canary},{}],
    ['ui_presence_changed',{unknown_field:canary},{}],
    ['ui_presence_changed',accessor,{}],
    ['ui_presence_changed',{visible:null},{}],
    ['onboarding_step_changed',{duration_ms:0.5},{}],
    ['resource_constraints_observed',{slots:Infinity},{}],
    ['not-a-fact',{visible:true},{}],
    ['ui_presence_changed',{visible:true},{off:true}],
    ['ui_presence_changed',{visible:true},{headers:{'sec-gpc':'1'}}],
    ['ui_presence_changed',{visible:true},{headers:{'faravan-telemetry':'off'}}],
    ['ui_presence_changed',{visible:true},{surface:canary}],
    ['ui_presence_changed',{$set:{email:canary}},{}],
  ];
  for(const [name,properties,options]of invalid)assert.equal(api.observeFact(name,properties,options),false,name);
  assert.equal(getters,0,'untrusted accessor must never be evaluated');
  api.tick();assert.deepEqual(api.preview().items.map(item=>item.body),before);
  assert.equal(diskContains(f.dir,canary),false);
  assert.equal(api.observeFact('ui_presence_changed',{visible:false}),true);api.tick();
  assert.equal(named(api,'ui_presence_changed').length,1,'positive control after rejected inputs');
  f.quiet();
});

test('saved OFF and interrupted purge outrank accepted memory and durable queue across factories',async t=>{
  const f=fixture(t),old=f.open();await on(old);
  assert.equal(old.observeFact('ui_presence_changed',{visible:true}),true);old.tick();
  assert.equal(named(old,'ui_presence_changed').length,1);
  assert.equal(old.observeFact('ui_presence_changed',{browser_online:true}),true);
  // Actual consent authority writes pending OFF; facade restart must complete physical purge.
  const direct=createConsent({...f.options,uploadable:true});direct.restrict();assert.equal(direct.purgePending(),true);
  old.tick();assert.equal(old.status().effective,'off');
  assert.equal(old.observeFact('ui_presence_changed',{visible:true}),false);
  const restarted=f.open();assert.equal(restarted.status().effective,'off');
  assert.deepEqual(restarted.preview().items,[]);
  assert.equal(direct.purgePending(),false);assert.equal(diskContains(join(f.dir,'outbox'),'"visible":true'),false);
  await restarted.choose({level:'on'});assert.equal(restarted.status().effective,'on');
  old.tick();assert.deepEqual(restarted.preview().items,[],'old raw facts cannot cross consent generation');
  assert.equal(restarted.observeFact('ui_presence_changed',{visible:false}),true);restarted.tick();
  const rows=named(restarted,'ui_presence_changed');assert.equal(rows.length,1);assert.deepEqual(rows[0].record.properties,{visible:false});
  await restarted.choose({level:'off'});assert.deepEqual(restarted.preview().items,[]);
  const final=f.open();assert.equal(final.status().level,'off');assert.equal(final.status().effective,'off');
  assert.deepEqual(final.preview().items,[]);f.quiet();
});
