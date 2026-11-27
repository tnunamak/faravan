import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {checkPage,INVARIANTS} from './invariants.mjs';
import {FRAME_PROBE} from './invariants-probe.mjs';

// Set INVARIANT_TEXT_CAPTURE=<dir> to write, per test, every sample's page text and button state, plus each page's
// per-frame probe keys. Off by default: no probe, no extra work, no files.
const CAPTURE_DIR=process.env.INVARIANT_TEXT_CAPTURE||'';

const MAX_DIAGNOSTIC_EVENTS=80;
const MAX_ABORT_DIAGNOSTICS=16;

function diagnosticRoute(route='') {
  const withoutQuery=String(route).split('?')[0]||'/';
  const parts=withoutQuery.split('/');
  return parts.map((part,index)=>{
    let decoded=part;try{decoded=decodeURIComponent(part);}catch{}
    const previous=parts[index-1]?.toLowerCase();
    if(['token','access_token','refresh_token','secret','credential','invitation','invite','auth'].includes(previous))return '[redacted]';
    if(decoded.length>=28&&/^[\w.:~%-]+$/.test(decoded))return '[id]';
    return part;
  }).join('/');
}

function diagnosticText(value='',limit=2000) {
  const safe=String(value)
    .replace(/\b(Bearer|Basic)\s+\S+/gi,'$1 [redacted]')
    .replace(/([?&](?:token|access_token|refresh_token|secret|api[_-]?key)=)[^&\s]+/gi,'$1[redacted]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'$1=[redacted]');
  return safe.length>limit?safe.slice(0,limit)+'…':safe;
}

// A saved copy is a 200 that says so in its body (lib/v1/saved-reads.mjs markSaved): `savedAt` on the object, or on any
// row of a list. It is not a fresh read, so it must not set the freshness that the invariants judge live text against.
export function isSavedCopy(body) {
  return (Array.isArray(body)?body:[body]).some(row=>row&&typeof row==='object'&&typeof row.savedAt==='string');
}

// Observe the deadline before waiting for another UI transition, such as a
// dialog closing. A late confirmation must remain a recorded failure.
export async function checkMutationConfirmation(recorder,page,completedAt,confirmation) {
  await page.waitForTimeout(Math.max(0,completedAt+2000-Date.now()));
  await recorder.checkpoint(page,'mutation confirmation',{mutation:{ageMs:Date.now()-completedAt,confirmation}});
}

// One recorder per real two-install test. Fail at teardown so an early visual
// defect cannot conceal all the later pages in the same journey.
// `admission`, when given, returns the lending computer's real admission check for a standard offer now (null: it
// would be admitted). I45 compares every "ready" the pages show with it.
export function journeyInvariants(info,{admission=null,inspect=checkPage}={}) {
  let refusedSince=null;
  const pages=new Map(),failures=new Map(),observations=new Map(),pending=new Set();
  let pageSequence=0;
  let stopped=false;
  const captured=[];
  function trace(state,page,event,details={}) {
    const at=Date.now(),pageUrl=page?.url?.()??'';
    let route=state.route;
    try{route=new URL(pageUrl).hash||state.route||'/';}catch{}
    const row={at,time:new Date(at).toISOString(),event,page:state.pageId,actor:state.actor,route:diagnosticRoute(route),epoch:state.epoch,available:state.available,...details};
    for(const [key,value] of Object.entries(row))if(key.toLowerCase().endsWith('route')&&typeof value==='string')row[key]=diagnosticRoute(value);
    state.trace.push(row);if(state.trace.length>MAX_DIAGNOSTIC_EVENTS)state.trace.splice(0,state.trace.length-MAX_DIAGNOSTIC_EVENTS);
    return row;
  }
  function enterRoute(state,route,force=false,cause='route-observed',page=null) {
    if(!force&&state.route===route)return;
    const fromRoute=state.route,epochBefore=state.epoch;
    state.epoch++;state.route=route;state.context={};state.lastSuccess=0;state.lastJobSuccess=0;
    state.lastJobEvidence=null;state.lastSuccessfulApi=null;
    state.readyRoute=route;state.ready.clear();state.resultReads.clear();state.inflight.clear();state.counters.clear();state.reads=[];
    trace(state,page,'observer-epoch-advance',{cause,fromRoute,toRoute:route,epochBefore,epochAfter:state.epoch});
  }
  function counters(state,route) {
    if(!state.counters.has(route))state.counters.set(route,{maxConcurrent:0,aborted:0});
    return state.counters.get(route);
  }
  function networkMeasurement(state,route,now=Date.now(),windowMs=60000) {
    const reads=state.reads.filter(row=>now-row.at<windowMs&&row.route===route),counts=new Map();
    for(const row of reads)counts.set(row.path,(counts.get(row.path)??0)+1);
    return {reads:reads.length,maxPerPath:Math.max(0,...counts.values()),...counters(state,route)};
  }
  function diagnosticsFor(state,route) {
    const routeKey=diagnosticRoute(route);
    const timeline=state.trace.filter(item=>item.route===routeKey||item.fromRoute===routeKey||item.toRoute===routeKey).slice(-40);
    const abortedRequests=state.abortedRequests.filter(item=>item.startedRoute===routeKey||item.failedRoute===routeKey).slice(-MAX_ABORT_DIAGNOSTICS);
    return {capturedAt:Date.now(),route:routeKey,epoch:state.epoch,available:state.available,timeline,abortedRequests,
      lastSuccessfulJobStatus:state.lastJobEvidence,lastSuccessfulApi:state.lastSuccessfulApi};
  }
  function record(page,result,label,context) {
    const state=pages.get(page);if(!state)return;
    const route=new URL(page.url()).hash||'/';
    const key=[state.actor,route,result.snapshot.width,label].join(' ');
    observations.set(key,{actor:state.actor,route,width:result.snapshot.width,label});
    for(const failure of result.failures)failures.set([failure.id,key].join(' '),{...failure,actor:state.actor,route,width:result.snapshot.width,label,
      ...(failure.id==='I30'?{measurement:context.network}:{}),...(failure.id==='I29'?{latencyMs:context.liveLatencyMs}:{}),
      ...(failure.id==='I03'?{brokenWordCount:result.snapshot.brokenWords.length,brokenWords:[...new Set(result.snapshot.brokenWords)].slice(0,12)}:{}),...(failure.id==='I02'?{overflowingElements:result.snapshot.overflowingElements}:{}),...(failure.id==='I25'?{frameOverflow:result.snapshot.frameOverflow}:{}),
      ...(failure.id==='I30'?{diagnostics:diagnosticsFor(state,route)}:{}),
      ...(failure.id==='I45'?{diagnostics:{...diagnosticsFor(state,route),refusalCode:diagnosticText(context.readyAdmission??'',160),refusedMs:context.readyRefusedMs??0,
        readinessText:diagnosticText(result.snapshot.text??'',1000)}}:{}),
      ...(failure.id==='I43'?{diagnostics:{...diagnosticsFor(state,route),statusEvidenceText:(result.snapshot.statusEvidenceText??[]).slice(0,12).map(value=>diagnosticText(value,1000)),statusEvidenceTextTruncated:result.snapshot.statusEvidenceTextTruncated??false,emptyLastKnown:(result.snapshot.emptyLastKnown??[]).slice(0,12).map(value=>diagnosticText(value,1000)),
        knownState:Boolean(context.knownState||context.accepting||context.cachedResult)}}:{})});
  }
  async function sample(page,label='transition',extra={}) {
    const state=pages.get(page);if(!state||page.isClosed()||!/^http/.test(page.url()))return;
    const now=Date.now(),route=new URL(page.url()).hash;
    enterRoute(state,route,false,'sample-route-change',page);
    const epoch=state.epoch;
    const availableResources=state.readyRoute===route?Object.fromEntries([...state.ready].map(([label,at])=>[label,now-at])):{};
    const readyAdmission=admission?await admission().catch(()=>undefined):undefined;
    // Ignore obsolete admission responses before touching the shared clock.
    if(epoch!==state.epoch||route!==new URL(page.url()).hash||page.isClosed())return;
    const activeRefusal=typeof readyAdmission==='string'&&readyAdmission!=='off';
    if(activeRefusal)refusedSince??=now;else refusedSince=null;
    const context={people:state.people,selfDevice:state.selfDevice,promptKnown:state.acceptedPromptKnown&&route.startsWith('#/job/'),availableResources,...state.context,...extra,
      readyAdmission,readyRefusedMs:activeRefusal?now-refusedSince:0,
      network:extra.network??networkMeasurement(state,route,now),
      appFresh:state.available&&now-state.lastSuccess<5000,jobFresh:state.available&&now-state.lastJobSuccess<5000,hostAvailable:state.available};
    const result=await inspect(page,context,{probe:Boolean(CAPTURE_DIR)});
    const recorded=epoch===state.epoch&&route===new URL(page.url()).hash;
    if(CAPTURE_DIR)capture(state,{label,route,epoch,recorded,result});
    if(recorded)record(page,result,label,context);
  }
  // Every sample is captured, recorded or not: a dropped sample is evidence too. Text and buttons are written when they
  // change from the page's previous sample, except for an I08 sample, which always keeps them.
  function capture(state,{label,route,epoch,recorded,result}) {
    const {snapshot,failures}=result;
    const i08=failures.some(failure=>failure.id==='I08');
    const row={at:snapshot.pageAt,pageId:state.pageId,actor:state.actor,label,route,width:snapshot.width,epoch,recorded,i08,probeKey:snapshot.probeKey,
      runEnabled:snapshot.buttons.some(button=>!button.disabled&&button.text==='Run it')};
    const previous=state.lastCapture;
    if(!i08&&previous&&previous.text===snapshot.text&&JSON.stringify(previous.buttons)===JSON.stringify(snapshot.buttons))row.sameAsPrevious=true;
    else {row.text=snapshot.text;row.buttons=snapshot.buttons;}
    state.lastCapture={text:snapshot.text,buttons:snapshot.buttons};
    captured.push(row);
  }
  async function writeCapture(info,pages) {
    const frames=[];
    for(const [page,state] of pages) {
      const log=page.isClosed()?null:await page.evaluate(()=>window.__invariantFrames??null).catch(()=>null);
      frames.push({pageId:state.pageId,actor:state.actor,keys:log?.keys??[],frames:log?.frames??[]});
    }
    await mkdir(CAPTURE_DIR,{recursive:true});
    const file=[info.title,info.project?.name,process.pid,Date.now()].join('-').replace(/[^\w.-]+/g,'_')+'.json';
    await writeFile(join(CAPTURE_DIR,file),JSON.stringify({test:info.title,project:info.project?.name,samples:captured,frames},null,1));
  }
  function register(page,actor,identity={}) {
    if(pages.has(page))return;
    const state={actor,...identity,pageId:++pageSequence,lastSuccess:0,lastJobSuccess:0,lastJobEvidence:null,lastSuccessfulApi:null,available:true,route:'',context:{},reads:[],inflight:new Map(),requestRows:new WeakMap(),abortedRequests:[],trace:[],counters:new Map(),epoch:0,stopping:false,ready:new Map(),resultReads:new Set()};
    pages.set(page,state);
    if(CAPTURE_DIR)page.addInitScript(FRAME_PROBE).catch(()=>{});
    trace(state,page,'page-open');
    state.listeners=[];
    const on=(event,fn)=>{page.on(event,fn);state.listeners.push(()=>page.off(event,fn));};
    // Observe every committed visit, even an A -> Home -> A round trip between
    // samples. A child frame cannot invalidate the main page's evidence.
    on('framenavigated',frame=>{
      if(frame!==page.mainFrame())return;
      const route=new URL(frame.url()).hash,previous=state.pendingNavigation;
      const fromRoute=previous?.toRoute===route?previous.fromRoute:state.route;
      trace(state,page,'main-frame-navigation-commit',{fromRoute,toRoute:route,navigationStartedAt:previous?.at??null,sameRoute:fromRoute===route,epochBefore:state.epoch});
      enterRoute(state,route,true,'main-frame-navigation-commit',page);
      state.pendingNavigation=null;
    });
    on('response',async response=>{
      const path=new URL(response.url()).pathname;
      const route=new URL(page.url()).hash;
      const request=state.inflight.get(response.request());
      enterRoute(state,route,false,'response-route-change',page);
      const epoch=state.epoch;
      if(!request||request.epoch!==epoch||request.route!==route||!response.ok()||response.request().method()!=='GET'||path==='/api/events')return;
      try {if(await response.finished())return;}catch{return;}
      if(stopped||epoch!==state.epoch||route!==new URL(page.url()).hash)return;
      const saved=await response.json().then(isSavedCopy,()=>false);
      if(stopped||epoch!==state.epoch||route!==new URL(page.url()).hash)return;
      if(saved){trace(state,page,'saved-copy-read',{path:diagnosticRoute(path),status:response.status()});return;}
      const succeededAt=Date.now();
      state.lastSuccess=succeededAt;
      state.lastSuccessfulApi={at:succeededAt,time:new Date(succeededAt).toISOString(),path:diagnosticRoute(path),route:diagnosticRoute(route),epoch,available:state.available,status:response.status()};
      if(!path.startsWith('/api/jobs'))return;
      const activeJob=route.startsWith('#/job/')?decodeURIComponent(route.split('/')[2]):null;
      const responseJob=path.startsWith('/api/jobs/')?decodeURIComponent(path.split('/')[3]):null;
      if(activeJob&&activeJob!==responseJob||route==='#/jobs'&&path!=='/api/jobs')return;
      if(/^\/api\/jobs(?:\/[^/]+)?$/.test(path)) {
        state.lastJobSuccess=succeededAt;
        state.lastJobEvidence={at:succeededAt,time:new Date(succeededAt).toISOString(),path:diagnosticRoute(path),route:diagnosticRoute(route),epoch,available:state.available,status:response.status()};
        trace(state,page,'job-status-success',state.lastJobEvidence);
      }
      if(path==='/api/jobs'&&!state.ready.has('Loading jobs'))state.ready.set('Loading jobs',Date.now());
      if(/^\/api\/jobs\/[^/]+$/.test(path)&&!state.ready.has('Loading job'))state.ready.set('Loading job',Date.now());
      if(/\/api\/jobs\/[^/]+\/(changes|transcript)$/.test(path)) {
        const section=path.split('/').at(-1);state.resultReads.add(section);
        if(section==='changes'&&!state.ready.has('Loading changes'))state.ready.set('Loading changes',Date.now());
        if(state.resultReads.size===2&&!state.ready.has('Loading result'))state.ready.set('Loading result',Date.now());
      }
    });
    on('request',request=>{
      const navigation=request.isNavigationRequest()&&request.frame()===page.mainFrame();
      if(navigation) {
        const currentUrl=new URL(page.url()),requestUrl=new URL(request.url());
        const fromRoute=currentUrl.hash,observerToRoute=requestUrl.hash;
        const sameDocumentUrl=requestUrl.origin===currentUrl.origin&&requestUrl.pathname===currentUrl.pathname&&requestUrl.search===currentUrl.search;
        const toRoute=observerToRoute||(sameDocumentUrl?fromRoute:'');
        const at=Date.now();
        state.pendingNavigation={fromRoute,toRoute,at};
        trace(state,page,'main-frame-navigation-start',{fromRoute,toRoute,observerToRoute:diagnosticRoute(observerToRoute),sameDocumentUrl,sameRoute:fromRoute===toRoute,startedAt:at,startedTime:new Date(at).toISOString(),epochBefore:state.epoch});
        enterRoute(state,observerToRoute,true,'main-frame-navigation-request',page);
      } else enterRoute(state,new URL(page.url()).hash,false,'request-route-change',page);
      const path=new URL(request.url()).pathname;
      if(request.method()!=='GET'||!path.startsWith('/api/'))return;
      const now=Date.now(),route=new URL(page.url()).hash;
      // Event streams count towards the budget, but have their own lifetime.
      state.reads=state.reads.filter(r=>now-r.at<60000);
      const row={at:now,path,route,epoch:state.epoch,available:state.available};state.reads.push(row);state.inflight.set(request,row);state.requestRows.set(request,row);
      trace(state,page,'api-read-start',{path:diagnosticRoute(path),startedAt:now,startedTime:new Date(now).toISOString(),requestRoute:diagnosticRoute(route),requestEpoch:state.epoch,requestAvailable:state.available});
      const concurrency=[...state.inflight.values()].filter(r=>r.path===path&&r.route===route&&r.epoch===state.epoch).length;
      const stats=counters(state,route);
      if(path!=='/api/events')stats.maxConcurrent=Math.max(stats.maxConcurrent,concurrency);
    });
    on('requestfinished',request=>state.inflight.delete(request));
    on('requestfailed',request=>{
      const activeRow=state.inflight.get(request),row=state.requestRows.get(request);state.inflight.delete(request);
      const failedAt=Date.now(),failureText=request.failure()?.errorText??'';
      const cancelled=/ERR_ABORTED|NS_BINDING_ABORTED/.test(failureText);
      const failedRoute=page.isClosed()?state.route:new URL(page.url()).hash;
      const failureCode=failureText.match(/ERR_[A-Z0-9_]+|NS_BINDING_ABORTED/)?.[0]??'request-failed';
      const counted=Boolean(activeRow&&cancelled&&row?.available&&state.available&&row.epoch===state.epoch&&row.route===failedRoute&&!page.isClosed()&&!state.stopping);
      if(cancelled) {
        const aborted={path:diagnosticRoute(row?.path??new URL(request.url()).pathname),startedAt:row?.at??null,startedTime:row?new Date(row.at).toISOString():null,failedAt,failedTime:new Date(failedAt).toISOString(),
          startedRoute:diagnosticRoute(row?.route??''),failedRoute:diagnosticRoute(failedRoute),startedEpoch:row?.epoch??null,failedEpoch:state.epoch,startedAvailable:row?.available??null,failedAvailable:state.available,
          errorCode:failureCode,counted};
        state.abortedRequests.push(aborted);if(state.abortedRequests.length>MAX_ABORT_DIAGNOSTICS)state.abortedRequests.shift();
      }
      trace(state,page,'api-read-failed',{path:diagnosticRoute(row?.path??new URL(request.url()).pathname),startedAt:row?.at??null,startedTime:row?new Date(row.at).toISOString():null,failedAt,failedTime:new Date(failedAt).toISOString(),
        startedRoute:diagnosticRoute(row?.route??''),failedRoute:diagnosticRoute(failedRoute),startedEpoch:row?.epoch??null,failedEpoch:state.epoch,startedAvailable:row?.available??null,failedAvailable:state.available,errorCode:failureCode,aborted:cancelled,counted});
      if(counted)counters(state,row.route).aborted++;
    });
    on('close',()=>trace(state,page,'page-close'));
    // Polling samples intermediate DOM, including the short wrong-status flash
    // after Run it. Navigation races are retried; other scanner errors fail closed.
    const tick=async()=>{
      if(stopped||page.isClosed())return;
      const work=sample(page).catch(error=>{
        if(!/Execution context was destroyed|Target page.*closed|Cannot find context/.test(error.message))failures.set('scanner '+actor,{id:'SCANNER',title:error.message,actor});
      });
      pending.add(work);await work;pending.delete(work);
      if(!stopped&&!page.isClosed())state.timer=setTimeout(tick,250);
    };
    state.timer=setTimeout(tick,250);
  }
  return {
    register,
    availability(page,available) {
      const state=pages.get(page);if(!state)return;
      const previous=state.available,epochBefore=state.epoch;
      state.available=available;
      // An explicit process outage starts a new observation epoch, rather than
      // treating a refused connection as an app-generated cancellation storm.
      state.epoch++;state.inflight.clear();state.ready.clear();state.resultReads.clear();state.lastJobSuccess=0;state.lastSuccess=0;
      trace(state,page,'availability-change',{fromAvailable:previous,toAvailable:available,epochBefore,epochAfter:state.epoch});
    },
    boundary(page,operation,phase,label='') {
      const state=pages.get(page);if(!state)return;
      if(!['navigation','reload','close'].includes(operation)||!['start','finish'].includes(phase))throw new Error('Unknown journey boundary');
      trace(state,page,'explicit-'+operation+'-'+phase,{label:diagnosticText(label)});
    },
    diagnostics(page) {
      const state=pages.get(page);if(!state)return null;
      return diagnosticsFor(state,new URL(page.url()).hash||state.route||'/');
    },
    async checkpoint(page,label,context={}) {
      const state=pages.get(page);
      await sample(page,label,context);
      if(state&&context.promptKnown)state.acceptedPromptKnown=true;
      if(state)Object.assign(state.context,Object.fromEntries(Object.entries(context).filter(([key])=>!['liveMarker','liveLatencyMs','network','mutation','circleFormReady','capped','requestDoesNotFit'].includes(key))));
    },
    async finish() {
      stopped=true;for(const state of pages.values()){clearTimeout(state.timer);state.stopping=true;}
      await Promise.allSettled([...pending]);
      for(const state of pages.values())for(const stop of state.listeners)stop();
      for(const [page,state] of pages) {
        if(page.isClosed())continue;
        const route=new URL(page.url()).hash;
        try {await sample(page,'final',{network:networkMeasurement(state,route,Date.now(),Infinity)});}
        catch(error){failures.set('final scanner '+state.actor,{id:'SCANNER',title:error.message,actor:state.actor});}
      }
      const pageMeasurements=[...pages].slice(-MAX_DIAGNOSTIC_EVENTS).map(([page,state])=>{
        const closed=page.isClosed(),route=closed?state.route:new URL(page.url()).hash||'/';
        return {page:state.pageId,actor:state.actor,width:page.viewportSize()?.width??null,closed,route:diagnosticRoute(route),epoch:state.epoch,available:state.available,network:networkMeasurement(state,route,Date.now(),Infinity)};
      });
      const result={rules:INVARIANTS.map(({id,title})=>({id,title})),observations:[...observations.values()],pageMeasurements,failures:[...failures.values()]};
      if(CAPTURE_DIR)await writeCapture(info,pages);
      await info.attach('rendered-invariants',{body:JSON.stringify(result,null,2),contentType:'application/json'});
      return result;
    },
  };
}
