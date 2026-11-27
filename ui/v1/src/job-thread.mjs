import {problemResult} from './problem-catalog.mjs';
import {formatDate,dateParts} from './dates.mjs';
import {JOB_STATES} from './view-models.mjs';
import {formatJobProjection} from './job-projection-view.mjs';
import {loadDraft, newDraftId, saveDraft} from './compose-draft.mjs';

// The copied summary may be pasted into any session, so it carries the same allow-listed fields as an onward
// follow-up (lib/v1/continuation.mjs continuationPrompt): the borrower's own instructions and the sandbox's
// observed checks. Agent-written prose stays on this page only.
export function handoffText(handoff) {
  if (!handoff || typeof handoff !== 'object') return '';
  return JSON.stringify({schema: 'faravan.continuation.v1', mode: 'summary', trust: 'untrusted',
    objective: handoff.objective ?? '', latest_instruction: handoff.latest_instruction ?? '',
    observed_checks: (handoff.observed_checks ?? []).map(({cmd, exit, timed_out}) => ({cmd, exit, timed_out, observed_by: 'sandbox'})),
    scan: {status: handoff.scan?.status === 'passed' ? 'passed' : 'withheld', policy: 'credential-rules-v1'}}, null, 2);
}

const timeValue = value => {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
};
function threadTime(value,now,zone) {
  const at=Date.parse(value??'');
  if(!Number.isFinite(at))return 'Time unavailable';
  const calendarDay=ms=>{
    const parts=dateParts(ms,'dayKey',{zone});
    return Date.UTC(+parts.year,+parts.month-1,+parts.day)/86400000;
  };
  const day=calendarDay(at),today=calendarDay(now);
  const clock=formatDate(at,'clock',{zone});
  if(day===today)return clock;
  if(day===today-1)return 'Yesterday '+clock;
  return formatDate(at,'monthDay',{zone})+', '+clock;
}
// The current attempt is worded by the authoritative job projection: its phase and stop evidence, not the raw job state.
const currentRunDetail = job => (JOB_STATES[formatJobProjection(job).key] || JOB_STATES.unknown).word;
// An older attempt is judged by its own evidence. A cancel after work started, with no confirmed stop, may still be computing.
const olderRunDetail = run => {
  const state=run.state || run.status || '';
  if (run.result_digest || run.resultDigest) return JOB_STATES.ready.word;
  if (state === 'cancelled' && run.compute_stopped === true) return JOB_STATES.stopped.word;
  if (state === 'cancelled' && run.execution_started_at) return JOB_STATES.stop_unconfirmed.word;
  const key=({queued:'waiting',claimed:run.execution_started_at?'working':'starting',active:run.execution_started_at?'working':'starting',running:'working',completed:'ready','result-accepted':'ready',done:'ready',released:'uncertain'})[state] || state;
  const word=(JOB_STATES[key] || JOB_STATES.unknown).word;
  return ['waiting','starting','working','active','running','claimed','queued'].includes(key)
    ? 'Last reported '+word.toLowerCase()+' — current activity unconfirmed' : word;
};
export function followupBaseVM(base={}) {
  return {label:'Continues: '+(base.title || 'Earlier job'),
    commit:/^[0-9a-f]{40,64}$/.test(base.commit??'')?base.commit.slice(0,7):''};
}
const checkDetail = check => {
  if (!check || typeof check !== 'object') return String(check ?? '');
  const command = typeof check.cmd === 'string' ? check.cmd : 'Check';
  const outcome = Number.isInteger(check.exit) ? `exit ${check.exit}` : check.timed_out ? 'timed out' : 'outcome unavailable';
  return `${command} · ${outcome}`;
};
export const handoffChecks = checks => Array.isArray(checks) ? checks.map(checkDetail).filter(Boolean) : [];

