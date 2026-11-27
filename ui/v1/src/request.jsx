import {displayVisible} from './display-visibility.mjs';
import {problemView,browserProblemContext} from './problem-catalog.mjs';
import {requestCapacity} from './request-capacity.mjs';
import {ParentJobLink} from './job-parent.jsx';
import {SourceManifest} from './source-choice.jsx';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Connection, Link, Note, enc, circleName, ProblemNotice, OFFLINE_REASON } from './shared.jsx';
import { Avatar, Button, Card, Disclosure, Facts, Icon, Spinner } from './ds/index.mjs';
import { PageSkeleton } from './shell-states.jsx';
import { reviewCard, circleMembers, safeName, decisionTime, errorMessage } from './helpers.mjs';
import { requestReviewVM, requestResolutionVM, requestName, requestHeaderVM, requestDeadlineVM, requestDeclinedVM, requestStartedVM, requestTakenVM, loadRequest, saveRequest } from './request-model.mjs';
import {requestContextVM, requestContextReady, requestProjectVM} from './request-context.mjs';
import { requestFactsVM } from './view-models.mjs';
import { REQUEST_APPROVAL_DISCLOSURE } from './safety-copy.mjs';
import {Markdown} from './result-reader.jsx';

// The one request page (U5): who asked and what, what the job gets and can do on your computer, and a decision card
// beside it. Nothing runs without "Run it", and it stays off until the app says the request is complete, the deadline
// is known and the sandbox protection checks out. The deadline is read from a one-second clock, so the card turns to
// "expired" on time even when no server event arrives.
// Saving a local name re-issues the card for the same job under a new id; follow it instead of calling the old one gone.
export const successorOf = (approvals, jobDigest) => (jobDigest && Array.isArray(approvals) ? approvals.find((c) => c.jobDigest === jobDigest) : null) ?? null;

const store=()=>{try{return globalThis.localStorage;}catch{return null;}};
const jobHref=(digest,circle)=>'#/job/'+enc(digest)+(circle?'/'+enc(circle):'');
const zoneOf=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;

function Head({ title, sub, headingRef }) {
  return (
    <header class="rq-head ph-no-capture" data-telemetry-private="request">
      <a class="back" href="#/home"><Icon name="chev-l" size="sm" />Home</a>
      <h1 class="t-page" ref={headingRef} tabIndex="-1">{title}</h1>
      {sub && <p class="rq-sub">{sub}</p>}
    </header>
  );
}

