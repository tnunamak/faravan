import {visibleInterval} from './display-visibility.mjs';
import { useEffect, useState, useRef, useContext } from 'preact/hooks';
import { Button, Icon, Card, Facts, Command, Status, Switch } from './ds/index.mjs';
import { hostContact, hostRestartVM, hostStartProgress, keepAwakeVM } from './circles-view.mjs';
import { Action, Connection, Notices, OFFLINE_REASON, useResource } from './shared.jsx';
import { errorMessage } from './helpers.mjs';
import { hostChooseVM, hostStatusVM, hostComputerReference, hostFactsFor, hostStopCopy, nameHostComputerInCopy } from './view-models.mjs';
import {StartAnotherCircle} from './start-circle.jsx';
import {enc, go} from './shared.jsx';
import {formatDayTime} from './dates.mjs';

export function hostingObservation(previous, next, error, checkedAt = Date.now()) {
  return error ? {...previous, stale: true} : {stale: false, checkedAt, lastOnlineAt: next?.running ? checkedAt : previous?.lastOnlineAt};
}

export async function copyHostingDetails(details, clipboard = globalThis.navigator?.clipboard) {
  try {
    if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
    await clipboard.writeText(details);
    return {message: 'Hosting details copied.', fallback: false};
  } catch {
    return {message: 'Couldn’t copy. Select and copy these details.', fallback: true};
  }
}

const REMEMBER = 'faravan-host-choice';
const saved = () => { try { return JSON.parse(globalThis.localStorage?.getItem(REMEMBER) ?? '{}') || {}; } catch { return {}; } };
const save = (value) => { try { globalThis.localStorage?.setItem(REMEMBER, JSON.stringify(value)); } catch { /* not remembered */ } };

const Banner = ({ banner, children }) => (
  <div class={('banner ' + banner.tone) + ' ph-no-capture'} role={banner.tone === 'bad' ? 'alert' : 'status'} data-telemetry-private="host">
    <Icon name={banner.icon} />
    <div class="grow"><b>{banner.headline}</b><p class="t-sm">{banner.text}</p>{children}</div>
  </div>
);

function StartControl({ body, onStart, pending, blocked, elapsed, error, errorRef, label, disabled = false, disabledReason = '', submit = false }) {
  const { offline } = useContext(Connection);
  return <div class="stack-2 ph-no-capture" data-telemetry-private="host">
    <Button kind="primary" type={submit ? 'submit' : 'button'} pending={pending} disabled={!body || disabled || pending || blocked || offline} disabledReason={offline ? OFFLINE_REASON : disabledReason || (!body ? 'Choose how to start first.' : 'Waiting for the current step to finish.')} noHint={Boolean(disabledReason) && !offline} title={offline ? OFFLINE_REASON : undefined}
      onClick={submit ? undefined : () => onStart(body)}>{label}</Button>
    {disabledReason && <p class="t-sm t-2" role="status">{disabledReason}</p>}
    {offline && <p class="t-sm t-2" role="status">{OFFLINE_REASON}</p>}
    {pending && <p class="t-sm t-2" role="status">{hostStartProgress(true, elapsed)}</p>}
    {blocked && <p class="t-sm t-2" role="status">Hosting status is unconfirmed. Use Retry hosting status above.</p>}
    {error && <p class="t-sm bad-text" role="alert" tabIndex="-1" ref={errorRef}>{error}</p>}
  </div>;
}

