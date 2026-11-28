import {sandboxRemediationLines,sandboxRemovalCommands} from '../../../lib/sandbox-remediation.mjs';
import {policySummary} from './lending-policy-view.mjs';
import {normalizeLendingPolicy} from '../../../lib/v1/lending-policy.mjs';
import {RUNNING_JOB} from '../../../lib/v1/lending-status-copy.mjs';
import {ReadinessCheck} from './lending-checks.jsx';
import { formatDate } from './dates.mjs';
import {homeLendingCardVM} from './home-lending.mjs';
import {cleanupStatusVM} from './cleanup-status.mjs';
import {membershipProjectionFor} from './membership-projection-view.mjs';
import { Action, enc, field, circleName, Notices, Connection, OFFLINE_REASON } from './shared.jsx';
import { safeName, formatTime, agentProduct, errorMessage, todayCounts } from './helpers.mjs';
import { SignIn } from './signin.jsx';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { Avatar, Card, Icon, Switch, Button, InlineStatus, Sheet } from './ds/index.mjs';
import { BlockerList, BlockerAction } from './blockers.jsx';
import { jobStateKey, lendPageVM, agentSectionsVM, agentsCheckedVM, agentCheckVM, canonicalAgentId, plainRemedy, agentRowVM, lendingLimitsVM, lendingQuotaLinesVM, pauseChoices } from './view-models.mjs';

// The model is chosen from the models this agent advertises. "Another model…" keeps the id field, which the server
// also accepts (agentRun), for a model the list does not name yet.
const OTHER_MODEL='__other__';
// A save clears only the draft it sent. An edit made while the save is in flight stays in the form.
const clearIfSent=(sent,setDraft)=>result=>{setDraft(current=>current===sent?null:current);return result;};
function AgentRunControl({agent,mutate}) {
  const [draft,setDraft]=useState(null),[typing,setTyping]=useState(false);
  const value=draft??{model:agent.run?.model??'',effort:agent.run?.effort??''};
  const known=(agent.models??[]).map(x=>safeName(x)).filter(Boolean);
  const example=(agent.models??[]).find(model=>typeof model==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(model));
  const showOther=typing||(value.model!==''&&!known.includes(value.model));
  const valid=value.model===''||/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(value.model);
  const choose=e=>{const next=field(e);if(next===OTHER_MODEL){setTyping(true);return;}setTyping(false);setDraft({...value,model:next});};
  return <form onSubmit={e=>e.preventDefault()} aria-label="Model and effort" class="agent-control ph-no-capture" data-telemetry-private="lend">
    <h3>Model and effort</h3>
    <label>Model
      <select value={showOther?OTHER_MODEL:value.model} onChange={choose}>
        <option value="">Agent default</option>
        {known.map(model=><option key={model} value={model}>{model}</option>)}
        <option value={OTHER_MODEL}>Another model…</option>
      </select>
    </label>
    {showOther&&<label>Model id
      <input value={value.model} placeholder={example ? "e.g. " + example : "Model id from this agent’s model list"} maxLength={80}
        onInput={e=>setDraft({...value,model:field(e)})} />
    </label>}
    <label>Effort
      <select value={value.effort}
        onChange={e=>setDraft({...value,effort:field(e)})}>
        <option value="">Agent default</option><option value="low">Low</option>
        <option value="medium">Medium</option><option value="high">High</option>
      </select>
    </label>
    <p>{agent.auth_strategy === 'provider-file-generation' ? 'Your own jobs use this model and effort.' : 'Jobs from your circles use this model and effort.'} Lower effort usually uses less of your allowance.</p>
    {!valid&&<p role="alert">{example ? "Use a model id like " + example + ". " : ""}Use 1–80 letters, digits or - . _ : /, starting with a letter or digit.</p>}
    <Action className="btn btn-secondary" disabled={!valid} disabledReason="Enter a valid model id before saving." run={()=>{const sent=draft;return mutate('agents/'+enc(agent.id)+'/run',{
      model:value.model||null,effort:value.effort||null,
    }).then(clearIfSent(sent,setDraft));}} success="Model and effort saved.">Save</Action>
  </form>;
}


const UNCONFIRMED_COPY = 'The lending selection could not be confirmed. Reload this page to check its saved state before changing it again.';

/** The one line under a switch while Faravan answers it: what it is waiting for, so the switch never looks dead.
 *  `ready` is false for every lending sign-in, which Faravan checks again in a sandbox each time it is chosen. */
export function agentChoiceNote(name, on, ready) {
  if (!on) return 'Turning off ' + name + '…';
  return ready ? 'Turning on ' + name + '…'
    : 'Checking that ' + name + ' is signed in for lending. This starts a sandbox and takes about a minute.';
}

