import {useEffect,useRef,useState} from 'preact/hooks';
import {formatDate} from './dates.mjs';
import {updatesVM} from './updates-view.mjs';

// Shell snapshots are invalidation hints, not ordered page evidence.
const snapshotKey=value=>JSON.stringify(value,(_key,item)=>
  item&&typeof item==='object'&&!Array.isArray(item)
    ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);

export function Updates({api,initial=null}) {
  const [data,setData]=useState(initial),[error,setError]=useState(''),[pending,setPending]=useState(false);
  const [checking,setChecking]=useState(false);
  const generation=useRef(0),busy=useRef(null),mutation=useRef(null),owner=useRef(null);
  const currentApi=useRef(api);currentApi.current=api;
  const key=snapshotKey(initial),lastInitial=useRef(key);
  const owns=o=>o.active&&owner.current===o&&currentApi.current===o.api;
  const invalidate=()=>{generation.current++;if(busy.current)clearTimeout(busy.current.timer);busy.current=null;setPending(false);};
  const drain=o=>{
    // Observation deadlines never release physical ownership. Only settlement
    // may consume a queued hint; hints arriving during this read queue again.
    if(!owns(o)||!o.hint||o.requests.size||busy.current||mutation.current)return;
    o.hint=false;o.run('read',false,true);
  };
  const run=async(kind,foreground=true,advisory=false)=>{
    const o=owner.current;if(!o||!owns(o))return;
    if(kind==='check'&&mutation.current)return;
    if(busy.current){if(kind==='check'&&!busy.current.foreground)invalidate();else return;}
    const ticket={id:++generation.current,timer:null,foreground};
    busy.current=ticket;o.requests.add(ticket);
    if(kind==='check'){mutation.current=ticket;setChecking(true);}
    setPending(foreground);
    ticket.timer=setTimeout(()=>{
      if(!owns(o)||generation.current!==ticket.id)return;
      generation.current++;busy.current=null;setPending(false);
      const message='Update status timed out. Refresh status to see what happened.'+(mutation.current?' A check may still be running; another check is blocked until its request settles.':'');
      setError(previous=>advisory&&previous?previous:message);
    },15000);
    try{
      const value=await (kind==='check'?o.api.post('updates/check'):o.api.get('updates'));
      if(owns(o)&&generation.current===ticket.id){setData(value);setError('');}
    }catch{
      if(owns(o)&&generation.current===ticket.id){
        const message=kind==='check'?'We couldn’t check for updates. Your installed version is still running. Try again.':'Update status could not be read. Try again.';
        setError(previous=>advisory&&previous?previous:message);
      }
    }finally{
      clearTimeout(ticket.timer);o.requests.delete(ticket);
      if(owns(o)){
        if(busy.current===ticket){busy.current=null;setPending(false);}
        if(mutation.current===ticket){mutation.current=null;setChecking(false);}
        drain(o);
      }
    }
  };
  useEffect(()=>{
    const o={api,active:true,hint:false,requests:new Set(),run};
    owner.current=o;lastInitial.current=key;
    setChecking(false);setPending(false);
    run('read',false);
    return()=>{
      o.active=false;o.hint=false;
      for(const ticket of o.requests)clearTimeout(ticket.timer);
      if(owner.current===o){generation.current++;busy.current=null;mutation.current=null;owner.current=null;}
    };
  },[api]);
  useEffect(()=>{
    if(key===lastInitial.current)return;
    lastInitial.current=key;
    const o=owner.current;if(!o||!owns(o))return;
    o.hint=true;drain(o);
  },[key,api]);
  const vm=updatesVM(data??{},!!error);
  const check=()=>run('check');
  const retry=()=>run('read');
  const time=value=>value?formatDate(value,'exact')||'Unknown':'Not yet';
  return <section class="info-section stack-4 ph-no-capture" aria-labelledby="updates-title" data-telemetry-private="updates">
    <p class="t-sm t-2">Updates: this computer</p>
    <h2 id="updates-title" class="t-title2">{data?vm.headline:error?'Update status unavailable':'Loading update status…'}</h2>
    {data&&!error&&!vm.error&&<p>{vm.explanation}</p>}
    {data&&(error||vm.error)&&<p>Last known update details and release notes are shown below.</p>}
    {data&&<dl class="stack-3"><div><dt class="t-sm t-2">Running version</dt><dd>{data.currentVersion||'Version unavailable'}</dd></div>
      <div><dt class="t-sm t-2">Last checked</dt><dd>{time(data.checkedAt)}</dd></div>
      {data.nextCheckAt&&<div><dt class="t-sm t-2">Next automatic check</dt><dd>{time(data.nextCheckAt)}</dd></div>}</dl>}
    {(error||vm.error)&&<p role="alert">{error||vm.error}</p>}
    {checking&&!pending&&<p role="status">The check request is still unresolved. Refresh status reads the latest status without starting another check.</p>}
    {vm.canCheck&&<button type="button" class="btn btn-secondary" disabled={pending||checking||vm.pending} onClick={check}>{pending||checking||vm.pending?'Checking…':'Check now'}</button>}
    {!(checking&&pending)&&((!data&&error)||(data&&(error||vm.pending||checking)))&&<button type="button" class="btn btn-secondary" disabled={pending} aria-busy={pending} onClick={retry}>{pending?'Loading update status…':data?'Refresh status':'Try again'}</button>}
    {!!data?.notes?.length&&<div class="stack-2"><h3 class="t-title3">What’s new</h3><ul>{data.notes.map((note,i)=><li key={i}>{note}</li>)}</ul></div>}
    {data?.notesUrl&&<a href={data.notesUrl} target="_blank" rel="noopener noreferrer">Full release notes</a>}
  </section>;
}
