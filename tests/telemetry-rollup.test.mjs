import './helpers/no-browser.mjs';
// Rollup: aggregation, spans, flags, exemplars, dedupe and its memory bounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRollup, ROLLUP_LIMITS } from '../lib/v1/telemetry/rollup.mjs';
import { seededBytes } from './helpers/telemetry-harness.mjs';

const VIEW = {gen: 1, streams: ['counts', 'diagnostics', 'quota']};
const HOUR = 3600000, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 21, 19, 5);
function make({view = VIEW} = {}) {
  let t = T0;
  const self = [];
  const rollup = createRollup({now: () => t, identity: () => ({epoch: 'e-' + 'A'.repeat(20), session: 's-' + 'A'.repeat(20)}), bytes: seededBytes(3), onSelf: (reason, entry) => self.push([reason, entry])});
  return {rollup, self, view, set: ms => { t = ms; }, advance: ms => { t += ms; }, drain: (v = view) => rollup.closeDue(v)};
}
const count = (attrs, extra = {}) => ({op: 'count', name: 'problem.count', attrs, ...extra});
const problem = {'error.type': 'sandbox_start_failed', 'problem.registry': 'failure', component: 'lender', phase: 'prepare', outcome: 'requeue', surface: 'background'};

test('counts add up in one cell per period and leave only when the period has ended', () => {
  const r = make();
  for (let i = 0; i < 5; i++) r.rollup.observe(count(problem), VIEW);
  r.rollup.observe(count({...problem, phase: 'run'}), VIEW);
  assert.deepEqual(r.drain(), [], 'the hour is still open');
  r.set(Date.UTC(2026, 9, 21, 20, 0, 1));
  const out = r.drain();
  assert.deepEqual(out.map(i => [i.stream, i.record.value, i.record.attrs.phase]).sort(), [['counts', 1, 'run'], ['counts', 5, 'prepare']]);
  assert.deepEqual(r.drain(), [], 'drained once');
});

