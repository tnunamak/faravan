import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
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
    const input = ordinaryInput({now, windows:ordinaryInput({now}).windows.map(w => ({...w, used_micro:typeof meter === 'number' ? meter : meter[w.id], kappa_micro:native ? null : 10_000, ...(native ? {conversion:'native_window'} : {})}))});
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

test('affirmative unstarted cessation releases its vector with durable no-dispatch proof', {skip:'no-dispatch rebase has not supplied the durable stamp path'}, async t => {
  const f = await rig(t);
  assert.equal((await f.admit('a')).admitted,true);
  await f.reopen();
  await f.event({type:'cessation_proven',event_id:'a:unstarted',attempt_id:'a',authoritative_cessation:true,usage_reconciled:true});
  for (const row of f.oracle.get('a').values()) {row.released_micro=row.held_micro;row.held_micro=0;}
  await f.reopen();
});

// Measured bound. An unstarted reservation with no zero-use attestation and no cleanup or absence proof carries unknown
// usage: the cessation is refused unchanged, the hold survives a reopen, and only its durable deadline closes it.
test('unstarted cessation retains through reopen and closes at its cessation bound', async t => {
  const f=await rig(t,{postingLagBoundMs:120000});assert.equal((await f.admit('a')).admitted,true);
  await f.reopen();
  const before=f.adapter.state();
  const refused=await f.event({type:'cessation_proven',event_id:'a:unstarted',attempt_id:'a',authoritative_cessation:true,usage_reconciled:true},false);
  assert.equal(refused.reason,'usage_unknown');
  assert.deepEqual(f.adapter.state(),before,'the refused cessation changes nothing');
  assert.equal(executionProvenAbsent(f.adapter.state().attempts[0]),false);
  await f.reopen();
  const original=f.adapter.state().attempts[0];
  assert.ok(original.resources.every(r=>r.held_micro===r.initial_micro),'the hold survives the reopen');
  assert.notEqual(original.hold_closed,true);
  // Without a durable cessation proof no deadline exists, so a reset event alone must not release. The bare physical
  // cessation records the bound and reconciles no usage.
  f.setClock(NOW+1);
  await f.event({type:'cessation_proven',event_id:'a:bare',at:NOW+1,attempt_id:'a',authoritative_cessation:true});
  await f.reopen();
  for(const resource of [...f.adapter.state().attempts[0].resources].sort((a,b)=>Math.max(a.resets_at,NOW+1+a.duration_ms)-Math.max(b.resets_at,NOW+1+b.duration_ms))){
    const at=Math.max(resource.resets_at,NOW+1+resource.duration_ms);f.setClock(at);
    await f.event({type:'window_reset_settled',event_id:`a:bound:${resource.id}`,at,attempt_id:'a',authoritative_cessation:true,resource_ids:[resource.id]});
    // Only the settled window is charged in full; a window still open stays held until its own durable bound.
    const row=f.oracle.get('a').get(resource.id);
    row.spent_micro+=row.held_micro;row.held_micro=0;row.unrepresented_micro=0;
    await f.reopen();
  }
  assert.equal(f.adapter.state().attempts[0].hold_closed,true);
});
