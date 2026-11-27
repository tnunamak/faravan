import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {syncBuiltinESMExports} from 'node:module';
import {createSandboxDeadlineManager,sandboxDeadlineUnit,runDeadlineCommand,deadlineProcessStart} from '../lib/sandbox-deadline.mjs';
import {superviseSandboxDeadline} from '../lib/sandbox-deadline-supervisor.mjs';
import {serviceProof,serviceState} from './helpers/deadline-service-model.mjs';

const row=()=>({_cleanupId:'11111111-1111-4111-8111-111111111111',sandbox_id:'wf-0123456789abcdef',sbx_home:'/sandbox home',
  deadline_at:70_000,deadline_clock:{version:1,boot_id:'boot',boot_at:64_000}});
const ok={code:0,stdout:'',stderr:''};
function manager(options={}) {
  const calls=[];let armed=false,time=10_000,boot=4000,requested=row();
  const binary='/opt/sbx with spaces';
  const run=async(command,args)=>{
    calls.push({command,args});
    if(command==='systemd-run'){const payload=JSON.parse(args.at(-1));requested={...row(),deadline_at:payload.deadline_at,deadline_clock:payload.deadline_clock};armed=true;return {...ok,code:options.armCode??0};}
    if(command==='systemctl') {
      if(args.includes('stop')){armed=false;return ok;}
      if(args.includes('is-active'))return {...ok,code:armed?0:1};
      if(options.slowProbe){time=80_000;boot=74_000;}
      return ok;
    }
    if(command==='busctl') {
      if(!armed)return {...ok,code:1};
      if(args.includes('GetUnit'))return {...ok,stdout:JSON.stringify({type:'o',data:['/org/freedesktop/systemd1/unit/deadline_2eservice']})};
      return serviceProof(args,{...requested,...(options.wrongTarget?{sandbox_id:'wf-fedcba9876543210'}:{}),...(options.wrongHome?{sbx_home:'/other home'}:{})},binary);
    }
    throw Error('Unexpected deadline control command');
  };
  return {calls,run,arm:()=>{armed=true;},setTime:(value,bootValue=boot)=>{time=value;boot=bootValue;},
    manager:createSandboxDeadlineManager({binary,platform:'linux',run,stateReader:()=>armed?serviceState(requested,binary):null,readyTimeoutMs:1,now:()=>time,
      clock:()=>({wall:time,boot_id:'boot',boot_ms:boot})})};
}

test('registration verifies exact service argv and HOME before acknowledging',async()=>{
  const {manager:m,calls}=manager();const r=row(),saved=await m.register(r);
  assert.ok(calls.some(call=>call.command==='busctl'&&call.args.at(-1)==='ExecStart'));
  assert.ok(calls.some(call=>call.command==='busctl'&&call.args.at(-1)==='ExecStart'));
  assert.match(saved.unit,/111111111111/,'unit names include the durable incarnation');
  const args=calls.find(call=>call.command==='systemd-run').args;
  assert.ok(args.includes('--expand-environment=no'));
  assert.equal(args.some(arg=>arg.startsWith('--on-active=')),false);
  const payload=JSON.parse(args.at(-1));assert.equal(payload.binary,'/opt/sbx with spaces');assert.equal(payload.sandbox_id,r.sandbox_id);assert.deepEqual(payload.deadline_clock,r.deadline_clock);
  assert.deepEqual(args.filter(arg=>arg.startsWith('--setenv=')),['--setenv=HOME=/sandbox home']);
});

for(const problem of ['wrongTarget','wrongHome'])test(problem+' cannot authorize execution or recovery',async()=>{
  const {manager:m,arm}=manager({[problem]:true});
  await assert.rejects(m.register(row()),/registered|verified/i);
  arm();assert.equal(await m.active({...row(),deadline_enforcer:{kind:'systemd',unit:sandboxDeadlineUnit(row()),binary:'/opt/sbx with spaces'}}),false);
});

test('a timed-out control call queries the same accepted action instead of duplicating it',async()=>{
  const {manager:m,calls}=manager({armCode:1});
  const saved=await m.register(row());
  assert.equal(saved.kind,'systemd');
  assert.equal(calls.filter(call=>call.command==='systemd-run').length,1);
  assert.equal(calls.some(call=>call.command==='systemctl'&&call.args.includes('stop')),false);
});

test('a registration delay crossing the deadline never dispatches a fresh timer',async()=>{
  const {manager:m,calls}=manager({slowProbe:true});
  await assert.rejects(m.register(row()),/deadline/i);
  assert.equal(calls.some(call=>call.command==='systemd-run'),false);
});

