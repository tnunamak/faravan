import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createSandboxDeadlineManager,deadlineProcessStart,sandboxDeadlineUnit,deadlineSupervisorPayload,deadlineBinding,SANDBOX_GUARD_BUILD_ID} from '../lib/sandbox-deadline.mjs';

const row=()=>({sandbox_id:'wf-0123456789abcdef',sbx_home:'/isolated/sbx',deadline_at:100_000});
const ok={code:0,stdout:'',stderr:''};
import {serviceProof,serviceState} from './helpers/deadline-service-model.mjs';

const proof=(args,r=row(),binary='/opt/sbx')=>serviceProof(args,r,binary);
test('systemd registers the exact target, remaining seconds and HOME only',async()=>{
  const calls=[];let armed=false;
  const manager=createSandboxDeadlineManager({binary:'/opt/sbx',platform:'linux',now:()=>40_000,stateReader:()=>serviceState(row(),'/opt/sbx'),readyTimeoutMs:1,
    run:async(binary,args)=>{calls.push({binary,args});if(binary==='systemd-run')armed=true;
      if(binary==='busctl')return proof(args);
      return {...ok,code:args.includes('is-active')&&!armed?1:0};}});
  const saved=await manager.register(row()),unit=sandboxDeadlineUnit(row());
  assert.equal(unit,'faravan-f0b272fc9426-deadline-wf-0123456789abcdef');
  const control=calls.find(call=>call.binary==='systemd-run').args;
  assert.ok(control.includes('--collect'));assert.ok(control.includes('--expand-environment=no'));
  assert.deepEqual(control.slice(control.indexOf('--')+1,control.indexOf('--')+4),['/usr/bin/env','-i','HOME='+row().sbx_home]);
  const payload=JSON.parse(control.at(-1));assert.equal(payload.deadline_at,100000);assert.equal(payload.binary,'/opt/sbx');assert.equal(payload.sandbox_id,row().sandbox_id);
  assert.deepEqual(saved,{kind:'systemd',unit,binary:'/opt/sbx'});
  assert.notEqual(sandboxDeadlineUnit({...row(),sbx_home:'/other/home'}),unit);
  assert.notEqual(sandboxDeadlineUnit({...row(),sandbox_id:'wf-fedcba9876543210'}),unit);
});

test('a failed systemd registration is refused, including cleanup of a partial registration',async()=>{
  const calls=[];
  const manager=createSandboxDeadlineManager({binary:'/opt/sbx',platform:'linux',now:()=>40_000,stateReader:()=>serviceState(row(),'/opt/sbx'),readyTimeoutMs:1,run:async(binary,args)=>{
    calls.push([binary,...args]);return {...ok,code:binary==='systemd-run'?1:0};
  },spawnGuard:()=>assert.fail('registration failure must not silently start another enforcer')});
  await assert.rejects(manager.register(row()),/could not be registered/);
  assert.equal(calls.at(-1)[2],'stop');
});

for(const platform of ['linux','darwin'])test(platform+' without a user manager uses a detached guard and saves PID/start',async()=>{
  const calls=[],child=new EventEmitter();let state;
  Object.assign(child,{pid:12345,kill:()=>calls.push('kill'),disconnect:()=>calls.push('disconnect'),unref:()=>calls.push('unref')});
  const manager=createSandboxDeadlineManager({binary:'/opt/sbx',platform,now:()=>40_000,stateReader:()=>state,run:async()=>({...ok,code:1}),processStart:async()=> 'boot:123',
    spawnGuard:(binary,args,options)=>{
      const payload=JSON.parse(args[1]);state={build_id:SANDBOX_GUARD_BUILD_ID,binding:deadlineBinding(payload),state:'armed',pid:12345,start:'boot:123'};
      calls.push({binary,args,options});queueMicrotask(()=>child.emit('message',{ready:true}));return child;
    }});
  const saved=await manager.register(row());
  assert.deepEqual(saved,{kind:'guard',pid:12345,start:'boot:123',binary:'/opt/sbx'});
  assert.equal(calls[0].binary,process.execPath);
  assert.equal(calls[0].options.detached,true);
  assert.deepEqual(calls[0].options.stdio,['ignore','ignore','ignore','ipc']);
  assert.deepEqual(calls[0].options.env,{HOME:row().sbx_home});
  assert.equal(JSON.parse(calls[0].args[1]).deadline_at,100000);assert.equal(JSON.parse(calls[0].args[1]).binary,'/opt/sbx');
  assert.equal(await manager.active({...row(),deadline_enforcer:saved}),true);
});

