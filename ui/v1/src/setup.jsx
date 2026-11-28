import {EarlyBuilds} from './early-builds.jsx';
import { Action, go, Connection, OFFLINE_REASON } from './shared.jsx';
import { SignIn } from './signin.jsx';
import { checkView } from './signin.mjs';
import { useContext, useState, useRef, useEffect } from 'preact/hooks';
import { errorMessage, agentProduct } from './helpers.mjs';
import { Icon, Button, Spinner } from './ds/index.mjs';
import { SwingCard, SwingChip } from './ds/swing.jsx';
import { BlockerAction, DiskHelp } from './blockers.jsx';
import { setupRowsVM, setupDetailsVM } from './setup-details.mjs';
import { LENDING_ON_COPY } from './safety-copy.mjs';
import { setupVM, agentReadinessRows } from './view-models.mjs';
import { setupRemedyVM } from './setup-install.mjs';
import { CommandLineTool } from './command-line-tool.jsx';
import { useLendingReadiness } from './lending-readiness-read.mjs';

const isPhone = () => globalThis.matchMedia?.('(max-width: 899px)').matches === true;
const withCode = text => text.split('`').map((part, n) => n % 2 ? <code data-telemetry-private="setup" class="ph-no-capture">{part}</code> : part);

function Command({ text, label = 'Copy command' }) {
  return <div class="cmd ph-no-capture" data-telemetry-private="setup">
    <span class="p" aria-hidden="true">$</span><code>{text}</code>
    <Action className="copy" allowOffline run={() => navigator.clipboard.writeText(text)} success="Command copied.">
      <Icon name="copy" size="sm" label={label} />
    </Action>
  </div>;
}

