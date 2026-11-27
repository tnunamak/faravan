import { isDeepStrictEqual } from 'node:util';
import { createHostAdapter } from './host-adapter.mjs';

// Configured host boundary, not a qualified CLI installation. The host owns
// concrete command/proxy mapping, enrollment and opaque HostSecret handling.
// No legacy native credential copy, model catalog, inference URL or shell default.
const obj=x=>!!x && typeof x==='object' && !Array.isArray(x);
const str=x=>typeof x==='string' && x.length>0;
const nat=x=>Number.isSafeInteger(x) && x>=0;
const fail=code=>({ok:false,error:{code,retryAtMs:null,nextAction:{
  id:'provider_settings',label:'Check provider configuration',target:{}}}});
const clone=x=>structuredClone(x);
function freeze(x) { if(x && typeof x==='object') { for(const v of Object.values(x)) freeze(v);Object.freeze(x); } return x; }
function descriptorValid(d) {
  return obj(d)&&d.schemaVersion===1&&d.id==='codex'&&str(d.label)&&
    ['browser_oauth','device_code','api_key','local_harness'].includes(d.signInKind)&&
    ['rotating','reusable','none'].includes(d.refreshKind)&&['remote','job_local','none'].includes(d.usageKind)&&
    (d.maxConcurrentJobs===null||(nat(d.maxConcurrentJobs)&&d.maxConcurrentJobs>0))&&
    Array.isArray(d.models)&&d.models.every(m=>obj(m)&&str(m.id)&&str(m.label)&&
      typeof m.enabled==='boolean'&&Number.isFinite(m.rank)&&(m.pareto===null||typeof m.pareto==='boolean')&&
      Array.isArray(m.efforts)&&m.efforts.every(e=>str(e.id)&&str(e.label))&&
      new Set(m.efforts.map(e=>e.id)).size===m.efforts.length&&
      (m.defaultEffort===null||m.efforts.some(e=>e.id===m.defaultEffort)))&&
    new Set(d.models.map(m=>m.id)).size===d.models.length&&
    Array.isArray(d.nativeUnits)&&d.nativeUnits.every(u=>str(u.id)&&nat(u.scale)&&u.scale>0)&&
    new Set(d.nativeUnits.map(u=>u.id)).size===d.nativeUnits.length&&
    Array.isArray(d.destinations)&&d.destinations.every(v=>{
      try { const u=new URL(v.origin); return u.protocol==='https:'&&u.origin===v.origin&&
        Array.isArray(v.pathPrefixes)&&v.pathPrefixes.length>0&&v.pathPrefixes.every(p=>str(p)&&p.startsWith('/'))&&
        Array.isArray(v.methods)&&v.methods.length>0&&v.methods.every(m=>str(m)&&m===m.toUpperCase()); }
      catch{return false;}
    });
}
function allowed(d,r) {
  try { const u=new URL(r.url);return !u.username&&!u.password&&!u.hash&&
    d.destinations.some(v=>v.origin===u.origin&&v.methods.includes(r.method)&&v.pathPrefixes.some(p=>u.pathname.startsWith(p))); }
  catch{return false;}
}
function amountValid(a,d) {
  return obj(a)&&['native','window_micro_points'].includes(a.unit)&&
    (a.unit!=='native'||d.nativeUnits.some(u=>u.id===a.nativeUnit))&&
    Array.isArray(a.byResource)&&a.byResource.length>0&&a.byResource.every(r=>
      obj(r)&&str(r.id)&&(r.instance===null||str(r.instance))&&nat(r.amount))&&
    new Set(a.byResource.map(r=>JSON.stringify([r.id,r.instance]))).size===a.byResource.length;
}
function approvalValid(r,e,s,d) {
  return obj(r)&&r.schemaVersion===1&&r.accountId===s.accountId&&str(r.jobId)&&str(r.attemptId)&&
    str(r.policyVersion)&&nat(r.quotedLedgerRevision)&&nat(r.settingsRevision)&&nat(r.evaluatedAtMs)&&
    ['observed','aged','cold_pace'].includes(r.mode)&&amountValid(r.amount,d)&&obj(e)&&
    isDeepStrictEqual(r.amount,e.amount)&&nat(e.wallLimitMs)&&e.wallLimitMs>0&&e.stopOnBudget===true&&
    ['measured','estimated'].includes(e.metering)&&Array.isArray(e.limitations)&&e.limitations.every(x=>typeof x==='string');
}
function readingValid(r,x,d) {
  return obj(r)&&r.schemaVersion===1&&r.accountId===x.accountId&&r.attemptId===x.attemptId&&
    str(r.accountId)&&str(r.attemptId)&&str(r.eventId)&&nat(r.sequence)&&nat(r.atMs)&&
    ['delta','cumulative'].includes(r.semantics)&&str(r.meterEpoch)&&obj(r.amount)&&
    d.nativeUnits.some(u=>u.id===r.amount.unit)&&nat(r.amount.value)&&Array.isArray(r.windowDebits)&&
    r.windowDebits.every(w=>obj(w)&&str(w.id)&&str(w.instance)&&nat(w.micro))&&
    new Set(r.windowDebits.map(w=>JSON.stringify([w.id,w.instance]))).size===r.windowDebits.length;
}
function localReading(x,d) {
  const e=x?.event,raw=e?.raw,u=raw?.usage;
  // Codex harness lifecycle grammar; cached input is already part of input.
  if(raw?.type!=='turn.completed'||!nat(u?.input_tokens)||!nat(u?.output_tokens)||
    !nat(u.input_tokens+u.output_tokens)||!d.nativeUnits.some(u=>u.id==='tokens'&&u.scale===1))
    return fail('invalid_provider_response');
  const r={schemaVersion:1,accountId:x.accountId,attemptId:x.attemptId,eventId:e.eventId,
    sequence:e.sequence,atMs:e.atMs,semantics:'delta',meterEpoch:e.meterEpoch,
    amount:{unit:'tokens',value:u.input_tokens+u.output_tokens},windowDebits:e.windowDebits??[]};
  return readingValid(r,x,d)?{ok:true,value:clone(r)}:fail('invalid_provider_response');
}
export function createCodexProvider(options={}) {
  const effects=options.effects??{};
  let d;
  try { if(descriptorValid(options.descriptor)) d=freeze(clone(options.descriptor)); } catch {}
  const base=createHostAdapter({...options,descriptor:d,effects});
  return {...base,descriptor:d,
    makeRun(input) {
      if(!d||typeof effects.makeRun!=='function') return fail('adapter_unsupported');
      try {
        const s=input?.selection;
        if(!obj(s)||s.providerId!==d.id||!str(s.accountId)) return fail('job_binding_mismatch');
        const m=d.models.find(m=>m.enabled&&m.id===s.modelId);
        if(!m) return fail('model_unavailable');
        if(m.efforts.length ? !m.efforts.some(e=>e.id===s.effortId) : s.effortId!==null)
          return fail('effort_unavailable');
        if(!str(input.jobKey)||!obj(input.job)||!approvalValid(input.receipt,input.enforcement,s,d))
          return fail('job_binding_mismatch');
        // Opaque job is cloned intact; only the frozen five fields cross mapping.
        const safe=freeze(clone({selection:s,jobKey:input.jobKey,job:input.job,
          receipt:input.receipt,enforcement:input.enforcement}));
        const result=effects.makeRun(safe);
        if(result?.ok===false) return fail('adapter_unsupported');
        const r=result?.value;
        if(result?.ok!==true||!obj(r)||r.schemaVersion!==1||!str(r.command)||
          Object.keys(r).some(k=>!['schemaVersion','command','args','env','proxy','receipt','enforcement'].includes(k))||
          !Array.isArray(r.args)||!r.args.every(a=>typeof a==='string')||!obj(r.env)||
          !Object.values(r.env).every(v=>typeof v==='string')||!obj(r.proxy)||
          !isDeepStrictEqual(r.receipt,safe.receipt)||!isDeepStrictEqual(r.enforcement,safe.enforcement))
          return fail('invalid_provider_response');
        return {ok:true,value:clone(r)};
      } catch {return fail('invalid_provider_response');}
    },
    async authorizeRequest(input) {
      if(!d||typeof effects.authorizeRequest!=='function') return fail('adapter_unsupported');
      const a=input?.auth,r=input?.request;
      if(!obj(a)||a.providerId!==d.id||!str(a.accountId)||!nat(a.generation))
        return fail('job_binding_mismatch');
      if(!obj(r)||!allowed(d,r)) return fail('destination_denied');
      if(!obj(r.headers)||!obj(r.body)||!['empty','one_shot','replayable'].includes(r.body.kind))
        return fail('invalid_provider_response');
      try {
        // Broker owns key/lease checks. Remove guest identity hints before the
        // trusted host authorizer injects the harness Authorization: Bearer value.
        const headers=Object.fromEntries(Object.entries(r.headers).filter(([k])=>
          !/^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-account-id|chatgpt-account-id|x-job-key)$/i.test(k)));
        const request=Object.freeze({method:r.method,url:r.url,headers:Object.freeze(headers),body:r.body});
        const auth=Object.freeze({accountId:a.accountId,providerId:a.providerId,generation:a.generation,secret:a.secret});
        const result=await effects.authorizeRequest({auth,request});
        if(result?.ok===false) return fail('auth_temporarily_unavailable');
        const v=result?.value;
        if(result?.ok!==true||!obj(v)||v.method!==request.method||v.url!==request.url||
          v.body!==request.body||!obj(v.headers)||!Object.values(v.headers).every(h=>typeof h==='string'))
          return fail('invalid_provider_response');
        return {ok:true,value:{method:v.method,url:v.url,headers:{...v.headers},body:r.body}};
      } catch{return fail('invalid_provider_response');}
    },
    // Only authenticated transport bytes enter this parser. CLI stdout and
    // request parameters are not observations of the served model.
    parseExecutionResponse({body,contentType}) {
      try {
        let response;
        if(contentType.split(';')[0].trim()==='application/json')response=JSON.parse(body);
        else if(contentType.split(';')[0].trim()==='text/event-stream') {
          const completed=body.split(/\r?\n\r?\n/).map(frame=>frame.split(/\r?\n/)
            .filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n'))
            .filter(Boolean).filter(value=>value!=='[DONE]').map(value=>JSON.parse(value))
            .filter(event=>event.type==='response.completed');
          if(completed.length!==1)return null;
          response=completed[0].response;
        } else return null;
        // OpenAI Responses schema: object=response, model and terminal status.
        // https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts
        if(response?.object!=='response'||response.status!=='completed'||!str(response.id)||
          !str(response.model)||response.model.length>256||/[\u0000-\u0020\u007f]/.test(response.model))return null;
        return {model:response.model};
      } catch {return null;}
    },
    classifyReplay:()=> 'never',
    parseJobUsage(input) {
      if(!d) return fail('adapter_unsupported');
      try {
        const x=freeze(clone(input));
        if(!str(x.accountId)||!str(x.attemptId)) return fail('invalid_provider_response');
        if(typeof effects.parseJobUsage!=='function') return localReading(x,d);
        const result=effects.parseJobUsage(x);
        return result?.ok===true&&readingValid(result.value,x,d)?
          {ok:true,value:clone(result.value)}:fail('invalid_provider_response');
      } catch{return fail('invalid_provider_response');}
    },
  };
}
