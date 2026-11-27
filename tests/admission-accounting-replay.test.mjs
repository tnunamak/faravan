import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {settleOwnResets, assertAdmissionCounts, exposure} from './helpers/pace50-reset-assertions.mjs';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {executionProvenAbsent} from '../lib/v1/lending-policy.mjs';
import {ACCOUNT, NOW, WEEK, ordinaryInput, request, MICRO} from './helpers/pace50-fixtures.mjs';

async function rig(t, {native = false, postingLagBoundMs} = {}) {
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'accounting-replay-'));
  let adapter;
  let failWrite = false;
  let meter = 0;
  let clock=NOW;
  const launches = [];
  let builderGate;
  let builtAttemptIds;
  const buildInput = async ({now,state}) => {
    builtAttemptIds = state.attempts.map(a => a.id);
    if (builderGate) {const gate = builderGate; builderGate = null; gate.enter(); await gate.promise;}
    const input = ordinaryInput({now, windows:ordinaryInput({now:now<NOW+42*3600000?NOW:now}).windows.map(w => ({...w, observed_at:now, used_micro:typeof meter === 'number' ? meter : meter[w.id], kappa_micro:native ? null : 10_000, ...(native ? {conversion:'native_window'} : {})}))});
    input.objective.job.requestedUsdMicro = 2*MICRO;
    return input;
  };
  const open = () => createPace50Adapter({directory, postingLagBoundMs, account:ACCOUNT, account_week_id:WEEK,
    now:() => clock, buildInput, io:{fsyncDirectory(directory) {
      if (failWrite) {failWrite=false; throw Object.assign(new Error('after rename'),{code:'EIO'});}
      const fd=fs.openSync(directory,'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    }}, effects:{arm_cessation_deadline:async () => () => {}, launch_chunk:async effect => {launches.push(effect.attempt_id);}, open_short_window:async () => {}, cancel_pending_attempt:async () => {}, request_cessation:async () => {}, request_fresh_complete_reconciliation:async () => {}}});
  adapter = open();
  t.after(async () => {await adapter.close(); fs.rmSync(directory, {recursive:true, force:true});});
  const oracle = new Map();
  let aggregate = null;
  function check() {
    const state = adapter.state();
    assert.deepEqual(state.attempts.map(a => a.id).sort(), [...oracle.keys()].sort());
    for (const a of state.attempts) for (const r of a.resources) {
      const expected = oracle.get(a.id).get(r.id);
      assert.equal(r.initial_micro, r.held_micro+r.spent_micro+r.settled_micro+r.released_micro);
      for (const [key,value] of Object.entries(expected)) assert.equal(r[key], value, `${a.id}/${r.id}/${key}`);
      assert.equal(new Set(r.burns.map(b => b.id)).size, r.burns.length);
      assert.equal(r.unrepresented_micro, r.burns.filter(b => !b.represented).reduce((n,b) => n+b.amount_micro,0));
    }
    assert.equal(new Set(state.event_ids).size, state.event_ids.length);
    for (const id of ['short','weekly']) {
      const rows = state.attempts.flatMap(a => a.resources.filter(r => r.id === id));
      const represented = rows.reduce((n,r) => n+r.spent_micro-r.unrepresented_micro,0);
      if (aggregate !== null) {
        assert.ok(represented <= aggregate, `${id}: represented burn exceeds accepted aggregate`);
        const watermarks = rows.filter(r => r.aggregate_used_micro !== null);
        assert.ok(watermarks.some(r => r.aggregate_used_micro === aggregate));
      }
    }
  }
  async function reopen() {check(); const before = adapter.state(); await adapter.close(); adapter = open(); assert.deepEqual(adapter.state(),before); check();}
  async function admit(id, revision = adapter.state().revision) {
    const out = await adapter.admit({expectedRevision:revision, request:request({attempt_id:id, job_id:id, requested_usd_micro:2*MICRO})});
    if (out.admitted) {
      // The quote is an input to this oracle; subsequent movements are computed independently.
      const a = adapter.state().attempts.find(a => a.id === id);
      oracle.set(id,new Map(a.resources.map(r => [r.id,{held_micro:r.initial_micro,spent_micro:0,released_micro:0,unrepresented_micro:0}])));
    }
    return out;
  }
  async function event(e, applied = true) {
    const out = await adapter.transition({at:NOW,...e}, {expectedRevision:adapter.state().revision});
    assert.equal(out.applied,applied,JSON.stringify(out));
    return out;
  }
  return {
    deferBuilder() {
      let enter, release;
      const entered = new Promise(resolve => {enter=resolve;});
      const promise = new Promise(resolve => {release=resolve;});
      builderGate = {enter,promise};
      return {entered,release};
    },
    get builtAttemptIds() {return builtAttemptIds;},
    acceptAggregate(value) {aggregate=value;},
    setClock(value){clock=value;},armCrash(){failWrite=true;},setMeter(value){meter=value;},launches,
    async recoverReservation(id) {
      const disk = JSON.parse(fs.readFileSync(join(directory,'lending-pace50-state.json'),'utf8'));
      assert.deepEqual(disk.attempts.map(a=>a.id),[id]);
      oracle.set(id,new Map(disk.attempts[0].resources.map(r=>[r.id,{held_micro:r.initial_micro,spent_micro:0,released_micro:0,unrepresented_micro:0}])));
      await adapter.close(); adapter=open(); check(); await reopen();
    },get adapter(){return adapter;},oracle,admit,event,reopen,check};
}

for (const order of [['a','b'],['b','a']]) test(`accounting: CAS, duplicate ids, cleanup, aggregate and closure ${order}`, async t => {
  const f = await rig(t,{postingLagBoundMs:120000});
  const gate = f.deferBuilder();
  const first = f.admit('a',0);
  await gate.entered;
  const secondAtSameRevision = f.admit('b',0);
  gate.release();
  const results = await Promise.all([first,secondAtSameRevision]);
  assert.equal(results[0].admitted,true);
  assert.equal(results[1].reason,'revision_conflict');
  await f.reopen();
  assert.equal((await f.admit('a')).reason,'duplicate_attempt');
  await f.reopen();
  const second = await f.admit('b'); assert.equal(second.admitted,true,JSON.stringify(second));
  await f.reopen();
  // Preview must remove only the named hold and must never persist its filtered copy.
  const before = f.adapter.state();
  const preview = await f.adapter.preview({request:request({attempt_id:'a',requested_usd_micro:2*MICRO}),replacingAttemptId:'a'});
  assert.equal(preview.admitted,true,JSON.stringify(preview));
  assert.deepEqual(f.builtAttemptIds,['b']);
  assert.deepEqual(f.adapter.state(),before);
  await f.reopen();
  for (const id of order) {
    await f.event({type:'launch_result',event_id:`${id}:start`,attempt_id:id,result:'started'});
    await f.reopen();
    const usage = {type:'usage',event_id:`${id}:usage`,attempt_id:id,burn_id:`${id}:burn`,
      resources:f.adapter.state().attempts.find(a => a.id===id).resources.map(r => ({id:r.id,instance:r.instance,amount_micro:10_000}))};
    if (id === order[1]) {
      assert.equal((await f.event({...usage,event_id:`${id}:reused-burn`,burn_id:`${order[0]}:burn`},false)).reason,'burn_id_reused');
      await f.reopen();
    }
    await f.event(usage);
    for (const row of f.oracle.get(id).values()) {row.held_micro-=10_000;row.spent_micro+=10_000;row.unrepresented_micro+=10_000;}
    await f.reopen();
    assert.equal((await f.event(usage,false)).reason,'duplicate_event');
    await f.reopen();
    await f.event({type:'cleanup_proven',event_id:`${id}:cleanup-proven:1`,attempt_id:id,cleanup_removed:true});
    assert.equal(f.adapter.state().attempts.find(a => a.id===id).hold_closed,false);
    await f.reopen();
  }
  const resources = amount => f.adapter.state().attempts[0].resources.map(r => ({id:r.id,instance:r.instance,
    anchor_at:r.anchor_at,resets_at:r.resets_at,used_micro:amount}));
  const reconcile = (id,amount) => ({type:'reconcile_burn',event_id:`${id}:aggregate:${amount}`,attempt_id:id,burn_id:`${id}:burn`,
    account:ACCOUNT,epoch:'epoch-1',complete:true,compatible:true,refresh_succeeded:true,attribution_confirmed:true,
    observed_at:NOW,resources:resources(amount)});
  const partial = reconcile(order[0],20_000);
  partial.resources = partial.resources.slice(0,1);
  assert.equal((await f.event({...partial,event_id:'incomplete-aggregate'},false)).reason,'reconciliation_incomplete');
  await f.reopen();
  assert.equal((await f.event(reconcile(order[0],10_000),false)).reason,'reconciliation_mismatch');
  await f.reopen();
  assert.equal((await f.event(reconcile(order[0],20_000),false)).reason,'usage_coverage_unavailable');
  await f.reopen();
  assert.equal((await f.event(reconcile(order[1],20_000),false)).reason,'usage_coverage_unavailable');
  for (const id of order) {
    const before=f.adapter.state();
    assert.notEqual(before.attempts.find(a=>a.id===id).hold_closed,true);
    assert.equal((await f.event({type:'cessation_proven',event_id:`${id}:close`,attempt_id:id,
      authoritative_cessation:true,usage_reconciled:true},false)).reason,'cessation_unreconciled');
    assert.deepEqual(f.adapter.state(),before,'aggregate movement and finish leave exposure unchanged');
    await assertAdmissionCounts(f.adapter,id,request({attempt_id:`${id}:preview`,requested_usd_micro:2*MICRO}));
  }
  for(const id of order) {
    await settleOwnResets(f.adapter,id);
    for (const [resourceId,row] of f.oracle.get(id)) {
      row.spent_micro=f.adapter.state().attempts.find(a=>a.id===id).resources.find(r=>r.id===resourceId).initial_micro;
      row.held_micro=0;row.unrepresented_micro=0;row.released_micro=0;
    }
    await f.reopen();
  }

});

for (const settledUse of [0,MICRO]) test(`native reservation reduces to one step after a lag-covered reading; meter rise ${settledUse}`, async t => {
  const f = await rig(t,{native:true,postingLagBoundMs:120000});
  const first = await f.admit('a'); assert.equal(first.admitted,true,JSON.stringify(first));
  await f.reopen();
  await f.event({type:'launch_result',event_id:'a:start',attempt_id:'a',result:'started'});
  await f.reopen();
  await f.event({type:'cleanup_proven',event_id:'a:cleanup-proven:1',attempt_id:'a',cleanup_removed:true});
  await f.reopen();
  assert.equal((await f.admit('b')).reason,'native_attempt_in_flight');
  await f.reopen();
  const a = f.adapter.state().attempts[0];
  const settle = {type:'native_meter_settled',event_id:'a:native',attempt_id:'a',account:ACCOUNT,account_week_id:WEEK,epoch:'epoch-1',
    complete:true,compatible:true,refresh_succeeded:true,usage:'unknown',observed_at:NOW+120_000,at:NOW+120_000,
    resources:a.resources.map(r=>({id:r.id,instance:r.instance,anchor_at:r.anchor_at,resets_at:r.resets_at,used_micro:settledUse,uncertainty_micro:MICRO}))};
  await f.event({...settle,event_id:'a:too-early',observed_at:NOW-1},false);
  await f.reopen();
  // A fresh small rise does not cover the full reservation.
  await f.event(settle);
  for (const row of f.oracle.get('a').values()) {row.spent_micro=settledUse+MICRO;row.released_micro=Math.max(0,row.held_micro-row.spent_micro);row.held_micro=0;row.unrepresented_micro=MICRO;}
  await f.reopen();
  assert.equal(f.adapter.state().attempts[0].hold_closed,false);
  // Do not acquire an older reading after the settlement watermark.
  const coverage = {...settle,event_id:'a:covered',resources:a.resources.map(r=>({id:r.id,instance:r.instance,
    anchor_at:r.anchor_at,resets_at:r.resets_at,used_micro:r.baseline_used_micro+r.initial_micro,uncertainty_micro:MICRO}))};
  await f.event(coverage);
  for (const row of f.oracle.get('a').values()) row.unrepresented_micro=0;
  assert.equal(f.adapter.state().attempts[0].hold_closed,true);
  await f.reopen();
  f.setClock(NOW+120_000);
  f.setMeter(Object.fromEntries(coverage.resources.map(r=>[r.id,r.used_micro])));
  const next=await f.admit('b'); assert.equal(next.reason,'owner_reserve', 'coverage frees exclusivity but does not replenish an exhausted meter');
  await f.reopen();
});

for (const settledUse of [0,MICRO]) test(`native reservation remains unresolved through meter readings until its own reset; meter rise ${settledUse}`, async t => {
  const f = await rig(t,{native:true});
  const first = await f.admit('a'); assert.equal(first.admitted,true,JSON.stringify(first));
  await f.reopen();
  await f.event({type:'launch_result',event_id:'a:start',attempt_id:'a',result:'started'});
  await f.reopen();
  await f.event({type:'cleanup_proven',event_id:'a:cleanup-proven:1',attempt_id:'a',cleanup_removed:true});
  await f.reopen();
  assert.equal((await f.admit('b')).reason,'native_attempt_in_flight');
  await f.reopen();
  const a = f.adapter.state().attempts[0];
  const settle = {type:'native_meter_settled',event_id:'a:native',attempt_id:'a',account:ACCOUNT,account_week_id:WEEK,epoch:'epoch-1',
    complete:true,compatible:true,refresh_succeeded:true,usage:'unknown',observed_at:NOW+120_000,at:NOW+120_000,
    resources:a.resources.map(r=>({id:r.id,instance:r.instance,anchor_at:r.anchor_at,resets_at:r.resets_at,used_micro:settledUse,uncertainty_micro:MICRO}))};
  await f.event({...settle,event_id:'a:too-early',observed_at:NOW-1},false);
  await f.reopen();
  // A fresh small rise does not cover the full reservation.
  await f.event(settle);
  for (const row of f.oracle.get('a').values()) {row.spent_micro=MICRO;row.held_micro-=MICRO;row.unrepresented_micro=MICRO;}
  await f.reopen();
  assert.equal(f.adapter.state().attempts[0].hold_closed,false);
  f.setClock(NOW+120_000);
  f.setMeter(settledUse);
  await assertAdmissionCounts(f.adapter,'a',request({attempt_id:'held-preview',requested_usd_micro:2*MICRO}));
  // Even a rise as large as the reservation proves no interval coverage.
  const coverage = {...settle,event_id:'a:covered',resources:a.resources.map(r=>({id:r.id,instance:r.instance,
    anchor_at:r.anchor_at,resets_at:r.resets_at,used_micro:r.baseline_used_micro+r.initial_micro,uncertainty_micro:MICRO}))};
  await f.event(coverage);
  for (const [id,row] of f.oracle.get('a')) {
    row.spent_micro=a.resources.find(r=>r.id===id).initial_micro;row.held_micro=0;row.unrepresented_micro=row.spent_micro;
  }
  assert.equal(f.adapter.state().attempts[0].hold_closed,false);
  assert.deepEqual(exposure(f.adapter.state().attempts[0]),a.resources.map(r=>r.initial_micro));
  await f.reopen();
  f.setMeter(Object.fromEntries(coverage.resources.map(r=>[r.id,r.used_micro])));
  const next=await f.admit('b'); assert.equal(next.reason,'native_attempt_in_flight', 'an aggregate rise leaves unresolved exposure in admission');
  await f.reopen();
  await settleOwnResets(f.adapter,'a');
  for(const row of f.oracle.get('a').values())row.unrepresented_micro=0;
  await f.reopen();
  f.setClock(f.adapter.state().updated_at);f.setMeter(0);
  assert.equal((await f.admit('b')).admitted,true,'the reset restores admission with fresh unused windows');
  await f.reopen();
});

test('unstarted cessation without cleanup or absence proof stays held after reopening', async t => {
  const f=await rig(t);
  assert.equal((await f.admit('a')).admitted,true);
  const before=f.adapter.state();
  const refused=await f.event({type:'cessation_proven',event_id:'a:unproven',attempt_id:'a',
    authoritative_cessation:true,usage_reconciled:true,zero_use_attested:true},false);
  assert.equal(refused.reason,'usage_unknown');
  assert.deepEqual(f.adapter.state(),before);
  assert.notEqual(before.attempts[0].hold_closed,true);
  await assertAdmissionCounts(f.adapter,'a',request({attempt_id:'a:preview',requested_usd_micro:2*MICRO}));
  await f.reopen();
});

test('affirmative unstarted cessation releases its vector with durable no-dispatch proof', {skip:'no-dispatch rebase has not supplied the durable stamp path'}, async t => {
  const f = await rig(t);
  assert.equal((await f.admit('a')).admitted,true);
  await f.reopen();
  await f.event({type:'cessation_proven',event_id:'a:unstarted',attempt_id:'a',authoritative_cessation:true,usage_reconciled:true,zero_use_attested:true,absence_proven:true});
  for (const row of f.oracle.get('a').values()) {row.released_micro=row.held_micro;row.held_micro=0;}
  await f.reopen();
});

test('an unstarted cessation without zero_use_attested reports usage_unknown and the hold survives a reopen',async t=>{
  const f=await rig(t);
  assert.equal((await f.admit('a')).admitted,true);
  await f.reopen();
  const before=f.adapter.state();
  const refused=await f.event({type:'cessation_proven',event_id:'a:unattested',attempt_id:'a',
    authoritative_cessation:true,usage_reconciled:true},false);
  assert.equal(refused.reason,'usage_unknown');
  assert.deepEqual(f.adapter.state(),before,'the refused event changes nothing');
  await f.reopen();
  const attempt=f.adapter.state().attempts[0];
  assert.notEqual(attempt.hold_closed,true);
  assert.ok(attempt.resources.every(r=>r.held_micro===r.initial_micro&&r.released_micro===0),'the whole reservation stays held');
});

test('crash after renamed reservation retains liability and never dispatches it on reopen', async t => {
  const f = await rig(t);
  f.armCrash();
  await assert.rejects(f.admit('a'),{code:'pace50_persist_failed'});
  assert.deepEqual(f.launches,[]);
  assert.throws(()=>f.adapter.state(),{code:'pace50_store_poisoned'});
  await f.recoverReservation('a');
  assert.deepEqual(f.launches,[]);
  assert.equal((await f.admit('a')).reason,'duplicate_attempt');
  await f.reopen();
  assert.deepEqual(f.launches,[]);
});


test('native coverage without the measured bound retains its reservation after reopen',async t=>{
 const f=await rig(t,{native:true});assert.equal((await f.admit('a')).admitted,true);
 await f.event({type:'launch_result',event_id:'a:start',attempt_id:'a',result:'started'});
 await f.event({type:'cleanup_proven',event_id:'a:cleanup-proven:1',attempt_id:'a',cleanup_removed:true});
 const a=f.adapter.state().attempts[0];
 await f.event({type:'native_meter_settled',event_id:'a:no-bound',attempt_id:'a',account:ACCOUNT,account_week_id:WEEK,epoch:a.epoch,
  complete:true,compatible:true,refresh_succeeded:true,observed_at:NOW+120000,at:NOW+120000,
  resources:a.resources.map(r=>({id:r.id,instance:r.instance,anchor_at:r.anchor_at,resets_at:r.resets_at,used_micro:MICRO}))},false);
 await f.reopen();assert.deepEqual(f.adapter.state().attempts[0].resources,a.resources);
});
