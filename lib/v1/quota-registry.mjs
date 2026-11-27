// Pure, versioned quota definitions. A seed is a vocabulary, NOT a verified account roster.
const text = x => typeof x === 'string' && x.length > 0;
const positive = x => Number.isFinite(x) && x > 0;
const bound = x => x && Number.isFinite(x.lower) && Number.isFinite(x.upper) && x.lower >= 0 && x.upper >= x.lower;
// A limit whose job charge is not known in dollars: the job is held to an allowance in the limit's own unit, read from the
// live meter. It has no model weight at all; a missing weight is never stood in for by a number.
export const NATIVE_WINDOW_WEIGHTS = 'native-window/1';
// Both native provider meters currently report whole percentage points.
export const PROVIDER_PERCENT_UNCERTAINTY_MICRO = 1_000_000;
// The provider's reset for one window can move this far between reads.
export const RESET_JITTER_MS = 60_000;
const nativeWindow = l => l.weights.version === NATIVE_WINDOW_WEIGHTS && l.weights.nativeUnit === l.unit &&
  Object.keys(l.weights.byModel).length === 0;
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
export function createQuotaRegistry({version, complete, limits}) {
  if (!text(version) || typeof complete !== 'boolean' || !Array.isArray(limits)) throw new TypeError('invalid registry');
  const ids = new Set();
  for (const l of limits) {
    if (!text(l?.id) || ids.has(l.id) || !text(l.provider) || !text(l.unit) ||
        !(l.capacity === null || positive(l.capacity)) || !(l.durationMs === null || positive(l.durationMs)) ||
        !l.reset || ![null,'fixed','rolling','first-use'].includes(l.reset.kind) ||
        !l.scope || !['account','model_family','model','speed','class'].includes(l.scope.kind) ||
        (l.scope.kind !== 'account' && (!Array.isArray(l.scope.values) || !l.scope.values.length || !l.scope.values.every(text))) ||
        !text(l.weights?.version) || !text(l.weights?.nativeUnit) || !l.weights.byModel || Array.isArray(l.weights.byModel) ||
        Object.values(l.weights.byModel).some(v => !(v === null || positive(v)))) throw new TypeError('invalid limit definition');
    if (l.reset.kind === 'fixed' && !(l.reset.anchorMs === null || Number.isFinite(l.reset.anchorMs))) throw new TypeError('invalid anchor');
    ids.add(l.id);
  }
  return freeze(structuredClone({schema:1,version,complete,limits}));
}
function applicable(l,job) {
  if (!text(job?.provider) || !text(job.model)) return null;
  if (l.provider !== job.provider) return false;
  if (l.scope.kind === 'account') return true;
  const field = l.scope.kind === 'model_family' ? (job.modelFamily ?? /^claude-(haiku|sonnet|opus)(?:-|$)/.exec(job.model)?.[1]) : job[l.scope.kind];
  return text(field) ? l.scope.values.includes(field) : null;
}
export function quotaRoster(registry, job) {
  const r=createQuotaRegistry(registry), rows=[];
  for (const l of r.limits) {
    const applies=applicable(l,job);
    if (applies === false) { rows.push({id:l.id,status:'inapplicable',applicable:false,charge:null}); continue; }
    let reason=applies === null ? 'unknown_applicability' : null;
    if (!reason && (!positive(l.capacity) || !positive(l.durationMs) || !l.reset.kind ||
        (l.reset.kind === 'fixed' && !Number.isFinite(l.reset.anchorMs)))) reason='unknown_definition';
    if (!reason && nativeWindow(l)) {
      rows.push({id:l.id,applicable:applies,status:'supported',reason:null,charge:null,nativeWindow:true,
        capacity:l.capacity,durationMs:l.durationMs,reset:l.reset,weightVersion:l.weights.version});
      continue;
    }
    const weight=Object.hasOwn(l.weights.byModel,job?.model) ? l.weights.byModel[job.model] : null;
    if (!reason && !positive(weight)) reason='unknown_weight';
    const cost=job?.nativeCostBounds;
    if (!reason && (!bound(cost) || cost.unit !== l.weights.nativeUnit)) reason='unknown_native_cost';
    const charge=reason ? null : {lower:cost.lower*weight,upper:cost.upper*weight,unit:l.unit};
    if (charge && (!Number.isFinite(charge.upper) || (cost.upper > 0 && charge.upper === 0))) reason='unsafe_charge';
    rows.push({id:l.id,applicable:applies,status:reason?'unsupported':'supported',reason,
      charge:reason?null:charge,capacity:l.capacity,durationMs:l.durationMs,reset:l.reset,weightVersion:l.weights.version});
  }
  const supported=r.complete && text(job?.provider) && text(job.model) && rows.some(x=>x.applicable===true) &&
    rows.every(x=>x.status==='supported'||x.status==='inapplicable');
  return {registryVersion:r.version,supported:Boolean(supported),reason:!r.complete?'incomplete_registry':supported?null:'unsupported_roster',rows};
}
export function reconcileQuotaSnapshot(registry, job, snapshot, now) {
  const roster=quotaRoster(registry,job), readings=snapshot?.windows;
  if (!Array.isArray(readings) || !Number.isFinite(now)) return {...roster,supported:false,reason:'invalid_snapshot',rows:[]};
  const ids=readings.map(x=>x?.window_id);
  if (ids.some(x=>!text(x)) || new Set(ids).size !== ids.length) return {...roster,supported:false,reason:'ambiguous_readings',rows:[]};
  const rows=roster.rows.map(row=>{
    if (row.status==='inapplicable') return row;
    const reading=readings.find(x=>x.window_id===row.id);
    if (!reading) return {...row,status:'absent',reason:'missing_reading'};
    if (row.status==='unsupported') return {...row,status:'unknown',readingState:reading.state};
    if (reading.state==='not_open') return {...row,status:'not-open',reason:'epoch_not_open'};
    const definition=registry.limits.find(x=>x.id===row.id);
    const duration=reading.window_minutes*60000;
    const reset=reading.resets_at;
    const value=reading.used ?? (definition.unit==='quota_percent'?reading.used_pct:undefined);
    const fixedAligned=definition.reset.kind!=='fixed' ||
      Number.isSafeInteger((reset-definition.reset.anchorMs)/duration);
    if (reading.state!=='open' || duration!==definition.durationMs || !Number.isFinite(reset) || reset<=now ||
        !Number.isFinite(reading.observed_at) || reading.observed_at>now ||
        !Number.isFinite(value) || value<0 || value>definition.capacity || !fixedAligned)
      return {...row,status:'unknown',reason:'incompatible_reading'};
    return {...row,status:'open',reason:null};
  });
  for (const id of ids) if (!registry.limits.some(x=>x.id===id)) rows.push({id,status:'unregistered',reason:'unregistered_limit',charge:null});
  return {...roster,rows,supported:roster.supported && rows.every(x=>x.status==='open'||x.status==='inapplicable')};
}
/** Known meter vocabulary only. Reset mechanics, native capacities and conversion weights are NOT inferred.
 * quota_percent capacity 100 describes the meter scale, not tokens/USD included in a subscription.
 * Codex durations are supplied explicitly; a new duration needs no rule-code change.
 */
