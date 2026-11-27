import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildLendingRuleState, evaluateLendingRule} from '../lib/v1/lending-rule-seam.mjs';

const M = 1_000_000, H = 3_600_000, START = 1_800_000_000_000;
const IDS = ['seven_day', 'five_hour'];
const gates = {consent:true, limits:true, funding:true, stopping:true};
// Authored workload/threshold parameters, NOT pre-registered research thresholds.
export const ACCEPTANCE_PARAMETERS = Object.freeze({minimumNominalSpareFraction:.95,
  tolerancePoints:1e-6, lightOwnerPoints:10, chunkUsd:3, durationMs:60_000});

function input({hours=165, owner=10, borrowed=0, shortUsed=borrowed, committed=0,
  gross=3, worst=.1, ageMs=0, dial=.5} = {}) {
  const now = START + hours * H, reset = START + 168 * H;
  const windows = {
    seven_day:{kind:'weekly', durationMs:168*H, usedMicro:Math.round((owner + borrowed)*M), committedMicro:Math.round(committed*M),
      uncertaintyMicro:0, pointsPerUsdMicro:M, resetAtMs:reset, known:true, fresh:true, compatible:true},
    five_hour:{kind:'short', durationMs:5*H, usedMicro:Math.round(shortUsed*M), committedMicro:Math.round(committed*M),
      uncertaintyMicro:0, pointsPerUsdMicro:M, resetAtMs:Math.min(reset, now+3*H), known:true, fresh:true, compatible:true},
  };
  const rows = IDS.map(id => ({window_id:id, window_minutes:id==='seven_day'?10080:300,
    used_pct:windows[id].usedMicro/M, resets_at:windows[id].resetAtMs, observed_at:now-ageMs,
    state:'open', lent_pct:borrowed, reserved_pct:committed}));
  const entries = borrowed === 0 ? [] : rows.map(r => ({account:'claude', window_id:r.window_id,
    resets_at:r.resets_at, started_at:now-1000-ageMs, ended_at:now-ageMs,
    represented_at:now-ageMs, attribution:'exact', lent_pts:borrowed, lent_lower_pts:borrowed}));
  return {now, observedAt:now-ageMs, windows, weeklyResource:'seven_day', gates:{...gates},
    laterBurnCapacityMicro:0, ruleDial:dial,
    ruleEvidence:{quotaRegistry:{version:'synthetic/1',complete:true,
      limits:IDS.map(id=>({id,provider:'claude',unit:'quota_percent',capacity:100,
        durationMs:windows[id].durationMs,reset:{kind:'first-use'},scope:{kind:'account'},
        weights:{version:'synthetic/1',nativeUnit:'usd',byModel:{'claude-haiku-5-5':windows[id].pointsPerUsdMicro/M}}}))},
      snapshot:{account:'claude', windows:rows}, entries, history:[],
      applicableResources:{account:'claude',provider:'claude',model:'claude-haiku-5-5',complete:true,ids:[...IDS]},
      roundingPoints:{seven_day:0, five_hour:0},
      lagBounds:Object.fromEntries(IDS.map(id=>[id,{providerLagMs:0, maxPointsPerHour:0, maxPointsPerHourEvidenceClass:'measured',
        provenance:"Synthetic synchronous meter: no intrinsic provider delay."}]))},
    job:{provider:'claude',model:'claude-haiku-5-5',wallMs:ACCEPTANCE_PARAMETERS.durationMs, uncertaintyMs:1000, stopMs:1000,
      estimateUsdMicro:Math.round(gross*M), requestedUsdMicro:Math.round(gross*M),
      nativeCostBounds:{unit:'usd',lower:0,upper:Math.round(gross*M)/M},
      worstCallUsdMicro:Math.round(worst*M), friendValue:1}};
}

export const lendNothing = s => ({admit:false,
  lendable:Object.fromEntries(s.windows.map(w => [w.id, 0])), reason:'Keeping all allowance for you.'});
// Reference only, not a production default or a claim about unpredictable future demand.
export function lendAboveCurrentPace(s) {
  const lendable = Object.fromEntries(s.windows.map(w => {
    const elapsed = Math.max(0, Math.min(w.length_h, s.now_h - (w.reset_h-w.length_h)));
    const projected = elapsed > 0 ? w.used_hi * w.length_h/elapsed : w.used_hi === 0 ? 0 : 100;
    return [w.id, Math.max(0, 100 - Math.max(w.used_hi, projected) - w.borrower_used - w.inflight_gross) * s.dial];
  }));
  return {admit:s.windows.every(w => s.job.gross[w.id] <= lendable[w.id]), lendable,
    reason:'Lending the allowance above your current usage pace.'};
}
const admit = async (args, decide) => {
  const {decideObjectiveLend} = await import('../lib/v1/lending-objective.mjs');
  return decideObjectiveLend({...args, decide});
};

