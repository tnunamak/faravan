import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectLegacySandboxReferences} from '../lib/docker-backend.mjs';
import {showStatus} from '../lib/v1/status.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';
const name='wf-0123456789abcdef',command="env HOME='/synthetic sandbox' 'sbx' rm --force '"+name+"'";
const remediation={name,home:'/synthetic sandbox',command};
for(const cause of ['foreign cwd','own cwd','foreign reference','uid unreadable','cmdline unreadable','proc unreadable','vanished pid','own cwd missing'])test('legacy process evidence: '+cause,async()=>{
  const denied=()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});};
  const fs={readdir:async()=>cause==='proc unreadable'?denied():['42'],
    readFile:async()=>cause==='cmdline unreadable'?denied():cause==='foreign reference'?'other-tool\0'+name+'\0':'other-tool\0',
    stat:async()=>cause==='vanished pid'?Promise.reject(Object.assign(new Error('gone'),{code:'ENOENT'})):cause==='uid unreadable'?denied():({uid:['own cwd','own cwd missing'].includes(cause)?1000:0}),readlink:async()=>cause==='own cwd missing'?Promise.reject(Object.assign(new Error('gone'),{code:'ENOENT'})):denied()};
  const proof=await inspectLegacySandboxReferences([name],{procRoot:'/synthetic/proc',fs,uid:1000});
  assert.equal(proof.complete,['foreign cwd','foreign reference','vanished pid'].includes(cause));
  if(cause==='foreign reference')assert.deepEqual(proof.references,[name]);
});
test('status text displays exact legacy recovery guidance',async t=>{
  const home=await mkdtemp(join(tmpdir(),'recovery-status-'));t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(home,'v1'));await writeFile(join(home,'v1','app.json'),JSON.stringify({pid:process.pid,port:1234,token:'synthetic'}));
  let output='';
  assert.equal(await showStatus([],{home,device:{keyId:'a'.repeat(64),listCircles:async()=>[]},fetch:async()=>({ok:true,json:async()=>({enabled:true,status:'stopping',remediation:[remediation]})}),stdout:{write:s=>output+=s}}),0);
  assert.ok(output.includes(command));assert.ok(output.includes(name));assert.match(output,/only if this install created the job/);
});
test('lender cessation report displays exact legacy recovery guidance',async t=>{
  const f=await lenderFixture(t);f.backend.reconcileOwnedSandboxes=async()=>({removed:false,remediation:[remediation]});
  const controller=new AbortController(),lender=createLender({client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock,onEvent:e=>f.events.push(e)});
  const running=lender.start(controller.signal);running.catch(()=>{});
  try{await until(()=>f.events.some(e=>e.reason==='cessation_unverified'),'recovery refusal');const event=f.events.find(e=>e.reason==='cessation_unverified');assert.ok(event.label.includes(command));assert.match(event.label,/only if this install created the job/);}
  finally{controller.abort();await running.catch(()=>{});}
});

test('pending recovery keeps guidance visible in the final cessation report',async t=>{
  const f=await lenderFixture(t);f.policy.enabled=false;f.policy.recoveryOnly=true;
  await f.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:120000,pending:{jobId:'old-job',attemptId:'old-attempt',attempt:{attempt_id:'old-attempt'},reservedMs:120000}});
  f.backend.reconcilePending=async row=>({removed:false,attemptId:row.attemptId,remediation:[remediation]});
  const controller=new AbortController(),lender=createLender({client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock,onEvent:e=>f.events.push(e)});
  const running=lender.start(controller.signal);running.catch(()=>{});
  try{await until(()=>f.events.filter(e=>e.reason==='cessation_unverified').length>=2,'pending recovery refusal');assert.ok(lender.getState().label.includes(command));}
  finally{controller.abort();await running.catch(()=>{});}
});
test('an unknown sandbox without a safe removal command is reported, never given a command',async()=>{
  const {sandboxRemediationLines}=await import('../lib/sandbox-remediation.mjs');
  for(const reason of ['creation_unproven','old_record']) {
    const [line]=sandboxRemediationLines([{name,home:'/synthetic sandbox',reason}]);
    assert.ok(line.includes(name));
    assert.doesNotMatch(line,/undefined|Run it/);
    assert.match(line,/Faravan did not remove it/);
  }
});
