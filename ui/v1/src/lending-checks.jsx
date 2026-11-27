import {useContext,useEffect,useRef,useState} from 'preact/hooks';
import {Button} from './ds/index.mjs';
import {Connection,Notices,OFFLINE_REASON} from './shared.jsx';
import {focusOutcome} from './focus.mjs';
import {recheckReadiness,checkOutcome,boundedUI} from './lending-checks.mjs';

function CheckControl({api,refresh,kind='secondary',children}) {
  const [pending,setPending]=useState(false),[note,setNote]=useState('');
  const operation=useRef(null),mounted=useRef(true),trigger=useRef(null);
  const {offline}=useContext(Connection),notices=useContext(Notices);
  useEffect(()=>()=>{mounted.current=false;operation.current?.abort();if(trigger.current&&!trigger.current.isConnected)requestAnimationFrame(focusOutcome);},[]);
  async function check(event) {
    if(operation.current||offline)return;
    trigger.current=event.currentTarget;
    const controller=new AbortController();operation.current=controller;
    setPending(true);setNote('');const page=notices?.page();
    try {
      const result=await recheckReadiness(api,controller.signal);
      if(controller.signal.aborted)return;
      const text=checkOutcome(result);
      if(mounted.current)setNote(text);
      notices?.set(text,page);
      try {await boundedUI(Promise.resolve().then(refresh));}
      catch {
        if(controller.signal.aborted)return;
        const message=text+' The rest of the page could not update.';
        if(mounted.current)setNote(message);
        notices?.set(message,page);
      }
    }catch {
      if(!controller.signal.aborted&&mounted.current)setNote(checkOutcome());
    }finally {
      if(operation.current===controller)operation.current=null;
      if(mounted.current)setPending(false);
      if(trigger.current&&!trigger.current.isConnected)requestAnimationFrame(focusOutcome);
    }
  }
  return <span class="check-control"><Button kind={kind} size="sm" aria-label={typeof children==='string'?children:undefined} pending={pending} disabled={offline} disabledReason={OFFLINE_REASON} title={offline?OFFLINE_REASON:undefined} onClick={check}>{children}{pending?' · Checking…':''}</Button><span class="t-xs t-2 ph-no-capture" role="status" data-telemetry-private="readiness">{pending?'Checking…':note}</span>{offline&&<span class="t-xs t-2">{OFFLINE_REASON}</span>}</span>;
}
export const ReadinessCheck=props=><CheckControl {...props}>{props.children||'Check readiness again'}</CheckControl>;
