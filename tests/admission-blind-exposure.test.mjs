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
    borrower:{weekly:0, short:0}};
}
function fixture(t, o) {
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'exposure-replay-'));
  const source = createSyntheticPace50Source({start:NOW, override:({base}) => ({...base,
    observed_at:o.readingAt, resources:base.resources.map(r => ({...r, observed_at:o.readingAt,
      used_micro:o.measured[r.kind], owner_used_micro:o.measured[r.kind], uncertainty_micro:o.step??1_000_000,
      ...(r.kind==='short'&&o.nextShort ? {instance:'next-short', anchor_at:o.nextShort, resets_at:o.nextShort+5*3600000} : {}),
      conversion:'native_window', kappa_micro:null, kappa_lower_micro:null}))})});
  const build = source.objectiveInputFor;
  source.objectiveInputFor = args => ({...build(args), strategy:'fixed_share', strategyParams:{fixedSharePct:20, keepPct:0, perJobPct:o.perJobPct??2}});
  let pace = createPace50Candidate({directory, source, now:() => o.at, account:ACCOUNT, account_week_id:WEEK});
  t.after(async () => {
    await pace.candidate.cancelObservations();
    await pace.adapter.close();
    fs.rmSync(directory, {recursive:true, force:true});
  });
  const reopen = async () => {
    await pace.candidate.cancelObservations(); await pace.adapter.close();
    pace = createPace50Candidate({directory, source, now:() => o.at, account:ACCOUNT, account_week_id:WEEK});
    return {...pace, source, reopen, directory};
  };
  return {...pace, source, reopen, directory};
}
const reserve = (p,id,provider='claude') => p.candidate.reserve({attemptId:id, jobId:id, provider, model:'claude-haiku-5-5',
  automatic:true, ownerAbsent:true, job:{budget_v1:{max_list_usd:2}, requirements:{limits:{wall_seconds:300}},
    expires_at:new Date(NOW+86400e3).toISOString()}});
function rows(p,id) {return p.adapter.state().attempts.find(a => a.id===id).resources;}

