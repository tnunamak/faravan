import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DockerSbxBackend, preparationView} from '../../lib/docker-backend.mjs';
import {createSandboxCleanupJournal} from '../../lib/sandbox-cleanup-journal.mjs';
import {sandboxDeadlineReservation, createSandboxDeadlineManager, deadlineSupervisorPayload, deadlineBinding} from '../../lib/sandbox-deadline.mjs';
import {opById} from '../../lib/v1/ops/registry.mjs';

const context = {jobId:'job-one',attemptId:'attempt-one',generation:1};
const job = {job_id:context.jobId,resources:{wall_seconds:60}};
function fixture(t) {
  const parent=path.join(os.homedir(),'.tmp');
  fs.mkdirSync(parent,{recursive:true,mode:0o700});
  const root=fs.mkdtempSync(path.join(parent,'preparation-receipt-'));
  fs.chmodSync(root,0o700);
  const directory=path.join(root,'journal'),scratchRoot=path.join(root,'scratch');
  fs.mkdirSync(scratchRoot,{mode:0o700});
  const journal=createSandboxCleanupJournal({directory,scratchRoot:()=>scratchRoot,home:()=>root,destroy:async()=>({})});
  const handles=[],states=new Map();
  const clock=()=>({wall:100000,boot_id:'synthetic-boot',boot_ms:1000});
  const manager=createSandboxDeadlineManager({directory,binary:'/synthetic/sbx',clock,
    stateReader:file=>states.get(file),processStartSync:pid=>pid===12345?'synthetic-start':null});
  t.after(()=>{for(const handle of handles)journal.finish(handle,{removed:false});fs.rmSync(root,{recursive:true,force:true});});
  function handle() {
    const sandbox_id='wf-'+String(handles.length+1).padStart(16,'0');
    const scratch_dir=fs.mkdtempSync(path.join(scratchRoot,'wf-job-'+sandbox_id+'-'));
    const value={job_id:context.jobId,sandbox_id,scratch_dir,...sandboxDeadlineReservation(60000,clock()),
      _deadline:{endsAt:60000,expired:false,controller:new AbortController()}};
    journal.register(value);
    journal.mark(value,{create:'dispatched',compute_created:true,create_settled:true,
      deadline_enforcer:{kind:'guard',binary:'/synthetic/sbx',pid:12345,start:'synthetic-start'}});
    const payload=deadlineSupervisorPayload(journal.admissionAuthority(value),'/synthetic/sbx',directory,'guard');
    states.set(payload.statusPath,{binding:deadlineBinding(payload),state:'armed',pid:12345,start:'synthetic-start'});
    handles.push(value);return value;
  }
  const backend=Object.assign(Object.create(DockerSbxBackend.prototype),{
    cleanupJournal:journal,sandboxDeadlines:manager,monotonic:()=>0,deadlineClock:clock,_now:()=>1234,
    ensureSandboxAdmission:async()=>{},assertDeadlineTargetClear(){},_assertCreateSignIn(){},
    _preparing:0,_prepare:async()=>handle(),
  });
  return {backend,journal,handle,directory};
}
test('context-only options records only an owned current completed preparation',async t=>{
  const {backend,journal}=fixture(t);
  const h=await backend.prepare(job,{preparationContext:context});
  assert.equal(journal.admissionAuthority(h).sandbox_id,h.sandbox_id);
  assert.equal(journal.admissionAuthority({...h}),null);
  assert.equal(backend.getPreparationObservation(context).state,'prepared');
  assert.equal(backend.getPreparationObservation({...context,generation:2}).state,'unknown');
  assert.deepEqual(Object.keys(preparationView(backend.getPreparationObservation(context))).sort(),
    ['schemaVersion','state','jobId','attemptId','sandboxId','observedAtMs'].sort());
  journal.finish(h,{removed:false});
  assert.equal(backend.getPreparationObservation(context).state,'unknown');
});
test('copied handle and missing settled receipt cannot establish preparation',async t=>{
  const {backend,handle,journal}=fixture(t);
  const h=handle();backend._prepare=async()=>({...h});
  await backend.prepare(job,{preparationContext:context});
  assert.equal(backend.getPreparationObservation().state,'unknown');
  journal.mark(h,{create_settled:false});backend._prepare=async()=>h;
  await backend.prepare(job,{preparationContext:context});
  assert.equal(backend.getPreparationObservation().state,'unknown');
});
test('replacement, removal and restart do not inherit observations',async t=>{
  const {backend,directory}=fixture(t);
  const h=await backend.prepare(job,{preparationContext:context});
  const file=path.join(directory,h._cleanupId+'.json');
  const row=JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file,JSON.stringify({...row,job_id:'replacement'}));
  assert.equal(backend.getPreparationObservation().state,'unknown');
  fs.unlinkSync(file);
  assert.equal(backend.getPreparationObservation().state,'unknown');
  assert.equal(DockerSbxBackend.prototype.getPreparationObservation.call({}).state,'unknown');
});
test('failure, cancellation and late superseded completion stay unknown',async t=>{
  const {backend,handle}=fixture(t);
  backend._prepare=async()=>{throw Error('synthetic failure');};
  await assert.rejects(backend.prepare(job,{preparationContext:context}),/synthetic failure/);
  assert.equal(backend.getPreparationObservation().state,'unknown');
  let resolve;
  backend._prepare=()=>new Promise(r=>{resolve=r;});
  const controller=new AbortController();
  const first=backend.prepare(job,{preparationContext:context,signal:controller.signal});
  await new Promise(r=>setImmediate(r));
  assert.equal(backend.getPreparationObservation(context).state,'pending');
  controller.abort();
  resolve(handle());await first;
  assert.equal(backend.getPreparationObservation().state,'unknown');
  let late;
  backend._prepare=()=>new Promise(r=>{late=r;});
  const old=backend.prepare(job,{preparationContext:context});
  await new Promise(r=>setImmediate(r));
  backend._prepare=async()=>handle();
  await backend.prepare(job,{preparationContext:{...context,attemptId:'attempt-two',generation:2}});
  late(handle());await old;
  assert.equal(backend.getPreparationObservation(context).state,'unknown');
  assert.equal(backend.getPreparationObservation().attemptId,'attempt-two');
});
test('projection fails closed and drops internal fields',()=>{
  assert.deepEqual(preparationView({state:'prepared',generation:1,handle:{}}),
    {schemaVersion:1,state:'unknown',jobId:null,attemptId:null,sandboxId:null,observedAtMs:null});
  const schema=opById('readiness.get').output.properties.preparation;
  assert.equal(schema.additionalProperties,false);
  assert.deepEqual(Object.keys(schema.properties).sort(),Object.keys(preparationView(null)).sort());
  assert.deepEqual(schema.required.slice().sort(),Object.keys(preparationView(null)).sort());
  const value=preparationView({...context,state:'prepared',sandboxId:'wf-0000000000000001',observedAtMs:1234,rawHandle:{}});
  assert.equal(value.state,'prepared');
  assert.equal(Object.hasOwn(value,'generation'),false);
});
