// Read-only consent checks use a five-second deadline, independent of API read
// retries. A closed/broken event stream stops capture immediately.
export function connectBrowserPolicy({api,browser,store,onStop=()=>{},setTimer=setInterval,clearTimer=clearInterval}) {
  let stopped=false,revision=0,pendingChanges=0,checking=false,checkDemanded=false;
  let latestGeneration=-1,offThroughGeneration=-1,activeCheck=null;
  const startedChanges=new Set();
  const stopCapture=()=>{browser.stop();onStop();};
  const check=async()=>{
    if(stopped)return;
    if(checking || pendingChanges){checkDemanded=true;return;}
    checkDemanded=false;
    checking=true;
    const current=revision,controller=new AbortController();
    const owned={controller,timeout:null};
    activeCheck=owned;
    owned.timeout=setTimeout(()=>{
      if(stopped || activeCheck!==owned)return;
      controller.abort();stopCapture();
    },4500);
    try{
      const state=await api.get('telemetry/bootstrap',controller.signal);
      if(stopped || current!==revision || controller.signal.aborted)return;
      // A local OFF increments policy generation. Reads from before that write,
      // or an older authoritative generation, cannot grant permission again.
      if(!Number.isSafeInteger(state?.generation) || state.generation<0 ||
        state.generation<latestGeneration || (state.consent==='on' && state.generation<=offThroughGeneration)){
        stopCapture();return;
      }
      if(state.generation!==latestGeneration || state.consent!=='on' || !state.remoteEnabled || state.noticePending)onStop();
      latestGeneration=state.generation;
      browser.tick();browser.version?.(store.get()?.version);browser.bootstrap(state);
    }catch{if(!stopped && current===revision)stopCapture();}
    finally{
      if(activeCheck===owned){clearTimeout(owned.timeout);activeCheck=null;}
      checking=false;
      // Coalesce invalidations without manufacturing retries; writes retain demand.
      if(checkDemanded && !stopped && !pendingChanges)check();
    }
  };
  const before=store.beforeChange((path,body,change)=>{
    startedChanges.add(change);
    revision++;pendingChanges++;
    // Record privacy intent before external stop effects, which may throw.
    if(path==='telemetry/choose' && body.level==='off')offThroughGeneration=Math.max(offThroughGeneration,latestGeneration);
    stopCapture();
  });
  const completed=store.afterChange((path,body,saved,change)=>{
    // Earlier preconditions can abort before this policy starts. Never consume another call.
    if(!startedChanges.delete(change)){
      // An earlier guard may reject OFF before beforeChange reaches this policy.
      // Preserve local privacy intent without claiming a saved write or another identity.
      if(!saved && path==='telemetry/choose' && body.level==='off'){
        revision++;
        offThroughGeneration=Math.max(offThroughGeneration,latestGeneration);
        stopCapture();check();
      }
      return;
    }
    if(saved && path==='telemetry/choose' && body.level==='off')offThroughGeneration=Math.max(offThroughGeneration,latestGeneration+1);
    revision++;pendingChanges--;check();
  });
  const after=store.subscribe(()=>{revision++;check();});
  let lastCheck=0;
  const periodic=setTimer(()=>{if(stopped)return;browser.tick();if(++lastCheck>=5){lastCheck=0;check();}},1000);
  const disconnected=()=>{revision++;browser.connection(false);onStop();};
  const wrapped={...api,request:async(path,options)=>{
    const response=await api.request(path,options);
    if(!path.startsWith('events?') || !response.body)return response;
    if(!response.headers.get('content-type')?.includes('text/event-stream')){disconnected();return response;}
    revision++;browser.connection(true);check();
    const reader=response.body.getReader();
    const body=new ReadableStream({async pull(controller){
      try{const next=await reader.read();if(next.done){disconnected();controller.close();}else controller.enqueue(next.value);}
      catch(error){disconnected();controller.error(error);}
    },cancel(reason){disconnected();return reader.cancel(reason);}});
    return new Response(body,{status:response.status,headers:response.headers});
  }};
  return {
    api:wrapped,
    connection(value){if(value!==true)disconnected();},
    event(event){if(['telemetry','reset'].includes(event.type)){revision++;stopCapture();check();}},
    check,
    stop(){
      stopped=true;checkDemanded=false;revision++;clearTimer(periodic);
      // Release only this policy's active bootstrap and its deadline.
      const owned=activeCheck;activeCheck=null;
      if(owned){clearTimeout(owned.timeout);owned.controller.abort();}
      before();completed();after();stopCapture();
    },
  };
}