// One agent of the Lending page: its name, sign-in and model in one line, the on/off switch, and
// the existing controls (sign in, install help, model and effort) one tap away.
export function AgentCard({ agent: a, api, mutate, refresh, blocker, account, lendingOn = false }) {
  const ownerOnly = a.auth_strategy === 'provider-file-generation';
  const p = agentProduct(a.id), row = agentRowVM(a, blocker, {now: useNow(a.checking), account, lendingOn}), ready = row.state === 'ready', id = 'agent-' + a.id;
  const notices = useContext(Notices);
  // The choice shows at once, as pending, until Faravan answers; a second tap waits for the first.
  const [choosing, setChoosing] = useState(null);
  // The agent as the server last described it; an answer that arrives later reads this, not the agent at the click.
  const latest = useRef(a); latest.current = a;
  const lent = a.useForLending === true;
  // The save answers with every agent. This card reads its own row, and holds the switch unless that row shows the value asked for.
  // `held` keeps the value asked for, and the saved value it started from; once the saved value changes, the card shows that.
  const [held, setHeld] = useState(null), [failure, setFailure] = useState('');
  const holding = held !== null && a.useForLending === held.from;
  const toggle = async (on) => {
    if (choosing !== null || holding) return;
    setChoosing(on); setFailure('');
    try {
      const views = await mutate('agents/' + enc(a.id), { useForLending: on });
      const saved = (Array.isArray(views) ? views : []).find(item => item?.id === a.id);
      if (typeof saved?.useForLending !== 'boolean' || saved.useForLending !== on) {
        // A missing or different row is not a confirmed change; a second tap would act on a state nobody has seen.
        setHeld({on, from: latest.current.useForLending});
        notices?.set(UNCONFIRMED_COPY);
        return;
      }
      // Say only what this answer confirmed: the choice. Signed in is not able to lend; the card's status says the rest.
      notices?.set(on ? row.name + ' is chosen for lending.' : 'No new jobs will use ' + row.name + '.');
    } catch (error) {
      // The sign-in check found the agent signed out: say so, and reload so the card shows its sign-in.
      setFailure(errorMessage(error));
      notices?.set(on && error?.code === 'agent_not_ready' ? row.name + ' isn’t signed in for lending. Sign it in, then turn it on.' : errorMessage(error));
      if (on && error?.code === 'agent_not_ready') Promise.resolve(refresh?.()).catch(() => {});
      return;
    }
    finally { setChoosing(null); }
    // Turning an agent on starts its check at once; nobody has to press Check first. The check answers sign-in only.
    if (on && !agentCheckVM(latest.current).ready) mutate('agents/refresh', {agents: [a.id]})
      .then(found => {
        const agent = (Array.isArray(found) ? found : []).find(item => canonicalAgentId(item) === row.id), check = agent && agentCheckVM(agent);
        notices?.set(check?.ready ? row.name + ' is signed in.' : check?.signedOut ? row.name + ' is signed out. Sign it in to lend it.' : row.name + ' couldn’t be checked.');
      })
      .catch((error) => notices?.set(errorMessage(error)));
  };
  return (
    <div class="lagent ph-no-capture" aria-labelledby={id} data-telemetry-private="lend">
      <span class="logo" aria-hidden="true"><Icon name={row.icon} /></span>
      <div class="row-title" id={id}>{row.name}</div>
      {ownerOnly ? <span class="t-xs t-2">For your own jobs</span> : row.canChoose || a.useForLending || choosing !== null ? <Switch label={'Lend with ' + row.name} checked={choosing ?? (holding ? held.on : a.useForLending)} onChange={toggle}
          disabled={holding} disabledReason={holding ? UNCONFIRMED_COPY : undefined}
          aria-describedby={choosing !== null ? id + "-choosing" : undefined} />
        : row.canSignIn ? null
        : row.canCheck ? <Action className="btn btn-secondary btn-sm" disabled={row.checking} disabledReason="Checking this agent. Wait for the result." run={() => mutate('agents/refresh', {agents:[a.id]})} success={found => agentsCheckedVM(found, blocker ? {[a.id]: blocker} : {})}>Check {row.name}</Action>
        : <span class="t-xs t-2">Install {row.name} to lend</span>}
      {(row.canChoose || a.useForLending) && row.canCheck && !row.canSignIn && <Action className="btn btn-secondary btn-sm" disabled={row.checking} disabledReason="Checking this agent. Wait for the result."
        run={() => mutate('agents/refresh', {agents:[a.id]})} success={found => agentsCheckedVM(found, blocker ? {[a.id]: blocker} : {})}>Check {row.name}</Action>}
      <div class="sub" data-blocker-state={blocker?.status}>
        {ownerOnly && <p>This sign-in is only for your own jobs and is never lent.</p>}
        <InlineStatus kind={row.kind} word={ownerOnly && row.canEnable ? 'Signed in for your own jobs' : row.sub.join(' · ')} />{row.note && <span class="t-xs t-2" role="status">{row.note}</span>}
        {choosing !== null && <span class="t-xs t-2" role="status" id={id + '-choosing'}>{agentChoiceNote(row.name, choosing, agentCheckVM(a).ready && !a.lendingSignInTarget)}</span>}
        {failure && <p role="alert">{failure} Review this agent’s status before trying again.</p>}
        {failure && <Button kind="quiet" onClick={() => refresh?.()}>Check agent status</Button>}
        {holding && <Button kind="quiet" onClick={() => location.reload()}>Reload page to confirm agent status</Button>}
      </div>
      {row.canSignIn && <div class="agent-signin"><SignIn api={api} target={a.id} agentName={row.name} refresh={refresh} kind="secondary" /></div>}
      <div class="more">
        <details class="tech" data-agent-id={a.id}>
          <summary>Details</summary>
          <div class="legacy">
            {!ready && a.installed === false ? <p>{p.install}</p>
              : row.canSignIn ? null
              : !ready && blocker?.status === 'blocked' ? <p>{plainRemedy(a.remedy) || p.connect}</p> : null}
            {a.credential_in_guest && <p>{ownerOnly ? 'Your own jobs can read this sign-in’s access and refresh tokens. Deleting the sandbox does not revoke them.' : 'Jobs can read sign-in details supplied inside this sandbox.'}</p>}
            {row.canEnable && <AgentRunControl agent={a} mutate={mutate} />}
            <dl>
              {a.models?.length > 0 && (
                <div><dt>Models</dt><dd>{a.models.map((x) => safeName(x)).filter(Boolean).join(', ')}</dd></div>
              )}
              {a.lendable_models?.length > 0 && a.models?.length > a.lendable_models.length && (
                <div><dt>Lending</dt><dd>This computer lends {[...new Set(a.lendable_models.map((x) => x.split('-')[1]))].map((f) => f.charAt(0).toUpperCase() + f.slice(1)).join(', ')} jobs</dd></div>
              )}
              {formatTime(a.checkedAt) && <div><dt>Last checked</dt><dd>{formatTime(a.checkedAt)}</dd></div>}
              <dt>Sign-in details</dt>
              <dd>{ownerOnly ? 'Available only to your own jobs; never lent' : a.credential_in_guest ? 'Available inside each job' : 'Stay on your computer; a local intermediary uses them for jobs'}</dd>
            </dl>
          </div>
        </details>
      </div>
    </div>
  );
}