// A reusable rule-agnostic experiment: only the injected decide varies. The denominator
// is NOMINAL spare (100 - owner service), never the candidate's declared lendable amount.
export async function milestoneResults(decide, parameters = ACCEPTANCE_PARAMETERS) {
  let borrowed = 0;
  for (let i=0; i<30; i++) {
    const d = await admit(input({hours:165+i/12, owner:parameters.lightOwnerPoints,
      borrowed, gross:parameters.chunkUsd, dial:1}), decide);
    if (d.admitted) {
      // Declared spend-to-gross workload, native + one maximum final call; not a
      // claim that arbitrary small-call jobs necessarily consume all headroom.
      const spent = (d.nativeBudgetUsdMicro+d.worstCallUsdMicro)/M;
      assert.equal(spent, d.exposureUsdMicro/M);
      for (const id of IDS) assert.ok(d.reservePointsMicro[id] >= spent*M);
      borrowed += spent;
    }
  }
  const nominalSpare = 100-parameters.lightOwnerPoints;
  const modelAdmission = [];
  // Fixed milestone $20 workloads; headroom values are authored inputs, not a live pricing lookup.
  for (const [model, worst] of [['Haiku',1.32], ['Sonnet',5.28], ['Opus',10.56]]) {
    const d = await admit(input({hours:.5, owner:0, gross:20, worst, dial:1}), decide);
    modelAdmission.push({model, admitted:d.admitted});
    if (d.admitted) assert.equal(d.nativeBudgetUsdMicro, Math.round((20-worst)*M));
  }
  return {a:borrowed/nominalSpare >= parameters.minimumNominalSpareFraction,
    c:modelAdmission.every(row => row.admitted), borrowed, nominalSpare, modelAdmission};
}

test('milestones a/c discriminate: lend-nothing fails both; current-pace reference passes both', async () => {
  const nothing = await milestoneResults(lendNothing), pace = await milestoneResults(lendAboveCurrentPace);
  assert.equal(nothing.a, false); assert.equal(nothing.c, false);
  assert.equal(nothing.borrowed, 0); assert.equal(nothing.nominalSpare, 90);
  assert.equal(pace.a, true, JSON.stringify(pace)); assert.equal(pace.c, true, JSON.stringify(pace));
  assert.ok(pace.borrowed <= pace.nominalSpare);
});

export async function heavyOwnerResult(decide) {
  let owner=0, borrowed=0, baselineOwner=0;
  for (const [hours, demand] of [[42,80],[84,10],[166,10]]) {
    const baselineServed=Math.min(demand,100-baselineOwner);
    const served=Math.min(demand,100-owner-borrowed);
    owner+=served; baselineOwner+=baselineServed;
    const d=await admit(input({hours,owner,borrowed,gross:2,dial:1}),decide);
    if(d.admitted)borrowed+=d.exposureUsdMicro/M;
    assert.ok(owner+borrowed<=100);
  }
  return {safe:owner===baselineOwner, owner, baselineOwner, borrowed};
}
const aggressive = s=>({admit:true,lendable:Object.fromEntries(s.windows.map(w=>[w.id,100])),
  reason:'Lend all physically available allowance.'});
test('b: heavy owner oracle rejects aggressive lending, while safe references preserve service', async () => {
  for (const decide of [lendNothing, lendAboveCurrentPace]) {
    const result=await heavyOwnerResult(decide);
    assert.equal(result.safe,true);assert.equal(result.owner,100);assert.equal(result.borrowed,0);
  }
  const unsafe=await heavyOwnerResult(aggressive);
  assert.equal(unsafe.safe,false);assert.ok(unsafe.borrowed>0);assert.ok(unsafe.owner<unsafe.baselineOwner);
});

test('d/e: real admission calls the injected rule in the first hour with no history and projects its sentence', async () => {
  let called=0;
  const d=await admit(input({hours:.5,owner:0,gross:20,dial:1}),s=>{
    called++; assert.deepEqual(s.history,[]); assert.ok(s.now_h-(s.windows[0].reset_h-168)<1);
    return lendAboveCurrentPace(s);
  });
  assert.equal(called,1); assert.equal(d.admitted,true);
  assert.equal(d.reasonText,'Lending the allowance above your current usage pace.');
  assert.equal(d.projection.reasonText,d.reasonText); assert.match(d.reasonText,/^[^.!?]+[.]$/);
  assert.equal(d.projection.strategyId,'injected_rule');
});

