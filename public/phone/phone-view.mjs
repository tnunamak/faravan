// What the device page says, as pure functions over the device listener's JSON. phone.mjs only draws it.

const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** The pairing code the computer's QR put after '#', or null. Nothing else in the fragment is trusted. */
export function codeFromHash(hash) {
  // Same rule as the computer's normalizeCode: separators out, ASCII only, then upper case (ſ would otherwise become S).
  const bare = String(hash ?? '').replace(/^#/, '').replace(/[\s\-\u2013\u2014]/g, '');
  if (!/^[A-Za-z0-9]+$/.test(bare)) return null;
  const value = bare.toUpperCase();
  return CODE.test(value) ? value.slice(0, 4) + '-' + value.slice(4) : null;
}

export function defaultPhoneName(userAgent = '') {
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return 'Android device';
  return 'Device';
}

/** iOS keeps a Home Screen web app's cookies apart from Safari's: pairing in a tab would not carry over. */
export function iosNeedsHomeScreen(userAgent = '', standalone = false) {
  return /iPhone|iPad/.test(userAgent) && !standalone;
}

// The device may be far from the computer, so every ending names a step it can take here: a new pairing link.
const NEW_LINK = 'Open a new pairing link, or start pairing again in Faravan on your computer.';
const START_AGAIN = 'Pairing ended. ' + NEW_LINK;
/** The device polls /phone/api/pair/status. done: stop polling; message: what to say if it did not work. */
export function pairOutcome(state) {
  if (state === 'claimed' || state === 'waiting_for_computer') return {done: false, message: null};
  if (state === 'paired') return {done: true, message: null};
  if (state === 'rejected') return {done: true, message: 'Your computer said the words didn’t match, so pairing stopped. Start pairing again on your computer.'};
  // Recoverable: once a device is removed on the computer, the same pairing finishes by itself.
  if (state === 'too_many_phones') return {done: false, message: 'Your computer has as many paired devices as it allows. Remove one there; this device then finishes pairing.'};
  if (state === 'too_many_tries') return {done: true, message: 'Too many wrong codes. Start pairing again on your computer.'};
  // The code's 5 minutes ran out before the computer confirmed the words.
  if (state === 'expired') return {done: true, message: 'Pairing wasn’t confirmed in time. ' + NEW_LINK};
  return {done: true, message: START_AGAIN};
}

export function timeLeft(expiresAt, now = Date.now()) {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return 'Expired';
  if (ms < 60000) return 'Less than a minute left';
  if (ms >= 3600000) return Math.floor(ms / 3600000) + ' h left';
  return Math.floor(ms / 60000) + ' min left';
}

const NETWORK = {internet: 'Internet access', 'provider-only': 'Only the agent’s own service', none: 'No network'};
function duration(seconds) {
  if (!Number.isFinite(seconds)) return null;
  return seconds >= 3600 ? 'Up to ' + Math.round(seconds / 360) / 10 + ' h' : 'Up to ' + Math.max(1, Math.round(seconds / 60)) + ' min';
}

export function cardView(card, {canAnswer, now = Date.now()} = {}) {
  const facts = [card.agent, duration(card.runtimeSeconds), NETWORK[card.network] ?? null,
    Number.isFinite(card.sourceFiles) ? card.sourceFiles + (card.sourceFiles === 1 ? ' file' : ' files') : null].filter(Boolean);
  return {
    id: card.id, offer: card.offer === true, declineLabel: card.offer ? 'Not for me' : 'Not now',
    declineNote: card.offer ? 'Not for me hides this offer on this computer. Others can still run it.' : 'Not now sends it back to the circle.', title: card.requester || 'A circle member', facts,
    prompt: typeof card.prompt === 'string' && card.prompt ? card.prompt : null,
    promptNote: card.promptHidden ? 'Task text stays on your computer. This device has view-only access; pair over trusted HTTPS to see it and answer.' : null,
    notice: card.notice ?? null,
    expires: timeLeft(card.expiresAt, now),
    startsNow: card.startsNow !== false,
    canAnswer: canAnswer === true,
    answerNote: canAnswer === true ? null : 'Answer on your computer. This device can see requests but not answer them.',
  };
}

const STATUS = {accepted: 'Run it', declined: 'Not now', dismissed: 'Not for me', expired: 'Expired'};
export function inboxView(inbox, now = Date.now()) {
  const done = item => ({...cardView(item, {canAnswer: false, now}), canAnswer: false, answerNote: null, expires: null,
    status: STATUS[item.state] + (item.by && item.state !== 'expired' ? ' · answered on ' + item.by : '')});
  return {
    heading: 'Requests for ' + (inbox.computer || 'your computer'),
    sections: [
      {id: 'needs', title: 'Needs your answer', items: (inbox.needs ?? []).map(card => cardView(card, {canAnswer: inbox.canAnswer, now})),
        empty: (inbox.needs ?? []).length ? null : 'Nothing needs your answer.'},
      {id: 'answered', title: 'Answered', items: (inbox.answered ?? []).map(done), empty: null},
      {id: 'expired', title: 'Expired', items: (inbox.expired ?? []).map(done), empty: null},
    ],
    reachNote: 'Updates while this device can reach your computer and Faravan is running there. No notifications yet.',
  };
}

const PROBLEMS = {
  wrong_code: 'That code doesn’t match. Check the code on your computer and try again.',
  pairing_not_open: 'This pairing link has expired or was already used. ' + NEW_LINK,
  too_many_tries: 'Too many wrong codes. Start pairing again on your computer.',
  not_paired: 'This device isn’t paired any more. Open a new pairing link, or pair it again from Faravan on your computer.',
  forbidden: 'This device can see requests but not answer them. Answer on your computer.',
  too_many_phones: 'Your computer has as many paired devices as it allows. Remove one there, then pair again.',
  network: 'Can’t reach your computer. Check that this device is on your tailnet or the computer’s network, the computer is awake, and Faravan is running.',
  approval_expired: 'This request expired before your answer arrived.',
  identity_changed: 'The requester’s details changed. Review the request again.',
  protection_not_ready: 'Your computer isn’t ready to run this safely right now. Check Faravan on the computer.',
  not_found: 'This request was already answered or has ended.',
};
export function problemText(problem) {
  return PROBLEMS[problem?.code] ?? (typeof problem?.message === 'string' && problem.message.length < 240 ? problem.message : 'Something went wrong. Try again.');
}

// ----- friction (design §2.2 "UI and phone", §3.4 ui.friction) -----
// The device reports an error it showed, as enums only: the screen, the answer's operation id, and the failure code, but
// only a code this device has text for (PROBLEMS). Nothing else from the server's answer is sent. The app checks every
// record again and maps any other code to unknown.
const FRICTION_ROUTES = new Set(['home', 'request']);
const FRICTION_OPS = new Set(['approvals.accept', 'approvals.decline']);

/** The record for an error banner on a screen, or null for a screen this list does not name. */
export function frictionRecord({route, op, problem} = {}) {
  if (!FRICTION_ROUTES.has(route)) return null;
  const record = {kind: 'error_banner', route};
  if (FRICTION_OPS.has(op)) record.op = op;
  if (typeof problem?.code === 'string' && Object.hasOwn(PROBLEMS, problem.code)) record.code = problem.code;
  return record;
}

/** Sends the records in batches of at most 20, at most one batch every `batchMs`. Nothing it does reaches the caller. */
export function createFriction({send, setTimer = setTimeout, batchMs = 5000, max = 20}) {
  let queue = [], timer = null;
  const flush = () => {
    timer = null;
    const records = queue.splice(0, max);
    if (records.length) {
      try { Promise.resolve(send(records)).catch(() => {}); } catch { /* telemetry never gets in the way */ }
    }
    if (queue.length) timer = setTimer(flush, batchMs);
  };
  return {
    add(record) {
      if (!record) return;
      queue.push(record);
      if (queue.length > 100) queue.shift();
      if (!timer) timer = setTimer(flush, batchMs);
    },
  };
}