export function RequesterLimitsControl({ circleId, keyId, value, mutate }) {
  const [draft, setDraft] = useState(null);
  const opener=useRef(null),firstField=useRef(null),wasEditing=useRef(false);
  useEffect(()=>{
    if(draft!==null){wasEditing.current=true;firstField.current?.focus();return;}
    if(wasEditing.current){wasEditing.current=false;opener.current?.focus();}
  },[draft!==null]);
  const saved = value?.limits || {}, used = value?.usage;
  const number = (text) => text === '' ? null : /^\d+$/.test(text) ? Number(text) : NaN;
  const valid = draft && Object.values(draft).every(text => {
    const n = number(text);
    return n === null || (Number.isSafeInteger(n) && n >= 0 && n <= 2147483);
  });
  const sent = draft;
  const save = () => mutate('lending/requester-limits', {
    circle: circleId, keyId, limits: {
      dailyJobs: number(draft.dailyJobs), dailyMinutes: number(draft.dailyMinutes),
    },
  }).then(clearIfSent(sent, setDraft));
  return (
    <section class="ph-no-capture" aria-label="Limits for this device" data-telemetry-private="lend">
      {/* One line here; the details live in the edit form so the review card stays short. */}
      <p>
        <strong>This device:</strong>{' '}
        {used ? (value.carried ? 'earlier day ' : 'today ') + used.jobs + ' jobs, ' +
          Math.ceil(used.milliseconds / 60000) + ' min' : "today's use unavailable"} ·{' '}
        {saved.dailyJobs == null && saved.dailyMinutes == null ? 'no device limit' :
          [saved.dailyJobs != null && 'max ' + saved.dailyJobs + ' jobs',
           saved.dailyMinutes != null && 'max ' + saved.dailyMinutes + ' min'].filter(Boolean).join(', ') + ' a day'}
      </p>
      <button ref={opener} class="btn btn-secondary" hidden={draft!==null} disabled={!circleId || !keyId} onClick={() => setDraft({
          dailyJobs: saved.dailyJobs == null ? '' : String(saved.dailyJobs),
          dailyMinutes: saved.dailyMinutes == null ? '' : String(saved.dailyMinutes),
        })}>Edit device limits</button>
      <form hidden={draft===null} onSubmit={(e) => e.preventDefault()}>
          <label>Jobs per day
            <input ref={firstField} type="number" min="0" max="2147483" step="1" value={draft?.dailyJobs??''}
              onInput={(e) => setDraft({ ...draft, dailyJobs: field(e) })} />
          </label>
          <label>Minutes per day
            <input type="number" min="0" max="2147483" step="1" value={draft?.dailyMinutes??''}
              onInput={(e) => setDraft({ ...draft, dailyMinutes: field(e) })} />
          </label>
          <p>Leave a field empty for no device cap. Zero blocks new jobs. Time includes reserved
            runtime. Your global limits also apply.{value?.timeZone ? ' Resets at midnight in ' + value.timeZone + '.' : ''}</p>
          <Action className="btn btn-primary" disabled={!valid} disabledReason="Enter valid device limits before saving." run={save} success="Device limits saved.">
            Save device limits
          </Action>
          <Action className="btn btn-secondary" run={() => mutate('lending/requester-limits', {
            circle: circleId, keyId, limits: null,
          }).then(clearIfSent(sent, setDraft))} success="Device limits cleared.">Clear device limits</Action>
          <button type="button" class="btn btn-secondary" onClick={() => setDraft(null)}>Cancel</button>
        </form>
    </section>
  );
}

