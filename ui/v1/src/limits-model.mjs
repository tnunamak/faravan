import {settingsFailureText} from './problem-catalog.mjs';
import { validateLimits, scheduleOf, zoneName, limitsDraft } from './view-models.mjs';
import { policyDraft, validatePolicy } from './lending-policy-view.mjs';

/** The whole page draft: time limits and hours (view-models) plus the lending policy. */
export function pageDraft(lending = {}, home = {}, localZone) {
  return {...limitsDraft(lending, home, localZone), policy: policyDraft(lending.limits?.lendingPolicy)};
}
/** Both halves must be valid; the saved limits carry the normalized policy as `lendingPolicy`. */
export function validatePage(draft) {
  const time = validateLimits(draft), policy = validatePolicy(draft.policy);
  const ok = time.ok && policy.ok;
  return {ok, errors: time.errors, policyErrors: policy.errors, limits: ok ? {...time.limits, lendingPolicy: policy.policy} : null};
}

export function scheduleChange(draft, patch, computerZone) {
  return { ...draft, ...(patch.on === true ? { timeZone: computerZone } : {}), schedule: { ...draft.schedule, ...patch } };
}

export function scheduleZoneHint(savedZone, computerZone) {
  return savedZone !== computerZone
    ? 'Your saved hours use ' + zoneName(savedZone) + '. Use your time (' + zoneName(computerZone) + ')? A running job may finish after.'
    : 'Jobs start only in these hours, in your time. A running job may finish after.';
}

export function limitsSaveAmbiguous(error) {
  return !['config_changed', 'invalid_request', 'unauthorized', 'invalid_origin', 'invalid_host', 'device_busy', 'lending_busy'].includes(error?.code)
    && !(error?.status >= 400 && error?.status < 500 && error?.status !== 408);
}

export function sameLimits(left, right) {
  const value = draft => ({...validateLimits(draft).limits, schedule:scheduleOf(draft), policy:validatePolicy(draft.policy ?? policyDraft({})).policy});
  return JSON.stringify(value(left)) === JSON.stringify(value(right));
}

export function limitsSaveError(error) {
  return settingsFailureText(error,limitsSaveAmbiguous(error));
}

// Hash navigation cannot be cancelled. Stop its router event and restore the current URL when
// the person keeps editing. Links are checked before navigation; reload uses the browser prompt.
export function guardUnsavedLimits(win, doc, confirmLeave = () => win.confirm('Discard your unsaved changes?')) {
  const current = win.location.href;
  let approved = false;
  const unload = event => { if (!approved) { event.preventDefault(); event.returnValue = ''; } };
  const click = event => {
    const link = event.target.closest?.('a[href]');
    if (!link || link.target === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (new URL(link.href, current).href === current) return;
    // A link to an element of this page ("#starting-assumption") opens local help; it leaves nothing behind.
    if (/^#[^/]/.test(link.getAttribute?.('href') ?? '')) return;
    if (confirmLeave()) approved = true;
    else { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  const hash = event => {
    if (approved || win.location.href === current) return;
    if (confirmLeave()) approved = true;
    else { win.history.replaceState(win.history.state, '', current); event.stopImmediatePropagation(); }
  };
  win.addEventListener('beforeunload', unload);
  win.addEventListener('hashchange', hash, true);
  doc.addEventListener('click', click, true);
  return () => { win.removeEventListener('beforeunload', unload); win.removeEventListener('hashchange', hash, true); doc.removeEventListener('click', click, true); };
}

// Owner money input is canonical cents, not a rounded binary-float comparison.
// Exponent notation is deliberately not accepted by this decimal-dollar field.
export function ownerLimitAmount(value, minimum) {
  const text = String(value).trim();
  const range = 'Enter an amount from $' + minimum + ' to $1,000,000.';
  if (!text || !Number.isFinite(Number(text)) || Number(text) < minimum || Number(text) > 1000000)
    return {amount: null, error: range};
  if (!/^\d+(?:\.\d{1,2})?$/.test(text))
    return {amount: null, error: 'Enter a dollar amount with no more than two decimal places.'};
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return {amount: cents / 100, error: ''};
}
