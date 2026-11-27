import {evaluateLending} from './lending-policy.mjs';
import {POLICY_VERSION} from './lending-objective.mjs';
import {lagBoundsFor,PROVIDER_LAG_MS} from './lending-rule-defaults.mjs';

const MICRO = 1000000, HOUR = 3600000;
const invalid = () => {throw Object.assign(new TypeError('invalid_decision_input'), {code:'invalid_decision_input',
  nextAction:{id:'repair_settings',label:'Check lending settings',target:{}}});};
const integer = n => Number.isSafeInteger(n) && n >= 0;
// Same joint maximum, zero forecast and scale-100 band used by the legacy bridge.
// A resource must cover the whole week with contiguous completed episodes.
function historyBand(rows,ids,weeklyResource,now) {
  const weekMs=7*24*HOUR,epoch='foundation-owner-traces/1',procedure='joint-max-utilization/zero-forecast/scale-100-v1';
  const weekly=rows.filter(r=>r.window_id===weeklyResource && r.length_ms===weekMs && r.resets_at<=now);
  const weeks=weekly.slice(-26).map(w=>{
    const upperScores={};let complete=true;
    for(const id of ids) {
      const episodes=rows.filter(r=>r.window_id===id && r.start_at>=w.start_at && r.resets_at<=w.resets_at)
        .sort((a,b)=>a.start_at-b.start_at);
      let cursor=w.start_at,total=0;
      for(const r of episodes) {
        const valid=r.complete && !r.censored && r.start_at===cursor && r.resets_at-r.start_at===r.length_ms &&
          r.trace.length>=2 && r.trace[0][0]===r.start_at && r.trace[0][1]===0 &&
          r.trace.at(-1)[0]===r.resets_at && r.trace.every(([t,v],j)=>integer(t) && t>=r.start_at && t<=r.resets_at &&
            Number.isFinite(v) && v>=0 && v<=100 && (!j || t>=r.trace[j-1][0] && v>=r.trace[j-1][1]));
        if(!valid) {cursor=-1;break;}
        cursor=r.resets_at;total+=r.trace.at(-1)[1]+r.rounding_points;
      }
      const covered=cursor===w.resets_at && Number.isFinite(total);
      complete &&= covered;upperScores[id]=covered?total/100:Infinity;
    }
    return {id:'week:'+w.resets_at,end:w.resets_at,epoch,procedure,complete,upperScores};
  });
  return {weekStart:now,epoch,procedure,domain:ids,weeks,
    forecasts:ids.map(id=>({id,domain:id,prediction:0,scale:100}))};
}
function validateDecisionInput(i) {
  if (!i || i.schemaVersion !== 1) invalid();
  const {nowMs:now, account, usage, policy, eligibility:e, ledger, history, job, runtime} = i;
  // A null job is the claim-time view of one account; a present job is its launch-time accounting.
  const jobValid = job === null || (job?.selection?.accountId === account.id &&
    job.selection.providerId === account.providerId && job.id && job.attemptId);
  if (!integer(now) || !account?.id || usage?.accountId !== account.id || ledger?.accountId !== account.id ||
      history?.accountId !== account.id || !jobValid ||
      e?.evaluatedAtMs !== now || e.settingsRevision !== policy?.revision || !runtime ||
      !Array.isArray(history.rows) || !Array.isArray(ledger.resources)) invalid();

}