test('f: an injected yes cannot bypass either resource, reservations or reset boundary', async () => {
  const yes=s=>({admit:true,lendable:Object.fromEntries(s.windows.map(w=>[w.id,100])),reason:'Spare is available.'});
  for(const edit of [x=>{x.windows.seven_day.usedMicro=99*M;x.ruleEvidence.snapshot.windows[0].used_pct=99;},
    x=>{x.windows.five_hour.usedMicro=99*M;x.ruleEvidence.snapshot.windows[1].used_pct=99;},
    x=>{x.windows.five_hour.committedMicro=99*M;}]) {
    const x=input({owner:0});edit(x);const d=await admit(x,yes);
    assert.equal(d.admitted,false);assert.equal(d.reservePointsMicro,undefined);
  }
});

test('reset boundary holds for its specific reason with matching evidence, before rule evaluation', async () => {
  const x=input({owner:0});
  x.windows.five_hour.resetAtMs=x.now+62_000;
  x.ruleEvidence.snapshot.windows[1].resets_at=x.windows.five_hour.resetAtMs;
  // The evidence mapper accepts this snapshot; rejection is exclusively the job horizon.
  assert.doesNotThrow(()=>buildLendingRuleState(x));
  let calls=0;
  const d=await admit(x,s=>{calls++;return aggressive(s);});
  assert.equal(d.admitted,false);assert.equal(d.reasonCode,'objective_reset');
  assert.equal(d.reason,'reset');assert.equal(calls,0);assert.equal(d.reservePointsMicro,undefined);
});

test('disjoint ledger reservations and admission commitments are both debited', async () => {
  const x=input({owner:0,committed:49,gross:3});
  x.ruleEvidence.snapshot.windows.forEach(r=>{r.reserved_pct=49;});
  assert.equal(buildLendingRuleState(x).windows[0].inflight_gross,98);
  const d=await admit(x,aggressive);
  assert.equal(d.admitted,false);assert.equal(d.reservePointsMicro,undefined);
});

test('receipt freshness cannot substitute for an explicit intrinsic provider lag bound', async () => {
  for(const edit of [x=>{delete x.ruleEvidence.lagBounds;},
    x=>{delete x.ruleEvidence.lagBounds.seven_day.providerLagMs;},
    x=>{x.ruleEvidence.lagBounds.seven_day.providerLagMs=-1;},
    x=>{x.ruleEvidence.lagBounds.seven_day.provenance=' ';}]) {
    const x=input({owner:0,ageMs:0});edit(x);
    assert.throws(()=>buildLendingRuleState(x),/lag bound|provider lag/);
    assert.equal((await admit(x,aggressive)).reasonCode,'rule_evidence_unknown');
  }
  const x=input({owner:10,ageMs:30_000});
  x.ruleEvidence.lagBounds=Object.fromEntries(IDS.map(id=>[id,{providerLagMs:30_000,
    maxPointsPerHour:12,provenance:'Synthetic bounded 30 second provider delay and account-wide rate.'}]));
  const w=buildLendingRuleState(x).windows[0];
  assert.equal(w.used_hi,10.2);
  assert.equal(w.reading_age_h,30_000/H);assert.equal(w.provider_lag_bound_h,30_000/H);
});

test('hard gates remain ahead of injection; budget and stoppable chunk remain enforced', async () => {
  for(const edit of [x=>{x.stopped=true;}, x=>{x.windows.seven_day.known=false;},
    x=>{x.gates.stopping=false;}, x=>{x.gates.consent=false;},x=>{x.gates.funding=false;},
    x=>{x.gates.limits=false;}]) {
    let calls=0;const x=input();edit(x);
    const d=await admit(x,s=>{calls++;return lendAboveCurrentPace(s);});
    assert.equal(d.admitted,false);assert.equal(calls,0);
  }
  for(const edit of [x=>{x.ownerMaxJobUsdMicro=M;},x=>{x.job.worstCallUsdMicro=3*M;},
    x=>{x.job.chunkCandidates=[{id:'small',usdMicro:M,friendValue:1}];}]) {
    const x=input({dial:1});edit(x);assert.equal((await admit(x,lendAboveCurrentPace)).admitted,false);
  }
});

