import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {MINUTE} from './helpers/lending-soak.mjs';
import {persistentRun,importedRecoveryRun} from './helpers/lending-soak-persistent.mjs';
import {createLiveness} from './helpers/lending-soak-liveness.mjs';

test('liveness weights irregular intervals and keeps reason duration and start step', () => {
  const m = createLiveness();
  m.sample(0,true,false,'refresh_failed',7);
  m.sample(3*MINUTE,true,true,'objective_lend',8);
  m.sample(10*MINUTE,false,false,'stopped',9);
  assert.deepEqual(m.report(), {L:0.3,availableMs:10*MINUTE,refusedMs:3*MINUTE,
    longest:{durationMs:3*MINUTE,reasons:{refresh_failed:3*MINUTE},startStep:7}});
});

async function run(t, seed) {
  return persistentRun(t,seed);
}

// Regression ceiling, not a target. Today a lent job keeps its whole reservation
// until its bound, so idle refusals dominate seed 0x1102 (tracking issue #302).
// Tighten this when calibrated release lands. The run is deterministic (the
// identical-seed check below asserts the full trace matches), so the measured
// value is exact; the epsilon only absorbs decimal-literal rounding.
const IDLE_REFUSAL_SHARE_CEILING = 0.99427895048333;
const IDLE_REFUSAL_SHARE_EPSILON = 1e-12;
// Measured user+system CPU for both runs together, three single-process runs:
// 173857.8 ms, 215005.0 ms, 192395.1 ms (median 192395.1 ms).
// Limit = 1.5 x median (288.6 s) rounded up to the next 10 s.
const SOAK_CPU_LIMIT_MS = 290_000;

test('one growing ledger follows four days of combined faults deterministically', {timeout:600_000}, async t => {
  const cpuStarted = process.cpuUsage();
  const a = await run(t,0x1102);
  t.diagnostic(JSON.stringify(a));
  // Structural liveness, independent of L: every refused quote named open holds
  // (the refusal audit checks each one at its own time). Here we check the
  // consequence for each hold: the last quote that named it came before its
  // bound, so no later quote was refused for it after the bound passed.
  const holds = Object.entries(a.holds);
  assert.ok(holds.length>0,'the soak must contain named-hold refusals, or this check is vacuous');
  for(const [hold,row] of holds)
    assert.ok(row.lastAt<row.lastB,`${hold} blocked a quote at ${row.lastAt}, at or after its bound ${row.lastB}`);
  // Measured seed 0x1102 includes required cross-window waits as well as native
  // waits. Each refusal separately proves its named holds are still before B.
  assert.ok(a.L <= IDLE_REFUSAL_SHARE_CEILING + IDLE_REFUSAL_SHARE_EPSILON,
    `I4 user-visible refusal fraction ${a.L} exceeds the measured ceiling ${IDLE_REFUSAL_SHARE_CEILING}`);
  // An uncovered native reservation can safely wait until its own window resets.
  assert.ok(a.longest.durationMs <= Math.max(15*MINUTE,a.nativeResetBoundMs),'I4 refusal exceeds the native window reset bound');
  assert.equal(a.combinedRecovered,true,'I1 combined fault must recover after a covering read');
  assert.equal(a.upgradedClosed,true,'I1 all fifteen old holds must close at their resource bounds');
  assert.equal(a.allClosed,true,'I1 every row must close after the last resource bound');
  const b = await run(t,0x1102);
  assert.deepEqual(a,b,'identical seed must reproduce the complete decision trace and liveness');
  // CPU time, not wall clock: a busy host stretches wall time without changing the work done.
  const cpu = process.cpuUsage(cpuStarted);
  const cpuMs = (cpu.user+cpu.system)/1000;
  t.diagnostic(`SOAK_CPU_MS ${cpuMs}`);
  assert.ok(cpuMs < SOAK_CPU_LIMIT_MS,`both soak runs used ${cpuMs} ms of CPU, limit ${SOAK_CPU_LIMIT_MS} ms`);
});

test('liveness excludes running time while counting idle refusals behind sticky holds', () => {
  const meter = createLiveness();
  meter.sample(0,false,false,'running',0);
  meter.sample(MINUTE,true,false,'native_attempt_in_flight',1);
  meter.sample(3*MINUTE,true,true,'objective_lend',2);
  meter.sample(10*MINUTE,false,false,'running',3);
  assert.equal(meter.report().availableMs,9*MINUTE);
  assert.equal(meter.report().refusedMs,2*MINUTE);
  assert.equal(meter.report().L,2/9);
});

test('imported holds retain early protection and close at each resource bound',async t=>{
  const result=await importedRecoveryRun();
  assert.equal(result.imported,15);assert.equal(result.codex,14);
  assert.equal(result.closed,true,'I1 all fifteen old holds must close');
  t.diagnostic(JSON.stringify(result));
});