// Pure production accounting boundary. Coordinates describe room before allocator
// risk, duration and saved ceilings; they are not a promise to lend all that room.
// A null job is the claim-time answer for one account (what it would lend now); a job
// is the same accounting at launch, with that attempt's own live readings included.
export function normalizeLendingAccounting(i) {
  validateDecisionInput(i);
  const {nowMs:now,account,usage,policy,ledger,history,job}=i;
  const reading = usage.reading;
  if (reading && (reading.accountId !== account.id || !integer(reading.observedAtMs) || reading.observedAtMs > now)) invalid();
  const age = reading ? now - reading.observedAtMs : 0;
  const source = reading?.windows ?? [{id:'seven_day',instance:null,capacityMicro:100*MICRO,usedHiMicro:0,
    resetsAtMs:now+7*24*HOUR,maxOwnerRateMicroPerMs:null}];
  if (!source.length) invalid();
  const liveRows=source.map(w=>({window_id:w.id,trace:usage.jobReadings?.filter(r=>r.accountId===account.id &&
    job && r.attemptId===job.attemptId && r.semantics==='cumulative' && r.atMs<=now)
    .map(r=>[r.atMs,r.windowDebits.find(d=>d.id===w.id && d.instance===w.instance)?.micro])
    .filter(([,v])=>integer(v)).map(([t,v])=>[t,v/MICRO]).sort((a,b)=>a[0]-b[0]) ?? []}));
  const bounds = lagBoundsFor({windows:source, rows:history.rows,liveRows, now});
  const windows = Object.fromEntries(source.map(w => {
    if (!w.id || !integer(w.capacityMicro) || w.capacityMicro !== 100*MICRO || !integer(w.usedHiMicro) ||
        w.usedHiMicro > w.capacityMicro || (reading && !w.instance)) invalid();
    const rows = ledger.resources.filter(r => r.id === w.id && (r.instance === w.instance || r.instance === null) && r.unit === 'window_micro_points');
    if (rows.some(r => ![r.reserved,r.unrepresented,r.consumed].every(integer))) invalid();
    const debt = rows.reduce((n,r) => n+r.unrepresented,0);
    const reserved = rows.reduce((n,r) => n+r.reserved,0);
    const rate = w.maxOwnerRateMicroPerMs ?? bounds.maxPointsPerHour[w.id]*MICRO/HOUR;
    if (!Number.isFinite(rate) || rate < 0) invalid();
    // Eq17: aggregate upper + incremental owner + unrepresented borrower; reservations once.
    const upper = Math.min(w.capacityMicro,w.usedHiMicro+Math.ceil((reading?age:PROVIDER_LAG_MS)*rate)+debt);
    return [w.id,{known:true,fresh:true,compatible:true,kind:w.id === 'seven_day' ? 'weekly' : 'short',
      // Fixed share caps spent plus held exposure; committedMicro separately
      // reserves aggregate capacity once. Do not add reservations to usedMicro.
      usedMicro:upper,committedMicro:reserved,lentMicro:rows.reduce((n,r)=>n+r.consumed,0)+reserved,
      resetAtMs:w.resetsAtMs ?? now+7*24*HOUR,conversion:'native_window',pointsPerUsdMicro:null}];
  }));
  const ids = Object.keys(windows), weeklyResource = windows.seven_day ? 'seven_day' : ids[0];
  windows[weeklyResource].kind = 'weekly';
  const savedPolicy={strategy:policy.strategy,strategyParams:policy.strategyParams,protectionPosition:policy.protectionPosition};
  const evaluation = {policy:savedPolicy,objectiveInput:{now,observedAt:reading?.observedAtMs ?? now,
    windows,weeklyResource,pointsOnly:true,laterBurnCapacityMicro:0,
    gates:{consent:true,limits:true,funding:true,stopping:true},
    band:historyBand(history.rows,ids,weeklyResource,now),
    job:{wallMs:policy.strategyParams.wallLimitMs ?? 60000,stopMs:10000,uncertaintyMs:0,
      friendValue:1,estimateUsdMicro:0,requestedUsdMicro:null,worstCallUsdMicro:0}}};
  const coordinates=source.map(w=>({id:w.id,instance:w.instance,unit:'window_micro_points',
    upperMicro:windows[w.id].usedMicro,reservedMicro:windows[w.id].committedMicro,
    remainingMicro:Math.max(0,w.capacityMicro-windows[w.id].usedMicro-windows[w.id].committedMicro)}));
  return {reading,age,source,coordinates,evaluation};
}

export function decideLending(i) {
  validateDecisionInput(i);
  const {nowMs:now,account,usage,policy,eligibility:e,job,runtime}=i;
  const action = (id,label) => ({id,label,target:{accountId:account.id,...(job?{jobId:job.id}:{})}});
  const hold = (code,id,label) => ({schemaVersion:1,kind:'hold',code,nextAction:action(id,label)});
  if (!policy.enabled || !e.enabledNow || !account.enabled) return hold('lending_off','enable_lending','Turn lending on');
  if (!runtime.canStart) return {schemaVersion:1,kind:'hold',code:'sandbox_cannot_start',
    nextAction:runtime.nextAction ?? action('repair_sandbox','Open sandbox setup')};
  if (account.authState !== 'signed_in' || usage.state==='signed_out') return hold('account_signed_out','sign_in','Sign in to this account');
  if (usage.state === 'limit' && (usage.limitResetAtMs === null || usage.limitResetAtMs > now))
    return hold('provider_limit_reached','wait_for_reset',usage.limitResetAtMs === null ? 'Check provider allowance' : 'Wait until allowance resets');
  if (!['automatic','fixed_share','custom'].includes(policy.strategy))
    throw Object.assign(new TypeError('strategy_unsupported'),{code:'strategy_unsupported',nextAction:action('select_strategy','Choose lending settings')});
  const {reading,age,source,evaluation}=normalizeLendingAccounting(i);
  const result=evaluateLending(evaluation);
  const byResource = Object.entries(result.reservePointsMicro ?? {}).filter(([,n])=>n>0)
    .map(([id,amount])=>({id,instance:source.find(w=>w.id===id).instance,amount}));
  if (!result.admitted || !byResource.length) {
    const deadlines = [usage.nextReadAtMs,e.nextChangeAtMs,...source.map(w=>w.resetsAtMs)].filter(t=>integer(t)&&t>now);
    const nextEvaluationAtMs = deadlines.length ? Math.min(...deadlines) : now+120000;
    return {schemaVersion:1,kind:'wait',reason:result.reason,strategy:policy.strategy,nextEvaluationAtMs,
      nextAction:action('wait_for_spare','No spare allowance estimated now')};
  }
  return {schemaVersion:1,kind:'lend',amount:{unit:'window_micro_points',byResource},
    mode:!reading ? 'cold_pace' : age ? 'aged' : 'observed',readingAgeMs:reading ? age : null,
    policyVersion:POLICY_VERSION,diagnostics:[...(!reading ? ['cold rate floor: 20 points/hour'] : []),
      'Estimated allowance; no hard spending bound',...(reading?.coverage.kind !== 'proven' ? ['Unknown coverage may double reserve borrower use'] : [])]};
}
