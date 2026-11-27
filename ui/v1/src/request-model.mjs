import {safeName, CIRCLE_MEMBER, inSentence, isOwnRequest, OWN_REQUEST_TITLE} from './helpers.mjs';
import {formatDate, formatDayTime} from './dates.mjs';
import {formatJobProjection} from './job-projection-view.mjs';
export function requestName(value, fallback = CIRCLE_MEMBER) {
  const name = safeName(value, '');
  return !name || /^(?:Someone|Unnamed device|Member \d+|sha256:|[0-9a-f]{8}-|[0-9a-f]{32,}$)/i.test(name) ? fallback : name;
}
export function requestReviewVM(card = {}, view = {}, devices = {}, contributions, {now=Date.now(),zone} = {}) {
  const own = isOwnRequest({requester:view.requesterKey || card.requester}, devices.fingerprint);
  const name = own ? 'You' : requestName(view.localName || view.personName || view.requesterName);
  const row=contributions?.windows?.[30]?.rows?.find(r=>r.keyId===(view.requesterKey||card.requester)&&r.circle===card.job?.circle);
  const count=Number.isSafeInteger(row?.run)&&row.run>0?row.run:0;
  const expires=typeof card.expiresAt==='number'?card.expiresAt:Date.parse(card.expiresAt);
  const expired=Number.isFinite(expires)&&expires<=now;
  return {own,name,expired,expiry:expired&&card.offer?'Expired at '+formatDayTime(expires,{now,zone})+'.':expired?'Back for others at '+time(expires,zone)+'.':'',heading:expired&&card.offer?'This job expired':expired?(own?'Your request went back to the circle':name+'’s request went back to the circle'):own?OWN_REQUEST_TITLE:name+' asked for help',
    history:own?'':count?'You’ve run '+count+' of '+inSentence(name)+'’s jobs in the past 30 days.':contributions?.windows?.[30]?'You haven’t run any of '+inSentence(name)+'’s jobs in the past 30 days.':'Your past jobs with '+inSentence(name)+' haven’t loaded yet.'};
}
const time = (value,zone) => {
  const at=typeof value==='number'?value:Date.parse(value);
  return Number.isFinite(at)?formatDate(at, 'clock', {zone}):'';
};
const jobLine = job => {
  const key=formatJobProjection(job).key;
  return ({working:'The job is running.',starting:'The job is starting.',approved:'The job was approved and is waiting to start.',waiting:'The job is waiting.',waiting_approval:'The job is waiting for approval.',stop_requested:'The stop is not confirmed yet.',stop_unconfirmed:'The job may still be running.',stopped:'The job was stopped.',ready:'The result is ready to review.',added_branch:'The result is ready to review.',no_changes:'The result is ready to review.',failed:'The job didn’t finish.',cancelled:'The job was cancelled.',expired:'The job expired.',unknown:'The job status is not available yet.'})[key]||'The job status is not available yet.';
};
// Approval events are correlated by this card's id or its retained digest, never by recency alone.
export function requestResolutionVM({id, digest, circle, activity = [], zone, job} = {}) {
  const events=(Array.isArray(activity)?activity:[]).filter(e=>e.type==='approval'&&
    ((e.data?.approvalId===id||e.data?.id===id)||(digest&&e.data?.jobDigest===digest)));
  const terminal=events.filter(e=>['accepted','skipped','declined','expired','review-ended','taken'].includes(e.data?.state));
  const event=terminal.reduce((a,e)=>!a||e.id>a.id?e:a,null);
  const known=events.find(e=>e.data?.jobDigest);
  const resolvedDigest=digest||known?.data?.jobDigest;
  const resolvedCircle=circle||known?.data?.job?.circle;
  const at=time(event?.data?.answeredAt??event?.data?.expiresAt??event?.at??event?.created_at,zone);
  const taken=event?.data?.state==='taken',offer=event?.data?.offer===true;
  const expired=event?.data?.state==='expired',reviewEnded=event?.data?.state==='review-ended',accepted=event?.data?.state==='accepted';
  const prefix=accepted?'You accepted this':event?.data?.state==='declined'?'You declined this request':event?.data?.state==='skipped'?'You passed on this request':'';
  const state=job ? jobLine(job) : '';
  const takenLine=requestTakenVM({taker:event?.data?.taker});
  return {digest:resolvedDigest,circle:resolvedCircle,state:event?.data?.state||'',heading:taken?'Taken by someone else':expired?'This request expired':reviewEnded?'Review window ended':accepted?'You accepted this request.':event?'This request was answered.':'This request is no longer available here.',
    line:taken?takenLine:reviewEnded?'This computer’s review window ended'+(at?' at '+at:'')+'. The job is back in the circle.'+(state?' '+state:''):expired?'This request expired'+(at?' at '+at:'')+(offer?'. Its deadline has passed; this job is no longer available to accept.':'. It went back to the circle.'):prefix?prefix+(at?' at '+at:'')+'.'+(state?' '+state:''):'We couldn’t confirm how this request ended. '+(resolvedDigest?'Open the job for its latest status.':'Look for it in Jobs.')+(state?' '+state:''),
    // This computer never ran a taken job, so there is no job page here to open.
    href:taken?'#/home':resolvedDigest?'#/job/'+encodeURIComponent(resolvedDigest)+(resolvedCircle?'/'+encodeURIComponent(resolvedCircle):''):'#/jobs',
    action:taken?'':resolvedDigest?'Open the job':'Find the job'};
}
// A claim this computer lost (judge r8 O1): another computer holds the job, so nothing ran here and Run it cannot help.
// The taker is named only from the app's own read of the job; `sender` means the requester's own computer took it.
export function requestTakenVM({taker, name = ''} = {}) {
  const who = requestName(taker?.personName, '') || (taker?.sender === true ? requestName(name, '') : '');
  const line = taker?.sender === true ? (who ? who + '’s own computer took this job.' : 'The sender’s own computer took this job.')
    : who ? who + '’s computer took this job.' : 'Another computer took this job.';
  return line + ' Nothing ran here.';
}
export function loadRequest(storage,id){try{return JSON.parse(storage?.getItem('faravan-request:'+id)??'null');}catch{return null;}}
export function saveRequest(storage,id,record){try{storage?.setItem('faravan-request:'+id,JSON.stringify(record));}catch{/* Activity still supplies the digest in this session. */}}

