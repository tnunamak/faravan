import {displayVisible} from './display-visibility.mjs';
import {readState} from '../../../lib/v1/problem.mjs';
import {problemView,readStateView,browserProblemContext} from './problem-catalog.mjs';
import {ResultProperties} from './result-properties.jsx';
import {ImagePreview} from './image-preview.jsx';
import {ResultReader, Markdown, copyOutputMessage,downloadOutput} from './result-reader.jsx';
import {
  useResource,
  ProblemNotice,
  enc,
  circleName,
  Action,
  Connection,
  field,
  KEEP_CONFIRM_OPEN,
  OFFLINE_REASON,
} from './shared.jsx';
import {
  jobsListPath,
  jobsEmptyState,
  errorMessage,
  jobFacts,
  changeSummary,
  safeName,
  localNameOf,
  circleMembers,
} from './helpers.mjs';
import { useState, useRef, useEffect, useContext } from 'preact/hooks';
import { Avatar, Button, Card, Empty, Icon } from './ds/index.mjs';
import { plainFolderResultCaption, jobsListVM, JOBS_EMPTY, JOB_STATES, jobStatusVM, howItRanVM, whenLabel, waitingCopyVM, jobContextVM, jobOutputWarningVM, jobDetailVM, jobHeadingVM, agentSummaryVM, createdJobVM, jobRoleVM, jobVM, jobRetentionVM, jobStateKey, jobPeopleVM, hostOfflineBanner } from './view-models.mjs';
import {formatJobProjection} from './job-projection-view.mjs';
import { JobHead, TabTitle, JobStatusCard, HowItRan, CheckLines, AskedCard, AppliedCard } from './job-view.jsx';
import { saveDraft, loadDraft, newDraftFromJob } from './compose-draft.mjs';
import { ApplySheet } from './apply-sheet.jsx';
import { AgentActivity } from './transcript-feed.jsx';
import { agentUpdateFresh, liveFreshness, statusLastOutputAt, transcriptFeedVM } from './transcript-feed.mjs';
import {JobTimeline} from './job-timeline.jsx';
import {agentQuestionVM} from './agent-question.mjs';
import {AgentQuestion} from './agent-question.jsx';
import {saveFollowupRequest} from './result-followup.mjs';
import {ParentJobLink} from './job-parent.jsx';
import {resendResultDraft, RESELECT_FILES_LINE, SOURCE_UNKNOWN_LINE} from './resend-result.mjs';
import {ResultActions} from './result-actions.jsx';
import {ResultWorkspace} from './result-workspace.jsx';
import {knownJobReceipt, loadJobReceipt} from './job-receipts.mjs';
import {JobThread} from './job-thread.jsx';
import {prepareFollowupDraft} from './job-thread.mjs';
import {activityFreshness} from './activity-freshness.mjs';
import {isJobDeleted, markJobDeleted, appliedFrom} from './job-local-outcome.mjs';
import {savedCopyNote} from './saved-copy.mjs';
import {cancelledJobProjection, confirmedAppliedJob, jobProjectionFor, jobPageRecord} from './job-projection-view.mjs';


export async function saveBorrowerOutcome(api, base, circle, verdict) {
  const response = await api.post(base + '/outcome', {circle, outcome: verdict === null ? null : {verdict}});
  return response.borrowerOutcome;
}
// Retain a server acknowledgement until polling observes it; old reads cannot undo a save or clear.
export function createBorrowerVerdictSession() {
  let current;
  return {
    target(api, base, circle) {
      if (!current || current.api !== api || current.base !== base || current.circle !== circle)
        current = {api, base, circle, pending:false, acknowledgement:null};
      return current;
    },
    active: target => current === target,
    invalidate(target) { if (current === target) current = null; },
    read(target, outcome) {
      if (target.acknowledgement && (target.acknowledgement.outcome?.verdict ?? null) === (outcome?.verdict ?? null))
        target.acknowledgement = null;
      return target.acknowledgement ? target.acknowledgement.outcome : outcome;
    },
    async save(target, verdict) {
      if (current !== target || target.pending) return false;
      target.pending = true;
      try {
        const outcome = await saveBorrowerOutcome(target.api, target.base, target.circle, verdict);
        if (current !== target) return false;
        target.acknowledgement = {outcome};
        return true;
      } finally { target.pending = false; }
    },
  };
}
export function BorrowerVerdictNotice({busy, offline}) {
  return busy || offline ? <p class="t-xs t-2 ph-no-capture" role="status" data-telemetry-private="jobs">{busy ? 'Saving…' : 'Reconnect to choose or clear your choice.'}</p> : null;
}
export function BorrowerVerdict({api, base, circle, outcome, onChanged}) {
  const connection = useContext(Connection);
  const session = useRef(null);
  if (!session.current) session.current = createBorrowerVerdictSession();
  const target = session.current.target(api, base, circle);
  const [, redraw] = useState(0), [failure, setFailure] = useState(null);
  useEffect(() => () => session.current.invalidate(target), [target]);
  const saved = session.current.read(target, outcome), busy = target.pending;
  const error = failure?.target === target ? failure.message : '';
  const choices = [['used', 'Used it'], ['needs-more-work', 'Needs more work'], ['unused', 'Didn’t use it']];
  const selected = choices.find(([value]) => value === saved?.verdict);
  async function choose(verdict) {
    if (target.pending || connection.offline) return;
    setFailure(null);
    const saving = session.current.save(target, verdict);
    redraw(value => value + 1);
    try { if (await saving) onChanged?.(); }
    catch (error) { if (session.current.active(target)) setFailure({target, message:errorMessage(error)}); }
    finally { if (session.current.active(target)) redraw(value => value + 1); }
  }
  return <section class="result-rail-section stack-2 ph-no-capture" aria-label="Did this result help?" data-telemetry-private="jobs">
    <h2 class="t-title3">Did this help?</h2>
    <p class="t-xs t-2" role="status">{selected ? 'Saved: ' + selected[1] + '. Choose another to change it.' : 'No choice saved yet.'}</p>
    <div class="hstack-2 wrap">{choices.map(([value, label]) => <Button key={value} kind="secondary" size="sm" aria-pressed={saved?.verdict === value} disabled={busy || connection.offline} disabledReason={connection.offline ? OFFLINE_REASON : 'Saving your choice…'} onClick={() => choose(value)}>{label}</Button>)}</div>
    {selected && <Button kind="quiet" size="sm" disabled={busy || connection.offline} disabledReason={connection.offline ? OFFLINE_REASON : 'Saving your choice…'} onClick={() => choose(null)}>Clear choice</Button>}
    <BorrowerVerdictNotice busy={busy} offline={connection.offline} />
    {error && <p class="form-error" role="alert">{error}</p>}
  </section>;
}

/** Result availability is independent of auxiliary activity history. */
export const resultDataPending = (page, changes) => Boolean(page.ready && !changes.data);
export function ResultHistoryStatus({transcript, onRetry}) {
  if (transcript.data && transcript.data.live !== true && !transcript.error && !transcript.data.unavailable) return null;
  const unavailable = Boolean(transcript.error || transcript.data?.unavailable);
  return <section class="stack-2 ph-no-capture" role="status" data-telemetry-private="jobs"><p>{unavailable ? 'The result is ready, but its activity history couldn’t be loaded.' : 'The result is ready. The activity history is still loading.'}</p><Button kind="secondary" onClick={onRetry}>Check activity again</Button></section>;
}
export function resendJobDialog({storage, jobCircle, job, prompt, sourceFolder, navigate}) {
  return {title:'Send another request?', confirmLabel:'Prepare a new request', cancelLabel:'Keep this result',
    children:<><p data-telemetry-private="jobs" class="ph-no-capture">Anything the earlier job did outside your code may have happened already: messages, uploads, deployments or other changes. A second run can repeat those effects.</p><p data-telemetry-private="jobs" class="ph-no-capture">Check the source and request before sending. The new job starts from the source you choose and needs fresh acceptance.</p>{(draft=>draft.sourceKind==='files'?<p data-telemetry-private="jobs" class="ph-no-capture">{RESELECT_FILES_LINE}</p>:draft.sourceUnknown?<p data-telemetry-private="jobs" class="ph-no-capture">{SOURCE_UNKNOWN_LINE}</p>:null)(newDraftFromJob(job,{path:sourceFolder}))}</>,
    onConfirm:() => {
      // Inspect again at confirmation: another tab may have saved work since this dialog opened.
      const raw = storage.getItem('faravan-compose-draft:' + jobCircle);
      const current = loadDraft(storage,jobCircle);
      if (raw) {
        let saved;
        try { saved = JSON.parse(raw); } catch { throw new Error('Your saved request could not be read. Open it before preparing another request.'); }
        if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !/^[A-Za-z0-9-]{8,64}$/.test(saved.id || '') ||
            current.sending || current.uncertainSince != null || current.agentRefusal ||
            ['prompt','path','workingDirectory','gitUrl','gitCommit','verifyCmd','attachmentId'].some(key => Boolean(current[key])) ||
            current.files?.length || current.zip || current.followup)
          throw new Error('This circle already has a saved or pending request. Send or clear it in the composer before preparing another request. Your request has not been replaced.');
      }
      const next = resendResultDraft({current,job,prompt,sourceFolder});
      if (!saveDraft(storage,jobCircle,next)) throw new Error('This browser couldn’t save the new request. Keep this page open and try again.');
      storage.setItem('faravan-compose-circle',jobCircle);
      if (storage.getItem('faravan-compose-circle') !== jobCircle) throw new Error('The new request was saved, but this browser couldn’t select its circle. Open the composer and choose this circle before sending.');
      navigate();
    }};
}

