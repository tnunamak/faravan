import {SavedRequestPreview} from './saved-request.jsx';
import {discardSavedDraft, undoDiscardedDraft} from './compose-draft.mjs';
import {requestCapacity} from './request-capacity.mjs';
import {useEffect, useRef, useState} from 'preact/hooks';
import {useResource, enc, Link, circleName, Action} from './shared.jsx';
import {safeName, reviewCard, circleMembers, homePlan, contributionLine} from './helpers.mjs';
import {Avatar, Button, Card, Icon, InlineStatus} from './ds/index.mjs';
import {SwingItemCard} from './ds/swing.jsx';
import {agentRowVM, lendPageVM, homeProviderQuotaVM, homePageVM, homePeopleVM, requestFactsVM} from './view-models.mjs';
import {BlockerAction} from './blockers.jsx';
import {LendingCard} from './lend.jsx';
import {loadHomePreview,loadHomeReceipt} from './home-preview.mjs';
import {useMemberHost, MemberHostNotices} from './member-host.jsx';
import {onboardingVM} from './onboarding.mjs';
import {composeCircle} from './compose-model.mjs';
import {OnboardingEntry, ProgressCard, FirstTasks, FirstRunCard} from './onboarding.jsx';
import {requestDeadlineVM} from './request-model.mjs';
import {handoffHomeDraft, readHomeText, keepHomeText} from './compose-draft.mjs';
import {formatRelative} from './dates.mjs';
import {homeLendingSummary} from './home-lending.mjs';
import {circlesWithCurrentWork, JobHistoryNotice, uncheckedCirclesInUse} from './jobs.jsx';
import {normalizeNetwork} from './safety-copy.mjs';


const Section = ({id, title, link, children}) => <section class="ph-no-capture" aria-labelledby={id} data-telemetry-private="home">
  <div class="section-h"><h2 id={id}>{title}</h2>{link}</div>{children}
</section>;

function LendingPrompt({prompt, limits = {}, agents = [], mutate}) {
  const dailyJobs = limits.dailyJobs === null ? 'No daily job cap' : Number.isFinite(limits.dailyJobs) ? limits.dailyJobs + (limits.dailyJobs === 1 ? ' job' : ' jobs') : 'Daily job limit unavailable';
  const dailyMinutes = limits.dailyMinutes === null ? 'no daily minute cap' : Number.isFinite(limits.dailyMinutes) ? limits.dailyMinutes + (limits.dailyMinutes === 1 ? ' minute a day' : ' minutes a day') : 'daily minute limit unavailable';
  const names = agents.filter(agent => agent.useForLending === true).map(agent => agentRowVM(agent).name);
  const agentNames = names.length ? names.join(' and ') : 'agents chosen in Lending settings';
  const [pending, setPending] = useState(false);
  const run = async (path, body) => {
    setPending(true);
    try { return await mutate(path, body); }
    finally { setPending(false); }
  };
  return <Card class="ph-no-capture" data-telemetry-private="home"><div class="card-pad stack-3">
    <h3 class="t-title3">Lend to {safeName(prompt.name)} automatically?</h3>
    <p>Let jobs from {safeName(prompt.name)} use your {agentNames} on this computer and your subscription allowance. While Automatic is on, Faravan renews permission when it confirms who’s in the circle. If it can’t confirm anyone for 30 days, lending automatically to this circle stops.</p>
    <p>Daily caps across all circles: {dailyJobs}; {dailyMinutes}. Other limits still apply. <a href="#/lend/limits">Review limits</a></p>
    <p>Turn this off in <a href="#/lend/limits">Lending settings</a>. Keep asking requires approval until you change it. Not now shows this card next launch.</p>
    {prompt.atRuleLimit && <p role="status">You have 100 automatic lending permissions. Remove one in <a href="#/lend/limits">Lending settings</a> to add this circle.</p>}
    <div class="request-actions">
      <Action disabled={pending || prompt.atRuleLimit} disabledReason={prompt.atRuleLimit ? 'Remove an automatic lending permission first.' : 'Saving your choice.'} run={()=>run('lending/mode',{circle:prompt.circle,mode:'auto'})}>Lend automatically</Action>
      <Action disabled={pending} disabledReason="Saving your choice." run={()=>run('lending/mode',{circle:prompt.circle,mode:'ask'})}>Keep asking</Action>
      <Action className="btn btn-quiet" disabled={pending} disabledReason="Saving your choice." run={()=>run('lending/prompts/dismiss',{circle:prompt.circle})} success="We’ll ask again next time you start the app.">Not now</Action>
    </div>
  </div></Card>;
}


