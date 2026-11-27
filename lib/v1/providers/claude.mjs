import {isDeepStrictEqual as equal} from 'node:util';
import {createHostAdapter} from './host-adapter.mjs';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const id = x => typeof x === 'string' && x.length > 0;
const integer = x => Number.isSafeInteger(x) && x >= 0;
const strings = x => Array.isArray(x) && x.every(id);
const unique = xs => new Set(xs).size === xs.length;
const fault = (code, accountId) => ({ok:false,error:{code,retryAtMs:null,
  nextAction:{id:code === 'invalid_provider_response' ? 'report_provider_error' : 'select_provider',
    label:code === 'invalid_provider_response' ? 'Report a provider error' : 'Select a supported provider, model or effort',
    target:id(accountId) ? {accountId} : {}}}});
const providerCodes=new Set(['provider_not_found','signin_cancelled','signin_expired','signin_failed',
  'account_exists','adapter_unsupported','account_signed_out','auth_expired','auth_temporarily_unavailable',
  'refresh_uncertain','destination_denied','model_unavailable','effort_unavailable','invalid_provider_response']);
function providerFault(result,accountId) {
  if (!providerCodes.has(result?.error?.code)) return fault('invalid_provider_response',accountId);
  const answer=fault(result.error.code,accountId);
  if (result.error.retryAtMs===null || integer(result.error.retryAtMs)) answer.error.retryAtMs=result.error.retryAtMs;
  return answer;
}
function freeze(value) {
  if (object(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function validDescriptor(d) {
  return object(d) && d.schemaVersion === 1 && id(d.id) && id(d.label) &&
    ['browser_oauth','device_code','api_key','local_harness'].includes(d.signInKind) &&
    ['rotating','reusable','none'].includes(d.refreshKind) &&
    ['remote','job_local','none'].includes(d.usageKind) &&
    (d.maxConcurrentJobs === null || integer(d.maxConcurrentJobs) && d.maxConcurrentJobs > 0) &&
    Array.isArray(d.models) && unique(d.models.map(m=>m?.id)) && d.models.every(m=>
      object(m) && id(m.id) && id(m.label) && typeof m.enabled === 'boolean' &&
      Number.isFinite(m.rank) && (m.pareto === null || typeof m.pareto === 'boolean') &&
      Array.isArray(m.efforts) && unique(m.efforts.map(e=>e?.id)) &&
      m.efforts.every(e=>object(e)&&id(e.id)&&id(e.label)) &&
      (m.defaultEffort === null || m.efforts.some(e=>e.id === m.defaultEffort))) &&
    Array.isArray(d.nativeUnits) && unique(d.nativeUnits.map(u=>u?.id)) &&
    d.nativeUnits.every(u=>object(u)&&id(u.id)&&integer(u.scale)&&u.scale>0) &&
    Array.isArray(d.destinations) && d.destinations.every(x=>{
      try {return object(x) && new URL(x.origin).origin === x.origin &&
        ['http:','https:'].includes(new URL(x.origin).protocol) &&
        strings(x.pathPrefixes) && x.pathPrefixes.every(p=>p.startsWith('/')&&!/[?#]/.test(p)) &&
        strings(x.methods) && x.methods.every(m=>/^[A-Z]+$/.test(m));}
      catch {return false;}
    });
}
function amountValid(a,d,mode) {
  if (!object(a) || !['native','window_micro_points'].includes(a.unit) ||
      !Array.isArray(a.byResource)) return false;
  if (a.unit === 'native' && !d.nativeUnits.some(u=>u.id === a.nativeUnit)) return false;
  if (a.unit !== 'native' && a.nativeUnit !== undefined) return false;
  const keys=a.byResource.map(r=>JSON.stringify([r?.id,r?.instance]));
  return unique(keys) && a.byResource.every(r=>object(r)&&id(r.id)&&
    (id(r.instance)||(r.instance===null&&mode==='cold_pace'))&&integer(r.amount)) &&
    (a.byResource.length===0 || a.byResource.some(r=>r.amount>0));
}
function selectionCode(s,d) {
  if (!object(s)||!id(s.accountId)||s.providerId!==d.id) return 'job_binding_mismatch';
  const model=d.models.find(m=>m.id===s.modelId&&m.enabled);
  if (!model) return 'model_unavailable';
  if (s.effortId === null) return model.defaultEffort === null ? null : 'effort_unavailable';
  return model.efforts.some(e=>e.id===s.effortId) ? null : 'effort_unavailable';
}
function bindingValid(x,d) {
  const r=x.receipt,e=x.enforcement;
  return object(r)&&r.schemaVersion===1&&r.accountId===x.selection.accountId&&
    id(r.jobId)&&id(r.attemptId)&&id(r.policyVersion)&&integer(r.quotedLedgerRevision)&&
    integer(r.settingsRevision)&&integer(r.evaluatedAtMs)&&
    ['observed','aged','cold_pace'].includes(r.mode)&&amountValid(r.amount,d,r.mode)&&
    object(e)&&equal(e.amount,r.amount)&&integer(e.wallLimitMs)&&e.wallLimitMs>0&&
    e.stopOnBudget===true&&['measured','estimated'].includes(e.metering)&&
    Array.isArray(e.limitations)&&e.limitations.every(s=>typeof s==='string')&&
    object(x.job)&&equal(x.job.selection,x.selection)&&id(x.jobKey);
}
function allowed(request,d) {
  try {
    if (!object(request)||!id(request.method)||!id(request.url)) return false;
    const u=new URL(request.url);
    if (u.username||u.password) return false;
    // Reject encoded separators rather than rely on an upstream server's decoding policy.
    if (/%2f|%5c/i.test(u.pathname)||u.pathname.includes('\\')) return false;
    return d.destinations.some(dest=>u.origin===dest.origin&&dest.methods.includes(request.method)&&
      dest.pathPrefixes.some(prefix=>u.pathname===prefix||
        u.pathname.startsWith(prefix.endsWith('/')?prefix:prefix+'/')));
  } catch {return false;}
}
function bodyValid(b) {
  return object(b)&&(b.kind==='empty' ||
    b.kind==='replayable'&&typeof b.open==='function'&&typeof b.dispose==='function' ||
    b.kind==='one_shot'&&b.stream instanceof ReadableStream&&typeof b.dispose==='function');
}
function readingValid(r,x,d) {
  return object(r)&&r.schemaVersion===1&&r.accountId===x.accountId&&r.attemptId===x.attemptId&&
    id(r.eventId)&&integer(r.sequence)&&integer(r.atMs)&&
    ['cumulative','delta'].includes(r.semantics)&&id(r.meterEpoch)&&
    object(r.amount)&&integer(r.amount.value)&&
    (r.amount.unit==='window_micro_points'||d.nativeUnits.some(u=>u.id===r.amount.unit))&&
    Array.isArray(r.windowDebits)&&unique(r.windowDebits.map(w=>JSON.stringify([w?.id,w?.instance])))&&
    r.windowDebits.every(w=>object(w)&&id(w.id)&&id(w.instance)&&integer(w.micro));
}
function runValid(r,x) {
  return object(r)&&r.schemaVersion===1&&id(r.command)&&Array.isArray(r.args)&&
    r.args.every(a=>typeof a==='string')&&object(r.env)&&
    Object.values(r.env).every(v=>typeof v==='string')&&object(r.proxy)&&
    equal(r.receipt,x.receipt)&&equal(r.enforcement,x.enforcement);
}
// Configured host adapter only. This does not discover CLI state, enroll a real
// account, qualify transport, or authorize a job/lease independently of launch.
export function createClaudeProvider(options={}) {
  const effects=options.effects??{};
  const descriptor=freeze(structuredClone(options.descriptor));
  const generic=createHostAdapter({...options,descriptor});
  const configured=validDescriptor(descriptor);
  return {...generic,
    makeRun(input) {
      if (typeof effects.makeRun!=='function') return fault('adapter_unsupported');
      if (!configured) return fault('adapter_unsupported');
      const selectionError=selectionCode(input?.selection,descriptor);
      if (selectionError) return fault(selectionError,input?.selection?.accountId);
      try {
        if (!bindingValid(input,descriptor)) return fault('job_binding_mismatch',input.selection.accountId);
        // Deliberately pick fields: host auth or extra caller fields cannot enter RunSpec mapping.
        const approved=structuredClone({selection:input.selection,jobKey:input.jobKey,job:input.job,
          receipt:input.receipt,enforcement:input.enforcement});
        const mapped=structuredClone(approved);
        const result=effects.makeRun(mapped);
        if (!equal(mapped.selection,approved.selection) || !equal(mapped.receipt,approved.receipt) ||
            !equal(mapped.enforcement,approved.enforcement) || !equal(mapped.job.selection,approved.selection)) return fault('invalid_provider_response');
        if (result?.ok===false) return providerFault(result,approved.selection.accountId);
        if (result?.ok!==true||!runValid(result.value,approved)) return fault('invalid_provider_response');
        const {schemaVersion,command,args,env,proxy,receipt,enforcement}=result.value;
        return {ok:true,value:structuredClone({schemaVersion,command,args,env,proxy,receipt,enforcement})};
      } catch {return fault('invalid_provider_response');}
    },
    async authorizeRequest(input) {
      if (typeof effects.authorizeRequest!=='function') return fault('adapter_unsupported');
      if (!configured) return fault('adapter_unsupported');
      const auth=input?.auth,request=input?.request;
      if (!object(auth)||!id(auth.accountId)||auth.providerId!==descriptor.id||
          !integer(auth.generation)||!Object.hasOwn(auth,'secret')) return fault('job_binding_mismatch');
      if (!allowed(request,descriptor)||!bodyValid(request.body)) return fault('destination_denied',auth.accountId);
      try {
        // Freeze a host-only copy, not the caller's secret or the owned BodySource.
        const host=freeze(structuredClone(auth));
        const copied=Object.freeze({method:request.method,url:request.url,
          headers:Object.freeze({...request.headers}),body:request.body});
        const result=await effects.authorizeRequest({auth:host,request:copied});
        if (result?.ok===false) return providerFault(result,auth.accountId);
        if (result?.ok!==true||!allowed(result.value,descriptor)||
            result.value.body!==request.body||result.value.method!==request.method||
            result.value.url!==request.url||!object(result.value.headers))
          return fault('invalid_provider_response',auth.accountId);
        return result;
      } catch {return fault('invalid_provider_response',auth.accountId);}
    },
    parseJobUsage(input) {
      if (typeof effects.parseJobUsage!=='function') return fault('invalid_provider_response');
      if (!configured||!id(input?.accountId)||!id(input?.attemptId)) return fault('invalid_provider_response');
      try {
        const original=structuredClone(input),result=effects.parseJobUsage(structuredClone(original));
        if (result?.ok!==true||!readingValid(result.value,original,descriptor)) return fault('invalid_provider_response',original.accountId);
        return {ok:true,value:freeze(structuredClone(result.value))};
      } catch {return fault('invalid_provider_response');}
    },
    // Conservative classification: no retries, even if a configured mapper asks for them.
    classifyReplay:()=> 'never',
  };
}
