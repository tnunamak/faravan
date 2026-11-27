import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,lstatSync,rmSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {createTelemetry} from '../../lib/v1/telemetry/index.mjs';
import {createRequestPrivacy} from '../../lib/v1/telemetry/request-privacy.mjs';

const queued=api=>api.preview().items.filter(x=>x.state==='queued').map(x=>JSON.parse(x.body));
const positive=api=>queued(api).filter(x=>x.name==='ui_presence_changed');
const response=(status=204,retry=null,onCancel=()=>{})=>({
  status,headers:{get:name=>name==='retry-after'?retry:null},
  body:{cancel:async()=>onCancel()},
});
function contains(root,needle){
  for(const e of readdirSync(root,{withFileTypes:true})){
    const p=join(root,e.name);assert.ok(!e.isSymbolicLink());
    if(e.isDirectory()?contains(p,needle):e.isFile()&&readFileSync(p).includes(Buffer.from(needle)))return true;
  }
  return false;
}
function fixture(t,transport){
  const parent=join(homedir(),'.tmp');mkdirSync(parent,{recursive:true,mode:0o700});
  const stat=lstatSync(parent);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());
  assert.equal(stat.mode&0o777,0o700);if(process.getuid)assert.equal(stat.uid,process.getuid());
  const base=mkdtempSync(join(parent,'telemetry-isolation-')),dir=join(base,'telemetry'),instances=[];
  let at=1800000000000,sequence=0,cancelled=0;
  const errors=[];const onUnhandled=error=>errors.push(error);
  process.on('unhandledRejection',onUnhandled);
  const options={base,dir,env:{},version:'1.2.3',enabled:true,now:()=>at,
    bytes:size=>Buffer.alloc(size,(++sequence%250)+1),random:()=>0,transport,
    setTimer:()=>{throw new Error('background timers forbidden');},
    remoteFactory:()=>({allowed:()=>true,poll:async()=>{},reset:()=>{},cancel:()=>{cancelled++;}})};
  const open=()=>{const api=createTelemetry(options);instances.push(api);
    assert.equal(api.status().uploadable,true);return api;};
  t.after(async()=>{
    try{for(const api of instances)await api.close();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(errors,[]);}
    finally{process.off('unhandledRejection',onUnhandled);rmSync(base,{recursive:true,force:true});}
  });
  return {base,dir,open,advance:ms=>{at+=ms;},now:()=>at,cancelled:()=>cancelled};
}
async function seed(api){
  await api.markNoticeShown();await api.choose({level:'on'});
  assert.equal(api.status().effective,'on');
  assert.equal(api.observeFact('ui_presence_changed',{visible:true}),true);api.tick();
  assert.equal(positive(api).length,1,'positive record reached actual durable outbox');
}
async function bounded(promise,ms){
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('bounded operation did not settle')),ms);
  })]);}finally{clearTimeout(timer);}
}

for(const mode of ['throw','reject'])test('actual facade isolates transport '+mode+' and retains sanitized queued evidence',async t=>{
  let calls=0,fail=true;const canary='private-transport-canary-391';
  const f=fixture(t,()=>{calls++;if(!fail)return response();
    if(mode==='throw')throw new Error(canary);
    return Promise.reject(new Error(canary));
  });
  const api=f.open();await seed(api);
  assert.ok(contains(join(f.dir,'outbox'),'"visible":true'));
  await api.flushNow();assert.equal(calls,1);assert.equal(positive(api).length,1);
  assert.deepEqual(api.status().upload.last,{status:null,error:'network',at:f.now()});
  assert.equal(api.status().upload.backoffUntil,f.now()+60000);
  await api.flushNow();assert.equal(calls,1,'backoff prevents duplicate dispatch');
  assert.equal(contains(f.dir,canary),false,'raw transport errors never persist');
  // Observation remains usable independently while delivery is deferred.
  assert.equal(api.observeFact('ui_presence_changed',{visible:false}),true);api.tick();
  assert.equal(positive(api).length,2);
  fail=false;f.advance(60000);await api.flushNow();
  assert.ok(calls>=2);assert.equal(positive(api).length,0);
  assert.equal(api.status().upload.last.error,null);
  assert.equal(api.status().upload.backoffUntil,null);
});

test('429 consumes only status/retry-after, cancels body and retries the real queued batch',async t=>{
  let calls=0,cancelled=0,first=true;const bodies=[];
  const f=fixture(t,(_url,init)=>{
    calls++;bodies.push(gunzipSync(init.body).toString('utf8'));
    const value=response(first?429:204,first?'120':null,()=>{cancelled++;});first=false;return value;
  });
  const api=f.open();await seed(api);
  await api.flushNow();assert.equal(calls,1);assert.equal(cancelled,1);
  assert.match(bodies[0],/ui_presence_changed/);
  assert.equal(api.status().upload.last.status,429);
  assert.equal(api.status().upload.backoffUntil,f.now()+120000);
  assert.equal(positive(api).length,1);
  f.advance(119999);await api.flushNow();assert.equal(calls,1);
  f.advance(1);await api.flushNow();assert.ok(calls>=2);
  assert.equal(cancelled,calls);assert.equal(positive(api).length,0);
});

test('hung transport receives abort while facade shutdown completes independently',async t=>{
  let release,signal,entered;
  const dispatched=new Promise(resolve=>{entered=resolve;});
  const pending=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,(_url,init)=>{signal=init.signal;entered();return pending;});
  const api=f.open();await seed(api);const flush=api.flushNow();
  await bounded(dispatched,1000);
  try{
    assert.equal(signal.aborted,false);
    await bounded(api.close(),3500);
    assert.equal(signal.aborted,true);assert.ok(f.cancelled()>0);
    assert.equal(api.observeFact('ui_presence_changed',{visible:false}),false);
    assert.equal(positive(api).length,1,'aborted dispatch is not a sent receipt');
  }finally{release(response());await bounded(flush,1000);}
});

test('OFF purges a queued in-flight batch and late response cannot resurrect it',async t=>{
  let release,signal,entered;
  const dispatched=new Promise(resolve=>{entered=resolve;});
  const pending=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,(_url,init)=>{signal=init.signal;entered();return pending;});
  const api=f.open();await seed(api);const flush=api.flushNow();await bounded(dispatched,1000);
  try{
    await bounded(api.choose({level:'off'}),1000);
    assert.equal(signal.aborted,true);assert.equal(api.status().effective,'off');
    assert.deepEqual(api.preview().items,[]);
  }finally{release(response());await bounded(flush,1000);}
  const restarted=f.open();assert.equal(restarted.status().effective,'off');
  assert.deepEqual(restarted.preview().items,[]);
  assert.equal(restarted.observeFact('ui_presence_changed',{visible:true}),false);
});

test('unwritable owned privacy path refuses opt-out persistence rather than swallowing it',async t=>{
  const f=fixture(t,()=>{throw new Error('transport must not run');});
  const blocked=join(f.base,'blocked');writeFileSync(blocked,'owned obstacle',{mode:0o600});
  const privacy=createRequestPrivacy({dir:blocked,base:f.base,now:f.now});
  assert.throws(()=>privacy.reserve(),error=>error.code==='telemetry_privacy_unavailable'&&error.status===503);
  const unavailable=createTelemetry({dir:blocked,base:f.base,env:{},enabled:true,version:'1.2.3'});
  assert.equal(unavailable.status().uploadable,false);
  assert.throws(()=>unavailable.prepareRequest({headers:{'faravan-telemetry':'off'}}),
    error=>error.code==='telemetry_privacy_unavailable'&&error.status===503);
  await unavailable.close();
});
