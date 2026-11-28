import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { lenderLimitsSaveBody } from './settings-model.mjs';
import { Action, Connection, field } from './shared.jsx';
import { Button, Card, Disclosure, Icon, Sheet, Switch } from './ds/index.mjs';
import { HOURS, WEEKDAYS, scheduleOf, zoneName } from './view-models.mjs';
import { guardUnsavedLimits, limitsSaveError, scheduleChange, scheduleZoneHint, limitsSaveAmbiguous, sameLimits, pageDraft, validatePage } from './limits-model.mjs';
import { policySummary, validatePolicy, migrationVM, needsPerJobApproval, rulesVM } from './lending-policy-view.mjs';
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
export function LimitsPage({ lending, data, errors: readErrors = {}, refresh, api, mutate, circle, circles = [], agents = [], headingRef, now: fixedNow }) {
  const [checkedHome, setCheckedHome] = useState(null);
  const [ruleDirty, setRuleDirty] = useState(false);
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
  const migration=migrationVM({migration:currentLending.migration});
  const savedPolicy = validatePolicy(saved.policy).policy, draftPolicy = validatePolicy(p).policy;
  const policyChanged = draftPolicy && JSON.stringify(draftPolicy) !== JSON.stringify(savedPolicy);
  useLayoutEffect(() => dirty || ruleDirty ? guardUnsavedLimits(window, document) : undefined, [dirty, ruleDirty]);
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
      {migration && <div class="banner" role="status"><Icon name="alert" /><div class="grow"><p class="t-sm">{migration.text}</p></div></div>}
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
          <p class="t-xs t-2">Save applies the lending setting, strategy, effort, consent, daily limits, concurrency and hours together, or none of them. Standing rules save on their own.</p>
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
