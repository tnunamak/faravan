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
  let pace = createPace50Candidate({postingLagBoundMs:120000,directory, source, now:() => o.at, account:ACCOUNT, account_week_id:WEEK});
  t.after(async () => {
    await pace.candidate.cancelObservations();
    await pace.adapter.close();
    fs.rmSync(directory, {recursive:true, force:true});
  });
  const reopen = async () => {
    await pace.candidate.cancelObservations(); await pace.adapter.close();
    pace = createPace50Candidate({postingLagBoundMs:120000,directory, source, now:() => o.at, account:ACCOUNT, account_week_id:WEEK});
    return {...pace, source, reopen, directory};
  };
  return {...pace, source, reopen, directory};
}
const reserve = (p,id,provider='claude') => p.candidate.reserve({attemptId:id, jobId:id, provider, model:'claude-haiku-5-5',
  automatic:true, ownerAbsent:true, job:{budget_v1:{max_list_usd:2}, requirements:{limits:{wall_seconds:300}},
    expires_at:new Date(NOW+86400e3).toISOString()}});
function rows(p,id) {return p.adapter.state().attempts.find(a => a.id===id).resources;}

// Ported from PR #244: the oracle tracks real spend independently of reading acquisition.
test('PR 244/249 oracle: unchanged meters retain one step for each sequential job', async t => {
  const o=oracle(), p=fixture(t,o), B=1_000_000;
  for(const id of ['first','second','third']) {
    assert.equal((await reserve(p,id)).ok,true);
    await p.candidate.started(id,{ok:true});
    o.borrower.weekly+=300_000;o.borrower.short+=300_000;
    await p.candidate.recordCleanup(id,{removed:true});
    o.at+=121_000;o.readingAt=o.at;
    await p.candidate.probeHeld();
    for(const kind of ['weekly','short']) {
      const retained=p.adapter.state().attempts.flatMap(a=>a.resources).filter(r=>r.kind===kind)
        .reduce((sum,r)=>sum+r.held_micro+r.unrepresented_micro,0);
      assert.ok(retained>=o.borrower[kind]);
      assert.equal(retained,p.adapter.state().attempts.length*B);
    }
  }
  // A single rise cannot erase three accumulated uncertainty steps.
  o.at+=1_000;o.readingAt=o.at;o.measured.weekly+=1_000_000;o.measured.short+=1_000_000;
  await p.candidate.probeHeld();
  const before=p.adapter.state().revision;
  await p.candidate.probeHeld();
  assert.equal(p.adapter.state().revision,before,'insufficient aggregate coverage never repeats durable writes');
  assert.ok(p.adapter.state().attempts.every(a=>a.resources.every(r=>r.unrepresented_micro===B)));
  // No room for the next reservation once the aggregate meter consumes the headroom.
  o.measured.weekly=99_000_000;o.measured.short=99_000_000;o.readingAt=o.at;
  assert.equal((await reserve(p,'too-large')).ok,false);
});

test('forty shown steps leave one uncertainty step; later aggregate coverage clears it', async t => {
 const o=oracle(),p=fixture(t,o);
 assert.equal((await reserve(p,'large')).ok,true);
 await p.candidate.started('large',{ok:true});
 await p.candidate.recordCleanup('large',{removed:true});
 o.at+=121_000;o.readingAt=o.at;o.measured.weekly+=40_000_000;o.measured.short+=40_000_000;
 await p.candidate.probeHeld();
 assert.ok(rows(p,'large').every(r=>r.held_micro===0&&r.unrepresented_micro===1_000_000));
 const spent=rows(p,'large').map(r=>r.spent_micro);
 o.at+=1_000;o.readingAt=o.at;o.measured.weekly+=1_000_000;o.measured.short+=1_000_000;
 await p.candidate.probeHeld();
 assert.ok(rows(p,'large').every(r=>r.unrepresented_micro===0));
 assert.deepEqual(rows(p,'large').map(r=>r.spent_micro),spent,'later jobs never recharge old work');
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
 p=await p.reopen();
 o.at+=121_000;o.readingAt=o.at;
 await p.candidate.probeHeld();
 assert.ok(rows(p,'legacy').every(r=>r.held_micro===0&&r.unrepresented_micro===(r.kind==='weekly'?2_000_000:1_000_000)));
 assert.equal((await reserve(p,'next',provider)).ok,true);
});

