import { adaptLegacyJob } from './state-projection.mjs';
import { classify, passingDeclineCode } from './failures.mjs';

// The one reading of a presence entry: the job status line and the circle roster both classify a lender through it,
// so they cannot disagree about who is active. `spent` is true when no jobs or minutes are left today.
// state is 'offline' (no fresh report) or the lender's own state, with exhausted budgets as 'done' and a lender that
// lacks the job's agent as 'unfit'.
export function classifyLender(d,{now=Date.now(),harnesses=null,wallSeconds=null,accountMismatchDevices}={}) {
  const at=Date.parse(d.source==='poll'?d.last_poll_at:d.last_heartbeat_at??d.last_poll_at);
  if(!d.online||!Number.isFinite(at)||now-at<0||now-at>=90000)return {state:'offline',at,spent:false};
  // The coordinator retains old heartbeat fields in a poll-only row. Polling only establishes reachability.
  if(d.source==='poll')return {state:accountMismatchDevices?.has(d.device)?'account_unknown':'polled',at,spent:false};
  // Minutes left that this job's time limit does not fit in are spent for it, as the lender's gate refuses it (judge r10 R3).
  const minutesLeft=d.budget?.minutes_left_today;
  const spent=d.budget?.jobs_left_today===0||minutesLeft===0||
    Number.isFinite(wallSeconds)&&Number.isFinite(minutesLeft)&&minutesLeft*60<wallSeconds;
  // An older lender reports no agents: unknown, so it is not excluded.
  const fits=!Array.isArray(harnesses)||!harnesses.length||!Array.isArray(d.agents)||!d.agents.length||
    d.agents.some(a=>a?.readiness==='ready'&&harnesses.includes(a.adapter));
  let state=['starting','running','finishing','stopping'].includes(d.execution?.state)?'running':d.intent?.state;
  // A lender with lending off and nothing left today is both: the reader needs to know it stays off until tomorrow.
  if(state==='resting'&&d.intent?.reason==='daily_limit'||['ready','resting'].includes(state)&&spent)state='done';
  else if(state==='ready'&&!fits)state='unfit';
  else if(state==='ready'&&accountMismatchDevices?.has(d.device))state=d.source==='heartbeat'?'account_unfit':'account_unknown';
  return {state,at,spent};
}

const CLEANUP_WAIT_REASONS = new Set(['cleanup_pending','cessation_unverified','scratch_cleanup_pending']);