test('no injection leaves the production path unchanged rather than selecting a research rule', async () => {
  const {decideObjectiveLend}=await import('../lib/v1/lending-objective.mjs');
  const x=input();x.strategy='manual_approval';
  const baseline=decideObjectiveLend(x);
  const withUnusedEvidence=decideObjectiveLend({...x,ruleDial:NaN,ruleEvidence:null});
  assert.deepEqual(withUnusedEvidence,baseline);assert.notEqual(baseline.strategyId,'injected_rule');
});

test('mapping: exact units, both conversions, borrower debit, in-flight reservation and history', () => {
  const x=input({borrowed:7,committed:4,dial:.2});
  x.windows.five_hour.pointsPerUsdMicro=2*M;
  x.ruleEvidence.quotaRegistry.limits.find(r=>r.id==='five_hour').weights.byModel['claude-haiku-5-5']=2;
  x.ruleEvidence.history=[{window_id:'seven_day',start_at:START,resets_at:START+168*H,
    length_ms:168*H,complete:false,censored:false,source:'probe',rounding_points:0,
    metadata:{measurement:'exact'},trace:[[START,0],[x.now-H,8],[x.now,10]]}];
  const s=buildLendingRuleState(x);
  assert.equal(s.now_h,x.now/H);assert.equal(s.dial,.2);
  assert.deepEqual(s.windows[0],{id:'seven_day',length_h:168,reset_h:(START+168*H)/H,
    total_lo:17,total_hi:17,borrower_settled_hi:7,borrower_represented_lo:7,owner_lo:10,owner_hi:10,owner_envelope_hi:10,
    used_lo:10,used_hi:10,borrower_used:7,inflight_gross:8,reading_age_h:0,provider_lag_bound_h:0});
  assert.deepEqual(s.job,{gross:{seven_day:3,five_hour:6},duration_h:62_000/H});
  assert.deepEqual(s.history,[{window_id:'seven_day',supported:true,unsupported:[],
    start_h:START/H,reset_h:START/H+168,length_h:168,complete:false,open:true,censored:false,
    source:'probe',rounding_points:0,metadata:{measurement:'exact'},
    trace:[[0,0],[164,8],[165,10]],raw_trace_ms:[[START,0],[x.now-H,8],[x.now,10]]}]);
});

test('mapping: aged rounded meter uses only explicit account-wide rate evidence', () => {
  const x=input({borrowed:7,ageMs:30_000});
  x.ruleEvidence.roundingPoints={seven_day:.5,five_hour:.5};
  x.ruleEvidence.lagBounds=Object.fromEntries(IDS.map(id=>[id,{maxPointsPerHour:12, providerLagMs:30_000,
    provenance:'Synthetic test world: total account burn bounded at 12 points/hour.'}]));
  const s=buildLendingRuleState(x);
  assert.equal(s.windows[0].used_lo,9.5);assert.equal(s.windows[0].used_hi,10.7);
  assert.equal(s.windows[0].borrower_used,7);
  delete x.ruleEvidence.lagBounds;
  x.ruleEvidence.snapshot.windows.forEach(r=>{r.max_rate_pct_per_hour=0;});
  assert.throws(()=>buildLendingRuleState(x),/account-wide lag bound/);
});

test('mapping: unrepresented borrower spend is never subtracted from the owner upper bound', () => {
  const x=input({borrowed:7});x.ruleEvidence.entries.forEach(e=>{e.represented_at=null;});
  const s=buildLendingRuleState(x);
  assert.equal(s.windows[0].used_hi,17);assert.equal(s.windows[0].used_lo,10);
  assert.equal(s.windows[0].borrower_used,7);
});

test('mapping: missing rounding, inconsistent ledger, stale/future meter, missing window and unknown reservation hold', () => {
  for(const edit of [x=>{delete x.ruleEvidence.roundingPoints.seven_day;},
    x=>{x.ruleEvidence.snapshot.windows[0].lent_pct=1;},
    x=>{x.ruleEvidence.snapshot.windows[0].observed_at=x.now-8*24*60*60_000;},
    x=>{x.ruleEvidence.snapshot.windows[0].observed_at=x.now+1;},
    x=>{delete x.windows.five_hour;},x=>{x.windows.seven_day.committedMicro=null;}]) {
    const x=input();edit(x);assert.throws(()=>buildLendingRuleState(x));
  }
});

test('rule output fails closed and cannot mutate the real admission evidence', () => {
  for(const decide of [()=>null,()=>Promise.resolve({}),()=>({admit:true,lendable:{},reason:'Yes.'}),
    s=>({admit:true,lendable:{seven_day:NaN,five_hour:10},reason:'Yes.'}),
    s=>({admit:true,lendable:{seven_day:100,five_hour:100},reason:''})])
    assert.throws(()=>evaluateLendingRule(input(),decide));
  const x=input(),before=structuredClone(x);
  const out=evaluateLendingRule(x,s=>{s.windows[0].used_hi=0;s.job.gross.seven_day=0;
    return {admit:false,lendable:{seven_day:0,five_hour:0},reason:'Keep it.'};});
  assert.equal(out.admitted,false);assert.deepEqual(x,before);
});

