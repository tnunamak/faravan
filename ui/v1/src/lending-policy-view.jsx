// The parts of "What you lend" (LENDING-POLICY-DESIGN §4). Copy and numbers come from lending-policy-view.mjs.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Action, field } from './shared.jsx';
import { Card, Disclosure, Switch } from './ds/index.mjs';
import { concurrencyText, rulesVM, rulePeople, ruleDraft, validateRule, nextRules,
  PROTECTION_POSITIONS, DEFAULT_PROTECTION_POSITION, PLAN_OPTIONS, planHint, providerName, whenText, objectiveExplanationVM,
  DIAL_EXPLAINER, FIXED_SHARE_PARAM, POLICY_LABELS, chooseStrategy, withFixedShare } from './lending-policy-view.mjs';
import { STRATEGY_COPY } from '../../../lib/v1/lending-status-copy.mjs';
import { agentProduct } from './helpers.mjs';

export const Line = ({ label, hint, children, error, errorId }) => (
  <div class="line ph-no-capture" data-telemetry-private="lending-policy-view">
    <div class="lbl"><b>{label}</b>{hint}{error && <span id={errorId} class="line-error" role="alert">{error}</span>}</div>
    {children}
  </div>
);

export function AccountCard({ account, plan, setPlan }) {
  const options = PLAN_OPTIONS[account.provider];
  return (
    <Card class="allow-card ph-no-capture" data-telemetry-private="lending-policy-view">
      <div class="allow-head">
        <h3>{account.label || providerName(account.provider)}{plan && plan !== 'unknown' && <span class="t-2">{' · ' + options?.find(([id]) => id === plan)?.[1]}</span>}</h3>
      </div>
      {options && setPlan && (
        <Disclosure class="allow-plan" summary={providerName(account.provider) + ' plan: ' + (options.find(([id]) => id === (plan ?? 'unknown'))?.[1] ?? 'Choose a plan')}>
          <label class="t-sm" for={'plan-' + account.provider}>{providerName(account.provider)} plan</label>
          <select id={'plan-' + account.provider} class="select hours" aria-label={providerName(account.provider) + ' plan'} value={plan ?? 'unknown'} onChange={(e) => setPlan(field(e))}>
            {options.map(([id, name]) => <option value={id}>{name}</option>)}
          </select>
          <p class="t-xs t-2">{planHint(account.provider, plan ?? 'unknown')}</p>
        </Disclosure>
      )}
    </Card>
  );
}

/** The objective rule's protection dial. */
export function ProtectionChooser({ p, setP, errors }) {
  return (
    <Card data-telemetry-private="lending-policy-view" class="ph-no-capture">
      <fieldset class="protection-positions" aria-label="Lending setting" aria-describedby="protection-model-targets">
        {PROTECTION_POSITIONS.map(position => (
          <label class={'protection-option' + (p.protectionPosition === position.id ? ' on' : '')} key={position.id}>
            <input type="radio" name="protectionPosition" value={position.id} checked={p.protectionPosition === position.id}
              aria-describedby={'protection-' + position.id} onChange={() => setP({ ...p, protectionPosition: position.id })} />
            <span><b>{position.label}</b>{position.id === DEFAULT_PROTECTION_POSITION && <span class="protection-tag">Default</span>}
              <span class="t-sm t-2 protection-desc" id={'protection-' + position.id}>{position.description.replace('Risk target:', 'Model target (not a measured rate):')}</span></span>
          </label>
        ))}
        {errors.protectionPosition && <span class="line-error" role="alert">{errors.protectionPosition}</span>}
      </fieldset>
      <p class="t-sm t-2 dial-first-use">Choose a lending setting. Your limits cap lending, not its effect on your own use.</p>
      <p class="t-xs t-2" id="protection-model-targets">Risk targets are model targets, not measured rates.</p>
      <details class="dial-how">
        <summary>How this works</summary>
        <p class="t-sm t-2 dial-explainer">{DIAL_EXPLAINER}</p>
      </details>
      <details class="dial-assumption" id="starting-assumption">
        <summary>Starting assumption for new users</summary>
        <p class="t-xs t-2">Faravan can start lending before the first quota reading, within your lending limits. With a reading, it starts by lending up to a fifth of each window (a tenth at the most protective setting), based on the room this computer's readings show. Later in a window it may lend more of the quota still unused, even before it has your usage history. It cannot see your use on other devices, the web, or the app, so the room it sees may be more than you have. These limits bound what friends use, not how much of your own work may need that quota. Readings and history may change how much it can lend.</p>
      </details>
    </Card>
  );
}

