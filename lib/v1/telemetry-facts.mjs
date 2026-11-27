// App facts select only known fields. Raw names, paths and operation bodies never cross this boundary.
import * as os from 'node:os';
import {parseFact, publicModel, FACT_SCHEMAS, PERSON_PROPERTIES} from './telemetry/contract.mjs';
import {scopeOf} from './ops/http.mjs';
import {OPS} from './ops/registry.mjs';

const restOperations=OPS.filter(op=>op.rest).map(op=>({id:op.id,method:op.rest.method,parts:op.rest.path.split('/').filter(Boolean)}));
const enums={provider:PERSON_PROPERTIES.provider,harness:FACT_SCHEMAS.job_requested.requested_harness,
  effort:FACT_SCHEMAS.job_requested.requested_effort,plan:PERSON_PROPERTIES.plan,surface:FACT_SCHEMAS.operation_completed.surface,
  job_role:FACT_SCHEMAS.job_execution_finished.role,job_outcome:FACT_SCHEMAS.job_execution_finished.outcome,stop_reason:FACT_SCHEMAS.job_execution_finished.stop_reason};
const members = name => enums[name].values;
function problemCode(body,status) {
  const allowed=FACT_SCHEMAS.operation_completed.error_code.values;
  const secondary=body?.code==='apply_refused'?'result_'+body.apply_code:body?.code==='repo_refused'?body.repo_code:null;
  let code=allowed.includes(secondary)?secondary:allowed.includes(body?.code)?body.code:'unknown';
  if(status===401)code='unauthorized';else if(status===429)code='rate_limited';
  else if(code==='unknown'&&!body?.code&&status===409)code='conflict';else if(code==='unknown'&&!body?.code&&status===404)code='not_found';
  return code;
}
const known = (name,value,fallback=null) => members(name).includes(value)?value:fallback;
const MAX_MS=2**31-1, DAY=86400000, HEARTBEAT=300000;
export const duration = value => Math.min(MAX_MS,Math.max(0,Math.floor(Number.isFinite(value)?value:0)));
const bounded = (value,max=1000000) => Number.isFinite(value)?Math.min(max,Math.max(0,value)):undefined;
const compact = object => Object.fromEntries(Object.entries(object).filter(([,value])=>value!==undefined));
const version = value => typeof value==='string'&&/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-preview\.\d{8}\.\d{1,4})?$/.test(value)?value:undefined;
const bucket = (value,bounds) => String(bounds.find(bound=>value<=bound)??'inf');
export const surfaceOf = ({writer,headers}={}) => writer==='phone'?'phone':known('surface',headers?.['faravan-surface'],'http');
export function mcpClient({name,version:clientVersion}={}) {
  const families=Object.assign(Object.create(null),{'claude':'claude','claude code':'claude','claude-code':'claude','claude-ai':'claude',
    codex:'codex','codex cli':'codex',chatgpt:'chatgpt',cursor:'cursor',vscode:'vscode','visual studio code':'vscode'});
  const client_family=families[String(name).toLowerCase()]??'other';
  return {client_family,...(typeof clientVersion==='string'&&/^\d{1,4}(?:\.\d{1,4}){0,3}$/.test(clientVersion)?{client_version:clientVersion}:{}),source:'reported'};
}
export function systemProfile(input={}) {
  const platform=input.platform??os.platform(), architecture=input.arch??os.arch();
  const os_type=['linux','darwin'].includes(platform)?platform:platform==='win32'?'windows':'other';
  const arch=architecture==='x64'?'amd64':architecture==='arm64'?'arm64':'other';
  const cpu=(input.cpus??os.cpus()).map(cpu=>cpu.model??'').join(' ');
  const cpu_class=/apple/i.test(cpu)?'apple':/amd/i.test(cpu)?'amd':/intel/i.test(cpu)?'intel':/arm|aarch/i.test(cpu)?'arm':'other';
  const total_ram_gib=Math.ceil((input.totalmem??os.totalmem())/1024**3);
  const major=Number.parseInt(input.osVersion??(os_type==='darwin'?null:input.release??os.release()),10),docker=input.docker??{};
  const facts=compact({os_type,arch,cpu_class,os_major:bounded(major,999),
    available_parallelism:bounded(input.parallelism??os.availableParallelism(),4096),total_ram_gib:bounded(total_ram_gib,1048576),
    docker_installed:typeof docker.installed==='boolean'?docker.installed:undefined,
    docker_running:typeof docker.running==='boolean'?docker.running:undefined,
    docker_signed_in:typeof docker.signedIn==='boolean'?docker.signedIn:undefined,docker_version:version(docker.version)});
  return {...facts,$set:compact({os_type,arch,cpu_class,os_major:facts.os_major,ram_bucket:bucket(total_ram_gib,[4,8,16,32,64,128,256]),
    docker_present:facts.docker_installed,docker_version:facts.docker_version,app_version:version(input.appVersion)})};
}
export function requestedJob(requirements={}) {
  const harness=Array.isArray(requirements.harness)?requirements.harness.length===1?requirements.harness[0]:null:requirements.harness;
  const requested_harness=known('harness',harness==='claude-code-subscription'?'claude-code':harness==='codex-subscription'?'codex':harness);
  const rawModel=typeof requirements.model==='string'?requirements.model:requirements.model?.any_of?.length===1?requirements.model.any_of[0]:null;
  return {requested_provider:known('provider',requirements.provider,requested_harness==='claude-code'?'claude':requested_harness==='codex'?'codex':null),
    requested_harness,requested_model:publicModel(rawModel),requested_effort:known('effort',requirements.effort)};
}
export function finishedJob({requirements,receipt,role,outcome,stopReason}={}) {
  const executed_harness=known('harness',receipt?.harness==='claude-code-subscription'?'claude-code':receipt?.harness==='codex-subscription'?'codex':receipt?.harness);
  return compact({...requestedJob(requirements),executed_provider:known('provider',receipt?.provider,executed_harness==='claude-code'?'claude':executed_harness==='codex'?'codex':null),
    executed_harness,executed_model:publicModel(receipt?.model),executed_effort:known('effort',receipt?.effort),role:known('job_role',role),
    outcome:known('job_outcome',outcome,'uncertain'),duration_ms:Number.isFinite(receipt?.duration_ms)?duration(receipt.duration_ms):undefined,
    stop_reason:known('stop_reason',stopReason),model_source:receipt?.model!=null?'execution_report':'unknown'});
}

