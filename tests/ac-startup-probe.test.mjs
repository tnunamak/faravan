import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDeadlineRecoveryGate} from '../lib/v1/deadline-recovery-gate.mjs';
import {createLendingProbe} from '../lib/v1/lending-probe.mjs';

// Real pure gate/probe modules and exact lender source slices. A usage reading is a host read and never touches the sandbox
// backend, so a reading runner here is a plain host-read double; cleanup debt for sandboxes is checked through the gate alone.
const createRunner=()=>async()=>({stdout:goodOutput,host_read:true});
const goodOutput=JSON.stringify({faravan_probe:1,status:200,body:{rate_limit:{allowed:true,limit_reached:false,
  primary_window:{used_percent:20,limit_window_seconds:604800,reset_at:2000000},secondary_window:null}}});
const reportFor=(status='failed',reason='unsafe_record')=>({complete:false,rows:Array.from({length:12},(_,i)=>({
  id:(i+1).toString(16).padStart(8,'0')+'-1234-1234-1234-123456789012',name:'wf-'+i.toString(16).padStart(16,'0'),
  status:i===0?status:'resolved',...(i===0?{reason,home:'/private/SECRET'}:{})}))});
function fixture(report) {
  let starts=0,prepares=0,protectedStarts=0;
  const backend={recoverSandboxDeadlines:async()=>report,deadlineRecoveryHold:()=>null,
    cleanupStatus:()=>({deadline_recovery:{...report,debt:report.rows?.filter(r=>!['resolved','protected','watching'].includes(r.status))??[]}}),
    lenderCapabilities:async()=>({available:true}),prepare:async()=>{prepares++;return {sandbox_id:'wf-ffffffffffffffff',deadline_enforcer:{fresh:true}};},
    start:async(handle,{onLog})=>{starts++;if(handle.deadline_enforcer?.fresh)protectedStarts++;onLog?.({stream:'stdout',chunk:goodOutput});},
    requestStop:async()=>({delivered:true}),destroy:async()=>({removed:true})};
  return {backend,counts:()=>({starts,prepares,protectedStarts})};
}

for(const status of ['failed','in_progress','foreign_locked'])test(status+' old row among twelve remains debt while an unrelated protected probe proceeds',async()=>{
  const report=reportFor(status),f=fixture(report),gate=createDeadlineRecoveryGate({backend:f.backend});
  assert.equal(await gate.retry(),true);assert.equal(gate.current(),null);
  const state=gate.status();assert.equal(state.complete,false);assert.equal(state.debt_count,1);
  assert.equal(state.rows.filter(row=>row.status==='resolved').length,11);
  assert.equal(state.debt[0].status,status);assert.equal(state.debt[0].protected,false);
  assert.doesNotMatch(JSON.stringify(state),/SECRET|private|No new jobs|all.*protected/i);
  const probe=createLendingProbe({runGuest:gate.wrapProbe(createRunner({backend:f.backend})),now:()=>1000000});
  assert.equal((await probe.probe('codex')).ok,true);
  assert.deepEqual(f.counts(),{starts:0,prepares:0,protectedStarts:0},'a reading creates and starts no sandbox');await probe.close();
});

test('malformed single record has a fixed per-row reason and never becomes a global hold',async()=>{
  const f=fixture(reportFor('failed','unsafe_record')),gate=createDeadlineRecoveryGate({backend:f.backend});
  assert.equal(await gate.retry(),true);assert.equal(gate.status().debt[0].reason,'unsafe_record');
  assert.equal(gate.current(),null);gate.assertReady();
});

// Cleanup isolation rule: only service unavailability and unproven daemon ownership are global.
test('invalid reports do not close unrelated admission',async()=>{
  for(const report of [undefined,null,{},'yes',{complete:true,rows:reportFor().rows},{complete:false,rows:[{status:'bogus'}]}]){
    const gate=createDeadlineRecoveryGate({backend:{recoverSandboxDeadlines:async()=>report}});
    assert.equal(await gate.retry(),false);assert.equal(gate.status().state,'clear');
  }
});