export function createdJobPageSeed({seed, navigationType, id, circle}) {
  if (navigationType !== 'navigate') return null;
  return createdJobVM(seed, id, circle);
}

export function clearCreatedJobPageSeed(historyState, id) {
  if (historyState?.state?.createdJob?.job_digest !== id) return false;
  const {createdJob, ...state} = historyState.state;
  historyState.replaceState(state, '');
  return true;
}

export function jobLastOutputAt(transcript, feed) {
  return transcript?.live === true ? feed?.lastAt ?? null : null;
}

export {jobPageRecord} from './job-projection-view.mjs';

function pageNavigationType() {
  try { return performance.getEntriesByType('navigation')[0]?.type ?? 'reload'; }
  catch { return 'reload'; }
}

// A waiting job says where it was sent, who takes it and when it expires (EXPERIENCE M7), never a start time.
export function WaitingJob({job, circleLabel, lender, now = Date.now()}) {
  const wording = waitingCopyVM(job, {circle:circleLabel,lender,zone:Intl.DateTimeFormat().resolvedOptions().timeZone,now});
  return <>{wording.previousDecision && <p class="t-sm t-2 ph-no-capture" data-telemetry-private="jobs">{wording.previousDecision}</p>}<p data-telemetry-private="jobs" class="ph-no-capture"><b>{wording.headline}</b></p>{wording.timing && <p class="t-sm t-2 ph-no-capture" data-telemetry-private="jobs">{wording.timing}</p>}{wording.text && <p class="t-sm t-2 ph-no-capture" data-telemetry-private="jobs">{wording.text}</p>}</>;
}

function useDecisionClock(interval = 30000, enabled = true) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if(!enabled)return;
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval,enabled]);
  return now;
}

function LiveJobStatus({job,context,person,personName,waiting,activity,progress,lastOutputAt,stale:resourceStale=false}) {
  const now=useDecisionClock(1000,!jobDetailVM(job).terminal);
  // Never an empty "Last known:" (judge r10 R1): the headline, else the job's status word, else no line at all.
  if(resourceStale){const known=jobStatusVM(job,{...context,now}).headline||jobVM(job).word;
    return <Card class="ph-no-capture" pad data-telemetry-private="jobs"><p class="t-sm t-2">Job status is updating.</p>{known&&<p class="t-sm t-2">Last known: {known}</p>}</Card>;}
  return <>{job.budgetWarning && <p class="banner warn ph-no-capture" role="status" data-telemetry-private="jobs">{job.budgetWarning}</p>}<JobStatusCard vm={jobStatusVM(job,{...context,now,activity,progress,lastOutputAt})} {...{person,personName}} waiting={waiting(now)} /></>;
}
function LiveAgentActivity(props) {
  const now=useDecisionClock(1000,props.live);
  const status=props.job?jobStatusVM(props.job,{...props.context,now}):null;
  const freshness=activityFreshness({stale:props.stale,headline:status?.headline??props.headline});
  // A present-execution claim needs a timestamped agent update inside the window. A stale page keeps only its labelled last-known line.
  // The observed start and time limit are not claims, so they show whenever the page is fresh.
  const claimed=freshness.stale||agentUpdateFresh(props.feed,now);
  return <div class={(freshness.stale?'data-stale':'') + ' ph-no-capture'} data-telemetry-private="jobs"><AgentActivity key={props.live?'live':'history'} {...props} viewer={props.context?.role} headline={claimed?freshness.headline:''} facts={freshness.stale?[]:(status?.facts??props.facts)} now={now} /></div>;
}

function JobListRow({row}) {
  return <a class="row ph-no-capture" href={row.attention?.href ?? row.href} data-telemetry-private="jobs">
    <div class="row-main job-row-title">
      <span class="job-kind"><Icon name={row.glyph} size="sm" /></span>
      <div class="job-title-text"><span class="row-title" title={row.title}>{row.title}</span>{row.circle && <span class="job-circle" title={row.circle}>{row.circle}</span>}
        {row.sentByAgent && <span class="t-xs">Sent by an agent</span>}
        {row.attention && <span class="t-xs">{row.attention.label}</span>}
        <div class="row-meta phone-only dots"><span class={'st ' + row.kind} title={row.statusTitle}>{row.word}</span><span>{row.agent || '—'}</span><span>{row.when}</span>{row.circle && <span>{row.circle}</span>}</div>
      </div>
    </div>
    <span class="jcol job-status t-sm" title={row.statusTitle ?? row.word}><span class={'st ' + row.kind}>{row.word}</span>{row.lastKnown && <span class="t-xs"> · Open for details</span>}</span>
    <span class="jcol t-sm t-2" title={row.agent}>{row.agent || '—'}</span>
    <span class="jcol t-sm t-2" title={row.when}>{row.when}</span>
    <Icon name="chev-r" size="sm" />
  </a>;
}

export function JobsList({ vm, onFilter, query = '', onSearch }) {
  return <div class="jobs-list ph-no-capture" data-telemetry-private="jobs">
    <div class="jobs-filter-wrap"><div class="filters" role="group" aria-label="Show">
      {vm.filters.map(f => <button key={f.id} type="button" class={'chip' + (f.on ? ' on' : '')} aria-pressed={f.on ? 'true' : 'false'} onClick={() => onFilter(f.id)}>{f.label} <span class="job-count">{f.count}</span></button>)}
    </div></div>
    <div class="jobs-tools"><label class="jobs-search"><Icon name="search" size="sm" /><input class="input" type="search" aria-label="Search jobs" placeholder="Search jobs" value={query} onInput={e => onSearch?.(field(e))} /></label><span class="t-xs t-2 desk-only">J/K to move · Enter to open</span></div>
    {vm.count === 0 && <div role="status"><p class="t-2">{readStateView({kind:'filtered-empty'}).text}</p><Button onClick={()=>{onFilter?.('all');onSearch?.('');}}>{readStateView({kind:'filtered-empty'}).action}</Button></div>}
    {vm.count > 0 && <div class="jobs-columns t-xs t-2" aria-hidden="true"><span>Job</span><span>Status</span><span>Agent</span><span>Updated</span><span /></div>}
    {vm.groups.map(group => <section key={group.title} aria-label={group.title}>
      <h2 class="grp">{group.title}</h2>
      <ul class="list card compact jlist">{group.items.map(row => <li key={row.id + (row.circleId || '')}>
        {row.batch ? <details class="jobs-batch"><summary><span class="job-kind"><Icon name="stack" size="sm" /></span><span class="job-batch-title">{row.label}</span><Icon name="chev-r" size="sm" /></summary><ul class="list">{row.rows.map(child => <li key={child.id + child.circleId}><JobListRow row={child} /></li>)}</ul></details> : <JobListRow row={row} />}
      </li>)}</ul>
    </section>)}
  </div>;
}

// Keep successful rows across route unmounts; each API instance owns its own session cache.
const jobsCache = new WeakMap();
const deletionNoticeKey = 'faravan-job-deleted';
function takeDeletionNotice() {
  try { const text = sessionStorage.getItem(deletionNoticeKey) || ''; sessionStorage.removeItem(deletionNoticeKey); return text; } catch { return ''; }
}

function jobCircleId(job) {
  return job.circle?.id ?? job.circle;
}

export function circlesWithCurrentWork(selected, lending, jobs = []) {
  const ids = new Set();
  if (selected) ids.add(selected);
  if (lending?.enabled && lending.circle) ids.add(lending.circle);
  for (const job of jobs) {
    const key = jobStateKey(job);
    const id = jobCircleId(job);
    if (id && !JOB_STATES[key].terminal && key !== 'ready' && key !== 'pr_open') ids.add(id);
  }
  return ids;
}

export function uncheckedCirclesInUse(uncheckedCircles = [], inUse) {
  return uncheckedCircles.filter(entry => inUse.has(typeof entry === 'string' ? entry : entry.id));
}

export function JobHistoryNotice({uncheckedCircles, circles, onRetry}) {
  if (!uncheckedCircles?.length) return null;
  const reasons = {
    unreachable: 'The host couldn’t be reached. Ask the host to check that Faravan is running.',
    busy: 'The host is taking longer than usual. Check again in a moment.',
    access: 'The host refused this request. Check your circle membership.',
    missing: 'The host couldn’t find this circle. Open the circle to check its status.',
    partial: 'The host couldn’t be reached. Only jobs that member computers confirmed are shown.',
  };
  return <div role="status" class="t-sm t-2 ph-no-capture" data-telemetry-private="jobs">
    {uncheckedCircles.map(entry => {
      const {id, reason} = typeof entry === 'string' ? {id: entry} : entry;
      const circle = circles.find(item => item.id === id);
      return <p key={id}>Couldn’t check jobs in {circle ? <a href={'#/circle/' + enc(id)}>{circle.name}</a> : 'a circle'}.
        {' '}{reasons[reason]}</p>;
    })}
    <Button kind="quiet" onClick={onRetry}>Check jobs again</Button>
  </div>;
}