// The current job's current attempt is one of its runs. A recorded snapshot of that attempt can be stale, so the projection
// words it; merge the current attempt into lagging recorded history by its stable ID.
function runRows(item, currentJob) {
  const current = currentJob && item.job_digest === currentJob.job_digest ? currentJob : null;
  const attempt = current?.current_attempt || null;
  const recorded = Array.isArray(item.runs) && item.runs.length ? item.runs : null;
  const isCurrent = run => attempt !== null && (run === attempt || typeof run.attempt_id === 'string' && run.attempt_id.length > 0 && run.attempt_id === attempt.attempt_id);
  const runs = recorded ? recorded.slice() : attempt ? [attempt] : [];
  if (recorded && typeof attempt?.attempt_id === 'string' && attempt.attempt_id) {
    const index = runs.findIndex(run => run.attempt_id === attempt.attempt_id);
    if (index < 0) runs.push(attempt);
    else runs[index] = {...runs[index], ...attempt};
  }
  return runs.sort((a,b)=>(b.generation??0)-(a.generation??0)).map((run,index) => ({
    label:'Run ' + (Number.isInteger(run.generation) && run.generation>0 ? run.generation : index + 1),
    detail:isCurrent(run) ? currentRunDetail(current) : olderRunDetail(run),
  }));
}

export function threadRows(thread = [], circleId = '', currentJob = null, {now=Date.now(),zone=Intl.DateTimeFormat().resolvedOptions().timeZone} = {}) {
  const entries=[...thread].filter(item => item && typeof item.job_digest === 'string');
  if (currentJob?.job_digest && !entries.some(item => item.job_digest === currentJob.job_digest)) entries.push(currentJob);
  return entries
    .sort((a,b) => timeValue(b.submittedAt ?? b.local?.submittedAt) - timeValue(a.submittedAt ?? a.local?.submittedAt))
    .map(item => ({
      id:item.job_digest,
      current:item.job_digest===currentJob?.job_digest,
      href:'#/job/' + encodeURIComponent(item.job_digest) + '/' + encodeURIComponent(circleId),
      title:typeof item.title === 'string' && item.title.trim() ? item.title : typeof item.local?.title === 'string' && item.local.title.trim() ? item.local.title : 'Untitled job',
      submittedAt:threadTime(item.submittedAt ?? item.local?.submittedAt,now,zone),
      parentJob:item.parentJob || item.local?.parentJob || '',
      runs:runRows(item,currentJob),
    }));
}

export function prepareFollowupDraft(storage, circleId, continuation, {replaceDraft} = {}) {
  const current = loadDraft(storage,circleId);
  if (current.sending || current.uncertainSince) return problemResult('followup_pending');
  const base = continuation?.base;
  if (!continuation?.parentJob || !continuation?.parentResult || !base)
    return problemResult('followup_missing');

  const snapshot = JSON.stringify(current);
  if (String(current.prompt || '').trim() && replaceDraft !== snapshot)
    return {ok:false, conflict:true, draftSnapshot:snapshot, error:'You have an unsent draft. Keep it or replace it with this follow-up?'};
  const parent = continuation.thread?.find(item=>item.job_digest===continuation.parentJob);
  const title = parent?.title || parent?.local?.title || continuation.handoff?.latest_instruction || continuation.handoff?.objective;
  const draft = {
    ...current,
    id:newDraftId(),
    prompt:'',
    sourceKind:continuation.sourceKind==='none'?'none':'folder',
    path:continuation.sourceKind==='none'?'':base.path || '',
    includeUncommitted:false,
    verifyCmd:'',
    verifyEdited:false,
    sending:false,
    uncertainSince:null,
    sendAnyway:false,
    agentRefusal:null,
    followup:{parentJob:continuation.parentJob,parentResult:continuation.parentResult},
    base:{path:base.path || '',branch:base.branch || '',commit:base.commit || '',...(title?{title:String(title).trim().split('\n')[0].slice(0,200)}:{})},
  };
  try { saveDraft(storage,circleId,draft); } catch { return problemResult('followup_storage'); }
  try { storage?.setItem('faravan-compose-circle', circleId); } catch { /* draft remains scoped to its circle */ }
  const stored=loadDraft(storage,circleId);
  return stored.id === draft.id && stored.followup?.parentJob === draft.followup.parentJob
    ? {ok:true,draft}
    : problemResult('followup_storage');
}