test('real local ledger reservation and lending-history trace feed the pure mapping', async t => {
  const {createLendingLedger}=await import('../lib/v1/lending-ledger.mjs');
  const {createLendingHistory}=await import('../lib/v1/lending-history.mjs');
  const home=mkdtempSync(join(tmpdir(),'rule-seam-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const x=input({owner:10});
  const ledger=createLendingLedger({file:join(home,'ledger.json'),now:()=>x.now});
  const readings=x.ruleEvidence.snapshot.windows.map(r=>({...r,source:'probe',rounding_points:0,metadata:{measurement:'exact'}}));
  ledger.recordReadings('claude',readings);
  const history=createLendingHistory({home,account:'claude',ledger,now:()=>x.now});
  for(const r of readings)history.record({...r,account_week_epoch:x.windows.seven_day.resetAtMs,
    censoring:{complete:true,limit_reached:false,owner_refused:false,owner_deferred:false}});
  const held=ledger.reserve({account:'claude',job_digest:'job',attempt_id:'running',budget_units:20,
    unit:'claude_usd',model:'claude-haiku-5-5',plan:'max20'});
  assert.equal(held.ok,true);
  x.ruleEvidence.snapshot=ledger.snapshot('claude',{plan:'max20',model:'claude-haiku-5-5'});
  x.ruleEvidence.entries=ledger.entries({account:'claude'});x.ruleEvidence.history=history.ownerTraces();
  const s=buildLendingRuleState(x);
  assert.equal(s.windows[0].inflight_gross,1);assert.equal(s.windows[1].inflight_gross,5);
  const episode=s.history.find(row=>row.window_id==='seven_day');
  assert.deepEqual(episode.trace,[[165,10]]);
  assert.equal(episode.start_h,START/H);assert.equal(episode.reset_h,START/H+168);
  assert.equal(episode.complete,false);assert.equal(episode.tail_unobserved_h,3);
  assert.deepEqual(episode.unsupported,['trace endpoints']);
});

test('owner traces exclude every resource and reset in a censored account-week only', async t => {
  const {createLendingHistory}=await import('../lib/v1/lending-history.mjs');
  for(const censoring of [{complete:false},{limit_reached:true},{owner_refused:true},{owner_deferred:true}])
  for(const explicitBadWeek of [true,false]) {
    const home=mkdtempSync(join(tmpdir(),'rule-censor-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
    const now=START+167*H;
    // History-only fixture: no borrower charges; real-ledger integration is tested above.
    const ledger={entries:()=>[]};
    const history=createLendingHistory({home,account:'claude',ledger,now:()=>now});
    const clean={complete:true,limit_reached:false,owner_refused:false,owner_deferred:false};
    const record=(id,at,week,flags=clean)=>history.record({window_id:id,
      window_minutes:id==='seven_day'?10080:300,used_pct:10,
      resets_at:id==='seven_day'?week:at+H,observed_at:at,state:'open',source:'probe',rounding_points:0,metadata:{measurement:'exact'},
      account_week_epoch:week,censoring:flags});
    // A clean earlier week must remain, while one later bad short-window row
    // invalidates otherwise clean weekly and multiple short reset traces in its week.
    record('seven_day',START-H,START);
    record('seven_day',START+H,START+168*H);
    record('five_hour',START+H,START+168*H);
    record('five_hour',START+7*H,explicitBadWeek ? START+168*H : undefined,{...clean,...censoring});
    const episodes=history.ownerTraces();
    const cleanEpisodes=episodes.filter(row=>!row.censored);
    assert.equal(cleanEpisodes.length,1);
    assert.deepEqual(cleanEpisodes[0],{window_id:'seven_day',trace:[[START-H,10]],
      start_at:START-168*H,resets_at:START,length_ms:168*H,complete:false,censored:false,
      source:'probe',rounding_points:0,metadata:{measurement:'exact'},tail_unobserved_ms:H});
    assert.ok(episodes.filter(row=>row.censored).length>=2);
    for(const row of episodes.filter(row=>row.censored)) {
      assert.deepEqual(row.trace,[]);assert.equal(row.metadata.excluded_reason,'account_week_censored');
    }
  }
});