// Ported from PR #244: the oracle tracks real spend independently of reading acquisition.
for (const mode of ['never', 'covers', 'reset', 'restart', 'reset_then_cover']) test(`native sequential exposure: ${mode}`, async t => {
  const o = oracle();
  let p = fixture(t,o);
  const B = 1_000_000;
  let represented = 0;
  for (const id of ['first','second']) {
    const grant = await reserve(p,id);
    if(id==='second') {
      assert.equal(grant.ok,false,'the next job is refused while the first envelope remains unresolved');
      assert.equal(grant.policyReason,'cross_window_exposure_unreconciled');
      break;
    }
    assert.equal(grant.ok,true,JSON.stringify(grant));
    const maxima = rows(p,id).map(r=>r.held_micro);
    const envelope = rows(p,id).map(r=>r.initial_micro);
    assert.ok(maxima.every(n=>n>=800_000));
    assert.equal((await p.candidate.admitStart(id)).ok,true);
    await p.candidate.started(id,{ok:true});
    o.borrower.weekly += 800_000; o.borrower.short += 800_000;
    assert.ok(o.borrower.short-represented <= (id==='first'?1:2)*B, 'each job retains its own step');
    await p.candidate.recordCleanup(id,{removed:true});
    await p.candidate.probeHeld();
    assert.equal(p.adapter.state().attempts.find(a=>a.id===id).hold_closed,false);
    o.at += 121_000; o.readingAt = o.at;
    await p.candidate.probeHeld();
    let attempt = p.adapter.state().attempts.find(a=>a.id===id);
    assert.equal(attempt.hold_closed,false, 'acquisition time is not provider coverage');
    assert.deepEqual(attempt.resources.map(r=>r.held_micro+r.unrepresented_micro), envelope,
      'post-delay reading retains the original unresolved envelope');
    assert.ok(attempt.resources.every(r=>r.spent_micro>=1_000_000), 'floor charge is preserved');
    if (mode==='restart') p = await p.reopen();
    for(let retry=0;retry<3;retry++) {
      o.at += 121_000; o.readingAt=o.at;
      await p.candidate.probeHeld();
      assert.deepEqual(rows(p,id).map(r=>r.held_micro+r.unrepresented_micro), envelope,
        'an unchanged fresh reading does not reduce exposure');
    }
    if(mode==='never') break;
    if(mode==='reset'||mode==='reset_then_cover') {
      o.at=attempt.resources.find(r=>r.kind==='short').resets_at;o.readingAt=o.at;
      await p.candidate.probeHeld();
      attempt=p.adapter.state().attempts.find(a=>a.id===id);
      assert.equal(attempt.resources.find(r=>r.kind==='short').unrepresented_micro,0);
      const weekly = attempt.resources.find(r=>r.kind==='weekly');
      assert.equal(weekly.held_micro+weekly.unrepresented_micro,weekly.initial_micro);
      assert.equal(attempt.hold_closed,false, 'each limit clears at its own reset');
      if(mode==='reset_then_cover') {
        p=await p.reopen();
        const weekly=attempt.resources.find(r=>r.kind==='weekly');
        o.measured.weekly=weekly.baseline_used_micro+weekly.initial_micro;
        o.at+=1_000;o.readingAt=o.at;o.nextShort=o.at;
        await p.candidate.probeHeld();
        attempt=p.adapter.state().attempts.find(a=>a.id===id);
        assert.equal(attempt.hold_closed,false,'aggregate coverage does not clear the weekly envelope');
        assert.equal(attempt.resources.find(r=>r.kind==='weekly').held_micro+
          attempt.resources.find(r=>r.kind==='weekly').unrepresented_micro,weekly.initial_micro);
        o.at=attempt.resources.find(r=>r.kind==='weekly').resets_at;o.readingAt=o.at;
        await p.candidate.probeHeld();
        attempt=p.adapter.state().attempts.find(a=>a.id===id);
        assert.equal(attempt.hold_closed,true,'the weekly reset settles its own remaining exposure');
        assert.ok(attempt.resources.every(r=>r.held_micro===0&&r.unrepresented_micro===0));
        break;
      }
      o.at=Math.max(...attempt.resources.map(r=>r.resets_at));o.readingAt=o.at;
      await p.candidate.probeHeld();
      attempt=p.adapter.state().attempts.find(a=>a.id===id);
      assert.ok(attempt.resources.every(r=>r.held_micro===0&&r.unrepresented_micro===0));
      assert.equal(attempt.hold_closed,true);
      break;
    }
    if(mode==='covers') {
      const weekly=attempt.resources.find(r=>r.kind==='weekly');
      o.measured.weekly=weekly.baseline_used_micro+weekly.initial_micro;
      o.at+=1_000;o.readingAt=o.at;
      await p.candidate.probeHeld();
      attempt=p.adapter.state().attempts.find(a=>a.id===id);
      assert.equal(weekly.held_micro+weekly.unrepresented_micro,weekly.initial_micro);
      assert.equal(attempt.hold_closed,false, 'aggregate movement cannot release either limit');
    }
    // Cover the full reserved envelope, including any spend that could have been hidden.
    for(const r of attempt.resources) o.measured[r.kind]=r.baseline_used_micro+r.initial_micro;
    o.at+=1_000;o.readingAt=o.at;
    await p.candidate.probeHeld();
    attempt=p.adapter.state().attempts.find(a=>a.id===id);
    assert.equal(attempt.hold_closed,false,'aggregate movement does not close the attempt');
    assert.ok(attempt.resources.every(r=>r.held_micro+r.unrepresented_micro===r.initial_micro));
    represented=o.borrower.short;
    if(id==='first') {
      o.at=attempt.resources.find(r=>r.kind==='short').resets_at+1;
      o.nextShort=o.at; o.readingAt=o.at; o.measured.short=40_000_000;
    }
  }
});