// Acceptance is known before execution. Only the job's recorded start and limit support a stop time.
// Acceptance pending, accepted/preparing, failed reads and dated execution snapshots are distinct.
// A dated running read hands current status to the job page; it is not a claim of ongoing execution.
export function requestStartedVM(job, {device = 'your computer', zone, accepted = false, pending = false, readFailed = false, confirmedAt} = {}) {
  if (pending) return {line:'Sending your approval…',canStop:false,terminal:false,phase:'approval_pending',transitional:true};
  if (readFailed) return {line:'We couldn’t confirm the job’s current status. Open the job to check before trying again.',canStop:false,terminal:false,phase:'unknown'};
  const awaitingStart = {line:'Your approval was received. Waiting for confirmation that the job has started.',canStop:false,terminal:false,phase:'approved',transitional:true};
  if (job === null || job === undefined) return accepted ? awaitingStart : {line:'Starting on ' + requestName(device, 'your computer') + '. Waiting for the job to confirm its start.',canStop:false,terminal:false,phase:'approved'};
  const {projection,key}=formatJobProjection(job ?? {}), evidence=projection.evidence ?? {};
  if (accepted && ['unknown','waiting','waiting_approval','approved','starting'].includes(key)) return awaitingStart;
  const terminal = {ready:'The result is ready to review.',added_branch:'The result is ready to review.',no_changes:'The result is ready to review.',failed:'The job didn’t finish.',cancelled:'The job was cancelled.',expired:'The job expired.',stopped:'The job was stopped.'}[key];
  if (terminal) return {line:terminal,canStop:false,terminal:true,phase:projection.phase};
  const started = typeof evidence.executionStartedAt === 'string' ? Date.parse(evidence.executionStartedAt) : NaN;
  const hardStop = time(evidence.hardStopAt, zone);
  if (key !== 'working' || !Number.isFinite(started)) {
    const line=key==='unknown'?'The job status is not available yet. Refresh the job to check its status.':
      key==='approved'?'Approved on your computer. Waiting for the job to start.':
      key==='waiting_approval'?'Waiting for someone to approve the job.':
      key==='stop_requested'?'The stop is not confirmed yet. The job may still be working.':
      key==='stop_unconfirmed'?'Stopping is not confirmed. The job may still be running.':
      key==='stopped'?'The job was stopped.':
      key==='starting'?'Starting on ' + requestName(device, 'your computer') + '. Waiting for the job to confirm its start.':
      key==='waiting'?'The job is waiting.':
      'Waiting for the job to confirm its start.';
    return {line,canStop:false,terminal:false,phase:projection.phase};
  }
  if (Number.isFinite(confirmedAt)) return {line:'Last confirmed running at ' + formatDayTime(confirmedAt, {zone}) + '. Started on ' + requestName(device, 'your computer') + '. Open the job for current status and stop controls.',canStop:true,terminal:false,phase:projection.phase};
  return {line:'Started on ' + requestName(device, 'your computer') + (hardStop ? ' · stops by ' + hardStop : ' · stop time not confirmed') + '.', canStop:true,terminal:false,phase:projection.phase};
}

