import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,lstatSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createTelemetry} from '../../lib/v1/telemetry/index.mjs';
import {createConsent} from '../../lib/v1/telemetry/consent.mjs';

function fixture(t) {
  const parent=join(homedir(),'.tmp');mkdirSync(parent,{recursive:true,mode:0o700});
  const stat=lstatSync(parent);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());
  assert.equal(stat.mode&0o777,0o700);if(process.getuid)assert.equal(stat.uid,process.getuid());
  const base=mkdtempSync(join(parent,'notice-capture-')),dir=join(base,'telemetry'),instances=[];
  let at=1800000000000,n=0,forbiddenCalls=0;
  const forbidden=()=>{forbiddenCalls++;throw new Error('transport/timer forbidden');};
  const options={base,dir,env:{},version:'1.2.3',enabled:true,now:()=>at,bytes:size=>Buffer.alloc(size,++n%250+1),random:()=>0,
    transport:forbidden,setTimer:forbidden,remoteFactory:()=>({allowed:()=>true,poll:async()=>{},reset:()=>{},cancel:()=>{}})};
  const open=()=>{const api=createTelemetry(options);instances.push(api);assert.equal(api.status().uploadable,true);return api;};
  t.after(async()=>{try{for(const api of instances)await api.close();assert.equal(forbiddenCalls,0);}finally{rmSync(base,{recursive:true,force:true});}});
  return {options,dir,open,advance:()=>{at+=10;}};
}
const facts=api=>api.preview().items.filter(x=>x.state==='queued').map(x=>JSON.parse(x.body)).filter(x=>x.name==='ui_presence_changed');
function contains(root,needle) {
  return readdirSync(root,{withFileTypes:true}).some(entry=>{
    const p=join(root,entry.name);assert.ok(!entry.isSymbolicLink());
    return entry.isDirectory()?contains(p,needle):entry.isFile()&&readFileSync(p).includes(Buffer.from(needle));
  });
}
test('stale notice preserves accepted memory, durable generation and queued facts',async t=>{
  const f=fixture(t),first=f.open(),stale=f.open();
  const direct=createConsent({...f.options,uploadable:true});
  assert.equal(first.observeFact('ui_presence_changed',{visible:true}),false);
  await first.markNoticeShown();
  const generation=first.status().generation;
  assert.equal(first.observeFact('ui_presence_changed',{visible:true}),true);
  f.advance();direct.markNoticeShown();
  await stale.markNoticeShown();
  assert.equal(first.status().generation,generation);
  first.tick();
  assert.equal(facts(first).length,1);
  assert.ok(contains(join(f.dir,'outbox'),'"visible":true'));
  const restarted=f.open();
  assert.equal(restarted.status().generation,generation);
  assert.equal(facts(restarted).length,1);
});
test('pending OFF outranks delayed notice and stale capture across restart',async t=>{
  const f=fixture(t),first=f.open(),stale=f.open();
  const delayed=createConsent({...f.options,uploadable:true});
  await first.markNoticeShown();
  assert.equal(first.observeFact('ui_presence_changed',{visible:true}),true);first.tick();
  assert.equal(first.observeFact('ui_presence_changed',{browser_online:true}),true);
  const authority=createConsent({...f.options,uploadable:true});
  authority.restrict();const generation=authority.current().generation;
  assert.equal(authority.purgePending(),true);
  assert.doesNotThrow(()=>delayed.markNoticeShown());
  delayed.refresh();assert.equal(delayed.current().generation,generation);
  assert.equal(delayed.current().effective,'off');
  await stale.markNoticeShown();
  first.tick();
  const restarted=f.open();
  assert.equal(restarted.status().effective,'off');
  assert.equal(restarted.status().generation,generation);
  assert.deepEqual(restarted.preview().items,[]);
  assert.equal(contains(join(f.dir,'outbox'),'"visible":true'),false);
  assert.equal(contains(join(f.dir,'outbox'),'"browser_online":true'),false);
  await restarted.choose({level:'on'});
  assert.ok(restarted.status().generation>generation);
  first.tick();
  assert.deepEqual(restarted.preview().items,[]);
  assert.equal(restarted.observeFact('ui_presence_changed',{visible:false}),true);
  restarted.tick();assert.deepEqual(facts(restarted).map(x=>x.properties),[{visible:false}]);
});