test('a histogram bins by the catalog bounds, with an overflow bin', () => {
  const r = make();
  for (const seconds of [0.2, 3, 3, 400, 90000]) r.rollup.observe({op: 'hist', name: 'job.duration', attrs: {'job.role': 'lender', outcome: 'finished'}, value: seconds}, VIEW);
  r.set(T0 + 2 * DAY);
  const [item] = r.drain();
  assert.equal(item.record.buckets, 'duration_s');
  assert.deepEqual(item.record.counts, [1, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
});

test('capture follows consent: nothing is made in a stream the view does not allow', () => {
  const r = make();
  const countsOnly = {gen: 1, streams: ['counts', 'quota']};
  r.rollup.observe({op: 'diag', name: 'problem.observed.readiness', kind: 'event', attrs: problem, sample: 'k'}, countsOnly);
  r.rollup.observe({op: 'record', name: 'quota.week', attrs: {}}, {gen: 1, streams: []});
  r.rollup.observe(count(problem), {gen: 1, streams: []});
  r.set(T0 + 2 * DAY);
  assert.deepEqual(r.drain(countsOnly), []);
});

test('a span keeps the stages it passed, derives its counts, and a diagnostic only under the generation it opened in', () => {
  const r = make();
  const open = {op: 'span', family: 'job.run', key: 'lender:codex:0', step: 'open', stageName: 'prepare', abandon: {'job.role': 'lender', outcome: 'abandoned'}};
  r.rollup.observe(open, VIEW);
  r.advance(40000);
  r.rollup.observe({op: 'span', family: 'job.run', key: 'lender:codex:0', step: 'stage', stage: 'run'}, VIEW);
  r.advance(100000);
  r.rollup.observe({op: 'span', family: 'job.run', key: 'lender:codex:0', step: 'close', attrs: {'job.role': 'lender', outcome: 'finished', harness: 'codex'}}, VIEW);
  const out = r.drain();
  const run = out.find(i => i.record.name === 'job.run').record;
  assert.equal(run.duration_ms, 140000);
  assert.deepEqual(run.attrs.stages, [{stage: 'prepare', ms: 40000, ok: true}, {stage: 'run', ms: 100000, ok: true}]);
  // The same span, opened under generation 1 and closed under generation 2, yields counts but no diagnostic.
  const q = make();
  q.rollup.observe(open, VIEW);
  const later = {gen: 2, streams: VIEW.streams};
  q.rollup.observe({op: 'span', family: 'job.run', key: 'lender:codex:0', step: 'close', attrs: {'job.role': 'lender', outcome: 'finished', harness: 'codex'}}, later);
  q.set(T0 + 2 * DAY);
  const names = q.drain(later).map(i => i.record.name);
  assert.ok(!names.includes('job.run') && names.includes('job.outcome.count'));
});

test('a span open for 48 hours closes as abandoned, and its counts follow', () => {
  const r = make();
  r.rollup.observe({op: 'span', family: 'job.run', key: 'borrower:x', step: 'open', stageName: 'waiting', abandon: {'job.role': 'borrower', outcome: 'abandoned'}}, VIEW);
  r.advance(47 * HOUR);
  assert.equal(r.drain().some(i => i.record.name === 'job.run'), false);
  r.advance(2 * HOUR);
  const out = r.drain();
  const run = out.find(i => i.record.name === 'job.run');
  assert.equal(run.record.attrs.outcome, 'abandoned');
  assert.equal(run.record.status, 'error');
  assert.equal(r.rollup.stats().spans, 0);
});

test('a span survives a restart through snapshot and restore', () => {
  const a = make();
  a.rollup.observe({op: 'span', family: 'signin.run', key: 'signin:f', step: 'open', abandon: {harness: 'codex', outcome: 'timed_out'}}, VIEW);
  a.rollup.observe(count(problem), VIEW);
  const state = JSON.parse(JSON.stringify(a.rollup.snapshot()));
  const b = make();
  b.rollup.restore(state, {gen: 1});
  assert.deepEqual(b.rollup.stats(), {cells: 1, spans: 1, ready: 0});
  b.advance(60000);
  b.rollup.observe({op: 'span', family: 'signin.run', key: 'signin:f', step: 'close', attrs: {harness: 'codex', outcome: 'complete'}}, VIEW);
  assert.ok(b.drain().some(i => i.record.name === 'signin.run' && i.record.duration_ms >= 60000));
  // Counters come back only under the generation they were captured in.
  const c = make();
  c.rollup.restore(state, {gen: 2});
  assert.equal(c.rollup.stats().cells, 0);
});

test('a milestone is reported once per install lifetime, across restarts, and only when counts are allowed', () => {
  const a = make();
  a.rollup.observe({op: 'milestone', milestone: 'docker_ready'}, {gen: 1, streams: []});
  a.rollup.observe({op: 'milestone', milestone: 'docker_ready'}, VIEW);
  a.rollup.observe({op: 'milestone', milestone: 'docker_ready'}, VIEW);
  a.set(T0 + 2 * DAY);
  const out = a.drain().filter(i => i.record.name === 'funnel.reached');
  assert.equal(out.length, 1);
  assert.equal(out[0].record.value, 1);
  const b = make();
  b.rollup.restore(JSON.parse(JSON.stringify(a.rollup.snapshot())), {gen: 1});
  b.rollup.observe({op: 'milestone', milestone: 'docker_ready'}, VIEW);
  b.set(T0 + 2 * DAY);
  assert.equal(b.drain().filter(i => i.record.name === 'funnel.reached').length, 0);
});

test('a dedupe key counts once, hourly health once per hour, and a borrower request once however often it is seen', () => {
  const r = make();
  for (let i = 0; i < 100; i++) r.rollup.observe(count({check: 'event_history_durable', state: 'degraded'}, {name: 'health.state', dedupe: 'health:event_history_durable:2026-10-21T19'}), VIEW);
  const request = digest => ({op: 'count', name: 'lending.request.outcome', attrs: {outcome: 'claimed', harness: 'codex', deadline: '60', 'source.kind': 'git'}, dedupe: 'request:' + digest});
  for (let i = 0; i < 50; i++) r.rollup.observe(request('d1'), VIEW);
  r.rollup.observe(request('d2'), VIEW);
  r.set(T0 + 2 * DAY);
  const records = r.drain().map(i => i.record);
  assert.equal(records.find(x => x.name === 'health.state').value, 1);
  assert.equal(records.find(x => x.name === 'lending.request.outcome').value, 2);
});

test('exemplars: the first per code and component in an epoch always go, then at most five an hour', () => {
  const r = make();
  const diag = key => ({op: 'diag', name: 'problem.observed.readiness', kind: 'event', attrs: problem, sample: key});
  for (let i = 0; i < 30; i++) r.rollup.observe(diag('a'), VIEW);
  const first = r.drain().length;
  assert.equal(first, 1 + 5, 'one first, five more');
  r.rollup.observe(diag('b'), VIEW);
  assert.equal(r.drain().length, 1, 'a new code goes even when the hour is spent');
  r.advance(HOUR);
  for (let i = 0; i < 30; i++) r.rollup.observe(diag('a'), VIEW);
  assert.equal(r.drain().length, 5, 'the next hour allows five more');
});

test('request-scoped suppression drops the lifecycle of a job until its span closes', () => {
  const r = make();
  r.rollup.observe({op: 'suppress', key: 'borrower:x'}, VIEW);
  r.rollup.observe({op: 'span', family: 'job.run', key: 'borrower:x', step: 'open', abandon: {'job.role': 'borrower', outcome: 'abandoned'}}, VIEW);
  r.rollup.observe({op: 'span', family: 'job.run', key: 'borrower:x', step: 'close', attrs: {'job.role': 'borrower', outcome: 'finished'}}, VIEW);
  r.set(T0 + 2 * DAY);
  assert.deepEqual(r.drain().map(i => i.record.name), []);
  // The mark is spent: the same key later behaves normally.
  r.rollup.observe({op: 'span', family: 'job.run', key: 'borrower:x', step: 'close', attrs: {'job.role': 'borrower', outcome: 'finished'}}, VIEW);
  r.advance(2 * DAY);
  assert.ok(r.drain().some(i => i.record.name === 'job.outcome.count'));
});

test('memory is bounded: cells, spans and suppressed keys stop at their caps and the overflow is counted', () => {
  const r = make();
  // Distinct cells (rollup does not validate attributes: the outbox does).
  for (let i = 0; i < ROLLUP_LIMITS.cells + 50; i++) r.rollup.observe({op: 'count', name: 'op.count', attrs: {op: 'op' + i, surface: 'cli', ok: true}}, VIEW);
  assert.equal(r.rollup.stats().cells, ROLLUP_LIMITS.cells);
  for (let i = 0; i < ROLLUP_LIMITS.spans + 20; i++) r.rollup.observe({op: 'span', family: 'job.run', key: 'k' + i, step: 'open'}, VIEW);
  assert.equal(r.rollup.stats().spans, ROLLUP_LIMITS.spans);
  for (let i = 0; i < ROLLUP_LIMITS.suppressed + 20; i++) r.rollup.observe({op: 'suppress', key: 's' + i}, VIEW);
  assert.ok(r.self.filter(([reason]) => reason === 'rollup_full').length >= 70);
});
