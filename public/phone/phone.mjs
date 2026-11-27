// The device page: pair, then the requests inbox. All text comes from phone-view.mjs; server strings go
// through textContent only. Polls while the page is visible; there is no push yet.
import { codeFromHash, defaultPhoneName, iosNeedsHomeScreen, pairOutcome, inboxView, problemText, frictionRecord, createFriction } from './phone-view.mjs';

const app = document.getElementById('app');
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let timer = null, flash = null;
const friction = createFriction({send: records => call('/phone/api/telemetry', {method: 'POST', body: {records}})});
const PAIRED = 'faravan.phone.paired'; // a flag, never a credential: the session is an HttpOnly cookie

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false)
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}
// Same rule as el(): a missing optional part draws nothing (replaceChildren(null) would print "null").
const show = (...nodes) => { app.replaceChildren(...nodes.flat().filter(node => node !== null && node !== undefined && node !== false)); };
// `pending` is the next step of whatever screen is polling (pairing words or inbox). A hidden page holds it without a timer
// and the page runs it once when it is visible again, so a hidden page makes no requests and the poll is never lost.
let pending = null;
const hidden = () => document.visibilityState === 'hidden';
const stop = () => { clearTimeout(timer); timer = null; pending = null; };
const later = (fn, ms) => {
  stop(); pending = fn;
  if (!hidden()) timer = setTimeout(() => { timer = null; pending = null; fn(); }, ms);
};

