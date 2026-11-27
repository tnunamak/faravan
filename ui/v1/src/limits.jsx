import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { lenderLimitsSaveBody } from './settings-model.mjs';
import { Action, Connection, field } from './shared.jsx';
import { Button, Card, Disclosure, Icon, Sheet, Switch } from './ds/index.mjs';
import { HOURS, WEEKDAYS, scheduleOf, zoneName } from './view-models.mjs';
import { ownerLimitAmount, guardUnsavedLimits, limitsSaveError, scheduleChange, scheduleZoneHint, limitsSaveAmbiguous, sameLimits, pageDraft, validatePage } from './limits-model.mjs';
import { policySummary, validatePolicy, migrationVM, needsPerJobApproval, rulesVM } from './lending-policy-view.mjs';
import { OWNER_LIMIT_LABEL, ownerLimitEffect } from '../../../lib/v1/lending-status-copy.mjs';
import { errorMessage } from './helpers.mjs';
import { Line, AccountCard, ProtectionChooser, StrategyChooser, ObjectiveExplanation, Concurrency, WhoRules, StopOnReturn, EffortCap } from './lending-policy-view.jsx';
import { PageSkeleton } from './shell-states.jsx';
import { SANDBOX_LEARN_MORE, STRATEGY_HELP_COPY } from './safety-copy.mjs';

// The one request of Save (EXPERIENCE 1.20): the protection position, supported limits, hours and zone.
// Hours off saves `null`. The approval mode is not part of it: who runs without asking is a standing rule.
export const saveBody = (draft, { limits, version }) => lenderLimitsSaveBody(limits, scheduleOf(draft), version);

/** "Saved now:" names the current objective position. */
const savedText = draft => policySummary(validatePolicy(draft.policy).policy ?? {});

// A Save that did not apply says so first, and why. A changed configuration offers the current settings.
export function SaveFailed({ error, checkFailed, onShow, onCheck, focusRef }) {
  const changed = error?.code === 'config_changed';
  return (
    <div class="banner bad ph-no-capture" role="alert" tabIndex="-1" ref={focusRef} data-telemetry-private="limits">
      <Icon name="alert" />
      <div class="grow">
        <b>{error?.current ? 'Current settings checked' : limitsSaveAmbiguous(error) ? 'We could not confirm whether your changes were saved.' : 'Nothing was saved'}</b>
        <p class="t-sm t-2">{limitsSaveAmbiguous(error) ? 'Check the saved settings before you change anything else.' : limitsSaveError(error)}</p>
        {error?.current && <p class="t-sm">Saved now: {error.current}</p>}
        {limitsSaveAmbiguous(error) && checkFailed && <p class="t-sm" role="status">Could not check the saved settings. Try again; your changes are still here.</p>}
        {limitsSaveAmbiguous(error) && onCheck && <Action className="linkish" run={onCheck} success="" allowOffline>Check saved settings</Action>}
        {changed && <p class="t-sm"><button type="button" class="linkish" onClick={onShow}>Show the current settings</button></p>}
      </div>
    </div>
  );
}

// "What you lend": the protection dial, account consent, concurrency, people and lending hours.
// Standing rules are saved by their own actions.
// The saved per-job limit. Saving is a step of its own, with a confirmation that says what it does. It replaces an unreadable file
// only when the hold is active, and the hold's line links here.
function claudeModelName(model) {
  const match = /^claude-(haiku|sonnet|opus|fable|mythos)(?:-(\d+)(?:-(\d+))?)?/.exec(model);
  if (!match) return model;
  const family = match[1][0].toUpperCase() + match[1].slice(1);
  return match[2] ? family + ' ' + match[2] + (match[3] ? '.' + match[3] : '') : family;
}

function ownerMinimumUsd(minimums) {
  const rows = minimums.filter(row => typeof row.model === 'string' &&
    Number.isFinite(row.minimumMaxJobUsd) && row.minimumMaxJobUsd > 0);
  if (!rows.length) return null;
  return Math.min(...rows.map(row => row.minimumMaxJobUsd));
}

export const ownerLimitMoney = value => '$' + (Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2));

