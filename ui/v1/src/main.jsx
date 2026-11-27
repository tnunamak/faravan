import {ProfileMigrationNotice} from './profile-migration.jsx';
import {focusOutcome} from './focus.mjs';
import { useRef, useEffect, useLayoutEffect, useState, useMemo, useCallback } from 'preact/hooks';
import { Link, enc, Notices, Connection, Action, Note, go, Confirm } from './shared.jsx';
import { ROUTES, routeFromHash, formatTime, errorMessage, approvalTitle, newApprovalIds, approvalNotificationTitle, approvalNotificationBody, lendingControlBody } from './helpers.mjs';
import { createMutationGate, watchUpdates, createApi, guardApi, heldError, WRITES_ALWAYS } from './api.mjs';
import { Home } from './home.jsx';
import {Person} from './people.jsx';
import { Devices, Circles, Circle } from './circles.jsx';
import { Lend } from './lend.jsx';
import { LimitsPage } from './limits.jsx';
import { Setup } from './setup.jsx';
import { SignInProgress } from './signin.jsx';
import { Palette } from './palette.jsx';
import { Compose } from './compose.jsx';
import { Host } from './host.jsx';
import { Jobs, Job } from './jobs.jsx';
import { RequestPage } from './request.jsx';
import { loadHomeReceipt } from './home-preview.mjs';
import { Settings, RequestNotificationBanner } from './info.jsx';
import { Accounts } from './accounts.jsx';
import { jobAnnouncements } from './announcements.mjs';
import { createReadQueue } from './read-queue.mjs';
import { eventRevisesPages, eventRefreshesShell, eventScopeOf, revisionSignature } from './revision-signal.mjs';
import { JOB_REVISIONS, reviseForEvent, reviseForShell } from './job-revision.mjs';
import { bannerErrors } from './banner-errors.mjs';
import { restartBanner } from './update-restart.mjs';
import { takeFieldFocus, findField } from './deep-link.mjs';
import { takeJoinPrefill } from './join-prefill.mjs';
import { render } from 'preact';
import { Sprite } from './ds/sprite.jsx';
import { Shell, SKIP_TARGET } from './shell.jsx';
import { useLendingReadiness } from './lending-readiness-read.mjs';
import { ConnectionBanner, UpdateToast, PageSkeleton } from './shell-states.jsx';
import { connectionVM, updateVM, trackFreshness, REQUIRED_RESOURCES, trackAgentChecks, lendingSubtitle, lendPageVM, jobStateKey } from './view-models.mjs';
import {membershipProjectionFor} from './membership-projection-view.mjs';
import {composeCircle} from './compose-model.mjs';
import { Button, Icon } from './ds/index.mjs';
import './tokens.css';
import './components.css';
import './shell.css';
import './styles.css';
import './lend.css';
import './setup.css';
import './jobs.css';
import './job-thread.css';
import './compose.css';
import './host.css';
import './people.css';
import './home.css';
import './request.css';
import './connection.css';
import './telemetry.css';
import { joinReceipt, applyJoinReceipts } from './join-receipts.mjs';
import { FirstRunCard, TelemetryPreview } from './telemetry-ui.jsx';
import {browserOnboarding,browserDevice} from './posthog-facts.mjs';
import { connectBrowserPolicy } from './posthog-policy.mjs';
import { telemetryStore } from './telemetry-store.mjs';
import { createFriction, instrumentApi, hasUnsentCompose } from './telemetry.mjs';

const FAST_RESOURCES = ['home', 'circles', 'agents', 'devices', 'approvals', 'activity', 'jobs', 'updates'];
// What a job event can change: the lists that show jobs, approval cards, activity and Home (judge r12 R12-2).
const JOB_SHELL = ['approvals', 'activity', 'jobs', 'home'];
const READINESS = ['readiness'];

export function MainNotice({notice}) {
  return <div class="notice sr ph-no-capture" data-telemetry-private="main-notice" role="status" aria-live="polite">{notice}</div>;
}