// The jobs this computer sent or ran, newest first, grouped by the computer's calendar.
export function Jobs({ api, circles, selected, lending, revision, data, errors={}, devices = data?.devices, onHasRows, refresh, refreshRunJobs }) {
  const connection=useContext(Connection);
  const [deletionNotice] = useState(takeDeletionNotice);
  const confirmation = deletionNotice && <div class="banner on jobs-notice ph-no-capture" role="status" data-telemetry-private="jobs"><Icon name="check-circle" size="sm" /><span class="grow">{deletionNotice}</span></div>;
  useEffect(()=>{if(data)void refresh?.('jobs');},[api,refresh]);
  const now = useDecisionClock();
  const path = jobsListPath(circles), local = useResource(api, data?null:path, revision);
  // The shell already owns this endpoint; rendering its snapshot avoids a
  // second request stream for the same list while the Jobs page is open.
  const state=data?{data:data.jobs,error:errors.jobs}:local;
  if (!jobsCache.has(api)) jobsCache.set(api, new Map());
  const cache = jobsCache.get(api);
  if (Array.isArray(state.data)) cache.set(path,state.data);
  const saved = (Array.isArray(state.data) ? state.data : cache.get(path))?.filter(job => !isJobDeleted(api, job.job_digest));
  const [filter, setFilter] = useState('all'), [query, setQuery] = useState('');
  const resultSummaries = new Map((data?.jobs ?? []).filter(job => job.resultSummary)
    .map(job => [job.job_digest + '/' + job.circle?.id, job.resultSummary]));
  const jobs = (saved ?? []).map(job => {
    const summary = resultSummaries.get(job.job_digest + '/' + job.circle?.id);
    return summary && jobStateKey(job) === 'ready' ? {...job, resultSummary:summary} : job;
  });
  const [, receivedMetadata] = useState(0);
  const receiptLoad = useRef(Promise.resolve());
  const receipts = useRef({api,values:new Map()});
  if (receipts.current.api !== api) receipts.current = {api,values:new Map()};
  const retained = receipts.current.values;
  const receiptKey = job => JSON.stringify([job.circle?.id,job.job_digest,job.result_digest ?? null]);
  const currentReceiptKeys = new Set(jobs.map(receiptKey));
  for (const key of retained.keys()) if (!currentReceiptKeys.has(key)) retained.delete(key);
  const withReceipt = job => {
    const key = receiptKey(job), known = knownJobReceipt(api,job);
    if (known) retained.set(key,known);
    return {...retained.get(key),...job};
  };
  const displayedJobs = jobs.map(withReceipt);
  const resultJobs = jobs.filter(job =>
    job.circle?.id && ['ready','added_branch','no_changes'].includes(jobVM(job).key));
  // Receipt renders must not cancel a batch or restart failed/incomplete reads.
  const resultKeys = JSON.stringify(resultJobs.map(job => [job.circle.id,job.job_digest,job.result_digest]));
  useEffect(() => {
    let active = true;
    async function load() {
      if (!active) return;
      // Merge cached details before selecting work, including receipts from a prior pass.
      const pending = resultJobs.filter(job => {
        const identity = jobVM(withReceipt(job));
        return identity.resultPending || identity.agent === 'Agent not recorded';
      });
      for (let offset = 0; active && offset < pending.length; offset += 20) {
        const batch = pending.slice(offset,offset + 20);
        let next = 0;
        async function worker() {
          while (active && next < batch.length) {
            const job = batch[next++];
            try {
              const receipt = await loadJobReceipt(api,job);
              if (active) {
                retained.set(receiptKey(job),receipt);
                receivedMetadata(value => value + 1);
              }
            } catch {}
          }
        }
        // Drain this bounded batch before starting another. An unknown/error
        // receipt gets only one attempt per pass; revision can explicitly retry.
        await Promise.all(Array.from({length:Math.min(4,batch.length)},worker));
      }
    }
    // A new list/revision waits for the cancelled pass's in-flight reads, too.
    receiptLoad.current = receiptLoad.current.then(load,load);
    return () => { active = false; };
  },[api,resultKeys,revision]);
  const listState = readState({data:saved,error:state.error});
  const listView = readStateView(listState);
  const empty = jobsEmptyState(circles.some((c) => c.origin) ? undefined : selected, state.error),
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    vm = jobsListVM(displayedJobs, {
      filter, query, now, zone, devices, owner: devices?.ownerName ?? '', machine: devices?.name ?? '',
      jobApprovals: data?.approvals ?? [],
    });
  useEffect(() => {
    onHasRows?.(jobs.length > 0);
    return () => onHasRows?.(false);
  }, [jobs.length]);
  useEffect(() => {
    // J and K move between rows; Enter opens the focused row, as a link does.
    const keys = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey || !['j', 'k'].includes(event.key)) return;
      if (/^(input|textarea|select)$/i.test(event.target?.tagName || '') || event.target?.isContentEditable) return;
      const rows = [...document.querySelectorAll('.jlist a.row, .jobs-batch > summary')].filter(row => row.getClientRects().length > 0 && (row.tagName === 'SUMMARY' || !row.closest('details:not([open])')));
      if (!rows.length) return;
      const at = rows.indexOf(document.activeElement);
      rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'j' ? 1 : -1)))]?.focus();
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, []);
  if (empty)
    return <>{confirmation}<Card data-telemetry-private="jobs" class="ph-no-capture"><Empty icon="jobs" title="Run your first job" text={empty.message} action={<Button kind="primary" href={'#/' + empty.page}>{empty.action}</Button>} /></Card></>;
  if (state.error && !saved)
    return <>{confirmation}<Card data-telemetry-private="jobs" class="ph-no-capture"><Empty icon="alert" title="Jobs didn’t load" text={connection.stale?undefined:errorMessage(state.error)} action={state.reload && <Button kind="secondary" onClick={() => state.reload()}>Try again</Button>} /></Card></>;
  if (!saved)
    return (
      <>{confirmation}<div class="stack-3 ph-no-capture" role="status" aria-label="Loading jobs" data-telemetry-private="jobs">
        {[0, 1, 2].map((n) => <div key={n} class="card jobs-skeleton"><div class="skel" /><div class="skel" /><div class="skel" /></div>)}
      </div></>
    );
  const inUse = circlesWithCurrentWork(selected?.id, lending ?? data?.home?.lending, jobs);
  const unchecked = uncheckedCirclesInUse(data?.uncheckedJobCircles, inUse);
  const missed = !state.error && unchecked.length > 0;
  const coverageNotice = missed && <JobHistoryNotice uncheckedCircles={unchecked} circles={circles}
    onRetry={refreshRunJobs ?? (() => refresh?.('jobs'))} />;
  if (!jobs.length && missed) return <>{confirmation}{coverageNotice}</>;
  if (!jobs.length && listState.kind==='stale-with-data') return <Card data-telemetry-private="jobs" class="ph-no-capture"><Empty icon="alert" title={listView.title} text={connection.stale?undefined:listView.text} /></Card>;
  if (!jobs.length)
    return (
      <>{confirmation}<Card data-telemetry-private="jobs" class="ph-no-capture">
        <Empty icon="jobs" title={JOBS_EMPTY.title} text={JOBS_EMPTY.text}
          action={<Button kind="primary" href="#/new"><Icon name="plus" />{JOBS_EMPTY.action}</Button>} />
      </Card></>
    );
  const savedNote = savedCopyNote(saved.filter(job => inUse.has(jobCircleId(job))), circles, {now, zone});
  return <>{confirmation}{coverageNotice}{savedNote ? <p role="status" class="t-sm t-2 saved-copy ph-no-capture" data-telemetry-private="jobs">{savedNote} <Button kind="quiet" onClick={() => refresh ? refresh('jobs') : local.reload()}>Check again</Button> <a href="#/circles">Open circle →</a></p> : state.error && !connection.stale && <p role="alert" class="t-sm t-2 ph-no-capture" data-telemetry-private="jobs">{listView?.text}</p>}<JobsList vm={vm} onFilter={setFilter} query={query} onSearch={setQuery} /></>;
}

export function JobSummaryStatus({transcript,onRetry}) {
  if (transcript.error && !transcript.data) return <ProblemNotice error={transcript.error} onRead={onRetry}/>;
  return <p class="t-sm t-2 ph-no-capture" role="status" data-telemetry-private="jobs">{transcript.data ? 'No final message was recorded for this job.' : 'Loading the agent’s summary…'}</p>;
}

export function ChangesView({data, outputWarning = '', api, circle, resultDigest, onAskChanges}) {
  return <ResultWorkspace showDetails={false} key={(circle||'')+':'+(resultDigest||'')} data={data} outputWarning={outputWarning} circle={circle} resultDigest={resultDigest} onAskChanges={onAskChanges} renderImage={file => <ImagePreview key={file.preview.url} file={file} api={api} />} />;
}

