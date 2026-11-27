import {anthropicProvider} from '@earendil-works/pi-ai/providers/anthropic';
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex';
import {createClaudeProvider} from './claude.mjs';
import {createCodexProvider} from './codex.mjs';
import {ok,fault} from '../accounts.mjs';
import {parseRetryAfter} from './index.mjs';
import {parseClaudeUsage,parseCodexUsage} from '../lending-meter.mjs';
import {codexSubscriptionFunding,claudeSubscriptionFunding} from '../lending-pace50-source.mjs';
import {PROVIDER_RECORDS} from '../usage-provider-records.mjs';

const text=value=>typeof value==='string'&&value.length>0&&value.length<=512&&value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value);
const token=value=>typeof value==='string'&&value.length>0&&value.length<=65536&&!/[\u0000-\u0020\u007f]/.test(value);
const credentialValid=value=>token(value?.access)&&token(value.refresh)&&
  Number.isSafeInteger(value.expires)&&value.expires>=0;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});return {promise,resolve,reject};};
async function json(response){
  if(!response.body)throw Error('missing_response');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>1024*1024)throw Error('response_too_large');chunks.push(Buffer.from(value));}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
// These SDK providers expose direct host OAuth interactions and static model
// data. We use neither Models.getAuth nor any ambient/native credential store.
// The pinned SDK owns PKCE, callback state, token endpoints and refresh grammar.
export function createNativeHostProviders({proxyOrigin,fetch:send=globalThis.fetch,clock=Date.now,
  drivers={claude:anthropicProvider(),codex:openaiCodexProvider()}}={}) {
  return Object.entries(drivers).map(([id,driver])=>{
    if(!['claude','codex'].includes(id)||!driver.auth?.oauth||typeof driver.getModels!=='function')throw Error('invalid_native_provider');
    const codex=id==='codex',record=PROVIDER_RECORDS[id],oauth=driver.auth.oauth,flows=new Map(),funding=new Map();
    const models=driver.getModels().map((model,rank)=>{
      const efforts=model.reasoning?['low','medium','high'].filter(level=>model.thinkingLevelMap?.[level]!==null)
        .map(level=>({id:level,label:level})):[];
      return {id:model.id,label:model.name,enabled:true,rank,pareto:null,efforts,defaultEffort:efforts.some(e=>e.id==='medium')?'medium':null};
    });
    const descriptor={schemaVersion:1,id,label:codex?'Codex subscription':'Claude subscription',signInKind:'browser_oauth',
      refreshKind:'rotating',usageKind:'remote',maxConcurrentJobs:null,nativeUnits:[{id:'tokens',scale:1}],models,
      destinations:[{origin:codex?'https://chatgpt.com':'https://api.anthropic.com',pathPrefixes:[codex?'/backend-api/codex':'/v1'],methods:['POST']}]};
    const headers=secret=>codex?{authorization:'Bearer '+secret.credential.access,'chatgpt-account-id':secret.subjectId}:
      {authorization:'Bearer '+secret.credential.access,'anthropic-beta':'claude-code-20250219,oauth-2025-04-20','anthropic-version':'2023-06-01'};
    async function subject(credential,signal){
      if(codex){if(!text(credential.accountId))throw Error('identity_missing');return credential.accountId;}
      const response=await send(record.identity.url,{method:'GET',headers:{authorization:'Bearer '+credential.access,
        ...record.identity.headers},redirect:'error',signal});
      if(!response.ok){
        void response.body?.cancel().catch(()=>{});
        // Only an auth refusal discredits the credential. A throttle, a missing identity or a server
        // error proves nothing about it, so the caller keeps the sign-in and rechecks on its own schedule.
        if(response.status===429)throw Object.assign(Error('identity_throttled'),{retryAtMs:parseRetryAfter(response.headers.get('retry-after'),clock())});
        if(response.status===401||response.status===403)throw Error('identity_refused');
        throw Error('identity_unavailable');
      }
      const value=await json(response),id=value?.account?.uuid;
      if(!text(id))throw Error('identity_missing');return id;
    }
    const effects={
      async beginSignIn({accountId,signal}){
        if(flows.has(accountId))return flows.get(accountId).begin;
        const controller=new AbortController(),shown=deferred(),entry={controller,shown,prompt:null};
        const combined=AbortSignal.any([controller.signal,...(signal?[signal]:[]),AbortSignal.timeout(300000)]);
        combined.addEventListener('abort',()=>{shown.reject(Error('cancelled'));entry.prompt?.reject(Error('cancelled'));},{once:true});
        flows.set(accountId,entry);
        entry.completion=Promise.resolve().then(()=>oauth.login({signal:combined,
          prompt:prompt=>{
            if(prompt.type==='select')return Promise.resolve(prompt.options[0].id);
            if(!['manual_code','text'].includes(prompt.type))throw Error('unsupported_auth_prompt');
            entry.prompt=deferred();return entry.prompt.promise;
          },
          notify:event=>{if(event.type==='auth_url')shown.resolve({kind:'browser',url:event.url});
            else if(event.type==='device_code')shown.resolve({kind:'code',url:event.verificationUri,userCode:event.userCode});},
        },{agentName:'Faravan'})).then(async credential=>{
          if(!credentialValid(credential))throw Error('invalid_credential');
          const subjectId=await subject(credential,combined);combined.throwIfAborted();
          return {subjectId,secret:{credential,subjectId},expiresAtMs:credential.expires};
        });
        entry.completion.catch(error=>shown.reject(error));
        entry.begin=shown.promise.then(presentation=>ok({flowId:accountId,state:'waiting',presentation}),()=>{
          controller.abort();flows.delete(accountId);return fault(signal?.aborted?'signin_cancelled':'signin_failed');});
        return entry.begin;
      },
      async finishSignIn({flowId,answer,signal}){
        const entry=flows.get(flowId);if(!entry)return fault('signin_expired');
        if(answer!==undefined){if(!entry.prompt||typeof answer!=='string'||!answer||answer.length>16384||/[\r\n]/.test(answer))return fault('signin_failed');entry.prompt.resolve(answer);entry.prompt=null;}
        try{const enrollment=await entry.completion;if(signal?.aborted)return fault('signin_cancelled');return ok(enrollment);}
        catch{return fault(signal?.aborted?'signin_cancelled':'signin_failed');}
        finally{entry.controller.abort();flows.delete(flowId);}
      },
      async cancelSignIn(flowId){const entry=flows.get(flowId);if(!entry)return;entry.controller.abort();flows.delete(flowId);await entry.completion.catch(()=>{});},
      async refresh({secret,signal}){
        let credential;
        try{credential=await oauth.refresh(secret.credential,signal);}
        catch{return fault('auth_temporarily_unavailable');}
        if(!credentialValid(credential))return fault('refresh_uncertain');
        try{
          if(await subject(credential,signal)!==secret.subjectId)return fault('refresh_uncertain');
        }catch(error){
          if(signal?.aborted||String(error?.message)==='identity_refused')
            return fault(signal?.aborted?'auth_temporarily_unavailable':'refresh_uncertain');
          // The renewed sign-in succeeded; only its profile read is unconfirmed. Throwing it away would
          // force a new sign-in for a credential the provider already accepted. Keep it privately (the
          // retained subject) and let the account's shared usage schedule verify the identity.
          return ok({secret:{credential,subjectId:secret.subjectId},expiresAtMs:credential.expires,subjectVerificationPending:true});
        }
        return ok({secret:{credential,subjectId:secret.subjectId},expiresAtMs:credential.expires});
      },
      async authorizeRequest({auth,request}){
        if(!credentialValid(auth.secret?.credential)||!text(auth.secret.subjectId))return fault('account_signed_out');
        if(funding.get(auth.accountId)?.generation!==auth.generation||funding.get(auth.accountId)?.value.subscription_only!=='proven')
          return fault('auth_temporarily_unavailable');
        const clean=new Headers(request.headers);for(const key of ['authorization','cookie','x-api-key','anthropic-beta','chatgpt-account-id'])clean.delete(key);
        for(const [key,value] of Object.entries(headers(auth.secret)))clean.set(key,value);
        return ok({...request,headers:Object.fromEntries(clean)});
      },
      async readUsage({auth,signal}){
        const at=clock();
        // A renewed sign-in whose profile read was throttled waits for this scheduled read to prove its
        // identity. The check runs under the account's shared backoff, never as an extra provider call.
        let subjectVerified=false;
        if(auth.subjectVerificationPending===true){
          try{
            const observed=await subject(auth.secret.credential,signal);
            if(observed!==auth.secret.subjectId)return {kind:'signed_out'};
          }catch(error){
            if(String(error?.message)==='identity_refused')return {kind:'signed_out'};
            if(String(error?.message)==='identity_throttled')return {kind:'throttled',retryAtMs:error.retryAtMs??null};
            return {kind:'unavailable',code:'identity_unverified'};
          }
          subjectVerified=true;
        }
        try{
          const response=await send(record.usage.url,{method:'GET',headers:{...record.usage.headers,...headers(auth.secret)},redirect:'error',signal});
          if(response.status===429){void response.body?.cancel().catch(()=>{});return {kind:'throttled',retryAtMs:parseRetryAfter(response.headers.get('retry-after'),at),...(subjectVerified?{subjectVerified:true}:{})};}
          if(response.status===401){void response.body?.cancel().catch(()=>{});return {kind:'auth_expired',...(subjectVerified?{subjectVerified:true}:{})};}
          if(!response.ok){void response.body?.cancel().catch(()=>{});return {kind:'unavailable',code:'provider_unavailable',...(subjectVerified?{subjectVerified:true}:{})};}
          const body=await json(response),parsed=codex?parseCodexUsage(body,at,{preserveUnknownLimit:true}):parseClaudeUsage(body,at);
          if(!parsed)return {kind:'unavailable',code:'invalid_provider_response',...(subjectVerified?{subjectVerified:true}:{})};
          const value=codex?codexSubscriptionFunding({plan_type:body.plan_type,limit_reached:body.rate_limit?.allowed===false||body.spend_control?.reached===true?true:body.rate_limit?.limit_reached}):
            claudeSubscriptionFunding({extraUsage:parsed.extra_usage_state,guestAuth:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}});
          funding.set(auth.accountId,{generation:auth.generation,value});
          const windows=parsed.readings.filter(row=>Number.isSafeInteger(row.resets_at)).map(row=>({
            id:row.window_id,instance:row.window_id+':'+row.resets_at,capacityMicro:100000000,
            usedLoMicro:Math.floor(row.used_pct*1000000),usedHiMicro:Math.ceil(row.used_pct*1000000),
            resetsAtMs:row.resets_at,maxOwnerRateMicroPerMs:null}));
          if(codex&&(body.rate_limit?.limit_reached===true||body.rate_limit?.allowed===false||body.spend_control?.reached===true))
            return {kind:'limit',resetAtMs:windows.length?Math.min(...windows.map(w=>w.resetsAtMs)):null,...(subjectVerified?{subjectVerified:true}:{})};
          if(!windows.length)return {kind:'unavailable',code:'usage_unavailable',...(subjectVerified?{subjectVerified:true}:{})};
          return {kind:'reading',reading:{schemaVersion:1,accountId:auth.accountId,observationId:auth.accountId+':'+at,
            sequence:at,observedAtMs:at,receivedAtMs:clock(),postingUncertaintyMs:null,windows,coverage:{kind:'unknown'}},
            ...(subjectVerified?{subjectVerified:true}:{})};
        }catch{return {kind:'unavailable',code:'transport_error',...(subjectVerified?{subjectVerified:true}:{})};}
      },
      makeRun({selection,jobKey,job,receipt,enforcement}){
        const origin=proxyOrigin(),endpoint=new URL('/api/account-proxy/'+id,origin).href;
        return ok({schemaVersion:1,command:codex?'codex':'claude',args:codex?
          ['exec','--json','--dangerously-bypass-approvals-and-sandbox','-m',selection.modelId,
            ...(selection.effortId===null?[]:['-c','model_reasoning_effort='+selection.effortId]),job.promptText]:
          ['-p','--output-format','stream-json','--verbose','--model',selection.modelId,
            ...(selection.effortId===null?[]:['--effort',selection.effortId]),job.promptText],
          env:codex?{OPENAI_API_KEY:jobKey,OPENAI_BASE_URL:endpoint}:{CLAUDE_CODE_OAUTH_TOKEN:jobKey,ANTHROPIC_BASE_URL:endpoint},
          proxy:{providerId:id,origin:new URL(origin).origin},receipt,enforcement});
      },
    };
    if(!codex)effects.parseJobUsage=({accountId,attemptId,event})=>{
      const raw=event.raw,usage=raw?.usage;
      if(raw?.type!=='result'||!Number.isSafeInteger(usage?.input_tokens)||!Number.isSafeInteger(usage?.output_tokens))return fault('invalid_provider_response');
      const value=usage.input_tokens+usage.output_tokens+(usage.cache_read_input_tokens??0)+(usage.cache_creation_input_tokens??0);
      if(!Number.isSafeInteger(value)||value<0)return fault('invalid_provider_response');
      return ok({schemaVersion:1,accountId,attemptId,eventId:event.eventId,sequence:event.sequence,atMs:event.atMs,
        meterEpoch:event.meterEpoch,semantics:'delta',amount:{unit:'tokens',value},windowDebits:[]});
    };
    const adapter=(codex?createCodexProvider:createClaudeProvider)({descriptor,effects});
    // Claude's SDK appends /v1/messages; Codex appends /responses. The
    // destination checks still run in the adapter before injecting host auth.
    if(!codex)adapter.proxyRequestUrl=suffix=>new URL(suffix,'https://api.anthropic.com').href;
    adapter.requiredEvidence=({accountId,generation})=>({funding:funding.get(accountId)?.generation===generation
      ?structuredClone(funding.get(accountId).value):{subscription_only:'unknown',reason:'funding_unobserved'}});
    adapter.harnessId=codex?'codex':'claude-code-subscription';
    return adapter;
  });
}