for(const kind of ['throw','fatal','gate'])test(kind+' whole recovery failure leaves unrelated probes available',async()=>{
  let probes=0;const f=fixture({complete:false,rows:[],fatal:'journal_unavailable'});
  if(kind==='throw')f.backend.recoverSandboxDeadlines=async()=>{throw Object.assign(Error('/private/SECRET'),{code:'EACCES'});};
  if(kind==='gate')f.backend.deadlineRecoveryHold=()=>{throw Error('/private/SECRET gate failure');};
  const gate=createDeadlineRecoveryGate({backend:f.backend});
  assert.equal(await gate.retry(),false);assert.equal(gate.status().state,'clear');
  assert.equal(gate.current(),null);assert.doesNotMatch(JSON.stringify(gate.status()),/private|SECRET/);
  await gate.wrapProbe(async()=>{probes++;})();assert.equal(probes,1);
});

test('raw target refusal cannot poison the global gate even with a custom probe runner',async()=>{
  const f=fixture(reportFor()),gate=createDeadlineRecoveryGate({backend:f.backend});await gate.retry();
  const runner=gate.wrapProbe(async()=>{throw Object.assign(Error('target'),{code:'cessation_unverified',recovery_scope:'target'});});
  await assert.rejects(runner(),{recovery_scope:'target'});assert.equal(gate.current(),null);
  const probe=createLendingProbe({runGuest:runner});assert.equal((await probe.probe('codex')).reason,'probe_deferred');await probe.close();
});

const lenderSource=readFileSync(new URL('../lib/v1/lender.mjs',import.meta.url),'utf8');
const beginning=lenderSource.indexOf('      let foreignSeen=startupForeignDiagnostics.get(backend);');
const end=lenderSource.indexOf('      while(!signal?.aborted) {',beginning);
assert.ok(beginning>0&&end>beginning);
const startup=new Function('backend','signal','idle','emit','diagnose',
  'const startupForeignDiagnostics=new WeakMap(),DECLINE_BACKOFF_MS=0,availability=async()=>({reason:"cleanup_pending",until:120000});return (async()=>{'+lenderSource.slice(beginning,end)+'return true;})();');
test('lender accepts current per-target admission without converting debt to removed proof',async()=>{
  const proof={removed:false,admission_allowed:true,cleanup_debt:[{status:'foreign_locked'}]};let observed=0;
  assert.equal(await startup({reconcileOwnedSandboxes:async()=>proof,isOwnedSandboxAdmissionCurrent:value=>{observed++;return value===proof;},
    isOwnedSandboxProofCurrent:()=>false},undefined,async()=>{throw Error('unrelated lender was held');},()=>{},()=>{}),true);
  assert.equal(observed,1);assert.equal(proof.removed,false);
});
test('lender rechecks admission generation and retains the global failure barrier',async()=>{
  for(const current of [true,false]){
    const controller=new AbortController();let waited=0;
    const proof={removed:false,admission_allowed:!current};
    await startup({reconcileOwnedSandboxes:async()=>proof,isOwnedSandboxAdmissionCurrent:()=>current},controller.signal,
      async()=>{waited++;controller.abort();},()=>{},()=>{});
    assert.equal(waited,1);
  }
});

test('app status exposes cleanup debt separately and retains the fifteen-second retry cadence',()=>{
  const app=readFileSync(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  assert.ok(/deadline_recovery:deadlineRecovery\?\.status\(\)/.test(app),'app publishes separate deadline recovery status');
  assert.match(app,/dataCleanupTimer=setInterval\(reapData,options\.cleanupRecheckMs\?\?15000\)/);
  assert.match(app,/then\(\(\)=>deadlineRecovery\.retry\(\)\)/);
});


test('legacy cleanup debt remains visible in app status without duplication or raw details',async()=>{
  const f=fixture({complete:true,rows:[]}),gate=createDeadlineRecoveryGate({backend:f.backend});
  await gate.retry();
  const debt={name:'wf-1234567890abcdef',home:'/private/SECRET',status:'failed',reason:'old_record'};
  f.backend.cleanupStatus=()=>({deadline_recovery:{complete:false,rows:[],debt:[debt]}});
  const status=gate.status();
  assert.equal(status.state,'partial');assert.equal(status.complete,false);assert.equal(status.debt_count,1);
  assert.equal(status.debt[0].name,debt.name);assert.equal(status.debt[0].reason,'old_record');
  assert.doesNotMatch(JSON.stringify(status),/private|SECRET/);assert.equal(gate.current(),null);
  f.backend.cleanupStatus=()=>({deadline_recovery:{complete:false,rows:[debt],debt:[debt]}});
  assert.equal(gate.status().debt_count,1);
});