test('only recovery can restore an already overdue removal obligation',async()=>{
  const {manager:m,calls,setTime}=manager();setTime(80_000,74_000);
  await assert.rejects(m.register(row()),/deadline/i);
  const saved=await m.register(row(),{recovery:true});
  assert.equal(saved.kind,'systemd');
  assert.equal(await m.active({...row(),deadline_enforcer:saved}),true);
  assert.equal(JSON.parse(calls.find(call=>call.command==='systemd-run').args.at(-1)).deadline_at,70_000);
});

test('a stopped supervisor observation is bound to its exact cleanup target',async()=>{
  const r={...row(),deadline_enforcer:{kind:'systemd',unit:sandboxDeadlineUnit(row()),binary:'/fake/sbx'}};
  const state={...serviceState(r,'/fake/sbx'),state:'removed',observed:true};
  const m=createSandboxDeadlineManager({binary:'/fake/sbx',platform:'linux',stateReader:()=>state,processStartSync:()=>null});
  assert.equal(typeof m.observed,'function');
  assert.equal(m.observed(r),true,'a dead supervisor can leave durable evidence');
  assert.equal(m.activeSync(r),false,'an observation grants no execution authority');
  for(const changed of [{sandbox_id:'wf-fedcba9876543210'},{sbx_home:'/other'},{deadline_at:70001},{_cleanupId:'22222222-2222-4222-8222-222222222222'},
    {deadline_clock:{...r.deadline_clock,boot_id:'other-boot'}},{deadline_enforcer:{...r.deadline_enforcer,binary:'/other/sbx'}}])
    assert.equal(m.observed({...r,...changed}),false,'a different target cannot reuse the observation');
  state.observed=false;assert.equal(m.observed(r),false);
  assert.equal(m.observed({...r,deadline_at:undefined}),false,'older records without a deadline gain no observation authority');
});

test('wall rollback cannot renew the original boot-time bound',async()=>{
  const {manager:m,calls,setTime}=manager();setTime(5000);
  await m.register({...row(),deadline_clock:{version:1,boot_id:'boot',boot_at:14_000}});
  assert.equal(JSON.parse(calls.find(call=>call.command==='systemd-run').args.at(-1)).deadline_clock.boot_at,14_000);
});

test('a timer catches up after suspend and unloads after its final firing',async()=>{
  const {manager:m,calls}=manager();await m.register(row());
  const args=calls.find(call=>call.command==='systemd-run').args;
  assert.equal(args.some(arg=>arg.startsWith('--on-')),false);assert.equal(JSON.parse(args.at(-1)).deadline_clock.boot_at,64_000);
});

test('guard exit before acknowledgement never becomes successful registration',async()=>{
  const child=new EventEmitter();let killed=false;
  Object.assign(child,{pid:12345,kill:()=>{killed=true;},disconnect:()=>{},connected:true});
  const m=createSandboxDeadlineManager({binary:'/opt/sbx',platform:'darwin',now:()=>10_000,
    clock:()=>({wall:10_000,boot_id:'boot',boot_ms:4000}),
    spawnGuard:()=>{queueMicrotask(()=>child.emit('exit',1));return child;}});
  await assert.rejects(m.register(row()),/exited/);assert.equal(killed,true);
});

test('the supervisor uses the boot bound after wall rollback and suspend',{timeout:5000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deadline-rollback-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const record={...row(),sbx_home:root,owner_scope:sandboxOwnerScope(),
    create:'dispatched',compute_created:true,create_settled:true};
  // Trusted startup authority is captured before any read or command can wait.
  const originalRecord=structuredClone(record),commands=[];
  await superviseSandboxDeadline({...record,binary:'/fake/sbx'},{originalRecord,
    clock:()=>({wall:-10000,boot_id:'boot',boot_ms:74000}),readRecord:()=>structuredClone(record),
    pause:async()=>{throw Error('expired settled fixture must finish without a retry');},
    run:async args=>{commands.push(args);return {code:0,stdout:'[]'};}});
  assert.deepEqual(originalRecord,record,'command completion cannot replace startup authority');
  assert.deepEqual(commands,[['ls','--json'],['rm','--force',row().sandbox_id],['ls','--json']]);
});