test('independent exposure oracle: unchanged meters retain the envelope and refuse the next job', async t => {
  const o=oracle(), p=fixture(t,o);
  assert.equal((await reserve(p,'first')).ok,true);
  const envelope=rows(p,'first').map(r=>r.initial_micro);
  await p.candidate.started('first',{ok:true});
  o.borrower.weekly+=300_000;o.borrower.short+=300_000;
  await p.candidate.recordCleanup('first',{removed:true});
  o.at+=121_000;o.readingAt=o.at;
  await p.candidate.probeHeld();
  assert.deepEqual(rows(p,'first').map(r=>r.held_micro+r.unrepresented_micro),envelope);
  for(const kind of ['weekly','short']) {
    const resources=p.adapter.state().attempts.flatMap(a=>a.resources).filter(r=>r.kind===kind);
    const retained=resources.reduce((sum,r)=>sum+r.held_micro+r.unrepresented_micro,0);
    assert.ok(retained>=o.borrower[kind]);
    assert.equal(retained,resources.reduce((sum,r)=>sum+r.initial_micro,0));
  }
  // A single rise cannot erase the original unresolved envelope.
  o.at+=1_000;o.readingAt=o.at;o.measured.weekly+=1_000_000;o.measured.short+=1_000_000;
  await p.candidate.probeHeld();
  const before=p.adapter.state().revision;
  await p.candidate.probeHeld();
  assert.equal(p.adapter.state().revision,before,'insufficient aggregate coverage never repeats durable writes');
  assert.ok(p.adapter.state().attempts.every(a=>a.resources.every(r=>r.held_micro+r.unrepresented_micro===r.initial_micro)));
  assert.equal((await reserve(p,'second')).ok,false,'the unresolved envelope blocks another job');
});

test('large meter rises stay unresolved after cleanup and restart', async t => {
 const o=oracle(),p=fixture(t,o);
 assert.equal((await reserve(p,'large')).ok,true);
 const envelope=rows(p,'large').map(r=>r.initial_micro);
 await p.candidate.started('large',{ok:true});
 await p.candidate.recordCleanup('large',{removed:true});
 o.at+=121_000;o.readingAt=o.at;o.measured.weekly+=40_000_000;o.measured.short+=40_000_000;
 await p.candidate.probeHeld();
 assert.deepEqual(rows(p,'large').map(r=>r.held_micro+r.unrepresented_micro),envelope);
 assert.equal(p.adapter.state().attempts[0].hold_closed,false);
 const spent=rows(p,'large').map(r=>r.spent_micro);
 o.at+=1_000;o.readingAt=o.at;o.measured.weekly+=1_000_000;o.measured.short+=1_000_000;
 await p.candidate.probeHeld();
 assert.deepEqual(rows(p,'large').map(r=>r.held_micro+r.unrepresented_micro),envelope,
   'a further aggregate rise cannot release the original envelope');
 assert.ok(rows(p,'large').every(r=>r.released_micro===0));
 assert.ok(rows(p,'large').every((r,i)=>r.spent_micro>=spent[i]));
});

for(const provider of ['claude','codex']) test(`${provider}: legacy 65.8-point hold re-settles on restart without guard usage`, async t => {
 const o=oracle();o.measured.weekly=33_000_000;
 let p=fixture(t,o);
 assert.equal((await reserve(p,'legacy',provider)).ok,true);
 await p.candidate.started('legacy',{ok:true});
 await p.candidate.recordCleanup('legacy',{removed:true});
 await p.candidate.cancelObservations();await p.adapter.close();
 const file=join(p.directory,'lending-pace50-state.json');
 const state=JSON.parse(fs.readFileSync(file,'utf8'));
 const a=state.attempts[0];a.usage_unknown=provider;
 const r=a.resources.find(r=>r.kind==='weekly');
 Object.assign(r,{baseline_used_micro:33_000_000,initial_micro:65_778_689,spent_micro:2_000_000,
  held_micro:63_778_689,unrepresented_micro:2_000_000,released_micro:0,settled_micro:0,
  burns:[{id:'legacy-floor',amount_micro:2_000_000,at:NOW,represented:false}]});
 fs.writeFileSync(file,JSON.stringify(state));
 const envelope=rows(p,'legacy').map(r=>r.initial_micro);
 p=await p.reopen();
 o.at+=121_000;o.readingAt=o.at;
 await p.candidate.probeHeld();
 assert.deepEqual(rows(p,'legacy').map(r=>r.held_micro+r.unrepresented_micro),envelope);
 assert.equal(p.adapter.state().attempts[0].hold_closed,false);
});

