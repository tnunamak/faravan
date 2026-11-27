import {formatDate} from './dates.mjs';
export const REQUEST_UI_TIMEOUT_MS=15000;
const READINESS_UI_TIMEOUT_MS=90000;
export function boundedUI(promise, timeoutMs=REQUEST_UI_TIMEOUT_MS) {
 let timer; return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Status is unknown')),timeoutMs);})]).finally(()=>clearTimeout(timer));
}
export function recheckReadiness(api, signal) {
  const deadline=AbortSignal.timeout(READINESS_UI_TIMEOUT_MS);
  return api.get('readiness?refresh=true',signal?AbortSignal.any([signal,deadline]):deadline,undefined,
    {transferTimeout:READINESS_UI_TIMEOUT_MS,retry:false});
}
function checkedTime(value, zone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const at=typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(at) ? formatDate(at,'exact',{zone}) : '';
}
export function checkOutcome(report, zone) {
  const failed=report?.checks?.find(check=>check.ok===false&&check.unknown!==true)??
    (report?.workspaceCheck?.ok===false?report.workspaceCheck:null);
  if(failed) {
    const reason=failed.label?.trim(), remedy=failed.remedy?.trim();
    if(reason&&remedy&&!reason.includes(remedy))return reason.replace(/[.!?]$/,'')+' — '+remedy;
    if(reason||remedy)return reason||remedy;
  }
  if(report?.ready===true) {
    const login=report.checks?.find(check=>check.name==='docker_login');
    if(login?.signinVerified===false&&login.createAccepted!==true&&report.workspaceCheck?.ok!==true)
      return login.checking?'Faravan is checking whether Docker can start a workspace.':
        'Faravan hasn’t confirmed a Docker workspace start — choose Check again.';
    const observed=checkedTime(report.protection?.observed_at??report.observed_at,zone);
    return observed?'Sandbox checks passed. Last checked '+observed:'Sandbox checks passed.';
  }
  return 'Faravan couldn’t confirm readiness. Check again.';
}
