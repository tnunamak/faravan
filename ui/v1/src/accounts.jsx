import {h} from 'preact';
import {useEffect,useMemo,useRef,useState} from 'preact/hooks';
import {createAccountClient} from './api.mjs';

const strings=x=>Array.isArray(x)&&x.every(v=>typeof v==='string');
const capability=(data,name)=>Array.isArray(data?.capabilities?.mutations)&&data.capabilities.mutations.includes(name);
const preference=(data,name)=>capability(data,'settings')&&Array.isArray(data?.capabilities?.settings)&&data.capabilities.settings.includes(name);
const operation=()=>globalThis.crypto?.randomUUID?.()??('account-'+Date.now()+'-'+Math.random().toString(36).slice(2));
const errorCode=e=>e?.status===404?'update_required':typeof e?.code==='string'?e.code:'unavailable';
const words=code=>code==='settings_conflict'||code==='revision_conflict'?'Account preferences changed elsewhere. Reload before trying again.':
  code==='account_removal_pending'?'Removal pending. This account remains until cleanup is confirmed.':
  code==='update_required'||code==='adapter_unsupported'?'Update this host to enable account management.':
  code==='mutation_uncertain'?'The outcome is not confirmed. Check accounts before trying again.':
  code==='offline'?'Reconnect to this computer before changing accounts.':
  code==='signin_failed'?'Sign-in did not finish. Check accounts before trying again.':'Account service is unavailable. Check accounts before trying again.';
function validSnapshot(x) {
  return x?.schemaVersion===1&&Number.isSafeInteger(x.revision)&&x.revision>=0&&
    Array.isArray(x.accounts)&&x.accounts.every(a=>typeof a.id==='string'&&a.id&&typeof a.providerId==='string'&&typeof a.label==='string'&&strings(a.modelOrder))&&
    new Set(x.accounts.map(a=>a.id)).size===x.accounts.length&&
    Array.isArray(x.providers)&&x.providers.every(p=>typeof p.id==='string'&&typeof p.label==='string'&&Array.isArray(p.models))&&strings(x.accountOrder);
}
const flowValue=x=>x&&typeof x.flowId==='string'&&x.flowId&&['waiting','complete'].includes(x.state)&&
  x.presentation&&['browser','code','key','local'].includes(x.presentation.kind)?x:null;