test('recovery detects a missing timer but preserves a running deadline service',async()=>{
  const calls=[],manager=createSandboxDeadlineManager({binary:'/opt/sbx',platform:'linux',stateReader:()=>serviceState(row(),'/opt/sbx'),run:async(binary,args)=>{
    calls.push(args);if(binary==='busctl')return proof(args);
    return {...ok,code:args.at(-1).endsWith('.service')?0:1};
  }});
  assert.equal(await manager.active(row()),true);
  assert.deepEqual(calls.filter(args=>args.includes('is-active')).map(args=>args.slice(0,3)),[['--user','is-active','--quiet']]);
});

test('invalid names, homes and deadlines never dispatch a process',async()=>{
  const manager=createSandboxDeadlineManager({binary:'/opt/sbx',run:()=>assert.fail('unsafe process dispatch')});
  for(const changed of [{sandbox_id:'wf-*'},{sandbox_id:'other'},{sbx_home:'relative'},{deadline_at:NaN}])
    await assert.rejects(manager.register({...row(),...changed}),/Invalid sandbox deadline/);
});

for(const removalMode of ['normal','first-fails','first-hangs','false-success'])test('detached guard stops a detached writer after its registering app is SIGKILLed: '+removalMode,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deadline-crash-'));
  const marker=path.join(root,'removed.json'),binary=path.join(root,'fake-sbx'),inventory=path.join(root,'inventory.json'),beats=path.join(root,'beats');
  const script=path.join(root,'parent.mjs'),module=process.env.DEADLINE_BASELINE_MODULE_URL??new URL('../lib/sandbox-deadline.mjs',import.meta.url).href;
  fs.writeFileSync(binary,`#!${process.execPath}
    import fs from 'node:fs';import {deadlineProcessStart} from ${JSON.stringify(module)};
    const file=${JSON.stringify(inventory)},record=JSON.parse(fs.readFileSync(file,'utf8'));
    if(process.argv[2]==='ls'){console.log(JSON.stringify(Array.isArray(record)?record:[{name:record.name}]));process.exit(0);}
    const mode=${JSON.stringify(removalMode)};
    const counterFile=${JSON.stringify(path.join(root,'calls'))},count=Number(fs.existsSync(counterFile)?fs.readFileSync(counterFile,'utf8'):0)+1;fs.writeFileSync(counterFile,String(count));
    if(count===1&&mode==='first-fails')process.exit(1);
    if(count===1&&mode==='false-success')process.exit(0);
    if(count===1&&mode==='first-hangs')await new Promise(()=>setInterval(()=>{},1000));
    if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['rm','--force',record.name]))throw Error('wrong target');
    if(await deadlineProcessStart(record.writer.pid)===record.writer.start)process.kill(record.writer.pid,'SIGTERM');
    const until=Date.now()+2000;while(await deadlineProcessStart(record.writer.pid)&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
    if(await deadlineProcessStart(record.writer.pid))throw Error('writer still exists');
    fs.writeFileSync(file,'[]');
    fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({at:Date.now(),args:process.argv.slice(2),home:process.env.HOME,keys:Object.keys(process.env)}));
    `,{mode:0o755});
  const payload=path.join(root,'writer.mjs'),launcher=path.join(root,'launcher.mjs');
  fs.writeFileSync(payload,`import fs from 'node:fs';const beat=()=>fs.appendFileSync(${JSON.stringify(beats)},'beat\\n');beat();setInterval(beat,25);`);
  fs.writeFileSync(launcher,`import {spawn} from 'node:child_process';import {deadlineProcessStart} from ${JSON.stringify(module)};
    const child=spawn(process.execPath,[${JSON.stringify(payload)}],{detached:true,stdio:'ignore',env:{HOME:${JSON.stringify(root)}}});
    child.unref();process.send({pid:child.pid,start:await deadlineProcessStart(child.pid)});process.disconnect();`);
  fs.writeFileSync(script,`import fs from 'node:fs';import {spawn} from 'node:child_process';import {once} from 'node:events';
    import {createSandboxDeadlineManager,sandboxDeadlineClock} from ${JSON.stringify(module)};
    const launcher=spawn(process.execPath,[${JSON.stringify(launcher)}],{stdio:['ignore','ignore','ignore','ipc'],env:{HOME:${JSON.stringify(root)}}});
    const [{pid,start}]=await once(launcher,'message');
    fs.writeFileSync(${JSON.stringify(inventory)},JSON.stringify({name:'dl-0123456789abcdef',writer:{pid,start}}));
    const manager=createSandboxDeadlineManager({binary:${JSON.stringify(binary)},platform:'darwin',directory:${JSON.stringify(root)}});
    const clock=sandboxDeadlineClock(),row={sandbox_id:'dl-0123456789abcdef',sbx_home:${JSON.stringify(root)},deadline_at:clock.wall+5000,
      deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms+5000}};
    fs.writeFileSync(${JSON.stringify(path.join(root,'dl-0123456789abcdef.json'))},JSON.stringify({...row,create:'dispatched',compute_created:true,create_settled:true}));
    const guard=await manager.register(row),file=${JSON.stringify(path.join(root,'armed.json'))};
    fs.writeFileSync(file,JSON.stringify({...row,deadline_enforcer:guard}));
    for(const target of [file,${JSON.stringify(root)}]){const fd=fs.openSync(target,'r');fs.fsyncSync(fd);fs.closeSync(fd);}
    process.send({guard,writer:{pid,start}});setInterval(()=>{},1000);`);
  const child=spawn(process.execPath,[script],{stdio:['ignore','ignore','pipe','ipc'],env:{HOME:root}});
  let diagnostic='';child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-4096);});
  let saved,writer;
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    if(!writer){try{writer=JSON.parse(fs.readFileSync(inventory,'utf8')).writer;}catch{}}
    if(saved&&await deadlineProcessStart(saved.pid)===saved.start)process.kill(saved.pid,'SIGTERM');
    if(writer&&await deadlineProcessStart(writer.pid)===writer.start)process.kill(writer.pid,'SIGTERM');
    const done=Date.now()+2000;while(saved&&await deadlineProcessStart(saved.pid)&&Date.now()<done)await new Promise(resolve=>setTimeout(resolve,20));
    fs.rmSync(root,{recursive:true,force:true});
  });
  ({guard:saved,writer}=await Promise.race([once(child,'message').then(([value])=>value),
    once(child,'exit').then(()=>{throw Error('registrar exited: '+diagnostic);}),
    new Promise((_,reject)=>setTimeout(()=>reject(Error('guard did not register: '+diagnostic)),10_000).unref())]));
  assert.equal(saved.kind,'guard');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'armed.json'))).deadline_enforcer,saved);
  assert.equal(fs.existsSync(marker),false,'removal must not precede the parent crash');
  const count=()=>fs.existsSync(beats)?fs.readFileSync(beats,'utf8').split('beat').length-1:0;
  const readyUntil=Date.now()+2000;while(count()<2&&Date.now()<readyUntil)await new Promise(r=>setTimeout(r,10));
  const before=count();assert.ok(before>=2);
  const killedAt=Date.now(),exited=once(child,'exit');child.kill('SIGKILL');
  assert.equal((await exited)[1],'SIGKILL');
  const continuedUntil=Date.now()+1000;while(count()<=before&&Date.now()<continuedUntil)await new Promise(r=>setTimeout(r,10));
  assert.ok(count()>before,'the detached writer survives the app and its closed IPC channel');
  const until=Date.now()+25_000;
  while(!fs.existsSync(marker)&&Date.now()<until){if(await deadlineProcessStart(saved.pid)===null)break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.ok(fs.existsSync(marker),'independent removal survives SIGKILL of its parent');
  const removed=JSON.parse(fs.readFileSync(marker));
  assert.ok(removed.at>=killedAt);if(removalMode!=='normal')assert.ok(Number(fs.readFileSync(path.join(root,'calls'),'utf8'))>=2);
  assert.deepEqual(removed.args,['rm','--force','dl-0123456789abcdef']);
  assert.equal(removed.home,root);
  assert.deepEqual(removed.keys,['HOME']);
  assert.deepEqual(JSON.parse(fs.readFileSync(inventory)),[]);
  const stopped=count();await new Promise(r=>setTimeout(r,100));assert.equal(count(),stopped);
});