async function call(path, {method = 'GET', body} = {}) {
  let response;
  try {
    response = await fetch(path, {method, cache: 'no-store', credentials: 'same-origin',
      headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  } catch { throw {code: 'network'}; }
  let json = null; try { json = await response.json(); } catch { /* empty body */ }
  if (!response.ok) throw json ?? {code: 'network'};
  return json;
}

// ----- pairing -----
function pairScreen({message} = {}) {
  stop();
  const fromQr = codeFromHash(location.hash);
  if (location.hash) history.replaceState(null, '', location.pathname === '/pair' ? '/' : location.pathname);
  const code = el('input', {class: 'input code', id: 'code', name: 'code', autocomplete: 'off', autocapitalize: 'characters',
    spellcheck: 'false', inputmode: 'text', placeholder: 'XXXX-XXXX', value: fromQr ?? '', 'aria-describedby': 'code-help'});
  const name = el('input', {class: 'input', id: 'name', name: 'name', autocomplete: 'off', maxlength: '40', value: defaultPhoneName(navigator.userAgent)});
  const error = el('p', {class: 'notice bad', role: 'alert', hidden: !message}, message ?? '');
  const submit = el('button', {class: 'btn btn-primary btn-block', type: 'submit'}, 'Pair this device');
  const form = el('form', {class: 'card', novalidate: true, onsubmit: async event => {
    event.preventDefault();
    if (submit.getAttribute('aria-disabled')) return;
    submit.setAttribute('aria-disabled', 'true'); submit.prepend(el('span', {class: 'spinner', 'aria-hidden': 'true'}));
    try {
      const claimed = await call('/phone/api/pair/claim', {method: 'POST', body: {code: code.value, label: name.value}});
      wordsScreen(claimed);
    } catch (problem) {
      error.textContent = problemText(problem); error.hidden = false;
      submit.removeAttribute('aria-disabled'); submit.querySelector('.spinner')?.remove();
      code.focus();
    }
  }},
  el('div', {class: 'field'}, el('label', {for: 'code'}, 'Pairing code'), code,
    el('p', {class: 'muted', id: 'code-help'}, 'Type the 8 characters; the dash is optional. If the code is empty, start pairing on your computer in Faravan › Settings › Pairing, then type the code here.')),
  el('div', {class: 'field'}, el('label', {for: 'name'}, 'Name for this device'), name),
  error, submit);
  show(
    el('header', {class: 'head'}, el('h1', {class: 't-page'}, 'Pair this device'),
      el('p', {class: 'lede'}, 'Pair this device with your Faravan computer. What it can do here is the access chosen on that computer.')),
    iosNeedsHomeScreen(navigator.userAgent, standalone)
      ? el('p', {class: 'notice need'}, 'On iPhone, first tap Share, then Add to Home Screen, and pair from the Home Screen app. Safari and the Home Screen app keep separate sign-ins.')
      : null,
    form);
  if (!fromQr) code.focus();
}

function wordsScreen(claimed) {
  const status = el('p', {class: 'waiting', role: 'status'}, el('span', {class: 'spinner', 'aria-hidden': 'true'}),
    'Waiting for confirmation from ' + (claimed.computer || 'your computer') + '…');
  show(
    el('header', {class: 'head'}, el('h1', {class: 't-page'}, 'Check the words'),
      el('p', {class: 'lede'}, (claimed.computer || 'Your computer') + ' shows three words. They must match these exactly. Pairing finishes when they are confirmed there.')),
    el('section', {class: 'card'},
      el('p', {class: 'words', 'aria-label': 'Pairing words: ' + claimed.phrase.join(', ')}, ...claimed.phrase.map(word => el('span', {}, word))),
      status,
      el('p', {class: 'muted'}, claimed.scopes?.includes('app:full')
        ? 'Once paired, this device can use the whole Faravan app: send jobs, lend, see job results and change settings. Pairing other devices and actions that need this computer still happen there.'
        : claimed.scopes?.includes('requests:answer')
        ? 'Once paired, this device can see requests and run them or leave them for other people. It can’t send jobs or change settings.'
        : 'Once paired, this device can see requests. To answer them here, your computer needs an encrypted (HTTPS) connection.')));
  const poll = async () => {
    try {
      const {state, full} = await call('/phone/api/pair/status');
      // A device paired for the full app opens it: this listener now serves the app at /.
      if (state === 'paired' && full === true) { localStorage.setItem(PAIRED, 'yes'); return location.replace('/'); }
      const outcome = pairOutcome(state);
      if (!outcome.done) { if (outcome.message) status.replaceChildren(outcome.message); return later(poll, outcome.message ? 4000 : 1500); }
      if (outcome.message) return pairScreen({message: outcome.message});
      return inbox();
    } catch (problem) {
      status.replaceChildren(problemText(problem));
      later(poll, 4000);
    }
  };
  later(poll, 1500);
}

// ----- inbox -----
function requestCard(item, {live}) {
  const facts = el('ul', {class: 'facts'}, ...item.facts.map(fact => el('li', {}, fact)));
  const parts = [
    el('div', {class: 'request-head'}, el('h3', {class: 'request-who'}, item.title),
      item.expires ? el('span', {class: 'request-time' + (item.offer ? ' offer-deadline' : '')}, item.expires) : null),
    facts,
    item.prompt ? el('p', {class: 'prompt'}, item.prompt) : null,
    item.promptNote ? el('p', {class: 'muted'}, item.promptNote) : null,
    item.notice ? el('p', {class: 'notice need'}, item.notice) : null,
    item.status ? el('p', {class: 'status-line'}, item.status) : null,
  ];
  if (live && item.canAnswer) {
    // The same decision and words as the request page on the computer: nothing runs without Run it.
    parts.push(el('p', {class: 'muted'}, (item.startsNow ? 'Run it starts the job on your computer now, even while you are using it. ' : '') + item.declineNote),
      el('div', {class: 'actions'},
        el('button', {class: 'btn btn-secondary', type: 'button', onclick: event => answer(item.id, 'decline', event.currentTarget, item.offer)}, item.declineLabel),
        el('button', {class: 'btn btn-primary', type: 'button', onclick: event => answer(item.id, 'accept', event.currentTarget)}, 'Run it')));
  } else if (live && item.answerNote) parts.push(el('p', {class: 'muted'}, item.answerNote));
  return el('li', {}, el('article', {class: 'card request', 'aria-label': 'Request from ' + item.title}, ...parts));
}

async function answer(id, verb, button, offer = false) {
  if (button.getAttribute('aria-disabled')) return;
  for (const sibling of button.parentElement.querySelectorAll('button')) sibling.setAttribute('aria-disabled', 'true');
  try {
    await call('/phone/api/requests/' + encodeURIComponent(id) + '/' + verb, {method: 'POST', body: {}});
    flash = {text: verb === 'accept' ? 'Run it sent. Check progress on your computer.' : offer ? 'Not for me sent. Hidden on this computer; others can still run it.' : 'Not now sent. The request goes back to the circle.', bad: false};
  } catch (problem) {
    flash = {text: problemText(problem), bad: true};
    friction.add(frictionRecord({route: 'request', op: verb === 'accept' ? 'approvals.accept' : 'approvals.decline', problem}));
  }
  inbox();
}

async function inbox({first = false} = {}) {
  stop();
  let data;
  try { data = await call('/phone/api/inbox'); } catch (problem) {
    if (problem?.code === 'not_paired') {
      // Only a device that was paired here before is told it was removed; a new phone just sees the pair form.
      const wasPaired = localStorage.getItem(PAIRED) === 'yes';
      localStorage.removeItem(PAIRED);
      return pairScreen(first && !wasPaired ? {} : {message: problemText(problem)});
    }
    show(el('header', {class: 'head'}, el('h1', {class: 't-page'}, 'Requests')),
      el('p', {class: 'notice bad', role: 'alert'}, problemText(problem)),
      el('button', {class: 'btn btn-secondary', type: 'button', onclick: () => inbox()}, 'Try again'));
    return later(inbox, 10000);
  }
  localStorage.setItem(PAIRED, 'yes');
  const view = inboxView(data);
  const sections = view.sections.filter(section => section.id === 'needs' || section.items.length).map(section =>
    el('section', {'aria-labelledby': 'h-' + section.id},
      el('h2', {class: 't-section', id: 'h-' + section.id}, section.title,
        section.items.length ? el('span', {class: 'count'}, String(section.items.length)) : null),
      section.items.length
        ? el('ul', {class: 'list'}, ...section.items.map(item => requestCard(item, {live: section.id === 'needs'})))
        : el('p', {class: 'empty'}, section.empty)));
  const message = flash; flash = null;
  show(
    el('header', {class: 'head'}, el('h1', {class: 't-page'}, view.heading), el('p', {class: 'muted'}, view.reachNote)),
    message ? el('p', {class: 'notice' + (message.bad ? ' bad' : ''), role: message.bad ? 'alert' : 'status'}, message.text) : null,
    ...sections,
    el('footer', {class: 'foot'},
      el('p', {class: 'muted'}, 'Paired as ' + data.phone.label + '.'),
      el('button', {class: 'btn btn-quiet', type: 'button', onclick: unpair}, 'Unpair this device')));
  later(inbox, 10000);
}

async function unpair(event) {
  const button = event.currentTarget;
  if (button.dataset.armed !== 'yes') {
    button.dataset.armed = 'yes'; button.textContent = 'Tap again to unpair'; button.className = 'btn btn-danger';
    return;
  }
  try { await call('/phone/api/unpair', {method: 'POST', body: {}}); } catch (problem) {
    // Already removed on the computer counts as unpaired. Any other failure leaves this device paired: say so, and let the next tap retry.
    if (problem?.code !== 'not_paired') {
      flash = {text: 'This device is still paired. ' + problemText(problem) + ' Tap Unpair this device to try again.', bad: true};
      return inbox();
    }
  }
  localStorage.removeItem(PAIRED);
  pairScreen({message: 'This device is unpaired. Pair it again from Faravan on your computer.'});
}

document.addEventListener('visibilitychange', () => {
  if (hidden()) { clearTimeout(timer); timer = null; return; }
  const resume = pending; stop();
  if (resume) resume();
});
new MutationObserver(() => { app.dataset.screen = app.querySelector('.request, .empty, .foot') ? 'inbox' : 'pair'; })
  .observe(app, {childList: true});

if (window.isSecureContext && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (codeFromHash(location.hash)) pairScreen();
else inbox({first: true});
