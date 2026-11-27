import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {isSavedCopy,journeyInvariants} from './browser-verify/invariants-journey.mjs';
import {INVARIANTS} from './browser-verify/invariants.mjs';

// The journey tracker counts a 2xx read as fresh unless its body says it is a saved copy (lib/v1/saved-reads.mjs
// markSaved). A saved copy counted as fresh made I06 read its "Last known:" text as a stale claim on a live read.
test('a body marked savedAt, on the object or on any list row, is a saved copy', () => {
  assert.equal(isSavedCopy({job_digest:'d1',state:'last_known',savedAt:'2026-10-23T10:00:00.000Z',savedReason:'unreachable'}),true);
  assert.equal(isSavedCopy([{job_digest:'d1'},{job_digest:'d2',savedAt:'2026-10-23T10:00:00.000Z',savedReason:'busy'}]),true);
});

test('a live body, an empty list, and a body that is not an object are not saved copies', () => {
  assert.equal(isSavedCopy({job_digest:'d1',state:'running'}),false);
  assert.equal(isSavedCopy([{job_digest:'d1'}]),false);
  assert.equal(isSavedCopy([]),false);
  assert.equal(isSavedCopy(null),false);
  assert.equal(isSavedCopy('savedAt'),false);
});

function readinessFixture(t,admission) {
  let now=10000,route='#/home',closed=false;
  t.mock.method(Date,'now',()=>now);
  const contexts=[],rule=INVARIANTS.find(row=>row.id==='I45');
  const page={url:()=> 'http://fixture.invalid/'+route,isClosed:()=>closed,on(){},off(){},viewportSize:()=>({width:390})};
  const recorder=journeyInvariants({attach:async()=>{}},{admission,inspect:async(_page,context)=>{
    contexts.push(context);
    const snapshot={width:390,text:'Ready for requests',buttons:[]};
    return {snapshot,failures:rule.check(snapshot,context)?[{id:rule.id,title:rule.title}]:[]};
  }});
  recorder.register(page,'friend');
  return {recorder,page,contexts,setTime:v=>now=v,setRoute:v=>route=v,
    finish:async()=>{closed=true;return recorder.finish();}};
}
test('off does not spend the active-refusal grace; continuous refusal still fails at 3 seconds',async t=>{
  let code='off';const f=readinessFixture(t,async()=>code);
  try {
    await f.recorder.checkpoint(f.page,'off');
    f.setTime(20000);code='rate_limited';await f.recorder.checkpoint(f.page,'new refusal');
    assert.equal(f.contexts.at(-1).readyRefusedMs,0,'off incorrectly aged the active refusal');
    f.setTime(22999);await f.recorder.checkpoint(f.page,'inside grace');
    f.setTime(23000);await f.recorder.checkpoint(f.page,'expired grace');
    const out=await f.finish();
    assert.deepEqual(out.failures.filter(x=>x.id==='I45').map(x=>x.label),['expired grace']);
  } finally {await f.finish();}
});
test('null/admitted and off reset the refusal clock, not every refusal poll',async t=>{
  let code='busy';const f=readinessFixture(t,async()=>code);
  try {
    await f.recorder.checkpoint(f.page,'busy');
    f.setTime(14000);code=null;await f.recorder.checkpoint(f.page,'admitted');
    assert.equal(f.contexts.at(-1).readyRefusedMs,0);
    f.setTime(15000);code='busy';await f.recorder.checkpoint(f.page,'new');
    assert.equal(f.contexts.at(-1).readyRefusedMs,0);
    f.setTime(17000);code='off';await f.recorder.checkpoint(f.page,'off');
    assert.equal(f.contexts.at(-1).readyRefusedMs,0);
    f.setTime(18000);code='busy';await f.recorder.checkpoint(f.page,'new again');
    assert.equal(f.contexts.at(-1).readyRefusedMs,0);
  } finally {await f.finish();}
});
test('an obsolete admission response cannot mutate the current route refusal clock',async t=>{
  let release,code='busy',held=true;
  const f=readinessFixture(t,()=>held?new Promise(r=>release=r):Promise.resolve(code));
  try {
    const old=f.recorder.checkpoint(f.page,'obsolete');
    await Promise.resolve();
    f.setRoute('#/friends');f.setTime(20000);held=false;code=null;
    await f.recorder.checkpoint(f.page,'current admitted');
    release('busy');await old;
    f.setTime(21000);code='busy';await f.recorder.checkpoint(f.page,'current refusal');
    assert.equal(f.contexts.at(-1).readyRefusedMs,0,'obsolete route response seeded current refusal age');
    const out=await f.finish();
    assert(!out.failures.some(x=>x.id==='I45'));
  } finally {await f.finish();}
});

