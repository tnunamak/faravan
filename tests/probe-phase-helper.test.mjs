import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,symlink,rm} from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProbeDiagnostics,createProbeReceiptStore,sanitizeProbeDiagnostics} from '../lib/v1/probe-diagnostics.mjs';
const receipt=()=>createProbeDiagnostics().finish();

test('review: nested failure reports inner phase that actually failed first',()=>{
  const d=createProbeDiagnostics();const outer=d.start('preflight');const inner=d.start('storage_qualification');
  d.end(inner,'failed');d.end(outer,'failed');
  assert.equal(d.finish().failed_phase,'storage_qualification');
});

test('review: receipt writes cannot follow an existing predictable temp symlink',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phase-review-'));
  try {
    const file=join(dir,'receipts.json'),target=join(dir,'unrelated.txt');
    await writeFile(target,'keep this unchanged',{mode:0o644});
    await symlink(target,file+'.'+process.pid+'.tmp');
    const store=createProbeReceiptStore({file,fs});
    await store.record(receipt()).catch(()=>{});
    assert.equal(await readFile(target,'utf8'),'keep this unchanged');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('review: stale temp file mode must not expose private receipts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phase-review-'));
  try {
    const file=join(dir,'receipts.json');
    await writeFile(file+'.'+process.pid+'.tmp','stale',{mode:0o644});
    const store=createProbeReceiptStore({file,fs});await store.record(receipt());
    assert.equal((await stat(file)).mode&0o777,0o600);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('review: event channel uses bounded metadata like final receipt',()=>{
  const events=[];const d=createProbeDiagnostics({provider:'secret-provider',job_digest:'secret-job',attempt_id:'secret with spaces',onEvent:e=>events.push(e)});
  d.start('preflight');
  assert.equal(events[0].provider,undefined);
  assert.equal(events[0].job,undefined);
  assert.equal(events[0].attempt_id,undefined);
});

test('review: failing callbacks do not change observations',async()=>{
  const d=createProbeDiagnostics({onEvent(){throw new Error('no log');},onReceipt(){return Promise.reject(new Error('no receipt'));}});
  const p=d.start('preflight');d.end(p,'failed');assert.equal(d.finish().failed_phase,'preflight');
  await new Promise(resolve=>setImmediate(resolve));
});

test('review: invalid purpose cannot bypass metadata allowlist and receipt byte bound',()=>{
  const events=[],receipts=[];
  const d=createProbeDiagnostics({purpose:'secret'.repeat(2000),onEvent:e=>events.push(e),onReceipt:r=>receipts.push(r)});
  d.start('preflight'); const r=d.finish();
  assert.ok(sanitizeProbeDiagnostics(r), 'all receipts must satisfy their own sanitizer');
  assert.ok(Buffer.byteLength(JSON.stringify(r))<=8192);
  for(const e of events) assert.ok(e.purpose.length<32);
});

test('review: monotonic rollback cannot reverse elapsed observations, and large duration is bounded',()=>{
  let tick=100;const d=createProbeDiagnostics({monotonic:()=>tick,now:()=>Date.parse('2026-11-08T00:00:00.000Z')});
  tick=125;const p=d.start('first_command',{budgetMs:1000,deadlineSource:'command'});
  tick=110;d.end(p,'failed');
  assert.equal(d.snapshot().phases[0].start_elapsed_ms,25);assert.equal(d.snapshot().phases[0].end_elapsed_ms,25);
  assert.equal(d.snapshot().phases[0].effective_deadline_elapsed_ms,1025);
  tick=1e12;const q=d.start('teardown',{budgetMs:1000,deadlineSource:'cleanup'});d.end(q,'failed');
  const r=d.finish();assert.equal(r.phases[1].end_elapsed_ms,86400000);
  assert.equal(r.phases[1].effective_deadline_elapsed_ms,null);assert.equal(r.failed_phase,'first_command');
});

test('review: first failure is stable across same-tick nesting, cleanup failure and re-sanitization',()=>{
  const d=createProbeDiagnostics({monotonic:()=>100});
  const outer=d.start('preflight'),inner=d.start('storage_qualification',{subject:'qualification'});
  d.end(inner,'timed_out');d.end(outer,'failed');const cleanup=d.start('teardown');d.end(cleanup,'failed');
  const r=d.finish();assert.equal(r.failed_phase,'storage_qualification');
  assert.deepEqual(sanitizeProbeDiagnostics(r),r);
  assert.equal(r.first_failure.sequence,2);assert.equal(r.first_failure.outcome,'timed_out');
});

test('review: phase/event count and payloads are strictly bounded',()=>{
  const events=[];const d=createProbeDiagnostics({provider:'claude',purpose:'native_identity',job_digest:'a'.repeat(64),attempt_id:'b'.repeat(128),onEvent:e=>events.push(e)});
  for(let i=0;i<40;i++){const p=d.start('storage_qualification',{subject:'qualification',budgetMs:1000000,deadlineSource:'sandbox_wall'});d.end(p,i?'ok':'failed');}
  const r=d.finish();assert.equal(r.phases.length,24);assert.equal(events.length,48);
  assert.ok(Buffer.byteLength(JSON.stringify(r))<=8192);assert.equal(d.start('teardown'),null);
  const bad={...r,argv:'secret',stderr:'secret',token:'secret',phases:r.phases.map(p=>({...p,path:'secret',stdout:'secret'}))};
  assert.ok(!JSON.stringify(sanitizeProbeDiagnostics(bad)).includes('secret'));
});

test('review: never-settling advisory receipt callback cannot delay finish',()=>{
  const d=createProbeDiagnostics({onReceipt:()=>new Promise(()=>{})});
  d.end(d.start('preflight'),'ok');const r=d.finish();assert.equal(r.phases[0].outcome,'ok');
});

test('review: receipt store retains only 64 sanitized entries and exact job correlation',async()=>{
  const files=new Map();const memfs={readFile:async p=>files.get(p)??'',writeFile:async(p,b)=>files.set(p,b),rename:async(a,b)=>{files.set(b,files.get(a));files.delete(a);},unlink:async p=>files.delete(p)};
  const store=createProbeReceiptStore({file:'receipts',fs:memfs});const receipts=[];
  for(let i=0;i<70;i++){
    const d=createProbeDiagnostics({job_digest:i%2?'a'.repeat(64):'b'.repeat(64),attempt_id:'attempt_'+i});
    d.end(d.start('preflight'),'ok');const r=d.finish();receipts.push(r);await store.record({...r,stdout:'secret',path:'secret'});
  }
  let rows=JSON.parse(files.get('receipts'));assert.equal(rows.length,64);assert.equal(rows[0].probe_id,receipts[6].probe_id);
  assert.ok(!files.get('receipts').includes('secret'));
  assert.equal((await store.forJob('a'.repeat(64))).length,32);assert.equal((await store.forJob('b'.repeat(64))).length,32);
  assert.deepEqual(await store.forJob('bogus'),[]);
  await store.record(receipts.at(-1));rows=JSON.parse(files.get('receipts'));assert.equal(rows.length,64);
  assert.equal(rows.filter(r=>r.probe_id===receipts.at(-1).probe_id).length,1);
});

test('review: optional receipt write failure does not poison later writes or flush',async()=>{
  const files=new Map();let fail=true;const memfs={readFile:async p=>files.get(p)??'',writeFile:async(p,b)=>{if(fail){fail=false;throw new Error('disk busy');}files.set(p,b);},rename:async(a,b)=>{files.set(b,files.get(a));files.delete(a);},unlink:async p=>files.delete(p)};
  const store=createProbeReceiptStore({file:'receipts',fs:memfs});await assert.rejects(store.record(receipt()));
  await store.flush();await store.record(receipt());assert.equal(JSON.parse(files.get('receipts')).length,1);
});

test('review: caller deadline applies only to active check and earlier command deadline wins',()=>{
 let tick=0;const d=createProbeDiagnostics({callerBudgetMs:90000,monotonic:()=>tick});
 const pre=d.start('preflight');assert.equal(pre.effective_deadline_elapsed_ms,90000);assert.equal(pre.deadline_source,'caller');d.end(pre);
 tick=10000;const command=d.start('identity',{budgetMs:30000,deadlineSource:'command'});
 assert.equal(command.effective_deadline_elapsed_ms,40000);assert.equal(command.deadline_source,'command');
 tick=40000;d.interrupt('timed_out');const cleanup=d.start('teardown');assert.equal(cleanup.effective_deadline_elapsed_ms,null);
 assert.equal(cleanup.deadline_source,null);d.end(cleanup,'failed');const r=d.finish();assert.equal(r.first_failure.outcome,'timed_out');assert.equal(r.failed_phase,'identity');
});