test('unproven cleanup keeps every reserved point through delay and restart', async t => {
 const o=oracle();let p=fixture(t,o);
 assert.equal((await reserve(p,'live')).ok,true);
 await p.candidate.started('live',{ok:true});
 const before=rows(p,'live').map(r=>r.held_micro);
 o.at+=121_000;o.readingAt=o.at;p=await p.reopen();
 await p.candidate.probeHeld();
 assert.deepEqual(rows(p,'live').map(r=>r.held_micro),before);
 assert.ok(rows(p,'live').every(r=>r.native_release_used_micro===undefined));
});

test('the delay boundary does not release the native exposure', async t => {
 const o=oracle();o.step=250_000;const p=fixture(t,o);
 assert.equal((await reserve(p,'quarter-step')).ok,true);
 await p.candidate.started('quarter-step',{ok:true});
 await p.candidate.recordCleanup('quarter-step',{removed:true});
 const before=rows(p,'quarter-step').map(r=>r.held_micro+r.unrepresented_micro);
 o.at+=119_999;o.readingAt=o.at;
 await p.candidate.probeHeld();
 assert.deepEqual(rows(p,'quarter-step').map(r=>r.held_micro+r.unrepresented_micro),before);
 o.at+=1;o.readingAt=o.at;
 await p.candidate.probeHeld();
 assert.deepEqual(rows(p,'quarter-step').map(r=>r.held_micro+r.unrepresented_micro),before);
 assert.ok(rows(p,'quarter-step').every(r=>r.released_micro===0));
 assert.equal(p.adapter.state().attempts[0].hold_closed,false);
});

test('one aggregate rise cannot close a cleaned-up native hold across restart', async t => {
 const o=oracle();let p=fixture(t,o);
 assert.equal((await reserve(p,'a')).ok,true);
 const envelope=rows(p,'a').map(r=>r.initial_micro);
 await p.candidate.started('a',{ok:true});
 await p.candidate.recordCleanup('a',{removed:true});
 o.at+=121_000;o.readingAt=o.at;await p.candidate.probeHeld();
 o.at+=1_000;o.readingAt=o.at;o.measured.weekly+=2_000_000;o.measured.short+=2_000_000;
 await p.candidate.probeHeld();
 assert.equal(p.adapter.state().attempts[0].hold_closed,false,'aggregate movement cannot close the attempt');
 assert.deepEqual(rows(p,'a').map(r=>r.held_micro+r.unrepresented_micro),envelope);
 assert.equal((await reserve(p,'b')).ok,false,'the unresolved hold blocks another job');
 p=await p.reopen();const before=p.adapter.state().revision;
 await p.candidate.probeHeld();
 assert.equal(p.adapter.state().revision,before,'an unchanged aggregate reading causes no durable rewrite');
 assert.equal(p.adapter.state().attempts[0].hold_closed,false);
 assert.deepEqual(rows(p,'a').map(r=>r.held_micro+r.unrepresented_micro),envelope);
});

for(const rise of [0,40_000_000]) test(`a sub-step charge retains a full step of exposure (rise ${rise})`, async t => {
 const o=oracle();o.perJobPct=0.3;let p=fixture(t,o);
 assert.equal((await reserve(p,'small')).ok,true);
 const initial=rows(p,'small').find(r=>r.kind==='weekly').initial_micro;
 assert.equal(initial,300_000);
 await p.candidate.started('small',{ok:true});await p.candidate.recordCleanup('small',{removed:true});
 o.at+=121_000;o.readingAt=o.at;o.measured.weekly+=rise;o.measured.short+=rise;
 await p.candidate.probeHeld();
 const weekly=rows(p,'small').find(r=>r.kind==='weekly');
 assert.equal(weekly.spent_micro,300_000,'the charge remains capped');
 assert.equal(weekly.held_micro+weekly.unrepresented_micro,initial,'the residual remains the full original envelope');
 p=await p.reopen();assert.equal(rows(p,'small').find(r=>r.kind==='weekly').held_micro+
   rows(p,'small').find(r=>r.kind==='weekly').unrepresented_micro,initial);
 // Aggregate movement does not cover the uncertainty envelope.
 o.at+=1_000;o.readingAt=o.at;o.measured.weekly+=300_000;o.measured.short+=300_000;
 await p.candidate.probeHeld();assert.equal(rows(p,'small').find(r=>r.kind==='weekly').held_micro+
   rows(p,'small').find(r=>r.kind==='weekly').unrepresented_micro,initial);
 o.at+=1_000;o.readingAt=o.at;o.measured.weekly+=700_000;o.measured.short+=700_000;
 await p.candidate.probeHeld();
 assert.equal(p.adapter.state().attempts[0].hold_closed,false);
 assert.equal(rows(p,'small').find(r=>r.kind==='weekly').held_micro+
   rows(p,'small').find(r=>r.kind==='weekly').unrepresented_micro,initial);
 assert.equal(rows(p,'small').find(r=>r.kind==='weekly').spent_micro,300_000);
});

