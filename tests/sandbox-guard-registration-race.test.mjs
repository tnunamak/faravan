import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {sandboxDeadlineClock,createSandboxDeadlineManager,deadlineSupervisorPayload} from '../lib/sandbox-deadline.mjs';

// A sees B still choosing and backs off. B already captured A's registration,
// then reads it after A released it. Neither try-lock attempt acquires ownership.
// This distinguishes failure before publication from a loser overwriting a winner.
test('concurrent startup retries transient lock contention until one remover publishes',{timeout:20000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'guard-registration-race-')),directory=path.join(root,'records');
  fs.mkdirSync(directory);
  const events=path.join(root,'events.jsonl'),wrapper=path.join(root,'bootstrap.mjs');
  const module=new URL('../lib/sandbox-deadline-supervisor.mjs',import.meta.url).href;
  fs.writeFileSync(wrapper,`import fs from 'node:fs';import path from 'node:path';
import {startDeadlineSupervisor} from ${JSON.stringify(module)};
const root=${JSON.stringify(root)},role=process.argv[2],payload=JSON.parse(process.argv[3]);
const log=event=>fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({role,event})+'\\n');
const wait=name=>{const until=Date.now()+10000;while(!fs.existsSync(path.join(root,name))){if(Date.now()>until)throw Error('Barrier '+name);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);}};
const symlink=fs.symlinkSync,readlink=fs.readlinkSync,unlink=fs.unlinkSync;let own,blocked=false;
fs.unlinkSync=(file,...rest)=>{const result=unlink(file,...rest);if(role==='A'&&String(file)===own){log('released');fs.writeFileSync(path.join(root,'A.done'),'');}return result;};
fs.symlinkSync=(target,file,...rest)=>{
 const result=symlink(target,file,...rest);
 if(String(file).endsWith('.choosing')&&String(file).includes('.deadline.lock.owners-v1')){
  own=String(file);log('choosing');fs.writeFileSync(path.join(root,role+'.choosing'),'');wait((role==='A'?'B':'A')+'.choosing');
 }
 return result;
};
fs.readlinkSync=(file,...rest)=>{
 if(role==='B'&&!blocked&&own&&String(file)!==own&&String(file).endsWith('.choosing')&&String(file).includes('.deadline.lock.owners-v1')){
  blocked=true;log('snapshot');fs.writeFileSync(path.join(root,'B.snapshot'),'');wait('A.done');
  try{return readlink(file,...rest);}catch(error){log('registration_'+error.code);throw error;}
 }
 if(role==='A'&&own&&String(file)!==own&&String(file).endsWith('.choosing')&&String(file).includes('.deadline.lock.owners-v1')){wait('B.snapshot');log('sees_choosing');}
 return readlink(file,...rest);
};
await startDeadlineSupervisor(payload).finally(()=>{log('done');fs.writeFileSync(path.join(root,role+'.done'),'');});
`);
  const clock=sandboxDeadlineClock(),row={_cleanupId:'11111111-1111-4111-8111-111111111111',sandbox_id:'wf-0123456789abcdef',sbx_home:root,
    deadline_at:clock.wall+3600000,deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms+3600000},create:'dispatched',create_settled:true};
  fs.writeFileSync(path.join(directory,row._cleanupId+'.json'),JSON.stringify(row));
  const children=[];let launches=0;
  t.after(async()=>{
    await Promise.all(children.map(async child=>{if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill('SIGKILL');await exited;}));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const manager=()=>createSandboxDeadlineManager({binary:'/fake/sbx',directory,platform:'hermetic-guard',readyTimeoutMs:5000,
    spawnGuard:(binary,args,options)=>{const child=spawn(binary,[wrapper,++launches===1?'A':'B',args[1]],options);children.push(child);return child;}});
  const results=await Promise.allSettled([manager().register(row,{recovery:true}),manager().register(row,{recovery:true})]);
  const trace=fs.readFileSync(events,'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(trace.some(item=>item.role==='A'&&item.event==='sees_choosing'));
  assert.ok(trace.some(item=>item.role==='B'&&item.event==='registration_ENOENT'));
  const winners=results.filter(item=>item.status==='fulfilled').map(item=>item.value);
  const payload=deadlineSupervisorPayload(row,'/fake/sbx',directory,'guard');
  assert.ok(winners.length>=1,JSON.stringify({results:results.map(item=>item.reason?.message??item.value),trace,published:fs.existsSync(payload.statusPath)}));
  assert.equal(new Set(winners.map(item=>item.pid)).size,1);
  assert.equal(JSON.parse(fs.readFileSync(payload.statusPath)).pid,winners[0].pid);
});