// The page's own reading of a request: who sent it, when, and how long is left to answer. Pure, so the expiry flip
// and the own-job wording are tested without a browser. `now` comes from a one-second clock, never from a server event.
const ago = (at, now, zone) => {
  const ms = Math.max(0, now - at), minutes = Math.floor(ms / 60000), hours = Math.floor(minutes / 60);
  return ms < 60000 ? 'just now' : minutes < 60 ? minutes + ' min ago' : hours < 24 ? hours + (hours === 1 ? ' hour ago' : ' hours ago') : 'at ' + time(at, zone);
};
export function requestHeaderVM({own = false, name = '', device = '', circle = '', sentAt, now = Date.now(), zone} = {}) {
  const sent = typeof sentAt === 'number' ? sentAt : Date.parse(sentAt);
  const where = safeName(device, '') && !/^(?:Unnamed device|sha256:)/i.test(device) ? device : 'your computer';
  const sub = [safeName(circle, ''), Number.isFinite(sent) ? 'sent ' + ago(sent, now, zone) : ''].filter(Boolean).join(' · ');
  return {title: own ? OWN_REQUEST_TITLE : requestName(name) + ' wants to run a job on your computer' + (where === 'your computer' ? '' : ' (' + where + ')'), sub};
}
export function requestDeadlineVM({offer=false,legacyHold=false,expiresAt, now = Date.now(), zone} = {}) {
  const at = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return {state: 'unknown', countdown: 'We can’t confirm the deadline. Refresh this page before approving.', exact: ''};
  const exact = offer ? formatDayTime(at, {now, zone}) : time(at, zone);
  if(offer)return now>=at?{state:'expired',exact,line:'This job expired at '+exact+'.'}:{state:'open',exact,countdown:'Open until '+exact,title:'The borrower’s deadline',urgent:false};
  if(legacyHold&&now>=at)return {state:'review-ended',exact,line:'This computer’s review window ended at '+exact+'. The job is back in the circle.'};
  if (now >= at) return {state: 'expired', exact, line: 'This request expired at ' + exact + '. It went back to the circle.'};
  const seconds = Math.ceil((at - now) / 1000);
  return {state: 'open', exact, seconds, urgent: seconds <= 60,
    countdown: (legacyHold?'Review window closes in ':'Answer within ') + (seconds >= 5400 ? Math.round(seconds / 3600) + ' h' : seconds >= 60 ? Math.ceil(seconds / 60) + ' min' : seconds + ' s'), title: legacyHold?'This computer’s review window':'Answer by ' + exact};
}
export function requestDeclinedVM({offer=false,own = false, name = ''} = {}) {
  if(offer)return 'You declined this request. It won’t return on this computer. Others can still run it.';
  const who = requestName(name);
  return own ? 'You declined your job here. It went back to the circle.' : 'You declined ' + (who === 'A circle member' ? 'a circle member' : who) + '’s request. It went back to the circle.';
}