function HomeSkeleton({label}) {
  return <Card data-telemetry-private="home" class="ph-no-capture"><div class="home-loading" role="status" aria-label={label}>{[0,1,2].map(i => <div key={i} class="row"><span class="skel skel-av" /><div class="row-main"><div class="skel skel-line" /><div class="skel skel-line short" /></div></div>)}</div></Card>;
}

function JobRows({rows, stale = false}) {
  return <ul class="list card home-jobs ph-no-capture" data-telemetry-private="home">{rows.map(row => {
    const running=row.role==='ran'&&['starting','working'].includes(row.key),current=running&&row.person?.name?(row.key==='starting'?'Starting for ':'Running for ')+row.person.name:row.word,
      word=stale||row.lastKnown?'Last known: '+current.replace(/^Last known: /,''):current;
    return <li key={row.id + row.circleId}>
    <a class="row" href={row.href}>
      <span title={row.directionLabel}><Icon name={row.glyph} /></span>
      <div class="row-main"><div class="row-title">{row.title}</div>{row.reason && <p class="t-xs t-2">{row.reason}</p>}
        <div class="row-meta dots"><InlineStatus kind={row.kind} word={word} />{row.whoShort && !running && <span>{row.whoShort}</span>}{row.circle && <span>{row.circle}</span>}{row.when && <span>{row.when}</span>}</div>
      </div><Icon name="chev-r" size="sm" />
    </a>
  </li>;})}</ul>;
}

export function ResultCard({vm, stale = false, primary = true, previewError=false, receiptError=false, retryPreview, previewPending=false, retrying=false, dismiss}) {
  const row = vm.result;
  return <Card class="result-card ph-no-capture" data-telemetry-private="home"><div class="card-pad stack-4">
    <div class="hstack"><InlineStatus kind={row.kind} word={stale || row.lastKnown ? 'Last known: ' + row.word.replace(/^Last known: /,'') : row.word} /><span class="grow" /><span class="t-xs t-2">{row.when}</span></div>
    <div class="stack-2"><h3 class="t-title2">{vm.preview.prompt || row.title}</h3><p class="t-sm t-2">{row.stopNote || vm.resultCopy.lead}</p></div>
    {vm.preview.lines.length > 0 ? <div class="result-preview" aria-label="Changes preview">
      <div class="preview-file"><Icon name="file" size="sm" /><code>{vm.preview.file || 'Changes'}</code><span class="grow" /><span class="t-xs t-2">{vm.preview.summary}</span></div>
      {vm.preview.lines.map((line, i) => <div key={i} class={'preview-line ' + line.kind}><span aria-hidden="true">{line.kind === 'add' ? '+' : '−'}</span><code>{line.text}</code></div>)}
    </div> : vm.resultCopy.summary ? <div class="result-prompt"><p class="t-xs t-2">{vm.preview.summary || 'Open the result to review its files.'}</p></div> : null}
    {retryPreview && (previewError || receiptError || previewPending) && <div role="status">
      {previewError && <p>Preview couldn’t be loaded. Open the result to review it.</p>}
      {receiptError && <p>Run details couldn’t be loaded. The result is still available to review.</p>}
      {previewPending && <p>Loading preview and run details…</p>}
      {(previewError || receiptError || retrying) && <Button kind="quiet" aria-disabled={previewPending} onClick={()=>{if(!previewPending)retryPreview();}}>Try preview again</Button>}
    </div>}
    <div class="result-footer"><span class="t-xs t-2">{[row.whoShort, row.circle].filter(Boolean).join(' · ')}</span>{dismiss && <Button kind="quiet" onClick={dismiss}>Dismiss</Button>}<Button kind={primary ? 'primary' : 'secondary'} href={row.href}>{vm.resultCopy.action} <Icon name="chev-r" size="sm" /></Button></div>
  </div></Card>;
}

function requestNetworkLine(card) {
  const input = card.safety?.network ?? card.job?.requirements?.network ?? card.network;
  const {mode} = normalizeNetwork({network:input, registries:card.job?.requirements?.registries});
  return ({provider:'AI provider only', 'provider+git':'AI provider + GitHub',
    'provider+registries':'AI provider + package sources', internet:'Public websites'})[mode] ?? '';
}

function requestSourceLine(card, view) {
  if (card.source?.kind === 'none') return 'Prompt only';
  if (card.source?.kind === 'git') return 'Git repository';
  if (card.source?.kind !== 'archive') return '';
  const size = (view.source || '').replace(/^Uploaded files(?: · )?/, '').replace(/\bbytes$/, 'B');
  const counted = size.match(/^(\d+) (files?)\b(.*)$/);
  if (counted) return `${counted[1]} project ${counted[2]}${counted[3]}`;
  return size ? 'Project files · ' + size : 'Project files';
}