const CLAUDE_METER_MINUTES=Object.freeze({five_hour:300,seven_day:10080,seven_day_opus:10080,seven_day_sonnet:10080,seven_day_oauth_apps:10080,seven_day_overage_included:10080});
/** The provider whose meter names this window id, or null for an id outside the known vocabulary. */
export function meterProvider(id) {
  if (typeof id !== 'string') return null;
  if (/^codex:(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)$/.test(id)) return 'codex';
  return Object.hasOwn(CLAUDE_METER_MINUTES, id) ? 'claude' : null;
}
export function seedQuotaRegistry({codexWindowMinutes=[]}={}) {
  if (!Array.isArray(codexWindowMinutes) || codexWindowMinutes.some(x=>!positive(x))) throw new TypeError('invalid Codex duration');
  const claude=CLAUDE_METER_MINUTES;
  const make=(id,provider,minutes,scope)=>({id,provider,unit:'quota_percent',capacity:100,durationMs:minutes*60000,
    reset:{kind:null,anchorMs:null},scope,weights:{version:'unknown',nativeUnit:'unknown',byModel:{}}});
  return createQuotaRegistry({version:'meter-vocabulary/1',complete:false,limits:[
    ...Object.entries(claude).map(([id,m])=>make(id,'claude',m,
      id==='seven_day_opus'||id==='seven_day_sonnet'?{kind:'model_family',values:[id.slice(10)]}:
      id==='seven_day_oauth_apps'?{kind:'class',values:['oauth_app']}:
      id==='seven_day_overage_included'?{kind:'class',values:['overage_included']}:{kind:'account'})),
    ...[...new Set(codexWindowMinutes)].map(m=>make('codex:'+m,'codex',m,{kind:'account'}))]});
}