// The strategies an owner picks here. Custom is not offered; manual approval is the requests "ask" mode.
const CHOOSABLE_STRATEGIES = ['automatic', 'fixed_share'];

/** Lending strategy: Automatic (recommended) or Fixed share with its one share number. Saved with the protection position. */
export function StrategyChooser({ p, setP, errors }) {
  const share = p.strategyParams?.fixedSharePct;
  return (
    <Card data-telemetry-private="lending-policy-view" class="ph-no-capture">
      <fieldset class="protection-positions" aria-label={POLICY_LABELS.strategy}>
        {CHOOSABLE_STRATEGIES.map(id => (
          <label class={'protection-option' + (p.strategy === id ? ' on' : '')} key={id}>
            <input type="radio" name="lendingStrategy" value={id} checked={p.strategy === id}
              aria-describedby={'strategy-' + id} onChange={() => setP(chooseStrategy(p, id))} />
            <span><b>{STRATEGY_COPY[id].label}</b>{id === 'automatic' && <span class="protection-tag">Recommended</span>}
              <span class="t-sm t-2 protection-desc" id={'strategy-' + id}>{STRATEGY_COPY[id].description}</span></span>
          </label>
        ))}
      </fieldset>
      <Line label="Per-job cap" hint="The per-job cap defaults to 10% of the weekly allowance. You can change it; 100% removes this cap. Faravan stops a job when its measured use reaches the cap. A hold lasts until the meter shows its use or the weekly reset."
        error={errors['strategyParams.perJobPct']} errorId="per-job-cap-error">
        <input class="input num" type="number" inputMode="decimal" step="any" min="0" max="100"
          aria-label="Per-job cap, percent of weekly allowance" value={String(p.strategyParams?.perJobPct ?? 10)}
          aria-invalid={errors['strategyParams.perJobPct'] ? 'true' : undefined}
          aria-describedby={errors['strategyParams.perJobPct'] ? 'per-job-cap-error' : undefined}
          onInput={event => setP({...p,strategyParams:{...p.strategyParams,perJobPct:field(event).trim()===''?'':Number(field(event))}})} />
        <span class="t-2" aria-hidden="true">%</span>
      </Line>
      {p.strategy === 'fixed_share' && (
        <Line label={POLICY_LABELS.fixedSharePct} hint={FIXED_SHARE_PARAM.description}
          error={errors['strategyParams.fixedSharePct']} errorId="fixed-share-error">
          <input class="input num" type="number" inputMode="decimal" step="any" min={FIXED_SHARE_PARAM.minimum} max={FIXED_SHARE_PARAM.maximum}
            aria-label="Share of each week friends can use, percent" value={String(share ?? '')}
            aria-invalid={errors['strategyParams.fixedSharePct'] ? 'true' : undefined}
            aria-describedby={errors['strategyParams.fixedSharePct'] ? 'fixed-share-error' : undefined}
            onInput={event => setP(withFixedShare(p, field(event)))} />
          <span class="t-2" aria-hidden="true">%</span>
        </Line>
      )}
    </Card>
  );
}

