import {problemView,browserProblemContext} from './problem-catalog.mjs';
// Settings › Pairing (briefs/shell-access-integration.md, REVISION 3). The view is the backend's GET /api/phone object,
// flat: {enabled, address, hostname, https, origin, reach:{state,headline,facts}, addresses, phones, pairing}.
// Nothing here guesses a state, a reach or a permission the backend did not report: what a device may do comes from scopes.
import {formatDate, formatRelative} from './dates.mjs';
import {safeName} from './helpers.mjs';

export const phoneErrorText = error => problemView(error?.code==='local_session_required'?{code:'phone_local_session_required'}:error?.problem??error,browserProblemContext()).detail;

/** What a pairing (or a paired phone) may do, in words, from its scopes. Read-only is the default. */
export function scopeLines(scopes) {
  const can = new Set(Array.isArray(scopes) ? scopes : []);
  const answer = can.has('requests:answer');
  if (can.has('app:full')) return {
    can: ['Use the whole Faravan app: send jobs, lend, see job results and change settings'],
    cannot: ['Pair other devices, turn on device access, or confirm actions that need this computer'],
    short: 'Full app',
  };
  return {
    can: [can.has('inbox:read') ? 'See requests to use this computer' : null, answer ? 'Answer requests to use this computer' : null].filter(Boolean),
    cannot: [answer ? null : 'Answer requests (that needs HTTPS)', 'Send jobs, change settings, see your files, or pair other devices'].filter(Boolean),
    short: answer ? 'Can answer requests' : 'View only',
  };
}

export function phoneVM(view, {now = Date.now(), zone} = {}) {
  if (!view || typeof view !== 'object' || !view.reach) return {state: 'loading', phones: [], facts: []};
  const pairing = view.pairing ?? null;
  const dateOptions = zone ? {zone} : {};
  const phones = (Array.isArray(view.phones) ? view.phones : []).map(phone => {
    const paired = formatDate(phone.created_at, 'monthDayYear', dateOptions) || formatDate(phone.created_at, 'longDate', dateOptions);
    const used = formatRelative(phone.last_used_at, {now});
    return {id: phone.id, label: safeName(phone.label, 'A device'), access: scopeLines(phone.scopes).short,
      meta: [paired ? 'Paired ' + paired : '', used ? 'last used ' + used : ''].filter(Boolean).join(' · ')};
  });
  const reach = view.reach.state;
  const left = Date.parse(pairing?.expiresAt) - now, minutes = Math.ceil(left / 60000);
  const confirmationExpired = pairing && (pairing.state === 'expired' || (pairing.state === 'claimed' && !(left > 0)));
  const open = pairing && ['waiting', 'claimed'].includes(pairing.state) && !confirmationExpired;
  const state = !view.enabled ? 'off' : reach === 'problem' ? 'problem' : reach === 'starting' ? 'starting'
    : open && pairing.state === 'claimed' ? 'claimed' : open && pairing.url ? 'waiting' : 'on';
  const ended = confirmationExpired ? 'Pairing was not confirmed in time. Start pairing again when your device is ready.' : pairing && ({
    too_many_tries: 'Too many wrong codes were entered, so pairing stopped. Start again.',
    cancelled: 'Pairing was cancelled. Start again when your device is ready.',
    rejected: 'Pairing stopped because the words didn’t match. No device was paired.'})[pairing.state];
  return {
    state, reachState: reach, headline: String(view.reach.headline ?? ''), facts: Array.isArray(view.reach.facts) ? view.reach.facts.map(String) : [],
    secure: view.https === true, origin: typeof view.origin === 'string' ? view.origin : '',
    addresses: Array.isArray(view.addresses) ? view.addresses : [], address: view.address ?? '',
    phones, ended: state === 'on' ? ended ?? '' : '',
    confirmHere: view.confirmHere === true, computer: safeName(view.computer, 'your computer'),
    pairing: open ? {id: pairing.id, code: String(pairing.code ?? ''), url: String(pairing.url ?? ''),
      // The display link drops the #code: the code is shown on its own, to type.
      shownUrl: String(pairing.url ?? '').replace(/#.*$/, ''),
      qr: pairing.qr && Number.isInteger(pairing.qr.size) && /^(M\d+ \d+h1v1h-1z)*$/.test(pairing.qr.d ?? '') ? pairing.qr : null} : null,
    countdown: state === 'waiting' ? (left > 0 ? (minutes <= 1 ? 'The code works for less than a minute more.' : 'The code works for ' + minutes + ' more minutes.') : 'This code has expired. Start again.') : '',
    phoneLabel: safeName(pairing?.phone?.label, 'A device'), phoneAddress: String(pairing?.phone?.address ?? ''),
    phrase: Array.isArray(pairing?.phrase) ? pairing.phrase.filter(word => typeof word === 'string') : [],
    validPhrase: Array.isArray(pairing?.phrase) && pairing.phrase.length === 3 && Array.from(pairing.phrase).every(word => typeof word === 'string' && /^[a-z]+$/i.test(word)),
    expired: state === 'waiting' && !(left > 0),
    grants: scopeLines(pairing?.scopes),
  };
}
