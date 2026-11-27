import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,lstatSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createConsent} from '../../../lib/v1/telemetry/consent.mjs';
import {envSwitch,clientHeaders,scopeOf,forwardedHeaders,OFF_HEADER,SURFACE_HEADER} from '../../../lib/v1/telemetry/switch.mjs';

function fixture(t,{uploadable=true,env={}}={}){
  const parent=join(homedir(),'.tmp');mkdirSync(parent,{recursive:true,mode:0o700});
  const stat=lstatSync(parent);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());
  assert.equal(stat.mode&0o777,0o700);if(process.getuid)assert.equal(stat.uid,process.getuid());
  const base=mkdtempSync(join(parent,'consent-slice-')),dir=join(base,'telemetry');
  mkdirSync(dir,{mode:0o700});t.after(()=>rmSync(base,{recursive:true,force:true}));
  let at=1800000000000;
  const options={base,dir,uploadable,env,now:()=>at,bytes:size=>Buffer.alloc(size,7)};
  return {dir,options,open:over=>createConsent({...options,...over}),tick:()=>{at+=1000;},
    read:()=>JSON.parse(readFileSync(join(dir,'policy.json'),'utf8')),
    write:value=>writeFileSync(join(dir,'policy.json'),typeof value==='string'?value:JSON.stringify(value),{mode:0o600})};
}
function noDispatch(consent,generation){
  let calls=0;assert.equal(consent.dispatch(generation,'counts',()=>{calls++;}),null);assert.equal(calls,0);
}

test('fresh uploadable install requires notice; restart and repeated notice preserve policy generation',t=>{
  const f=fixture(t),first=f.open(),stale=f.open();
  assert.equal(first.current().effective,'off');assert.equal(first.current().reason.kind,'notice_pending');
  noDispatch(first,first.current().generation);
  const transition=first.markNoticeShown();assert.equal(transition.after.effective,'on');
  const policy=f.read(),generation=transition.after.generation;
  f.tick();first.markNoticeShown();assert.deepEqual(f.read(),policy);
  // This factory predates the notice: idempotence must consult disk, not its cached policy.
  stale.markNoticeShown();assert.deepEqual(f.read(),policy);
  const restarted=f.open();assert.equal(restarted.current().effective,'on');
  assert.equal(restarted.current().generation,generation);
  let sent=0;const reply=restarted.dispatch(generation,'counts',()=>{sent++;return 'synthetic-response';});
  assert.equal(sent,1);assert.equal(reply.response,'synthetic-response');
});

test('saved OFF survives a late stale notice, restart, reset and interrupted purge',t=>{
  const f=fixture(t),noticeFactory=f.open(),writer=f.open();
  writer.markNoticeShown();const oldGeneration=writer.current().generation,oldPolicy=f.read();
  writer.restrict();assert.equal(writer.purgePending(),true);
  noDispatch(noticeFactory,oldGeneration);
  // Synthetic interrupted policy write: durable purge marker is the source of OFF intent.
  f.write(oldPolicy);
  const restart=f.open();assert.equal(restart.current().reason.kind,'purge_pending');
  noDispatch(restart,oldGeneration);noDispatch(noticeFactory,oldGeneration);
  const before=f.read();noticeFactory.markNoticeShown();assert.deepEqual(f.read(),before);
  restart.completePurge();assert.equal(restart.current().effective,'off');
  assert.equal(restart.current().level,'off');assert.equal(restart.purgePending(),false);
  noticeFactory.refresh();noticeFactory.markNoticeShown();noDispatch(noticeFactory,oldGeneration);
  restart.resetIdentity();const reset=f.open();
  assert.equal(reset.current().level,'off');assert.equal(reset.current().effective,'off');
  noDispatch(reset,reset.current().generation);
});

for(const legacyLevel of [null,'on','counts','diagnostics','off']){
  test('legacy '+String(legacyLevel)+' migrates through purge and renewed notice without reviving OFF',t=>{
    const f=fixture(t);
    f.write({version:1,level:legacyLevel,region:'US',noticeShownAt:1700000000000,decidedAt:null,generation:4});
    const migrated=f.open();assert.equal(migrated.purgePending(),true);
    assert.equal(migrated.current().effective,'off');noDispatch(migrated,4);
    assert.equal(f.read().generation,5);assert.equal(f.read().noticeShownAt,null);
    assert.equal(f.read().level,legacyLevel==='off'?'off':legacyLevel===null?null:'on');
    migrated.completePurge();const ready=f.open();
    assert.equal(ready.current().effective,'off');
    ready.markNoticeShown();
    assert.equal(ready.current().effective,legacyLevel==='off'?'off':'on');
    const restarted=f.open();assert.equal(restarted.current().effective,legacyLevel==='off'?'off':'on');
  });
}