/** The server's latest durable objective answer in the same words used by the dial. */
export function ObjectiveExplanation({ snapshot, changed = false, intent, approvalRequired = false, rulesActive = false }) {
  const rows = objectiveExplanationVM(snapshot);
  const needsApproval = provider => typeof approvalRequired === 'function'
    ? approvalRequired(provider) === true : approvalRequired === true;
  return (
    <div class="objective-explanation preview ph-no-capture" aria-label="Lending explanation" aria-live="polite" data-telemetry-private="lending-policy-view">
      {intent === 'off' ? <p>Lending is off.</p> : intent === 'paused' ? <p>Paused by you.</p> : rows.length ? rows.map(row => {
        const approvalIsPerJob = needsApproval(row.provider);
        return (
          <div class="objective-reason" key={row.id}>
            <p><b>{row.title}</b></p>
            <p>{row.line}{row.links?.map(link => <> <a href={link.href} onClick={event => {
              if (link.href === '#starting-assumption') {
                // Local help: open it in place. Changing the URL hash would navigate away from this page.
                event.preventDefault();
                const assumption = document.getElementById('starting-assumption');
                if (assumption) { assumption.open = true; assumption.scrollIntoView?.({block: 'nearest'}); assumption.querySelector('summary')?.focus(); }
              }
            }}>{link.label}</a></>)}</p>
            {row.basisLine && <p class="t-sm">{row.basisLine}</p>}
            {row.basisExplainer && <p class="t-xs t-2">{row.basisExplainer}</p>}
            {approvalIsPerJob && <p>{rulesActive ? 'Requests not covered by a rule ask you first.' : 'You approve each job before it starts.'}</p>}
          </div>
        );
      }) : <p>Faravan can use a starting estimate until a quota reading is available.</p>}
      {changed && <p class="t-sm t-2 preview-note">This explanation reflects the saved settings. Save to apply your changes.</p>}
    </div>
  );
}

const listNames = names => names.length <= 2 ? names.join(' and ') : names.slice(0, -1).join(', ') + ' and ' + names.at(-1);

/** Concurrency is a scheduler capacity setting, not an allowance share. */
export function Concurrency({ p, setP, errors, machineCapacity, providers = [] }) {
  const per = p.accountSlots ?? 1, cap = p.machineSlots ?? (machineCapacity > 0 ? machineCapacity : null);
  const names = providers.map(providerName), together = names.length * per;
  return (
    <Disclosure class="concurrency ph-no-capture" summary={'At the same time: ' + concurrencyText({ ...p, machineSlots: p.machineSlots }, machineCapacity).replace('on this computer','on your computer')} data-telemetry-private="lending-policy-view">
      <p class="t-sm t-2">
        Each agent account runs {per === 1 ? 'one job' : per + ' jobs'} at a time.
        {names.length > 1 && ' If you lend ' + listNames(names) + ', up to ' + together + ' jobs can run together.'}
        {cap && ' Your computer stops at ' + cap + ' jobs in all.'} Jobs share your computer’s resources.
      </p>
      <Card>
        <Line label={POLICY_LABELS.accountSlots} hint="Set this to the number of jobs the account can run together.">
          <select class="select hours" aria-label="Jobs per account" value={String(p.accountSlots ?? 1)} onChange={(e) => setP({ ...p, accountSlots: +field(e) })}>
            {[1, 2, 3].map(n => <option value={String(n)}>{n} per account</option>)}
          </select>
        </Line>
        <Line label={POLICY_LABELS.machineSlots} hint={machineCapacity > 0 ? 'Leave empty to use the detected capacity of ' + machineCapacity + ' jobs.' : 'Leave empty to use detected computer capacity.'} error={errors.machineSlots}>
          <input class="input num" type="number" min="1" max="32" inputMode="numeric" aria-label="Your computer runs at most, jobs" placeholder={machineCapacity > 0 ? String(machineCapacity) : 'Auto'}
            value={p.machineSlots ?? ''} onInput={e => setP({...p,machineSlots:field(e)===''?null:Number(field(e))})} />
          <span class="t-2" aria-hidden="true">jobs</span>
        </Line>
      </Card>
    </Disclosure>
  );
}

export function StopOnReturn({ p, setP }) {
  return <Card data-telemetry-private="lending-policy-view" class="ph-no-capture"><Line label={POLICY_LABELS.stopOnReturn} hint="Off by default. Turn this on to stop lent jobs after about 2 minutes of activity when you return.">
    <Switch label="Stop a running job when I return" checked={p.stopOnReturn} onChange={on => setP({...p,stopOnReturn:on})} />
  </Line></Card>;
}