// The card leaves `data.approvals` once it is answered or times out; the page keeps the last copy it showed so the
// answer (or the expiry) is reported in place instead of jumping to a different page.
export function RequestPage({ id, api, data, errors, refresh, refreshRunJobs, circles, lending, agents, members, mutate, headingRef }) {
  const [now, setNow] = useState(Date.now);
  const [outcome, setOutcome] = useState(null);
  const remembered=useRef(loadRequest(store(),id));
  const lastDigest=useRef(remembered.current?.digest??null);
  const shown=useRef(null);
  const [job,setJob]=useState(null),[jobConfirmedAt,setJobConfirmedAt]=useState(null),[jobReadFailed,setJobReadFailed]=useState(false),[contributions,setContributions]=useState(data.contributions);
  const found = Array.isArray(data.approvals) ? data.approvals.find((c) => c.id === id) : null;
  if (found?.jobDigest) lastDigest.current = found.jobDigest;
  const successor = !found ? successorOf(data.approvals, lastDigest.current) : null;
  // An answered page keeps its answer in view; only an unanswered page follows a re-issued card.
  useEffect(() => { if (successor && !outcome) location.replace('#/request/' + enc(successor.id)); }, [successor?.id]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const live=found||successor;
  if (live) shown.current = live;
  const zone=zoneOf();
  const resolution=requestResolutionVM({id,digest:lastDigest.current,circle:(live||shown.current)?.job?.circle||remembered.current?.circle,activity:data.activity,zone,job});
  // Disappearance does not prove expiry. Recorded outcomes supply the resolution.
  const card = live || (outcome ? shown.current : null);
  useEffect(()=>{if(card?.jobDigest)saveRequest(store(),id,{digest:card.jobDigest,circle:card.job?.circle});},[id,card?.jobDigest]);
  const digest=card?.jobDigest||resolution.digest, jobCircle=card?.job?.circle||resolution.circle;
  // A dated handoff snapshot, not a live job monitor. The job page owns subsequent status and stop controls.
  useEffect(()=>{
    let stopped=false,timer,failures=0;
    const poll=outcome?.kind==='run' && !outcome.pending;
    setJob(null);setJobConfirmedAt(null);setJobReadFailed(false);
    const settled=j=>{const vm=requestStartedVM(j);return vm.canStop||vm.terminal;};
    const read=()=>{
      if(!digest||!api?.get||!displayVisible())return;
      let last=null;
      api.get('jobs/'+enc(digest)+(jobCircle?'?circle='+enc(jobCircle):'')).then(j=>{
        last=j;failures=0;
        if(!stopped){setJob(j);setJobConfirmedAt(Date.now());setJobReadFailed(false);if(requestStartedVM(j).phase==='running')refreshRunJobs?.();}
      }).catch(()=>{failures++;if(!stopped)setJobReadFailed(true);}).finally(()=>{
        if(poll&&!stopped&&!settled(last)&&failures<5)timer=setTimeout(read,2000);
      });
    };
    const visible=()=>{if(displayVisible())read();else clearTimeout(timer);};
    document.addEventListener('visibilitychange',visible);
    if(poll||(!card&&!outcome?.pending))read();
    return()=>{document.removeEventListener('visibilitychange',visible);stopped=true;clearTimeout(timer);};
  },[card?.id,outcome?.kind,outcome?.pending,digest,jobCircle,refreshRunJobs,api]);
  useEffect(()=>{let stopped=false;if(api?.get)api.get('contributions').then(c=>{if(!stopped)setContributions(c);}).catch(()=>{});return()=>{stopped=true;};},[]);
  useEffect(()=>{if(!card&&Array.isArray(data.approvals))headingRef?.current?.focus();},[card?.id]);
  if (!Array.isArray(data.approvals) && errors?.approvals) {
    return (
      <div class="rq ph-no-capture" data-telemetry-private="request">
        <Head title={problemView(errors.approvals?.problem??errors.approvals,browserProblemContext()).title} headingRef={headingRef} />
        <Card><div class="card-pad stack-3">
          <ProblemNotice error={errors.approvals} onRead={refresh}/>
          <div class="hstack-2 wrap"><Button kind="secondary" href="#/home">Back to Home</Button></div>
        </div></Card>
      </div>
    );
  }
  if (!Array.isArray(data.approvals) || (card && !data.devices)) return <PageSkeleton label="Loading the request" />;
  if (!card) {
    return (
      <div class="rq ph-no-capture" data-telemetry-private="request">
        <Head title={resolution.heading} headingRef={headingRef} />
        <Card><div class="card-pad stack-4">
          <p role="status">{jobReadFailed ? requestStartedVM(job,{readFailed:true}).line : job && requestStartedVM(job).phase==='running' ? requestStartedVM(job,{confirmedAt:jobConfirmedAt,zone}).line : resolution.line}</p>
          <div class="hstack-2 wrap">
            {resolution.action && <Button kind="primary" href={resolution.href}>{resolution.action}</Button>}
            <Button kind="secondary" href="#/home">Back to Home</Button>
          </div>
        </div></Card>
      </div>
    );
  }

  const circle = circles.find((c) => c.id === (card.job?.circle || lending?.circle)),
    view = reviewCard(card, agents, circleMembers(data.devices, circle?.id) || members),
    identity = requestReviewVM(card, view, data.devices, contributions,{now,zone}),
    own = identity.own,
    name = identity.name,
    device = requestName(data.devices?.name, ''),
    head = requestHeaderVM({own, name, device, circle: circle ? circleName(circle) : '', sentAt: card.job?.created_at, now, zone}),
    deadline = requestDeadlineVM({offer:card.offer,legacyHold:card.legacyHold,expiresAt: card.expiresAt, now, zone}),
    facts = requestFactsVM(card, { own }),
    checks = [card.job?.verify?.cmd, ...(Array.isArray(card.job?.checks) ? card.job.checks : []).map(check => check?.cmd)].map(cmd => safeName(cmd, '')).filter(Boolean),
    context = requestContextVM(view.prompt),
    contextReady = requestContextReady(context),
    blocked = !contextReady || deadline.state !== 'open' || !view.complete || !view.protectionVerified || !card.jobDigest;
  const project = requestProjectVM(card, view.source, context.followup);
  const parent = card.job?.parent;
  const parentHref = /^sha256:[a-f0-9]{64}$/.test(parent?.job_digest) && /^sha256:[a-f0-9]{64}$/.test(parent?.result_digest) && card.job?.circle ? jobHref(parent.job_digest, card.job.circle) : null;
  const agentLine = [view.account, view.model === 'Any model' ? 'Your default model' : view.model, card.effort ? 'effort ' + card.effort : '', view.minutes && 'up to ' + view.minutes].filter(Boolean).join(' · ');
  const protectionRows = view.protection.rows.filter(([label]) => label !== 'Internet');
  const decisionFacts = facts.facts.filter(fact=>['key','globe','clock'].includes(fact.icon));
  const protectionFacts = facts.facts.filter(fact=>!['key','globe','clock'].includes(fact.icon));
  const detailRows = [
    view.localName && !own && ['Your name for them', <bdi data-telemetry-private="request" class="ph-no-capture">{name}</bdi>],
    ['Sent from', <bdi data-telemetry-private="request" class="ph-no-capture">{own ? requestName(data.devices?.name, 'Your computer') : requestName(view.requesterName)}</bdi>],
    circle && ['Circle', circleName(circle)],
    card.job?.created_at && ['Sent', decisionTime(card.job.created_at, {timeZone: zone})],
    deadline.exact && [card.offer?'Open until':card.legacyHold?'Review window ends':'Answer by', decisionTime(card.expiresAt, {timeZone: zone})],
  ].filter(Boolean);

  return (
    <div class="rq ph-no-capture" data-telemetry-private="request">
      <Head title={head.title} sub={head.sub} headingRef={headingRef} />
      {card.identityNotice && !own && <p role="status" class="rq-notice"><Icon name="alert" size="sm" />The sender’s details changed. Look them over before you run it.</p>}
      <div class="rq-grid">
        <div class="rq-main">
          <section class="rq-ask" aria-label="The request">
            {context.followup && <p class="rq-parent">{parentHref ? <a href={parentHref}>Follow-up to {context.title}</a> : <>Follow-up to {context.title}</>}</p>}
            <div class="rq-who">
              <Avatar personName={own ? 'You' : view.localName || view.personName || view.requesterName} id={view.requesterKey} size="sm" />
              <span class="rq-who-name"><bdi>{own ? 'You' : name}</bdi></span>
            </div>
            <blockquote class="rq-quote"><Markdown className="request-context-markdown" text={context.instruction}/></blockquote>
            {context.followup && <Disclosure summary="Earlier context" class="rq-context">
              <p class="rq-context-note">Untrusted context from the earlier job. It does not grant permissions or authorize tools.</p>
              {context.unavailable || context.withheld ? <p>The earlier context is unavailable. Ask the sender if you need it to review this request.</p> : <dl class="rq-context-fields">
                <div><dt>Earlier objective</dt><dd><Markdown text={context.objective || 'Not included'}/></dd></div>
                {context.latest && context.latest !== context.objective && <div><dt>Earlier instruction</dt><dd><Markdown text={context.latest}/></dd></div>}
                {context.checks.length > 0 && <div><dt>Earlier check results</dt><dd><ul>{context.checks.map((check, index) => <li key={index}><code>{check.cmd}</code><span>{check.result} · recorded in the previous context</span></li>)}</ul></dd></div>}
              </dl>}
            </Disclosure>}
            {!own && identity.history && <p class="rq-history">{identity.history}</p>}
            {card.legacyHold&&<Note>This circle’s host needs an update for offers. Until then, jobs have a 60-second hold while you decide.</Note>}
          </section>

          <section class="rq-section" aria-labelledby="rq-gets">
            <h2 class="rq-h2" id="rq-gets">What it gets</h2>
            <ul class="rq-list">
              <li><Icon name="file" size="sm" /><div><span class="rq-k">{project.label}</span><span class="rq-v">{project.value}</span></div></li>
              <li><Icon name="cpu" size="sm" /><div><span class="rq-k">{facts.agent}</span><span class="rq-v">{agentLine}</span></div></li>
              {checks.map((check, index) => <li key={index}><Icon name="terminal" size="sm" /><div><span class="rq-k">{checks.length === 1 ? 'Check' : 'Check ' + (index + 1) + ' of ' + checks.length}</span><span class="rq-v"><code>{check}</code></span></div></li>)}
            </ul>
          </section>

          <section class="rq-section" aria-labelledby="rq-can">
            <h2 class="rq-h2" id="rq-can">{facts.heading}</h2>
            <div class="rq-facts"><Facts items={decisionFacts} label={facts.heading} /></div>
          </section>

          <div class="rq-more">
            <Disclosure summary="Files being sent">{card.sourceManifest || card.job?.source_manifest ? <SourceManifest manifest={card.sourceManifest || card.job.source_manifest} compact/> : <p>{own ? 'File list unavailable.' : 'File list unavailable. Ask the sender to confirm the files before approving.'}</p>}</Disclosure>
            <Disclosure summary="Protection details" rows={protectionRows}>
              <p class="t-xs t-2">{view.protection.sourceNetworkNote}</p>
              <Facts items={protectionFacts} label="Sandbox protections"/>
              <p class="rq-caption">Checked again right before the job starts.</p>
            </Disclosure>
            <Disclosure summary="Details" rows={detailRows} />
          </div>
        </div>

        <aside class="rq-decide" aria-label="Your answer">
          <Decision {...{jobConfirmedAt, jobReadFailed, contextReady, contextWithheld: context.withheld, card, own, name, deadline, outcome, setOutcome, blocked, view, mutate, job, zone, data, refresh}} />
        </aside>
      </div>
    </div>
  );
}

export function Decision({ jobConfirmedAt, jobReadFailed = false, contextReady = true, contextWithheld = false, card, own, name, deadline, outcome, setOutcome, blocked, view, mutate, job, zone, data, refresh }) {
  const [deferred, setDeferred] = useState(false);
  const href = jobHref(card.jobDigest, card.job?.circle);
  const {offline}=useContext(Connection), answering=useRef(false);
  const capacity=requestCapacity(data?.home, data?.home?.lending, Date.now(), card);
  // A decision or deadline may remove the focused control. Move focus to the result only when that happens.
  const said = useRef(), runAction = useRef(), lastDecisionFocus = useRef(null), [focusHandoff, setFocusHandoff] = useState(false), key = `${outcome?.kind || 'none'}:${deadline.state}:${deferred}`, previous = useRef(key);
  useLayoutEffect(() => {
    const rememberFocus = event => {
      lastDecisionFocus.current = event.target.closest?.('.rq-decide') ? event.target : null;
    };
    document.addEventListener('focusin', rememberFocus);
    return () => document.removeEventListener('focusin', rememberFocus);
  }, []);
  useEffect(() => {
    const was = previous.current; previous.current = key;
    if (was !== key && typeof document !== 'undefined') {
      const focusedControlDisappeared = Boolean(lastDecisionFocus.current && !lastDecisionFocus.current.isConnected);
      setFocusHandoff(focusedControlDisappeared);
      if (focusedControlDisappeared) {
        const target=!deferred&&(!outcome||outcome.kind==='error')&&deadline.state==='open'&&!blocked&&!offline&&capacity.canRun ? runAction.current?.querySelector('button') : said.current;
        target?.focus();
      }
    }
  }, [key]);
  const answer = async kind => {
    if(answering.current||offline||(kind==='run'&&(blocked||!capacity.canRun)))return;
    answering.current=true;
    // Keep this card and this page’s own answer before mutate can refresh approvals away.
    setOutcome({kind, pending:true});
    try {
      await mutate('approvals/' + enc(card.id) + (kind === 'run' ? '/accept' : '/decline'), {});
      setOutcome({kind});
    } catch (error) {
      // Another computer already holds the job: nothing ran here, and offering Run it again cannot help.
      if(error?.code==='job_taken')setOutcome({kind:'taken', line:requestTakenVM({taker:error.taker, name})});
      else {answering.current=false;setOutcome({kind:'error', message:errorMessage(error)});}
    }
  };
  if (outcome?.kind === 'run') {
    const started = requestStartedVM(job, {device: 'your computer', zone, accepted: !outcome.pending, pending: outcome.pending, readFailed: jobReadFailed, confirmedAt: jobConfirmedAt});
    const waiting = started.transitional === true;
    return (
      <div class="rq-card is-done ph-no-capture" data-telemetry-private="request">
        <p class="rq-state" ref={said} tabIndex="-1" role="status" aria-live="polite">{waiting ? <Spinner /> : <Icon name={started.terminal||started.phase==='unknown' ? 'alert' : 'check'} size="sm" />}<span>{started.line}</span></p>
        {started.canStop && <p class="rq-hint">To stop this job, open it and choose Stop.</p>}
        <Button kind="primary" href={href}>{started.canStop ? 'Open job and stop controls' : 'Open the job'}</Button>
      </div>
    );
  }
  if (outcome?.kind === 'taken') {
    return (
      <div class="rq-card is-done ph-no-capture" data-telemetry-private="request">
        <p class="rq-state" ref={said} tabIndex="-1" role="status" aria-live="polite"><Icon name="alert" size="sm" /><span>{outcome.line}</span></p>
        <Button kind="secondary" href="#/home">Back to Home</Button>
      </div>
    );
  }
  if (outcome?.kind === 'pass' || deadline.state === 'expired' || deadline.state === 'review-ended') {
    return (
      <div class="rq-card is-done ph-no-capture" data-telemetry-private="request">
        <p class="rq-state" ref={said} tabIndex="-1" role={outcome ? 'status' : undefined} aria-live={outcome ? 'polite' : undefined}>{outcome ? null : <Icon name="clock" size="sm" />}<span>{outcome?.kind === 'pass' ? (outcome.pending ? 'Declining this request…' : requestDeclinedVM({offer:card.offer,own, name})) : deadline.line}</span></p>
        {!outcome && ['expired','review-ended'].includes(deadline.state) && !focusHandoff && <p class="sr" role="status" aria-live="polite">{deadline.line}</p>}
        {outcome?.kind === 'error' && <p role="alert" class="rq-answer-error">{outcome.message}</p>}
        {card.offer && deadline.state === 'expired' && <p class="rq-hint">Its deadline has passed. This job is no longer available to accept.</p>}
        <Button kind="secondary" href="#/home">Back to Home</Button>
      </div>
    );
  }
  if (deferred) return <div class="rq-card ph-no-capture" data-telemetry-private="request">
    <p class="rq-state" ref={said} tabIndex="-1" role="status">Still pending{deadline.exact ? ' until ' + deadline.exact : ''}. You can review it later.</p>
    <Button kind="secondary" href="#/home">Back to Home</Button>
    <Button kind="secondary" onClick={() => setDeferred(false)}>Review again</Button>
  </div>;
  return (
    <div class="rq-card ph-no-capture" data-telemetry-private="request">
      {outcome?.kind === 'error' && <p ref={said} tabIndex="-1" role="alert" class="rq-answer-error">{outcome.message}</p>}
      <p class={'rq-clock' + (deadline.urgent ? ' urgent' : '')} title={deadline.title}>
        <Icon name="clock" size="sm" /><span aria-hidden={!card.offer && deadline.state!=='unknown' ? 'true' : undefined}>{deadline.countdown}</span>
        {!card.offer && deadline.exact && <span class="rq-exact">by {deadline.exact}</span>}
      </p>
      {capacity.text && <p class="rq-hint" role="status">{capacity.text}</p>}
      {capacity.capped && <Button kind="secondary" href="#/lend/limits">Raise today's limit</Button>}
      {capacity.admission === 'unknown' && refresh && <Button kind="secondary" onClick={() => refresh()}>Refresh status</Button>}
      <p class="rq-hint rq-disclosure">{REQUEST_APPROVAL_DISCLOSURE.split('AI-provider').flatMap((part, i) => i ? [<span class="nowrap">AI-provider</span>, part] : [part])}</p>
      {(blocked||offline||!capacity.canRun) && <p class="rq-hint" ref={said} tabIndex="-1">Approval is unavailable. Review the request details and status before approving.</p>}
      {!contextReady && <p role="alert">{contextWithheld ? "Earlier context was withheld by a safety scan. Approval is blocked. Ask the sender to review and remove unsafe material before sending a new request." : "We couldn’t read the complete request. Ask the sender to resend it."}</p>}
      <div class="rq-actions">
        <Button kind="secondary" onClick={() => setDeferred(true)}>Not now</Button>
        <span class="rq-run-action" ref={runAction}><Button kind="primary" disabled={blocked||offline||!capacity.canRun} disabledReason={offline ? OFFLINE_REASON : blocked ? 'This request can’t be run yet.' : capacity.text || 'This computer can’t run it right now.'} onClick={() => answer('run')}>Run it</Button></span>
      </div>
      <Button kind="secondary" disabled={offline} disabledReason={OFFLINE_REASON} onClick={() => answer('pass')}>Decline</Button>
      <p class="rq-hint rq-help">Not now keeps this request pending until its deadline. {card.offer ? "Decline removes it from this computer; other lenders can still run it." : "Decline returns it to the circle; other lenders can still run it."}</p>
      {(!view.complete || !card.jobDigest) && <Note>We couldn't load everything needed to review this job. Refresh this page.</Note>}
      {!view.protectionVerified && (
        <p class="rq-hint"><strong>{data.home?.lending_blockers?.first?.detail || 'This job’s safety checks are not confirmed.'}</strong> <Link page="setup">Open Setup</Link></p>
      )}
    </div>
  );
}
