import {onboardingVM} from './onboarding.mjs';
import {setupVM} from './view-models.mjs';
const SETUP_STEPS=Object.freeze({sandboxes:'sandboxes','docker-account':'docker_signin',agents:'agent',isolation:'isolation',check:'check',circle:'circle',kvm:'platform','agent:codex':'codex_signin','agent:claude-code-subscription':'claude_signin'});
export function browserOnboarding(screen,data,{circle,lendingReadiness,lendingReadinessError}={}) {
  if(!data?.home)return null;
  if(screen==='setup'){
    const model=setupVM({readiness:data.readiness,agents:data.agents,status:data.home,devices:data.devices,circle,lendingReadiness,lendingReadinessError});
    const current=model.steps?.find(step=>step.primary) ?? model.steps?.find(step=>step.state==='now');
    const step=model.ready?'complete':SETUP_STEPS[current?.id];
    return step?{flow:'lending',step}:null;
  }
  if(!['home','borrow','jobs','job','circles','circle'].includes(screen))return null;
  const current=onboardingVM({home:data.home,circles:data.circles,jobs:data.jobs,agents:data.agents}).progress?.current?.id;
  return ['ready','joined','reviewed','useful'].includes(current)?{flow:'borrowing',step:current}:null;
}
// This route is served by the authenticated phone listener, including when a
// paired phone opens the full Vite app. Read only the scope, never its label.
export async function browserDevice(fetcher=globalThis.fetch) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2000);
  try{const response=await fetcher('/phone/api/inbox',{credentials:'same-origin',signal:controller.signal});if(!response.ok)return 'local';const value=await response.json();return value?.phone?.scopes?.includes('app:full')?'paired':'local';}
  catch{return 'local';}finally{clearTimeout(timer);}
}
