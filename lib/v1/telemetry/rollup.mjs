// Rollup: observations over time -> finished records. Stateful, with no network and no disk (the facade persists
// `snapshot()`). It owns the aggregation and sampling policy: counters and histograms for the open hour or day,
// lifecycle spans, once-per-install funnel flags, problem exemplars, local dedupe and request-scoped suppression.
//
// `view` is the consent in force: {gen, streams}. Capture follows consent: a record is made only in a stream the view
// allows, and a span's diagnostic record needs the same generation at its open and its close (docs/design/TELEMETRY-WIRE.md §9).
// A finished record leaves as {stream, gen, record}; the identity fields (rid, epoch, session, seq, trace) are assigned here.
import { CATALOG, bucket, bucketIndex, canonicalJson } from './catalog.mjs';
import { FAMILIES, spanOk } from './projection.mjs';
import { randomId } from './ids.mjs';

export const ROLLUP_LIMITS = Object.freeze({cells: 10000, spans: 200, suppressed: 1000, ready: 5000, stages: 12, recentKeys: 4000, spanMaxMs: 48 * 3600000, extraExemplarsPerHour: 5, exemplarKeys: 2000});
const HOUR = 3600000, DAY = 86400000;

const periodOf = (unit, ms) => new Date(ms).toISOString().slice(0, unit === 'hour' ? 13 : 10);
const periodEnd = period => (period.length === 13 ? Date.parse(period + ':00:00Z') + HOUR : Date.parse(period + 'T00:00:00Z') + DAY);

