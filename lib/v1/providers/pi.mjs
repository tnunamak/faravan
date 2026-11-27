import { randomUUID } from 'node:crypto';
import { ok, fault } from '../accounts.mjs';

const text = value => typeof value === 'string' && value.length > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const validBinding = b => b && text(b.operationId) && text(b.keyId) && text(b.jobId) &&
  text(b.attemptId) && integer(b.generation) && integer(b.fence) &&
  b.selection && ['accountId','providerId','modelId'].every(k=>text(b.selection[k])) &&
  (b.selection.effortId === null || text(b.selection.effortId));

/** Private downstream only. Never install this as a guest listener.
 * A stop timeout is debt, not cessation. Its eventual receipt remains observable
 * on a later revoke, without issuing concurrent stop requests for that handle.
 */
export function createPiTransport({invoke}) {
  if (typeof invoke !== 'function') throw new TypeError('invalid_pi_invoke');
  const entries=new Map(), revoked=new Set();
  async function stopEntry(entry) {
    if (entry.receipt || !entry.handle) return;
    if (!entry.stopping) {
      const handle=entry.handle;
      entry.stopping=Promise.resolve().then(()=>handle.stop({reason:entry.reason})).then(result=>{
        if (result?.kind === 'ceased' && integer(result.ceasedAtMs) && result.ceasedAtMs <= Date.now()) {
          entry.receipt={operationId:entry.operationId,streamId:handle.streamId,ceasedAtMs:result.ceasedAtMs};
          entry.handle=null;
          entry.detach?.(); entry.detach=null;
        }
      },()=>{}).finally(()=>{entry.stopping=null;});
    }
    let timer;
    try { await Promise.race([entry.stopping,new Promise(resolve=>{timer=setTimeout(resolve,1000);})]); }
    finally { clearTimeout(timer); }
  }
  return {
    async dispatch({request,signal,binding}) {
      if (!validBinding(binding)) return fault('job_binding_mismatch');
      const b=structuredClone(binding);
      if (entries.has(b.operationId)) return fault('operation_conflict');
      if (revoked.has(b.keyId) || signal?.aborted) return fault('job_key_revoked');
      const controller=new AbortController();
      const entry={operationId:b.operationId,keyId:b.keyId,handle:null,receipt:null,
        stopping:null,revoked:false,reason:'revoked',controller,detach:null};
      const abort=()=> {
        entry.revoked=true; entry.reason='revoked'; controller.abort('revoked');
        void stopEntry(entry);
      };
      signal?.addEventListener('abort',abort,{once:true});
      entry.detach=()=>signal?.removeEventListener('abort',abort);
      entries.set(b.operationId,entry); // before any injected effect
      if (signal?.aborted) abort();
      if (entry.revoked) return fault('job_key_revoked');
      let result;
      try { result=await invoke({request,signal:controller.signal,binding:structuredClone(b)}); }
      catch { entry.detach?.(); entry.detach=null; return fault('auth_temporarily_unavailable'); }
      if (!result?.ok) { entry.detach?.(); entry.detach=null; return fault('auth_temporarily_unavailable'); }
      const handle=result.value;
      if (!handle || !text(handle.streamId) || typeof handle.stop !== 'function') {
        // A malformed effect result may still represent live work. Never erase it.
        return fault('invalid_provider_response');
      }
      entry.handle=handle;
      if (!(handle.response instanceof Response)) { entry.revoked=true; entry.reason='invalid_response'; }
      if (entry.revoked || revoked.has(b.keyId) || signal?.aborted) {
        entry.revoked=true; controller.abort(entry.reason);
        await stopEntry(entry);
        return fault('job_key_revoked');
      }
      return ok({streamId:handle.streamId,response:handle.response});
    },
    async revokeStreams({keyId,reason}) {
      revoked.add(keyId);
      const owned=[...entries.values()].filter(e=>e.keyId===keyId);
      for (const entry of owned) {
        entry.revoked=true; entry.reason=typeof reason==='string'?reason:'revoked';
        entry.controller.abort(entry.reason);
      }
      // All waits run together; one slow handle cannot multiply the timeout.
      await Promise.all(owned.map(stopEntry));
      const reconciled=owned.filter(e=>e.receipt).map(e=>({...e.receipt}));
      return {aborted:reconciled.map(r=>r.streamId),
        unconfirmed:owned.filter(e=>!e.receipt).map(e=>e.operationId),reconciled};
    },
  };
}

function localDestination(url, descriptor, method) {
  try {
    const u=new URL(url);
    if (u.username || u.password || u.hash || u.searchParams.has('accountId')) return false;
    if (u.protocol!=='http:' || !['127.0.0.1','[::1]','localhost'].includes(u.hostname)) return false;
    return descriptor.destinations.some(d=>d.origin===u.origin && d.methods.includes(method) &&
      d.pathPrefixes.some(prefix=>u.pathname===prefix || u.pathname.startsWith(prefix.endsWith('/')?prefix:prefix+'/')));
  } catch { return false; }
}

/** Configuration, not a universal pi command mapping. Identity is a trusted,
 * explicit host subject string, never inferred from a native store or request.
 * This adapter performs no process/network effects; the broker owns admission.
 */