// host-choose: how friends reach this computer. Starting is in-app; the terminal command stays available as a fallback.
export function HostChoose({ choice, onChoice, onStart, pending = false, blocked = false, elapsed = 0, error = '', startErrorRef = null, viewerSession, computerName }) {
  const vm = hostChooseVM(choice, {viewerSession, computerName});
  const {offline}=useContext(Connection);
  return (
    <form class="stack-6 host ph-no-capture" onSubmit={event=>{event.preventDefault();if(vm.start&&choice.name?.trim()&&!pending&&!blocked&&!offline)onStart(vm.start);}} data-telemetry-private="host">
      <label class="field"><span class="t-sm"><b>Circle name</b></span>
        <input class="input" aria-label="Circle name" value={choice.name} placeholder="For example, Weekend projects" maxLength="256" disabled={pending || blocked} onInput={(e) => onChoice({ name: e.currentTarget.value })} />
      </label>
      <fieldset class="stack-2 host-ways">
        <legend class="section-legend">{nameHostComputerInCopy('How friends reach this computer', hostComputerReference(viewerSession, computerName))}</legend>
        <Card>
          {vm.methods.map((m) => (
            <label class={'way' + (m.selected ? ' on' : '')}>
              <input type="radio" name="host-way" value={m.id} checked={m.selected} disabled={pending || blocked} onChange={() => onChoice({ method: m.id })} />
              <span class="grow">
                <b>{m.title}</b>{m.tag && <span class="t-xs t-2"> · {m.tag}</span>}
                <span class="t-sm t-2 block">Needs: {m.needs}</span>
                <span class={'t-xs block' + (m.warn ? ' warn' : ' t-2')}>{m.fact}</span>
              </span>
            </label>
          ))}
        </Card>
      </fieldset>
      <p class="t-sm t-2">Invitations use one fixed address. Keep it when restarting the circle.</p>
      <Facts items={vm.facts} label="What hosting means" />
      {vm.start
        ? <StartControl submit body={vm.start} onStart={onStart} pending={pending} blocked={blocked} disabled={!choice.name?.trim()} disabledReason={!choice.name?.trim() ? 'Name your circle to start it.' : ''} elapsed={elapsed} error={error} errorRef={startErrorRef} label="Start circle" />
        : <section class="stack-2"><p class="t-sm">Review and approve an offer in a terminal on the host computer.</p><Command text={vm.command}/></section>}
      {vm.start && <details class="stack-2"><summary>Start from a terminal</summary><Command text={vm.command}/></details>}
    </form>
  );
}

function KeepAwake({ value, api, onUpdated, onRead, computerReference }) {
  const [pending, setPending] = useState(''), [problem, setProblem] = useState('');
  const saving = Boolean(pending);
  const [requestedAt, setRequestedAt] = useState(Date.now), [now, setNow] = useState(Date.now);
  const outcome = useRef(null);
  const unconfirmed = value.enabled && !value.active;
  useEffect(() => {
    if (!unconfirmed) return;
    const started = Date.now();
    setRequestedAt(started);setNow(started);
  }, [unconfirmed]);
  useEffect(() => {
    if (!unconfirmed) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, requestedAt + 10000 - Date.now()));
    return () => clearTimeout(timer);
  }, [unconfirmed, requestedAt]);
  // Release state takes precedence over the configured switch and last active flag.
  const releaseCopy = {
    __proto__: null,
    stopping: 'Releasing the keep-awake request. Release is not confirmed yet.',
    stop_failed: 'The keep-awake request could not be released. Release is not confirmed.',
    power_unknown: 'Power status is unknown. No new keep-awake request will start.',
    stopped: 'The keep-awake request has been released.',
  }[value.reason];
  const view = releaseCopy ? {text: releaseCopy, retry: value.reason !== 'stopped'} : keepAwakeVM(value, {now, requestedAt});
  const update = async (on, retry = false) => {
    if (saving) return;
    setPending(retry ? 'check' : 'save');setProblem('');
    try {const run = () => retry ? api.get('hosting') : api.post('hosting/keep-awake', {on}); if (onRead) await onRead(run); else onUpdated(await run());}
    catch(e) {setProblem(errorMessage(e));}
    finally {setPending('');if(retry)requestAnimationFrame(() => outcome.current?.focus());}
  };
  return <Card class="ph-no-capture" pad data-telemetry-private="host">
    <div class="hstack-3"><div class="grow"><b>{nameHostComputerInCopy('Keep this computer awake while it hosts', computerReference)}</b>
      <p class="t-sm t-2" id="keep-awake-reason" role={problem ? 'alert' : 'status'} tabIndex="-1" ref={outcome}>{problem || nameHostComputerInCopy(view.text, computerReference)}{view.retry && <> · <button type="button" class="linklike t-sm" aria-disabled={saving} aria-busy={saving} onClick={() => update(undefined, true)}>Check again</button></>}</p>
    </div><Switch label={nameHostComputerInCopy('Keep this computer awake while it hosts', computerReference)} aria-describedby="keep-awake-reason" checked={value.enabled} aria-disabled={saving} aria-busy={saving} onChange={on => update(on)} /></div>
    {saving && <p class="t-sm t-2" role="status">{pending === 'check' ? 'Checking sleep preference…' : 'Saving sleep preference…'}</p>}
  </Card>;
}