// Lender Stop authorizes one attempt; borrower cancellation follows the job as it starts.
function sameCancelTarget(target,current) {
  return Boolean(target&&current&&target.role===current.role&&target.jobId===current.jobId&&target.circle===current.circle&&
    (target.role!=='ran'||target.attemptId===current.attemptId&&target.generation===current.generation));
}
const changedStopDialog={title:'Job changed',confirmLabel:'Review current job',cancelLabel:'Close',
  children:()=> <p data-telemetry-private="jobs" class="ph-no-capture">This job changed while you were reviewing it. Close this message and open Stop again to review the current run.</p>,onConfirm(){}};

// The rename form holds its title until the save is answered. While the save is in flight the title and Cancel are locked;
// a refused save keeps the typed title and says why; only a saved title closes the form.
export function RenameJob({initial, save, onDone, onCancel}) {
  const [title, setTitle] = useState(initial), [pending, setPending] = useState(false), [failure, setFailure] = useState(''), [gate] = useState(() => ({sending: false}));
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  async function submit(event) {
    event.preventDefault();
    if (gate.sending) return;
    gate.sending = true; setPending(true); setFailure('');
    try { await save(title); if (mounted.current) onDone(); }
    catch (error) { if (mounted.current) setFailure(errorMessage(error)); }
    finally { gate.sending = false; if (mounted.current) setPending(false); }
  }
  return <Card class="ph-no-capture" pad data-telemetry-private="jobs"><form class="stack-3" onSubmit={submit}>
    <label class="field">Job title<input class="input" value={title} required maxLength="160" disabled={pending} onInput={e => setTitle(field(e))} /></label>
    {failure && <p class="form-error" role="alert">{failure}</p>}
    <div class="pair"><Button kind="primary" type="submit" pending={pending}>Save title</Button><Button disabled={pending} disabledReason="Wait for the title to save." onClick={onCancel}>Cancel</Button></div>
  </form></Card>;
}

