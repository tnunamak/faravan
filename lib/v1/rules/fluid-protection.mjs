// Research policy: two-stage surrogate, not dynamic optimality or calibration.
const Q = 100;
const refusalCodes = new WeakMap();
const refusal = (reasonCode, message) => {
  const error = new Error(message); refusalCodes.set(error, reasonCode); return error;
};
export const COLD_START_CAP = 0.20; // Lead-chosen (the product owner left tunables to the lead, 10-27); from the cold-start study; easy to change.
const finite = x => typeof x === 'number' && Number.isFinite(x);
const clamp = (x,lo=0,hi=Q) => Math.max(lo,Math.min(hi,x));
function traceEnd(h,length,complete) {
  if (!Array.isArray(h.trace) || h.trace.length < 2) throw refusal('fluid_invalid_history', 'invalid history');
  let t=-Infinity,u=-Infinity;
  for(const p of h.trace){
    if(!Array.isArray(p)||p.length!==2||!p.every(finite)||p[0]<0||p[0]<t||p[0]>length||p[1]<u||p[1]<0||p[1]>Q)throw refusal('fluid_invalid_trace', 'invalid trace');
    [t,u]=p;
  }
  if(h.trace[0][0]!==0||h.trace[0][1]!==0||(complete&&t!==length))throw refusal('fluid_invalid_reset_relative_trace', 'invalid reset-relative trace');
  return {t,u};
}
function probeLowerEnd(h,length) {
  // History's existing trace is upper-valued. A separate lower trace is the
  // smallest sound opt-in: missing/invalid provenance stays excluded, not relabeled.
  try {
    traceEnd(h,length,false);
    const lower=h.owner_lower_trace;
    const end=traceEnd({trace:lower},length,false);
    if(lower.length!==h.trace.length || lower.some((p,i)=>p[0]!==h.trace[i][0]||p[1]>h.trace[i][1]))return null;
    return end;
  } catch { return null; }
}
// Correct DP predictive: uniform base mass one plus endpoint atoms, NOT gap mass.
// owner is a lower observation, never a projection of latent future demand.
export function protection(history,id,length,dial,{owner=0,later=0,reset_h,elapsed=0,owner_envelope_hi}={}) {
  const samples=[];let imported=0;
  for(const h of history){
    if(h.window_id!==id)continue;
    if(h.source==='import-open-window'||(h.source==='probe'&&h.complete===false)){
      const p=h.source==='probe' ? (h.open===true ? probeLowerEnd(h,length) : null) : traceEnd(h,length,false);
      // Partial logs are lower evidence only, tied to this physical reset identity.
      if(p&&finite(h.reset_h)&&h.reset_h===reset_h&&p.t<=elapsed) imported=Math.max(imported,p.u);
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
  // R1: pace and the largest completed-history sample can only lower startup.
  // These observations are not guarantees of future owner demand; physical room
  // and cumulative debit remain separate gates.
  const pace=a===0?0:elapsed>0?a*length/elapsed:Infinity;
  const worstPast=samples.reduce((worst,sample)=>Math.max(worst,sample),0);
  const startup=Math.min(Q*Math.min(dial,COLD_START_CAP),Math.max(0,Q-Math.max(pace,worstPast)));
  // The cap branch receives the seam's R2 burn-rate estimate, not a certified bound, so Theorem B's
  // K+B (Q-K+Q*d) does not apply: lending above the setting's share Q*d stays inside the room Q-K the
  // estimate leaves the owner. The shape/range check below is not certification of future owner demand.
  const certified=finite(owner_envelope_hi)&&owner_envelope_hi>=a&&owner_envelope_hi<=Q;
  const cap=certified?Math.max(Q*dial,Q-owner_envelope_hi):Q*dial;
  const envelope=Math.min(cap,Math.max(optimum,startup));
  return {reserve:Q-envelope,envelope,n,imported,owner:a,optimum,startup,mode:'two-stage model; cold-start probability uncertified'};
}
function candidateDecide(s){
  const lendable=Object.create(null);
  try{
    if(!s||!finite(s.now_h)||!finite(s.dial)||s.dial<0||s.dial>1||!Array.isArray(s.windows)||!s.windows.length||!Array.isArray(s.history)||!s.job||!finite(s.job.duration_h)||s.job.duration_h<0||!s.job.gross||typeof s.job.gross!=='object')throw refusal('fluid_invalid_state', 'invalid state');
    const native = s.contract_version === 2 && s.job.costBasis === 'native_window';
    const ids=new Set(), certificates=[];let admit=true,positive=native, allowance=false, deadline=false;
    for(const w of s.windows){
      if(!w||typeof w.id!=='string'||!w.id||ids.has(w.id))throw refusal('fluid_invalid_identity', 'invalid identity');ids.add(w.id);
      for(const k of ['length_h','reset_h','used_lo','used_hi','borrower_used','inflight_gross'])if(!finite(w[k]))throw refusal('fluid_invalid_window', 'invalid window');
      if(w.length_h<=0||w.reset_h<=s.now_h||w.used_lo<0||w.used_hi<w.used_lo||w.used_hi>Q||w.borrower_used<0||w.borrower_used>w.used_hi||w.inflight_gross<0)throw refusal('fluid_invalid_bounds', 'invalid bounds');
      const g=s.job.gross[w.id];if(!Object.hasOwn(s.job.gross,w.id)||!finite(g)||g<0)throw refusal('fluid_missing_gross', 'missing gross');positive ||= g>0;
      const elapsed=clamp(w.length_h-(w.reset_h-s.now_h),0,w.length_h);
      // Nominal quota-rate catch-up forecast, PROPOSED; not a throughput certificate.
      const later=Q*(1-elapsed/w.length_h);
      const p=protection(s.history,w.id,w.length_h,s.dial,{owner:Math.max(0,w.used_lo-w.borrower_used),later,reset_h:w.reset_h,elapsed,owner_envelope_hi:w.owner_envelope_hi});
      if(Object.hasOwn(w,'owner_envelope_hi')){
        const u=w.owner_envelope_hi;
        if(!finite(u)||u<p.owner||u>Q)certificates.push(`${w.id}: invalid owner_envelope_hi ignored (K=0)`);
        else if(p.envelope>Q*s.dial)certificates.push(`${w.id}: allowance exceeds exposure cap ${Q*s.dial} using full-episode owner_envelope_hi=${u}`);
      }
      const recentRate = s.dial === .10 && w.length_h === 168 && finite(w.recentMeterRate) && w.recentMeterRate >= 0
        ? w.recentMeterRate : null;
      const room = Q - w.used_hi - w.inflight_gross;
      const allowanceRoom = recentRate === null
        ? p.envelope - w.borrower_used - w.inflight_gross
        : room - (recentRate * (w.reset_h - s.now_h) + 3);
      lendable[w.id] = Math.max(0, Math.min(room, allowanceRoom));
      const exceeds=native ? lendable[w.id]<=0 : g>lendable[w.id];
      if(exceeds)allowance=true;
      // Preserve the original short-circuit: do not inspect the deadline after
      // the allowance has already refused this window.
      if(exceeds||s.now_h+s.job.duration_h>w.reset_h){admit=false;if(!exceeds)deadline=true;}
    }
    if(Object.keys(s.job.gross).some(id=>!ids.has(id)))throw refusal('fluid_unknown_gross_resource', 'unknown gross resource');admit &&=positive;
    // Stable precedence when several constraints fail: allowance, deadline, then zero gross.
    const reasonCode=admit?'fluid_lend':allowance?'fluid_allowance':deadline?'fluid_deadline':'fluid_zero_gross';
    return {admit,lendable,reasonCode,reason:`${admit?'Lend':'Hold'} because the full job ${admit?'fits':'exceeds'} the remaining cumulative share, two-stage waiting/startup allowance, physical room or deadline (model only; cold-start probability uncertified).${certificates.length?' '+certificates.join('; ')+'.':''}`};
  }catch(e){return {admit:false,lendable:Object.create(null),reasonCode:refusalCodes.get(e) ?? 'fluid_unexpected_error',reason:`Hold: ${e.message}; no probability claim.`};}
}


// Contract translation only; certificate passes through without being inferred.
export function adaptSeamV2(s) {
  return {...s, windows:s.windows.map(w => ({...w, used_lo:w.total_lo,
    used_hi:w.total_hi, borrower_used:w.borrower_settled_hi})),
    history:s.history.filter(h => h.supported === true &&
      s.windows.some(w => w.id === h.window_id && w.length_h === h.length_h) &&
      // Candidate models only exact or half-point rounded measurements.
      ((h.rounding_points === 0 && !h.metadata.measurement.includes('rounded')) ||
       (h.rounding_points === .5 && h.metadata.measurement.includes('rounded'))) &&
      (h.complete === true || (h.open === true && (h.source === 'import-open-window' ||
        (h.source === 'probe' && h.complete === false && probeLowerEnd(h,h.length_h) !== null)))))};
}
export function decide(s) {
  try { return candidateDecide(s?.contract_version === 2 ? adaptSeamV2(s) : s); }
  catch { return {admit:false, lendable:{}, reasonCode:'fluid_unsupported_contract', reason:'Unsupported fluid input contract.'}; }
}