function ownerModelLimitCopy(minimums, amount, agents) {
  if (!minimums.length || !Number.isFinite(amount) || amount <= 0) return null;
  const account = (Array.isArray(agents) ? agents : []).find(agent => agent.id === 'claude-code-subscription' && agent.useForLending === true &&
    agent.installed === true && agent.signedIn === true);
  if (!account) return null;
  const accountModels = new Set([...(Array.isArray(account.models) ? account.models : []), account.run?.model]
    .filter(model => typeof model === 'string' && model));
  const money = ownerLimitMoney;
  const joinNames = names => names.length < 2 ? names[0] ?? '' : names.length === 2
    ? names[0] + ' and ' + names[1] : names.slice(0, -1).join(', ') + ', and ' + names.at(-1);
  const models = minimums.filter(row => accountModels.has(row.model))
    .map(row => ({name: claudeModelName(row.model), minimumMaxJobUsd: row.minimumMaxJobUsd}));
  if (!models.length) return null;
  const lendable = models.filter(row => row.minimumMaxJobUsd <= amount);
  const held = models.filter(row => row.minimumMaxJobUsd > amount);
  return {line: 'If you save ' + money(amount) + ', these models fit the per-job limit: ' +
      (lendable.length ? joinNames(lendable.map(row => row.name)) : 'no Claude models') + '.',
    higherLimit: held.map(row => row.name + ' needs at least ' + money(row.minimumMaxJobUsd) + ' per job.')};
}

