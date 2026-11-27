// Mounted-component test kit: a real DOM (happy-dom), real Preact effects (preact/test-utils `act`),
// one deterministic clock (node:test mock timers, which also fake Date) and a fake API whose reads are
// deferred promises the test settles by hand. Import this file FIRST in a test: it installs the DOM
// globals before any component module is evaluated. Nothing here replaces a hook, queue or component.
import {Window} from 'happy-dom';
import {mock} from 'node:test';
import {render} from 'preact';
import {act, setupRerender, teardown as resetPreactScheduler} from 'preact/test-utils';

const window = new Window({url: 'http://127.0.0.1:7777/', width: 1280, height: 900});
const GLOBALS = ['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'MutationObserver',
  'Node', 'Element', 'HTMLElement', 'HTMLDialogElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'getComputedStyle'];
const define = (key, value) => Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
for (const key of GLOBALS) define(key, key === 'window' ? window : window[key]);
define('matchMedia', query => window.matchMedia(query));
define('requestAnimationFrame', callback => setTimeout(() => callback(Date.now()), 16));
define('cancelAnimationFrame', id => clearTimeout(id));
// happy-dom does not implement <dialog> modality; the app only needs the calls to exist.
const dialog = window.HTMLDialogElement?.prototype;
if (dialog) { dialog.showModal ??= function () { this.setAttribute('open', ''); }; dialog.close ??= function () { this.removeAttribute('open'); }; }

// ---- clock ---------------------------------------------------------------------------------------
let clockOn = false;
export function installClock(start = Date.UTC(2026, 9, 20, 15, 0, 0)) {
  mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date'], now: start});
  clockOn = true;
}
export function removeClock() { if (clockOn) mock.timers.reset(); clockOn = false; }

const microtasks = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// Settle pending promises and effects without moving the clock.
export const flush = () => act(async () => { await microtasks(); });

// Commit Preact's queued state renders but leave useEffect work on the mocked frame/timer queue.
export async function flushRendersWithoutEffects(trigger) {
  const rerender=setupRerender();
  try {
    trigger?.();
    await microtasks();
    rerender();
    await microtasks();
    rerender();
  } finally {
    resetPreactScheduler();
  }
}

// Move the fake clock `ms` forward in `step` slices, letting promises and effects settle after each.
export async function advance(ms, step = 1000) {
  let left = ms;
  while (left > 0) {
    const slice = Math.min(step, left);
    left -= slice;
    await act(async () => { mock.timers.tick(slice); await microtasks(); });
  }
  await flush();
}

// ---- mounting ------------------------------------------------------------------------------------
export function resetPage(hash = '') {
  document.body.innerHTML = '';
  document.title = '';
  try { localStorage.clear(); sessionStorage.clear(); } catch {}
  history.replaceState(null, '', '/' + (hash ? '#' + hash.replace(/^#/, '') : ''));
}

const roots = new Set();
export async function mount(vnode, {id = 'app'} = {}) {
  const container = document.createElement('div');
  container.id = id;
  document.body.append(container);
  roots.add(container);
  await act(() => { render(vnode, container); });
  await flush();
  return {
    container,
    rerender: async next => { await act(() => { render(next, container); }); await flush(); },
    unmount: async () => { await act(() => { render(null, container); }); await flush(); container.remove(); roots.delete(container); },
    text: () => container.textContent.replace(/\s+/g, ' ').trim(),
    $: selector => container.querySelector(selector),
    $$: selector => [...container.querySelectorAll(selector)],
    button: label => [...container.querySelectorAll('button, a')].find(el => el.textContent.trim() === label) ?? null,
  };
}
// Unmount every root this test mounted (running effect cleanups and removing window/document
// listeners), then drop the fake clock. Call from an async afterEach; the clock goes last.
export async function teardown() {
  for (const container of [...roots]) { await act(() => { render(null, container); }); container.remove(); roots.delete(container); }
  await flush();
  removeClock();
}
export const click = async element => { await act(() => { element.click(); }); await flush(); };
// Dispatch a DOM event directly to exercise the Button's disabled click handling.
export const forceClick = async element => {
  await act(() => { element.dispatchEvent(new window.MouseEvent('click', {bubbles: true, cancelable: true})); });
  await flush();
};
export const navigate = async hash => { await act(() => { location.hash = hash; }); await flush(); };

// ---- fake API (stable identity; every read is a deferred promise) ------------------------------------
const matcher = match => typeof match === 'function' ? match : match instanceof RegExp ? path => match.test(path) : path => path === match;

export function createFakeApi(table = {}) {
  const reads = [], posts = [], encoder = new TextEncoder();
  let open = 0, peakOpen = 0;
  const peakByPath = new Map(), openByPath = new Map();
  const api = {
    table,
    reads,
    posts,
    get(path, signal) {
      const call = {path, signal, state: 'open', ignoreAbort: false};
      call.promise = new Promise((resolve, reject) => {
        call.settle = (kind, value) => {
          if (call.state !== 'open') return;
          call.state = kind === 'ok' ? 'resolved' : 'rejected';
          open--; openByPath.set(path, openByPath.get(path) - 1);
          (kind === 'ok' ? resolve : reject)(value);
        };
      });
      reads.push(call);
      open++; peakOpen = Math.max(peakOpen, open);
      openByPath.set(path, (openByPath.get(path) ?? 0) + 1);
      peakByPath.set(path, Math.max(peakByPath.get(path) ?? 0, openByPath.get(path)));
      signal?.addEventListener('abort', () => {
        call.aborted = true;
        if (!call.ignoreAbort) call.settle('err', new DOMException('Read cancelled', 'AbortError'));
      }, {once: true});
      return call.promise;
    },
    async post(path, body = {}) {
      const call = {path, body};
      posts.push(call);
      return table[path] ?? {};
    },
    async download() { throw new Error('download is not part of these journeys'); },
    // Server-sent events: tests push whole events; watchUpdates reads them like a real stream.
    stream: {queue: [], waiting: null, count: 0, id: 0},
    async request(path, options = {}) {
      if (!path.startsWith('events')) throw new Error('unexpected request ' + path);
      const stream = api.stream;
      stream.count++;
      options.signal?.addEventListener('abort', () => { stream.closed = true; stream.waiting?.({done: true}); }, {once: true});
      return {ok: true, headers: {get: () => 'text/event-stream'}, body: {
        cancel: async () => {},
        getReader: () => ({
          read: () => stream.queue.length ? Promise.resolve({done: false, value: stream.queue.shift()})
            : stream.closed ? Promise.resolve({done: true}) : new Promise(resolve => { stream.waiting = resolve; }),
          cancel: async () => {},
        }),
      }};
    },
    async emit(type, data) {
      const stream = api.stream, chunk = encoder.encode('data: ' + JSON.stringify({id: ++stream.id, type, data}) + '\n\n');
      if (stream.waiting) { const wake = stream.waiting; stream.waiting = null; wake({done: false, value: chunk}); }
      else stream.queue.push(chunk);
      await flush();
    },
    // -- inspection
    readsOf: match => reads.filter(call => matcher(match)(call.path)),
    openReads: match => reads.filter(call => call.state === 'open' && matcher(match)(call.path)),
    count: match => reads.filter(call => matcher(match)(call.path)).length,
    postsOf: match => posts.filter(call => matcher(match)(call.path)),
    peak: path => peakByPath.get(path) ?? 0,
    get peakOpen() { return peakOpen; },
    // -- answering: a value, or a function of the call, looked up in `table` when omitted
    async answer(match, value) {
      const calls = api.openReads(match);
      if (!calls.length) throw new Error('no open read for ' + String(match));
      const call = calls[0];
      call.settle('ok', value === undefined ? resolveTable(call) : value);
      await flush();
      return call;
    },
    async fail(match, error) { const call = api.openReads(match)[0]; call.settle('err', error); await flush(); return call; },
    // Settle every open read that has a table entry, once. Reads started by the answers stay open.
    async release(match = () => true) {
      const calls = api.openReads(match).filter(call => entryFor(call) !== undefined);
      for (const call of calls) call.settle('ok', resolveTable(call));
      await flush();
      return calls.length;
    },
  };
  function entryFor(call) { return table[call.path] ?? table[call.path.split('?')[0]]; }
  function resolveTable(call) {
    const entry = entryFor(call);
    if (entry === undefined) throw new Error('no table entry for ' + call.path);
    return typeof entry === 'function' ? entry(call) : structuredClone(entry);
  }
  return api;
}

export const abortError = () => new DOMException('Read cancelled', 'AbortError');
export {act, window};