test('corrupt policy and unavailable upload destination fail closed without recording notice',t=>{
  const f=fixture(t);f.write('{broken fixture');
  const corrupt=f.open();assert.equal(corrupt.current().reason.kind,'policy_unreadable');
  corrupt.markNoticeShown();noDispatch(corrupt,0);assert.equal(readFileSync(join(f.dir,'policy.json'),'utf8'),'{broken fixture');
  rmSync(join(f.dir,'policy.json'));
  const unavailable=f.open({uploadable:false});unavailable.markNoticeShown();
  assert.equal(unavailable.current().effective,'off');assert.equal(unavailable.current().noticeShown,false);
  noDispatch(unavailable,0);
  const release=f.open();assert.equal(release.current().reason.kind,'notice_pending');
  release.markNoticeShown();assert.equal(release.current().effective,'on');
});

test('environment restrictions never change durable saved policy and allowed callback cannot bypass OFF',t=>{
  const f=fixture(t),enabled=f.open();enabled.markNoticeShown();const saved=f.read();
  for(const env of [{DO_NOT_TRACK:'1'},{FARAVAN_NO_TELEMETRY:'yes'}]){
    const restricted=f.open({env});assert.equal(restricted.current().effective,'off');
    assert.equal(restricted.current().reason.kind,'env');noDispatch(restricted,saved.generation);
  }
  assert.deepEqual(f.read(),saved);
  let calls=0;assert.equal(enabled.dispatch(saved.generation,'counts',()=>++calls,()=>false),null);assert.equal(calls,0);
  assert.equal(enabled.dispatch(saved.generation,'unknown-stream',()=>++calls),null);assert.equal(calls,0);
});

test('rejected injected send followed by opt-out and retry cannot authorize stale generations',async t=>{
  const f=fixture(t),sender=f.open(),other=f.open();sender.markNoticeShown();
  const generation=sender.current().generation;let calls=0;
  const dispatched=sender.dispatch(generation,'counts',()=>{calls++;return Promise.reject(new Error('injected send failure'));});
  await assert.rejects(dispatched.response,/injected send failure/);assert.equal(calls,1);
  other.restrict();noDispatch(sender,generation);other.completePurge();noDispatch(sender,generation);
  other.choose({level:'on'});assert.ok(other.current().generation>generation);noDispatch(sender,generation);
  const current=other.current().generation;
  assert.equal(sender.dispatch(current,'counts',()=>{calls++;return 'retry';}).response,'retry');
  assert.equal(calls,2);
});

test('switch and GPC forwarding emits only public allow-listed restriction headers',()=>{
  assert.equal(envSwitch({DO_NOT_TRACK:' false '}),null);
  assert.equal(envSwitch({DO_NOT_TRACK:' 1 '}),'DO_NOT_TRACK');
  assert.equal(envSwitch({FARAVAN_NO_TELEMETRY:'yes'}),'FARAVAN_NO_TELEMETRY');
  assert.deepEqual(clientHeaders({DO_NOT_TRACK:'1'},'cli'),{[SURFACE_HEADER]:'cli',[OFF_HEADER]:'off'});
  assert.deepEqual(scopeOf({'sec-gpc':'1'}),{off:true});
  assert.deepEqual(scopeOf({'sec-gpc':'0'}),{off:false});
  assert.deepEqual(forwardedHeaders({[SURFACE_HEADER]:'mcp','sec-gpc':'1',authorization:'synthetic-do-not-forward',cookie:'synthetic',extra:'x'}),
    {[SURFACE_HEADER]:'mcp',[OFF_HEADER]:'off'});
  assert.deepEqual(forwardedHeaders({[OFF_HEADER]:'off','sec-gpc':'0'}),{[OFF_HEADER]:'off'});
  assert.deepEqual(forwardedHeaders({[SURFACE_HEADER]:42,authorization:'synthetic'}),{});
});
