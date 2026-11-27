import './helpers/no-browser.mjs';
import {settleAdapterAtBound} from './helpers/lending-settle-at-bound.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {createEstimatedPace50State} from '../lib/v1/lending-policy.mjs';
import {ACCOUNT, HOUR_MS, NOW, WEEK, ordinaryInput, quietInput, request} from './helpers/pace50-fixtures.mjs';

const fault = (code) => Object.assign(new Error(`injected ${code}`), {code});
const fsyncDirectory = (directory) => {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

// A store in a fresh directory. Handlers record every provider-facing call in order.
function rig(t, {quiet = false, effects = {}, open = {}} = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pace50-adapter-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const clock = {at: NOW};
  const calls = [];
  const handlers = {
    arm_cessation_deadline: async (effect) => {
      calls.push(['arm', effect.attempt_id, effect.resource_id]);
      return () => calls.push(['disarm', effect.attempt_id, effect.resource_id]);
    },
    launch_chunk: async (effect) => { calls.push(['launch', effect.attempt_id]); },
    open_short_window: async (effect) => { calls.push(['open', effect.attempt_id]); },
    cancel_pending_attempt: async (effect) => { calls.push(['cancel', effect.attempt_id]); },
    request_cessation: async (effect) => { calls.push(['cessation', effect.attempt_id, effect.effect_id]); },
    request_fresh_complete_reconciliation: async (effect) => { calls.push(['reconcile', effect.attempt_id]); },
    ...effects,
  };
  const defaultInput = quiet ? async ({state, now}) => quietInput({now, state}) : async ({now}) => ordinaryInput({now});
  const build = (overrides = {}) => createPace50Adapter({postingLagBoundMs:120000,directory, account: ACCOUNT, account_week_id: WEEK,
    buildInput: defaultInput, effects: handlers, now: () => clock.at, ...open, ...overrides});
  const file = join(directory, 'lending-pace50-state.json');
  return {directory, file, calls, clock, adapter: build(), open: build,
    disk: () => JSON.parse(fs.readFileSync(file, 'utf8'))};
}

test('a required handler missing at construction is refused, and the lock is released', (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pace50-adapter-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const handlers = {
    arm_cessation_deadline: async () => () => {},
    launch_chunk: async () => {},
    open_short_window: async () => {},
    cancel_pending_attempt: async () => {},
    request_fresh_complete_reconciliation: async () => {},
  };
  assert.throws(() => createPace50Adapter({postingLagBoundMs:120000,directory, account: ACCOUNT, account_week_id: WEEK,
    buildInput: async () => ({}), effects: handlers}), {code: 'pace50_handler_missing'});
  const complete = {...handlers, request_cessation: async () => {}};
  const adapter = createPace50Adapter({postingLagBoundMs:120000,directory, account: ACCOUNT, account_week_id: WEEK,
    buildInput: async () => ({}), effects: complete});
  return adapter.close();
});

// Fence regression (review of f43b2699): an On-class event queued before an admission must not clear a
// Stop or owner-return fence that was requested after the admission was queued. Admission order is FIFO.
// Startup obligation: a crash inside a launch leaves a stored reservation that never recorded a result. A restarted
// process must ask the backend to cease it, keyed by attempt so that the key survives later revisions, and must not
// launch it again or release it.
// A fake process reports its start from inside the launch callback. Awaiting the queue there would deadlock, so the
// observation is queued behind the launch and applied, in order, after it returns.
// A persisted state with one attempt whose quiet opening is still unconfirmed. The store validates it on open. Quiet admission cannot
// create one at this base, so the state is written directly: the opening token is consumed by the attempt, and the opening's window is
// the attempt's short resource.
const DAY_MS = 24 * HOUR_MS;
function openingState() {
  const weekly = {id: 'weekly', instance: 'weekly-1', epoch: 'epoch-1', kind: 'weekly', anchor_at: NOW - DAY_MS,
    resets_at: NOW + 6 * DAY_MS, duration_ms: 7 * DAY_MS, baseline_used_micro: 20000000, kappa_micro: 50000,
    aggregate_observed_at: NOW - 1000, aggregate_used_micro: 20000000, initial_micro: 15000000, spent_micro: 0, settled_micro: 0,
    held_micro: 15000000, released_micro: 0, unrepresented_micro: 0, burns: []};
  const short = {id: 'short', instance: 'short-quiet-1', epoch: 'epoch-1', kind: 'short', anchor_at: NOW, resets_at: NOW + 5 * HOUR_MS,
    duration_ms: 5 * HOUR_MS, baseline_used_micro: 0, kappa_micro: 200000, aggregate_observed_at: NOW, aggregate_used_micro: 0,
    initial_micro: 60000000, spent_micro: 0, settled_micro: 0, held_micro: 60000000, released_micro: 0, unrepresented_micro: 0, burns: []};
  const attempt = {id: 'attempt-1', account: ACCOUNT, account_week_id: WEEK, epoch: 'epoch-1', job_id: 'job-1', created_at: NOW,
    wall_ms: 300000, stop_ms: 60000, uncertainty_ms: 0, launch_state: 'reserved', process_state: 'not_started',
    cessation_proven: false, cleanup_proven: false, late_ack_unresolved: false, late_ack_events: [], usage_unknown: null,
    opening: {resource_id: 'short', instance: 'short-quiet-1', anchor_at: NOW, resets_at: NOW + 5 * HOUR_MS, account_week_id: WEEK,
      confirmed: false},
    recoveries: [], resources: [weekly, short]};
  return {...createEstimatedPace50State({account: ACCOUNT, account_week_id: WEEK}), revision: 2, updated_at: NOW,
    event_ids: ['seed-admit-1', 'seed-absent-0'], opening_tokens: [{account_week_id: WEEK, status: 'consumed', attempt_id: 'attempt-1'}],
    opened_windows: [], attempts: [attempt]};
}
async function openingRig(t) {
  const r = rig(t, {quiet: true});
  await r.adapter.close();
  fs.writeFileSync(r.file, JSON.stringify(openingState()));
  r.adapter = r.open();
  return r;
}

// The sandbox can be proven gone before its quiet window confirms. The process is gone, so the late confirmation records the window
// and nothing else: it must not launch, cancel or reopen the process.
// The same removed process: a no-open proof is still valid evidence. It releases the opening token and changes nothing else.
test('a sandbox removed before its quiet window confirms can still release the opening token on a no-open proof', async (t) => {
  const r = await openingRig(t);
  await r.adapter.transition({type: 'cleanup_proven', event_id: 'attempt-1:cleanup-proven:3', at: NOW + 1, attempt_id: 'attempt-1',
    cleanup_removed: true}, {expectedRevision: 2});
  const released = await r.adapter.transition({type: 'opening_not_occurred', event_id: 'no-open-1', at: NOW + 2, attempt_id: 'attempt-1',
    authoritative_not_open: true, account: ACCOUNT, account_week_id: WEEK, epoch: 'epoch-1', resource_id: 'short',
    instance: 'short-quiet-1', window_state: 'not_open', anchor_at: NOW, resets_at: NOW + 5 * HOUR_MS, observed_at: NOW + 2},
  {expectedRevision: 3});
  assert.equal(released.applied, true, JSON.stringify(released));
  assert.equal(r.adapter.state().opening_tokens[0].status, 'unused', 'the no-open proof releases the token');
  assert.equal(r.adapter.state().attempts[0].process_state, 'ceased', 'the removed process stays ceased');
  await r.adapter.close();
});

for (const newWeek of [false, true]) {
  test(`deferred headroom refuses preview and admission without writes (new week: ${newWeek})`, async t => {
    const r = rig(t, {open: {buildInput: async ({now}) => {
      const input = ordinaryInput({now});
      return {...input, account_week_id: newWeek ? `${ACCOUNT}:weekly:${input.windows.find(w => w.kind === 'weekly').resets_at}` : WEEK,
        admission_headroom_failure: 'budget_too_small'};
    }}});
    try {
      const before = r.adapter.state();
      const diskBefore = fs.existsSync(r.file) ? fs.readFileSync(r.file, 'utf8') : null;
      for (const method of ['preview', 'admit']) {
        const out = await r.adapter[method]({expectedRevision: before.revision, request: request()});
        assert.equal(out.admitted, false);
        assert.equal(out.reason, 'budget_too_small');
        assert.equal(out.revision, before.revision);
        assert.deepEqual(r.adapter.state(), before);
        assert.equal(fs.existsSync(r.file) ? fs.readFileSync(r.file, 'utf8') : null, diskBefore);
        assert.deepEqual(r.calls, []);
      }
    } finally { await r.adapter.close(); }
  });
}