// A guard process of this directory, as an older version left it: the manager reads its identity and adopts it. It is never signalled.
const olderGuard=({boot='boot',start='same-start'}={})=>{
  const target={...row(),deadline_enforcer:{kind:'guard',pid:12345,start:'same-start',binary:'/fake/sbx'}};
  const payload={sandbox_id:target.sandbox_id,sbx_home:target.sbx_home,binary:'/fake/sbx',launchMode:'guard',deadline_at:target.deadline_at,
    recordPath:'/fixture/journal/id.json',statusPath:'/fixture/journal/id.json.deadline'};
  const m=createSandboxDeadlineManager({directory:'/fixture/journal',platform:'hermetic',processStart:async()=>start,processStartSync:()=>start,clock:()=>({wall:10_000,boot_id:boot,boot_ms:4000}),
    listProcesses:async()=>[{pid:12345,payload}],stateReader:()=>({pid:12345,start,binding:'x',state:'armed'}),kill:()=>{throw Error('A guard is never signalled.');}});
  return {target,m};
};
test('recovery never signals a PID, whether or not the app holds its child-process handle',async t=>{
  const signals=[];t.mock.method(process,'kill',(...args)=>signals.push(args));
  const {target,m}=olderGuard();
  const report=await m.reconcileGuards({directory:'/fixture/journal',rowFor:()=>target});
  assert.deepEqual(signals,[]);assert.equal(report.adopted.length,1);
});

test('manager control commands do not inherit provider environment values',async t=>{
  let captured;const prior=process.env.FARAVAN_FAKE_DEADLINE_SECRET;
  process.env.FARAVAN_FAKE_DEADLINE_SECRET='TEST-ONLY-do-not-forward';
  t.mock.method(childProcess,'execFile',(_binary,_args,options,done)=>{captured=options.env;queueMicrotask(()=>done(null,'',''));return new EventEmitter();});
  syncBuiltinESMExports();
  try {
    const lstat=fs.lstatSync;t.mock.method(fs,'lstatSync',file=>({uid:process.getuid(),isDirectory:()=>true,isSocket:()=>true,isSymbolicLink:()=>false}));
    await runDeadlineCommand('/fake/control',[]);
    assert.equal(JSON.stringify(captured).includes('TEST-ONLY-do-not-forward'),false);
    assert.ok(Object.keys(captured).every(key=>['HOME','PATH','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'].includes(key)));
  }finally{if(prior===undefined)delete process.env.FARAVAN_FAKE_DEADLINE_SECRET;else process.env.FARAVAN_FAKE_DEADLINE_SECRET=prior;t.mock.restoreAll();syncBuiltinESMExports();}
});

for(const socket of ['owned','foreign','symlink'])test('manager reconnects only through an '+socket+' user bus socket',{skip:process.platform!=='linux'},async t=>{
  let captured;const uid=process.getuid(),runtime='/run/user/'+uid;
  const saved=Object.fromEntries(['XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'].map(key=>[key,process.env[key]]));
  for(const key of Object.keys(saved))delete process.env[key];
  const lstat=fs.lstatSync;
  t.mock.method(fs,'lstatSync',(file,...args)=>String(file).startsWith('/run')?{
    isDirectory:()=>true,uid:socket==='foreign'?uid+1:uid,isSocket:()=>true,isSymbolicLink:()=>socket==='symlink'}:lstat(file,...args));
  t.mock.method(childProcess,'execFile',(_binary,_args,options,done)=>{captured=options.env;queueMicrotask(()=>done(null,'',''));return new EventEmitter();});
  syncBuiltinESMExports();
  try {
    await runDeadlineCommand('/fake/control',[]);
    if(socket!=='owned'){assert.equal(captured,undefined);return;}
    assert.equal(captured.XDG_RUNTIME_DIR,socket==='owned'?runtime:undefined);
    assert.equal(captured.DBUS_SESSION_BUS_ADDRESS,socket==='owned'?'unix:path='+runtime+'/bus':undefined);
  }finally{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}t.mock.restoreAll();syncBuiltinESMExports();}
});

test('a different boot never causes a guard signal even when PID/start text matches',async t=>{
  const signals=[];t.mock.method(process,'kill',(...args)=>signals.push(args));
  const {target,m}=olderGuard({boot:'new-boot'});
  await m.reconcileGuards({directory:'/fixture/journal',rowFor:()=>target});
  assert.deepEqual(signals,[]);
});

test('an unreadable Linux process-start field grants no guard identity',async t=>{
  const read=fs.readFileSync;
  t.mock.method(fs,'readFileSync',(file,...rest)=>String(file)==='/proc/12345/stat'?'12345 (guard) S 1 2':
    String(file)==='/proc/sys/kernel/random/boot_id'?'boot':read(file,...rest));
  assert.equal(await deadlineProcessStart(12345,{platform:'linux'}),null);
});