const safeUrl=x=>{try {const u=new URL(x);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};

// Local authenticated surface only. No provider-global fallback, raw responses,
// token storage, or optimistic removal. Public DTO fields are rendered explicitly.
export function Accounts({api,viewerSession={kind:'local'}}) {
  const client=useMemo(()=>createAccountClient(api),[api]);
  const [data,setData]=useState(null),[problem,setProblem]=useState(null),[loading,setLoading]=useState(true);
  const [provider,setProvider]=useState(''),[label,setLabel]=useState(''),[flow,setFlow]=useState(null);
  const [answer,setAnswer]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState({});
  const life=useRef(null),locks=useRef(new Set()),addOperation=useRef(null),removeOperations=useRef(new Map());
  const activeFlow=useRef(null),cancelFlight=useRef(new Map()),answerField=useRef(null);
  const local=viewerSession.kind==='local';
  const clearAnswer=()=>{if(answerField.current)answerField.current.value='';setAnswer('');};
  const cancelOwned=(id)=>{
    if(cancelFlight.current.has(id))return cancelFlight.current.get(id);
    const task=client.cancel(id).finally(()=>cancelFlight.current.delete(id));
    cancelFlight.current.set(id,task);return task;
  };
  const reload=async(session=life.current)=>{
    if(!session?.active||!local)return;
    const serial=++session.serial;setLoading(true);
    try {
      const x=await client.list(session.controller.signal);
      if(!session.active||serial!==session.serial)return;
      if(!validSnapshot(x))throw {code:'update_required'};
      setData(x);setProblem(null);setProvider(old=>x.providers.some(p=>p.id===old)?old:(x.providers[0]?.id??''));
    } catch(e){if(session.active&&serial===session.serial&&e?.name!=='AbortError')setProblem(errorCode(e));}
    finally {if(session.active&&serial===session.serial)setLoading(false);}
  };
  useEffect(()=>{
    const session={active:true,serial:0,locks:new Set(),controller:new AbortController()};life.current=session;
    setData(null);setFlow(null);activeFlow.current=null;setProblem(null);setLoading(local);
    locks.current.clear();addOperation.current=null;removeOperations.current.clear();setPending({});setBusy(false);
    if(local)reload(session);
    return ()=>{
      session.active=false;session.controller.abort();
      // A flow arriving after unmount is cancelled by the add continuation too.
      const owned=activeFlow.current;activeFlow.current=null;
      if(answerField.current)answerField.current.value='';
      if(owned)cancelOwned(owned).catch(()=>{});
    };
  },[client,local]);
  const run=async(key,work)=>{
    const session=life.current;
    if(!session?.active||session.locks.size)return;
    session.locks.add(key);setBusy(true);setProblem(null);
    try {await work(session);}
    catch(e){if(session.active&&e?.name!=='AbortError')setProblem(errorCode(e));}
    finally {session.locks.delete(key);if(session.active)setBusy(false);}
  };
  const result=x=>{if(x?.ok!==true)throw {code:x?.error?.code??'update_required'};return x.value;};
  const add=()=>run('add',async session=>{
    if(!capability(data,'enroll')||!capability(data,'complete')||!capability(data,'cancel'))throw {code:'update_required'};
    // Uncertain retries retain both operation ID and exact original payload.
    addOperation.current??={providerId:provider,label,operationId:operation()};
    const x=flowValue(result(await client.enroll(addOperation.current)));
    if(!x)throw {code:'update_required'};
    if(!session.active){if(x.state!=='complete')await cancelOwned(x.flowId);return;}
    addOperation.current=null;
    if(x.state==='complete'){await reload(session);return;}
    activeFlow.current=x.flowId;setFlow(x);
  });
  const complete=()=>{const submitted=answer;clearAnswer();return run('complete',async session=>{
    result(await client.complete(flow.flowId,submitted));
    if(session.active){activeFlow.current=null;setFlow(null);await reload(session);}
  });};
  const cancel=()=>{clearAnswer();return run('cancel',async session=>{
    result(await cancelOwned(flow.flowId));
    if(session.active){activeFlow.current=null;setFlow(null);addOperation.current=null;await reload(session);}
  });};
  const checkFlow=()=>run('flow',async session=>{
    const response=await client.flow(flow.flowId,session.controller.signal);
    const x=flowValue(response?.ok===true?response.value:response);if(!x||x.flowId!==flow.flowId)throw {code:'update_required'};
    if(!session.active)return;
    if(x.state==='complete'){activeFlow.current=null;clearAnswer();setFlow(null);await reload(session);}else setFlow(x);
  });
  const remove=a=>run('remove:'+a.id,async session=>{
    if(!capability(data,'remove'))throw {code:'update_required'};
    if(!removeOperations.current.has(a.id))removeOperations.current.set(a.id,operation());
    const response=await client.remove(a.id,removeOperations.current.get(a.id));
    if(!session.active)return;
    if(response?.ok===false&&response.error?.code==='account_removal_pending'){
      setPending(old=>({...old,[a.id]:true}));return;
    }
    result(response);removeOperations.current.delete(a.id);
    setPending(old=>{const next={...old};delete next[a.id];return next;});
    setData(old=>({...old,accounts:old.accounts.filter(x=>x.id!==a.id),accountOrder:old.accountOrder.filter(id=>id!==a.id)}));
  });
  const save=(a,changes)=>run('settings:'+a.id,async session=>{
    result(await client.settings(a.id,data.revision,changes,data.capabilities));
    if(session.active)await reload(session); // server-confirmed preferences only
  });
  const ordered=data?[...data.accounts].sort((a,b)=>{
    const rank=id=>{const n=data.accountOrder.indexOf(id);return n<0?data.accountOrder.length:n;};
    return rank(a.id)-rank(b.id);
  }):[];
  return <section class="info-page ph-no-capture" data-telemetry-private="accounts" aria-labelledby="accounts-heading">
    <h2 id="accounts-heading" class="t-page">Accounts</h2>
    {!local?<p>Open this computer’s local app to manage accounts.</p>:<>
      {problem&&<div role="alert"><p>{words(problem)}</p><button type="button" class="btn btn-secondary" disabled={busy} onClick={()=>reload()}>Check accounts</button></div>}
      {loading?<p role="status">Loading accounts…</p>:data&&<>
        {!ordered.length&&<p>No accounts. Add an account on this computer to get started.</p>}
        {!['enroll','complete','cancel','remove','settings'].every(n=>capability(data,n))&&<div><p>Update this host to enable unsupported account controls.</p><button type="button" class="btn btn-secondary" disabled={busy} onClick={()=>reload()}>Check host support</button></div>}
        {!flow&&<div>
          <label>Provider<select aria-label="Provider" value={provider} disabled={busy||!!addOperation.current||!capability(data,'enroll')} onChange={e=>setProvider(e.currentTarget.value)}>
            {data.providers.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
          </select></label>
          <label>Account label<input aria-label="Account label" value={label} disabled={busy||!!addOperation.current} onInput={e=>setLabel(e.currentTarget.value)}/></label>
          <button type="button" class="btn btn-primary" disabled={busy||!provider||!['enroll','complete','cancel'].every(n=>capability(data,n))} onClick={add}>Add account</button>
        </div>}
        {flow&&<div role="group" aria-label="Active sign-in">
          <p>Finish signing in to this account.</p>
          {safeUrl(flow.presentation.url)&&<a href={safeUrl(flow.presentation.url)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open sign-in</a>}
          {flow.presentation.kind==='code'&&typeof flow.presentation.userCode==='string'&&<p>{flow.presentation.userCode}</p>}
          {['browser','key','code'].includes(flow.presentation.kind)&&<label>
            {flow.presentation.kind==='browser'?'Code from sign-in (if asked)':'Sign-in answer'}
            <input ref={answerField} aria-label={flow.presentation.kind==='browser'?'Code from sign-in':'Sign-in answer'} type="password" autoComplete="off" value={answer} onInput={e=>setAnswer(e.currentTarget.value)} disabled={busy}/>
          </label>}
          <button type="button" class="btn btn-primary" disabled={busy} onClick={complete}>Complete sign-in</button>
          <button type="button" class="btn btn-secondary" disabled={busy} onClick={cancel}>Cancel sign-in</button>
          <button type="button" class="btn btn-secondary" disabled={busy} onClick={checkFlow}>Check sign-in</button>
        </div>}
        {ordered.map((a,index)=>{
          const p=data.providers.find(p=>p.id===a.providerId);
          const models=[...(p?.models??[])].sort((x,y)=>{
            const rank=id=>{const n=a.modelOrder.indexOf(id);return n<0?a.modelOrder.length:n;};return rank(x.id)-rank(y.id);
          });
          return <article key={a.id} aria-label={a.label}>
            <h3>{a.label}</h3><p>{p?.label??'Provider unavailable'} · {a.authState==='signed_in'?'Signed in':a.authState==='signed_out'?'Signed out':'Sign-in needed'}</p>
            <p>{a.enabled?'Enabled':'Off'}</p>
            <label><input type="checkbox" checked={a.paretoOnly===true} disabled={busy||!preference(data,'paretoOnly')}
              onChange={e=>save(a,{paretoOnly:e.currentTarget.checked})}/> Pareto only</label>
            <ul>{models.map((m,i)=>{
              const saved=Object.hasOwn(a.modelPreferences??{},m.id)?a.modelPreferences[m.id]:null;
              const enabled=saved?.enabled===true;
              const allowed=saved?.effortIds ?? m.efforts.map(effort=>effort.id);
              const supported=preference(data,'modelPreference');
              const setModel=(nextEnabled,effortIds)=>save(a,{modelPreference:{modelId:m.id,enabled:nextEnabled,effortIds}});
              return <li key={m.id}>
                <label><input type="checkbox" checked={enabled} disabled={busy||!supported||!m.enabled}
                  onChange={e=>setModel(e.currentTarget.checked,saved?.effortIds??null)}/> Lend {m.label}</label>
                {!m.enabled && <span>Provider unavailable</span>}
                {m.efforts.length ? <fieldset disabled={busy||!supported||!enabled}>
                  <legend>Allowed efforts for {m.label}</legend>
                  {m.efforts.map(effort=><label key={effort.id}><input type="checkbox" checked={allowed.includes(effort.id)}
                    onChange={e=>setModel(enabled,e.currentTarget.checked?[...allowed,effort.id]:allowed.filter(id=>id!==effort.id))}/> {effort.label}</label>)}
                </fieldset> : <span>Default effort only</span>}
                {i>0&&preference(data,'modelOrder')&&<button type="button" disabled={busy} onClick={()=>{const ids=models.map(x=>x.id);[ids[i-1],ids[i]]=[ids[i],ids[i-1]];save(a,{modelOrder:ids});}}>Move {m.label} earlier</button>}
              </li>;
            })}</ul>
            <button type="button" class="btn btn-secondary" disabled={busy||!preference(data,'enabled')} onClick={()=>save(a,{enabled:!a.enabled})}>{a.enabled?'Disable':'Enable'} {a.label}</button>
            {index>0&&<button type="button" class="btn btn-secondary" disabled={busy||!preference(data,'accountOrder')} onClick={()=>{const ids=ordered.map(x=>x.id);[ids[index-1],ids[index]]=[ids[index],ids[index-1]];save(a,{accountOrder:ids});}}>Move {a.label} earlier</button>}
            {pending[a.id]&&<p role="status">Removal pending. Waiting for streams and cleanup.</p>}
            <button type="button" class="btn btn-secondary" disabled={busy||!capability(data,'remove')} onClick={()=>remove(a)}>{pending[a.id]?'Check removal':'Remove'} {a.label}</button>
          </article>;
        })}
      </>}
    </>}
  </section>;
}
