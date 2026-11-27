import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {decide as currentDecide, protection as currentProtection} from '../lib/v1/rules/fluid-protection.mjs';
// Frozen executable reference from base 57cda4e0864da937ade059f6f408d4f6133f1fe4,
// with only the startup term moved to the 1027 cold-start cap (min(dial,.20)Q, never
// past the owner's own pace). Keep independent of production so absent-certificate
// regressions include reasons.
// Research policy: two-stage surrogate, not dynamic optimality or calibration.
const Q = 100;
const COLD_START_CAP = .20;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const clamp = (x,lo=0,hi=Q) => Math.max(lo,Math.min(hi,x));
function traceEnd(h,length,complete) {
  if (!Array.isArray(h.trace) || h.trace.length < 2) throw Error('invalid history');
  let t=-Infinity,u=-Infinity;
  for(const p of h.trace){
    if(!Array.isArray(p)||p.length!==2||!p.every(finite)||p[0]<0||p[0]<t||p[0]>length||p[1]<u||p[1]<0||p[1]>Q)throw Error('invalid trace');
    [t,u]=p;
  }
  if(h.trace[0][0]!==0||h.trace[0][1]!==0||(complete&&t!==length))throw Error('invalid reset-relative trace');
  return {t,u};
}
// Correct DP predictive: uniform base mass one plus endpoint atoms, NOT gap mass.
// owner is a lower observation, never a projection of latent future demand.
function protection(history,id,length,dial,{owner=0,later=0,reset_h,elapsed=0}={}) {
  const samples=[];let imported=0;
  for(const h of history){
    if(h.window_id!==id)continue;
    if(h.source==='import-open-window'){
      const p=traceEnd(h,length,false);
      // Partial logs are lower evidence only, tied to this physical reset identity.
      if(finite(h.reset_h)&&h.reset_h===reset_h&&p.t<=elapsed) imported=Math.max(imported,p.u);
      continue;
    }
    const {u}=traceEnd(h,length,true);
    // Rounded history is not qualified no-lending demand. This remains a model.
    samples.push(h.censored===true||u===Q?Q:Math.min(Q,u+(h.metadata?.measurement?.includes('rounded')?.5:0)));
  }
  const a=Math.max(owner,imported), n=samples.length;
  const cdf=(u,inclusive)=>{
    let total=a===Q?(inclusive?Number(u>=Q):Number(u>Q)):clamp((u-a)/(Q-a),0,1);
    for(const z of samples)total+=inclusive?Number(Math.max(a,z)<=u):Number(Math.max(a,z)<u);
    return total/(n+1);
  };
  // Left derivative of J(x): (1-d) P(U>Q-x) - d P(U<=Q-x-later).
  // Infimum left slope >=0 selects a minimizer; endpoints explicitly defined.
  let lo=0,hi=Q;
  if(dial===0)hi=0;
  else if(dial===1)lo=hi=Math.max(0,Q-a-later);
  else for(let i=0;i<60;i++){ // 60 bisections: <=100/2^60 mathematical bracket.
    const x=(lo+hi)/2,u=Q-x;
    const slope=(1-dial)*(1-cdf(u,true))-dial*cdf(u-later,true);
    if(slope<0)lo=x;else hi=x;
  }
  const optimum=(lo+hi)/2;
  // Explicit immediate-lending constraint, reduced by observed owner use.
  const pace=a===0?0:elapsed>0?a*length/elapsed:Infinity;
  const startup=Math.min(Q*Math.min(dial,COLD_START_CAP),Math.max(0,Q-pace));
  const envelope=Math.min(Q*dial,Math.max(optimum,startup));
  return {reserve:Q-envelope,envelope,n,imported,owner:a,optimum,startup,mode:'two-stage model; cold-start probability uncertified'};
}
function candidateDecide(s){
  const lendable=Object.create(null);
  try{
    if(!s||!finite(s.now_h)||!finite(s.dial)||s.dial<0||s.dial>1||!Array.isArray(s.windows)||!s.windows.length||!Array.isArray(s.history)||!s.job||!finite(s.job.duration_h)||s.job.duration_h<0||!s.job.gross||typeof s.job.gross!=='object')throw Error('invalid state');
    const ids=new Set();let admit=true,positive=false;
    for(const w of s.windows){
      if(!w||typeof w.id!=='string'||!w.id||ids.has(w.id))throw Error('invalid identity');ids.add(w.id);
      for(const k of ['length_h','reset_h','used_lo','used_hi','borrower_used','inflight_gross'])if(!finite(w[k]))throw Error('invalid window');
      if(w.length_h<=0||w.reset_h<=s.now_h||w.used_lo<0||w.used_hi<w.used_lo||w.used_hi>Q||w.borrower_used<0||w.borrower_used>w.used_hi||w.inflight_gross<0)throw Error('invalid bounds');
      const g=s.job.gross[w.id];if(!Object.hasOwn(s.job.gross,w.id)||!finite(g)||g<0)throw Error('missing gross');positive ||= g>0;
      const elapsed=clamp(w.length_h-(w.reset_h-s.now_h),0,w.length_h);
      // Nominal quota-rate catch-up forecast, PROPOSED; not a throughput certificate.
      const later=Q*(1-elapsed/w.length_h);
      const p=protection(s.history,w.id,w.length_h,s.dial,{owner:Math.max(0,w.used_lo-w.borrower_used),later,reset_h:w.reset_h,elapsed});
      lendable[w.id]=Math.max(0,Math.min(Q-w.used_hi-w.inflight_gross,p.envelope-w.borrower_used-w.inflight_gross));
      if(g>lendable[w.id]||s.now_h+s.job.duration_h>w.reset_h)admit=false;
    }
    if(Object.keys(s.job.gross).some(id=>!ids.has(id)))throw Error('unknown gross resource');admit &&=positive;
    return {admit,lendable,reason:`${admit?'Lend':'Hold'} because the full job ${admit?'fits':'exceeds'} the remaining cumulative share, two-stage waiting/startup allowance, physical room or deadline (model only; cold-start probability uncertified).`};
  }catch(e){return {admit:false,lendable:Object.create(null),reason:`Hold: ${e.message}; no probability claim.`};}
}