/** `onSelf(reason, entry, n)` reports n (default 1) of what rollup had to drop. `identity()` is consent's current {epoch, session}. */
export function createRollup({now = Date.now, identity, bytes, onSelf = () => {}}) {
  let cells = new Map(), spans = new Map(), ready = [];
  let recent = [], recentSet = new Set(), ever = new Set(), suppressed = new Map(), refusedUntil = 0; // key -> when the mark expires (a job's span ends within 48 h); refusedUntil: no job capture until then
  let exemplars = {epoch: null, seen: new Set(), hours: new Map()};
  let installedAt = now(), seq = 0, dirty = false;
  const touch = () => { dirty = true; };

  // ---- dedupe, once-ever flags --------------------------------------------------------------------------------
  function firstTime(key) {
    if (recentSet.has(key)) return false;
    recentSet.add(key); recent.push(key);
    if (recent.length > ROLLUP_LIMITS.recentKeys) recentSet.delete(recent.shift());
    touch();
    return true;
  }

  // ---- counts -------------------------------------------------------------------------------------------------
  function cellFor(obs, view, shape) {
    const entry = CATALOG.entries[obs.name];
    if (!entry || entry.stream !== 'counts' || !view.streams.includes('counts')) return null;
    const period = obs.period ?? periodOf(entry.period, now());
    const origin = obs.origin && obs.origin !== 'app' ? obs.origin : undefined;
    const key = obs.name + '|' + period + '|' + canonicalJson(obs.attrs) + '|' + (origin ?? '');
    let cell = cells.get(key);
    if (!cell) {
      if (cells.size >= ROLLUP_LIMITS.cells && obs.name !== 'telemetry.self') { onSelf('rollup_full', obs.name); return null; }
      cell = {name: obs.name, period, attrs: obs.attrs, origin, gen: view.gen, ...shape(entry)};
      cells.set(key, cell);
    }
    touch();
    return cell;
  }
  function count(obs, view) {
    if (obs.dedupe && !(view.streams.includes('counts') && firstTime(obs.dedupe))) return;
    const cell = cellFor(obs, view, () => ({value: 0}));
    if (cell) cell.value += obs.n ?? 1;
  }
  function hist(obs, view) {
    if (obs.dedupe && !(view.streams.includes('counts') && firstTime(obs.dedupe))) return;
    const cell = cellFor(obs, view, entry => ({buckets: entry.buckets, counts: new Array(CATALOG.bucket_sets[entry.buckets].bounds.length + 1).fill(0)}));
    if (cell) cell.counts[bucketIndex(cell.buckets, obs.value)]++;
  }
  function milestone(obs, view) {
    if (!view.streams.includes('counts') || ever.has(obs.milestone)) return;
    ever.add(obs.milestone);
    count({op: 'count', name: 'funnel.reached', attrs: {milestone: obs.milestone, since_install: bucket('since_install', Math.max(0, (now() - installedAt) / 1000))}}, view);
  }

  // Finished records wait here for the next housekeeping pass; the wait is bounded.
  function keep(item) {
    if (ready.length >= ROLLUP_LIMITS.ready) { onSelf('rollup_full', item.record.name); return; }
    ready.push(item);
    touch();
  }

  // ---- diagnostics --------------------------------------------------------------------------------------------
  function sampled(obs) {
    const {epoch} = identity();
    if (exemplars.epoch !== epoch) exemplars = {epoch, seen: new Set(), hours: new Map()};
    if (!exemplars.seen.has(obs.sample)) {
      if (exemplars.seen.size < ROLLUP_LIMITS.exemplarKeys) exemplars.seen.add(obs.sample);
      return true; // the first of each code and component in an epoch always goes
    }
    const hour = periodOf('hour', now()), used = exemplars.hours.get(hour) ?? 0;
    if (used >= ROLLUP_LIMITS.extraExemplarsPerHour) return false;
    exemplars.hours.clear(); exemplars.hours.set(hour, used + 1);
    return true;
  }
  const hourOf = ms => periodOf('hour', ms);
  function diagnostic({name, kind, attrs, origin, hour, durationMs, status, pinned}, view) {
    const who = pinned ?? identity();
    const record = {name, kind, hour: hour ?? hourOf(now()), rid: randomId('r', bytes), epoch: who.epoch, session: who.session, seq: seq++, attrs,
      ...(origin && origin !== 'app' ? {origin} : {}),
      ...(kind === 'span' ? {duration_ms: durationMs, status, trace: who.trace ?? randomId('t', bytes)} : {})};
    keep({stream: 'diagnostics', gen: view.gen, record});
  }
  function diag(obs, view) {
    if (!view.streams.includes('diagnostics')) return;
    if (obs.sample && !sampled(obs)) return;
    diagnostic({name: obs.name, kind: obs.kind, attrs: obs.attrs, origin: obs.origin, hour: obs.hour, durationMs: obs.duration_ms, status: obs.status}, view);
  }
  function recordObs(obs, view) {
    if (!view.streams.includes('quota')) return;
    keep({stream: 'quota', gen: view.gen, record: {name: obs.name, attrs: obs.attrs}});
  }

  // ---- spans --------------------------------------------------------------------------------------------------
  function openSpan(obs, view) {
    if (spans.has(obs.key)) return spans.get(obs.key);
    if (suppressed.has(obs.key)) return null;
    // Fail closed: while the marks are full, a job that is not already open may have lost its mark, so it is not captured.
    if (obs.family === 'job.run' && now() < refusedUntil) { onSelf('rollup_full', obs.family); return null; }
    if (spans.size >= ROLLUP_LIMITS.spans) { onSelf('rollup_full', obs.family); return null; }
    const who = identity();
    const span = {family: obs.family, key: obs.key, startedAt: Number.isFinite(obs.since) ? obs.since : now(), epoch: who.epoch, session: who.session,
      trace: randomId('t', bytes), gen: view.gen, diagnostics: view.streams.includes('diagnostics'), stages: [], current: obs.stageName ? {stage: obs.stageName, at: now()} : null,
      abandon: obs.abandon ?? null};
    spans.set(obs.key, span);
    touch();
    return span;
  }
  const compactNotes = attrs => Object.fromEntries(Object.entries(attrs ?? {}).filter(([, v]) => v !== undefined));
const endStage = (span, ok) => {
    if (!span.current) return;
    if (FAMILIES[span.family]?.stages && span.stages.length < ROLLUP_LIMITS.stages) span.stages.push({stage: span.current.stage, ms: Math.max(0, Math.round(now() - span.current.at)), ok});
    span.current = null;
  };
  function span(obs, view) {
    if (obs.step === 'discard') { spans.delete(obs.key); touch(); return; }
    if (obs.step === 'open') { openSpan(obs, view); return; }
    const current = spans.get(obs.key) ?? openSpan({...obs, step: 'open'}, view);
    if (obs.step === 'note') {
      if (current) { current.notes = {...current.notes, ...compactNotes(obs.attrs)}; touch(); }
      return;
    }
    if (obs.step === 'stage') {
      if (!current) return;
      endStage(current, true);
      current.current = {stage: obs.stage, at: now()};
      touch();
      return;
    }
    if (obs.step === 'close') closeSpan(current, obs, view);
  }
  function closeSpan(current, obs, view) {
    if (suppressed.delete(obs.key)) { spans.delete(obs.key); touch(); return; }
    // Fail closed here too: with the marks full, a job that is not open may be one whose mark was refused.
    if (!current && obs.family === 'job.run' && now() < refusedUntil) { onSelf('rollup_full', obs.family); return; }
    const ok = obs.failed === undefined ? spanOk(obs.attrs) : !obs.failed;
    if (current) endStage(current, ok);
    const stagesNames = new Set(current?.stages.map(s => s.stage));
    const stages = [...(current?.stages ?? [])];
    if (Number.isFinite(obs.ranFrom) && !stagesNames.has('run') && FAMILIES[obs.family]?.stages === 'job_stage') stages.push({stage: 'run', ms: Math.max(0, Math.round(now() - obs.ranFrom)), ok});
    const startedAt = current?.startedAt ?? (Number.isFinite(obs.since) ? obs.since : now());
    const durationMs = Math.max(0, Math.round(now() - startedAt));
    const family = FAMILIES[obs.family];
    const attrs = {...current?.notes, ...obs.attrs, ...(family?.stages && stages.length ? {stages: stages.slice(0, 12)} : {})};
    spans.delete(obs.key);
    touch();
    for (const derived of family?.derive({attrs, durationMs, stages: stages.slice(0, 12)}) ?? []) observe(derived, view);
    // A diagnostic needs diagnostics allowed now, and the generation it was opened under.
    if (view.streams.includes('diagnostics') && current?.diagnostics !== false && (current?.gen ?? view.gen) === view.gen) {
      diagnostic({name: obs.family, kind: 'span', attrs, hour: hourOf(startedAt), durationMs, status: ok ? 'ok' : 'error',
        pinned: current ? {epoch: current.epoch, session: current.session, trace: current.trace} : undefined}, view);
    }
  }

  function observe(obs, view) {
    switch (obs.op) {
      case 'count': return count(obs, view);
      case 'hist': return hist(obs, view);
      case 'milestone': return milestone(obs, view);
      case 'diag': return diag(obs, view);
      case 'record': return recordObs(obs, view);
      case 'span': return span(obs, view);
      case 'suppress':
        // Marks expire with the job's longest span. When one cannot be stored, the job it was for is unknown: nothing about
        // jobs is captured for as long as such a job could still be open, whatever happens to the marks meanwhile.
        spans.delete(obs.key);
        if (suppressed.size < ROLLUP_LIMITS.suppressed) suppressed.set(obs.key, now() + ROLLUP_LIMITS.spanMaxMs);
        else { refusedUntil = now() + ROLLUP_LIMITS.spanMaxMs; onSelf('rollup_full', 'none'); }
        touch();
        return undefined;
      default: return undefined;
    }
  }

  // ---- finished records ---------------------------------------------------------------------------------------
  // A cell carries at most the entry's `maxPerPeriod` (one record's cap, see TELEMETRY-WIRE.md §6): more saturates there.
  // A batch may not hold two records for one cell, so the excess cannot ride in a second record: it is self-reported.
  function cellRecord(cell) {
    const max = CATALOG.entries[cell.name].maxPerPeriod;
    const base = {name: cell.name, period: cell.period, attrs: cell.attrs, ...(cell.origin ? {origin: cell.origin} : {})};
    if (!cell.counts) { if (cell.value > max) onSelf('rollup_full', cell.name, cell.value - max); return {...base, value: Math.min(cell.value, max)}; }
    const total = cell.counts.reduce((sum, n) => sum + n, 0);
    return {...base, buckets: cell.buckets, counts: total <= max ? cell.counts : saturate(cell.counts, total, max)};
  }
  /** Scale a histogram down to at most `max` samples, keeping every non-empty bin at 1 or more. */
  function saturate(counts, total, max) {
    const scaled = counts.map(n => (n ? Math.max(1, Math.floor(n * max / total)) : 0));
    for (let sum = scaled.reduce((a, n) => a + n, 0); sum > max; sum--) scaled[scaled.indexOf(Math.max(...scaled))]--;
    return scaled;
  }
  function drain(view, {all}) {
    const t = now();
    for (const [key, expires] of suppressed) if (expires <= t) { suppressed.delete(key); touch(); }
    for (const current of [...spans.values()]) {
      if (t - current.startedAt < ROLLUP_LIMITS.spanMaxMs) continue;
      if (current.abandon) closeSpan(current, {family: current.family, key: current.key, step: 'close', attrs: current.abandon, failed: true}, view);
      else { spans.delete(current.key); touch(); }
    }
    for (const [key, cell] of cells) {
      if (!all && periodEnd(cell.period) > t) continue;
      cells.delete(key);
      touch();
      if (cell.gen === view.gen && view.streams.includes('counts')) ready.push({stream: 'counts', gen: cell.gen, record: cellRecord(cell)});
    }
    const out = ready;
    ready = [];
    return out.filter(item => item.gen === view.gen && view.streams.includes(item.stream));
  }

  return {
    observe,
    jobAllowed: key => !suppressed.has(key) && now()>=refusedUntil,
    /** Privacy restrictions merge independently of report generations and never disappear in a report reset. */
    restorePrivacy(state) {
      refusedUntil=Math.max(refusedUntil,state.refusedUntil);
      if(now()<refusedUntil)for(const [key,span] of spans)if(span.family==='job.run')spans.delete(key);
      for(const [key,expiry] of state.suppressed) {
        if(expiry<=now())continue;
        if(suppressed.has(key)||suppressed.size<ROLLUP_LIMITS.suppressed)suppressed.set(key,Math.max(suppressed.get(key)??0,expiry));
        else refusedUntil=Math.max(refusedUntil,expiry);
        spans.delete(key);
      }
    },
    /** Records whose period ended, spans past 48 h, and diagnostics waiting: removed from rollup and returned. */
    closeDue: view => drain(view, {all: false}),
    /** The same, and the open periods too (shutdown). A later cell adds into the same server row. */
    flush: view => drain(view, {all: true}),
    /** The consent transition: state of `fromGen` in streams both consents allow moves to `gen`; the rest is dropped. */
    carry({fromGen, gen, streams}) {
      for (const [key, cell] of cells) {
        if (cell.gen === fromGen && streams.includes('counts')) cell.gen = gen; else cells.delete(key);
      }
      ready = ready.filter(item => item.gen === fromGen && streams.includes(item.stream)).map(item => ({...item, gen}));
      touch();
    },
    /** Drop the cells and ready records with these names: the allowance totals, once their choice is withdrawn. */
    dropNamed(names) {
      for (const [key, cell] of cells) if (names.includes(cell.name)) cells.delete(key);
      ready = ready.filter(item => !names.includes(item.record.name));
      touch();
    },
    /** Clear report state. A remote stop retains request privacy restrictions, including overflow refusal. */
    reset({keepSpans = false,keepSuppressions = false} = {}) {
      cells = new Map(); ready = []; if(!keepSuppressions){suppressed = new Map(); refusedUntil = 0;} exemplars = {epoch: null, seen: new Set(), hours: new Map()};
      if (!keepSpans) spans = new Map();
      touch();
    },
    /** Put finished records back when they could not be handed on, so the next pass offers them again. */
    restoreReady(items) {
      ready = [...items, ...ready];
      // Bounded like every other queue here: past the cap the oldest go, and it is counted.
      for (const lost of ready.splice(0, Math.max(0, ready.length - ROLLUP_LIMITS.ready))) onSelf('rollup_full', lost.record.name);
      touch();
    },
    installedAt: () => installedAt,
    stats: () => ({cells: cells.size, spans: spans.size, ready: ready.length}),
    isDirty: () => dirty,
    /** Call after the snapshot reached the disk: until then the state counts as unsaved. */
    markClean() { dirty = false; },
    snapshot() {
      return {version: 1, installedAt, seq, refusedUntil, ever: [...ever], recent, suppressed: [...suppressed],
        cells: [...cells.values()], spans: [...spans.values()].map(s => ({...s, current: s.current})), exemplars: {epoch: exemplars.epoch, seen: [...exemplars.seen]}};
    },
    /** Counters come back only under the generation they were captured in; spans keep their own stamp. */
    restore(state, {gen}) {
      if (!state || state.version !== 1) return;
      installedAt = Number.isFinite(state.installedAt) ? state.installedAt : installedAt;
      refusedUntil = Number.isFinite(state.refusedUntil) ? state.refusedUntil : 0;
      seq = Number.isSafeInteger(state.seq) ? state.seq : 0;
      ever = new Set(state.ever ?? []); recent = [...(state.recent ?? [])]; recentSet = new Set(recent); suppressed = new Map((state.suppressed ?? []).map(entry => (Array.isArray(entry) ? entry : [entry, now() + ROLLUP_LIMITS.spanMaxMs])));
      cells = new Map((state.cells ?? []).filter(c => c.gen === gen).map(c => [c.name + '|' + c.period + '|' + canonicalJson(c.attrs) + '|' + (c.origin ?? ''), c]));
      spans = new Map((state.spans ?? []).map(s => [s.key, s]));
      exemplars = {epoch: state.exemplars?.epoch ?? null, seen: new Set(state.exemplars?.seen ?? []), hours: new Map()};
    },
  };
}