// host-running, host-woke, host-address-changed and the stopped state, as one view of the host's own report.
export function HostStatus({ vm, onCopyDetails, hosting, api, onUpdated, onStart, pending = false, blocked = false, elapsed = 0, startError = '', startErrorRef = null, computerReference = null, stale = false, lastOnlineAt = null, onRefresh, onRead }) {
  const [changeAddress, setChangeAddress] = useState(false), [confirmStop, setConfirmStop] = useState(false);
  const changeTrigger=useRef(null), stopTrigger=useRef(null);
  const stopKey = useRef(null);
  const stopCopy = hostStopCopy(hosting, computerReference);
  const stop = async () => {
    const run = async () => {
    stopKey.current ??= globalThis.crypto?.randomUUID();
    try {
      await api.request('ops/hosting.stop', {method:'POST',headers:{'content-type':'application/json','faravan-confirm':'yes','idempotency-key':stopKey.current},body:'{}'});
    } catch(error) {
      if(Number.isInteger(error.status))stopKey.current=null;
      throw error;
    }
    stopKey.current=null;
    const next=await api.get('hosting');
    return next;
    };
    const next = onRead ? await onRead(run) : await run();
    if (next) {setConfirmStop(false);if (!onRead) onUpdated(next);}
    return next;
  };
  return (
    <div class="stack-6 host ph-no-capture" data-telemetry-private="host">
      {stale && <p role="status">Hosting status unknown.{lastOnlineAt ? ' Last confirmed online ' + formatDayTime(lastOnlineAt) + '.' : ' Last known status is shown below.'}</p>}
      {stale && vm.kind === 'setup-failed' && <p class="t-sm bad-text" role="alert" tabIndex="-1" ref={startErrorRef}>{vm.banner.text}</p>}
      {!stale && vm.banner && (
        <Banner banner={vm.banner}>
          {vm.kind === 'stopped' && (onStart && hostRestartVM(hosting)
            ? <StartControl body={hostRestartVM(hosting)} onStart={onStart} pending={pending} blocked={blocked} elapsed={elapsed} error={startError} errorRef={startErrorRef} label="Start again" />
            : <p class="t-sm">To start hosting, open Start from a terminal below.</p>
          )}
        </Banner>
      )}
      {vm.kind === 'address-changed' && <p class="t-xs t-2">{vm.reference} · <button class="linklike" type="button" onClick={onCopyDetails}>Copy details</button></p>}
      {vm.kind === 'address-changed' && <Card pad class="stack-3"><h2 class="t-title3">About this address</h2><p class="t-sm t-2">{stale ? 'At the last successful check, the invitation address did not match the host address. The current address and publishing status are unknown. This app does not support changing the address used by existing invitations.' : nameHostComputerInCopy('The circle’s invitation address does not match the address this computer now serves. Faravan will not publish the circle until they match. This app does not support changing the address used by existing invitations.', computerReference)}</p><p class="t-sm t-2">{vm.restore || hosting.route?.binding?.remedy?.instructions || 'Restore the saved invitation address, then check hosting status again.'}</p><Action className="btn btn-secondary" run={onRefresh || (async () => onUpdated(await api.get('hosting')))} success="">Check hosting status</Action></Card>}
      {vm.kind === 'running' && (
        <Card pad>
          <div class="stack-3">
            <div class="hstack-2"><Icon name="laptop" /><b>{vm.headline}</b><Status kind={stale ? 'wait' : 'on'} word={stale ? 'Last known status: ' + vm.status : vm.status} /></div>
            <p>{vm.line}</p>
            {!stale && vm.reached && <p class="t-sm t-2">{vm.reached}</p>}
            {!stale && vm.inviteHref && <Button kind="primary" block href={vm.inviteHref}><Icon name="share" size="sm" />Invite someone</Button>}
          </div>
          <p class="t-sm t-2">{nameHostComputerInCopy('This computer runs the circle. Hosting does not mean it is lending.', computerReference)}</p>
          <p class="t-sm t-2">Lending and job availability are shown separately on Lend.</p>
        </Card>
      )}
      {vm.kind === 'running' && !stale && hosting && <div class="stack-6">
        {hosting.keepAwake && <KeepAwake value={hosting.keepAwake} api={api} onUpdated={onUpdated} onRead={onRead} computerReference={computerReference} />}
        <div class="hstack-2 wrap"><Button href="#/circles/new">Start another circle</Button><Button onClick={event => {changeTrigger.current=event.currentTarget;setChangeAddress(!changeAddress);}} aria-expanded={changeAddress}>About this address</Button><Button kind="danger" onClick={event => {stopTrigger.current=event.currentTarget;setConfirmStop(!confirmStop);}} aria-expanded={confirmStop}>Stop hosting</Button></div>
        {changeAddress && <Card pad class="stack-3"><h2 class="t-title3">About this address</h2><p class="t-sm t-2">This address is included in the circle’s invitations. This app does not currently support changing it.</p><Button kind="quiet" onClick={() => {setChangeAddress(false);requestAnimationFrame(() => changeTrigger.current?.focus());}}>Close</Button></Card>}
        <Facts items={hostFactsFor(computerReference)} label="What hosting means" />
      </div>}
      {vm.kind === 'address-changed' && !stale && hosting?.running && <Button kind="danger" onClick={event => {stopTrigger.current=event.currentTarget;setConfirmStop(!confirmStop);}} aria-expanded={confirmStop}>Stop hosting</Button>}
      {['running', 'address-changed'].includes(vm.kind) && !stale && hosting?.running && confirmStop && <Card pad class="stack-3"><h2 class="t-title3">{stopCopy.title}</h2><p class="t-sm t-2">{stopCopy.members} {stopCopy.data}</p><div class="hstack-2 wrap"><Button kind="quiet" onClick={() => {setConfirmStop(false);requestAnimationFrame(() => stopTrigger.current?.focus());}}>Keep hosting</Button><Action className="btn btn-danger" run={stop} success={next => !next ? 'Hosting status changed. Check its current status.' : next.running ? 'Hosting is still running. Check its status before trying again.' : 'Hosting stopped.'}>{stopCopy.action}</Action></div></Card>}
      {vm.kind === 'unreadable' && <div class="hstack-2 wrap"><Action className="btn btn-secondary" run={onRefresh} success="">Check hosting status</Action></div>}
      {vm.kind === 'setup-uncertain' && <div class="hstack-2 wrap"><Action className="btn btn-secondary" run={onRefresh} success="">Check hosting status</Action><Button href="#/circles">Inspect circles</Button></div>}
      {vm.kind === 'setup-failed' && <div class="hstack-2 wrap"><Action className="btn btn-secondary" run={onRefresh} success="">Check hosting status</Action><Button href="#/circles">Inspect circles</Button></div>}
      {vm.kind === 'stopped' && (
        <div class="stack-4">
          {stale && onStart && hostRestartVM(hosting) && <StartControl body={hostRestartVM(hosting)} onStart={onStart} pending={pending} blocked={blocked} elapsed={elapsed} error={startError} errorRef={startErrorRef} label="Start again" />}
          <details class="stack-2"><summary>Start from a terminal</summary>
            <section class="stack-2" aria-labelledby="host-term"><h2 class="t-sm t-2" id="host-term">In a terminal</h2><Command text={vm.command} /></section>
          </details>
        </div>
      )}
    </div>
  );
}

