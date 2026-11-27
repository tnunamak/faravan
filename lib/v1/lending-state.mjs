/**
 * Pure local projection. Times are epoch milliseconds; no IO or implicit clock.
 *
 * Two axes (EXPERIENCE 1.1). `intent` is what lending is set to do; `execution` is what is
 * running now, computed first and never hidden by an `off` or `paused` intent. `state`,
 * `reason` and `until` keep the old single-axis answer for older clients.
 */
import { lendingBlockers } from './blockers.mjs';
import { RUNNING_JOB } from './lending-status-copy.mjs';

// The blockers that sit before lending in the ordered model (EXPERIENCE 1.21): Docker, per-job isolation, the circle's host.
// A blocker never changes the intent: it holds new claims, the switch stays on, and lending resumes when the blocker clears.
const MACHINE = ['docker_installed', 'docker_running', 'docker_signin', 'readiness_requirement', 'isolation_check', 'circle'];
export const blockerReason = item => item.unconfirmed&&item.key!=='agent'?'sandbox_not_ready':({
  docker_installed: 'docker_not_installed', docker_running: 'docker_not_running', docker_signin: 'docker_signed_out',
  readiness_requirement: item.cause==='guard_runtime_unavailable'?'guard_runtime_unavailable':item.cause==='v1_limits'?'requirements_unsupported':item.cause==='network_policy'?'policy_unenforceable':'sandbox_not_ready',
  isolation_check:'isolation_check_failed',
  circle: item.detail_code === 'unreachable' ? 'circle_unreachable' : 'circle_update_needed',
})[item.key];

const fmtTime=(ms,timeZone)=>{
  if(!Number.isFinite(ms))return null;
  const local=Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {return new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:timeZone||local}).format(ms);}
  catch {return new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:local}).format(ms);}
};

export function effectiveState({
  intent='off', pause_until=null, paused: pausedOpen=false, now=0, launchedAt=0, factsKnown=true,
  blockReason=null, agents=[], current=null, launched=false, blocking=null,
  restingReason=null, restingUntil=null, needs_you=[], resuming=false, resumeError=null,
  outsideNextStart=null, updateRequired=false,
  person=null, stopsBy=null, stopping=false, timeZone=null, cessationPending=false,
}={}) {
  const intentOn=intent==='on'||intent==='paused';
  const needs=needs_you.map(item=>({...item}));
  const blockers=[];
  // The ordered model, when the caller knows the facts: {docker, isolationFailure, circle, agents} (lib/v1/blockers.mjs).
  const timedPause=Number.isFinite(pause_until),paused=intent==='paused'||timedPause||pausedOpen===true||resuming||Boolean(resumeError);
  const futurePause=timedPause&&pause_until>now;
  let model=null,machine=[];
  if(blocking) {
    model=lendingBlockers({readiness:blocking.readiness,checking:blocking.checking,docker:blocking.docker,isolationFailure:blocking.isolationFailure,readinessRequirements:blocking.readinessRequirements,circle:blocking.circle,agents:blocking.agents??[],
      intent:{on:intentOn,pausedUntil:paused?(futurePause?fmtTime(pause_until,timeZone):'you resume'):null,
        outsideUntil:Number.isFinite(outsideNextStart)?fmtTime(outsideNextStart,timeZone):null,
        restingUntil:restingReason&&Number.isFinite(restingUntil)?fmtTime(restingUntil,timeZone):null}});
    machine=model.items.filter(item=>item.status==='blocked'&&MACHINE.includes(item.key));
  }
  // A machine step still being checked (Docker facts not read yet, a readiness check running) is not proof that this
  // computer can take a job: lending stays on, but it is not ready until every step is known to be ok.
  const machineUnknown=Boolean(model)&&!machine.length&&model.items.some(item=>MACHINE.includes(item.key)&&['unknown','waits'].includes(item.status));
  const machineReason=machine.length?blockerReason(machine[0]):null;
  for(const item of machine){blockers.push({kind:blockerReason(item)});if(item.action)needs.push({kind:blockerReason(item)});}
  for(const agent of agents.filter(a=>a.enabled&&a.signedIn===false)) {
    needs.push({kind:'agent_signed_out',agent:agent.id});
    blockers.push({kind:'agent_signed_out',agent:agent.id});
  }
  // The blocker list keeps the raw kind; the status reason names an unreachable host the way every other surface does.
  const statusReason=blockReason==='network_error'?'circle_unreachable':blockReason;
  if(blockReason)blockers.push({kind:blockReason});
  const runnable=agents.some(a=>a.enabled&&a.installed===true&&a.signedIn===true);

  // Intent: what lending is set to do, whatever is running.
  let state,reason=null,until=null;
  if(!intentOn)state='off';
  else if(paused){state='paused';reason=resumeError?'resume_failed':'paused';until=timedPause?pause_until:null;}
  else if(machineReason){state='blocked';reason=machineReason;}
  else if(updateRequired){state='update';reason='update_required';}
  else if(blockReason){state='blocked';reason=statusReason;}
  else if(!runnable&&!factsKnown&&now-launchedAt<10000)state='starting';
  else if(!runnable){
    state='blocked';reason='agent_not_ready';
    if(!blockers.some(b=>b.kind==='agent_not_ready'||b.kind==='agent_signed_out'))blockers.push({kind:agents.some(a=>a.enabled)?'agent_not_ready':'no_agents'});
  }
  else if(current&&!launched){state='starting';reason='execution_starting';}
  else if(current&&!machineUnknown)state='ready'; // a running job outranks a rest or window: the job is what the headline names
  else if(current){state='starting';reason='machine_checking';}
  else if(restingReason){state='resting';reason=restingReason;until=restingUntil;}
  else if(Number.isFinite(outsideNextStart)){state='outside';until=outsideNextStart;}
  // A definite reason (a rest, a window) still names itself; otherwise unknown machine facts are never ready.
  else if(machineUnknown){state='starting';reason='machine_checking';}
  else state='ready';
  const intentView={on:intentOn,state,reason,until,...(state==='paused'&&resuming?{resuming:true}:{}),
    ...(state==='paused'&&resumeError?{resumeError}:{})};

  // Execution: observed, and shown whatever the intent says.
  let execution={state:'idle'};
  if(current&&launched) {
    const job={job:current,person,stops_by:Number.isFinite(stopsBy)?stopsBy:null};
    execution=stopping?{state:'stopping',...job}:
      state==='ready'||reason==='machine_checking'?{state:'running',...job}:{state:'finishing',...job};
  } else if(cessationPending) {
    // The job is over but its sandbox is not proven gone: still stopping, whatever the intent says.
    execution={state:'stopping',job:null,person:null,stops_by:null};
  }

  // The old single answer: intent wins over a running job, except where the old order let the job win.
  const legacy=!intentOn?['off',null,null]:paused?['paused',resumeError?'resume_failed':'paused',timedPause?pause_until:null]:
    machineReason?['blocked',machineReason,null]:updateRequired?['update','update_required',null]:blockReason?['blocked',statusReason,null]:
    state==='starting'&&reason!=='machine_checking'?['starting',null,null]:!runnable?['blocked','agent_not_ready',null]:
    current&&launched?['running',null,null]:current?['starting','execution_starting',null]:restingReason?['resting',restingReason,restingUntil]:state==='outside'?['ready',null,null]:machineUnknown?['starting','machine_checking',null]:['ready',null,null];

  const who=person?person+"'s job":'A job',by=execution.stops_by!==null&&execution.stops_by!==undefined?fmtTime(execution.stops_by,timeZone):null;
  const clause=execution.state==='running'?who+' is running'+(by?', stops by '+by:''):
    execution.state==='finishing'?RUNNING_JOB+(by?' It stops by '+by+'.':''):
    execution.state==='stopping'?(execution.job===null?'Stopping a job; not confirmed yet':'Stop requested for '+who):null;
  const base={ready:'Lending is on',paused:resumeError?'Paused · Lending could not resume':resuming?'Paused · Resuming…':futurePause?'Paused until '+fmtTime(pause_until,timeZone):'Paused',off:'Lending is off',
    blocked:machine.length?machine[0].headline:'Lending stopped',starting:'Starting lending…',resting:until!==null?'Resting until '+fmtTime(until,timeZone):'Resting',
    outside:until!==null?'Outside lending hours · starts at '+fmtTime(until,timeZone):'Outside lending hours',update:'Update needed'}[state];
  const headline=clause?(state==='ready'&&execution.state==='running'?base+' · '+clause:base.replace(/ until .*$/,'')+' · '+clause):base;

  return {state:legacy[0],reason:legacy[1],until:legacy[2],needs_you:needs,
    intent:intentView,execution,blockers,headline,...(model?{lending_blockers:model}:{})};
}

