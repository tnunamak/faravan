import {useContext, useLayoutEffect, useRef, useState} from 'preact/hooks';
import {Button, Field} from './ds/index.mjs';
import {Action, Connection, OFFLINE_REASON, enc, go} from './shared.jsx';
import {errorMessage} from './helpers.mjs';
import {nameHostComputerInCopy} from './view-models.mjs';

// A new circle on an existing host shares its address, with separate membership and jobs.
export function StartAnotherCircle({mutate,refresh,first=false,computerReference=null}) {
  const [name,setName]=useState(''), [pending,setPending]=useState(false), [error,setError]=useState('');
  const [unknownNames,setUnknownNames]=useState([]);
  const unknown=useRef(new Set());
  const inFlight=useRef(false), {offline}=useContext(Connection);
  const mounted=useRef(true);
  useLayoutEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
  const checkCircles=async()=>{
    // A failed read must not strand recovery, but an old page must not redirect its successor.
    try{await refresh();}catch{/* Circles owns its read-error presentation. */}
    if(mounted.current)go('circles');
  };
  const start=async event=>{
    event.preventDefault();
    const attemptedName=name.trim();
    if(inFlight.current||!attemptedName||unknown.current.has(attemptedName)||offline)return;
    inFlight.current=true;setPending(true);setError('');
    try{
      const created=await mutate('circles',{name:attemptedName});
      // A success without a circle id is not a confirmed circle: never navigate to an invented page.
      if(created?.error||created?.problem)throw created;
      if(typeof created?.id!=='string'||!created.id.trim())throw {code:'mutation_uncertain'};
      if(mounted.current)go('circle/'+enc(created.id));
    }
    catch(error){
      if(!mounted.current)return;
      const code=error?.problem?.code ?? error?.code;
      const uncertain=typeof code!=='string'||!code.trim()||['timeout','network','network_error','offline','service_unavailable','internal_error','mutation_uncertain','mutation_pending','unknown'].includes(code);
      if(uncertain){unknown.current.add(attemptedName);setUnknownNames([...unknown.current]);setError('Faravan couldn’t confirm the new circle. Check Circles before starting it again.');}
      else setError(errorMessage(error));
    }
    finally{inFlight.current=false;if(mounted.current)setPending(false);}
  };
  return <form class="stack-6 host ph-no-capture" onSubmit={start} data-telemetry-private="start-circle">
    <p class="t-sm t-2">{nameHostComputerInCopy(first ? 'Hosting setup was started on this computer, but Faravan has not confirmed a running circle yet.' : 'Hosted on this computer at the same address. Your new circle has its own members, jobs and files.', computerReference)}</p>
    <Field label="Circle name" placeholder="For example, Weekend projects" maxLength={256} value={name} disabled={pending} onInput={event=>setName(event.currentTarget.value)} autoFocus />
    <div class="stack-2">
      <Button kind="primary" type="submit" pending={pending} disabled={!name.trim()||pending||offline||unknownNames.includes(name.trim())} disabledReason={offline?OFFLINE_REASON:!name.trim()?'Enter a circle name first':'Check Circles first. This name may already exist.'}>Start circle</Button>
      {pending&&<p class="t-sm t-2" role="status">Starting your circle…</p>}
      {offline&&<p class="t-sm t-2" role="status">{OFFLINE_REASON}</p>}
      {unknownNames.length>0&&(typeof refresh==='function' ? <Action run={checkCircles} success="">Check Circles</Action> : <><Button href="#/circles">Open Circles</Button><p class="t-sm t-2" role="status">Refresh is unavailable here. Open Circles and refresh the list to check the outcome.</p></>)}
      {error&&<p class="t-sm bad-text" role="alert">{error}</p>}
    </div>
  </form>;
}