import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {durableWrite} from '../lib/durable-write.mjs';
import {createSavedReads, jobReadKey, jobListKey, hostUnreachable, savedReasonFor} from '../lib/v1/saved-reads.mjs';

const digestA='sha256:'+'a'.repeat(64), digestB='sha256:'+'b'.repeat(64);
function savedFixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'saved-invalidation-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const metadata=join(directory,'authority.json');
  let failRemove=false, failure=null, writes=0, removals=0, time=1000;
  const options={directory,now:()=>time,
    remove:(...args)=>{removals++;if(failRemove)throw Object.assign(new Error('synthetic removal'),{code:'EACCES'});return rmSync(...args);},
    persist:(file,text)=>{
      if(file===metadata){writes++;if(failure==='after') {durableWrite(file,text);throw Object.assign(new Error('barrier'),{code:'EIO'});}
        if(failure)throw Object.assign(new Error('metadata'),{code:failure});}
      return durableWrite(file,text);
    }};
  return {directory,metadata,options,open:extra=>createSavedReads({...options,...extra}),
    failRemoval:()=>{failRemove=true;},fail:value=>{failure=value;},time:value=>{time=value;},
    writes:()=>writes,removals:()=>removals};
}
const remember=(cache,key,value)=>cache.remember(key,value,cache.ticket(key));
const payloads=directory=>readdirSync(directory,{withFileTypes:true})
  .filter(entry=>entry.isDirectory()).flatMap(circle=>readdirSync(join(directory,circle.name))
    .flatMap(job=>readdirSync(join(directory,circle.name,job)).map(name=>join(directory,circle.name,job,name))));

test('committed digest tombstone survives failed removal and restart, including cross-circle lists',t=>{
  const f=savedFixture(t),a=jobReadKey('circle-a',digestA),b=jobReadKey('circle-b',digestA),list=jobListKey('circle-b');
  let cache=f.open();
  remember(cache,a,{job_digest:digestA,result:'saved result'});
  remember(cache,b,{job_digest:digestA,result:'other circle'});
  remember(cache,list,[{job_digest:digestA},{job_digest:digestB}]);
  const oldTicket=cache.ticket(a);
  f.failRemoval();
  const token=cache.beginInvalidation({kind:'job',digest:digestA,circle:'circle-a'});
  assert.equal(cache.recall(a),null);assert.equal(cache.recall(b),null);assert.equal(cache.recall(list),null);
  cache.commitInvalidation(token);
  assert.ok(payloads(f.directory).length>0,'failed-rm bytes really remain');
  cache=f.open();
  assert.equal(cache.recall(a),null);assert.equal(cache.recall(b),null);
  cache.remember(a,{result:'late'},oldTicket);
  cache.remember(a,{result:'new'},cache.ticket(a));
  assert.equal(cache.recall(a),null);
  remember(cache,list,[{job_digest:digestA},{job_digest:digestB}]);
  assert.deepEqual(cache.recall(list).value,[{job_digest:digestB}]);
  assert.ok(JSON.parse(readFileSync(f.metadata,'utf8')).jobs.some(row=>row.digest===digestA&&row.deleted));
});