function OwnerLimit({ accounts, agents, api, mutate, offline, onDirtyChange }) {
  const held = accounts.some(account => {
    const decision = account?.decision ?? {};
    const current = decision.availability ?? decision;
    return current.status?.id === 'owner_settings';
  });
  const [value, setValue] = useState('4'), [asking, setAsking] = useState(null), [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(''), [problem, setProblem] = useState('');
  const [savedAmount, setSavedAmount] = useState(null), [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false), [stale, setStale] = useState(true);
  const [savedKind, setSavedKind] = useState('unknown');
  const [modelLimitSummary, setModelLimitSummary] = useState(null);
  const [minimums, setMinimums] = useState([]), [minimumProblem, setMinimumProblem] = useState('');
  const [minimumAdjusted, setMinimumAdjusted] = useState(false);
  const ownerInput = useRef(null);

  const dirty = useRef(false), lastSaved = useRef(null), inFlight = useRef(false);
  const acceptedEpoch = useRef(-1);
  const request = useRef(0), context = useRef({api, agents, epoch: 0});
  if (context.current.api !== api || context.current.agents !== agents) {
    context.current = {api, agents, epoch: context.current.epoch + 1};
  }
  useLayoutEffect(() => {
    onDirtyChange?.(dirty.current || uncertain || busy);
  }, [value, uncertain, busy, savedAmount, onDirtyChange]);
  const readSnapshot = async () => {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        api.get('lending/owner-settings', controller.signal),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error('Reading the saved limit timed out.'));
        }, 15000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const acceptSnapshot = snapshot => {
    const actual = snapshot?.values?.maxJobUsd ?? snapshot?.defaultMaxJobUsd;
    if (!Number.isFinite(actual) || actual <= 0) throw new Error('Saved limit could not be read.');
    const rows = (Array.isArray(snapshot?.minimums) ? snapshot.minimums : []).filter(row => typeof row.model === 'string' &&
      Number.isFinite(row.minimumMaxJobUsd) && row.minimumMaxJobUsd > 0).sort((a, b) => a.minimumMaxJobUsd - b.minimumMaxJobUsd);
    setMinimums(rows);
    const minimum = ownerMinimumUsd(rows, agents);
    setMinimumProblem(minimum === null ? 'The lowest allowed limit could not be read. You cannot save a new limit yet.' : '');
    const changed = lastSaved.current !== null && lastSaved.current !== actual;
    setConflict(previous => dirty.current && (previous || changed));
    lastSaved.current = actual;
    setSavedAmount(snapshot?.values?.maxJobUsd ?? null);
    setModelLimitSummary(snapshot?.modelLimitSummary ?? null);
    setSavedKind(snapshot?.values?.maxJobUsd != null ? 'persisted' : held ? 'unreadable' : 'default');
    acceptedEpoch.current = context.current.epoch;
    setStale(false);
    if (!dirty.current) {
      setValue(String(minimum === null ? actual : Math.max(actual, minimum)));
      setMinimumAdjusted(minimum !== null && actual < minimum);
    }
  };
  useEffect(() => {
    const generation = ++request.current, epoch = context.current.epoch;
    setStale(true); setMinimums([]); setMinimumProblem(''); setSaved('');
    if (typeof api?.get !== 'function') {
      setMinimumProblem('The lowest allowed limit could not be read. You cannot save a new limit yet.');
      return;
    }
    readSnapshot().then(snapshot => {
      if (request.current === generation && context.current.epoch === epoch) acceptSnapshot(snapshot);
    }).catch(error => {
      if (request.current === generation && context.current.epoch === epoch)
        setMinimumProblem('The lowest allowed limit could not be read. You cannot save a new limit yet.');
    });
    return () => { ++request.current; };
  }, [api, agents]);
  const contextStale = stale || acceptedEpoch.current !== context.current.epoch;
  const minimum = ownerMinimumUsd(minimums);
  const focusedLimit = useRef(false);
  useEffect(() => {
    if (minimum !== null && !focusedLimit.current && globalThis.location?.hash === '#/lend/limits/owner-limit') {
      ownerInput.current?.focus();
      focusedLimit.current = true;
    }
  }, [minimum]);
  const {amount, error: fieldError} = ownerLimitAmount(value, minimum);
  const valid = minimum !== null && !minimumProblem && !fieldError;
  // Until the first read lands, "4" is a placeholder, not a saved amount.
  const loading = savedKind === 'unknown' && !minimumProblem;
  const modelCopy = valid ? ownerModelLimitCopy(minimums, amount, agents) : null;
  const reviewed = asking && asking.api === api && asking.agents === agents &&
    asking.minimums === minimums && asking.amount === amount;
  const checkSaved = async () => {
    if (inFlight.current || offline) return;
    inFlight.current = true; setBusy(true); setStale(true);
    const generation = ++request.current, epoch = context.current.epoch;
    try {
      const snapshot = await readSnapshot();
      if (generation !== request.current || epoch !== context.current.epoch) return;
      if (snapshot?.values?.maxJobUsd === amount) dirty.current = false;
      acceptSnapshot(snapshot);
      setUncertain(false); setProblem(''); setSaved('Limit checked.');
    } catch (error) {
      if (generation === request.current && epoch === context.current.epoch) {
        setMinimumProblem('Saved limit could not be read. ' + errorMessage(error));
        setProblem(uncertain ? 'We could not confirm whether your changes were saved. Check the saved settings before you change anything else.' : '');
      }
    } finally { inFlight.current = false; setBusy(false); }
  };
  const save = async () => {
    if (inFlight.current || offline || uncertain || !valid || !reviewed) return;
    const epoch = context.current.epoch, generation = ++request.current;
    let acknowledged = false;
    inFlight.current = true; setBusy(true); setProblem(''); setSaved(''); setUncertain(true);
    try {
      await mutate('lending/owner-settings', {maxJobUsd: amount, reason: 'Set on the Lend page.', ...(held ? {replaceUnreadable: true} : {})});
      acknowledged = true;
      // An old mutation may have applied, but cannot read through or replace a newer context.
      if (epoch !== context.current.epoch || generation !== request.current) {
        setProblem('We could not confirm whether your changes were saved. Check the saved settings before you change anything else.');
        return;
      }
      const snapshot = await readSnapshot();
      if (epoch !== context.current.epoch || generation !== request.current) {
        setProblem('We could not confirm whether your changes were saved. Check the saved settings before you change anything else.');
        return;
      }
      if (snapshot?.values?.maxJobUsd === amount) dirty.current = false;
      acceptSnapshot(snapshot);
      setUncertain(false); setSaved('Limit checked.');
    } catch (error) {
      if (epoch !== context.current.epoch || generation !== request.current) {
        setProblem('We could not confirm whether your changes were saved. Check the saved settings before you change anything else.');
      } else {
        const ambiguous = acknowledged || limitsSaveAmbiguous(error);
        setUncertain(ambiguous);
        setProblem(ambiguous ? 'We could not confirm whether your changes were saved. Check the saved settings before you change anything else.' : errorMessage(error));
      }
    } finally {
      inFlight.current = false; setBusy(false); setAsking(null);
    }
  };
  return (
    <section class="ph-no-capture" id="owner-limit" aria-labelledby="owner-limit-h" data-telemetry-private="limits">
      <div class="section-h"><h2 id="owner-limit-h">Per-job limit</h2></div>
      <Card>
        <div class="owner-limit-control">
          <label class="owner-limit-label" for="owner-limit-value">{OWNER_LIMIT_LABEL}</label>
          <p class="owner-limit-hint" id="owner-limit-hint">The most one job may spend. It must cover at least one call on the cheapest Claude model; the note below shows which models fit.</p>
          <div class="owner-limit-entry">
          <span class="t-2" aria-hidden="true">$</span>
          <input ref={ownerInput} id="owner-limit-value" class="input owner-limit-input" type="number" inputMode="decimal" min={minimum ?? undefined} max="1000000" step="0.01" aria-invalid={Boolean(minimum !== null && fieldError)} aria-describedby={minimum !== null && fieldError ? "owner-limit-hint owner-limit-error" : "owner-limit-hint"} aria-label={OWNER_LIMIT_LABEL}
            value={loading ? '' : value} placeholder={loading ? 'Loading…' : undefined} disabled={minimum === null || busy || uncertain} onInput={e => { dirty.current = e.currentTarget.value.trim() === '' || Number(e.currentTarget.value) !== lastSaved.current; if (!dirty.current) setConflict(false); setValue(e.currentTarget.value); setMinimumAdjusted(false); }} />
          <button type="button" class="btn btn-primary owner-limit-save" disabled={!valid || busy || offline || uncertain} onClick={() => { if (valid && !busy && !offline && !uncertain) setAsking({api, agents, minimums, amount}); }}>Save limit</button>
          </div>
        </div>
        {loading && <p class="owner-limit-saved" role="status">Loading the saved limit…</p>}
        {savedAmount !== null && <p class="owner-limit-saved">{uncertain || contextStale
          ? 'Last checked limit: ' + ownerLimitMoney(savedAmount) + '; current limit unknown.'
          : 'Saved per-job limit: ' + ownerLimitMoney(savedAmount) + '.'}</p>}
        {savedAmount === null && savedKind === 'unreadable' && <p class="owner-limit-saved">Saved limit unreadable; current limit unknown.</p>}
        {savedAmount === null && savedKind === 'default' && <p class="owner-limit-saved">Last checked default per-job limit: {ownerLimitMoney(lastSaved.current)}. A saved limit could not be confirmed.</p>}
        {conflict && !uncertain && !contextStale && savedAmount !== null && <p class="owner-limit-conflict" role="status">The saved limit changed to {ownerLimitMoney(savedAmount)}. Your unsaved amount is still shown below.</p>}
        {minimum !== null && fieldError && <p id="owner-limit-error" class="line-error">{fieldError}</p>}
        {(uncertain || minimumProblem) && <button type="button" class="btn owner-limit-check" disabled={busy || offline} onClick={checkSaved}>Check saved limit</button>}
        {modelLimitSummary && <p class="owner-limit-summary" role="status">{modelLimitSummary}</p>}
        {modelCopy && <div class="owner-limit-models t-sm stack-2" aria-live="polite">
          <p>{modelCopy.line}</p>
          {modelCopy.higherLimit.length > 0 && <details>
            <summary>Models that need a higher limit</summary>
            <ul>{modelCopy.higherLimit.map(row => <li key={row}>{row}</li>)}</ul>
          </details>}
        </div>}
        {minimumProblem && <p class="line-error" role="alert">{minimumProblem}</p>}
        {minimumAdjusted && minimum !== null && <p class="line-error" role="alert">The saved limit was below the lowest allowed amount of ${minimum.toFixed(2)}. The field now shows that amount; save to update it.</p>}
        {held && <p class="t-sm t-2">Your saved limit cannot be read. Saving replaces it after you confirm; the unreadable copy is kept so it can be checked later.</p>}
        {saved && <p class="t-sm" role="status">{saved}</p>}
        {problem && <p class="line-error" role="alert">{problem}</p>}
      </Card>
      <Sheet open={Boolean(asking)} onClose={() => setAsking(null)} label="Confirm the saved limit">
        <div class="card-pad stack-4">
          <h2 class="t-title2">Confirm the saved limit</h2>
          <p class="owner-limit-effect">{ownerLimitEffect({maxJobUsd: asking?.amount ?? amount, replaceUnreadable: held})}</p>
          {asking && !reviewed && <p role="alert">Model limits changed. Review the amount before saving.</p>}
          <button type="button" class="btn btn-primary owner-limit-confirm" disabled={busy || offline || uncertain || !valid || !reviewed} onClick={save}>Save the limit</button>
          <button type="button" class="btn btn-secondary" onClick={() => setAsking(null)}>Cancel</button>
        </div>
      </Sheet>
    </section>
  );
}

