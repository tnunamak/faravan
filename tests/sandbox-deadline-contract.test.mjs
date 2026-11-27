import './helpers/no-browser.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import childProcess from 'node:child_process';import {EventEmitter} from 'node:events';import {createHash} from 'node:crypto';import {syncBuiltinESMExports} from 'node:module';
import {createSandboxDeadlineManager,runDeadlineCommand,deadlineSupervisorPayload,deadlineBinding,SANDBOX_GUARD_BUILD_ID} from '../lib/sandbox-deadline.mjs';
const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
test('independent registration precedes create transport dispatch',()=>{
 const prepare=source.slice(source.indexOf('  async _prepare('),source.indexOf('  async assertActive('));
 assert.ok(prepare.indexOf('this.sandboxDeadlines.register(')<prepare.indexOf('runResult = await'),'create must never precede independent protection');
});
test('rejected canonical bus does not retain an inherited route',async t=>{
 const saved={XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS};let dispatched=false;
 process.env.XDG_RUNTIME_DIR='/unverified';process.env.DBUS_SESSION_BUS_ADDRESS='unix:path=/unverified/bus';
 const lstat=fs.lstatSync;t.mock.method(fs,'lstatSync',(file,...args)=>String(file).startsWith('/run/user/')?{uid:-1,isSocket:()=>true,isSymbolicLink:()=>false}:lstat(file,...args));
 t.mock.method(childProcess,'execFile',(_c,_a,_o,done)=>{dispatched=true;done(null,'','');return new EventEmitter();});syncBuiltinESMExports();
 try{await runDeadlineCommand('systemctl',['--user','show']);assert.equal(dispatched,false);}finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}t.mock.restoreAll();syncBuiltinESMExports();}
});
test('a published guard is reused after its parent dies before the journal update',async()=>{
 let count=0,state;const row={sandbox_id:'dl-0123456789abcdef',sbx_home:'/fake/home',deadline_at:70000};
 const options={binary:'/fake/sbx',platform:'darwin',now:()=>10000,stateReader:()=>state,processStart:async()=> 'boot:1',spawnGuard:(_binary,args)=>{
  count++;const payload=JSON.parse(args[1]),child=new EventEmitter();Object.assign(child,{pid:12345,kill(){},disconnect(){},unref(){}});
  state={build_id:SANDBOX_GUARD_BUILD_ID,binding:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),pid:12345,start:'boot:1',state:'armed'};
  queueMicrotask(()=>child.emit('message',{ready:true}));return child;
 }};
 await createSandboxDeadlineManager(options).register(row);await createSandboxDeadlineManager(options).register(row);assert.equal(count,1);
});
test('an action acknowledgement binds the immutable clock, not only an active name',async()=>{
 let argv;const row={sandbox_id:'dl-0123456789abcdef',sbx_home:'/fake/home',deadline_at:70000,deadline_clock:{version:1,boot_id:'boot',boot_at:64000}};
 const manager=createSandboxDeadlineManager({binary:'/fake/sbx',platform:'linux',readyTimeoutMs:1,clock:()=>({wall:10000,boot_id:'boot',boot_ms:4000}),run:async(command,args)=>{if(command==='systemd-run')argv=args.slice(args.indexOf('--')+1);return {code:command==='systemctl'&&!args.includes('is-active')?0:1,stdout:''};}});
 await manager.register(row).catch(()=>{});
 assert.ok(argv);const payload=JSON.parse(argv.at(-1));assert.equal(payload.deadline_at,row.deadline_at);assert.deepEqual(payload.deadline_clock,row.deadline_clock);
});
test('the two-minute reserve has an explicit cleanup reason and completion limit',()=>{
 const status=fs.readFileSync(new URL('../docs/STATUS.md',import.meta.url),'utf8');
 assert.match(status,/two.minute[\s\S]{0,180}(?:output|cleanup)/i);assert.match(status,/(?:verified|verification|completion)[\s\S]{0,150}(?:deadline|removal|service)/i);
});