test('unknown pending intent survives restart and cancel restores copies without accepting old callbacks',t=>{
  const f=savedFixture(t),key=jobReadKey('circle-a',digestA),list=jobListKey('circle-a'),other=jobReadKey('circle-b',digestB);
  let cache=f.open();
  remember(cache,key,{result:'prior'});remember(cache,list,[{job_digest:digestA}]);remember(cache,other,{result:'unrelated'});
  const saved=cache.recall(key),old=cache.ticket(key);
  const token=cache.beginInvalidation({kind:'job',digest:digestA});
  const during=cache.ticket(key);assert.equal(during,null);
  cache=f.open();
  assert.equal(cache.recall(key),null);assert.equal(cache.recall(list),null);
  assert.equal(cache.recall(other).value.result,'unrelated');
  cache.remember(key,{result:'pending'},cache.ticket(key));assert.equal(cache.recall(key),null);
  assert.deepEqual(cache.pendingInvalidations().map(row=>row.id),[token]);
  // Caller has established a definite remote not_applied refusal; cache does no remote retry.
  cache.cancelInvalidation(token);
  assert.deepEqual(cache.recall(key),saved);
  assert.notEqual(cache.ticket(key),old);
  cache.remember(key,{result:'pending callback'},during);assert.deepEqual(cache.recall(key),saved);
  cache.remember(key,{result:'old callback'},old);assert.deepEqual(cache.recall(key),saved);
  assert.deepEqual(cache.recall(list).value,[{job_digest:digestA}]);
});

test('circle generations block failed-rm old and unstamped copies, but permit fresh rejoin reads',t=>{
  const f=savedFixture(t),key=jobReadKey('circle-a',digestA),list=jobListKey('circle-a'),other=jobReadKey('circle-b',digestB);
  let cache=f.open();
  remember(cache,key,{result:'old'});remember(cache,list,[{job_digest:digestA}]);remember(cache,other,{result:'other'});
  const old=cache.ticket(key);
  const token=cache.beginInvalidation({kind:'circle',circle:'circle-a'});
  assert.equal(cache.recall(key),null);
  cache.cancelInvalidation(token);
  assert.equal(cache.recall(key).value.result,'old');
  cache.remember(key,{result:'late'},old);assert.equal(cache.recall(key).value.result,'old');
  f.failRemoval();
  cache.commitInvalidation(cache.beginInvalidation({kind:'circle',circle:'circle-a'}));
  for(const file of payloads(f.directory)){
    const row=JSON.parse(readFileSync(file,'utf8'));
    if(JSON.parse(row.key)[0]==='circle-a'){delete row.circleGeneration;writeFileSync(file,JSON.stringify(row));}
  }
  cache=f.open();
  assert.equal(cache.recall(key),null);assert.equal(cache.recall(list),null);
  assert.equal(cache.recall(other).value.result,'other');
  cache.remember(key,{result:'unstamped callback'});assert.equal(cache.recall(key),null);
  remember(cache,key,{result:'authorized rejoin'});remember(cache,list,[{job_digest:digestA}]);
  cache=f.open();assert.equal(cache.recall(key).value.result,'authorized rejoin');
  assert.deepEqual(cache.recall(list).value,[{job_digest:digestA}]);
});

for(const code of ['EIO','ENOSPC','after']) test('metadata '+code+' latches unavailable without overwriting uncertain authority',t=>{
  const f=savedFixture(t),key=jobReadKey('circle-a',digestA);
  const cache=f.open();remember(cache,key,{result:'prior'});
  f.fail(code);
  assert.throws(()=>cache.beginInvalidation({kind:'job',digest:digestA}),{code:'saved_reads_unavailable'});
  const bytes=readFileSync(f.metadata,'utf8'),writes=f.writes();
  assert.equal(cache.recall(key),null);
  cache.remember(key,{result:'online response remains owned by caller'},cache.ticket(key));
  assert.throws(()=>cache.forgetCircle('circle-a'),{code:'saved_reads_unavailable'});
  assert.equal(f.writes(),writes);assert.equal(readFileSync(f.metadata,'utf8'),bytes);
  f.fail(null);
  assert.equal(cache.reloadInvalidations(),true);
  if(code==='after') {
    assert.equal(cache.recall(key),null,'possibly committed begin stays fenced');
    cache.cancelInvalidation(cache.pendingInvalidations()[0].id);
  }
  assert.equal(cache.recall(key).value.result,'prior');
});