/** Foreground producers append to bounded memory. Background tick/drain publish optional facts. */
export function createTelemetryFacts({telemetry,now=Date.now,monotonic=()=>performance.now(),profile=()=>systemProfile(),plans=()=>({}),constraints=()=>({}),lendingOn=()=>false,schedule=fn=>setTimeout(fn,25)}={}) {
  const began=monotonic();let lastTick=began,lastHeartbeat=-Infinity,generation,started=false;
  const profiles=new Map(),surfaces=new Set(),jobs=new Map(),pending=[],reads=new Set();
  let scheduled=false,timer,closing=false,closed=false,closeWork;
  let closeDeadline=Infinity,closeNow=monotonic,closeTimer,resolveCloseWait;
  const mayObserve=()=>!closed&&(!closing||closeNow()<closeDeadline);
  function seal() {
    closed=true;closing=true;pending.length=0;scheduled=false;
    clearTimeout(timer);timer=undefined;
    clearTimeout(closeTimer);closeTimer=undefined;
    const resolve=resolveCloseWait;resolveCloseWait=undefined;resolve?.();
  }
  function defer(work) {
    if(closing||closed||pending.length>=256)return false;
    pending.push(work);
    if(!scheduled){scheduled=true;timer=schedule(drain);timer?.unref?.();}
    return true;
  }
  function drain() {
    if(!mayObserve()){pending.length=0;return;}
    clearTimeout(timer);timer=undefined;
    scheduled=false;
    const batch=pending.splice(0,16);
    for(const work of batch)try{work();}catch{/* optional observation */}
    if(pending.length&&!scheduled&&!closing){scheduled=true;timer=schedule(drain);timer?.unref?.();}
  }
  function synchronizeGeneration() {
    if(!mayObserve())return {remoteEnabled:false};
    if(typeof telemetry?.bootstrap!=='function')return undefined;
    let boot;try{boot=telemetry.bootstrap();}catch{return {remoteEnabled:false};}
    if(!boot)return {remoteEnabled:false};
    if(generation!==boot.generation){generation=boot.generation;started=false;profiles.clear();surfaces.clear();lastHeartbeat=-Infinity;}
    return boot;
  }
  function captureScope(scope={}) {
    if(closing||closed)return Object.freeze({surface:scope.surface??'background',off:true});
    const boot=synchronizeGeneration();
    return Object.freeze({surface:scope.surface??'background',generation:scope.generation??boot?.generation,off:scope.off===true||scopeOf(scope.headers).off||boot?.remoteEnabled===false});
  }
  function emitNow(name,properties,scope={}) {
    if(!mayObserve())return false;
    try {
      const boot=synchronizeGeneration();
      if(scope.off||scopeOf(scope.headers).off||boot?.remoteEnabled===false||scope.generation!==undefined&&scope.generation!==boot?.generation)return false;
      const parsed=parseFact(name,scope.surface&&scope.surface!=='background'?{...properties,$set:{...properties.$set,surfaces_used:[...new Set([...surfaces,scope.surface])].slice(0,9)}}:properties);
      const {generation:_generation,...observerScope}=scope;
      if(!mayObserve())return false;
      const accepted=telemetry?.observeFact?.(name,parsed,observerScope)===true;
      if(accepted&&scope.surface)surfaces.add(scope.surface);
      return accepted;
    } catch {return false;}
  }
  function emit(name,properties,scope={}) {
    try{const parsed=parseFact(name,properties),captured=captureScope(scope);return defer(()=>emitNow(name,parsed,captured));}catch{return false;}
  }
  function daily(name,properties,key=name) {
    const signature=JSON.stringify([Math.floor(now()/DAY),properties]);
    if(profiles.get(key)!==signature&&emitNow(name,properties,{surface:'background'}))profiles.set(key,signature);
  }
  function observePlans(scope={surface:'background'}) {
    for(const provider of ['claude','codex']) {
      const plan=known('plan',plans()?.[provider]);if(plan===null||plan==='unknown')continue;
      const properties={provider,plan,source:'user_selected',subscription_verified:false,
        $set:{[provider+'_plan']:plan,subscription_source:'user_selected',subscription_verified:false}};
      if(scope.surface==='background')daily('account_plan_observed',properties,'plan:'+provider);
      else emit('account_plan_observed',properties,scope);
    }
  }
  const lifecycle=()=>({uptime_ms:duration(monotonic()-began),lending_on:lendingOn()===true});
  function tick() {
    if(!mayObserve())return;
    try {
      const boot=synchronizeGeneration();
      if(!boot?.remoteEnabled){lastTick=monotonic();return;}
      if(!started)started=emitNow('app_started',lifecycle(),{surface:'background'});
      try{daily('system_profile_observed',profile());}catch{}
      try{observePlans();}catch{}
      try{const resource=constraints();if(Object.keys(resource).length)daily('resource_constraints_observed',resource);}catch{}
      const current=monotonic(),gap=current-lastTick;
      if(gap>HEARTBEAT)emitNow('app_resumed',{...lifecycle(),gap_ms:duration(gap),gap_reason:'unknown'},{surface:'background'});
      lastTick=current;
      if(current-lastHeartbeat>=HEARTBEAT&&emitNow('app_heartbeat',lifecycle(),{surface:'background'}))lastHeartbeat=current;
    } catch {/* optional observation */}
  }
  function operation({req,status,body,opId,durationMs,writer}={}) {
    try {
      if(writer==='app'&&req?.headers?.['faravan-operation-dispatch']==='1')return;
      if(!opId&&req?.url) {
        const parts=new URL(req.url,'http://local').pathname.split('/').filter(Boolean);
        if(writer==='phone') {
          if(req.method==='GET'&&parts.join('/')==='phone/api/inbox')opId='approvals.list';
          else if(req.method==='POST'&&parts.length===5&&parts.slice(0,3).join('/')==='phone/api/requests'&&['accept','decline'].includes(parts[4]))opId='approvals.'+parts[4];
        }else {
          const matches=restOperations.filter(op=>op.method===req.method&&op.parts.length===parts.length&&op.parts.every((part,index)=>part.startsWith('{')||part===parts[index]));
          if(matches.length===1)opId=matches[0].id;
        }
      }
      if(!opId)return;
      const surface=surfaceOf({writer,headers:req?.headers});
      emit('operation_completed',{op:opId,surface,...(Number.isFinite(durationMs)?{duration_ms:duration(durationMs)}:{}),ok:status<400,error_code:status<400?null:problemCode(body,status),
        $set:{surfaces_used:[...new Set([...surfaces,surface])].slice(0,9)}},{surface,headers:req?.headers});
    }catch{/* optional observation */}
  }
  function jobNow(key,properties,{terminal=false,requireRequested=false,...scope}={}) {
    if(!mayObserve())return;
    if(!key)return;
    const previous=jobs.get(key)??{};
    if(scope.off||scopeOf(scope.headers).off){jobs.set(key,{off:true});if(jobs.size>10000)jobs.delete(jobs.keys().next().value);return;}
    if(previous.off||previous[terminal?'finished':'requested']||terminal&&requireRequested&&!previous.requested)return;
    const boot=(()=>{try{return telemetry?.bootstrap?.();}catch{return null;}})();
    if(terminal&&previous.generation!==undefined&&boot?.generation!==previous.generation)return;
    const attributed=terminal&&previous.scope?previous.scope:scope;
    if(emitNow(terminal?'job_execution_finished':'job_requested',terminal?{...properties,...previous.request}:properties,attributed))jobs.set(key,{...previous,scope:{surface:attributed.surface},generation:boot?.generation,...(!terminal?{request:parseFact('job_requested',properties)}:{}),[terminal?'finished':'requested']:true});
    if(jobs.size>10000)jobs.delete(jobs.keys().next().value);
  }
  function job(key,properties,options={}) {
    try{const captured=captureScope(options),parsed=parseFact(options.terminal?'job_execution_finished':'job_requested',properties);
      return defer(()=>jobNow(key,parsed,{...options,...captured}));}catch{return false;}
  }
  function finishBorrowerNow(key,outcome,readReceipt) {
    if(!mayObserve())return;
    const previous=jobs.get(key);
    if(!previous?.requested||previous.off||previous.finished||previous.reading)return;
    // This continuation was admitted with finishBorrower. Drain it directly:
    // closing refuses new observations, while jobNow retains consent and identity checks.
    const finish=receipt=>{try{jobNow(key,finishedJob({receipt,role:'borrower',outcome}),{terminal:true,requireRequested:true});}catch{}};
    if(outcome!=='finished')return finish(null);
    try{const boot=telemetry?.bootstrap?.();if(!boot?.remoteEnabled||boot.generation!==previous.generation)return;}catch{return;}
    previous.reading=true;
    const read=Promise.resolve().then(readReceipt).then(value=>finish(value?.receipt),()=>finish(null));
    reads.add(read);
    read.finally(()=>{previous.reading=false;reads.delete(read);});
  }
  return {tick:()=>{if(!closing&&!closed)tick();},start:()=>defer(tick),drain,emit,operation,job,finishBorrower:(...args)=>defer(()=>finishBorrowerNow(...args)),captureScope,seal,plans:scope=>{if(closing||closed)return;try{observePlans(scope);}catch{}},
    onboarding:(step,outcome,elapsed,scope)=>emit('onboarding_step_changed',{step,outcome,duration_ms:duration(elapsed),surface:scope?.surface??'background'},scope),
    close:({deadline,now:clock=monotonic,drainMs=1000}={})=>{
      if(closing||closed)return closeWork;
      // Scope capture and synchronous draining spend the same owner budget.
      closeNow=clock;closeDeadline=deadline??clock()+drainMs;
      closing=true;clearTimeout(timer);timer=undefined;
      const boot=synchronizeGeneration();
      const scope=Object.freeze({surface:'background',generation:boot?.generation,off:boot?.remoteEnabled===false});
      while(pending.length)drain();
      const finish=()=>{
        try{emitNow('app_closed',{...lifecycle(),clean:true},scope);}catch{}
        seal();
      };
      if(closed||!reads.size){finish();return closeWork=Promise.resolve();}
      closeWork=Promise.race([Promise.allSettled([...reads]),new Promise(resolve=>{
        resolveCloseWait=resolve;closeTimer=setTimeout(resolve,Math.max(0,closeDeadline-closeNow()));
      })]).finally(finish);
      return closeWork;
    }};
}