for(const changed of ['deadline','target','state-binding'])test('active service refuses altered '+changed,async()=>{
 const row={sandbox_id:'dl-0123456789abcdef',sbx_home:'/fake/home',deadline_at:70000,deadline_clock:{version:1,boot_id:'boot',boot_at:64000}},payload=deadlineSupervisorPayload(row,'/fake/sbx');
 const actual=structuredClone(payload);if(changed==='deadline')actual.deadline_clock.boot_at+=1000;if(changed==='target')actual.sandbox_id='dl-fedcba9876543210';
 const argv=['/usr/bin/env','-i','HOME='+row.sbx_home,process.execPath,new URL('../lib/sandbox-deadline-supervisor.mjs',import.meta.url).pathname,JSON.stringify(actual)];
 const manager=createSandboxDeadlineManager({binary:'/fake/sbx',platform:'linux',clock:()=>({wall:10000,boot_id:'boot',boot_ms:4000}),stateReader:()=>({build_id:SANDBOX_GUARD_BUILD_ID,binding:changed==='state-binding'?'wrong':deadlineBinding(payload),state:'armed',pid:12345,start:'start'}),processStart:async()=> 'start',run:async(command,args)=>({code:0,stdout:command==='busctl'?JSON.stringify({data:args.includes('GetUnit')?['/org/freedesktop/systemd1/unit/fixture']:[[argv[0],argv,false,0,0,0,0,0,0,0]]}):''})});
 assert.equal(await manager.active(row),false);
});
test('a service publication cannot bypass its unit proof as a fallback guard',async()=>{
 const row={sandbox_id:'dl-0123456789abcdef',sbx_home:'/fake/home',deadline_at:70000},payload=deadlineSupervisorPayload(row,'/fake/sbx'),calls=[];
 const argv=['/usr/bin/env','-i','HOME='+row.sbx_home,process.execPath,new URL('../lib/sandbox-deadline-supervisor.mjs',import.meta.url).pathname,JSON.stringify(payload)];
 const manager=createSandboxDeadlineManager({binary:'/fake/sbx',platform:'linux',now:()=>10000,processStart:async()=> 'start',stateReader:()=>({build_id:SANDBOX_GUARD_BUILD_ID,binding:deadlineBinding(payload),state:'armed',pid:12345,start:'start'}),run:async(command,args)=>{calls.push([command,...args]);return {code:0,stdout:command==='busctl'?JSON.stringify({data:args.includes('GetUnit')?['/org/freedesktop/systemd1/unit/fixture']:[[argv[0],argv,false,0,0,0,0,0,0,0]]}):''};}});
 assert.equal((await manager.register(row)).kind,'systemd');assert.ok(calls.some(args=>args.includes('ExecStart')));
});
test('lost IPC acknowledgement leaves a durably published supervisor running',async()=>{
 let state,killed=false;const manager=createSandboxDeadlineManager({binary:'/fake/sbx',platform:'darwin',now:()=>10000,readyTimeoutMs:5,stateReader:()=>state,processStart:async()=> 'start',processStartSync:()=> 'start',spawnGuard:(_bin,args)=>{
  const payload=JSON.parse(args[1]),child=new EventEmitter();Object.assign(child,{pid:12345,kill(){killed=true;},unref(){},disconnect(){}});
  state={build_id:SANDBOX_GUARD_BUILD_ID,binding:deadlineBinding(payload),state:'armed',pid:12345,start:'start'};return child;
 }});
 await assert.rejects(manager.register({sandbox_id:'dl-0123456789abcdef',sbx_home:'/fake/home',deadline_at:70000}),/ready/);assert.equal(killed,false);
});
test('a null process identity never authorizes synchronous dispatch',()=>{
 const row={sandbox_id:'dl-0123456789abcdef',sbx_home:'/fake/home',deadline_at:70000},payload=deadlineSupervisorPayload(row,'/fake/sbx');
 const manager=createSandboxDeadlineManager({binary:'/fake/sbx',stateReader:()=>({build_id:SANDBOX_GUARD_BUILD_ID,binding:deadlineBinding(payload),state:'armed',start:null}),processStartSync:()=>null});
 assert.equal(manager.activeSync(row),false);
});
test('an active service with a dead publication PID is not acknowledged',async()=>{
 const row={sandbox_id:'dl-0123456789abcdef',sbx_home:'/fake/home',deadline_at:70000},payload=deadlineSupervisorPayload(row,'/fake/sbx');
 const argv=['/usr/bin/env','-i','HOME='+row.sbx_home,process.execPath,new URL('../lib/sandbox-deadline-supervisor.mjs',import.meta.url).pathname,JSON.stringify(payload)];
 const manager=createSandboxDeadlineManager({binary:'/fake/sbx',platform:'linux',processStart:async()=>null,stateReader:()=>({build_id:SANDBOX_GUARD_BUILD_ID,binding:deadlineBinding(payload),state:'armed',pid:12345,start:'old'}),run:async(command,args)=>({code:0,stdout:command==='busctl'?JSON.stringify({data:args.includes('GetUnit')?['/org/freedesktop/systemd1/unit/fixture']:[[argv[0],argv,false,0,0,0,0,0,0,0]]}):''})});
 assert.equal(await manager.active(row),false);
});