function HomePrompt({text}) {
  return <bdi data-telemetry-private="home" class="ph-no-capture">{String(text).split(/(YYYY-MM-DD)/g).map((part, index) =>
    part === 'YYYY-MM-DD' ? <span class="home-prompt-token" key={index}>{part}</span> : part)}</bdi>;
}

function SafetyDetails({facts}) {
  return <details class="home-safety-details ph-no-capture" data-telemetry-private="home">
    <summary class="home-safety-summary"><Icon name="shield" size="sm" />Safety details</summary>
    {facts?.length > 0 && <ul>{facts.map((fact, index) => <li key={index}>{fact.text}</li>)}</ul>}
  </details>;
}

function RequestCard({card, view, primary, capacity, device, now, zone}) {
  const [deferred, setDeferred] = useState(false);
  const deadline = requestDeadlineVM({expiresAt:card.expiresAt, now, zone});
  const safety = requestFactsVM(card, {device, own:view.own});
  const budget = card.safety ? card.safety.budget_minutes : card.runtimeSeconds / 60;
  const minutes = Number.isFinite(budget) && budget > 0
    ? (card.safety ? Math.round(budget) : Math.ceil(budget)) : null;
  const source = requestSourceLine(card, view);
  const network = requestNetworkLine(card);
  const hasAgent = Boolean(card.harness && view.agent &&
    !['Agent', 'Agent not recorded', 'Any agent'].includes(view.agent));
  const context = view.context?.followup
    ? 'Follow-up to ' + view.context.title + (view.context.instruction ? ' · ' + view.context.instruction : '')
    : '';
  const meta = [
    context && {value:context},
    hasAgent && {icon:'terminal', value:view.agent},
    minutes && {icon:'clock', value:'Up to ' + minutes + ' min'},
    source && {icon:'file', value:source},
    network && {icon:'globe', value:network},
    capacity?.text && {icon:'alert', value:<span class="ph-no-capture" role="status" data-telemetry-private="home">{capacity.admission === 'blocked' && !capacity.capped && ['off', 'paused', 'sandbox_not_ready'].includes(capacity.reasonCode) && 'This computer can’t run requests right now. '}{capacity.text}{capacity.capped && <> <a href="#/lend/limits">Raise today's limit</a></>}</span>},
  ].filter(Boolean);
  const deadlineText = deadline.state === 'open' ? deadline.title
    : deadline.state === 'expired' ? deadline.line : 'We can’t tell how long you have to answer. ' + deadline.countdown;
  const deferDescription = deadline.state === 'open' && deadline.exact
    ? 'Keeps it here until ' + deadline.exact + '. You can still decline it on the request page.'
    : 'Leaves the request here for later. You can still decline it on the request page.';
  const status = {label:deadlineText, tone:deadline.state === 'open' ? 'needs' : 'neutral',
    ...(deadline.state === 'open' ? {icon:'clock'} : {})};
  const actions = <>
    {deferred ? <p class="t-xs t-2 ph-no-capture" role="status" data-telemetry-private="home">Still pending{deadline.exact ? ' until ' + deadline.exact : ''}. Review it later.</p>
      : <Button kind="quiet" class="home-not-now ph-no-capture" title={deferDescription} aria-description={deferDescription} onClick={() => setDeferred(true)} data-telemetry-private="home">Not now</Button>}
    <Button class="ph-no-capture" kind={primary ? 'primary' : 'secondary'} href={'#/request/' + enc(card.id)} data-telemetry-private="home">Review request <Icon name="chev-r" size="sm" /></Button>
  </>;
  const actor = view.own ? 'You' : view.requester;
  const verb = view.own ? 'sent a job request' : 'asked to use your computer';
  const prompt = view.context?.instruction ?? view.prompt ?? '';

  return <SwingItemCard class="ph-no-capture" className="home-request" data-view="home" data-state="needs-you"
    actor={actor} verb={verb}
    avatar={<Avatar personName={view.requester} id={view.requesterKey} />}
    status={status}
    title={prompt ? <HomePrompt text={prompt} /> : null}
    meta={meta} disclosure={<SafetyDetails facts={safety.facts} />} actions={actions} data-telemetry-private="home" />;
}

// Clipboard permission can fail even when a draft must be rescued.
export async function copyHomeDraft(text, clipboard = globalThis.navigator?.clipboard) {
  try {
    if (typeof clipboard?.writeText !== 'function') return 'failed';
    await clipboard.writeText(text);
    return 'copied';
  } catch { return 'failed'; }
}

export function DraftCopyFeedback({state, text}) {
  if (state === 'copied') return <p class="ph-no-capture" role="status" data-telemetry-private="home">Copied to clipboard. Paste it somewhere you can keep it before leaving.</p>;
  if (state !== 'failed') return null;
  return <div class="ph-no-capture" role="status" data-telemetry-private="home">
    <p>Copy failed. Select and copy the text below before leaving this page.</p>
    <textarea aria-label="Request text to copy" readOnly value={text} onFocus={event => event.currentTarget.select()} />
  </div>;
}

export function HomeDraftCopy({text}) {
  const [state, setState] = useState('idle');
  const copying = useRef(false);
  const copy = async () => {
    if (copying.current) return;
    copying.current = true; setState('copying');
    try { setState(await copyHomeDraft(text)); }
    finally { copying.current = false; }
  };
  return <div data-telemetry-private="home" class="ph-no-capture">
    <Button kind="secondary" type="button" disabled={state === 'copying'} disabledReason="Copying…" onClick={copy}>{state === 'copying' ? 'Copying…' : 'Copy request text'}</Button>
    <DraftCopyFeedback state={state} text={text} />
  </div>;
}

/** The Home question about an earlier draft names that draft, so the person can tell what they would replace. */
export function homeHandoffCopy(result, now = Date.now()) {
  const quoted = result?.excerpt ? `“${result.excerpt}”` : '';
  const age = Number.isFinite(result?.editedAt) ? formatRelative(result.editedAt, {now}) : '';
  switch (result?.state) {
    case 'replace': return `You have an unsent request from earlier: ${quoted}${age ? ` (edited ${age})` : ''}.`;
    case 'pending': return `Your earlier request ${quoted ? quoted + ' ' : ''}may already have been sent. Check it before starting another.`;
    case 'refused': return `Review your earlier request ${quoted ? quoted + ' ' : ''}before replacing it. Its agent wasn’t available.`;
    case 'preserve': return 'Your new text could not be saved. Copy it now before leaving this page. Clear this input before opening the earlier request. The earlier request has not changed.';
    case 'failed': return 'This browser couldn’t save your request. Copy it now before leaving this page.';
    default: return '';
  }
}

const HOME_DISMISSED_RESULTS = 'faravan-home-dismissed-results';

function readDismissedResults() {
  try {
    const values = JSON.parse(globalThis.localStorage?.getItem(HOME_DISMISSED_RESULTS) ?? '[]');
    return new Set(Array.isArray(values) ? values.filter(value => typeof value === 'string') : []);
  } catch { return new Set(); }
}

export function Home(ctx) {
  const {api, data, circles, agents, lending, circle, mutate, refresh, refreshRunJobs, setDialog, members} = ctx;
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const revision = (data.activity ?? []).filter(event => event.data?.status !== 'transcript').at(-1)?.id ?? 0;
  const jobs = {data: data.jobs ?? null, error: ctx.errors?.jobs};
  const contributions = useResource(api, 'contributions', revision);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const device = safeName(data.devices?.name, 'This computer');
  const lendingView = lendPageVM(data.home, {agents, readiness: data.readiness, approvals:data.approvals, now, zone, showWeeklyQuota:false});
  const [dismissedResults, setDismissedResults] = useState(readDismissedResults);
  const [dismissError, setDismissError] = useState(false);
  function dismissResult(key) {
    const next = readDismissedResults();
    next.add(key);
    try {
      globalThis.localStorage.setItem(HOME_DISMISSED_RESULTS, JSON.stringify([...next]));
      setDismissedResults(next);
      setDismissError(false);
    } catch { setDismissError(true); }
  }
  const options = {devices:data.devices, home:data.home, readiness:data.readiness, agents, lendingBlockers: lendingView.blockers, jobs: jobs.data, approvals: data.approvals, now, zone, owner: data.devices?.ownerName, machine: device, dismissedResults};
  const initial = homePageVM(options);
  const top = initial.result;
  const previewPath=top ? 'jobs/' + enc(top.id) + '/changes' + (top.circleId ? '?circle=' + enc(top.circleId) : '') : null;
  const signedPreview=top ? data.jobs?.find(job => job.job_digest === top.id)?.resultSummary?.receipt : null;
  const [preview,setPreview]=useState({path:null,data:null,receipt:null});
  const [previewAttempt,setPreviewAttempt]=useState(0);
  const previewBusy=useRef(false);
  const [retriedPath,setRetriedPath]=useState(null);
  const retryPreview=()=>{if(previewBusy.current)return;previewBusy.current=true;setRetriedPath(previewPath);setPreviewAttempt(attempt=>attempt+1);};
  useEffect(()=>{
    if(!previewPath)return;
    let active=true;
    previewBusy.current=true;
    setPreview({path:previewPath,data:null,receipt:null,pending:true});
    const reads=[];
    if (!signedPreview) reads.push(loadHomeReceipt(api,previewPath).then(receipt=>{if(active)setPreview(old=>({...old,receipt}));},()=>{if(active)setPreview(old=>({...old,receiptError:true}));}));
    reads.push(loadHomePreview(api,previewPath).then(data=>{if(active)setPreview(old=>({...old,data}));},()=>{if(active)setPreview(old=>({...old,previewError:true}));}));
    Promise.allSettled(reads).then(()=>{if(active){previewBusy.current=false;setPreview(old=>({...old,pending:false}));}});
    return()=>{active=false;previewBusy.current=false;};
  },[api,previewPath,signedPreview,previewAttempt]);
  const vm = homePageVM({...options, changes: preview.path===previewPath ? preview.data : null, receipt: signedPreview ?? (preview.path===previewPath ? preview.receipt : null)});
  // The cards are the approvals the attention count holds: an approval for this computer's own job is not a decision here.
  const cards = (data.approvals ?? []).filter(card => vm.requestIds.has(card.id)).map(card => ({card, view: reviewCard(card, agents, circleMembers(data.devices, card.job?.circle || lending.circle) || members, data.devices?.fingerprint),
    capacity:requestCapacity(data.home,lending,now,card)}));
  const peopleCircle = circles.find(c => c.id === (lending.circle || circle));
  const people = homePeopleVM((data.devices?.circles ?? []).find(c => c.circle === peopleCircle?.id)?.members, {ownId:data.devices?.fingerprint, jobs:data.jobs, circleId:peopleCircle?.id, now, zone});
  const recentPeople = people.filter(member => !member.earlier);
  const inUse = circlesWithCurrentWork(circle, lending, jobs.data ?? []);
  const hostNotices = useMemberHost(api, circles.filter(item => inUse.has(item.id)));
  const plan = homePlan({circles, lending, lendingProjection:lendingView.lendingProjection, agents});
  const loadedAll = Boolean(data.home && data.circles && data.agents && data.jobs && data.approvals);
  const onboarding = onboardingVM({home: data.home, circles, jobs: data.jobs, agents});
  // The owner's other computers look like friends until the devices read says who this person is: withhold the summary until then.
  const ownerIdentified = Boolean(data.devices?.fingerprint);
  const contributionText = ownerIdentified ? contributionLine(contributions.data?.windows?.[7], data.devices.fingerprint, {ownerName:data.devices.ownerName || data.devices.circles?.flatMap(c=>c.members ?? []).find(m=>m.key_id===data.devices.fingerprint)?.personName}) : '';
  const borrowerInUse = plan.borrower || circles.some(item => item?.origin);
  const showBorrowerProgress = Boolean(onboarding.progress && borrowerInUse &&
    onboarding.progress.steps.some(step => !step.done));
  const hasHomeAttention = vm.needs > 0 || cards.length > 0 || vm.pendingRequests.length > 0;
  const unchecked = uncheckedCirclesInUse(data.uncheckedJobCircles, inUse);
  const jobsUnchecked = unchecked.length > 0;
  const homeReadFailed = Boolean(jobs.error || jobsUnchecked || ctx.errors?.home || ctx.errors?.approvals || ctx.errors?.circles);
  const onboardingLoaded = Array.isArray(data.circles) && Array.isArray(data.jobs) && !ctx.errors?.circles && !jobs.error && !jobsUnchecked;
  const showHomeSetup = onboardingLoaded && !hasHomeAttention;
  const homeLendingHeadline = homeLendingSummary(lendingView);
  const homeStale = Boolean(ctx.errors?.home);
  const weeklyQuotas = data.home ? homeProviderQuotaVM(data.home, agents, {now, zone, stale:homeStale}) : [];
  // Text kept from an earlier "Open earlier draft" comes back here with a one-line note.
  const [homePrompt,setHomePrompt] = useState(()=>readHomeText(globalThis.localStorage));
  const [keptNote,setKeptNote] = useState(()=>Boolean(readHomeText(globalThis.localStorage).trim()));
  const [handoff,setHandoff] = useState(null);
  const [discarded,setDiscarded] = useState(null), [draftActionError,setDraftActionError] = useState('');
  const [suggestion,setSuggestion] = useState(null);
  const [handoffPrompt,setHandoffPrompt] = useState(null);
  const chooseSuggestion=prompt=>{if(homePrompt.trim() && prompt!==homePrompt){setSuggestion(prompt);setHandoff(null);setHandoffPrompt(null);return;}transferPrompt(prompt);};
  const transferPrompt = (prompt, choice={}) => {
    setHandoffPrompt(prompt);
    try {
      const storage=globalThis.localStorage;
      const last=storage?.getItem('faravan-compose-circle')??'';
      const destination=composeCircle(circles,last,circle);
      const result=handoffHomeDraft(storage,destination,prompt,choice);
      setHandoff({...result,circleId:destination,circleName:circles.find(item=>item.id===destination)?.name || destination});
      if(result.state==='open'){
        // Text that went into the draft no longer needs keeping here.
        if(!choice.keep)keepHomeText(storage,'');
        setHomePrompt(prompt);setSuggestion(null);location.hash='#/new';
      }
    } catch { setHandoff({state:'failed'}); }
  };
  const discardEarlier = () => {
    if (!discardSavedDraft(globalThis.localStorage,handoff.circleId,handoff.raw)) {
      setDraftActionError('The saved request changed in another tab or could not be discarded. Open the job form again to review it.');return;
    }
    setDiscarded({raw:handoff.raw,circleId:handoff.circleId});setHandoff(null);setDraftActionError('');
  };
  const undoDiscard = () => {
    if (!undoDiscardedDraft(globalThis.localStorage,discarded.circleId,discarded.raw)) {
      setDraftActionError('Another request is now saved or the earlier text could not be restored. Your current text has been kept.');return;
    }
    setDiscarded(null);setDraftActionError('');
  };
  const openComposer = event => {
    event.preventDefault();
    transferPrompt(homePrompt);
  };

  return <div class="home-page ph-no-capture" data-telemetry-private="home">
    <section class="home-compose-entry" aria-label="New job">
      <form onSubmit={openComposer}>
        <label class="sr" for="home-task">Task description</label>
        <input id="home-task" name="task" placeholder="Describe a task…" autoComplete="off" value={homePrompt} onInput={event=>{const value=event.currentTarget.value;setHomePrompt(value);if(keptNote)keepHomeText(globalThis.localStorage,value);setHandoff(null);setSuggestion(null);setHandoffPrompt(null);}} />
        <Button kind={vm.needs || plan.fresh ? 'secondary' : 'primary'} type="submit">{homePrompt.trim() ? 'Continue to job' : 'New job'} <Icon name="chev-r" size="sm" /></Button>
      </form>
      {suggestion!==null && <div role="status"><p>Replace the text you typed with this suggested task?</p><p>{suggestion}</p><Button kind="secondary" onClick={()=>transferPrompt(suggestion)}>Use suggested task</Button><Button kind="quiet" onClick={()=>{setSuggestion(null);setHandoff(null);setHandoffPrompt(null);}}>Keep my text</Button></div>}
      {keptNote && homePrompt.trim() && !handoff && <p class="t-sm t-2" role="status">Your new text is still here. Send it when the earlier request is done.</p>}
      {handoff && handoff.state!=='open' && <div role="status">
        <p>{homeHandoffCopy(handoff, now)}</p>
        {handoff.state==='replace' && <p class="t-sm t-2">If you open the earlier draft, your new text stays in this box.</p>}
        {['preserve','failed'].includes(handoff.state) && <HomeDraftCopy key={handoffPrompt??homePrompt} text={handoffPrompt??homePrompt} />}
        {['replace','pending','refused'].includes(handoff.state) && <SavedRequestPreview key={handoff.raw} text={handoff.text} circle={handoff.circleName}>
          <Button kind="primary" onClick={()=>transferPrompt(handoffPrompt??homePrompt,{keep:true})}>{handoff.state==='pending'?'Check earlier request':handoff.state==='refused'?'Review earlier request':'Continue editing'}</Button>
          {handoff.state==='replace' && <><Button kind="quiet" onClick={discardEarlier}>Discard</Button><Button kind="secondary" onClick={()=>transferPrompt(handoffPrompt??homePrompt,{replace:true})}>Use my new text</Button></>}
        </SavedRequestPreview>}
      </div>}
      {discarded && <div role="status"><p>Saved request discarded.</p><Button kind="secondary" onClick={undoDiscard}>Undo</Button></div>}
      {draftActionError && <p role="alert">{draftActionError}</p>}
    </section>
    {ctx.errors?.approvals && <div role="status"><p>Requests could not be loaded.</p><Button kind="quiet" onClick={()=>refresh()}>Try requests again</Button></div>}
    {homeStale && <div role="status"><p>Computer status is out of date. Check the current state before changing lending.</p><Button kind="quiet" onClick={()=>refresh()}>Check current state</Button></div>}
    <div class="home-lending-line">
      {!data.home && <span role="status">{ctx.errors?.home ? 'This computer’s status could not be loaded.' : 'Loading this computer…'}</span>}
      <a href={lendingView.limitAction?.href || "#/lend"}>
        {homeStale ? 'Last known: '+homeLendingHeadline : homeLendingHeadline}
        {lending.mode && <span> · {lending.mode === 'ask' ? 'Ask each time' : 'Automatic'}</span>}
        {peopleCircle && <span> · {circleName(peopleCircle)}</span>}
        <Icon name="chev-r" size="sm" />
      </a>
    </div>
    <div class="home-grid">
      <div class="home-main stack-6">
        {/* Role-aware first run (onboarding.mjs): borrowing first; lending setup never reads as a blocker before it is started. */}
        {jobs.error && <div role="status" data-home-jobs-error><p>Jobs could not be loaded.{jobs.data?.length ? ' Last known jobs are shown below.' : ''}</p><Button kind="quiet" onClick={() => refreshRunJobs?.()}>Try jobs again</Button></div>}
        {(ctx.errors?.circles || !Array.isArray(data.circles)) && <div role="status"><p>{ctx.errors?.circles ? 'Circle membership could not be loaded.' : 'Checking circle membership…'}</p>{ctx.errors?.circles && <Button kind="quiet" onClick={()=>refresh()}>Try circle membership again</Button>}<a href="#/circles">Open Circles</a></div>}
        {!Array.isArray(data.jobs) && !jobs.error && <p role="status">Checking job history…</p>}

        {data.home?.lendingPrompts?.map(prompt => <LendingPrompt key={prompt.circle} prompt={prompt} limits={data.home?.lending?.limits} agents={agents} mutate={mutate} />)}
        {showHomeSetup && onboarding.entry && <OnboardingEntry entry={onboarding.entry} />}
        <>
          {(hasHomeAttention || !homeReadFailed && (!loadedAll || !onboarding.entry)) && <Section id="home-needs" title={hasHomeAttention ? 'Needs your attention' : 'Requests and results'} link={vm.needs > 0 && <span class="home-count">{vm.needs}</span>}>
            <div class="stack-3">
              {cards.map(({card, view, capacity}, i) => <RequestCard key={card.id} card={card} view={view} capacity={capacity} primary={i === 0} device={device} now={now} zone={zone} />)}
              {vm.pendingRequests.map((request, i) => <Card class="home-request" key={request.id}><div class="request-preview"><Icon name="lend" /><div class="grow"><h3 class="t-title3">Request needs review</h3><p class="t-sm t-2">Open the request to see who is asking.</p></div><Button kind={!vm.result && !cards.length && i === 0 ? 'primary' : 'secondary'} size="sm" href={'#/request/' + enc(request.id)}>Review</Button></div></Card>)}
              {dismissError && <p role="status">This browser couldn’t save the dismissal. The result is still shown.</p>}
              {vm.result && <ResultCard vm={vm} stale={Boolean(jobs.error)} previewError={preview.path===previewPath && preview.previewError} receiptError={preview.path===previewPath && preview.receiptError} retryPreview={retryPreview} previewPending={preview.path===previewPath && preview.pending} retrying={retriedPath===previewPath && preview.path===previewPath && preview.pending} dismiss={vm.resultDismissalKey ? ()=>dismissResult(vm.resultDismissalKey) : undefined} primary={!cards.length && !vm.pendingRequests.length} />}
              {vm.results.length > 1 && <JobRows rows={vm.results.slice(1)} stale={Boolean(jobs.error)} />}
              {vm.blockerItems.map(({item}, i) => <Card key={item.key + (item.agent ?? '')}><div class="request-preview"><Icon name="alert" /><div class="grow"><h3 class="t-title3">{item.label}</h3><p class="t-sm t-2">{item.detail}</p></div><div class="request-actions"><BlockerAction item={item} primary={!vm.result && !cards.length && !vm.pendingRequests.length && !plan.fresh && i === 0} api={api} agents={agents} mutate={mutate} circle={lending.circle || circle} refresh={refresh} latched={lendingView.latched} /></div></div></Card>)}
              {vm.otherItems.map(item => <Card key={item.id || item.label}><div class="card-pad"><p class="t-sm">{item.label || 'Something needs your attention.'}</p>{item.remedy && <p class="t-sm t-2">{item.remedy}</p>}<a href={item.chatgptAction ? "/connect/chatgpt?action=" + enc(item.chatgptAction) : "#/lend"}>{item.chatgptAction ? "Review ChatGPT request" : "Review lending"}</a></div></Card>)}
              {!jobs.error && (!vm.needs && !vm.loaded && !ctx.errors?.home && !ctx.errors?.approvals ? <HomeSkeleton label="Loading requests and results" /> : !vm.needs && <Card><div class="card-pad stack-3"><p class="t-sm t-2">{ctx.errors?.approvals ? 'Requests could not be loaded.' : ctx.errors?.home ? 'This computer’s status could not be loaded.' : !data.approvals || !vm.jobsLoaded ? 'Loading requests and results…' : 'Nothing needs a decision right now.'}</p></div></Card>)}
            </div>
          </Section>}
          {(!loadedAll || !onboarding.entry) && <Section id="home-motion" title="In motion" link={<a href="#/jobs">All jobs <span aria-hidden="true">→</span></a>}>
            {!vm.jobsLoaded && !jobs.error ? <HomeSkeleton label="Loading jobs" /> : <>
              {vm.inMotion.length > 0 && <JobRows rows={vm.inMotion.slice(0, 5)} stale={Boolean(jobs.error)} />}
              {vm.heldOffers.slice(0, Math.max(0, 5 - vm.inMotion.length)).map(offer =>
                <Card key={offer.id}><div class="card-pad"><h3 class="t-title3">Teammate request · {offer.agent}</h3>
                  <p class="t-sm t-2">Waiting · {offer.line}</p></div></Card>)}
              {!vm.inMotion.length && !vm.heldOffers.length && !jobs.error && !jobsUnchecked && <p class="inline-placeholder">No jobs in motion.</p>}
            </>}
          </Section>}
          {vm.unresolvedStops.length > 0 && <Section id="home-unresolved-stops" title="Unresolved stop requests">
            <ul class="stack-3">
              {vm.unresolvedStops.map(row => <li key={row.href}><Card><div class="card-pad stack-2">
                <h3 class="t-title3">{row.title}</h3>
                <p class="t-sm t-2">Lender did not confirm</p>
                <Button kind="secondary" size="sm" href={row.href}>Open</Button>
              </div></Card></li>)}
            </ul>
          </Section>}
          {(!loadedAll || !onboarding.entry) && <Section id="home-recent" title="Recently finished" link={<a href="#/jobs">View history <span aria-hidden="true">→</span></a>}>
            {!vm.jobsLoaded && !jobs.error ? <HomeSkeleton label="Loading recent jobs" /> : vm.recent.length ? <JobRows rows={vm.recent} stale={Boolean(jobs.error)} /> : !jobs.error && !jobsUnchecked && <p class="inline-placeholder">Finished jobs will appear here.</p>}
          </Section>}
        </>
        {showHomeSetup && !onboarding.entry && showBorrowerProgress && <ProgressCard progress={onboarding.progress} />}
        {showHomeSetup && onboarding.lendingSetup && <p><a href="#/setup">Set up lending</a> · Joining does not turn lending on.</p>}
        {loadedAll && <FirstTasks tasks={onboarding.suggestions} onChoose={task => chooseSuggestion(task.prompt)} />}
        {!jobs.error && <JobHistoryNotice uncheckedCircles={unchecked} circles={circles} onRetry={refreshRunJobs} />}
        <MemberHostNotices items={hostNotices} link />
        {(contributionText || contributions.error) && <section class="home-contributions stack-2"><h2 class="t-title3">Your contributions</h2><p class="t-sm t-2">{contributionText || 'Contributions could not be loaded.'}</p><a class="t-sm" href="#/jobs">Open Jobs <span aria-hidden="true">→</span></a></section>}
      </div>
      <section class="home-lending" aria-labelledby="home-computer"><div class="section-h"><h2 id="home-computer">This computer</h2></div>
        {homeStale && data.home ? <Card><div class="card-pad"><p>Last known: {homeLendingHeadline}</p><a href="#/lend">Review computer status</a></div></Card> : data.home ? <><a class="home-phone-lending" href="#/lend"><Icon name="laptop" size="sm" /><InlineStatus kind={lendingView.tone} word={lendingView.headline} /><Icon name="chev-r" size="sm" /></a>
        <LendingCard vm={lendingView} device={device} circle={circle} lending={lending} mutate={mutate} setDialog={setDialog} api={api} agents={agents} refresh={refresh} /></> :
          ctx.errors?.home ? null :
            <HomeSkeleton label="Loading this computer" />}
        {weeklyQuotas.length > 0 && <dl class="card-pad stack-2" aria-label="Weekly quota readings">
          {weeklyQuotas.map(({provider, title, meter}) => <div key={provider}>
            <dt>{title} this week</dt><dd>{meter ? `${meter.value} ${meter.of} · ${meter.note}` : 'No current weekly reading'}</dd>
          </div>)}
        </dl>}
      </section>
      {peopleCircle && people.length > 0 && <section class="home-people" aria-labelledby="home-people"><div class="section-h"><h2 id="home-people">{circleName(peopleCircle)}</h2><a href={'#/circle/' + enc(peopleCircle.id)}>View circle</a></div>
        <Card>{recentPeople.length ? <div class="list">{recentPeople.slice(0, 6).map(member => <div class="row" key={member.id}>
          <Icon name="laptop" /><div class="row-main"><div class="row-title">{member.name}</div><div class="row-meta">{member.state}</div></div>
        </div>)}</div> : <p class="card-pad t-sm t-2">No recent check-ins from other computers.</p>}</Card>
      </section>}
    </div>
  </div>;
}