/** Local wall-clock hours. days uses JS weekdays: Sunday=0 through Saturday=6.
 * An overnight window belongs to its starting day; both bounds are minute precision.
 * null preserves unrestricted lending for existing installations. */
export function validateSchedule(value) {
  if(value===null)return null;
  const invalid=()=>{throw Object.assign(new Error('invalid_schedule'),{code:'invalid_request'});};
  if(!value||typeof value!=='object'||Array.isArray(value)||
     Object.keys(value).some(k=>!['days','from','to','weekends_all_day'].includes(k))||
     !Array.isArray(value.days)||value.days.length>7||
     value.days.some(d=>!Number.isInteger(d)||d<0||d>6)||new Set(value.days).size!==value.days.length||
     typeof value.weekends_all_day!=='boolean'||
     typeof value.from!=='string'||typeof value.to!=='string'||
     !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.from)||
     !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.to)||value.from===value.to||
     (!value.days.length&&!value.weekends_all_day))invalid();
  return {days:[...value.days],from:value.from,to:value.to,weekends_all_day:value.weekends_all_day};
}

export function lendingHours(schedule,now,timeZone='UTC') {
  if(schedule===null||schedule===undefined)return {inside:true,until:null};
  const hours=validateSchedule(schedule);
  if(!Number.isFinite(now))throw new TypeError('invalid time');
  const formatter=new Intl.DateTimeFormat('en-US',{timeZone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const minutes=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
  const from=minutes(hours.from),to=minutes(hours.to);
  const inside=at=>{
    const p=Object.fromEntries(formatter.formatToParts(at).map(p=>[p.type,p.value]));
    const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday),minute=Number(p.hour)*60+Number(p.minute);
    if(hours.weekends_all_day&&(day===0||day===6))return true;
    if(from<to)return hours.days.includes(day)&&minute>=from&&minute<to;
    return (hours.days.includes(day)&&minute>=from)||(hours.days.includes((day+6)%7)&&minute<to);
  };
  // Every minute from a cached "outside" answer up to its next start is known to be outside.
  const key=timeZone+JSON.stringify(hours);
  if(outsideMemo?.key===key&&now>=outsideMemo.from&&now<outsideMemo.until)return {inside:false,until:outsideMemo.until};
  if(inside(now))return {inside:true,until:null};
  // Scan actual instants, so skipped/repeated civil minutes around DST are honest.
  const first=Math.floor(now/60000)*60000+60000;
  for(let at=first;at<=first+8*86400000;at+=60000)
    if(inside(at)){outsideMemo={key,from:now,until:at};return {inside:false,until:at};}
  return {inside:false,until:null};
}
let outsideMemo=null;