function useNow(fast) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), fast ? 1000 : 30000);
    return () => clearInterval(timer);
  }, [fast]);
  return now;
}

const LENDING_OFF_NOTICE = `No new jobs will start. ${RUNNING_JOB}`;

export const lendingOnNotice = vm => vm.lendingProjection?.intent !== 'on'
  ? 'Lending is set to on. Updating lending status.'
  : vm.lendingProjection.admission === 'allowed' ? 'Lending is on. Your approval mode and limits apply.'
  : vm.headline + '. ' + vm.reason;

// The lending switch is the biggest control on its page. It changes your computer only.
export function LendSwitch({ vm, disabled, run, size = 'xl' }) {
  const notices = useContext(Notices), { offline } = useContext(Connection), [pending, setPending] = useState(false);
  const latest = useRef(vm); latest.current = vm;
  async function flip(next) {
    if (pending) return;
    setPending(true);
    try {
      await run(next);
      notices?.set(next ? lendingOnNotice(latest.current) : LENDING_OFF_NOTICE);
    } catch (error) {
      notices?.set(errorMessage(error));
    } finally {
      setPending(false);
    }
  }
  return <Switch class="ph-no-capture" size={size} label="Lending" checked={vm.switch.on} onChange={flip} pending={pending} disabled={disabled || offline} disabledReason={offline ? OFFLINE_REASON : "Choose a circle before turning lending on."} title={offline ? OFFLINE_REASON : undefined} data-telemetry-private="lend" />;
}

function Meters({ meters }) {
  return (
    <div class="meters ph-no-capture" data-telemetry-private="lend">
      {meters.map((m) => (
        <div key={m.label}>
          <div class="t-xs t-2">{m.label}</div>
          <div class="n t-num">{m.value} <span class="t-3" style={{ fontWeight: '500' }}>{m.of}</span></div>
          {m.note ? <div class="t-xs t-2" style={{ marginTop: '6px' }}>{m.note}</div>
            : <div class="meter" aria-hidden="true"><i style={{ width: m.percent + '%' }} /></div>}
        </div>
      ))}
    </div>
  );
}

// The lending card on Home's rail: the setting, one line about it, the switch, and the running job with its Stop.
export function LendingCard({ vm, device, circle, lending, mutate, setDialog, api, agents = [], refresh }) {
  const flip = on => mutate('lending/' + (on ? (vm.kind === 'paused' || vm.latched ? 'resume' : 'on') : 'off'), {circle:lending.circle || circle});
  const card=homeLendingCardVM(vm), fix=card.action;
  const meters=vm.meters.filter(m=>vm.headline!=='Done for today'||m.label!=='Jobs today');
  const canStop = vm.exec?.canStop;
  const stop = () => setDialog({title: 'Stop this job?', confirmLabel: 'Stop job', cancelLabel: 'Keep going', children: <p data-telemetry-private="lend" class="ph-no-capture">We’ll ask the running computer to stop. It may take time to confirm.</p>, onConfirm: () => mutate('lending/stop', {attemptId: vm.exec.job, confirmed: true})});
  return <Card class={('home-lending-card' + (fix?.action === 'Resume now' ? ' recovery' : '')) + ' ph-no-capture'} data-telemetry-private="lend">
    <div class="card-pad stack-3">
      <div class="home-lending-head">
        <Icon name="laptop" />
        <span class="t-title3">{device}</span>
        {card.showSwitch && <div class="home-lending-toggle"><LendSwitch vm={vm} disabled={!circle} run={flip} size="" /></div>}
      </div>
      <p class="t-title3">{vm.headline}</p><p class="t-sm t-2">{card.reason}</p>
      {fix && <div class="home-lending-fix"><BlockerAction item={fix} primary={false} api={api} agents={agents} mutate={mutate} circle={lending.circle || circle} refresh={refresh} latched={vm.latched} /></div>}
      {!fix && vm.identityHold?.target && <div class="home-lending-fix identity-signin"><SignIn api={api} target={vm.identityHold.target} agentName={vm.identityHold.name} refresh={refresh} kind="secondary" /></div>}
      {vm.exec && <div class="stack-2"><p class="t-sm">{vm.exec.stops || (vm.exec.stopping ? 'Stop requested. Confirmation is still pending.' : vm.exec.finishing ? RUNNING_JOB : 'This job uses your saved limits.')}</p>{canStop && <Button kind="danger" size="sm" onClick={stop}>Stop {vm.exec.who ? vm.exec.who + "’s" : "this"} job…</Button>}</div>}
      {meters.length > 0 && <div class="home-usage t-xs t-2">{meters.slice(0, 2).map(m => <span key={m.label}>{m.label === 'Jobs today' ? <>{m.value} {m.of} {m.of === 'of 1' ? 'job today' : 'jobs today'}</> : <>{m.label} · {m.value} {m.of}</>}</span>)}</div>}
      <a class="t-sm" href="#/lend">Lending settings <span aria-hidden="true">→</span></a>
    </div>
  </Card>;
}