const refusedMessage = detail => 'Starting hosting was refused. ' + detail;
// On #/circles/new the page is always the new-circle form. A stopped hosted circle is one note that links to its own page.
export function StoppedHostNote({ name }) {
  return <p class="t-sm t-2 ph-no-capture" role="status" data-telemetry-private="host">{(name || 'Your hosted circle') + ' isn’t running on this computer. Starting a new circle starts hosting here again, at the same address. '}<a href="#/circles/host">{'Open ' + (name ? name + ' hosting' : 'hosting')}</a></p>;
}

export function Host({ api, data, headingRef, refresh, mutate, newCircle = false, viewerSession }) {
  const notices=useContext(Notices);
  const [loadError, setLoadError] = useState('');
  const [observation, setObservation] = useState({stale: false});
  const [copyResult, setCopyResult] = useState(null);
  const requestOwner = useRef({api, generation: 0, active: true});
  if (requestOwner.current.api !== api) requestOwner.current = {api, generation: 0, active: true};
  const failHosting = error => {setLoadError(errorMessage(error));setObservation(previous => hostingObservation(previous, null, error));};
  const [hosting, setHosting] = useState(undefined), [choice, setChoice] = useState(() => ({method:saved().method??'lan',name:''}));
  const [starting, setStarting] = useState(false), [elapsed, setElapsed] = useState(0), [startError, setStartError] = useState(''), [needsReconcile, setNeedsReconcile] = useState(false);
  const startingRef = useRef(false), startKeys = useRef(new Map()), startedAt = useRef(0), lastStart = useRef(null), configuredAtOpen = useRef(null);
  const startErrorRef = useRef(null), needsReconcileRef = useRef(false);
  // Preserve a refused Start through failed status reads; a running process alone cannot prove setup succeeded.
  const refusedStart = useRef(''), failedSetup = useRef(''), uncertainSetup = useRef('');
  const unconfirmedStart = () => refusedStart.current
    ? refusedMessage(refusedStart.current) + ' Current hosting status could not be refreshed. Retry hosting status before starting again.'
    : errorMessage({code:'hosting_uncertain'});
  const hasCircles = (hosting?.circles?.length ?? (hosting?.circle ? 1 : 0)) > 0;
  const acceptHosting = (next) => {
    if(configuredAtOpen.current===null)configuredAtOpen.current=next.configured;
    setHosting(next);setLoadError('');setObservation(previous => hostingObservation(previous, next));
    if (next.running && !uncertainSetup.current) {startKeys.current.clear();if (!failedSetup.current) refusedStart.current='';}
    if (needsReconcileRef.current) {
      needsReconcileRef.current = false;
      setNeedsReconcile(false);
      if (next.running) {
        setStartError(failedSetup.current);
        requestAnimationFrame(() => headingRef?.current?.focus());
        try { refresh?.(); } catch { /* Hosting status is confirmed locally. */ }
      } else {
        if(lastStart.current?.answered)startKeys.current.delete(lastStart.current.payload);
        setStartError(refusedStart.current ? refusedMessage(refusedStart.current) : errorMessage({code:'hosting_uncertain'}));
      }
    }
  };
  const readHosting = async (run = () => api.get('hosting')) => {
    const owner = requestOwner.current, generation = ++owner.generation;
    const current = () => owner.active && requestOwner.current === owner && owner.generation === generation;
    try {
      const next = await run();
      if (!current()) return null;
      acceptHosting(next);
      return next;
    } catch (error) {
      if (!current()) return null;
      failHosting(error);
      throw error;
    }
  };
  const retryHosting = () => readHosting();
  useEffect(() => {
    const owner = requestOwner.current;owner.active = true;
    setHosting(undefined);setLoadError('');setObservation({stale: false});
    startingRef.current=false;setStarting(false);needsReconcileRef.current=false;setNeedsReconcile(false);setStartError('');refusedStart.current='';failedSetup.current='';uncertainSetup.current='';lastStart.current=null;startKeys.current.clear();configuredAtOpen.current=null;
    const load = () => readHosting().catch(() => {});
    const stopPolling = visibleInterval(load, 15000);
    return () => {owner.active = false;++owner.generation;stopPolling();};
  }, [api]);
  useEffect(() => {
    if (!starting) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [starting]);
  useEffect(() => { if (startError) requestAnimationFrame(() => startErrorRef.current?.focus()); }, [startError]);
  const jobs = useResource(api, hosting?.circle ? 'jobs?circle=' + encodeURIComponent(hosting.circle) : null, hosting?.lastReachedAt);
  const computerName = data?.devices?.name;
  const computerReference = hostComputerReference(viewerSession, computerName);
  const vm = hostStatusVM(hosting ?? { configured: false }, {viewerSession, computerName, setupError: failedSetup.current, setupUncertain: uncertainSetup.current});
  if (vm.kind === 'running') vm.reached = hostContact({...hosting, selfKey:data?.devices?.fingerprint}, jobs.data || []);
  const update = (patch) => {
    if (startingRef.current || needsReconcileRef.current) return;
    setChoice((old) => { const next = { ...old, ...patch }; const {name, ...remembered}=next;save(remembered);return next; });
  };
  const start = async (body) => {
    if (!body || startingRef.current || needsReconcileRef.current) return;
    const context = requestOwner.current;
    const contextCurrent = () => context.active && requestOwner.current === context;
    ++context.generation;
    startingRef.current = true;
    setStarting(true);setElapsed(0);setStartError('');notices?.set('');
    startedAt.current = Date.now();
    const payload = JSON.stringify(body);
    let key = startKeys.current.get(payload);
    if (!key) {
      key = globalThis.crypto?.randomUUID?.() || 'host-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      startKeys.current.set(payload, key);
    }
    let operationError = null;
    // A previous lost reply may already have started the host. Reconcile before retrying.
    if (lastStart.current) {
      try {const current=await readHosting();if(!current){if(contextCurrent()){startingRef.current=false;setStarting(false);}return;}if(current.running){if(!failedSetup.current)refusedStart.current='';setStartError(failedSetup.current);startingRef.current=false;setStarting(false);if(newCircle&&current.circle&&!failedSetup.current&&!uncertainSetup.current)go('circle/'+enc(current.circle));else requestAnimationFrame(() => headingRef?.current?.focus());return;}}
      catch(error){if(!contextCurrent())return;needsReconcileRef.current=true;setNeedsReconcile(true);setStartError(unconfirmedStart());startingRef.current=false;setStarting(false);return;}
    }
    refusedStart.current='';failedSetup.current='';
    const operation = {payload,answered:false};lastStart.current=operation;
    try { await api.request('ops/hosting.start', {method:'POST',headers:{'content-type':'application/json','faravan-confirm':'yes','idempotency-key':key},body:payload}); operation.answered=true; uncertainSetup.current=''; }
    catch (error) { if (!contextCurrent()) return; operationError = error; operation.answered=Number.isInteger(error.status); if (operation.answered) {uncertainSetup.current='';failedSetup.current=errorMessage(error);refusedStart.current=failedSetup.current;} else uncertainSetup.current=errorMessage(error); }
    if (!contextCurrent()) return;
    try {
      const next = await readHosting();
      if (!next) return;
      if (next.running && operationError) setStartError(failedSetup.current);
      else if (next.running) requestAnimationFrame(() => headingRef?.current?.focus());
      else if (refusedStart.current) setStartError(refusedMessage(refusedStart.current));
      else if (operationError) setStartError(errorMessage(operationError));
      else setStartError(errorMessage({code:'hosting_uncertain'}));
      if (!next.running && operation.answered) startKeys.current.delete(payload);
      try { await refresh?.(); } catch { /* The hosting status poll can retry. */ }
      if (newCircle && !operationError && next.running && next.circle) go('circle/' + enc(next.circle));
    } catch (error) {
      if (!contextCurrent()) return;
      needsReconcileRef.current = true;setNeedsReconcile(true);
      setStartError(unconfirmedStart());
    } finally {
      if (contextCurrent()) {startingRef.current = false;setStarting(false);}
    }
  };
  return (
    <div class="host-page ph-no-capture" data-telemetry-private="host">
      <a class="back" href="#/circles"><Icon name="chev-l" size="sm" />Circles</a>
      <h1 class="t-page" ref={headingRef} tabIndex="-1">{newCircle ? hasCircles ? 'Start another circle' : 'Start a circle' : vm.title}</h1>
      {loadError && <div class="banner bad" role="alert"><p>{loadError}</p><Action className="btn btn-secondary" run={retryHosting} success="">Retry hosting status</Action></div>}
      {hosting === undefined ? !loadError && <div class="circle-skeleton" role="status" aria-label="Loading hosting status"><span /><span /><span /></div>
        : newCircle && configuredAtOpen.current && hasCircles && !failedSetup.current && !uncertainSetup.current && !hosting.unreadable && hosting.processState !== 'unreadable' ? <>
          {hosting.running === false && <StoppedHostNote name={hosting.name} />}
          <StartAnotherCircle mutate={mutate} refresh={refresh} first={!hasCircles} computerReference={computerReference} />
        </>
        : vm.kind === 'choose' ? <><p class="t-sm t-2">{vm.setupNotice}</p><HostChoose choice={choice} onChoice={update} onStart={start} pending={starting} blocked={needsReconcile || observation.stale} elapsed={elapsed} error={startError} startErrorRef={startErrorRef} viewerSession={viewerSession} computerName={computerName} /></>
        : <HostStatus key={vm.kind} vm={vm} hosting={hosting} api={api} stale={observation.stale} lastOnlineAt={observation.lastOnlineAt} onRefresh={retryHosting} onRead={readHosting} onUpdated={next => {acceptHosting(next);if(!next.running)requestAnimationFrame(() => headingRef?.current?.focus());}} onCopyDetails={async () => setCopyResult({...await copyHostingDetails(vm.details), details: vm.details})} onStart={start} pending={starting} blocked={needsReconcile || observation.stale} elapsed={elapsed} startError={startError} startErrorRef={startErrorRef} computerReference={computerReference} />}
      <p role="status" aria-live="polite">{copyResult?.message}</p>
      {copyResult?.fallback && <textarea aria-label="Hosting details to copy" readOnly value={copyResult.details} onFocus={event => event.currentTarget.select()} />}
    </div>
  );
}