// Use the same real provider parser/cache and durable candidate as the growing
// soak, with a clock that visits every release boundary instead of sampling it.
for(const lateAck of [false,true])test(`warm soak cessation boundary preserves history (late_ack=${lateAck})`,async t=>{
 const fs=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
 const {createPace50Candidate}=await import('../lib/v1/lender-pace50.mjs');
 const {durableCessationBound}=await import('../lib/v1/lending-policy.mjs');
 const {soakProviders,START}=await import('./helpers/lending-soak-providers.mjs');
 const directory=fs.mkdtempSync(join(tmpdir(),'soak-cessation-boundary-')),clock={at:START};
 const meter=soakProviders(directory,clock,{failure:new Set(),calls:[],extra:{claude:0,codex:0},fastMeter:true});
 await meter.refresh();
 const open=()=>createPace50Candidate({directory,now:()=>clock.at,account:'synthetic-account',account_week_id:meter.week('claude'),source:meter.source,
  io:{fsyncSync:()=>{},fsyncDirectory:()=>{}},effectOverrides:{arm_cessation_deadline:async()=>()=>{}},
  nativeGuard:{setTimer:()=>0,clearTimer:()=>{}}});
 let pace=open();
 t.after(async()=>{await pace.candidate.cancelObservations();await pace.adapter.close();await meter.probe.close();fs.rmSync(directory,{recursive:true,force:true});});
 const args={attemptId:'soak-warm',jobId:'soak-warm',provider:'claude',model:'claude-haiku-5-5',automatic:false,ownerAbsent:true,
  job:{budget_v1:{max_list_usd:2},requirements:{limits:{wall_seconds:60}}}};
 assert.equal((await pace.candidate.reserve(args)).ok,true);
 await pace.candidate.started(args.attemptId,{ok:true});clock.at+=MINUTE;
 if(lateAck)assert.equal((await pace.adapter.deliver({type:'late_ack',event_id:'soak:late',attempt_id:args.attemptId,at:clock.at})).applied,true);
 const C=clock.at;await pace.candidate.recordCleanup(args.attemptId,{removed:true});
 await pace.candidate.finish({...args,execution:{stdout:'',lending_meter:{final:true,cost_usd:0}}});
 const initial=pace.adapter.state().attempts[0],history=initial.late_ack_events.map(e=>e.event_id);
 assert.equal(durableCessationBound(initial,{state:pace.adapter.state()}),C);
 const proof={type:'cessation_proven',event_id:'soak:stale',attempt_id:args.attemptId,at:C,observed_at:C-3*MINUTE,
  authoritative_cessation:true,usage_reconciled:true,complete:true,compatible:true,refresh_succeeded:true,
  resources:initial.resources.map(r=>({...r,used_micro:r.baseline_used_micro}))};
 const stale=await pace.adapter.deliver(proof);
 assert.equal(stale.applied,false,'a stale reading with a zero-use flag proves nothing and releases nothing');
 assert.equal(stale.reason,lateAck?'late_ack_reconciliation_incomplete':'usage_uncovered');
 assert.deepEqual(pace.adapter.state().attempts[0].resources,initial.resources,'stale usage never releases money');
 assert.equal(pace.adapter.state().attempts[0].late_ack_unresolved,lateAck);
 await pace.adapter.close();pace=open();
 const bounds=initial.resources.map(r=>({id:r.id,B:lateAck?Math.max(r.resets_at,C+r.duration_ms):r.resets_at}));
 assert.ok(initial.resources.every(r=>C<r.resets_at-MINUTE&&r.duration_ms===r.resets_at-r.anchor_at));
 const times=[...new Set(initial.resources.flatMap(r=>{const B=bounds.find(b=>b.id===r.id).B;return [r.resets_at-1,r.resets_at,B-1,B];}))].sort((a,b)=>a-b);
 for(const at of times){
  clock.at=at;await meter.refresh();await pace.candidate.probeHeld();
  const saved=pace.adapter.state().attempts[0];
  assert.deepEqual(saved.late_ack_events.map(e=>e.event_id),history,'cessation and closure preserve audit history');
  for(const r of saved.resources){
   const B=bounds.find(b=>b.id===r.id).B;
   if(at<B)assert.equal(r.held_micro+r.unrepresented_micro,initial.resources.find(x=>x.id===r.id).held_micro);
   else assert.equal(r.held_micro+r.unrepresented_micro,0,'the real held sweep closes at the resource bound');
  }
  if(lateAck&&bounds.some(b=>at<b.B))assert.equal(saved.late_ack_unresolved,true);
 }
 assert.equal(pace.adapter.state().attempts[0].hold_closed,true);
 await pace.adapter.close();pace=open();assert.equal(pace.adapter.state().attempts[0].hold_closed,true);
});