const EFFORT_CHOICES = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
/** The highest effort a friend may ask for. A saved level above High behaves as High, so it shows as High. */
export function EffortCap({ p, setP }) {
  const shown = EFFORT_CHOICES.some(([id]) => id === p.effortMax) ? p.effortMax : 'high';
  return <Card data-telemetry-private="lending-policy-view" class="ph-no-capture"><Line label="Friends can ask for up to" hint="A request for more effort than this is declined. Lower effort usually uses less of your allowance.">
    <select class="select" aria-label="Highest effort friends can ask for" value={shown} onChange={e => setP({...p,effortMax:field(e)})}>
      {EFFORT_CHOICES.map(([id, label]) => <option value={id}>{label} effort</option>)}
    </select>
  </Line></Card>;
}

/** Who runs without asking: standing rules, each scoped to named people and agents, ending within 30 days. */
export function WhoRules({ lending, devices, circles, agents, mutate, now, zone, circle, onDirtyChange }) {
  const rules = lending.standingRules;
  const [editing, setEditing] = useState(null), [ruleErrors, setRuleErrors] = useState({});
  // A rule form is unsaved work once it differs from the draft it opened with.
  const opened = useRef(null);
  const open = draft => { opened.current = JSON.stringify(draft); setEditing(draft); };
  const dirty = editing !== null && JSON.stringify(editing) !== opened.current;
  useLayoutEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty]);
  if (!Array.isArray(rules)) {
    // Rules need the offers update. Until it ships, every request asks; an older automatic setting is shown, never created.
    return (
      <Card data-telemetry-private="lending-policy-view" class="ph-no-capture">
        <Line label="Requests" hint={lending.mode === 'auto'
          ? 'Automatic mode can run jobs from this circle when account permissions and limits allow it. This was set before rules for named people.'
          : 'Every request shows you what it asks before anything runs. Rules for people you trust come with the next update.'}>
          {lending.mode === 'auto' && lending.circle && <Action run={() => mutate('lending/mode', { circle: lending.circle, mode: 'ask' })} success="Every request now asks you first." className="btn btn-secondary btn-sm">Ask me first</Action>}
        </Line>
      </Card>
    );
  }
  const activeCircle = lending.circle || circle;
  // Agents your computer lends with; an edited rule keeps any it already names.
  const ready = (Array.isArray(agents) ? agents : []).filter(a => a.installed !== false && (a.useForLending === true || a.signedIn === true)).map(a => a.id);
  const vms = rulesVM(rules, { devices, circles, now, zone });
  const save = list => mutate('lending/rules', { rules: list, version: lending.configVersion });
  const people = editing ? rulePeople(editing.circle, devices) : [];
  const toggle = (key, id) => setEditing({ ...editing, [key]: editing[key].includes(id) ? editing[key].filter(x => x !== id) : [...editing[key], id] });
  async function commit() {
    const result = validateRule(editing, { now });
    setRuleErrors(result.errors);
    if (!result.ok) return;
    await save(nextRules(rules, { put: result.rule, now }));
    setEditing(null);
  }
  return (
    <Card data-telemetry-private="lending-policy-view" class="ph-no-capture">
      <p class="line t-sm t-2">{vms.some(rule => rule.appOwned)
        ? 'Anyone without a rule: Faravan shows you the request first. Automatic permission renews while Automatic is on; a rule you make yourself ends after at most 30 days. New people, other agents and longer jobs still ask.'
        : 'Anyone without a rule: Faravan shows you the request first. A rule ends after at most 30 days, and new people, other agents and longer jobs still ask.'}</p>
      {vms.map(rule => (
        <div class="line rule" key={rule.id}>
          <div class="lbl"><b>{rule.who}: run without asking</b>
            {rule.scope}{rule.circleName && ' · ' + rule.circleName} · <span class={rule.endingSoon ? 'rule-ending' : ''}>{rule.until}</span></div>
          <div class="pair">
            {rule.endingSoon && !rule.appOwned && <Action run={() => save(nextRules(rules, { put: { ...rules.find(r => r.id === rule.id), expiresAt: now + 30 * 86400000 }, now }))} success="Renewed for 30 days." className="btn btn-secondary btn-sm">Renew</Action>}
            <button type="button" class="btn btn-secondary btn-sm" onClick={() => { setRuleErrors({}); open(ruleDraft(rules.find(r => r.id === rule.id))); }}>Edit</button>
            <Action run={() => save(nextRules(rules, { revoke: rule.id, now }))} success={rule.appOwned ? 'Automatic is still on; its permission will be recreated. Choose Ask or Off to stop automatic permission.' : 'Rule removed. Their requests ask you again.'} className="btn btn-secondary btn-sm">Remove</Action>
          </div>
        </div>
      ))}
      {editing ? (
        <div class="rule-edit" role="group" aria-label={editing.id ? 'Edit rule' : 'New rule'}>
          {rules.find(r => r.id === editing.id)?.appOwned === true && <p class="t-sm t-2">Editing this permission makes it a custom rule; it will no longer renew automatically.</p>}
          <fieldset><legend><b>People</b></legend>
            {people.length ? people.map(person => (
              <label class="check" key={person.id}><input type="checkbox" checked={editing.people.includes(person.id)} onChange={() => toggle('people', person.id)} />{person.name}</label>
            )) : <p class="t-sm t-2">No one else is in this circle yet.</p>}
            {ruleErrors.people && <span class="line-error" role="alert">{ruleErrors.people}</span>}
          </fieldset>
          <fieldset><legend><b>Agents</b></legend>
            {[...new Set([...ready, ...editing.agents])].length === 0 && <p class="t-sm t-2">No agent is ready to lend yet. Set one up on the Lending page.</p>}
            {[...new Set([...ready, ...editing.agents])].map(id => <label class="check" key={id}><input type="checkbox" checked={editing.agents.includes(id)} onChange={() => toggle('agents', id)} />{agentProduct(id).name}</label>)}
            {ruleErrors.agents && <span class="line-error" role="alert">{ruleErrors.agents}</span>}
          </fieldset>
          {[['jobs', 'Jobs a day', 'jobs'], ['dailyMinutes', 'Minutes a day', 'min'], ['days', 'Ends after', 'days']].map(([key, label, suffix]) => (
            <Line label={label} error={ruleErrors[key]} key={key}
              hint={key === 'days' && /^\d+$/.test(editing.days) && +editing.days >= 1 && +editing.days <= 30 ? 'Ends ' + whenText(now + editing.days * 86400000, { now, zone }) + '. Renew it then if you still want it.' : ['jobs', 'dailyMinutes'].includes(key) ? 'Leave empty for no cap.' : undefined}>
              <input class="input num" type="number" min={key === 'jobs' ? 1 : key === 'dailyMinutes' ? 5 : 1}
                max={key === 'jobs' ? 20 : key === 'dailyMinutes' ? 600 : 30}
                inputMode="numeric" placeholder={['jobs', 'dailyMinutes'].includes(key) ? 'No cap' : undefined}
                aria-label={'Rule: ' + label} value={editing[key]} onInput={(e) => setEditing({ ...editing, [key]: field(e) })} />
              <span class="t-2" aria-hidden="true">{suffix}</span>
            </Line>
          ))}
          <div class="pair rule-actions">
            <button type="button" class="btn btn-secondary" onClick={() => { setEditing(null); setRuleErrors({}); }}>Cancel</button>
            <Action className="btn btn-primary" run={commit} success="">{editing.id ? 'Save rule' : 'Add rule'}</Action>
          </div>
        </div>
      ) : activeCircle && (
        <div class="line"><button type="button" class="btn btn-secondary btn-sm" onClick={() => { setRuleErrors({}); open(ruleDraft(null, { circle: activeCircle, people: [], agents: ready })); }}>Add a rule</button></div>
      )}
    </Card>
  );
}
