import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {NOW, ACCOUNT, WEEK} from './helpers/pace50-fixtures.mjs';

// Independent oracle: no production rate, headroom, settlement or sum helpers.
function oracle() {
  return {at:NOW, readingAt:NOW, measured:{weekly:20_000_000, short:40_000_000},
    owner:{weekly:20_000_000, short:40_000_000}, borrower:{weekly:0, short:0},
    valid:{weekly:false, short:false},
    room(kind) {return this.valid[kind] ? Math.max(0, 100_000_000-this.owner[kind]-this.borrower[kind]) : 0;}};
}
function fixture(t, o, native = false) {
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'exposure-replay-'));
  const source = createSyntheticPace50Source({start:NOW, override:({base}) => ({...base,
    observed_at:o.readingAt, resources:base.resources.map(r => ({...r, observed_at:o.readingAt,
      used_micro:o.measured[r.kind], owner_used_micro:o.measured[r.kind],
      ...(native ? {conversion:'native_window', kappa_micro:null, kappa_lower_micro:null} : {})}))})});
  const pace = createPace50Candidate({directory, source, now:() => o.at, account:ACCOUNT, account_week_id:WEEK});
  t.after(async () => {
    await pace.candidate.cancelObservations();
    await pace.adapter.close();
    fs.rmSync(directory, {recursive:true, force:true});
  });
  return {...pace, source};
}
const reserve = (p,id) => p.candidate.reserve({attemptId:id, jobId:id, provider:'claude', model:'claude-haiku-5-5',
  automatic:true, ownerAbsent:true, job:{budget_v1:{max_list_usd:2}, requirements:{limits:{wall_seconds:300}},
    expires_at:new Date(NOW+86400e3).toISOString()}});
function rows(p,id) {return p.adapter.state().attempts.find(a => a.id===id).resources;}

test('estimate boundary: owner burst after acquisition passes reserve and own recheck above hard room', async t => {
  const o = oracle(), p = fixture(t,o);
  assert.deepEqual(['weekly','short'].map(k => o.room(k)), [0,0], 'unknown envelopes prove no room');
  assert.equal(p.adapter.state().attempts.length, 0);
  // Hold delivery after acquisition while the independent owner clock advances.
  let deliver, acquired;
  const waiting = new Promise(resolve => { acquired = resolve; });
  const gate = new Promise(resolve => { deliver = resolve; });
  const observe = p.source.observe.bind(p.source);
  p.source.observe = async args => {
    const reading = await observe(args);
    acquired();
    await gate;
    return reading;
  };
  const pending = reserve(p,'burst');
  await waiting;
  assert.equal(p.adapter.state().attempts.length, 0, 'no reservation before delivery');
  o.at += 30_000;
  o.owner.short = 100_000_000;
  assert.equal(o.measured.short, 40_000_000);
  assert.equal(o.readingAt, NOW);
  assert.equal(o.room('short'), 0);
  deliver();
  const grant = await pending;
  assert.equal(grant.ok, true, JSON.stringify(grant));
  for (const r of rows(p,'burst')) {
    assert.ok(r.held_micro > o.room(r.kind), 'expected violation: estimate is not a hard certificate');
    assert.equal(r.baseline_used_micro, o.measured[r.kind]);
  }
  assert.equal((await p.candidate.admitStart('burst')).ok, true);
  assert.equal(o.owner.short, 100_000_000);
  assert.ok(rows(p,'burst').find(r => r.kind==='short').held_micro > 0);
});

test('per-limit boundary: exhausted short meter refuses although weekly has room', async t => {
  const o = oracle();
  o.measured.short = o.owner.short = 100_000_000;
  const p = fixture(t,o);
  const grant = await reserve(p,'short-full');
  assert.equal(grant.ok, false, JSON.stringify(grant));
  assert.equal(p.adapter.state().attempts.length, 0);
  assert.equal(o.measured.weekly, 20_000_000);
});

for (const fullRise of [false,true]) test(`native exposure: ${fullRise ? 'full meter rise' : 'partial meter rise'} retains the envelope`, async t => {
  const o = oracle(), p = fixture(t,o,true), id = 'first';
  const grant = await reserve(p,id);
  assert.equal(grant.ok,true,JSON.stringify(grant));
  const maxima = rows(p,id).map(r => r.initial_micro);
  assert.ok(maxima.every(n => n >= 800_000));
  assert.equal((await p.candidate.admitStart(id)).ok,true);
  await p.candidate.started(id,{ok:true});
  o.borrower.weekly = o.borrower.short = 800_000;
  assert.ok(o.borrower.weekly<=maxima[0]&&o.borrower.short<=maxima[1]);
  await p.candidate.recordCleanup(id,{removed:true});
  await p.candidate.probeHeld();
  assert.equal(p.adapter.state().attempts[0].hold_closed,false, 'no early refund');
  o.at += 121_000;
  if (fullRise) {
    // A full aggregate rise still has no interval-coverage proof.
    for (const r of rows(p,id)) o.measured[r.kind] = r.baseline_used_micro + r.initial_micro;
  }
  o.readingAt = o.at;
  await p.candidate.probeHeld();
  let attempt = p.adapter.state().attempts[0];
  assert.ok(attempt.resources.every(r => r.spent_micro >= 1_000_000), 'floor is charged');
  assert.equal(attempt.hold_closed,false);
  assert.deepEqual(attempt.resources.map(r => r.held_micro+r.unrepresented_micro),maxima,
    'the partial or full aggregate rise does not reduce the original envelope');
  assert.ok(attempt.resources.every(r => r.released_micro===0));
  if(!fullRise){
    for (const r of attempt.resources) o.measured[r.kind] = r.baseline_used_micro+r.initial_micro;
    o.at += 1_000; o.readingAt = o.at;
    await p.candidate.probeHeld();
    attempt = p.adapter.state().attempts[0];
    assert.equal(attempt.hold_closed,false);
    assert.deepEqual(attempt.resources.map(r => r.held_micro+r.unrepresented_micro),maxima);
  } else {
    // One more aggregate step cannot stand in for a coverage watermark.
    for(const r of attempt.resources)o.measured[r.kind]+=1_000_000;
    o.at+=1_000;o.readingAt=o.at;await p.candidate.probeHeld();
    attempt=p.adapter.state().attempts[0];
  }
  assert.equal(attempt.hold_closed,false,JSON.stringify(attempt));
  assert.deepEqual(attempt.resources.map(r => r.held_micro+r.unrepresented_micro),maxima);
  assert.equal((await reserve(p,'second')).ok,false,'the unresolved hold blocks another job');
});