export function LocalHistoryLearning({api,mutate}) {
  const [enabled,setEnabled]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  const {offline}=useContext(Connection);
  useEffect(()=>{
    let active=true;
    setError('');
    api.get('lending/history-learning').then(value=>{if(active)setEnabled(value.enabled);},
      failure=>{if(active)setError(errorMessage(failure));});
    return ()=>{active=false;};
  },[api,attempt]);
  const change=async value=>{
    if(busy)return;
    setBusy(true);setError('');
    try{const result=await mutate('lending/history-learning',{enabled:value});setEnabled(result.enabled);}
    catch(failure){setError(errorMessage(failure));}
    finally{setBusy(false);}
  };
  return <Card data-telemetry-private="lend" class="ph-no-capture"><div class="card-pad stack-3">
    <div class="hstack"><div class="grow"><b>Learn from my local agent logs</b></div>
      <Switch label="Learn from my local agent logs" aria-describedby="history-learning-reason" checked={enabled===true}
        pending={busy} disabled={enabled===null||offline} disabledReason={offline ? OFFLINE_REASON : "Waiting for the saved lending setting."} onChange={change} /></div>
    <p class="t-sm t-2" id="history-learning-reason">Faravan reads your local Claude Code and Codex logs to learn how much you usually use. It keeps only the model, time and token counts, never the conversation text.</p>
    <p class="t-xs t-2">Turning this off deletes what Faravan learned from your logs, but keeps usage records.</p>
    {enabled===null&&!error&&<p role="status">Loading local learning setting…</p>}
    {error&&<p role="alert">{error}</p>}
    {error&&enabled===null&&<Button kind="secondary" onClick={()=>setAttempt(n=>n+1)}>Try again</Button>}
  </div></Card>;
}