test('release requires the delay boundary and uses the synthetic step declared at admission', async t => {
 const o=oracle();o.step=250_000;const p=fixture(t,o);
 assert.equal((await reserve(p,'quarter-step')).ok,true);
 await p.candidate.started('quarter-step',{ok:true});
 await p.candidate.recordCleanup('quarter-step',{removed:true});
 const before=rows(p,'quarter-step').map(r=>r.held_micro);
 o.at+=119_999;o.readingAt=o.at;
 await p.candidate.probeHeld();
 assert.deepEqual(rows(p,'quarter-step').map(r=>r.held_micro),before);
 o.at+=1;o.readingAt=o.at;
 await p.candidate.probeHeld();
 assert.ok(rows(p,'quarter-step').every(r=>r.spent_micro===1_000_000&&r.unrepresented_micro===250_000&&r.held_micro===0));
});

test('one covering rise closes every cleaned-up native hold, including siblings, across restart', async t => {
 const o=oracle();let p=fixture(t,o);
 for(const id of ['a','b']) {
  assert.equal((await reserve(p,id)).ok,true);
  await p.candidate.started(id,{ok:true});
  await p.candidate.recordCleanup(id,{removed:true});
  o.at+=121_000;o.readingAt=o.at;await p.candidate.probeHeld();
 }
 o.at+=1_000;o.readingAt=o.at;o.measured.weekly+=2_000_000;o.measured.short+=2_000_000;
 await p.candidate.probeHeld();
 assert.ok(p.adapter.state().attempts.every(a=>a.hold_closed===true),'all covered siblings close in the same sweep');
 p=await p.reopen();const before=p.adapter.state().revision;
 let reads=0;const observe=p.source.observe;p.source.observe=async args=>{reads++;return observe(args);};
 await p.candidate.probeHeld();
 assert.equal(reads,0,'covered siblings cause no more provider reads');
 assert.equal(p.adapter.state().revision,before,'closed siblings need no new accounting event after restart');
 assert.ok(p.adapter.state().attempts.every(a=>a.hold_closed===true));
 // Repair the orphan flag already written by the previous build, including an unchanged meter.
 await p.candidate.cancelObservations();await p.adapter.close();
 const file=join(p.directory,'lending-pace50-state.json');const state=JSON.parse(fs.readFileSync(file));
 const sibling=state.attempts.find(a=>a.id==='b');sibling.hold_closed=false;
 for(const r of sibling.resources)r.aggregate_used_micro=o.measured[r.kind];
 fs.writeFileSync(file,JSON.stringify(state));p=await p.reopen();
 const spent=rows(p,'b').map(r=>r.spent_micro);await p.candidate.probeHeld();
 assert.equal(p.adapter.state().attempts.find(a=>a.id==='b').hold_closed,true);
 assert.deepEqual(rows(p,'b').map(r=>r.spent_micro),spent);
});

for(const rise of [0,40_000_000]) test(`a sub-step charge retains a full step of exposure (rise ${rise})`, async t => {
 const o=oracle();o.perJobPct=0.3;let p=fixture(t,o);
 assert.equal((await reserve(p,'small')).ok,true);
 assert.equal(rows(p,'small').find(r=>r.kind==='weekly').initial_micro,300_000);
 await p.candidate.started('small',{ok:true});await p.candidate.recordCleanup('small',{removed:true});
 o.at+=121_000;o.readingAt=o.at;o.measured.weekly+=rise;o.measured.short+=rise;
 await p.candidate.probeHeld();
 const weekly=rows(p,'small').find(r=>r.kind==='weekly');
 assert.equal(weekly.spent_micro,rise+1_000_000,'whole growth plus uncertainty is charged');
 assert.equal(weekly.unrepresented_micro,1_000_000,'exposure retains the entire reporting step');
 p=await p.reopen();assert.equal(rows(p,'small').find(r=>r.kind==='weekly').unrepresented_micro,1_000_000);
 // Covering only the charge does not cover the uncertainty envelope.
 o.at+=1_000;o.readingAt=o.at;o.measured.weekly+=300_000;o.measured.short+=300_000;
 await p.candidate.probeHeld();assert.equal(rows(p,'small').find(r=>r.kind==='weekly').unrepresented_micro,1_000_000);
 o.at+=1_000;o.readingAt=o.at;o.measured.weekly+=700_000;o.measured.short+=700_000;
 await p.candidate.probeHeld();
 assert.ok(p.adapter.state().attempts[0].hold_closed);
 assert.equal(rows(p,'small').find(r=>r.kind==='weekly').spent_micro,rise+1_000_000);
});