// Contract translation only: candidateDecide/protection and constants above are unchanged.
function adaptSeamV2(s) {
  return {...s, windows:s.windows.map(w => ({...w, used_lo:w.total_lo,
    used_hi:w.total_hi, borrower_used:w.borrower_settled_hi})),
    history:s.history.filter(h => h.supported === true &&
      s.windows.some(w => w.id === h.window_id && w.length_h === h.length_h) &&
      // Candidate models only exact or half-point rounded measurements.
      ((h.rounding_points === 0 && !h.metadata.measurement.includes('rounded')) ||
       (h.rounding_points === .5 && h.metadata.measurement.includes('rounded'))) &&
      (h.complete === true || (h.open === true && h.source === 'import-open-window')))};
}
function baseDecide(s) {
  try { return candidateDecide(s?.contract_version === 2 ? adaptSeamV2(s) : s); }
  catch { return {admit:false, lendable:{}, reason:'Unsupported fluid input contract.'}; }
}


const state=(dial=.25,owner=10)=>({now_h:167.99,dial,windows:[{id:'week',length_h:168,reset_h:168,used_lo:owner,used_hi:owner,borrower_used:0,inflight_gross:0}],history:Array.from({length:20},()=>({window_id:'week',trace:[[0,0],[168,10]]})),job:{gross:{week:1},duration_h:0}});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
// Reason codes are additive metadata. Keep the pinned reference untouched and
// compare every pre-existing field, including exact legacy reason text.
const legacyDecision=s=>{
  const {reasonCode,...legacy}=currentDecide(s);
  assert.match(reasonCode,/^fluid_[a-z_]+$/);
  return legacy;
};
test('absent certificate matches pinned base decision and reason across grid',()=>{
  for(const dial of [0,.1,.25,.5,.75,1])for(const now of [.5,1,42,150,165,167.99])for(const owner of [0,10,80,100])for(const borrowed of [0,3])for(const reserved of [0,2])for(const gross of [0,1.2296,3.6656,20]){
    if(owner+borrowed>100)continue;
    const s=state(dial,owner);s.now_h=now;s.history=[];
    Object.assign(s.windows[0],{used_lo:owner+borrowed,used_hi:owner+borrowed,borrower_used:borrowed,inflight_gross:reserved});
    s.job.gross.week=gross;
    assert.deepEqual(legacyDecision(s),baseDecide(s));
    s.contract_version=2;s.windows=s.windows.map(w=>({...w,total_lo:w.used_lo,total_hi:w.used_hi,borrower_settled_hi:w.borrower_used}));
    assert.deepEqual(legacyDecision(s),baseDecide(s));
  }
});
test('absent certificate matches acceptance workload fixtures including both limits',()=>{
  for(const [hours,owner,gross,dial] of [[165,10,3,1],[.5,0,20,1],[42,80,2,1],[84,90,2,1],[166,100,2,1]])for(const borrowed of [0,3,45]){
    if(owner+borrowed>100)continue;
    const s=state(dial,owner);s.now_h=hours;s.history=[];
    Object.assign(s.windows[0],{used_lo:owner+borrowed,used_hi:owner+borrowed,borrower_used:borrowed});
    s.windows.push({id:'short',length_h:5,reset_h:Math.min(168,hours+3),used_lo:borrowed,used_hi:borrowed,borrower_used:borrowed,inflight_gross:0});
    s.job={gross:{week:gross,short:gross},duration_h:62/3600};
    assert.deepEqual(legacyDecision(s),baseDecide(s));
  }
});
// Theorem B's K+B (lend up to Q-K+Q*d) assumes K is a certified bound on owner demand. The seam's K is
// the R2 burn-rate estimate, not a certificate, so the cap is max(Q*d, Q-K): above the setting's share,
// lending only uses room the estimate says the owner cannot reach (review 1027 F1, late-burst witness).
test('valid full-episode bound lifts late light-week allowance to physical room or the room it leaves',()=>{
  for(const u of [10,20,60,100]){
    const s=state();s.now_h=168-1e-12;s.windows[0].owner_envelope_hi=u;
    near(currentDecide(s).lendable.week,Math.min(90,Math.max(25,100-u)));
    if(u<100)assert.match(currentDecide(s).reason,new RegExp('owner_envelope_hi='+u));
  }
});
test('invalid explicit bounds ignored with diagnostic; absent remains byte identical',()=>{
  for(const u of [undefined,null,'10',NaN,Infinity,-1,101,9]){
    const s=state(),before=currentDecide(s);s.windows[0].owner_envelope_hi=u;
    const after=currentDecide(s);assert.equal(after.admit,before.admit);assert.deepEqual(after.lendable,before.lendable);
    assert.match(after.reason,/invalid owner_envelope_hi ignored \(K=0\)/);
  }
  const s=state();s.history.push({source:'import-open-window',window_id:'week',reset_h:168,trace:[[0,0],[1,80]]});
  s.windows[0].owner_envelope_hi=79;assert.match(currentDecide(s).reason,/invalid owner_envelope_hi/);
});
test('proposal, current certificate, settled debit and reservations stay independent',()=>{
  const s=state();s.windows[0].owner_envelope_hi=60;
  near(currentDecide(s).lendable.week,40);
  s.windows[0].inflight_gross=5;near(currentDecide(s).lendable.week,35);
  s.windows[0].inflight_gross=0;s.windows[0].borrower_used=5;s.windows[0].used_lo=s.windows[0].used_hi=15;
  near(currentDecide(s).lendable.week,35);
  s.windows[0].owner_envelope_hi=80;near(currentDecide(s).lendable.week,20);
  delete s.windows[0].owner_envelope_hi;near(currentDecide(s).lendable.week,20);
  const cold=state();cold.now_h=1;cold.history=[];cold.windows[0].owner_envelope_hi=10;
  near(currentDecide(cold).lendable.week,currentDecide({...cold,windows:cold.windows.map(({owner_envelope_hi,...w})=>w)}).lendable.week);
});
test('certificate cannot bypass another limit, deadline or physical room',()=>{
  const s=state();s.windows[0].owner_envelope_hi=10;s.job.gross.week=91;assert.equal(currentDecide(s).admit,false);
  s.job.gross.week=1;s.job.duration_h=1;assert.equal(currentDecide(s).admit,false);
  s.job.duration_h=0;s.windows.push({id:'short',length_h:5,reset_h:168,used_lo:100,used_hi:100,borrower_used:0,inflight_gross:0,owner_envelope_hi:100});s.job.gross.short=1;
  assert.equal(currentDecide(s).admit,false);
});
test('generated scalar demand paths bounded by fixed truthful certificate have harm <= B',()=>{
  // Finite synthetic divisible-quota simulation, not atomic-service or population validation.
  for(const dial of [0,.1,.25,.5,.75,1])for(const u of [0,10,30,60,90,100])for(const fraction of [0,.5,1])for(const ownerFirst of [true,false]){
    const s=state(dial,0);s.now_h=150;s.windows[0].owner_envelope_hi=u;
    let owner=0,borrowed=0,remaining=u*fraction;
    for(let step=0;step<20;step++){
      s.now_h=150+step*.8;
      const consume=()=>{const demand=step===19?remaining:remaining/2;remaining-=demand;owner+=Math.min(demand,Math.max(0,100-owner-borrowed));};
      if(ownerFirst)consume();
      Object.assign(s.windows[0],{used_lo:owner+borrowed,used_hi:owner+borrowed,borrower_used:borrowed,inflight_gross:0});
      const allowance=currentDecide(s).lendable.week;
      if(allowance>0){
        s.job.gross.week=allowance;assert.equal(currentDecide(s).admit,true);
        s.windows[0].inflight_gross=allowance;
        near(currentDecide(s).lendable.week,0);
        borrowed+=allowance;s.windows[0].inflight_gross=0;
      }
      if(!ownerFirst)consume();
      assert.ok(borrowed<=Math.min(100,100-u+100*dial)+1e-9);
      assert.ok(owner+borrowed<=100+1e-9);
    }
    assert.ok(u*fraction-owner<=100*dial+1e-9);
  }
});