export function App(props) {
  const generation = useRef(0);
  const key = useMemo(() => ++generation.current, [props.api]);
  // A different client owns a different shell lifetime, including its queued reads and view state.
  return <AppSession key={key} {...props} />;
}

function AppSession({ api, takeJoinLink, viewerSession = {kind: 'local'}, friction = null, browser = null, telemetryPolicy = null }) {
  const [route, setRoute] = useState(() => routeFromHash(location.hash)),
    [revision, setRevision] = useState(0),
    [jobRevisions, setJobRevisions] = useState(JOB_REVISIONS),
    [connected, setConnected] = useState(null),
    [online, setOnline] = useState(() => navigator.onLine !== false),
    [phone,setPhone]=useState(()=>matchMedia('(max-width: 899px)').matches);
  const [data, setData] = useState({}),
    [errors, setErrors] = useState({}),
    [freshness, setFreshness] = useState({});
  const circlesReadStarted = useRef(0);
  const [circlesSnapshot, setCirclesSnapshot] = useState(null);
  const getCirclesReadBarrier = useCallback(() => circlesReadStarted.current, []);
  const [handledUpdateVersions, setHandledUpdateVersions] = useState([]);
  const [circle, setCircle] = useState(''),
    [dialog, setDialog] = useState(null),
    [palette, setPalette] = useState(false),
    [pauseRequested, setPauseRequested] = useState(false),
    [jobsHaveRows, setJobsHaveRows] = useState(false),
    [notice, setNotice] = useState(''),
    // An update's "restarting" event arrives just before the app closes; the banner stays until the app is back.
    [restart, setRestart] = useState(null),
    [joinReceipts, setJoinReceipts] = useState({});
  // A notice belongs to the page it was raised on: a result that arrives after navigation is dropped.
  const pageId = useRef(0),
    notices = useMemo(
      () => ({
        page: () => pageId.current,
        set: (text, page) => {
          if (page === undefined || page === pageId.current) setNotice(text);
        },
      }),
      [],
    );
  useEffect(() => {
    pageId.current++;
    setNotice('');
  }, [route.page, route.id, route.circle]);
  // Friction is derived here from the route and the errors the app already holds (telemetry.mjs); it sends words, never text.
  useEffect(() => { friction?.setRoute(route.page); browser?.page(route.page); }, [route.page]);
  useEffect(() => { friction?.errors(errors); }, [errors]);
  const operations = useRef(null);
  if (!operations.current) operations.current = createMutationGate(api);
  const [draft, setDraft] = useState({
    title: '',
    prompt: '',
    kind: 'files',
    git: '',
    commit: '',
    files: [],
    excluded: [],
    agent: '',
    model: '',
    review: false,
    submission: null,
  });
  const groups = useRef({}), signatures=useRef({}), lastValues=useRef({}),
    active = useRef(true),
    heading = useRef();
  // Each resource has its own queue: a slow optional read cannot hold the page or an action.
  const readResource = useCallback(async (resource, signal) => {
    const circlesReadId = resource === 'circles' ? ++circlesReadStarted.current : null;
    let ok = false;
    try {
      let value = await api.get(resource, signal, resource === 'jobs' ? {'x-faravan-job-history':'1'} : undefined);
      const jobCoverage = resource === 'jobs' && Array.isArray(value?.items) ? value : null;
      if (jobCoverage) value = jobCoverage.items;
      if (resource === 'jobs' && Array.isArray(value)) {
        value = await Promise.all(value.map(async job => {
          if (['ran','received'].includes(job.role) || jobStateKey(job) !== 'ready' || !job.circle?.id || !job.job_digest) return job;
          try {
            const receipt = await loadHomeReceipt(api, 'jobs/' + enc(job.job_digest) + '/changes?circle=' + enc(job.circle.id));
            const signed = receipt?.receipt;
            if (signed?.candidate_format !== 'diff' || !Number.isSafeInteger(signed.diffstat?.files)) return job;
            return {...job, resultSummary:{noChanges:signed.diffstat.files === 0, receipt:{receipt:{candidate_format:signed.candidate_format,diffstat:signed.diffstat}}}};
          } catch { return job; }
        }));
      }
      ok = true;
      if (active.current) {
        // Publish raw rows and causal read id together, including JSON-equal successes.
        if (resource === 'circles' && Array.isArray(value) && !signal?.aborted)
          setCirclesSnapshot(old => !old || circlesReadId > old.readId
            ? {readId: circlesReadId, rows: value} : old);
        // A successful revalidation alone must not invalidate every page reader.
        const signature=revisionSignature(resource,value);
        if(signatures.current[resource]!==signature){
          const previouslyLoaded=signatures.current[resource]!==undefined;
          signatures.current[resource]=signature;
          const before=lastValues.current[resource];
          setJobRevisions(old=>reviseForShell(old,resource,before,value));
          // The first shell snapshot supplies context; it does not make an
          // already loaded page stale. Later changes and SSE invalidate it.
          if(previouslyLoaded)setRevision(revision=>revision+1);
        }
        lastValues.current[resource]=value;
        const key = resource === 'updates' ? 'updateStatus' : resource;
        setData(old => {
          const uncheckedJobCircles = resource === 'jobs' ? jobCoverage?.uncheckedCircles ?? [] : old.uncheckedJobCircles;
          const jobCircleCoverage = resource === 'jobs' ? jobCoverage?.circleCoverage : old.jobCircleCoverage;
          if (JSON.stringify(old[key]) === JSON.stringify(value) &&
              JSON.stringify(old.uncheckedJobCircles) === JSON.stringify(uncheckedJobCircles) &&
              JSON.stringify(old.jobCircleCoverage) === JSON.stringify(jobCircleCoverage)) return old;
          return {...old, uncheckedJobCircles, jobCircleCoverage, [key]: resource === 'agents' ? trackAgentChecks(old.agents, value, Date.now()) : value};
        });
        setErrors(old => { if (!old[resource]) return old; const next = {...old}; delete next[resource]; return next; });
      }
    } catch (error) {
      // Only unmounting cancels a shell read; a deadline arrives as read_timeout.
      if (error?.name === 'AbortError') return 'cancelled';
      if (active.current) setErrors(old => ({...old, [resource]: error}));
    }
    if (active.current) setFreshness(old => trackFreshness(old, [resource], [ok], new Date().toISOString()));
    return ok ? 'ok' : 'failed';
  }, [api]);
  // `force` is for a person's own action (a save, Retry): it never waits for the spacing between background reads.
  const load = useCallback((resource, {force = false} = {}) => {
    if (!active.current) return Promise.resolve();
    const queue = (groups.current[resource] ||= createReadQueue(signal => readResource(resource, signal), {whileHidden:resource==='approvals'}));
    return queue.load({force});
  }, [readResource]);
  const refreshAll = useCallback((resource, force) => {
    if(resource==='jobs')return load('jobs',{force});
    for(const name of [...READINESS,...FAST_RESOURCES])if(name!=='home')load(name,{force});
    return load('home',{force});
  }, [load]);
  // Called after a person's own action or Retry; `refresh('jobs')` from a page mount stays a background read.
  const refresh = useCallback(resource => refreshAll(resource, resource!=='jobs'), [refreshAll]);
  // The request page has a fresher per-job start read than the shell list. Once the lender's job confirms execution,
  // refresh that list immediately so the sidebar follows the same active lifecycle state.
  const refreshRunJobs = useCallback(() => load('jobs', {force:true}), [load]);
  // An urgent (readiness) refresh forces only the reads that carry readiness: Home (the lending status) and the
  // request cards (each card's own admission, which enables Run it). The rest keep their spacing, so the page never
  // says "Done for today" beside an enabled Run it, or the reverse.
  const URGENT = ['home', 'approvals'];
  // A job event names one job, so it reads only what lists jobs or shows their state; circles, agents, devices and
  // readiness have their own events (judge r12 R12-2).
  const refreshJobShell = useCallback(() => {
    for (const name of JOB_SHELL) if (name !== 'home') load(name);
    return load('home');
  }, [load]);
  const refreshQuietly = useCallback((urgent = false, scope = 'all') => {
    // Approval notifications remain time-sensitive while the optional visual reads are paused.
    if(scope==='approvals')return load('approvals');
    if (urgent !== true) return scope === 'job' ? refreshJobShell() : refreshAll(undefined, false);
    for (const name of [...READINESS, ...FAST_RESOURCES]) if (!URGENT.includes(name)) load(name);
    load('approvals', {force: true});
    return load('home', {force: true});
  }, [refreshAll, refreshJobShell, load]);
  useEffect(() => {
    active.current = true;
    const banner = restartBanner(setRestart, setConnected);
    // Phone access changes arrive as `phone` events with the same object as GET /api/phone (shell-access-integration.md).
    // Update checks and staging arrive as `update` events with the GET /api/updates view; Settings › Updates shows the
    // latest one without polling. The restarting banner is separate (restartBanner).
    const onEvent = event => {
      banner.onEvent(event);
      telemetryPolicy?.event(event);
      if (event.type === 'phone' && event.data) setData(old => ({...old, phone: event.data}));
      if (event.type === 'update' && event.data && event.data.state !== 'restarting') setData(old => ({...old, updateStatus: event.data}));
      // A page can revalidate its own small resource before a slow shell read
      // finishes. The resource reader coalesces bursts and keeps its read budget.
      if(eventRevisesPages(event)){setRevision(revision=>revision+1);setJobRevisions(old=>reviseForEvent(old,event));}
    };
    const stop = watchUpdates(api, refreshQuietly, value => { banner.onConnection(value); telemetryPolicy?.connection(value); }, {onEvent,minRefresh:5000,refreshes:eventRefreshesShell,urgent:event=>event.type==='readiness',scopeOf:eventScopeOf,hiddenScope:'approvals'});
    return () => {
      active.current = false;
      stop();
      for (const queue of Object.values(groups.current)) queue.stop();
      groups.current = {};
    };
  }, [api, refreshQuietly]);
  // Approvals are polled here, on every page, so the tab title and system
  // notifications reach a lender who is not looking at the Lend page.
  const seenApprovals = useRef(null);
  // Leaving a job page must not leave its words on the tab while approvals are still loading (r8 O16).
  useEffect(() => { if (route.page !== 'job' && !Array.isArray(data.approvals)) document.title = approvalTitle(0); }, [route.page, data.approvals]);
  useEffect(() => {
    const cards = Array.isArray(data.approvals) ? data.approvals : null;
    if (!cards) return;
    if (route.page !== 'job') document.title = approvalTitle(cards.length);
    const fresh = newApprovalIds(cards, seenApprovals.current || []);
    const firstLoad = seenApprovals.current === null;
    seenApprovals.current = [...(seenApprovals.current || []), ...fresh];
    // Requests already open when the app loads were announced by the title;
    // only new arrivals raise a notification, and each id at most once.
    if (firstLoad || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible' && route.page === 'lend') return;
    for (const id of fresh) {
      const card = cards.find((c) => c.id === id);
      try {
        const note = new Notification(approvalNotificationTitle(card, data.devices?.fingerprint), { body: approvalNotificationBody(card), tag: 'faravan-approval-' + id });
        note.onclick = () => { window.focus(); go('lend'); note.close(); };
      } catch {
        // Some browsers only allow notifications from a service worker; the tab title still counts.
      }
    }
  }, [data.approvals, data.devices?.fingerprint, route.page]);
  useEffect(() => {
    const listener = () => setRoute(routeFromHash(location.hash));
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);
  // Move focus to the heading when the person navigates inside the app, never on the first load: the first Tab
  // must reach the "Skip to content" link. The palette closes with the route.
  const firstRoute = useRef(true);
  useLayoutEffect(() => {
    setPalette(false);
    const field = takeFieldFocus();
    if (firstRoute.current) { firstRoute.current = false; return; }
    let focused = null;
    const focusHeading = () => {
      const active = document.activeElement;
      if (focused?.isConnected && active !== focused) return;
      // A search result or Settings map row asked for one field: land there once it renders, else on the heading.
      const wanted = findField(field);
      if (wanted) {
        if (wanted !== focused) {
          if (wanted.tabIndex < 0 && !wanted.hasAttribute('tabindex')) wanted.tabIndex = -1;
          wanted.focus(); wanted.scrollIntoView?.({block: 'center'}); focused = wanted;
        }
        return;
      }
      const target = heading.current?.isConnected ? heading.current : document.querySelector('h1');
      if (target && target !== focused) {
        target.tabIndex = -1;
        target.focus(); focused = target;
      } else if (!target && (active === document.body || !focused)) {
        document.querySelector('main')?.focus();
      }
    };
    focusHeading();
    // Follow delayed or replaced headings until the person starts another interaction.
    const observer = new MutationObserver(focusHeading);
    observer.observe(document.getElementById('app'), {childList:true, subtree:true});
    const stop = () => observer.disconnect();
    window.addEventListener('pointerdown', stop, {once:true});
    window.addEventListener('keydown', stop, {once:true});
    return () => {
      observer.disconnect();
      window.removeEventListener('pointerdown', stop);
      window.removeEventListener('keydown', stop);
    };
  }, [route.page, route.id, route.circle]);
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  useEffect(()=>{
    const media=matchMedia('(max-width: 899px)'),change=()=>setPhone(media.matches);
    media.addEventListener('change',change);
    return()=>media.removeEventListener('change',change);
  },[]);
  const circles = useMemo(() => applyJoinReceipts(data.circles || [], joinReceipts), [data.circles, joinReceipts]),
    agents = data.agents || [],
    home = data.home || {},
    lending = home.lending || {},
    members = (data.devices?.circles || []).flatMap((x) => x.members || []);
  useEffect(() => {
    if (circles.length && !circles.some((c) => c.id === circle))
      setCircle(composeCircle(circles,'','')||(circles.find(c=>c.selected)||circles[0]).id);
  }, [circle, circles]);
  const selected = circles.find((c) => c.id === circle);
  // Every write goes through here. While the page shows old data (a read failed, or the browser is offline) nothing
  // is written, whoever holds a captured callback (an open confirmation, a key, the palette); only stopping lending
  // stays available, because pausing or stopping must never wait for a connection check.
  const held = useRef(false);
  // Pages write through `guarded.post` too (the composer, sign-in), so they are held with the rest.
  const guarded = useMemo(() => guardApi(api, () => held.current), [api]);
  // The Lending dot in the sidebar needs the same lending checks the Setup page reads (read once readiness and agents are in).
  const lendingChecks = useLendingReadiness(data.readiness && data.agents ? guarded : null, data.readiness, data.agents);
  useEffect(() => { browser?.onboarding(browserOnboarding(route.page,data,{circle:selected,lendingReadiness:lendingChecks.value,lendingReadinessError:lendingChecks.error})); }, [route.page,data,lendingChecks.value,lendingChecks.error,selected]);
  // `quiet` is for background checks the person did not ask for: they refresh at the background pace.
  const mutate = async (path, body, {quiet = false} = {}) => {
    if (held.current && !WRITES_ALWAYS.test(path)) throw heldError();
    const result = await operations.current(path, lendingControlBody(path, body, lending));
    const receipt = joinReceipt(path, result, data.circles);
    if (receipt) setJoinReceipts(old => ({...old, [receipt.circle]: receipt}));
    await (quiet ? refreshQuietly() : refresh());
    // A circle write shows from the circle list, which the refresh above starts but does not wait for. Wait for it here,
    // so the control that asked for the change does not finish before the list shows the saved value. A join shows its
    // own receipt instead (joinReceipt), so it does not wait for the list.
    if (path.startsWith('circles/') && path !== 'circles/join') await load('circles', {force: true});
    return result;
  };
  // While a join waits for approval, ask the queue for the signed roster every few seconds.
  const waitingJoins = circles
    .filter((c) => membershipProjectionFor(c).phase === 'pending')
    .map((c) => c.id)
    .join(',');
  useEffect(() => {
    if (!waitingJoins) return;
    const timer = setInterval(() => {
      for (const id of waitingJoins.split(','))
        mutate('circles/' + enc(id) + '/check', {}, {quiet: true}).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [waitingJoins]);
  // Keys: ⌘K or Ctrl+K opens search and ⌘, or Ctrl+, opens Settings from anywhere; N (new job) and Shift+P (pause lending) work
  // outside text fields. Nothing runs without the key being pressed.
  const pauseLending = () => { setPauseRequested(true); go('lend'); };
  useEffect(() => {
    const keys = (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === ',') {
        event.preventDefault();
        location.hash = '#/you/all';
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || palette || dialog) return;
      if (/^(input|textarea|select)$/i.test(event.target?.tagName || '') || event.target?.isContentEditable) return;
      if (event.key === 'n' && ['home', 'jobs'].includes(route.page)) { event.preventDefault(); go('borrow'); }
      else if (event.key === 'P' && event.shiftKey && lending.enabled) { event.preventDefault(); pauseLending(); }
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  });
  // Job-state changes are spoken through the notice region once per job, run and state; they never move focus.
  const announced = useRef({seen: null, text: ''});
  useEffect(() => {
    const next = jobAnnouncements(announced.current.seen, data.jobs, {machine: data.devices?.name ?? '', devices: data.devices, open: route.page === 'job' ? route.id : null});
    announced.current.seen = next.seen;
    if (next.messages.length) { announced.current.text = next.messages.join(' '); setNotice(announced.current.text); }
  }, [data.jobs]);
  useLayoutEffect(() => { if (notice && notice !== announced.current.text && document.activeElement === document.body) focusOutcome(); });
  const connection = connectionVM({ connected, online, errors: bannerErrors(errors), freshness, phone, zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const context = {
    api: guarded,
    takeJoinLink,
    data,
    errors,
    revision,
    refresh,
    refreshRunJobs,
    mutate,
    circle,
    selected,
    circles,
    circlesSnapshot,
    getCirclesReadBarrier,
    agents,
    lending,
    members,
    viewerSession,
    computerName: data.devices?.name,
    setCircle,
    setDialog,
    pauseRequested,
    onPauseOpened: () => setPauseRequested(false),
    draft,
    setDraft,
  };
  const offline = ['offline', 'stale'].includes(connection?.kind), stale=Boolean(connection),
    reach = useMemo(() => ({ offline,stale,kind:connection?.kind }), [offline,stale,connection?.kind]);
  const shellDataStale = stale && !['job','jobs','home','lend'].includes(route.page);
  const homeStatusStale = Boolean(errors.home) && Boolean(data.home);
  const domainStale = ['home','lend'].includes(route.page) ? homeStatusStale : stale;
  held.current = offline;
  const machineName = data.devices?.name;
  return (
    <Notices.Provider value={notices}>
      <Connection.Provider value={reach}>
      <Sprite />
      <a
        class="skip"
        href={'#' + SKIP_TARGET}
        onClick={(e) => {
          e.preventDefault();
          document.getElementById(SKIP_TARGET)?.focus();
        }}
      >
        Skip to content
      </a>
      <Shell
        sessionEnded={connection?.kind==='session'}
        route={route}
        home={data.home}
        devices={data.devices}
        approvals={data.approvals}
        jobs={data.jobs}
        readiness={data.readiness}
        agents={agents}
        lendingReadiness={lendingChecks.value}
        lendingReadinessError={lendingChecks.error}
        circles={circles.filter(circle => circle.origin)}
        title={connection?.kind==='session' || ['job', 'request', 'borrow', 'host', 'limits', 'not-found', 'circle', 'person', 'setup', 'signin', 'telemetry'].includes(route.page) ? undefined : route.page === 'home' ? 'What would you like to get done?' : ROUTES[route.page]}
        unavailable={connection?.kind==='session' ? {status:401} : homeStatusStale ? {code:'stale'} : data.home ? null : errors.home}
        subtitle={domainStale?undefined:route.page === 'lend' && machineName ? lendingSubtitle(machineName, agents, circles, lending.circle || circle, lendPageVM(data.home ?? {},{agents,readiness:data.readiness,approvals:data.approvals}).switch?.on===true) : undefined}
        headingRef={heading}
        onSearch={() => setPalette(true)}
        banner={<ConnectionBanner vm={connection?.kind==='session' ? null : connection} onRetry={refresh} />}
        headAction={route.page === 'jobs' && jobsHaveRows ? <Button href="#/new"><Icon name="plus" />New job</Button> : undefined}
      >
        <main id="main" class={'page wide'+(shellDataStale?' data-stale':'')} tabIndex="-1">
          <div class="legacy">
            <MainNotice notice={notice} />

          </div>
          {connection?.kind!=='session' && (route.page === 'jobs' || (route.page === 'home' && !data.approvals?.length)) && <RequestNotificationBanner data={data} />}
          {connection?.kind!=='session' && <ProfileMigrationNotice notice={data.home?.profileMigration} api={api} />}
          {connection?.kind!=='session' && data.home && <FirstRunCard api={api} />}
          <div class={['home', 'lend', 'limits', 'jobs', 'job', 'request', 'host', 'borrow', 'settings', 'telemetry', 'not-found', 'circles', 'circle', 'devices', 'setup', 'signin'].includes(route.page) ? '' : 'legacy'}>
            {connection?.kind==='session' ? <div class="info-page"><h1 class="t-page">{connection.headline}</h1><ConnectionBanner vm={connection} /></div> : route.page === 'home' && errors.home && !data.home ? null : !data.home && !errors.home && route.page === 'lend' ? (
              <PageSkeleton label="Loading" />
            ) : route.page === 'home' ? (
              <Home {...context} />
            ) : route.page === 'devices' ? (
              <Devices {...context} />
            ) : route.page === 'circles' ? (
              <Circles {...context} />
            ) : route.page === 'person' ? (
              <Person key={route.id} {...context} id={route.id} circleId={route.circle} headingRef={heading} />
            ) : route.page === 'circle' ? (
              <Circle key={route.id} {...context} id={route.id} headingRef={heading} />
            ) : route.page === 'lend' ? (
              <Lend {...context} />
            ) : route.page === 'limits' ? (
              <LimitsPage {...context} headingRef={heading} />
            ) : route.page === 'setup' ? (
              <Setup {...context} headingRef={heading} />
            ) : route.page === 'signin' ? (
              <SignInProgress key={route.id} id={route.id} api={guarded} headingRef={heading} />
            ) : route.page === 'borrow' ? (
              <Compose {...context} headingRef={heading} />
            ) : route.page === 'host' ? (
              <Host key={route.id || 'status'} {...context} newCircle={route.id === 'new'} headingRef={heading} />
            ) : route.page === 'jobs' ? (
              <Jobs {...context} onHasRows={setJobsHaveRows} />
            ) : route.page === 'job' ? (
              <Job
                key={route.id + ':' + (route.circle || circle)}
                {...context}
                revision={jobRevisions.all}
                jobNews={jobRevisions.jobs[route.id] ?? 0}
                id={route.id}
                requestedCircle={route.circle}
                headingRef={heading}
              />
            ) : route.page === 'request' ? (
              <RequestPage key={route.id} {...context} id={route.id} headingRef={heading} />
            ) : route.page === 'settings' ? (
              <div>
                <Settings {...context} route={route} />
                <Accounts api={guarded} viewerSession={viewerSession} />
              </div>
            ) : route.page === 'telemetry' ? (
              <TelemetryPreview api={guarded} />
            ) : (
              <div class="info-page">
                <h1 class="t-page" ref={heading} tabIndex="-1">This page wasn’t found</h1>
                <p>Choose where to go</p>
                <div class="not-found-links">
                  <Link class="btn btn-primary" page="home">Home</Link>
                  <Link class="btn btn-secondary" page="jobs">Jobs</Link>
                  <Link class="btn btn-secondary" page="lend">Lending</Link>
                  <Link class="btn btn-secondary" page="circles">Circles</Link>
                </div>
                <button type="button" class="btn btn-secondary" onClick={() => setPalette(true)}>Search<span class="desk-only"> (⌘K)</span></button>
              </div>
            )}
          </div>
        </main>
      </Shell>
      <UpdateToast
        vm={updateVM(restart ? {update: restart} : data.home, data.updateStatus, handledUpdateVersions)}
        onOpenUpdates={() => {
          const version = updateVM({}, data.updateStatus, handledUpdateVersions)?.version;
          if (version) setHandledUpdateVersions(old => old.includes(version) ? old : [...old, version]);
          go('settings', 'updates');
        }}
      />
      <Palette
        api={api}
        open={palette}
        onClose={() => setPalette(false)}
        circles={circles}
        data={data}
        lending={lending}
        devices={data.devices}
        revision={revision}
        run={(op) => op === 'lending.pause' && pauseLending()}
      />
      <div class="legacy">{dialog && <Confirm {...dialog} onClose={() => setDialog(null)} />}</div>
      </Connection.Provider>
    </Notices.Provider>
  );
}

export async function start(token, viewerSession = {kind: 'local'}) {
  const {browserTelemetry} = await import('./posthog-sdk.mjs');
  const target = document.getElementById('app');
  target.replaceChildren();
  let pending = takeJoinPrefill(location, history);
  const takeJoinLink = () => {
    const link = pending;
    pending = '';
    return link;
  };
  // The friction sender posts through the raw api, so its own request is never counted; every other write is.
  browserTelemetry.device(viewerSession.kind==='paired'?'paired':await browserDevice());
  let friction;
  const policy = connectBrowserPolicy({api:createApi(token),browser:browserTelemetry,store:telemetryStore,onStop:()=>friction?.stop()});
  const raw = policy.api;
  const click = event => browserTelemetry.click(event.target);
  document.addEventListener('click', click);
  const toggle = event => { if(event.target.open){const section={'setup-safety-details':'setup-details'}[event.target.id];if(section)browserTelemetry.help(section);} };
  document.addEventListener('toggle', toggle, true);
  const visibility = () => { if(document.visibilityState!=='visible')browserTelemetry.engagement(); };
  document.addEventListener('visibilitychange',visibility);
  window.addEventListener('pagehide', () => { browserTelemetry.engagement(); policy.stop(); document.removeEventListener('click', click);document.removeEventListener('toggle',toggle,true);document.removeEventListener('visibilitychange',visibility); }, {once:true});
  friction = createFriction({
    send: records => raw.post('telemetry/ui', {records}),
    permitted: () => browserTelemetry.captureAllowed(),
    unsent: page => page === 'borrow' && hasUnsentCompose(localStorage),
  });
  telemetryStore.load(raw);
  render(<App api={instrumentApi(raw, friction)} friction={friction} browser={browserTelemetry} telemetryPolicy={policy} takeJoinLink={takeJoinLink} viewerSession={viewerSession} />, target);
}