/** Observe acknowledged protocol writes. Keep only normalized request facts, never job content. */
export function observeLenderClient(client,facts) {
  const requests=new Map(),methods=new Map();
  return new Proxy(client,{get(target,name){
    const value=Reflect.get(target,name,target);if(typeof value!=='function')return value;
    if(methods.has(name))return methods.get(name);
    const observed=['claimJob','claimNext','completeAttempt','fail','release'].includes(name);
    const method=observed?async(...args)=>{
      const callScope=facts.captureScope({surface:'background'});
      const result=await value.apply(target,args);
      try {
        if(name==='claimJob'||name==='claimNext') {
          if(result?.attempt?.attempt_id)requests.set(result.attempt.attempt_id,{scope:callScope,properties:requestedJob({...result.job?.payload?.requirements,effort:result.job?.payload?.budget_v1?.effort})});
          if(requests.size>10000)requests.delete(requests.keys().next().value);
        }else {
          const [attempt,payload]=args;
          const request=requests.get(attempt?.attempt_id);if(!request)return result;
          const fact={...finishedJob({receipt:name==='completeAttempt'?payload?.receipt:null,role:'lender',outcome:name==='completeAttempt'?'finished':name==='fail'?'failed':'stopped'}),...request.properties};
          facts.job('lender:'+attempt?.attempt_id,fact,{...request.scope,terminal:true});
        }
      }catch{/* observations never fail protocol operations */}
      return result;
    }:value.bind(target);
    methods.set(name,method);return method;
  }});
}