for(const declaredStep of [1_000_000,2_000_000]) test(`a settlement reading cannot lower the admission step ${declaredStep}`, async t => {
 const o=oracle();o.step=declaredStep;const p=fixture(t,o);
 assert.equal((await reserve(p,'fixed-step')).ok,true);
 await p.candidate.started('fixed-step',{ok:true});await p.candidate.recordCleanup('fixed-step',{removed:true});
 const before=rows(p,'fixed-step').map(r=>r.held_micro);
 o.at+=121_000;o.readingAt=o.at;o.step=declaredStep===2_000_000?1_000_000:250_000;
 await p.candidate.probeHeld();
 assert.deepEqual(rows(p,'fixed-step').map(r=>r.held_micro),before,'a smaller step cannot authorize release');
 o.step=declaredStep;await p.candidate.probeHeld();
 assert.ok(rows(p,'fixed-step').every(r=>r.unrepresented_micro===declaredStep&&r.held_micro===0));
});

test('older durable records cannot authorize a smaller step after upgrade', async t => {
 const o=oracle();let p=fixture(t,o);
 assert.equal((await reserve(p,'legacy-step')).ok,true);
 await p.candidate.started('legacy-step',{ok:true});await p.candidate.recordCleanup('legacy-step',{removed:true});
 await p.candidate.cancelObservations();await p.adapter.close();
 const file=join(p.directory,'lending-pace50-state.json');const state=JSON.parse(fs.readFileSync(file));
 for(const r of state.attempts[0].resources)delete r.meter_step_micro;
 fs.writeFileSync(file,JSON.stringify(state));p=await p.reopen();
 const before=rows(p,'legacy-step').map(r=>r.held_micro);
 o.at+=121_000;o.readingAt=o.at;o.step=250_000;
 await p.candidate.probeHeld();assert.deepEqual(rows(p,'legacy-step').map(r=>r.held_micro),before);
 o.step=1_000_000;await p.candidate.probeHeld();
 assert.ok(rows(p,'legacy-step').every(r=>r.unrepresented_micro===1_000_000));
});

test('upgrade restores the full uncertainty and additive charge floor for a prior sub-step exposure', async t => {
 const o=oracle();o.perJobPct=0.3;let p=fixture(t,o);
 assert.equal((await reserve(p,'legacy-small')).ok,true);
 await p.candidate.started('legacy-small',{ok:true});await p.candidate.recordCleanup('legacy-small',{removed:true});
 o.at+=121_000;o.readingAt=o.at;await p.candidate.probeHeld();
 await p.candidate.cancelObservations();await p.adapter.close();
 const file=join(p.directory,'lending-pace50-state.json');const state=JSON.parse(fs.readFileSync(file));
 const r=state.attempts[0].resources.find(r=>r.kind==='weekly');
 delete r.meter_step_micro;delete r.usage_covered_at;
 Object.assign(r,{initial_micro:300_000,spent_micro:300_000,held_micro:0,released_micro:0,unrepresented_micro:300_000,
  burns:[{id:'legacy-small:old-step',amount_micro:300_000,at:r.aggregate_observed_at,represented:false}]});
 fs.writeFileSync(file,JSON.stringify(state));p=await p.reopen();
 await p.candidate.probeHeld();
 assert.equal(rows(p,'legacy-small').find(r=>r.kind==='weekly').unrepresented_micro,1_000_000);
 assert.equal(rows(p,'legacy-small').find(r=>r.kind==='weekly').spent_micro,1_000_000);
});
