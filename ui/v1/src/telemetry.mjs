// UI friction, derived on this computer from signals the app already has (docs/design/TELEMETRY.md, `ui.friction`).
// Friction records go to this computer's app (POST /api/telemetry/ui), which projects
// them through the closed catalog before anything is queued. This module sends only semantic words: a ROUTES key, an
// operation id from OP_BY_WRITE, a failure code that looks like a code, and a friction kind. It never reads or forwards
// a title, id, path, message or any text the person typed; every record is rebuilt field by field in `clean`.
import {ROUTES} from './helpers.mjs';
import {bannerErrors} from './banner-errors.mjs';
import {COMPOSE_DRAFT_PREFIX} from './compose-draft.mjs';

export const KINDS = Object.freeze(['action_repeated', 'dead_end', 'recovery_shown', 'recovery_action', 'flow_abandoned', 'error_banner']);
export const BATCH_MS = 5000, MAX_BATCH = 20, MAX_QUEUE = 100, REPEAT_COUNT = 3, REPEAT_WINDOW_MS = 10000;
// The privacy screens carry no friction signal worth counting, and the catalog's route list has no entry for them.
const ROUTE_KEYS = new Set(Object.keys(ROUTES).filter(key => key !== 'telemetry'));
// The writes the app makes most, as operation ids (lib/v1/ops/registry.mjs). Anything else is counted locally for the
// repeat rule and sent without an op, which the server records as `none`. telemetry.test.mjs keeps these in the catalog.
export const OP_BY_WRITE = Object.freeze([
  [/^jobs$/, 'jobs.submit'], [/^jobs\/[^/]+\/cancel$/, 'jobs.cancel'], [/^jobs\/[^/]+\/apply$/, 'jobs.apply'],
  [/^approvals\/[^/]+\/accept$/, 'approvals.accept'], [/^approvals\/[^/]+\/skip$/, 'approvals.decline'],
  [/^lending\/on$/, 'lending.on'], [/^lending\/off$/, 'lending.off'], [/^lending\/pause$/, 'lending.pause'],
  [/^lending\/resume$/, 'lending.resume'], [/^lending\/stop$/, 'lending.stop_job'],
  [/^agents\/refresh$/, 'agents.check'], [/^circles$/, 'circles.create'], [/^circles\/join$/, 'circles.join'],
  [/^circles\/join-preview$/, 'circles.preview_join'],
].map(([pattern, op]) => Object.freeze({pattern, op})));
export const OPS_SENT = Object.freeze(new Set(OP_BY_WRITE.map(entry => entry.op)));
const CODE = /^[a-z][a-z0-9_]{1,47}$/;

const pathOf = path => String(path ?? '').replace(/^\/?(?:api\/)?/, '').split('?')[0];
export const opForWrite = path => OP_BY_WRITE.find(entry => entry.pattern.test(pathOf(path)))?.op ?? null;

/** Rebuild a record from its allowed fields only, or null. Nothing else on the input survives. */
export function clean(raw) {
  if (!raw || !KINDS.includes(raw.kind) || !ROUTE_KEYS.has(raw.route)) return null;
  const out = {kind: raw.kind, route: raw.route};
  if (OPS_SENT.has(raw.op)) out.op = raw.op;
  if (typeof raw.code === 'string' && CODE.test(raw.code)) out.code = raw.code;
  return out;
}

/** The error banners that are showing right now, as `{name, code}` (the same filter the app banner uses). */
export const bannerCodes = errors => Object.entries(bannerErrors(errors)).map(([name, error]) => ({name, code: error?.code}));

/**
 * `send(records)` posts a batch; `permitted()` is the authoritative browser consent gate. Without it, the supplied
 * effective level must be 'on'. Neither observations nor flushes run while permission is closed. At most one batch of MAX_BATCH goes out per BATCH_MS, never
 * awaited by the caller, and every error is swallowed.
 */
export function createFriction({send, effective = () => null, permitted = () => effective() === 'on', now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, unsent = () => false} = {}) {
  let queue = [], lastSent = -Infinity, timer = null, current = null;
  const writes = new Map(), banners = new Set();
  const allowed = () => permitted() === true;

  function flush() {
    timer = null;
    if (!allowed()) { queue = []; return; }
    if (!queue.length) return;
    const wait = lastSent + BATCH_MS - now();
    if (wait > 0) { timer = setTimer(flush, wait); return; }
    const records = queue.splice(0, MAX_BATCH);
    lastSent = now();
    try { Promise.resolve(send(records)).catch(() => {}); } catch { /* telemetry never breaks the app */ }
    if (queue.length) timer = setTimer(flush, BATCH_MS);
  }
  function record(raw) {
    if (!allowed()) return;
    const entry = clean(raw);
    if (!entry) return;
    queue.push(entry);
    if (queue.length > MAX_QUEUE) queue.shift();
    if (!timer) timer = setTimer(flush, Math.max(0, lastSent + BATCH_MS - now()));
  }

  return {
    record, flush,
    /** A write the person (or the app on their behalf) started. The third identical write on one route within 10 s is friction. */
    write(method, path) {
      if (!allowed() || String(method).toUpperCase() === 'GET') return;
      if (pathOf(path).startsWith('telemetry/')) return; // the privacy controls are never friction
      const at = now(), page = current, key = page + ' ' + String(method).toUpperCase() + ' ' + pathOf(path).replace(/[^/]*\d[^/]*/g, '#');
      const recent = (writes.get(key) ?? []).filter(time => at - time <= REPEAT_WINDOW_MS);
      recent.push(at);
      if (recent.length >= REPEAT_COUNT) { writes.delete(key); record({kind: 'action_repeated', route: page, op: opForWrite(path)}); } else writes.set(key, recent);
      if (writes.size > 200) writes.clear();
    },
    /** The app's current errors. Each new banner is one record; a banner that stays up is not counted again. */
    errors(errors) {
      if (!allowed()) return;
      const page = current, live = new Set();
      for (const {name, code} of bannerCodes(errors)) {
        const key = page + ':' + name + ':' + code;
        live.add(key);
        if (!banners.has(key)) { banners.add(key); record({kind: 'error_banner', route: page, code}); }
      }
      for (const key of banners) if (!live.has(key)) banners.delete(key);
    },
    /** The page the person is on. Leaving the composer with text that was never sent is an abandoned flow. */
    setRoute(next) {
      const from = current;
      current = next;
      if (!from || from === next || !allowed()) return;
      let abandoned = false;
      try { abandoned = unsent(from) === true; } catch { /* unreadable draft: nothing to report */ }
      if (abandoned) record({kind: 'flow_abandoned', route: from});
    },
    stop() { if (timer) clearTimer(timer); timer = null; queue = []; writes.clear(); banners.clear(); },
  };
}

/** Is there composer text on this computer that was never sent? Reads only whether a draft has a prompt. */
export function hasUnsentCompose(storage) {
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(COMPOSE_DRAFT_PREFIX)) continue;
      const draft = JSON.parse(storage.getItem(key) ?? 'null');
      if (draft && typeof draft.prompt === 'string' && draft.prompt.trim() && draft.sending !== true) return true;
    }
  } catch { /* storage blocked or unreadable: nothing to report */ }
  return false;
}

/** Wrap an api so each write is also noted for the repeat rule. The wrapper changes no request and no result. */
export function instrumentApi(api, friction) {
  return {...api, post: (path, body, signal) => { try { friction.write('POST', path); } catch { /* never in the way */ } return api.post(path, body, signal); }};
}
