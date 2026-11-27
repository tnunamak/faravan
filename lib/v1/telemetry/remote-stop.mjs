import {POSTHOG_HOST,POSTHOG_TOKEN} from './contract.mjs';
/** Public boolean only. A failure immediately closes the gate; success expires after fifteen minutes. */
export function createRemoteStop({consent,transport=fetch,now=Date.now,onStop=()=>{}}) {
 consent.revokeRemoteLease();
 let value=false,checkedAt=-Infinity,lastPoll=-Infinity,running=null,controller=null,discardPending=false;
 const allowed=()=>{const age=now()-checkedAt;return value && age>=0 && age<15*60000;};
 function stop({discard=true}={}) {
  value=false;controller?.abort();consent.revokeRemoteLease();discardPending ||= discard;
  if(discardPending&&onStop()!==false)discardPending=false;
 }

 async function poll({force=false}={}) {
  if(running)return running;
  if(discardPending){stop({discard:false});if(discardPending)return;}
  if(consent.current().effective==='off'){stop({discard:false});return;}
  if(!allowed()&&value)stop();
  if(!force&&now()-lastPoll<5*60000)return;
  controller=new AbortController();const gen=consent.current().generation;
  running=(async()=>{
   try {
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]);
    const dispatched=consent.dispatch(gen,'diagnostics',()=>{lastPoll=now();return transport(POSTHOG_HOST+'/flags/?v=2',{method:'POST',redirect:'error',credentials:'omit',signal,headers:{'content-type':'application/json'},body:JSON.stringify({api_key:POSTHOG_TOKEN,distinct_id:consent.installId(),person_properties:{},geoip_disable:true})});});
    if(!dispatched)return stop();
    const response=await dispatched.response;
    if(response.status!==200)return stop();
    const body=await response.json();
    consent.refresh();
    if(signal.aborted || consent.current().generation!==gen||consent.current().effective==='off')return stop();
    const flag=body?.flags?.['faravan-telemetry-enabled'];
    if(body?.errorsWhileComputingFlags===true || body?.quotaLimited?.includes?.('feature_flags') || flag?.enabled!==true || flag.variant!=null)return stop();
    const lease=consent.tryWithAuthority(()=>consent.grantRemoteLease(gen))?.value;if(!lease)return stop();
    value=true;checkedAt=lease.checkedAt;
   } catch {stop();}
  })().finally(()=>{running=null;controller=null;});
  return running;
 }
 return {allowed,poll,stop,cancel(){stop({discard:false});},reset(){stop({discard:false});lastPoll=-Infinity;}};
}