test('ambiguous commit cannot resurrect or let an old instance clobber authority',t=>{
  const f=savedFixture(t),key=jobReadKey('circle-a',digestA);
  const cache=f.open(),other=f.open();
  remember(cache,key,{result:'prior'});
  const token=cache.beginInvalidation({kind:'job',digest:digestA});
  f.fail('after');assert.throws(()=>cache.commitInvalidation(token),{code:'saved_reads_unavailable'});
  assert.equal(other.recall(key),null,'another instance refreshes durable authority');
  f.fail(null);assert.equal(cache.reloadInvalidations(),true);
  assert.equal(cache.recall(key),null);
  other.forgetCircle('unrelated');
  assert.equal(f.open().recall(key),null);
});

for(const corrupt of ['{broken', '{"version":999}', '{"version":1,"version":2}']) test('invalid metadata is retained verbatim: '+corrupt,t=>{
  const f=savedFixture(t),key=jobReadKey('circle-a',digestA);
  let cache=f.open();remember(cache,key,{result:'prior'});
  writeFileSync(f.metadata,corrupt);cache=f.open();
  assert.equal(cache.recall(key),null);
  assert.throws(()=>cache.beginInvalidation({kind:'circle',circle:'circle-a'}),{code:'saved_reads_unavailable'});
  cache.remember(key,{result:'online'});
  assert.equal(readFileSync(f.metadata,'utf8'),corrupt);
});
test('missing metadata beside existing payloads is not reset to empty authority',t=>{
  const f=savedFixture(t),key=jobReadKey('circle-a',digestA);
  let cache=f.open();remember(cache,key,{result:'prior'});rmSync(f.metadata);
  cache=f.open();assert.equal(cache.recall(key),null);
  assert.throws(()=>cache.forgetJob(digestA),{code:'saved_reads_unavailable'});
  assert.throws(()=>readFileSync(f.metadata),{code:'ENOENT'});
});

test('failed eviction retains byte accounting and metadata is never evicted',t=>{
  const f=savedFixture(t),key=jobReadKey('circle-a',digestA);
  let cache=f.open();remember(cache,key,{result:'x'.repeat(1000)});
  const metadata=readFileSync(f.metadata,'utf8');f.failRemoval();
  cache=f.open({maxDiskBytes:512,maxBytes:1});
  const first=f.removals();assert.ok(first>0);
  assert.ok(payloads(f.directory).length>0);
  remember(cache,jobReadKey('circle-b',digestB),{result:'new'});
  assert.ok(f.removals()>first,'failed bytes still count on subsequent eviction');
  assert.equal(readFileSync(f.metadata,'utf8'),metadata);
});

test('unchanged payloads keep conservative disk savedAt; refusal/fallback policy unchanged',t=>{
  const f=savedFixture(t),key=jobReadKey('circle-a',digestA);
  const cache=f.open();remember(cache,key,{result:'same'});const first=cache.recall(key).savedAt;
  f.time(5000);remember(cache,key,{result:'same'});assert.notEqual(cache.recall(key).savedAt,first);
  assert.equal(f.open().recall(key).savedAt,first);
  assert.equal(hostUnreachable({status:403}),false);assert.equal(hostUnreachable({status:404}),false);
  assert.equal(hostUnreachable({status:429}),false);assert.equal(savedReasonFor({status:429}),'busy');
  assert.equal(hostUnreachable({status:503}),true);
});