export function Lend({ api, agents, lending, data, errors = {}, mutate, circle, selected, circles, members, refresh, setDialog, setCircle, pauseRequested = false, onPauseOpened }) {
  const now = useNow(agents.some(a => a.checking)),
    home = data.home || {},
    use = todayCounts(lending, new Date(now)),
    vm = lendPageVM(home, { agents, use, now, readiness: data.readiness, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, approvals: data.approvals }),
    summary = lendingLimitsVM(lending, home.schedule, agents),
    mode = lending.mode || 'ask',
    // Quota lines cover only the accounts this computer lends; an account it does not lend has no quota open to lend.
    lentProviders = new Set(agents.filter(agent => agent.useForLending === true).map(agent => agent.id === 'codex' ? 'codex' : agent.id === 'claude-code-subscription' ? 'claude' : null)),
    approvalRequired = provider => mode !== 'auto' || !lentProviders.has(provider),
    quotaLines = lendingQuotaLinesVM(home.lendingPolicy && {...home.lendingPolicy, accounts: (home.lendingPolicy.accounts ?? []).filter(account => lentProviders.has(account.provider))}, approvalRequired, home, {now});
  if(lending.limits?.lendingPolicy){
    const index=summary.findIndex(row=>row.label==='Keep for yourself');
    summary.splice(index>=0?index:3,index>=0?1:0,{label:'Lending allowance',value:policySummary(normalizeLendingPolicy(lending.limits.lendingPolicy)).replace(/\.$/,'')});
  }
  // The circle shown is the circle a turn-on will use: the saved one while lending is on, your pick otherwise.
  const [savingCircle,setSavingCircle]=useState(null),[circleError,setCircleError]=useState('');
  const chosenCircle = savingCircle || lending.circle || circle;
  const availableCircles=circles.filter(c=>c.origin&&c.private!==true&&membershipProjectionFor(c).phase==='approved');
  // A saved target that is no longer eligible stays the target a turn-on would use, so no row may claim to be selected for it.
  const savedUnavailable=Boolean(lending.circle)&&!savingCircle&&!availableCircles.some(c=>c.id===lending.circle);
  const changeCircle=async event=>{
    const id=event.currentTarget.value;if(!event.currentTarget.checked||!id||savingCircle)return;
    setSavingCircle(id);setCircleError('');
    try {await mutate('lending/circle',{circle:id});setCircle(id);}catch(error){setCircleError(errorMessage(error));}
    finally {setSavingCircle(null);}
  };
  useEffect(() => { if (lending.circle && lending.enabled !== true) setCircle(lending.circle); }, [lending.circle]);
  const sections = agentSectionsVM(agents);
  const [showChecks, setShowChecks] = useState(false);
  const [pausing, setPausing] = useState(false);
  useEffect(() => {
    if (!pauseRequested) return;
    if (lending.enabled === true) setPausing(true);
    onPauseOpened?.();
  }, [pauseRequested]);
  const notices = useContext(Notices), {offline} = useContext(Connection);
  const cleanup = cleanupStatusVM(home.cleanup, {stale: offline || Boolean(errors.home)});
  const pauseFor = choice => {
    setPausing(false);
    notices?.set('Pausing lending…');
    return mutate('lending/pause', {circle:lending.circle || circle, ...(choice.until ? {until:choice.until} : {})}).then(
      () => notices?.set(choice.until ? 'Paused until ' + formatDate(choice.until, 'clock') + '.' : 'Paused. No new jobs start until you resume.'),
      error => notices?.set(errorMessage(error)));
  };
  const resume = () => mutate('lending/resume', {circle:lending.circle || circle});
  const fix = vm.kind === 'paused' ? null : vm.heroAction;
  const incomplete = !vm.checks.ready;
  // A latched stop (an earlier failed check) is cleared by resume; `on` would be refused.
  const flip = (on) => mutate('lending/' + (on ? (vm.latched ? 'resume' : 'on') : 'off'), { circle: lending.circle || circle });
  const stop = () =>
    setDialog({
      title: 'Stop this job?',
      confirmLabel: 'Stop job', cancelLabel: 'Keep going',
      children: <p data-telemetry-private="lend" class="ph-no-capture">We’ll ask the running computer to stop. It may take time to confirm.</p>,
      onConfirm: () => mutate('lending/stop', { attemptId: vm.exec.job, confirmed: true }),
    });
  const canStop = vm.exec?.canStop;
  // Keep the active job reachable on phones throughout running, finishing and stopping.
  const activeJob = vm.exec?.job ? (Array.isArray(data.jobs) ? data.jobs : []).find(job => job.current_attempt?.attempt_id === vm.exec.job) : null;
  const activeJobHref = activeJob?.job_digest ? '#/job/' + encodeURIComponent(activeJob.job_digest) + (activeJob.circle?.id ? '/' + encodeURIComponent(activeJob.circle.id) : '') : null;
  const pendingApproval = !vm.exec && data.approvals?.[0];
  const directOff = ['on', 'paused'].includes(vm.lendingProjection.intent) &&
    (pendingApproval || !circle || vm.kind === 'paused' || fix?.action === 'Resume now');
  return (
    <div class="lending-page stack-6 ph-no-capture" data-telemetry-private="lend">
      <Card>
        <div class={'hero' + (vm.checks.ready && !fix ? ' stable' : '')}>
          <div class="lstate">
            <span class={'orb ' + vm.tone}><Icon name={vm.icon} size="lg" /></span>
            <div class="grow">
              <h2 class="headline">{vm.headline}</h2>
              <p class="t-2" style={{ marginTop: '4px' }}>{vm.reason}</p>
              {(lending?.remediation?.length>0) && <div class="stack-2" role="note" aria-label="Sandbox recovery guidance">
                {sandboxRemediationLines(lending.remediation).map(line=><pre class="t-sm" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{line}</pre>)}
                {sandboxRemovalCommands(lending.remediation).map(command=><pre class="t-sm" aria-label="Removal command" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{command}</pre>)}
              </div>}
              {!circle && vm.switch && <p class="t-sm t-2" style={{ marginTop: '4px' }}>Join or start a circle to lend.</p>}
            </div>
            {pendingApproval ? <Button kind="primary" href={'#/request/' + enc(pendingApproval.id)}>Review request</Button> : !circle ? <Button kind="primary" href="#/circles">Join a circle</Button> : vm.switch && vm.kind !== 'paused' && fix?.action !== 'Resume now' && (vm.switch.on || !fix) && <LendSwitch vm={vm} run={flip} />}
            {directOff && <Action className="btn btn-secondary" run={() => flip(false)}
              success={LENDING_OFF_NOTICE}>Turn lending off</Action>}
          </div>
          {vm.exec && (
            <div class="exec">
              <Icon name="play" size="sm" />
              <span class="grow">{vm.exec.stops || (vm.exec.finishing ? RUNNING_JOB : 'This job uses your saved limits.')}</span>
              {activeJobHref && <a href={activeJobHref}>{vm.exec.stopping ? vm.headline : 'Open job'} <span aria-hidden="true">→</span></a>}
              {vm.exec.stopping && !activeJobHref && <span class="stack-2">
                {vm.lendingProjection.admissionReason!=='cleanup_pending' &&
                  <span>Stop requested. Confirmation is still pending.</span>}
                <Action className="btn btn-secondary btn-sm" run={() => refresh()}>Check stop status</Action>
              </span>}
              {canStop && <Button kind="danger" size="sm" onClick={stop}>{'Stop ' + (vm.exec.who ? vm.exec.who + '’s' : 'this') + ' job…'}</Button>}
            </div>
          )}
          {vm.identityHold?.target && <div class="identity-signin"><SignIn api={api} target={vm.identityHold.target} agentName={vm.identityHold.name} refresh={refresh} kind="secondary" /></div>}
          {!vm.exec && data.jobs?.some(job => ['ready','no_changes','applied','stopped','failed','expired'].includes(jobStateKey(job))) && <a href="#/jobs">View finished jobs <span aria-hidden="true">→</span></a>}
          {vm.banner && (
            <div class={'banner' + (vm.banner.tone === 'bad' ? ' bad' : '')} role="status">
              <Icon name={vm.banner.icon} />
              <div class="grow">
                <b>{vm.banner.title}</b>
                <p class="t-sm t-2" style={{ marginTop: '2px' }}>{vm.banner.text}</p>
              </div>
            </div>
          )}

          {vm.meters.length > 0 && <Meters meters={vm.meters.filter(m => !m.of.includes('weekly quota unused'))} />}
          {(vm.canPause || vm.kind === 'paused' || circle && fix) && <div class="hero-actions wrap">
          {circle && fix && <BlockerAction surface="lend" item={fix} primary={!pendingApproval} api={api} agents={agents} mutate={mutate} circle={circle} refresh={refresh} latched={vm.latched} />}
          {vm.lendingProjection.intent === 'paused' && <Action className={'btn btn-' + (pendingApproval ? 'secondary' : 'primary') + ' btn-sm'} run={resume} success="Lending is on.">Resume now</Action>}
          {vm.canPause && <div class="hstack-2 wrap"><Button size="sm" onClick={() => setPausing(true)}>{fix?.action === 'Resume now' ? 'Pause new jobs…' : 'Pause all agents…'}</Button></div>}
          {fix?.action==='Resume now' && !vm.canPause && <Button size="sm" onClick={() => setPausing(true)}>Pause new jobs…</Button>}
          </div>}
        </div>
      </Card>
      {!incomplete && <div class="checks-summary">
        <Icon name="check-circle" size="sm" /><span>Workspace checks passed{vm.checks.checked ? ' · workspace checked ' + vm.checks.checked : ''}</span>
        <button class="btn btn-quiet" type="button" aria-expanded={showChecks} onClick={() => setShowChecks(!showChecks)}>{showChecks ? 'Hide checks' : 'View checks'}</button>
      </div>}
      {(incomplete || showChecks) && <><BlockerList surface="lend" model={vm.checks} suppressAction={fix} primary={false} api={api} agents={agents} mutate={mutate} circle={circle} refresh={refresh} latched={vm.latched} /><ReadinessCheck api={api} refresh={refresh} /></>}
      {cleanup.summary && <section aria-label="Cleanup">
        <p class={'t-sm ' + (cleanup.summary.kind === 'bad' ? 'bad-text' : 't-2')} role="status">{cleanup.summary.line}</p>
        <details class="tech">
          <summary>Cleanup details</summary>
          <div class="stack-3">
            <h3>{cleanup.heading}</h3>
            <p class="t-sm t-2">{cleanup.watch.line}</p>
            {cleanup.watch.detail && <p class="t-sm t-2">{cleanup.watch.detail}</p>}
            {cleanup.unreadable && <p class="t-sm t-2">{cleanup.unreadable.line}</p>}
            <dl class="limit-rows">{cleanup.counts.map(row => <div key={row.key}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
          </div>
        </details>
      </section>}
      {home.desktop?.pinPrompt === true && (
        <div class="banner" role="status">
          <Icon name="alert" />
          <div class="grow">
            <b>Keep the Faravan icon in sight</b>
            <p class="t-sm t-2" style={{ marginTop: '2px' }}>Windows hides new icons behind the ^ arrow.</p>
          </div>
          <a class="btn btn-secondary btn-sm" href="#/setup">Show me</a>
        </div>
      )}
      {vm.kind !== 'unsupported' && (
        <div class="cols">
          <div class="stack-6">
            <section id="lend-agents">
              <div class="section-h">
                <h2>Agents you lend</h2>
                {sections.shown.length>0&&<Action className="btn btn-quiet" run={() => mutate('agents/refresh', {agents:sections.shown.map(agent => agent.id)})} success={(found) => agentsCheckedVM(Array.isArray(found) ? found : agents, vm.blockers.byAgent)}>Check agents again</Action>}
              </div>
              {sections.stoppedNote && <p class="t-xs t-2 agent-check-note" role="status">{sections.stoppedNote}</p>}
              <Card class="agents">
                {sections.shown.length ? sections.shown.map((a) => <AgentCard key={a.id} agent={a} lendingOn={vm.lendingProjection?.intent === 'on'} account={home.lendingPolicy?.accounts?.find(account=>account.provider===(canonicalAgentId(a)==='codex'?'codex':'claude'))} api={api} mutate={mutate} refresh={refresh} blocker={vm.blockers.byAgent[a.id]} />)
                  : <p class="card-pad t-sm" role="status">{data.agents ? <>{agents.length ? 'None of the agents on this computer can be lent yet. Faravan lends Claude Code and Codex.' : 'No supported agents were found.'} <a href="#/setup">Open Setup</a> to install or connect one.</> : 'Loading agents…'}</p>}
              </Card>
              <p class="t-xs t-2 agent-check-note">In circles set to Automatic, friends’ jobs start on their own within your limits once an agent is chosen. People in your circles see the agent, model and returned work.</p>
            </section>
            {quotaLines.length > 0 && <section aria-labelledby="quota-open-heading">
              <div class="section-h"><h2 id="quota-open-heading">Allowance</h2></div>
              <Card><div class="card-pad stack-2">{quotaLines.map(row => <p class="t-sm" key={row.key}><strong>{row.label}:</strong> {row.text}</p>)}</div></Card>
            </section>}
            <section>
              <div class="section-h"><h2>What you lend</h2><a class="btn btn-quiet" href="#/lend/limits">Edit lending limits</a></div>
              <Card>
                <div class="card-pad limits stack-3">
                  <dl class="limit-rows">{summary.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
                  {lending.limits?.idleOnly && home.ownerPresence?.active == null && <p role="status">Faravan can’t tell whether you’re at this computer.</p>}
                  <p class="t-xs t-2">These limits cover every circle and agent on your computer. Each agent account runs one job at a time by default; the computer’s total cap also applies.</p>
                </div>
              </Card>

            </section>
          </div>
          <div class="stack-6">
            <section>
              <div class="section-h"><h2>Lends to</h2></div>
              <Card class="lending-circles" role="radiogroup" aria-label="Choose a circle" aria-describedby={availableCircles.length?'circle-choice-note':undefined} aria-busy={savingCircle?'true':undefined}>
                {availableCircles.length ? availableCircles.map(item=><label class="lending-circle-row" key={item.id}>
                  <Avatar groupName={circleName(item)} id={item.id} />
                  <span class="grow"><span class="row-title">{circleName(item)}</span>
                    <span class="row-meta">{safeName(item.purpose)||((home.circles?.find(x => x.id === item.id)?.lendingMode ?? mode) === 'auto' ? 'Automatic: rules and limits decide' : 'Ask me each time')}</span></span>
                  {chosenCircle===item.id && <span class="t-xs t-2">Selected</span>}<input type="radio" name="lending-circle" value={item.id} checked={chosenCircle===item.id}
                    disabled={offline||vm.switch?.on||Boolean(lending.current)||Boolean(savingCircle&&savingCircle!==item.id)} onChange={changeCircle} />
                </label>) : <div class="card-pad stack-2"><p class="t-sm">No approved circle yet.</p><a class="btn btn-secondary btn-sm" href="#/circles">Join or create a circle</a></div>}
              {availableCircles.length>0 && <div class="card-pad stack-2">
                <p class="t-xs t-2" id="circle-choice-note">{savedUnavailable?'The circle you chose earlier is no longer available. '+(vm.switch?.on?'Turn lending off and let the running job finish before you choose another circle.':'Choose which circle your computer lends to.'):availableCircles.length===1?'New jobs from this circle use the agents and limits you chose.':vm.switch?.on?'Turn lending off and let the running job finish before you choose another circle.':'Choose which circle your computer lends to.'}</p>
                {vm.switch?.on && (availableCircles.length>1||savedUnavailable) && !lending.current && <Action className="btn btn-secondary btn-sm" run={()=>mutate('lending/off',{})} success="Lending is off. Choose a circle, then turn lending on.">Turn off to change circle</Action>}
                {circleError&&<p role="alert">{circleError}</p>}
              </div>}
              </Card>
            </section>
          </div>
        </div>
      )}
      <LocalHistoryLearning api={api} mutate={mutate} />
      <Sheet open={pausing} onClose={() => setPausing(false)} label="Pause all agents"><div class="card-pad stack-4"><h2 class="t-title2">Pause all agents</h2><p>Pause all agents. Waiting offers are held, not declined, and return on Resume if still available. {RUNNING_JOB}</p>{pauseChoices(now).map(choice => <Button key={choice.id} kind={choice.id === 'hour' ? 'primary' : 'secondary'} disabled={offline} disabledReason={OFFLINE_REASON} onClick={() => pauseFor(choice)}>{choice.label}</Button>)}{offline && <p>{OFFLINE_REASON}</p>}<Button onClick={() => setPausing(false)}>Cancel</Button></div></Sheet>
    </div>
  );
}
