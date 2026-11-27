import './helpers/no-browser.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {createSandboxDeadlineManager,deadlineProcessStart} from '../lib/sandbox-deadline.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('recovery reuses the durable guard after SIGKILL before the journal update',{timeout:15000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'deadline-publication-')),marker=path.join(root,'ready'),program=path.join(root,'parent.mjs'),directory=path.join(root,'profile/v1/sandbox-cleanup');
 const managerModule=new URL('../lib/sandbox-deadline.mjs',import.meta.url).href,fixtureModule=new URL('./helpers/sandbox-receipt-fixture.mjs',import.meta.url).href;
 fs.writeFileSync(program,`import fs from 'node:fs';import path from 'node:path';import {fileSbx,receiptBackend,receiptJob} from ${JSON.stringify(fixtureModule)};import {createSandboxDeadlineManager} from ${JSON.stringify(managerModule)};
 const root=${JSON.stringify(root)};process.env.FARAVAN_SCRATCH_ROOT=path.join(root,'scratch');fs.mkdirSync(process.env.FARAVAN_SCRATCH_ROOT);
 const backend=receiptBackend(root,fileSbx(root),{sandboxDeadlines:createSandboxDeadlineManager({binary:'/fake/sbx',platform:'darwin',directory:${JSON.stringify(directory)}})}),mark=backend.cleanupJournal.mark;
 backend.cleanupJournal.mark=(handle,facts)=>{if(facts.deadline_enforcer){fs.writeFileSync(${JSON.stringify(marker)},handle._cleanupId);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return mark(handle,facts);};
 backend.prepare(receiptJob()).catch(()=>{});setInterval(()=>{},1000);`);
 const parent=spawn(process.execPath,[program],{env:{HOME:process.env.HOME,PATH:process.env.PATH},stdio:'ignore'});let saved;
 t.after(async()=>{if(parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGKILL');if(saved&&await deadlineProcessStart(saved.pid)===saved.start)process.kill(saved.pid,'SIGTERM');await pause(100);fs.rmSync(root,{recursive:true,force:true});});
 const until=Date.now()+10000;while(!fs.existsSync(marker)&&Date.now()<until)await pause(20);assert.ok(fs.existsSync(marker));
 const recordPath=path.join(directory,fs.readFileSync(marker,'utf8')+'.json'),row=JSON.parse(fs.readFileSync(recordPath));saved=JSON.parse(fs.readFileSync(recordPath+'.deadline'));
 assert.equal(row.deadline_enforcer,undefined);assert.equal(row.create,'reserved');assert.equal(saved.state,'armed');
 const exit=once(parent,'exit');parent.kill('SIGKILL');await exit;
 const recovered=createSandboxDeadlineManager({binary:'/fake/sbx',platform:'darwin',directory,spawnGuard:()=>assert.fail('a second guard must never be armed')});
 const enforcer=await recovered.register(row);assert.equal(enforcer.pid,saved.pid);assert.equal(enforcer.start,saved.start);
 // Frozen change (no ENOENT removal receipt): a vanished record is not proof the sandbox is gone, so the guard keeps its duty. The
 // cleanup hook above ends it by SIGTERM.
 fs.unlinkSync(recordPath);await pause(1500);assert.equal(await deadlineProcessStart(saved.pid),saved.start,'the guard outlives its deleted record');
});
