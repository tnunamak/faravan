import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
const part=(a,b)=>{const s=source.indexOf(a),e=source.indexOf(b,s+a.length);assert.ok(s>=0&&e>s);return source.slice(s,e);};
const policyError=(code,message,details)=>Object.assign(Error(message),{code,...details});
const methods=part('  deadlineTargetDebt(', '  async inspectCleanupRemediation')+part('  async _dispatchProtected(', '  async _runJobCommand(');
const Backend=Function('policyError','sbxHome','sandboxDeadlineRemaining','return class {'+methods+'}')(policyError,()=>'/fake',row=>row.remaining??1000);
function own(){const handle={sandbox_id:'wf-0000000000000001',sbx_home:'/fake',_cleanupId:'owned'};
 let current={...handle,deadline_enforcer:{kind:'systemd',unit:'test'}};const b=new Backend();
 Object.assign(b,{_deadlineRecoveryReport:{rows:[{id:'owned',name:handle.sandbox_id,home:'/fake',status:'in_progress',protected:true}]},
 cleanupJournal:{admissionAuthority:h=>h===handle?current:null,assertExecAllowed:()=>{}},sandboxDeadlines:{active:async()=>true},
 _rowHomeMatches:r=>r.sbx_home==='/fake',deadlineClock:()=>({}),monotonic:()=>0,assertActive:async()=>{},recoverSandboxDeadlines:async()=>{}});
 return {b,handle,set:r=>{current=r;},row:()=>current};}
test('async-only deadline manager admits its exact protected owner and launches',async()=>{const f=own();assert.doesNotThrow(()=>f.b.assertDeadlineTargetClear(f.handle));let n=0;await f.b._dispatchProtected(f.handle,null,()=>n++,{create:true});assert.equal(n,1);});
for(const kind of ['copy','foreign','expired','unprotected'])test('fresh-row exception refuses '+kind,()=>{const f=own();let target=f.handle;if(kind==='copy')target={...target};if(kind==='foreign')f.set({...f.row(),sbx_home:'/other'});if(kind==='expired')f.set({...f.row(),remaining:0});if(kind==='unprotected')f.b._deadlineRecoveryReport.rows[0].protected=false;assert.throws(()=>f.b.assertDeadlineTargetClear(target),{code:'cessation_unverified'});});
for(const kind of ['lost','changed','expired','abort'])test('async final protection check revalidates '+kind,async()=>{const f=own(),stop=new AbortController();let checks=0;f.b.sandboxDeadlines.active=async()=>{checks++;if(kind==='lost')return false;if(kind==='changed')f.set({...f.row(),deadline_enforcer:{kind:'systemd',unit:'other'}});if(kind==='expired')f.set({...f.row(),remaining:0});if(kind==='abort')stop.abort();return true;};await assert.rejects(f.b._dispatchProtected(f.handle,stop.signal,()=>assert.fail('must not dispatch')));assert.equal(checks,1,'reject after the real async boundary');});
test('prepare publishes the acknowledged enforcer on its returned handle only after durable mark',()=>{const prepare=part('  async _prepare(', '  async ');assert.match(prepare,/mark\(handle,\{deadline_enforcer:enforcer\}\)[\s\S]*handle\.deadline_enforcer\s*=\s*enforcer/);});

for(const mode of ['success','mark_refused','register_failed'])test('real registration block publishes only acknowledged durable protection: '+mode,async()=>{
 const start=source.indexOf('    let enforcer;'),end=source.indexOf('    // Creating may pull',start);assert.ok(start>0&&end>start);
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const register=new AsyncFunction('handle','policyError',source.slice(start,end));
 const handle={},enforcer={kind:'systemd',unit:'guard'};let persisted=false;
 const backend={sandboxDeadlines:{register:async()=>{if(mode==='register_failed')throw Error('unavailable');return enforcer;}},
 cleanupJournal:{authority:()=>({}),mark:(h,facts)=>{assert.equal(h,handle);assert.equal(facts.deadline_enforcer,enforcer);assert.equal(handle.deadline_enforcer,undefined);persisted=mode!=='mark_refused';return persisted;}}};
 if(mode==='success'){await register.call(backend,handle,policyError);assert.equal(handle.deadline_enforcer,enforcer);assert.equal(persisted,true);}
 else {await assert.rejects(register.call(backend,handle,policyError),{code:'sandbox_start_failed'});assert.equal(handle.deadline_enforcer,undefined);}
});

for(const mode of ['owned','copied','released_during_check'])test('actual registered journal handle propagates through async-only final dispatch: '+mode,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cut-owned-'));const scratch=path.join(root,'scratch');fs.mkdirSync(scratch);
 const handle={job_id:'own',sandbox_id:'wf-0000000000000008',sbx_home:root,scratch_dir:path.join(scratch,'wf-job-wf-0000000000000008-'+randomUUID()),
 deadline_at:100000,deadline_clock:{version:1,boot_id:'fake',boot_at:100000}};
 const journal=createSandboxCleanupJournal({directory:path.join(root,'journal'),scratchRoot:()=>scratch,home:()=>root,destroy:()=>assert.fail('live own row is never destroyed')});
 journal.register(handle);journal.mark(handle,{deadline_enforcer:{kind:'systemd',unit:(await import('../lib/sandbox-deadline.mjs')).sandboxDeadlineUnit(journal.authority(handle)),binary:'/fake/sbx'}});
 t.after(()=>{journal.finish(handle,{});fs.rmSync(root,{recursive:true,force:true});});
 const Real=Function('policyError','sbxHome','sandboxDeadlineRemaining','return class {'+methods+'}')(policyError,()=>root,()=>1000),b=new Real();let calls=0,launches=0;
 Object.assign(b,{cleanupJournal:journal,sandboxDeadlines:{active:async()=>{calls++;if(mode==='released_during_check'&&calls===2)journal.finish(handle,{});return true;}},
 _rowHomeMatches:r=>r.sbx_home===root,deadlineClock:()=>({wall:1000,boot_id:'fake',boot_ms:1000}),monotonic:()=>0,assertActive:async()=>{},
 recoverSandboxDeadlines:async()=>{b._deadlineRecoveryReport=await journal.recoverDeadlines(b.sandboxDeadlines,{clock:b.deadlineClock});}});
 await b.recoverSandboxDeadlines();assert.equal(b._deadlineRecoveryReport.rows[0].status,'in_progress');assert.equal(b._deadlineRecoveryReport.rows[0].protected,true);
 const task=b._dispatchProtected(mode==='copied'?{...handle}:handle,null,()=>{launches++;});
 if(mode==='owned'){await task;assert.equal(launches,1);}else{await assert.rejects(task);assert.equal(launches,0);}
});