function CheckAgain({ api, refresh, state }) {
  const { offline } = useContext(Connection);
  const [phase, setPhase] = useState('idle'), [at, setAt] = useState(null), [before, setBefore] = useState(state), [error, setError] = useState('');
  const view = checkView({ phase, at, changed: state !== before, error, zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  async function click() {
    setBefore(state); setError(''); setPhase('checking');
    try {
      const result = await api.get('readiness?refresh=true');
      setAt(Date.parse(result.observed_at ?? result.protection?.observed_at));
      await refresh();
    } catch (e) { setError(errorMessage(e)); }
    setPhase('done');
  }
  return <>
    <Button class="ph-no-capture" kind="secondary" pending={view.busy} disabled={offline} disabledReason={OFFLINE_REASON} title={offline ? OFFLINE_REASON : undefined} onClick={click} data-telemetry-private="setup"><Icon name="refresh" size="sm" />{view.label}</Button>
    {view.note && <span class="t-sm t-2 check-note ph-no-capture" role="status" aria-live="polite" data-telemetry-private="setup">{view.note}</span>}
  </>;
}

export function Actions({ api, step, refresh, onSigning }) {
  const names = step.actions ?? [];
  const [signing, setSigning] = useState(false);
  const buttons = [];
  if (names.includes('docker-signin')) buttons.push(<div class="ph-no-capture" key="s" data-telemetry-private="setup"><SignIn api={api} target="docker" refresh={refresh} onWaiting={waiting=>{setSigning(waiting);onSigning?.(waiting);}} /></div>);
  if (signing) return <div class="pair setup-pair ph-no-capture" data-telemetry-private="setup">{buttons}</div>;
  if (names.includes('docker-create')) buttons.push(<Button class="ph-no-capture" key="c" kind="secondary" href="https://hub.docker.com/signup" target="_blank" rel="noopener noreferrer" data-telemetry-private="setup">Create a Docker account<Icon name="ext" size="sm" /></Button>);
  if (names.includes('agent-signin') && step.agent?.signInSupported)
    buttons.push(<div class="ph-no-capture" key="a" data-telemetry-private="setup"><SignIn api={api} target={step.agent.id} agentName={step.agent.name} refresh={refresh} onWaiting={onSigning} /></div>);
  if (names.includes('agent-signin') && !step.agent?.signInSupported)
    buttons.push(<p key="unavailable" class="t-sm t-2 ph-no-capture" data-telemetry-private="setup">Sign-in is unavailable in this app for {step.agent?.name || step.title}. <a href="#/lend">Open Lending</a> for the manual steps.</p>);
  if (names.includes('recheck')) buttons.push(<CheckAgain key="r" api={api} refresh={refresh} state={step.state} />);
  return buttons.length ? <div class="pair setup-pair ph-no-capture" data-telemetry-private="setup">{buttons}</div> : null;
}

const STEP_STATE = { ok: 'Done', need: 'Needs you', bad: 'Needs fixing', waits: 'Waiting', todo: 'Waiting', now: 'Checking' };
const STEP_ICON = { sandboxes: 'laptop', 'docker-account': 'user', kvm: 'shield', circle: 'circles', agents: 'terminal' };

function ManagedSandboxInstall({ api, refresh }) {
  const [state, setState] = useState({phase:'idle'});
  const busy = !['idle','failed','installed'].includes(state.phase);
  useEffect(() => {
    let active=true;
    api.get?.('setup/install-sandbox').then(result=>{if(active&&result?.phase)setState(result);}).catch(()=>{});
    return ()=>{active=false;};
  }, []);
  useEffect(() => {
    if (!busy) return;
    let active = true;
    const poll = setInterval(() => api.get('setup/install-sandbox').then(result => {
      if(active) {setState(result);if(result.phase==='installed')void refresh();}
    }).catch(() => {}), 750);
    return () => {active=false;clearInterval(poll);};
  }, [busy]);
  async function install() {
    setState({phase:'checking'});
    try {setState(await api.post('setup/install-sandbox', {}));await refresh();}
    catch(error) {setState({phase:'failed',message:error.code==='sandbox_not_ready'
      ? 'Finish the sign-in or wait for the job, then try again.'
      : 'The sandbox installation did not finish. Retry installation.'});}
  }
  async function cancel() {
    try {setState(await api.post('setup/cancel-sandbox', {}));}
    catch {setState(current=>({...current,message:'Could not cancel the download. Try Cancel again.'}));}
  }
  const labels = {checking:'Looking for the sandbox…', downloading:'Downloading the sandbox from Docker…',verifying:'Checking the download…',unpacking:'Installing the sandbox…',installed:'The sandbox is installed.'};
  return <div class="stack-2" data-telemetry-private="setup">
    <p class="t-sm">Faravan downloads the sandbox from Docker and checks it before installing it.</p>
    <Button kind="primary" pending={busy} disabled={busy} disabledReason="The sandbox installation is already running." onClick={install}>{state.phase === 'failed' ? 'Retry installation' : 'Install the sandbox'}</Button>
    {state.phase==='downloading' && <Button kind="secondary" onClick={cancel}>Cancel</Button>}
    {busy && <progress aria-label="Sandbox installation" max={state.total || undefined} value={state.total ? state.received : undefined} />}
    <p class="t-sm" role="status">{state.message || labels[state.phase]}</p>
  </div>;
}

function DockerInstall({ install, phone, automaticCheckActive, api, refresh }) {
  if (install.managed) return <ManagedSandboxInstall api={api} refresh={refresh} />;
  return <div class="stack-2 docker-install ph-no-capture" data-telemetry-private="setup">
    <p class="t-sm"><b>{install.terminal}</b> {install.explain}</p>
    {install.command && <><p class="t-sm">{phone ? install.phone : ''}</p><Command text={install.command} label="Copy install command" /></>}
    <a class={'btn btn-' + (install.command ? 'secondary' : 'primary')} href={install.link.href} target="_blank" rel="noopener noreferrer">{install.link.label}<Icon name="ext" size="sm" /></a>
    <p class="t-sm">{automaticCheckActive ? install.after : 'Return here after installation, then choose Check again.'}</p>
  </div>;
}

function SetupRemedy({ text, phone }) {
  const remedy = setupRemedyVM(text);
  return <div class="stack-2 ph-no-capture" data-telemetry-private="setup">
    {remedy.text && <p class="t-sm">{withCode(remedy.text)}</p>}
    {remedy.commands.length > 0 && <>
      <p class="t-sm">This step needs a terminal on {phone ? 'the computer running Faravan' : 'this computer'}. {remedy.explanation}</p>
      {phone && <p class="t-sm">Copy this command and run it in a terminal on the computer running Faravan.</p>}
      {remedy.commands.map(command => <Command key={command} text={command} />)}
    </>}
  </div>;
}

function SetupAgentSignIn({ agent, api, mutate, refresh, onSigning }) {
  const [error,setError] = useState('');
  async function choose() {
    try {await mutate('agents/' + encodeURIComponent(agent.id), {useForLending:true});await refresh();}
    catch (e) {setError(errorMessage(e));}
  }
  return <div class="stack-2" data-telemetry-private="setup">
    {agent.signedIn === true ? <Button kind="primary" onClick={choose}>Lend with {agentProduct(agent.id).name}</Button>
      : <SignIn api={api} target={agent.lendingSignInTarget || agent.id} agentName={agentProduct(agent.id).name} refresh={choose} onWaiting={onSigning} />}
    {error && <><p role="status">{error}</p><Button kind="secondary" onClick={choose}>Try selecting this agent again</Button></>}
  </div>;
}

function StepContent({ item, api, refresh, agents, mutate, phone, automaticCheckActive, connected, retryLendingChecks, onSigning }) {
  const { step } = item;
  const dockerStopped = step.dockerStopped && ['need', 'bad'].includes(step.state);
  if (dockerStopped) return <>
    {/* One message: what the app knows about the stopped sandbox service, from the row itself (blockers.mjs). */}
    <SetupRemedy text={step.detail} phone={phone} />
    {step.remedy && !step.detail?.includes(step.remedy) && <SetupRemedy text={step.remedy} phone={phone} />}
    {(automaticCheckActive || !connected) && <p class="setup-step-detail t-sm ph-no-capture" data-telemetry-private="setup">{automaticCheckActive ? 'Faravan checks again automatically while this page is connected.' : 'Faravan can’t confirm changes until this page reconnects.'}</p>}
    {step.blocker && <BlockerAction item={step.blocker} primary={step.primary} api={api} agents={agents} mutate={mutate} refresh={refresh} />}
    <div class="setup-pair setup-step-cta ph-no-capture" data-telemetry-private="setup">
      <CheckAgain api={api} refresh={refresh} state={step.state} />
    </div>
  </>;
  const linkAction = step.primary && step.link && !step.blocker && (!step.actions?.length || (step.actions.includes('agent-signin') && !step.agent?.signInSupported));
  return <>
    <p class="setup-step-detail ph-no-capture" data-telemetry-private="setup">{step.detail}</p>
    {step.agentChoices?.map(agent => <SetupAgentSignIn key={agent.id} agent={agent} api={api} mutate={mutate} refresh={refresh} onSigning={onSigning} />)}
    {(step.disk ?? step.blocker?.disk) && (step.managedSandbox
      ? <p class="t-sm">Free space on this Mac, then choose Check again.</p>
      : <DiskHelp disk={step.disk ?? step.blocker.disk} />)}
    {step.retryLendingChecks && <Button class="ph-no-capture" kind="secondary" onClick={retryLendingChecks} disabled={!connected} disabledReason={OFFLINE_REASON} data-telemetry-private="setup">Check lending again</Button>}
    {step.dockerInstall && <DockerInstall install={step.dockerInstall} phone={phone} automaticCheckActive={automaticCheckActive} api={api} refresh={refresh} />}
    {step.instructions && <details class="setup-instruction ph-no-capture" data-telemetry-private="setup"><summary>{step.instructions.label}</summary><p class="t-sm t-2">{step.instructions.text}</p></details>}
    {step.command && <SetupRemedy text={step.command} phone={phone} />}
    {step.install?.map(agent => <details class="ph-no-capture" key={agent.id} data-telemetry-private="setup"><summary>How to install {agent.name}</summary><p class="t-sm t-2">{agentProduct(agent.id).install}</p></details>)}
    {step.remedy && <SetupRemedy text={step.remedy} phone={phone} />}
    {(step.blocker || step.actions?.length || step.link || step.id === 'check') && <div class="setup-step-footer ph-no-capture" data-telemetry-private="setup">
      <div class="setup-disclosures">
        {step.link && !linkAction && <a class="setup-row-link" href={step.link.href}>{step.link.label}</a>}
      </div>
      {step.state !== 'ok' && <div class="setup-step-actions">
        {linkAction && <Button kind="primary" href={step.link.href}>{step.link.label}</Button>}
        {step.blocker && <BlockerAction item={step.blocker} primary={step.primary} api={api} agents={agents} mutate={mutate} refresh={refresh} />}
        <Actions api={api} step={step} refresh={refresh} onSigning={onSigning} />
      </div>}
    </div>}
  </>;
}

const CHECK_LABEL = {signed_in:'Signed in', account:'Account', subscription:'Plan', weekly_window:'Weekly limit', conversion:'Price', job_control:'Job control', usage_estimate:'Usage estimate'};
export function LendingChecks({ agent }) {
  if (!agent?.checks) return <p class="t-xs t-2 ph-no-capture" data-telemetry-private="setup">Checking lending details.</p>;
  // Account calibration is explanatory; the backend determines admission.
  const list = <ul class="lending-checks t-xs ph-no-capture" data-telemetry-private="setup">{agent.checks.map(check => <li key={check.id}>
    <span class={'lending-check-mark ' + check.state} aria-label={check.state === 'pass' ? 'Passed' : check.state === 'fail' ? 'Failed' : 'Not confirmed'}>{check.state === 'pass' ? '✓' : check.state === 'fail' ? '×' : '○'}</span>
    <span><b>{CHECK_LABEL[check.id] ?? check.id}</b>{check.state !== 'pass' && <>: {check.line || check.fix ? <>{check.line} {check.fix}</> : 'Not confirmed. Check lending again, or open Lending for details.'}</>}</span>
  </li>)}</ul>;
  return <details class="lending-check-details ph-no-capture" data-telemetry-private="setup"><summary class="t-xs">Account details</summary>{list}
    {agent.checks.filter(check=>check.note).map(check=><p key={check.id} class="t-xs t-2 ph-no-capture" data-telemetry-private="setup">{check.note}</p>)}</details>;
}

// One block per account of an agent. With several accounts each block is named and has its own check button, which reads only
// that account. With one account the block is the plain check list, as before. That is intended: a lone account needs no
// heading to tell it from another, and the Setup step's own "check lending" action already reads it, so a per-account button
// would only repeat it. The test 'one account keeps the plain check list' pins this.
export function LendingAccountChecks({ rows, mutate, onChecked }) {
  if (!rows || rows.length < 2) return <LendingChecks agent={rows?.[0]} />;
  return <div class="lending-accounts ph-no-capture" data-telemetry-private="setup">{rows.map(row => <section key={row.accountKey ?? row.id} class="lending-account" data-account={row.accountKey ?? row.id}>
    <h4 class="t-xs lending-account-label">{row.accountLabel ?? row.id}</h4>
    <LendingChecks agent={row} />
    {mutate && row.accountKey && <Action className="btn btn-quiet btn-sm" run={() => mutate('agents/refresh', { accounts: [row.accountKey] })} onSuccess={onChecked} success={'Checked ' + (row.accountLabel ?? 'this account') + '.'}>Check {row.accountLabel ?? 'this account'}</Action>}
  </section>)}</div>;
}

function SetupRows({ api, vm, refresh, agents, mutate, readiness, lendingReadiness, phone, automaticRefreshActive, retryLendingChecks, onSigning }) {
  const rows = setupRowsVM(vm.steps.map(step => vm.ready ? { ...step, primary: false } : step)).items;
  const { offline, stale } = useContext(Connection);
  const connected = !offline && !stale;
  const automaticCheckActive = connected && automaticRefreshActive === true;
  const done = vm.done, required = vm.required;
  const current = vm.ready ? null : rows.find(item => item.step.primary) ?? rows.find(item => item.step.state === 'now');
  const currentHeading = useRef(null), previousCurrent = useRef(current?.step.primary ? current.key : null);
  useEffect(() => {
    // Focus follows the flow only from inside the checklist (or when nothing has focus); a background refresh
    // must not pull focus away from a control the person is using elsewhere.
    const active = document.activeElement, inFlow = !active || active === document.body || !!active.closest?.('.setup-checklist');
    if (previousCurrent.current && previousCurrent.current !== current?.key && inFlow)
      (current ? currentHeading.current : document.querySelector('.setup-summary h2'))?.focus();
    previousCurrent.current = current?.step.primary ? current.key : null;
  }, [current?.key]);
  return <section class="setup-plan ph-no-capture" aria-labelledby="needs-h" data-telemetry-private="setup">
    <div class="setup-section-head"><span id="needs-h">{vm.ready && vm.accountHold && vm.on ? 'Setup complete · Waiting to lend' : `${done} of ${required} required checks complete`}</span></div>
    {!vm.ready && <progress class="setup-progress" aria-label="Setup progress" value={done} max={required} />}
    <SwingCard className="setup-guide">
      {current && <article class="setup-current" data-blocker={current.key + (current.agent ? ':' + current.agent : '')} data-state={current.status}>
        <h2 class="swing-item-title" ref={currentHeading} tabIndex="-1">{['Install the sandbox','Sign in to Docker','Sign in to your agent','Check'].includes(current.label) ? current.label : current.step.dockerInstall ? 'Prepare Docker Sandboxes for friends’ jobs' : ({ sandboxes: 'Prepare Docker Sandboxes for friends’ jobs', 'docker-account': 'Connect your sandbox account' })[current.step.id] || current.label}</h2>
        <StepContent item={current} api={api} refresh={refresh} agents={agents} mutate={mutate} phone={phone} automaticCheckActive={automaticCheckActive} connected={connected} retryLendingChecks={retryLendingChecks} onSigning={onSigning} />
        <a class="btn btn-secondary" href="#/new">Borrow instead — Send a job</a>
        {automaticCheckActive && <p class="setup-auto-check" role="status"><Spinner />Checking automatically…</p>}
      </article>}
      <details class="setup-journey" id="setup-check-details" open={vm.steps.some(s => s.id === 'check') || globalThis.location?.hash === '#/setup/details'}><summary>What Faravan checks</summary>
        <div class="setup-journey-head"><strong>Your setup</strong></div>
        <ol class="setup-steps">
          {rows.filter(item => item.step.id !== 'circle' || item.step.state !== 'ok').map(item => {
            const { step } = item, active = item === current;
            const accountRows = item.agent ? agentReadinessRows(lendingReadiness, item.agent) : [], agent = accountRows[0] ?? null;
            const agentState = item.agent && (agent || step.state === 'ok') ? step.confirmed ? 'pass' : step.lendingCheckState === 'fail' ? 'fail' : 'pending' : null;
            const shownState = agentState === 'pass' ? (step.lendingCheckState === 'pass' ? 'Done' : 'Signed in')
              : agentState === 'fail' ? (step.required ? 'Check this account' : 'Optional check failed')
              : accountRows.some(row => row.hasReading) ? 'Not confirmed' : 'Not checked yet';
            return <li key={step.id} data-blocker={item.key + (item.agent ? ':' + item.agent : '')} data-state={item.status} aria-current={active ? 'step' : undefined}>
              <span class="setup-step-icon" aria-hidden="true"><Icon name={step.state === 'ok' ? 'check-circle' : STEP_ICON[step.id] || 'terminal'} size="sm" /></span>
              <div class="setup-step-copy"><div class="setup-step-heading"><h3>{step.title}{step.required === false ? ' · Optional' : ''}</h3><SwingChip tone={agentState ? agentState === 'pass' ? 'ok' : agentState === 'fail' ? 'needs' : 'neutral' : step.state === 'ok' ? 'ok' : active && step.primary ? 'needs' : 'neutral'}>{agentState ? shownState : STEP_STATE[step.state]}</SwingChip></div>
                {!active && !agentState && <p class="setup-step-state">{step.detail}</p>}
                {agentState && (step.state === 'ok' ? <LendingAccountChecks rows={accountRows} mutate={mutate} onChecked={retryLendingChecks} /> : <><p class="t-sm t-2">{step.detail}</p><LendingAccountChecks rows={accountRows} mutate={mutate} onChecked={retryLendingChecks} /></>)}
              </div>
            </li>;
          })}
        </ol>
        <div class="setup-preparation ph-no-capture" data-preparation-observation data-state={vm.preparation.state} data-telemetry-private="setup">
          <div class="setup-step-heading"><h3>Sandbox preparation · Optional observation</h3><SwingChip tone={vm.preparation.state === 'prepared' ? 'ok' : 'neutral'}>{vm.preparation.label}</SwingChip></div>
          <p class="setup-step-state" role="status">{vm.preparation.detail}</p>
          <progress aria-label="Sandbox preparation observation" value={vm.preparation.done} max={1} />
        </div>
        <SetupDetails readiness={readiness}  />
        <p class="t-xs t-2 blocker-help">Checks report independently. Fix the issue shown above, then check again.</p>
      </details>
      {vm.optionalNotReady && <p class="t-sm t-2">{vm.steps.filter(s => s.id.startsWith('agent:') && !s.required && !s.confirmed).map(s => s.title + ': Open Lending to finish its checks').join(' ')} <a href="#/lend">Open Lending →</a></p>}
      <a class="setup-send-job btn btn-secondary" href="#/jobs/new">Send a job</a>
    </SwingCard>
  </section>;
}

function Frame({ vm, children }) {
  return <div class="setup-content ph-no-capture" data-view="setup" data-state={vm.kind} onFocusCapture={event => {
    const node = event.target, dock = document.querySelector('.tabbar'), limit = dock?.getBoundingClientRect().top ?? innerHeight;
    if (node.matches(':focus-visible') && node.getBoundingClientRect().bottom > limit) node.scrollIntoView({ block: 'center' });
  }} data-telemetry-private="setup">{children}</div>;
}

const Head = ({ vm, headingRef }) => <div class="stack-2 setup-head ph-no-capture" data-telemetry-private="setup">
  <h1 class="t-page" ref={headingRef} tabIndex="-1">{vm.kind === 'unsupported' ? vm.headline : vm.on || vm.executionActive || vm.intentUnknown ? vm.headline : vm.ready ? <><Icon name="check-circle" /> Your computer is ready</> : 'Getting this computer ready to lend'}</h1>
  <p class="t-2" role="status">{vm.lead} {vm.on && <a href="#/lend">Open Lending →</a>}</p>
</div>;

export function SetupDetails({ readiness, copyDetails = null }) {
  const ref = useRef();
  const open = globalThis.location?.hash === '#/setup/details';
  const vm = setupDetailsVM(readiness);
  const checked = checkView({ phase: 'done', at: Date.parse(readiness?.observed_at ?? readiness?.protection?.observed_at), changed: true, zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  useEffect(() => { if (open && ref.current) { ref.current.open = true; ref.current.scrollIntoView({ block: 'center' }); } }, [open]);
  return <details class="setup-details ph-no-capture" id="setup-safety-details" ref={ref} open={open} data-telemetry-private="setup">
    <summary>Details</summary>
    <div class="stack-3"><p class="t-sm">{vm.summary}</p>
      {Number.isFinite(Date.parse(readiness?.observed_at ?? readiness?.protection?.observed_at)) && <p class="t-xs t-2">{checked.note}</p>}
      <dl class="setup-protections">{vm.rows.map((row, i) => <div key={i} data-result={row.state}><dt>{row.label}</dt><dd><Icon name={row.state === 'Passed' ? 'check-circle' : row.state === 'Needs attention' ? 'alert' : 'clock'} size="sm" /><span>{row.state}</span>{row.detail && <p class="t-xs t-2">{row.detail}</p>}</dd></div>)}</dl>
      {copyDetails !== null && <div class="setup-copy"><Action className="btn btn-secondary btn-sm" allowOffline run={() => navigator.clipboard.writeText(copyDetails)} success="Details copied.">Copy details</Action></div>}
    </div>
  </details>;
}

export function Setup({ api, data, agents, circles, circle, lending, mutate, refresh, headingRef, phone = isPhone(), automaticRefreshActive = false }) {
  const lendCircle = circles.find(c => c.id === (lending.circle || circle));
  const {value: lendingReadiness, error: lendingReadinessError, retry: retryLendingChecks} = useLendingReadiness(api, data.readiness, data.agents, data.lendingReadiness ?? null);
  const [signing,setSigning] = useState(false);
  const signInView = useRef(null);
  const nextVM = setupVM({ readiness: data.readiness, agents: data.agents ? agents : undefined, status: { ...data.home, lending }, devices: data.devices, circle: lendCircle, lendingReadiness, lendingReadinessError, zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  // Keep the open sign-in mounted until its flow ends, even if credentials
  // become visible to a background readiness refresh first.
  const vm = signing ? signInView.current : nextVM;
  const onSigning = waiting => {signInView.current=waiting ? vm : null;setSigning(waiting);};
  const summaryHeading = useRef(null);
  const automaticCheck = !signing && vm.steps.find(s => s.automaticCheck)?.id;
  const checkStarted = useRef(false);
  useEffect(() => {
    if (!automaticCheck) {checkStarted.current=false;return;}
    if (checkStarted.current) return;
    checkStarted.current=true;
    api.get('readiness?refresh=true').then(() => refresh()).catch(() => {});
  }, [automaticCheck]);
  if (vm.kind === 'unsupported') return <Frame vm={vm}>
    <div class="stack-6"><div><Head vm={vm} headingRef={headingRef} /></div>
      <SwingCard className="setup-unsupported"><div class="card-pad stack-3">
        <b>{vm.card.title}</b><p class="t-sm t-2">{withCode(vm.card.text)}</p>
        <div class="pair setup-pair"><Button kind="primary" href={vm.card.action.href}>{vm.card.action.label}</Button></div>
      </div></SwingCard>
    </div>
  </Frame>;

  return <Frame vm={vm}>
    <Head vm={vm} headingRef={headingRef} />
    <p class="t-sm t-2 setup-selected-circle">Selected circle: {vm.circleName || 'None selected'} · <a href="#/circles">All memberships in Circles</a></p>
    {!vm.on && <p class="t-sm t-2 setup-off-copy">{!vm.confirmedOff ? "Faravan can't confirm whether lending is on. Do not rely on lending being off until this computer’s status loads again." : vm.executionActive ? 'No new friends’ jobs start until you turn lending on. The job already running can finish.' : 'No friends’ jobs run until you turn lending on.'}</p>}
    <div class="setup-grid" data-variant={new URLSearchParams(globalThis.location?.search).get('bigswing') === 'b' ? 'b' : 'a'}>
      <div class="setup-checklist"><SetupRows api={api} vm={vm} refresh={refresh} agents={agents} mutate={mutate} readiness={data.readiness} lendingReadiness={lendingReadiness} phone={phone} automaticRefreshActive={automaticRefreshActive} retryLendingChecks={retryLendingChecks} onSigning={onSigning} /></div>
      <div class="setup-supporting">
        <SwingCard className="setup-summary"><div class="setup-summary-body">
          <h2 class="t-title3" ref={summaryHeading} tabIndex="-1">{vm.summary.title}</h2>
          {vm.summary.text && <p class="t-sm t-2">{vm.summary.text}</p>}
          {vm.readinessNote && <p class="t-sm t-2" role="status">{vm.readinessNote}</p>}
          {lendingReadinessError && <Button kind="secondary" onClick={retryLendingChecks}>Check lending again</Button>}
          {vm.on ? <Button kind="secondary" block href="#/lend">Open Lending</Button> : vm.ready ? (
            <Action className="btn btn-primary btn-block" run={() => mutate('lending/' + (vm.latched ? 'resume' : 'on'), { circle: lendCircle?.id || circle })}
              onSuccess={() => go('lend')} success="Lending is on. Your approval mode and limits apply." disabled={!(lendCircle?.id || circle)} disabledReason="Choose a circle first">
              {vm.summary.cta}
            </Action>
          ) : <p class="t-sm t-2">{vm.summary.waiting}</p>}
          {(vm.on || vm.ready) && <a class="t-sm setup-row-link" href="#/lend/limits">Review lending limits →</a>}
        </div></SwingCard>
        <EarlyBuilds api={api} />
        <details class="setup-cli-details"><summary>Command-line tool · Optional</summary>
          <CommandLineTool api={api} initialResult={data.commandPath} installActionAvailable={vm.ready} />
        </details>
        {!vm.on && <SwingCard className="setup-meaning"><div class="card-pad stack-2"><h2 class="t-title3">What lending means</h2><p class="t-sm t-2">{LENDING_ON_COPY}</p></div></SwingCard>}
      </div>
    </div>
  </Frame>;
}