export function Job({id, requestedCircle, api, circle, circles, data, revision: sharedRevision, jobNews=0, draft, mutate, setDialog, members, headingRef, refresh}) {
  // `sharedRevision` moves for app-wide news; `jobNews` only for news that names this job. The page's sections follow both.
  const revision = sharedRevision + jobNews;
  const connection=useContext(Connection);
  const jobCircle = requestedCircle || (draft.submission?.digest === id ? draft.submission.circle : circle);
  const query = '?circle=' + enc(jobCircle), base = 'jobs/' + enc(id);
  // Retire an invalidated approval claim immediately. Healthy running snapshots
  // stay visible during background reads; errors and connection loss mute them.
  // The last successful answer stays current during background reads (I06); news that names this job reads it at once.
  const state = useResource(api, id && jobCircle ? base + query : null, sharedRevision);
  const ownCircle = circles?.find(item => item.id === jobCircle && item.owned === true);
  const ownCircleState = useResource(api, ownCircle ? 'circles/' + enc(jobCircle) + '/compose' : null, revision);
  // A download the person started stops when they leave the job page, even while it waits out a busy host.
  const downloads=useRef(new AbortController());
  useEffect(()=>()=>downloads.current.abort(),[]);
  // News about this job (an event or list row that names it) is read at once, past the usual read spacing,
  // so the page is not left showing "Last known" until the next scheduled read.
  const seenNews=useRef(jobNews), newsRead=useRef(null);
  useEffect(()=>{if(seenNews.current===jobNews)return;seenNews.current=jobNews;newsRead.current=state.reload();},[jobNews]);
  // Until a read that started after the news answers, the status shown may be the one the news replaced (judge r12 R12-1).
  const newsPending = newsRead.current != null && Boolean(state.data) && !(state.readGeneration >= newsRead.current);
  // Opening Cancel reads the job first. Its answer decides what the dialog may claim, not the page's last read (judge r13 R13-2).
  const decisionRead = useRef(null);
  const decisionPending = decisionRead.current != null && Boolean(state.data) && !state.error && !(state.readGeneration >= decisionRead.current);
  const [appliedNow,setAppliedNow]=useState(null);
  useEffect(()=>setAppliedNow(null),[id,jobCircle]);
  const confirmedApply = appliedNow?.jobId === id && appliedNow?.circle === jobCircle ? appliedNow.applied : null;
  // A branch this page just added is confirmed by the apply response itself; the refresh only repeats it.
  // A copy the app saved while the host is unreachable is shown, but never as current.
  let jobStale=(!confirmedApply&&state.stale)||Boolean(state.error)||Boolean(state.data?.savedAt);
  const [cancelled, setCancelled] = useState(null);
  useEffect(()=>setCancelled(null),[id,jobCircle]);
  const cancelDialogToken=useRef(null);
  const seed = useRef(typeof history !== 'undefined' ? history.state?.createdJob : null).current;
  const navigationType = useRef(pageNavigationType()).current;
  const created = createdJobPageSeed({seed,navigationType,id,circle:jobCircle});
  const hasCreatedSeed = Boolean(created);
  useEffect(() => {
    const clearSeed = () => {
      if (typeof history !== 'undefined') clearCreatedJobPageSeed(history, id);
    };
    // This value only exists to bridge the submit-to-detail transition; consuming it here
    // prevents reload or Back from replaying it as current server status.
    if (hasCreatedSeed || state.data || state.error || navigationType !== 'navigate') clearSeed();
    return clearSeed;
  }, [hasCreatedSeed, state.data, state.error, id, navigationType]);
  const listed = data.jobs?.find(row => row.job_digest === id && (row.circle?.id || row.circleId) === jobCircle);
  const matchingList = !state.data?.result_digest || !listed?.result_digest || state.data.result_digest === listed.result_digest ? listed : null;
  // The global jobs feed can lag a finished detail record. It may help fill in a loaded record,
  // but it is not an authoritative first paint for this page.
  // Page-local evidence only. Route/error/deletion retires it; a global list never seeds it.
  const lastConfirmed=useRef({key:null,record:null,seedAllowed:true});
  const observationKey=JSON.stringify([id,jobCircle]);
  if(lastConfirmed.current.key!==observationKey)lastConfirmed.current={key:observationKey,record:null,seedAllowed:true};
  // An absent shell response is loading, not confirmed removal from the circle.
  const retired=Boolean(state.error)||isJobDeleted(api,id)||
    (Array.isArray(data.circles)&&!data.circles.some(item=>item.id===jobCircle));
  const detail=state.data?{...state.data,circle:state.data.circle??{id:jobCircle}}:null;
  const detailProjection=detail?jobProjectionFor(detail):null;
  const incomplete=detailProjection?.phase==='unknown'&&['observation_changed','observation_unavailable'].includes(detailProjection.reasonCode)&&
    detailProjection.evidence.observation==='incomplete'&&detailProjection.version?.jobDigest===id;
  if(retired||detail&&detail.job_digest!==id||detailProjection?.phase==='unknown'&&!incomplete)
    lastConfirmed.current={key:observationKey,record:null,seedAllowed:false};
  else if(detail&&detailProjection?.phase!=='unknown') {
    lastConfirmed.current.record=detail;lastConfirmed.current.seedAllowed=false;
  }
  const loaded = jobPageRecord({record:detail, listed:matchingList, created:!retired&&lastConfirmed.current.seedAllowed?created:null,
    previous:!retired?lastConfirmed.current.record:null,error:state.error});
  if(loaded?.jobProjection?.observation&&loaded.jobProjection.actionHints?.length===0)jobStale=true;
  const observedRecord = loaded ? {...knownJobReceipt(api,{...loaded,job_digest:id,circle:{id:jobCircle}}),...loaded,...(confirmedApply&&!loaded.applied?{applied:confirmedApply}:{})} : loaded;
  const observed = confirmedApply && observedRecord ? confirmedAppliedJob(observedRecord,confirmedApply) : observedRecord;
  const sameCancellationRoute = cancelled?.jobId === id && cancelled?.circle === jobCircle;
  const pendingCancellation=sameCancellationRoute&&cancelled.acknowledgement.state==='pending';
  const hasFreshCancellationRead = Boolean(state.data && !state.error && !state.stale &&
    state.readGeneration >= cancelled?.readBarrier && state.readGeneration === state.resourceGeneration&&
    (!pendingCancellation||['stopping','stopped','result_accepted','failed','expired'].includes(jobProjectionFor(state.data).phase)));
  const cancelProjection = sameCancellationRoute ? cancelledJobProjection(observed,cancelled.acknowledgement,{
    hasNewerRead:hasFreshCancellationRead,
  }) : null;
  useEffect(()=>{
    if(sameCancellationRoute && hasFreshCancellationRead && jobProjectionFor(state.data).phase !== 'unknown')
      setCancelled(current=>current===cancelled?null:current);
  },[sameCancellationRoute,hasFreshCancellationRead,state.data,state.readGeneration,cancelled]);
  const job = sameCancellationRoute ? {...observed, jobProjection:cancelProjection,
    runTiming:{...observed?.runTiming,stopRequestedAt:cancelled.acknowledgement.requested_at}} : observed || {}, facts = jobFacts(job), role = jobRoleVM(job, data.devices?.fingerprint);
  // The projection may change its stop reason on the next read; live activity owns its own clock.
  const now = useDecisionClock(1000, jobStateKey(job) === 'stop_unconfirmed');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ownerCircleOutage = Boolean(ownCircle && ownCircleState.data?.hosted === true && ownCircleState.data?.networked !== false && ownCircleState.data?.host?.reachable === false);
  const ownerOutageBanner = ownerCircleOutage ? hostOfflineBanner(ownCircleState.data, circleName(ownCircle), {now, zone}) : null;
  const deleteUnavailableReason = ownerCircleOutage ? 'Delete is unavailable while the circle server isn’t answering.' : undefined;
  const savedNote = savedCopyNote(state.data?.savedAt ? {...state.data, circle: jobCircle} : null, circles, {now, zone});
  const roster = circleMembers(data.devices, jobCircle) || members || [];
  const people = jobPeopleVM(job, data.devices, roster);
  const {lender, requester:recipient} = people;
  const context = {zone, role, ...people, agent:facts.agent === 'Any agent' ? '' : facts.agent};
  const vm = jobStatusVM(job, {now, ...context});
  // A job whose last known state is before execution keeps Cancel, even on a saved copy: never offer Stop for a job
  // nobody started (judge r10 R1). Cancelling also stops it if it started since.
  const beforeExecution = ['waiting','waiting_approval','approved'].includes(vm.key);
  // A pre-start claim that news may have replaced is qualified until the read answers, never shown as current (judge r12 R12-1).
  const checking = (newsPending || decisionPending) && beforeExecution;
  const executionStarted=vm.executionStarted;
  const activeAttemptId=vm.attemptTarget?.attemptId??null;
  const activeAttemptGeneration=vm.attemptTarget?.generation??null;
  const cancelCopyState=useRef(null),cancelDialogTarget=useRef(null);
  cancelCopyState.current={beforeExecution,checking,stale:jobStale,started:executionStarted,role,attemptId:activeAttemptId,
    generation:activeAttemptGeneration,jobId:id,circle:jobCircle,canStop:vm.canStop};
  // Revocation is synchronous and permanent for this decision, even if eligibility returns before effects run.
  if(cancelDialogToken.current&&role==='sent'&&!vm.canStop)cancelDialogToken.current.revoked=true;
  const cancelCopyRevision=[beforeExecution,checking,jobStale,executionStarted,activeAttemptId,activeAttemptGeneration,vm.canStop].join(':');
  useEffect(()=>{
    const token=cancelDialogToken.current;
    if(!token)return;
    const target=cancelDialogTarget.current,current=cancelCopyState.current;
    if(token.revoked||target&&!sameCancelTarget(target,current)){
      cancelDialogToken.current=null;cancelDialogTarget.current=null;
      setDialog(dialog=>dialog?.jobCancelToken===token?changedStopDialog:dialog);
      return;
    }
    setDialog(current=>current?.jobCancelToken===token?{...current,jobCancelRevision:cancelCopyRevision}:current);
  },[cancelCopyRevision,role,activeAttemptId,activeAttemptGeneration,id,jobCircle,setDialog]);
  const cancelBeforeStart=()=>{
    const state=cancelCopyState.current;
    return state.beforeExecution&&!state.started;
  };
  const cancelCopy=()=>{
    const state=cancelCopyState.current;
    if(state.checking||state.stale&&!state.started)return 'Checking the job’s status. We’ll wait for an answer before confirming whether it started.';
    if(!cancelBeforeStart())return state.stale?'We’ll ask for the job to stop. It may take time to confirm.'
      :'We’ll ask the running computer to stop. It may take time to confirm.';
    return state.stale?'It won’t run. If it started since Faravan last checked, we’ll ask for it to stop.':'Nobody has started it. It won’t run.';
  };
  const initial = jobDetailVM(job, {role, zone, recipient, agent: facts.agent});
  // Remote transcript uploads do not change the job state, so shell events cannot refresh this feed.
  const activityPoll=initial.canReadTranscript&&!initial.terminal?5000:0;
  const progress = useResource(api, vm.key === 'working' && jobCircle ? base + '/progress' + query : null, revision,{poll:activityPoll});
  // The app answers from this computer's own approval; after an app restart it asks the host, whose copy can lag
  // the first seconds of a run. Until a short window passes, a failed read stays a neutral loading line.
  const [promptGaveUp, setPromptGaveUp] = useState(false);
  const promptPath = role==='ran'&&jobCircle ? base+'/prompt'+query : null;
  // The window starts when the page knows it ran the job and asks for the request, not when the page opens.
  useEffect(() => { setPromptGaveUp(false); if (!promptPath) return; const timer = setTimeout(() => setPromptGaveUp(true), 20000); return () => clearTimeout(timer); }, [promptPath]);
  const acceptedPrompt = useResource(api, promptPath, vm.key, {poll: 0});
  // Content already authorized for this job survives role/read transitions; actions still use the current role.
  const knownPrompt = useRef(null), promptIdentity = base + query;
  if (knownPrompt.current?.api !== api || knownPrompt.current?.identity !== promptIdentity)
    knownPrompt.current = {api, identity:promptIdentity, text:''};
  if (typeof acceptedPrompt.data?.text === 'string' && acceptedPrompt.data.text.trim())
    knownPrompt.current.text = acceptedPrompt.data.text;
  const promptRetrying = Boolean(acceptedPrompt.error) && !acceptedPrompt.data && !promptGaveUp;
  useEffect(() => { if (!promptRetrying) return; const timer = setTimeout(() => {if(displayVisible())acceptedPrompt.reload();}, 3000); return () => clearTimeout(timer); }, [promptRetrying, acceptedPrompt.error]);
  // Until this computer's fingerprint and the job's holder are both read, a page that may be the lender's is not yet a
  // viewer's: it shows the loading line, not an apology, for the same short window.
  const roleUnsettled = role==='viewer' && !(data.devices?.fingerprint && job.current_attempt?.holder);
  const [roleGaveUp, setRoleGaveUp] = useState(false);
  useEffect(() => { setRoleGaveUp(false); if (!roleUnsettled) return; const timer = setTimeout(() => setRoleGaveUp(true), 20000); return () => clearTimeout(timer); }, [roleUnsettled, promptIdentity]);
  const promptPending = (role==='ran' && !knownPrompt.current.text && !acceptedPrompt.data && (!acceptedPrompt.error || !promptGaveUp))
    || (roleUnsettled && !roleGaveUp && !knownPrompt.current.text && !(facts.prompt || job.job?.payload?.prompt || job.prompt));
  // The transport route names a job, but its result can change while a read is pending.
  // Give useResource a result-specific local key, never sent to the server, so its
  // normal path-change cancellation and stale-response fencing apply within a job.
  const changesApi = useRef(null);
  if (changesApi.current?.source !== api) {
    const reader = Object.create(api);
    reader.get = (path, signal) => api.get(path.split('#result=')[0], signal);
    changesApi.current = {source:api, reader};
  }
  const changesPath = initial.ready && jobCircle
    ? base + '/changes' + query + '#result=' + enc(job.result_digest || '') : null;
  const changes = useResource(changesApi.current.reader, changesPath, revision);
  // A failed refresh over a result already in hand is not a lost result.
  const changesLost = Boolean(changes.error) && !changes.data;
  // Read alongside job status: waiting for a slow status refresh before starting
  // this request adds another full server round trip to the first agent message.
  // A 1.1-second live read leaves transport/render time inside the five-second
  // delivery budget while making room for the other job-page reads. Slow live
  // reads stay single-flight; collection reads keep their default five-second spacing.
  const transcript = useResource(api, id && jobCircle && (!initial.terminal||initial.canReadTranscript) ? base + '/transcript' + query : null, initial.canReadTranscript&&!initial.terminal ? revision : vm.key,{poll:initial.canReadTranscript&&!initial.terminal?1100:0,minInterval:1100,adaptivePolling:false});
  const live = !initial.terminal && transcript.data?.live !== false;
  const activityStale=jobStale||Boolean(transcript.error&&transcript.error.status!==409);
  const activityEmpty=activityFreshness({error:transcript.error,role}).empty;
  const feed = transcriptFeedVM(transcript.data?.text, {truncated: transcript.data?.truncated, live, zone});
  const lastOutputAt = jobLastOutputAt(transcript.data, feed);
  const liveClaim = liveFreshness({connected: transcript.data?.live === true && !transcript.error && !jobStale, observedAt: transcript.observedAt});
  const status = jobStatusVM(job, {now, ...context, progress: progress.data?.entries ?? [], activity: feed.activity, lastOutputAt});
  const formattedJob = formatJobProjection(job);
  const retention = useResource(api, initial.terminal && jobCircle ? base + '/retention' + query : null, vm.key);
  const page = jobDetailVM({...job, ...changes.data, endedAt:retention.data?.ended_at}, {role, zone, recipient: recipient || changes.data?.resultAuthor?.name, agent: facts.agent});
  const threadPath = facts.own && jobCircle ? base + '/thread' + query : null;
  // This read belongs to the job route, not either visual slot. Keep it alive while
  // a ready-state transition temporarily replaces the page with the result loader.
  const thread = useResource(api, threadPath, revision);
  const continuationPath = page.result && facts.own && jobCircle ? base + '/continuation' + query : null;
  const ran = howItRanVM({...job, ...changes.data}, {role, lender, device:people.lenderDevice, compact:initial.ready, agent: facts.agent === 'Any agent' ? '' : facts.agent});
  const [followupError,setFollowupError]=useState('');
  const startFollowup=async()=>{
    setFollowupError('');
    try {
      const continuation=await api.get(continuationPath);
      const prepared=prepareFollowupDraft(globalThis.localStorage,jobCircle,continuation);
      if(!prepared.ok)throw Object.assign(new Error('followup_failed'),{code:prepared.code??'followup_missing'});
      location.hash='#/new';
    }catch(error){setFollowupError(errorMessage(error));}
  };
  const [applying, setApplying] = useState(false), [renaming, setRenaming] = useState(null);
  useEffect(() => { setApplying(false); setRenaming(null); setFollowupError(''); }, [id, jobCircle]);
  useEffect(() => { if (state.data && (document.activeElement === document.body || document.activeElement?.id === 'main')) headingRef?.current?.focus(); }, [Boolean(state.data), vm.key]);
  const summary = agentSummaryVM(transcript.data?.text);
  const agentMessage=agentQuestionVM(summary);
  const historyFeed={...feed,entries:feed.entries.filter(entry=>entry.kind!=='message'||!summary||!entry.text.trim().startsWith(summary))};
  const outputWarning = jobOutputWarningVM(summary, jobContextVM(transcript.data?.text).workspace_path);
  const returnedOutputs = ['message','files'].includes(changes.data?.format);
  const unsupportedResult = page.result && changes.data && changes.data.format !== 'diff' && !returnedOutputs;
  const identity = jobVM({...job, ...changes.data, title:facts.own ? facts.title : job.title}, role, {lender,requester:recipient || changes.data?.resultAuthor?.name,now,zone,devices:data.devices,changes:changes.data});
  const noChanges = page.result && !returnedOutputs && identity.noChanges;
  const resultPending = resultDataPending(page, changes);
  const plainFolder = changes.data?.format==='diff' && !job.local?.sourceBranch && !job.applied && !job.local?.applied && (/\(folder\)$/.test(job.local?.source||'') || job.local?.sourceBranch==='');
  const resultCaption=page.receipt ? '' : plainFolder ? plainFolderResultCaption(noChanges) : changesLost ? 'Load the result to review its files and checks.' : noChanges ? 'A follow-up continues from this result with a new instruction.' : returnedOutputs ? (changes.data?.files?.length ? 'Keep a copy of the returned files.' : 'Keep a copy of the response.') : 'Review and test these changes before you rely on them. A signature shows where they came from; it doesn’t prove the code works.';
  const title = jobHeadingVM(job, identity.title);
  const prompt = facts.prompt || knownPrompt.current.text || job.job?.payload?.prompt || job.prompt || (draft.submission?.digest === id ? draft.submission.prompt : '');
  async function startReviewFollowup(request, expectedResult) {
    const continuation=await api.get(base+'/continuation'+query);
    if(expectedResult && continuation?.parentResult!==expectedResult)throw Object.assign(new Error('followup_missing'),{code:'followup_missing'});
    const storage=globalThis.localStorage;
    const prepared=saveFollowupRequest({prepare:prepareFollowupDraft,save:saveDraft,storage,circle:jobCircle,continuation,request});
    if(!prepared.ok)throw Object.assign(new Error('followup_failed'),{code:prepared.code??'followup_missing'});
    const next=prepared.draft;
    const stored=loadDraft(storage,jobCircle);
    if(stored.id!==next.id||stored.prompt!==request||stored.followup?.parentJob!==next.followup.parentJob)throw Object.assign(new Error('followup_storage'),{code:'followup_storage'});
    storage.setItem('faravan-compose-circle',jobCircle);
    location.hash='#/new';
  }
  async function deleteJob() {
    await api.post(base + '/delete', {circle:jobCircle});
    markJobDeleted(api,id);
    try { sessionStorage.setItem(deletionNoticeKey, 'Job deleted'); } catch {}
    location.hash = '#/jobs';
    void refresh?.();
  }
  async function downloadPatch(endpoint='result') {
    const result = await api.download(base + '/'+endpoint + query, downloads.current.signal), url = URL.createObjectURL(result.blob), link = document.createElement('a');
    link.href = url; link.download = result.filename; link.classList.add('ph-no-capture'); link.setAttribute('data-telemetry-private', 'jobs-download'); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  let primaryAction=null;
  if(page.result){
    if(returnedOutputs){
      if(changes.data?.files?.length===1 && !changes.data?.download_only) primaryAction=<Action className="btn btn-primary" run={() => downloadOutput(api,changes.data.files[0].url)} success="File downloaded.">{ /\.(png|jpe?g|webp|gif|avif)$/i.test(changes.data.files[0].path)?'Download image':'Download file'}</Action>;
      else if(changes.data?.files?.length || changes.data?.download_only) primaryAction=<Action className="btn btn-primary" run={() => downloadPatch()} success="Files downloaded.">Download all files</Action>;
      else if(changes.data?.message?.markdown) primaryAction=<Action className="btn btn-primary" run={() => copyOutputMessage(api,changes.data.message)} success="Message copied.">Copy message</Action>;
    } else if(noChanges) primaryAction=<Button class="ph-no-capture" kind="primary" onClick={startFollowup} data-telemetry-private="jobs">Send a follow-up job</Button>;
    else if(plainFolder) primaryAction=<Action className="btn btn-primary" run={() => downloadPatch('changed-files')} success="Changed files downloaded.">Download changed files</Action>;
    else if(vm.key==='ready' && changes.data?.format==='diff' && !changes.data.invalid && !changes.data.blocked?.length) primaryAction=<Button class="ph-no-capture" kind="primary" onClick={() => setApplying(true)} data-telemetry-private="jobs"><Icon name="branch" size="sm" />Add as a branch…</Button>;
  }
  if (!loaded && !state.error) return <div class="stack-6 job-page job-loading ph-no-capture" role="status" aria-label="Loading job" data-telemetry-private="jobs"><TabTitle text="Loading job" /><header class="jh"><a class="back" href="#/jobs">Jobs</a><div class="skel" /><div class="skel loading-title" /><div class="skel" /></header><div class="job-layout"><div class="job-main stack-6"><Card pad><div class="skel" /><div class="skel" /><div class="skel" /></Card></div><aside class="rail"><Card pad><div class="skel" /><div class="skel" /></Card></aside></div></div>;
  if (state.error && !loaded) { const failed = problemView(state.error.problem??state.error,browserProblemContext()).title; return <Card class="ph-no-capture" pad data-telemetry-private="jobs"><TabTitle text={failed} /><h1 class="t-page">{failed}</h1><p role="alert">{errorMessage(state.error)}</p><div class="hstack-2 wrap"><Button href="#/jobs">Back to Jobs</Button><Button kind="secondary" onClick={() => state.reload()}>Try again</Button></div></Card>; }
  if(resultPending && !changesLost) return <div class="stack-6 job-page job-result job-result-loading ph-no-capture" data-telemetry-private="jobs"><JobHead vm={{...status,pill:{kind:'off',word:'Loading result'}}} title={title} headingRef={headingRef} sub={[circleName(circles.find(c=>c.id===jobCircle))]} /><div class="job-layout" role="status" aria-label="Loading result"><div class="job-main card card-pad stack-3"><div class="skel"/><div class="skel"/><div class="skel"/></div><aside class="rail card card-pad stack-3"><div class="skel"/><div class="skel"/><div class="skel"/></aside></div></div>;
  return <div class={("stack-6 job-page"+(page.ready?" job-result":"")+(jobStale?" data-stale":"")) + ' ph-no-capture'} data-telemetry-private="jobs">
    <JobHead vm={{...status,...(status.stoppedEarly?{headline:identity.word}:{}),...(checking?{headline:'Checking the job’s status…'}:{}),loading:resultPending && !changesLost,pill:{kind:changesLost?'need':identity.kind,word:jobStale?'Last known: '+identity.word:checking?'Checking…':changesLost?'Result unavailable':noChanges&&!status.stoppedEarly?'No changes':identity.word}}} title={title} headingRef={headingRef} sub={page.receipt ? [circleName(circles.find(c => c.id === jobCircle))] : [circleName(circles.find(c => c.id === jobCircle)), whenLabel(job.local?.submittedAt ?? job.waitingTiming?.submittedAt, now, zone) && 'sent ' + whenLabel(job.local?.submittedAt ?? job.waitingTiming?.submittedAt, now, zone)].filter(Boolean)} />
    {job.local?.sentByAgent && <p class="t-sm t-2">Sent by an agent</p>}
    {ownerOutageBanner && <div class="banner wait" role="status"><Icon name="cloud-off" /><div class="grow"><b>{ownerOutageBanner.headline}</b><p class="t-sm">{ownerOutageBanner.text}</p>{ownerOutageBanner.href && <p class="t-sm"><a href={ownerOutageBanner.href}>{ownerOutageBanner.linkLabel}</a></p>}</div></div>}
    {pendingCancellation&&<div class="banner wait" role="status"><div class="grow"><b>Stop pending delivery</b><p class="t-sm">The stop is saved on this computer. The job’s computer cannot be reached. Faravan will keep trying; work may still be running.</p></div></div>}
    {page.result && status.stoppedEarly && <p class="t-sm job-stop-note" role="status">{status.text}</p>}
    {page.result && <div class="result-phone-action stack-2">{primaryAction}{primaryAction && <p class="t-xs t-2">{resultCaption}</p>}</div>}
    {savedNote&&<p class="t-sm t-2 saved-copy" role="status">{savedNote}</p>}
    {state.error&&<Card pad class="stack-3"><ProblemNotice error={state.error} onRead={state.reload}/></Card>}
    <ParentJobLink api={api} parent={job.parentLink || job.job?.payload?.parent || acceptedPrompt.data?.parent || (job.local?.parentJob ? {job_digest:job.local.parentJob,result_digest:job.local.parentResult}:null)} circle={jobCircle} />
    {page.result && changesLost && <Card pad class="job-result-error stack-3"><ProblemNotice error={changes.error} onRead={changes.reload}/></Card>}
    <div class="job-layout">
      <div class="stack-6 job-main">
        {page.result && changes.data && <ResultHistoryStatus transcript={transcript} onRetry={transcript.reload}/>}
        {page.receipt ? <><Card pad><h2 class="t-title2">Result delivered</h2><p class="t-sm t-2">{recipient || 'The person who asked'} {returnedOutputs ? 'can read it and keep a copy.' : changes.data?.format === 'diff' && changes.data.files?.length === 0 && !changes.data.diff?.trim() ? 'can read the result. No file changes were returned.' : job.sourceKind === 'git' ? 'can review the changes and add them as a branch.' : 'can review the returned changes.'}</p></Card>{returnedOutputs ? <ResultReader data={changes.data} api={api} showActions={!page.ready} showFileActions={changes.data.files?.length!==1 || !page.result} /> : changes.data?.format === 'diff' && <ChangesView data={changes.data} api={api} circle={jobCircle} resultDigest={job.result_digest} />}<details class="job-details"><summary>Job details</summary><div class="stack-6"><AskedCard bare pending={promptPending} prompt={typeof prompt==='string'?prompt:''} own={false}/><JobTimeline bare api={api} jobId={id} circle={jobCircle} revision={revision} role={role} terminal/><AgentActivity bare feed={returnedOutputs?historyFeed:feed} live={false} now={now}/></div></details></> : <>
          {vm.key === 'added_branch' && <AppliedCard applied={job.applied} />}
          {!page.ready && (page.terminal || !page.canReadTranscript || transcript.data?.unavailable) && <LiveJobStatus job={job} stale={Boolean(jobStale)} context={context} progress={progress.data?.entries??[]} activity={feed.activity} lastOutputAt={lastOutputAt} person={lender} personName={lender} waiting={now => <WaitingJob key={jobCircle + ':' + id} api={api} job={job} circleId={jobCircle} circleLabel={circleName(circles.find(c => c.id === jobCircle))} lender={lender} revision={revision} now={now} />} />}
          {vm.key === 'failed' && <section class="stack-3"><h2 class="t-title2">Failure details</h2>{summary && <div class="job-summary"><Markdown text={summary} /></div>}<p class="t-sm t-2">Partial output is not available on this page. This does not confirm whether any files were kept or actions happened outside the project.</p></section>}
          {page.result && <>
            <AgentQuestion questionId={JSON.stringify([jobCircle,id,job.result_digest??null])} question={agentMessage.question} onAnswer={request=>startReviewFollowup(request,job.result_digest)} />
            {!returnedOutputs && (!agentMessage.question || agentMessage.body) && <section class="stack-3"><h2 class="t-title2">{noChanges || changesLost ? "Agent response" : "What changed for you"}</h2>{!summary && <JobSummaryStatus transcript={transcript} onRetry={transcript.reload} />}{agentMessage.body && <div class="job-summary"><Markdown text={agentMessage.body} /></div>}</section>}
            {!changesLost && ran.checks.length>0 && <section class="stack-3"><h2 class="t-title2">Faravan’s checks</h2><CheckLines checks={ran.checks} /></section>}
            {changes.data ? returnedOutputs ? <ResultReader data={changes.data} api={api} showActions={!page.ready} showFileActions={changes.data.files?.length!==1 || !page.result} /> : changes.data.invalid ? <Card pad><p role="alert">{errorMessage({code:'result_patch_invalid'})}</p><Action className="btn btn-secondary" run={() => navigator.clipboard.writeText(JSON.stringify({job:id,circle:jobCircle,code:'patch_unreadable'}))} success="Details copied.">Copy details</Action></Card> : changes.data.format === 'diff' ? noChanges ? <>{outputWarning && <p class="banner warn" role="status">{outputWarning}</p>}</> : <ChangesView data={changes.data} outputWarning={outputWarning} api={api} circle={jobCircle} resultDigest={job.result_digest} onAskChanges={startReviewFollowup} /> : <Card pad><p>Unsupported result format: {safeName(changes.data.format, 'unknown')}. This page cannot preview or download this format. Review the agent response or send a follow-up with a new instruction.</p></Card> : changesLost ? null : <Card pad class="job-changes-loading"><div class="stack-3" role="status" aria-label="Loading changes"><div class="skel" /><div class="skel" /><div class="skel" /></div></Card>}
          </>}
          {page.canReadTranscript && !page.terminal && <LiveAgentActivity job={job} context={{...context,lastOutputAt:statusLastOutputAt(feed,lastOutputAt,transcript.data?.live===true?transcript.data.at:null)}} key={jobCircle + ':' + id} feed={feed} freshness={liveClaim} headline={status.headline} facts={status.facts} live={live} stale={activityStale} unavailable={transcript.data?.unavailable} now={now} version={transcript.data?.text?.length ?? 0} empty={activityEmpty} />}
          {page.result && <details id="job-handoff" class="job-details job-handoff"><summary>Job details</summary><div class="stack-6">{facts.own && <JobThread bare key={jobCircle + ':' + id} api={api} thread={thread} continuationPath={continuationPath} revision={revision} circleId={jobCircle} currentJob={job} now={now} zone={zone} />}
<AskedCard bare pending={promptPending} prompt={typeof prompt==='string'?prompt:''} own={facts.own} action={facts.own && renaming===null?<Button kind="quiet" size="sm" disabled={connection.offline} disabledReason="Reconnect to rename this job" title={connection.offline?'Reconnect to rename this job':undefined} onClick={()=>setRenaming(title)}><Icon name="pencil" size="sm"/>Rename job</Button>:null}/>
<JobTimeline bare api={api} jobId={id} circle={jobCircle} revision={revision} role={role} terminal={page.terminal}/>
{page.canReadTranscript && <AgentActivity bare feed={historyFeed} live={false} now={now} version={transcript.data?.text?.length??0}/>}
{!returnedOutputs && !plainFolder && !noChanges && !unsupportedResult && !changesLost && <details class="job-details"><summary>Advanced: apply directly to your working tree</summary>{!applying&&<ResultActions api={api} jobId={id} circle={jobCircle} applied={job.applied} sourceFolder={page.sourceFolder} onChanged={refresh}/>}</details>}
</div></details>}
          {!page.result && <AskedCard pending={promptPending} prompt={typeof prompt === 'string' ? prompt : ''} own={facts.own} action={facts.own && renaming === null ? <Button kind="quiet" size="sm" disabled={connection.offline} disabledReason="Reconnect to rename this job" title={connection.offline?'Reconnect to rename this job':undefined} onClick={() => setRenaming(title)}><Icon name="pencil" size="sm" />Rename job</Button> : null} />}
          {renaming !== null && <RenameJob initial={renaming} save={title => mutate(base + '/title', {title})} onDone={() => setRenaming(null)} onCancel={() => setRenaming(null)} />}
          {!page.result && page.canReadTranscript && page.terminal && <LiveAgentActivity job={job} context={{...context,lastOutputAt:statusLastOutputAt(feed,lastOutputAt,transcript.data?.live===true?transcript.data.at:null)}} key={jobCircle + ':' + id} feed={feed} freshness={liveClaim} headline={status.headline} facts={status.facts} live={live} stale={activityStale} unavailable={transcript.data?.unavailable} now={now} version={transcript.data?.text?.length ?? 0} empty={activityEmpty} />}
        </>}
      </div>
      {page.ready ? <aside class="rail card result-rail" aria-label="Result actions and details">
        {!page.receipt && <section class={"result-rail-section stack-3"+(noChanges?" result-rail-primary-only":"")}><h2 class="t-title3">{changesLost ? 'Result details' : returnedOutputs ? 'Keep this result' : noChanges ? 'Next steps' : 'Use these changes'}</h2><div class="result-desktop-action">{primaryAction}</div><p class={'t-xs t-2'+(primaryAction?' result-action-caption':'')}>{resultCaption}</p>
        {page.result && !returnedOutputs && !noChanges && changes.data?.format === 'diff' && <Action className="btn btn-secondary job-download" run={() => downloadPatch()} success="Patch downloaded.">Download the patch</Action>}

        {page.result && returnedOutputs && changes.data?.message?.markdown && <>
          {(changes.data.files?.length>0 || changes.data.download_only) && <Action className="btn btn-secondary" run={() => copyOutputMessage(api,changes.data.message)} success="Message copied.">Copy message</Action>}
          <Action className="btn btn-secondary" run={() => downloadOutput(api,changes.data.message.url)} success="Message downloaded.">Download Markdown</Action>
        </>}
        {page.result && facts.own && !noChanges && <Button kind="secondary" onClick={startFollowup}>{returnedOutputs ? 'Send a follow-up job (new instruction)' : 'Send a follow-up job'}</Button>}
        {followupError && <p class="form-error" role="alert">{followupError}</p>}

        </section>}
        {page.result && facts.own && job.canSetBorrowerOutcome === true && <BorrowerVerdict key={jobCircle + ':' + id} api={api} base={base} circle={jobCircle} outcome={job.borrowerOutcome} onChanged={() => { void state.reload(); void refresh?.(); }} />}
        {page.result && <HowItRan details={ran.details} lines={ran.lines} checks={ran.checks} usage={ran.usage} note={ran.note} missing={changes.data ? ran.missing || (!ran.lines.length ? 'Run details weren’t included with this result.' : '') : 'Loading run details…'} />}
        <section class="result-rail-section stack-3"><h2 class="t-title3">Properties</h2><ResultProperties receipt={changes.data?.receipt || job.receipt} lender={lender} device={people.lenderDevice} ownRun={role==='ran' || Boolean(job.current_attempt?.holder && job.current_attempt.holder===data.devices?.fingerprint)} retention={retention.data} zone={zone} />
        </section>{facts.own && <section class="result-rail-section stack-2" aria-label="More job actions">
        {facts.own && <Button kind="secondary" onClick={() => setDialog(resendJobDialog({storage:globalThis.localStorage,jobCircle,job,prompt,sourceFolder:page.sourceFolder,navigate:()=>{location.hash='#/new';}}))}>Send again…</Button>}
        {facts.own && retention.data?.deletable===true && <Button kind="secondary" class="job-delete" disabled={ownerCircleOutage} disabledReason={deleteUnavailableReason} title={deleteUnavailableReason} onClick={() => setDialog({title:'Delete this job?',confirmLabel:'Delete job',cancelLabel:'Keep job',children:<p>This deletes the request, code and result from the host. This cannot be undone.</p>,onConfirm:async()=>{await deleteJob();}})}>Delete this job…</Button>}
        </section>}
      </aside> : <aside class={page.terminal?"rail card result-rail terminal-rail":"rail stack-4"}>
        {followupError && <p class="form-error" role="alert">{followupError}</p>}
        {(facts.own || role === 'ran') && status.canStop && (role !== 'ran' || vm.attemptTarget) && <Card><div class="use">
          <h2 class="t-title3">This job</h2>
          <p class="t-sm t-2">{beforeExecution ? (checking ? 'Checking whether anyone has started it.' : jobStale ? 'Nobody had started it when Faravan last checked. Cancelling also stops it if it has started since.' : 'Nobody has started it. To change it, cancel it and send a new one.') : jobStale ? 'Stopping asks for the job to end. Wait for confirmation; work so far may not be returned.' : people.ownRun ? 'Stopping ends your agent’s work on this job. Work so far may not be returned.' : 'Stopping asks ' + (lender ? lender + '’s computer' : 'the running computer') + ' to end the agent’s work. Wait for confirmation; work so far may not be returned.'}</p>
          <Button kind="danger" disabled={connection.offline&&role!=='ran'} disabledReason="Reconnect to stop this job" title={connection.offline&&role!=='ran'?'Reconnect to stop this job':undefined}
            onClick={() => {
              decisionRead.current = state.reload();
              const token={};
              const target={role,attemptId:activeAttemptId,generation:activeAttemptGeneration,jobId:id,circle:jobCircle};
              cancelDialogToken.current=token;
              cancelDialogTarget.current=target;
              setDialog({
              jobCancelToken:token,jobCancelRevision:cancelCopyRevision,
              allowOffline:role==='ran',title:()=>cancelBeforeStart()?'Cancel this job?':'Stop this job?',
              confirmLabel:()=>cancelBeforeStart()?'Cancel job':'Stop job',cancelLabel:'Keep going',
              children:()=> <p>{cancelCopy()}</p>,
              onConfirm:async()=>{
                const keepCurrentDialog=()=>{
                  if(cancelDialogToken.current!==token)return true;
                  if(!token.revoked&&sameCancelTarget(target,cancelCopyState.current)&&
                    (target.role==='ran'||cancelCopyState.current.canStop))return false;
                  cancelDialogToken.current=null;cancelDialogTarget.current=null;
                  setDialog(dialog=>dialog?.jobCancelToken===token?changedStopDialog:dialog);
                  return true;
                };
                if(keepCurrentDialog())return KEEP_CONFIRM_OPEN;
                if(target.role==='ran')await api.post('lending/stop',{attemptId:target.attemptId,confirmed:true});
                else {const acknowledgement=await api.post(base+'/cancel',{circle:jobCircle});const readBarrier=state.reload();setCancelled({jobId:id,circle:jobCircle,acknowledgement,readBarrier});}
                const keepOpen=keepCurrentDialog();
                requestAnimationFrame(()=>headingRef?.current?.focus());void refresh?.();
                return keepOpen?KEEP_CONFIRM_OPEN:undefined;
              },
            });
            }}>{jobStale&&!beforeExecution?'Stop this job':status.stopLabel}</Button>
        </div></Card>}
        {facts.own && <JobThread key={jobCircle + ':' + id} api={api} thread={thread} continuationPath={continuationPath} revision={revision} circleId={jobCircle} currentJob={job} now={now} zone={zone} />}
        {vm.key === 'stop_unconfirmed' && <Card pad><Action className="btn btn-secondary" allowOffline run={() => navigator.clipboard.writeText(JSON.stringify({job:id,circle:jobCircle,...formattedJob.failureDetails}))} success="Details copied.">Copy details</Action></Card>}
        {vm.key === 'failed' && <Card pad><Action className="btn btn-secondary" run={() => navigator.clipboard.writeText(JSON.stringify({job:id,circle:jobCircle,...formattedJob.failureDetails}))} success="Details copied.">Copy details</Action></Card>}
        {page.terminal && facts.own && <Card><div class="use"><h2 class="t-title3">Prepare another request</h2><p class="t-sm t-2">{vm.recovery === 'followup' ? 'This job ended without a completed result. Earlier actions outside the project may already have happened. Review the request and source before sending again.' : 'Prepare a new request for this circle. Earlier actions may already have happened. Review the request and source before sending again.'}</p><Button kind={vm.recovery === 'followup' ? 'primary' : 'secondary'} onClick={() => setDialog(resendJobDialog({storage:globalThis.localStorage,jobCircle,job,prompt,sourceFolder:page.sourceFolder,navigate:()=>{location.hash='#/new';}}))}>{vm.key === 'failed' && vm.recovery === 'resend' ? 'Send again…' : 'Prepare another request…'}</Button></div></Card>}

        {page.terminal && <JobTimeline role={role} terminal key={jobCircle+':'+id} api={api} jobId={id} circle={jobCircle} revision={revision} />}
        {(page.ready || ran.lines.length > 0 || ran.checks.length > 0) && <HowItRan details={ran.details} lines={ran.lines} checks={ran.checks} usage={ran.usage} note={ran.note} missing={changes.data ? ran.missing || (!ran.lines.length ? 'Run details weren’t included with this result.' : '') : page.ready ? 'Loading run details…' : ran.missing} />}
    {page.terminal && !page.ready && <Card pad class="stack-3"><h2 class="t-title3">Properties</h2><ResultProperties retention={retention.data} zone={zone} /><div class="stack-2 result-footer">
      {facts.own && retention.data?.deletable === true && <Button kind="secondary" class="job-delete" disabled={ownerCircleOutage} disabledReason={deleteUnavailableReason} title={deleteUnavailableReason} onClick={() => setDialog({title:'Delete this job?',confirmLabel:'Delete job',cancelLabel:'Keep job',children:<p>This deletes the request, code and result from the host. This cannot be undone.</p>,onConfirm:async()=>{await deleteJob();}})}>Delete this job…</Button>}
      {retention.error && <Action className="btn btn-secondary" run={()=>navigator.clipboard.writeText(JSON.stringify({job:id,circle:jobCircle,code:retention.error.code,status:retention.error.status}))} success="Details copied.">Copy details</Action>}
    </div></Card>}
      </aside>}

    </div>


    <ApplySheet key={jobCircle + ':' + id} open={applying} onClose={() => setApplying(false)} api={api} jobId={id} circle={jobCircle} lender={lender} sourceFolder={page.sourceFolder} sourceBranch={job.local?.sourceBranch || ''} onPatch={() => downloadPatch()} onFollowup={startFollowup} onApplied={out => {setApplying(false); setAppliedNow({jobId:id,circle:jobCircle,applied:appliedFrom(out)}); void refresh?.();}} />
  </div>;
}
