// Controlled viewport for the telemetry notice tests. It separates three things a real browser mixes together:
//   - observer entries: delivered by the test, or queued and delivered late, like an IntersectionObserver callback;
//   - layout: where the notice currently is, changed by the test without any observer entry;
//   - visibility: document.visibilityState, changed by the test with a visibilitychange event.
// Also counts live visibilitychange listeners, so a test can assert cleanup. Import after mounted.test-helper.mjs;
// call restoreViewport() in afterEach.
import {window} from './mounted.test-helper.mjs';

const ONSCREEN = {top: 100, bottom: 140, left: 0, right: 300, width: 300, height: 40};
const OFFSCREEN = {top: 2000, bottom: 2040, left: 0, right: 300, width: 300, height: 40};
const live = new Set(), all = [], visibilityListeners = new Set();
const state = {visibility: 'visible', layout: ONSCREEN};
let installed = false, originals = null;

class FakeIntersectionObserver {
  constructor(callback) { this.callback = callback; this.targets = new Set(); this.disconnected = false; this.observeCalls = 0; all.push(this); }
  observe(target) { this.observeCalls++; this.targets.add(target); live.add(this); }
  unobserve(target) { this.targets.delete(target); }
  disconnect() { this.disconnected = true; live.delete(this); }
  takeRecords() { return []; }
}

const isNotice = element => element?.classList?.contains?.('telemetry-notice');

/**
 * Install the fake observer, the layout control and the visibility control. Nothing reaches the component except
 * what the test delivers, so a test decides exactly when an entry is seen, when the notice moves, and when the tab changes.
 */
export function installViewport() {
  if (!installed) {
    installed = true;
    originals = {
      rect: window.Element.prototype.getBoundingClientRect,
      add: document.addEventListener,
      remove: document.removeEventListener,
    };
    globalThis.IntersectionObserver = FakeIntersectionObserver;
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => state.visibility});
    window.Element.prototype.getBoundingClientRect = function () {
      return isNotice(this) ? {...state.layout} : originals.rect.call(this);
    };
    document.addEventListener = function (type, listener, options) {
      if (type === 'visibilitychange') visibilityListeners.add(listener);
      return originals.add.call(this, type, listener, options);
    };
    document.removeEventListener = function (type, listener, options) {
      if (type === 'visibilitychange') visibilityListeners.delete(listener);
      return originals.remove.call(this, type, listener, options);
    };
  }
  state.visibility = 'visible';
  state.layout = ONSCREEN;
  return {
    /** Observers created so far, including disconnected ones. */
    created: all,
    /** Count of visibilitychange listeners that were added and not removed. */
    visibilityListeners: () => visibilityListeners.size,
    setVisibility(value) {
      state.visibility = value;
      document.dispatchEvent(new window.Event('visibilitychange'));
    },
    /** Move the notice without any observer entry: 'onscreen' or 'offscreen'. */
    place(where) { state.layout = where === 'offscreen' ? OFFSCREEN : ONSCREEN; },
    /** Deliver an intersection entry to every connected observer, as a browser does when the element moves. */
    deliver(isIntersecting) {
      for (const observer of [...live]) observer.callback([...observer.targets].map(target => ({target, isIntersecting})), observer);
    },
    /** Run a callback queued before its observer disconnected, or before a dismissal. A browser can still run one then. */
    deliverLate(observer, isIntersecting) {
      observer.callback([...observer.targets].map(target => ({target, isIntersecting})), observer);
    },
  };
}

export function restoreViewport() {
  live.clear(); all.length = 0; visibilityListeners.clear();
  state.visibility = 'visible'; state.layout = ONSCREEN;
  if (installed) {
    delete globalThis.IntersectionObserver;
    delete document.visibilityState;
    window.Element.prototype.getBoundingClientRect = originals.rect;
    document.addEventListener = originals.add;
    document.removeEventListener = originals.remove;
    installed = false;
    originals = null;
  }
}