export function LimitsPage({ lending, data, errors: readErrors = {}, refresh, api, mutate, circle, circles = [], agents = [], headingRef, now: fixedNow }) {
  const [checkedHome, setCheckedHome] = useState(null);
  const [ownerDirty, setOwnerDirty] = useState(false), [ruleDirty, setRuleDirty] = useState(false);
  const home = checkedHome ?? data.home ?? {};
  const currentLending = home.lending ?? lending;
  const saved = pageDraft(currentLending, home);
  useEffect(() => { if (checkedHome && data.home?.lending?.configVersion >= checkedHome.lending?.configVersion) setCheckedHome(null); }, [data.home, checkedHome]);
  const [draft, setDraft] = useState(null), [failed, setFailed] = useState(null), [checkFailed, setCheckFailed] = useState(false);
  const [pending, setPending] = useState(false), [success, setSuccess] = useState(''), [elapsed, setElapsed] = useState(0);
  const baseVersion = useRef();
  const set = value => {
    if (value === null) baseVersion.current = undefined;
    else if (draft === null) baseVersion.current = currentLending.configVersion;
    setDraft(value); setSuccess(''); setFailed(null);
  };
  const saving = useRef(false), errorRef = useRef(null), resultRef = useRef(null), saveRef = useRef(null), checking = useRef(null);
  const { offline } = useContext(Connection);
  const d = draft ?? saved, { ok, errors, policyErrors, limits } = validatePage(d);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = fixedNow ?? Date.now();
  const p = d.policy, setP = policy => set({ ...d, policy });
  const sched = d.schedule, setSched = (patch) => set(scheduleChange(d, patch, localZone));
  const snapshot = home.lendingPolicy ?? {}, accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
  const savedPolicy = validatePolicy(saved.policy).policy, draftPolicy = validatePolicy(p).policy;
  const policyChanged = draftPolicy && JSON.stringify(draftPolicy) !== JSON.stringify(savedPolicy);
  const migration = migrationVM(snapshot);
  useLayoutEffect(() => dirty || ownerDirty || ruleDirty ? guardUnsavedLimits(window, document) : undefined, [dirty, ownerDirty, ruleDirty]);
  useLayoutEffect(() => { if (failed) errorRef.current?.focus(); }, [failed]);
  useLayoutEffect(() => { if (success) resultRef.current?.focus({preventScroll:true}); }, [success]);
  useEffect(() => {
    if (!pending) return;
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [pending]);
  // One request saves the policy and lending hours together, or none of it (EXPERIENCE 1.20).
  // `version` is the configuration this page was showing; if it moved, nothing is saved.
  useEffect(() => () => checking.current?.abort(), []);
  async function checkSaved() {
    const controller = checking.current = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const current = await api.get('home', controller.signal);
      if (!current?.lending?.limits) throw new Error('missing limits');
      const actual = pageDraft(current.lending, current);
      setCheckedHome(current);
      setCheckFailed(false);
      if (sameLimits(actual, d)) {
        set(null); setSuccess('Saved settings checked. Your changes are saved.');
      } else {
        setFailed(old => ({...old, current:savedText(actual)}));
      }
    } catch {
      // The unconfirmed outcome and draft stay; the failed check is shown so it is not read as "nothing changed".
      setCheckFailed(true);
    }
    finally { clearTimeout(timeout); if (checking.current === controller) checking.current = null; }
  }
  async function save() {
    if (saving.current || !dirty || !ok || offline) return;
    saving.current = true; setPending(true); setElapsed(0); setFailed(null); setCheckFailed(false); setSuccess('');
    try {
      await mutate('lending/limits', saveBody(d, { limits, version: baseVersion.current }));
      set(null); setSuccess('Saved.');
      resultRef.current?.focus({preventScroll:true});
    } catch (error) {
      setFailed(error);
      if (limitsSaveAmbiguous(error)) await checkSaved();
    } finally { saving.current = false; setPending(false); }
  }
  if (!data.home && readErrors.home) return <div class="form limits-form ph-no-capture" data-telemetry-private="limits">
    <a class="back-link" href="#/lend"><Icon name="chev-l" size="sm" />Lending</a>
    <h1 class="t-page" tabIndex="-1" ref={headingRef}>What you lend</h1>
    <Card pad class="stack-3"><p role="alert">{errorMessage(readErrors.home)}</p><Button kind="secondary" onClick={() => refresh?.('home')}>Try again</Button></Card>
  </div>;
  if (!data.home) return <PageSkeleton label="Loading what you lend" />;
  return (
    <div class="form limits-form lend-policy ph-no-capture" data-telemetry-private="limits">
      <a class="back-link" href="#/lend"><Icon name="chev-l" size="sm" />Lending</a>
      <h1 class="t-page" tabIndex="-1" ref={headingRef}>What you lend</h1>
      <fieldset class="limits-fields" disabled={pending}>
      {migration && (
        <div class="banner" role="status">
          <Icon name="alert" />
          <div class="grow">
            <p class="t-sm">{migration.text}</p>
          </div>
        </div>
      )}
      <OwnerLimit accounts={accounts} agents={agents} api={api} mutate={mutate} offline={offline} onDirtyChange={setOwnerDirty} />
      <section aria-labelledby="lending-explanation-h">
        <div class="section-h"><h2 id="lending-explanation-h">Lending explanation</h2></div>
        <ObjectiveExplanation snapshot={snapshot} changed={Boolean(policyChanged)}
          intent={home.lendingProjection?.intent ?? (currentLending.enabled === false ? 'off' : undefined)}
          rulesActive={rulesVM(currentLending.standingRules, { devices: data.devices, circles, now, zone: localZone }).length > 0}
          approvalRequired={provider => needsPerJobApproval(currentLending.mode ?? 'ask',
            Object.fromEntries(agents.map(agent => [agent.id === 'claude-code-subscription' ? 'claude' : agent.id, agent.useForLending === true])), provider)} />
        <div class="strategy-help t-sm t-2 stack-2" aria-label="Lending strategies">
          {STRATEGY_HELP_COPY.map(line => <p key={line}>{line}</p>)}
          <details><summary>Learn more</summary><p>{SANDBOX_LEARN_MORE}</p></details>
        </div>
      </section>
      {accounts.length > 0 && (
        <Disclosure class="allowance-readings" summary="Account plans">
        <section class="allow-cards" aria-label="Your allowances">
          {accounts.map(account => (
            <AccountCard key={account.id} account={account}
              plan={p.accountPlans?.[account.provider]} setPlan={plan => setP({ ...p, accountPlans: { ...p.accountPlans, [account.provider]: plan } })} />
          ))}
        </section>
        </Disclosure>
      )}
      <section>
        <div class="section-h"><h2 id="protection-h">Lending setting</h2></div>
        <ProtectionChooser p={p} setP={setP} errors={policyErrors} />
      </section>
      <section aria-labelledby="strategy-h">
        <div class="section-h"><h2 id="strategy-h">Lending strategy</h2></div>
        <StrategyChooser p={p} setP={setP} errors={policyErrors} />
      </section>
      <section aria-labelledby="daily-limits-h">
        <div class="section-h"><h2 id="daily-limits-h">Daily request limits</h2></div>
        <Card>
          <Line label="Jobs a day" hint="Leave empty for no daily job cap." error={errors.dailyJobs}>
            <input class="input num" inputMode="numeric" placeholder="No cap"
              aria-label="Jobs a day" value={d.dailyJobs} onInput={event => set({...d, dailyJobs:field(event)})} />
          </Line>
          <Line label="Minutes a day" hint="Leave empty for no daily minute cap." error={errors.dailyMinutes}>
            <input class="input num" inputMode="numeric" placeholder="No cap"
              aria-label="Minutes a day" value={d.dailyMinutes} onInput={event => set({...d, dailyMinutes:field(event)})} />
          </Line>
        </Card>
      </section>
      <section>
        <Concurrency p={p} setP={setP} errors={policyErrors} machineCapacity={snapshot.machineCapacity} providers={[...new Set(accounts.map(a => a.provider))]} />
      </section>
      <section>
        <div class="section-h"><h2 id="lending-who">Who</h2></div>
        <p class="t-sm t-2">While you decide, other lenders can take the job so the sender isn’t kept waiting.</p>
        <WhoRules lending={currentLending} devices={data.devices} circles={circles} agents={agents} mutate={mutate} now={now} zone={localZone} circle={circle} onDirtyChange={setRuleDirty} />
      </section>
      <section>
        <div class="section-h"><h2>When</h2></div>
        <Card>
          <Line label="Only lend in set hours" hint={scheduleZoneHint(d.timeZone, localZone)}>
            <Switch label="Only lend in set hours" checked={sched.on} onChange={(on) => setSched({ on })} />
            {localZone && localZone !== d.timeZone && (
              <button type="button" class="btn btn-secondary btn-sm" onClick={() => set({ ...d, timeZone: localZone })}>Use {zoneName(localZone)}</button>
            )}
          </Line>
          {sched.on && (
            <>
              <Line label="Lending hours">
                <select class="select hours" aria-label="From" value={sched.from} onChange={(e) => setSched({ from: field(e) })}>
                  {HOURS.map((h) => <option value={h.value}>{h.label}</option>)}
                </select>
                <span class="t-2">to</span>
                <select class="select hours" aria-label="To" value={sched.to} onChange={(e) => setSched({ to: field(e) })}>
                  {HOURS.map((h) => <option value={h.value}>{h.label}</option>)}
                </select>
              </Line>
              <Line label="Days" error={errors.days}>
                <div class="days" role="group" aria-label="Days">
                  {WEEKDAYS.map(([value, letter, name]) => {
                    const on = sched.days.includes(value);
                    return (
                      <button type="button" class={'day' + (on ? ' on' : '')} aria-pressed={on ? 'true' : 'false'} aria-label={name}
                        onClick={() => setSched({ days: on ? sched.days.filter((x) => x !== value) : [...sched.days, value] })}>{letter}</button>
                    );
                  })}
                </div>
              </Line>
              <Line label="All day on weekends">
                <Switch label="All day on weekends" checked={sched.weekendsAllDay} onChange={(on) => setSched({ weekendsAllDay: on })} />
              </Line>
            </>
          )}
        </Card>
      </section>
      <section>
        <div class="section-h"><h2>How much effort friends can ask for</h2></div>
        <EffortCap p={p} setP={setP} />
      </section>
      <section>
        <div class="section-h"><h2>When you use your computer</h2></div>
        <Card><Line label="Only lend when I am away" hint="Off by default. Turn this on to start automatic jobs only after 5 minutes without keyboard or mouse activity.">
          <Switch label="Only lend when I am away" checked={d.idleOnly} onChange={on => set({...d,idleOnly:on})} />
        </Line></Card>
        {d.idleOnly && <StopOnReturn p={p} setP={setP} />}
      </section>
      </fieldset>
      <div class={'limits-footer' + (!dirty ? ' clean' : '') + (!dirty && success ? ' limits-savebar limits-confirmation' : '')}>
      {dirty ? <div class="limits-savebar">
        <div class="limits-result">
          {failed ? <SaveFailed error={failed} checkFailed={checkFailed} onCheck={async () => {
            if (saving.current) return;
            saving.current = true; setPending(true);
            try { await checkSaved(); } finally { saving.current = false; setPending(false); }
          }} focusRef={errorRef} onShow={() => { set(null); setSuccess('Current settings loaded.'); }} />
            : <p class="limits-status" role="status" aria-live="polite" tabIndex="-1" ref={resultRef}>{'You have unsaved changes'}</p>}
          <p class="t-xs t-2">Save applies the lending setting, strategy, effort, consent, daily limits, concurrency and hours together, or none of them. The per-job limit and standing rules save on their own.</p>
          {offline ? <p class="t-xs t-2">Reconnect, then select Save. These changes are not saved yet.</p> : draft !== null && !ok ? <p class="t-xs t-2">Fix the highlighted numbers to save</p> : null}
        </div>
        <div class="pair save-pair">
          <button type="button" class="btn btn-secondary" aria-disabled={!dirty || pending} onClick={() => {
            if (pending || !dirty) return;
            set(null); setFailed(null); setSuccess('Changes discarded.'); resultRef.current?.focus({preventScroll:true});
          }}>Discard</button>
          <span class="action"><button type="button" ref={saveRef} class="btn btn-primary" aria-disabled={!dirty || !ok || offline || pending} aria-busy={pending} onClick={save}>
            {pending ? 'Saving…' + (elapsed >= 10 ? ' ' + Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0') : '') : 'Save'}
          </button></span>
        </div>
      </div> : success ? <p class="limits-status" role="status" aria-live="polite" tabIndex="-1" ref={resultRef}>{success}</p> : null}
      </div>
    </div>
  );
}