// Public status explanations. Never include another person's allowance, reserve or paths.
// A computer counts as ready only when it lends now, has jobs and minutes left today and lends an agent this job
// can use. Budgets classify; their numbers are never shown.
export function waitingSummary(presence,{id,now=Date.now(),timeZone,harnesses=null,wallSeconds=null,accountMismatchDevices}={}) {
  if(!Array.isArray(presence?.devices))return null;
  const counts={ready:0,running:0,outside:0,resting:0,done:0,unfit:0,account_unfit:0,account_unknown:0,cleanup:0,polled:0,offline:0,off:0}, absent=[], done=[], off=[], reviewers=[];
  const label=d=>[d.personName,d.deviceName].map(v=>typeof v==='string'?v.replace(/[\p{Cc}\p{Cf}]/gu,'').slice(0,64):'').find(Boolean)??'';
  for(const d of presence.devices) {
    if(id&&d.device===id)continue;
    const {state,at,spent}=classifyLender(d,{now,harnesses,wallSeconds,accountMismatchDevices});
    if(state==='offline'){counts.offline++;
      const name=label(d);
      const atText=Number.isFinite(at)?new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',...(timeZone?{timeZone}:{})}).format(at):'';
      if(name)absent.push(name+" hasn't checked in"+(atText?' since '+atText:' recently'));
      continue;}
    if(state==='blocked'&&d.source==='heartbeat'&&CLEANUP_WAIT_REASONS.has(d.intent?.reason)) {
      counts.cleanup++;
      continue;
    }
    if(state==='done'&&label(d))done.push(label(d));
    if(!Object.hasOwn(counts,state)||state==='off')off.push({name:label(d),spent});
    counts[Object.hasOwn(counts,state)?state:'off']++;
    // A ready lender with an ask card open is deciding on offers like this one.
    // Only a fresh heartbeat says so: when presence has fallen back to polls, the old reason may describe a card long closed.
    if(state==='ready'&&d.source==='heartbeat'&&d.intent?.reason==='reviewing_offer')reviewers.push(label(d)||'the lender');
  }
  // Every ready computer is waiting on its person: the answer is theirs, not a queue.
  if(reviewers.length&&reviewers.length===counts.ready)return 'Waiting for '+reviewers.join(' or ')+' to approve';
  // Every count names what it counts: "2 computers are...", never a bare "2 are...".
  const some=(n,one,many)=>n+(n===1?' computer ':' computers ')+(n===1?one:many);
  const parts=[];
  if(counts.ready)parts.push(some(counts.ready,'is ready','are ready'));
  if(counts.running)parts.push(some(counts.running,'is answering another job','are answering another job'));
  if(counts.done)parts.push(done.length===counts.done?done.join(', ')+(counts.done===1?' is':' are')+' done for today':some(counts.done,'is done for today','are done for today'));
  if(counts.outside)parts.push(some(counts.outside,'is outside lending hours','are outside lending hours'));
  if(counts.resting)parts.push(some(counts.resting,'is keeping time for itself','are keeping time for themselves'));
  if(counts.unfit)parts.push(some(counts.unfit,"doesn't lend the agent this job needs","don't lend the agent this job needs"));
  if(counts.account_unfit)parts.push(some(counts.account_unfit,'is not offering the requested model or effort','are not offering the requested model or effort'));
  if(counts.account_unknown)parts.push(some(counts.account_unknown,'checked in','checked in')+', but account availability is unconfirmed');
  if(counts.cleanup)parts.push(some(counts.cleanup,'is waiting for cleanup','are waiting for cleanup'));
  if(counts.polled)parts.push(some(counts.polled,'checked in','checked in')+', but lending status is unconfirmed');
  if(counts.offline)parts.push(absent.length===counts.offline?absent.join('; '):some(counts.offline,"hasn't checked in recently","haven't checked in recently"));
  if(counts.off) {
    const tail=spent=>spent?' (done for today)':'';
    parts.push(off.every(o=>o.name)
      ? off.map(o=>o.name+(off.length===1?" isn't":" aren't")+' lending'+tail(o.spent)).join('; ')
      : some(counts.off,"isn't lending","aren't lending")+tail(off.every(o=>o.spent)));
  }
  if(!parts.length)return 'Waiting for someone to run it · no other computers have reported availability.';
  // A poll can confirm the computer is online without confirming an account offer.
  return counts.ready||counts.running||counts.offline||counts.account_unknown||counts.polled?'Waiting for someone to run it · '+parts.join(' · ')+'. Another computer may still take this job.':
    'Nobody can take it right now · '+parts.join(' · ')+'.';
}
export function jobStatusContract(view={},viewer={}) {
  const projection=view.jobProjection?.schemaVersion===2?view.jobProjection:
    adaptLegacyJob(view,{observedAt:new Date(viewer.now??Date.now()).toISOString()});
  const lifecycle=({waiting:'waiting',approval_pending:'approval_pending',approved:'approved',starting:'starting',running:'running',
    stopping:'stop_requested',stopped:'stopped',failed:'failed',expired:'expired',result_accepted:'ready'})[projection.phase]??'unknown';
  // Read the code's result category only; this is display policy, not accounting for a run.
  const failure = classify(projection.reasonCode, 'result');
  const resultDelivery = lifecycle==='failed' && failure.borrower_key==='failure.result_delivery.borrower' && failure.outcome==='failed';
  // Display responsibility is not the accounting owner returned by classify().
  const lenderFailure = lifecycle==='failed' && (resultDelivery || failure.borrower_key==='failure.lender_stop.borrower' ||
    ['sandbox_crash','lender_failed','lender_stopped','restart_interrupted','sandbox_stop_failed','stop_report_pending'].includes(projection.reasonCode));
  const deliveryExplanation = resultDelivery
    ? (projection.reasonCode==='meter_unavailable' && projection.evidence.failurePhase==='result'
      ? 'The lender’s computer finished the work but could not send it back because its usage meter was unavailable.'
      : 'The lender’s computer could not return a usable result.') +
      ' Nothing was added to your code. You can send it again or choose another lender.' : null;
  const retryCode=passingDeclineCode(view.current_attempt);
  const harnesses=viewer.harnesses??view.job?.payload?.requirements?.harness??null;
  const wallSeconds=viewer.wallSeconds??view.job?.payload?.requirements?.limits?.wall_seconds??null;
  // A released attempt explains what happened earlier. Only a current heartbeat can report cleanup now.
  const retryExplanation=retryCode==='cleanup_pending'
    ? Array.isArray(view.presence?.devices)?null:"The last try waited for the lender's computer to clean up. The lender's current status is unavailable."
    : retryCode ? 'A computer could not start this job yet. Waiting for it to be ready to try again. Another computer may still take it.' : null;
  // A lender cannot take this job while the earlier launch is unconfirmed, regardless of pool availability.
  const launchFenceExplanation = projection.evidence.launchFenceUntil ? projection.evidence.waitingExplanation : null;
  const explanations={waiting:launchFenceExplanation??retryExplanation??waitingSummary(view.presence,{...viewer,harnesses,wallSeconds})??projection.evidence.waitingExplanation??'Waiting for someone to run it.',approval_pending:'A computer reserved the job. Approval is still pending.',
    approved:'The job is approved. The agent has not started yet.',starting:'A computer picked up the job. The agent has not started yet.',
    running:projection.evidence.sharedStopRequestUnavailable===true
      ?'An agent is working on this job. A stop request may be pending; Faravan could not check.'
      :'An agent is working on this job.',ready:projection.evidence.sharedStopRequestedAt
      ?'The person lending stopped this job early. This is the work done until then.'
      :'The result is ready to review.',
    stop_requested:'Stop requested. The computer has not confirmed it stopped.',
    stopped:'The job stopped.',failed:'The job could not finish.',expired:'The deadline passed.',unknown:'Job status is unavailable. Check again.'};
  return {lifecycle,reasonCode:projection.reasonCode,explanation:deliveryExplanation??explanations[lifecycle],
    responsibleParty:lifecycle==='waiting'?'circle':lenderFailure||['approval_pending','approved','starting','running','stop_requested'].includes(lifecycle)?'lender':'you',
    observedAt:projection.times.observedAt??new Date(viewer.now??Date.now()).toISOString(),nextCheckAt:projection.times.nextTransitionAt,
    allowedActions:lifecycle==='failed'?[projection.reasonCode==='wall_timeout'?'followup':'resend']:
      projection.evidence.sharedStopRequestUnavailable===true?[]:
      ['waiting','approval_pending','approved','starting','running'].includes(lifecycle)?['cancel']:lifecycle==='ready'?['review']:[]};
}

// A fresh observation timestamp is evidence for readers, not a job transition.
export function jobEventSignature(view) {
  const presence=view.presence?.devices?{...view.presence,devices:view.presence.devices.map(device=>device.online
    ?{...device,last_poll_at:null,last_heartbeat_at:null}:device)}:view.presence;
  return JSON.stringify({...view,...(presence?{presence}:{}),
    ...(view.statusContract?{statusContract:{...view.statusContract,observedAt:null}}:{}),
    ...(view.jobProjection?.times?{jobProjection:{...view.jobProjection,times:{...view.jobProjection.times,observedAt:null}}}:{})});
}
