import {useEffect,useRef,useState} from 'preact/hooks';
import {errorMessage} from './helpers.mjs';
import {Button, Spinner} from './ds/index.mjs';
import {POLL_MS,SIGNIN_ACTION_ERROR_CODES,isTerminal,signInLabel,signInView,ACTION_LABELS,OTHER_WAYS_LABEL,beginSignIn,readProgress,writeProgress,progressView,signInResponses} from './signin.mjs';

// One explicit click starts one flow. Nothing opens until that click; polling only reads status.
export function SignIn({api,target,agentName,refresh,onWaiting}) {
  const [pollFailed,setPollFailed]=useState(false),[checkNote,setCheckNote]=useState('');
  const [flow,setFlow]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(''),[now,setNow]=useState(Date.now);
  const responses=useRef(signInResponses()),working=useRef(false);
  const mounted=useRef(true),flowId=flow?.flowId,waiting=flow&&!isTerminal(flow);
  useEffect(()=>()=>{mounted.current=false;},[]);
  useEffect(()=>{onWaiting?.(Boolean(waiting||busy));},[waiting,busy]);
  useEffect(()=>{if(!waiting)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[waiting]);
  const apply=(ticket,next)=>{if(!mounted.current||!responses.current.accept(ticket,next))return false;setFlow(next);setPollFailed(false);if(next.status==='complete')refresh?.();return true;};
  const run=async work=>{
    if(working.current)return;
    working.current=true;const ticket=responses.current.ticket();setBusy(true);setError('');
    try{await work(ticket);}catch(e){if(mounted.current&&responses.current.current(ticket))setError(SIGNIN_ACTION_ERROR_CODES.includes(e?.code) ? e.code : errorMessage(e));}
    finally{working.current=false;if(mounted.current)setBusy(false);}
  };
  const progressId=useRef(null);
  const startedAt=useRef(null);
  const storage=()=>{try{return globalThis.localStorage;}catch{return null;}};
  const start=(method)=>{
    if(working.current)return;
    responses.current.reset();setFlow(null);setPasted('');setCheckNote('');setPollFailed(false);
    const id=globalThis.crypto.randomUUID();progressId.current=id;startedAt.current=Date.now();
    return run(ticket=>beginSignIn({api,target,agentName,storage:storage(),open:(...args)=>window.open(...args),id,method,onFlow:next=>apply(ticket,next)}));
  };
  const [pasted,setPasted]=useState('');
  // Stops the device flow, then starts the loopback browser flow, which shows the paste field. If the stop fails the
  // device flow is still the open one, so nothing new is started.
  const otherWays=async()=>{
    if(working.current)return;
    if(flow&&!isTerminal(flow)){
      working.current=true;setBusy(true);setError('');
      try{await api.post('signin/'+encodeURIComponent(flowId)+'/cancel',{});}
      catch(e){working.current=false;if(mounted.current){setBusy(false);setError(SIGNIN_ACTION_ERROR_CODES.includes(e?.code)?e.code:errorMessage(e));}return;}
      working.current=false;
    }
    start('browser');
  };
  const submitCode=event=>{event.preventDefault();run(async ticket=>{
    if(apply(ticket,await api.post('signin/'+encodeURIComponent(flowId)+'/code',{code:pasted.trim()})))setPasted('');});};
  // A manual check retries the read, never starts another sign-in.
  const check=()=>run(async ticket=>{const next=await api.get('signin/'+encodeURIComponent(flowId));if(apply(ticket,next))setCheckNote(next.status==='awaiting_browser'?'Not signed in yet.':'');});
  const cancel=()=>run(async ticket=>apply(ticket,await api.post('signin/'+encodeURIComponent(flowId)+'/cancel',{})));
  useEffect(()=>{
    if(!waiting)return;
    let active=true,pending=false;
    const timer=setInterval(()=>{
      if(working.current||pending)return;
      pending=true;const ticket=responses.current.ticket();
      api.get('signin/'+encodeURIComponent(flowId)).then(next=>{if(active)apply(ticket,next);})
        .catch(()=>{if(active&&mounted.current&&responses.current.current(ticket))setPollFailed(true);}).finally(()=>{pending=false;});
    },POLL_MS);
    return()=>{active=false;clearInterval(timer);};
  },[waiting,flowId]);
  const copy=async code=>{try{await navigator.clipboard.writeText(code);setCopied('Code copied.');}catch{setCopied('Couldn\'t copy. Select the code instead.');}};
  const view=busy&&!flow?{heading:'Starting a secure sign-in…',status:'Preparing the sign-in page. Usually 30–60 seconds.',actions:['start']}:signInView(flow,error,{pollFailed,checkNote,elapsedMs:startedAt.current?now-startedAt.current:0}),label=signInLabel(target,agentName);
  const handlers={start:()=>start(),retry:()=>start(),check,cancel};
  return <div class="signin ph-no-capture" data-telemetry-private="signin">
    {busy&&!flow&&<Spinner />}
    {(busy||waiting)&&progressId.current&&<a class="t-sm" href={'/#/signin/'+encodeURIComponent(progressId.current)}>Continue sign-in in this tab</a>}
    {view.heading&&<p><strong>{view.heading}</strong></p>}
    {view.actionError&&<p class="error" role="alert">{view.actionError}</p>}
    {view.body&&<p class="error" role="alert">{view.body}</p>}
    {view.codeEntry&&<form class="signin-code" onSubmit={submitCode}>
      <label for={'signin-code-'+target}>Paste the code Claude shows you</label>
      <input id={'signin-code-'+target} value={pasted} onInput={e=>setPasted(e.currentTarget.value)}
        autocomplete="one-time-code" autocapitalize="off" spellcheck={false} required/>
      <Button type="submit" pending={busy} disabled={!pasted.trim()} disabledReason="Paste the code first">Finish sign-in</Button>
    </form>}
    {view.redirectEntry&&<form class="signin-code" onSubmit={submitCode}>
      <label for={'signin-redirect-'+target}>Approving on another device? After you approve, that page will not load. Copy its address and paste it here.</label>
      <input id={'signin-redirect-'+target} value={pasted} onInput={e=>setPasted(e.currentTarget.value)}
        autocapitalize="off" spellcheck={false} required/>
      <Button type="submit" pending={busy} disabled={!pasted.trim()} disabledReason="Paste the address first">Finish sign-in</Button>
    </form>}
    {view.code&&<p>Your code: <code>{view.code}</code> <Button kind="quiet" onClick={()=>copy(view.code)}>Copy code</Button> <span role="status">{copied}</span></p>}
    {view.status&&<p class="t-sm t-2 signin-status" role="status" aria-live="polite">{view.status}</p>}
    <div class="pair">{view.actions.map(name=>name==='open'
      ?(view.url&&<a class="btn btn-secondary" href={view.url} target="_blank" rel="noopener noreferrer">{ACTION_LABELS.open}</a>)
      :<Button kind="secondary" pending={busy} onClick={handlers[name]}>{busy?'Working…':name==='retry'&&flow?.status==='cancelled'?'Start again':ACTION_LABELS[name]||label}</Button>)}</div>
    {view.otherWays&&<p><Button kind="quiet" pending={busy} onClick={otherWays}>{OTHER_WAYS_LABEL}</Button></p>}
  </div>;
}

// This tab starts on our own application while the provider prepares its URL. No live write occurs on mount.
export function SignInProgress({id, api, headingRef}) {
  const storage=()=>{try{return globalThis.localStorage;}catch{return null;}};
  const [progress,setProgress]=useState(()=>{
    const saved=readProgress(storage(),id);
    return saved?{...saved,flow:null}:{startedAt:Date.now()};
  });
  const [now,setNow]=useState(Date.now),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const missingSince=useRef(null),responses=useRef(signInResponses()),working=useRef(false),alive=useRef(true),pendingCancel=useRef(false);
  const [retry,setRetry]=useState(0);
  useEffect(()=>()=>{alive.current=false;responses.current.reset();},[]);
  useEffect(()=>{
    const update=()=>{const saved=readProgress(storage(),id);setProgress(current=>saved?{...saved,flow:current?.flow,
      unavailable:current?.unavailable,sessionExpired:current?.sessionExpired,readFailed:current?.readFailed}:current);setNow(Date.now());};
    const timer=setInterval(update,250);
    window.addEventListener('storage',update);
    return()=>{clearInterval(timer);window.removeEventListener('storage',update);};
  },[id]);
  useEffect(()=>{
    let mounted=true,timer,pending=false;
    const poll=()=>{
      if(pending||working.current||responses.current.terminal())return;
      pending=true;const ticket=responses.current.ticket();
      api.get('signin/'+encodeURIComponent(id)).then(flow=>{
        if(!mounted||!responses.current.accept(ticket,flow))return;
        missingSince.current=null;setError('');
        setProgress(current=>({...current,target:current.target||flow.target,agentName:current.agentName||flow.target,flow,unavailable:false,sessionExpired:false,readFailed:false}));
        if(isTerminal(flow)){pendingCancel.current=false;clearInterval(timer);}
        else if(pendingCancel.current)cancel(flow);
      }).catch(error=>{
        if(!mounted||!responses.current.current(ticket))return;
        if(error?.status===401||error?.code==='unauthorized')setProgress(current=>({...current,sessionExpired:true}));
        else if(error?.status===404||error?.code==='not_found'){
          missingSince.current??=Date.now();
          if(Date.now()-missingSince.current>=8000)setProgress(current=>({...current,unavailable:true}));
        }else setProgress(current=>({...current,readFailed:true}));
      }).finally(()=>{pending=false;});
    };
    poll();timer=setInterval(poll,POLL_MS);
    return()=>{mounted=false;clearInterval(timer);};
  },[id,api,retry]);
  const view=progressView(progress,now);
  useEffect(()=>{if(view.url&&!view.keepOpen)window.location.replace(view.url);},[view.url,view.keepOpen]);
  const [copied,setCopied]=useState('');
  const copy=async code=>{try{await navigator.clipboard.writeText(code);setCopied('Code copied.');}catch{setCopied('Couldn\'t copy. Select the code instead.');}};
  useEffect(()=>{if(!view.complete)return;const timer=setTimeout(()=>window.close(),1500);return()=>clearTimeout(timer);},[view.complete]);
  const cancel=async(flowOverride=null)=>{
    if(working.current)return;
    working.current=true;setBusy(true);setError('');
    const saved=readProgress(storage(),id),current={...(saved||progress||{}),flow:flowOverride||progress?.flow||saved?.flow};
    const ticket=responses.current.ticket(current.flow?.flowId);
    pendingCancel.current=!current.flow?.flowId;
    const next={...current,target:current.target||current.flow?.target,agentName:current.agentName||current.flow?.target,cancelRequested:true,cancelError:false,cancelled:false};
    writeProgress(storage(),id,next);setProgress(next);
    try{
      if(current.flow?.flowId&&!isTerminal(current.flow)){
        const flow=await api.post('signin/'+encodeURIComponent(current.flow.flowId)+'/cancel',{});
        if(alive.current&&responses.current.accept(ticket,flow)){
          const confirmed={...next,flow,readFailed:false,unavailable:false,sessionExpired:false};writeProgress(storage(),id,confirmed);setProgress(confirmed);
        }
      }
    }catch(e){if(alive.current&&responses.current.current(ticket)){
      const failed={...next,cancelError:true};writeProgress(storage(),id,failed);setProgress(failed);setError(errorMessage(e));
    }}finally{working.current=false;if(alive.current)setBusy(false);}
  };
  return <section class="signin-progress stack-6 ph-no-capture" aria-labelledby="signin-heading" data-telemetry-private="signin">
    <h1 class="t-page" id="signin-heading" ref={headingRef} tabIndex="-1">{view.heading}</h1>
    <div class="card card-pad stack-3">
      {!view.terminal&&<Spinner />}
      <p role="status" aria-live="polite">{view.status}</p>
      {view.code&&<p>Your code: <code>{view.code}</code> <Button kind="quiet" onClick={()=>copy(view.code)}>Copy code</Button> <span role="status">{copied}</span></p>}
      {view.keepOpen&&view.url&&<p><a class="btn btn-secondary" href={view.url} target="_blank" rel="noopener noreferrer">{ACTION_LABELS.open}</a></p>}
      {error&&<p role="alert">{error} Cancellation is not confirmed. Retry Cancel sign-in or return to {view.recovery.name}.</p>}
      <div class="pair">{!view.terminal&&<Button pending={busy} onClick={()=>cancel()}>Cancel sign-in</Button>}
        {!view.terminal&&progress.readFailed&&<Button pending={busy} onClick={()=>setRetry(n=>n+1)}>Check now</Button>}
        <Button href={view.recovery.href} kind={view.terminal?'primary':'quiet'}>{view.expired?ACTION_LABELS.retry:view.recovery.label}</Button></div>
    </div>
  </section>;
}