for(const declaredStep of [1_000_000,2_000_000]) test(`a settlement reading cannot lower the admission step ${declaredStep}`, async t => {
 const o=oracle();o.step=declaredStep;const p=fixture(t,o);
 assert.equal((await reserve(p,'fixed-step')).ok,true);
 await p.candidate.started('fixed-step',{ok:true});await p.candidate.recordCleanup('fixed-step',{removed:true});
 const initial=rows(p,'fixed-step').map(r=>r.initial_micro);
 o.at+=121_000;o.readingAt=o.at;o.step=declaredStep===2_000_000?1_000_000:250_000;
 await p.candidate.probeHeld();
 assert.deepEqual(rows(p,'fixed-step').map(r=>r.held_micro+r.unrepresented_micro),initial,
   'a smaller step cannot reduce the original exposure');
 o.step=declaredStep;await p.candidate.probeHeld();
 assert.deepEqual(rows(p,'fixed-step').map(r=>r.held_micro+r.unrepresented_micro),initial);
});

test('older durable records cannot authorize a smaller step after upgrade', async t => {
 const o=oracle();let p=fixture(t,o);
 assert.equal((await reserve(p,'legacy-step')).ok,true);
 await p.candidate.started('legacy-step',{ok:true});await p.candidate.recordCleanup('legacy-step',{removed:true});
 await p.candidate.cancelObservations();await p.adapter.close();
 const file=join(p.directory,'lending-pace50-state.json');const state=JSON.parse(fs.readFileSync(file));
 for(const r of state.attempts[0].resources)delete r.meter_step_micro;
 fs.writeFileSync(file,JSON.stringify(state));p=await p.reopen();
 const initial=rows(p,'legacy-step').map(r=>r.initial_micro);
 o.at+=121_000;o.readingAt=o.at;o.step=250_000;
 await p.candidate.probeHeld();assert.deepEqual(rows(p,'legacy-step').map(r=>r.held_micro+r.unrepresented_micro),initial);
 o.step=1_000_000;await p.candidate.probeHeld();
 assert.deepEqual(rows(p,'legacy-step').map(r=>r.held_micro+r.unrepresented_micro),initial);
});

test('upgrade repairs a previously reduced sub-step exposure without another charge', async t => {
 const o=oracle();o.perJobPct=0.3;let p=fixture(t,o);
 assert.equal((await reserve(p,'legacy-small')).ok,true);
 await p.candidate.started('legacy-small',{ok:true});await p.candidate.recordCleanup('legacy-small',{removed:true});
 o.at+=121_000;o.readingAt=o.at;await p.candidate.probeHeld();
 await p.candidate.cancelObservations();await p.adapter.close();
 const file=join(p.directory,'lending-pace50-state.json');const state=JSON.parse(fs.readFileSync(file));
 const r=state.attempts[0].resources.find(r=>r.kind==='weekly');
 delete r.meter_step_micro;for(const b of r.burns)delete b.exposure_micro;r.unrepresented_micro=300_000;
 fs.writeFileSync(file,JSON.stringify(state));p=await p.reopen();
 await p.candidate.probeHeld();
 const weekly=rows(p,'legacy-small').find(r=>r.kind==='weekly');
 assert.equal(weekly.held_micro+weekly.unrepresented_micro,weekly.initial_micro);
 assert.equal(rows(p,'legacy-small').find(r=>r.kind==='weekly').spent_micro,300_000);
});