for(const code of ['EIO','ENOSPC','after']) test('startup metadata '+code+' refuses preflight without retrying initialization',t=>{
  const f=savedFixture(t);f.fail(code);
  const cache=f.open(),writes=f.writes(),key=jobReadKey('circle-a',digestA);
  const online={result:'fresh online response'};
  assert.doesNotThrow(()=>cache.remember(key,online));
  assert.deepEqual(online,{result:'fresh online response'});
  assert.equal(cache.recall(key),null);
  assert.throws(()=>cache.beginInvalidation({kind:'job',digest:digestA}),{code:'saved_reads_unavailable'});
  assert.equal(f.writes(),writes);
  f.fail(null);
  assert.equal(cache.reloadInvalidations(),code==='after');
  if(code==='after'){remember(cache,key,online);assert.deepEqual(cache.recall(key).value,online);}
});

test('ambiguous cancel restores only prior copies after explicit validated reload',t=>{
  const f=savedFixture(t),key=jobReadKey('circle-a',digestA),cache=f.open();
  remember(cache,key,{result:'prior'});const prior=cache.recall(key),old=cache.ticket(key);
  const id=cache.beginInvalidation({kind:'circle',circle:'circle-a'});
  f.fail('after');assert.throws(()=>cache.cancelInvalidation(id),{code:'saved_reads_unavailable'});
  assert.equal(cache.recall(key),null);const writes=f.writes();
  assert.throws(()=>cache.commitInvalidation(id),{code:'saved_reads_unavailable'});
  assert.equal(f.writes(),writes);
  f.fail(null);assert.equal(cache.reloadInvalidations(),true);
  assert.deepEqual(cache.recall(key),prior);
  cache.remember(key,{result:'old'},old);assert.deepEqual(cache.recall(key),prior);
});

test('metadata validation rejects impossible generations and duplicate canonical keys without repair',t=>{
  const f=savedFixture(t),cache=f.open(),key=jobReadKey('circle-a',digestA);
  remember(cache,key,{result:'prior'});
  const original=readFileSync(f.metadata,'utf8');
  for(const text of [
    original.replace('"revision":0','"revision":0,"revision":0'),
    JSON.stringify({...JSON.parse(original),jobs:[{digest:digestA,generation:5,deleted:true}]}),
    JSON.stringify({...JSON.parse(original),extra:'unknown'}),
  ]){
    writeFileSync(f.metadata,text);
    const reopened=f.open();
    assert.equal(reopened.recall(key),null);
    assert.throws(()=>reopened.forgetCircle('circle-a'),{code:'saved_reads_unavailable'});
    assert.equal(readFileSync(f.metadata,'utf8'),text);
  }
  writeFileSync(f.metadata,original);
  const reopened=f.open();
  assert.equal(reopened.recall(key).value.result,'prior');
  const writes=f.writes();
  assert.throws(()=>reopened.beginInvalidation({kind:'job',digest:digestA,extra:true}),{code:'invalid_saved_read_invalidation'});
  assert.throws(()=>reopened.commitInvalidation('not-a-token'),{code:'invalid_saved_read_invalidation'});
  assert.equal(f.writes(),writes);
});

test('begin acknowledges durable pending intent and commit persists deletion before removal',t=>{
  const f=savedFixture(t),key=jobReadKey('circle-a',digestA);
  let removals=0;
  const cache=f.open({remove:(...args)=>{
    const authority=JSON.parse(readFileSync(f.metadata,'utf8'));
    assert.equal(authority.jobs.find(row=>row.digest===digestA).deleted,true);
    assert.deepEqual(authority.pending,[]);
    removals++;
    throw Object.assign(new Error('retained physical bytes'),{code:'EACCES'});
  }});
  remember(cache,key,{result:'prior'});
  const id=cache.beginInvalidation({kind:'job',digest:digestA});
  assert.deepEqual(JSON.parse(readFileSync(f.metadata,'utf8')).pending.map(row=>row.id),[id]);
  assert.equal(removals,0,'no physical deletion while remote outcome is pending');
  cache.commitInvalidation(id);
  assert.ok(removals>0);
  assert.ok(payloads(f.directory).length>0);
  assert.equal(f.open().recall(key),null);
});