export function createPiProvider({descriptor,identity,createRun,parseUsage}) {
  const d=structuredClone(descriptor);
  if (!d || d.schemaVersion!==1 || !text(d.id) || !text(d.label) || d.signInKind!=='local_harness' ||
      d.refreshKind!=='none' || !['none','job_local'].includes(d.usageKind) ||
      !text(identity) || typeof createRun!=='function' ||
      (d.usageKind==='job_local' && typeof parseUsage!=='function') ||
      !Array.isArray(d.models) || !d.models.length || !Array.isArray(d.destinations) || !d.destinations.length ||
      !Array.isArray(d.nativeUnits) || d.nativeUnits.some(u=>!text(u.id)||!Number.isSafeInteger(u.scale)||u.scale<=0) ||
      !(d.maxConcurrentJobs===null || (integer(d.maxConcurrentJobs)&&d.maxConcurrentJobs>0)) ||
      new Set(d.models.map(m=>m.id)).size!==d.models.length ||
      d.models.some(m=>!text(m.id)||!text(m.label)||typeof m.enabled!=='boolean'||!integer(m.rank)||
        !Array.isArray(m.efforts)||m.efforts.some(e=>!text(e.id)||!text(e.label))||
        new Set(m.efforts.map(e=>e.id)).size!==m.efforts.length ||
        !(m.defaultEffort===null || m.efforts.some(e=>e.id===m.defaultEffort))) ||
      d.destinations.some(v=>!text(v.origin)||!Array.isArray(v.methods)||!v.methods.length||
        v.methods.some(m=>!text(m)||m!==m.toUpperCase())||!Array.isArray(v.pathPrefixes)||!v.pathPrefixes.length||
        v.pathPrefixes.some(p=>!text(p)||!p.startsWith('/')||!localDestination(v.origin+p,{destinations:[v]},v.methods[0]))))
    throw new TypeError('invalid_pi_configuration');
  const freeze = v => { if(v && typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v; };
  freeze(d);
  const flows=new Map();
  return {
    descriptor:d,
    async beginSignIn({accountId,signal}) {
      if (!text(accountId)) return fault('account_not_found');
      if (signal?.aborted) return fault('signin_cancelled',accountId);
      const flowId=randomUUID(); flows.set(flowId,accountId);
      return ok({flowId,state:'complete',presentation:{kind:'local'}});
    },
    async finishSignIn({flowId,signal}) {
      const accountId=flows.get(flowId); flows.delete(flowId);
      if (!accountId) return fault('signin_expired');
      if (signal?.aborted) return fault('signin_cancelled',accountId);
      return ok({subjectId:identity,secret:null,expiresAtMs:null});
    },
    async cancelSignIn(flowId) { flows.delete(flowId); },
    async refresh() { return fault('adapter_unsupported'); },
    async readUsage() { return {kind:'unavailable',code:d.usageKind==='job_local'?'job_local_only':'usage_unsupported'}; },
    async authorizeRequest({auth,request}) {
      if (!auth || auth.providerId!==d.id || !text(auth.accountId) || !integer(auth.generation))
        return fault('job_binding_mismatch');
      if (!localDestination(request?.url,d,request?.method)) return fault('destination_denied',auth.accountId);
      const headers=new Headers(request.headers);
      for(const name of ['authorization','proxy-authorization','cookie','x-api-key'])headers.delete(name);
      return ok({...request,headers:Object.fromEntries(headers)});
    },
    makeRun(input) {
      if(input?.selection?.providerId!==d.id || !text(input.selection.accountId))return fault('job_binding_mismatch');
      const model=d.models.find(m=>m.id===input.selection.modelId && m.enabled);
      if(!model)return fault('model_unavailable',input.selection.accountId);
      if(!(input.selection.effortId===null?model.defaultEffort===null:model.efforts.some(e=>e.id===input.selection.effortId)))
        return fault('effort_unavailable',input.selection.accountId);
      return createRun(input);
    },
    // The served model comes only from authenticated transport bytes of an OpenAI-compatible chat completion, never from
    // the request or the CLI's own output. A reply that did not finish, or that names two models, is no observation.
    parseExecutionResponse({body,contentType}) {
      try {
        const type=String(contentType).split(';')[0].trim();
        let chunks,finished;
        if(type==='application/json'){
          const reply=JSON.parse(body);
          if(reply?.object!=='chat.completion')return null;
          chunks=[reply];finished=Array.isArray(reply.choices)&&reply.choices.some(c=>text(c?.finish_reason));
        } else if(type==='text/event-stream') {
          const data=body.split(/\r?\n\r?\n/).map(frame=>frame.split(/\r?\n/).filter(line=>line.startsWith('data:'))
            .map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean);
          if(data.at(-1)!=='[DONE]')return null;
          chunks=data.slice(0,-1).map(value=>JSON.parse(value));
          if(!chunks.length||chunks.some(c=>c?.object!=='chat.completion.chunk'))return null;
          finished=chunks.some(c=>Array.isArray(c.choices)&&c.choices.some(x=>text(x?.finish_reason)));
        } else return null;
        const models=new Set(chunks.map(c=>c.model));
        const [model]=models;
        if(!finished||models.size!==1||!text(model)||model.length>256||/[\u0000-\u0020\u007f]/.test(model))return null;
        return {model};
      } catch {return null;}
    },
    classifyReplay() { return 'never'; },
    parseJobUsage(input) { return d.usageKind==='job_local'?parseUsage(input):fault('adapter_unsupported',input?.accountId); },
  };
}
