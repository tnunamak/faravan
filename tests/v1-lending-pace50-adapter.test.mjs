import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {createEstimatedPace50State} from '../lib/v1/lending-policy.mjs';
import {meterProvider} from '../lib/v1/quota-registry.mjs';
import {ACCOUNT, HOUR_MS, NOW, WEEK, ordinaryInput, quietInput, request} from './helpers/pace50-fixtures.mjs';

const fault = (code) => Object.assign(new Error(`injected ${code}`), {code});
const fsyncDirectory = (directory) => {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

// A store in a fresh directory. Handlers record every provider-facing call in order.
function rig(t, {quiet = false, effects = {}, open = {}, perJobPct} = {}) {
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
  const defaultInput = async ({state,now}) => {
    const input=quiet?quietInput({now,state}):ordinaryInput({now});
    if(perJobPct!==undefined)input.objective.strategyParams={perJobPct};
    return input;
  };
  const build = (overrides = {}) => createPace50Adapter({directory, account: ACCOUNT, account_week_id: WEEK,
    buildInput: defaultInput, effects: handlers, now: () => clock.at, ...open, ...overrides});
  const file = join(directory, 'lending-pace50-state.json');
  return {directory, file, calls, clock, adapter: build(), open: build,
    disk: () => JSON.parse(fs.readFileSync(file, 'utf8'))};
}

test('admission persists the reservation before any launch and reports stable ordered effects', async (t) => {
  const seenRevisions = [];
  const r = rig(t, {effects: {launch_chunk: async (effect) => {
    seenRevisions.push(r.disk().revision);
    r.calls.push(['launch', effect.attempt_id]);
  }}});
  const out = await r.adapter.admit({expectedRevision: 0, request: request()});
  assert.equal(out.admitted, true);
  assert.equal(out.effects_dispatched, true);
  assert.deepEqual(out.effects.map((e) => [e.type, e.effect_id, e.status]), [
    ['arm_cessation_deadline', 'r1.0', 'dispatched'],
    ['arm_cessation_deadline', 'r1.1', 'dispatched'],
    ['launch_chunk', 'r1.2', 'dispatched'],
  ]);
  assert.deepEqual(seenRevisions, [1], 'the launch handler saw the persisted revision, not the old one');
  assert.deepEqual(r.calls, [['arm', 'attempt-1', 'weekly'], ['arm', 'attempt-1', 'short'], ['launch', 'attempt-1']]);
  assert.equal(r.adapter.state().revision, 1);
  assert.equal(r.disk().attempts[0].id, 'attempt-1');
});

test('two admissions at one revision: one persists and launches, the other is a revision conflict', async (t) => {
  const r = rig(t);
  const [first, second] = await Promise.all([
    r.adapter.admit({expectedRevision: 0, request: request()}),
    r.adapter.admit({expectedRevision: 0, request: request({attempt_id: 'attempt-2'})}),
  ]);
  assert.equal(first.admitted, true);
  assert.equal(second.admitted, false);
  assert.equal(second.reason, 'revision_conflict');
  assert.equal(r.calls.filter((c) => c[0] === 'launch').length, 1);
  assert.equal(r.adapter.state().revision, 1);
  assert.deepEqual(r.adapter.state().attempts.map((a) => a.id), ['attempt-1']);
});

test('a second owner of the same store is refused while the first is open', async (t) => {
  const r = rig(t);
  assert.throws(() => r.open(), {code: 'lock_busy'});
  await r.adapter.close();
  const again = r.open();
  await again.close();
});

test('an fsync failure before rename dispatches nothing, keeps the old revision, and poisons the open instance', async (t) => {
  let failing = false;
  const r = rig(t, {open: {io: {fsyncSync: (fd) => {
    if (failing) throw fault('EIO');
    return fs.fsyncSync(fd);
  }}}});
  failing = true;
  await assert.rejects(r.adapter.admit({expectedRevision: 0, request: request()}), {code: 'pace50_persist_failed'});
  assert.deepEqual(r.calls, []);
  assert.equal(r.disk().revision, 0);
  assert.deepEqual(fs.readdirSync(r.directory).filter((n) => n.endsWith('.tmp')), []);
  await assert.rejects(r.adapter.admit({expectedRevision: 0, request: request()}), {code: 'pace50_store_poisoned'});
  await r.adapter.close();
  failing = false;
  const reopened = r.open();
  assert.equal(reopened.state().revision, 0);
  assert.deepEqual(reopened.state().attempts, []);
  await reopened.close();
});

test('a rename failure dispatches nothing and leaves no temporary file behind', async (t) => {
  let failing = false;
  const r = rig(t, {open: {io: {renameSync: (from, to) => {
    if (failing) throw fault('EXDEV');
    return fs.renameSync(from, to);
  }}}});
  failing = true;
  await assert.rejects(r.adapter.admit({expectedRevision: 0, request: request()}), {code: 'pace50_persist_failed'});
  assert.deepEqual(r.calls, []);
  assert.equal(r.disk().revision, 0);
  assert.deepEqual(fs.readdirSync(r.directory).filter((n) => n.endsWith('.tmp')), []);
  await r.adapter.close();
});

test('a directory-sync failure after rename keeps its held budget after restart', async (t) => {
  let failing = false;
  const r = rig(t, {perJobPct:100,open: {io: {fsyncDirectory: (directory) => {
    if (failing) throw fault('EIO');
    return fsyncDirectory(directory);
  }}}});
  failing = true;
  await assert.rejects(r.adapter.admit({expectedRevision: 0, request: request()}), {code: 'pace50_persist_failed'});
  assert.deepEqual(r.calls, [], 'no arm or launch after an unconfirmed persist');
  await r.adapter.close();
  failing = false;
  // The rename happened, so the reservation is the durable truth now.
  assert.equal(r.disk().revision, 1);
  assert.equal(r.disk().attempts[0].launch_state, 'reserved');
  const restarted = r.open();
  // The durable reservation is charged against this fixture's exhausted short-window capacity.
  const second = await restarted.admit({expectedRevision: 1, request: request({attempt_id: 'attempt-2'})});
  assert.equal(second.admitted, false, JSON.stringify(second));
  assert.equal(second.reason, 'budget_too_small');
  assert.deepEqual(restarted.state().attempts.map((attempt) => attempt.id), ['attempt-1']);
  assert.deepEqual(r.calls.filter((c) => c[1] === 'attempt-1'), [], 'the durable reservation is never launched');
  await restarted.close();
});

test('a failed launch keeps the reservation and token, is not retried, and consumes available budget', async (t) => {
  const launchedAttempts = [];
  const r = rig(t, {perJobPct:100,effects: {launch_chunk: async (effect) => {
    launchedAttempts.push(effect.attempt_id);
    throw new Error('launcher refused');
  }}});
  const out = await r.adapter.admit({expectedRevision: 0, request: request()});
  assert.equal(out.admitted, true);
  assert.equal(out.effects_dispatched, false);
  assert.equal(out.effects.find((e) => e.type === 'launch_chunk').status, 'failed');
  const [attempt] = r.adapter.state().attempts;
  assert.equal(attempt.launch_state, 'reserved');
  assert.ok(attempt.resources.every((resource) => resource.held_micro > 0), 'reservation still charged');
  // Startup recovery asks for cessation of the unlaunched reservation. It never replays the launch.
  const recovered = await r.adapter.recover();
  assert.deepEqual(recovered.effects.map((e) => e.type), ['request_cessation']);
  const second = await r.adapter.admit({expectedRevision: 1, request: request({attempt_id: 'attempt-2'})});
  assert.equal(second.admitted, false, 'the held reservation exhausts this fixture budget: '+JSON.stringify(second));
  assert.equal(second.reason, 'budget_too_small');
  assert.deepEqual(launchedAttempts, ['attempt-1'], 'attempt-1 was tried once and never retried');
  await r.adapter.close();
});

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
  assert.throws(() => createPace50Adapter({directory, account: ACCOUNT, account_week_id: WEEK,
    buildInput: async () => ({}), effects: handlers}), {code: 'pace50_handler_missing'});
  const complete = {...handlers, request_cessation: async () => {}};
  const adapter = createPace50Adapter({directory, account: ACCOUNT, account_week_id: WEEK,
    buildInput: async () => ({}), effects: complete});
  return adapter.close();
});

test('invalid, aged-past-headroom, missing, and throwing evidence refuse without persisting or dispatching', async (t) => {
  const modes = {
    aged: async ({now}) => {
      const input = ordinaryInput({now});
      // The allocator must account for plausible unseen spend on every evidence path.
      input.windows.forEach(w => {
        w.used_micro = 90_000_000;
        w.observed_at = now - 31 * 60_000;
      });
      return input;
    },
    missing: async ({now}) => {
      const input = ordinaryInput({now});
      delete input.evidence;
      return input;
    },
    throws: async () => { throw new Error('source unavailable'); },
  };
  for (const [mode, buildInput] of Object.entries(modes)) {
    const r = rig(t, {open: {buildInput}});
    const out = await r.adapter.admit({expectedRevision: 0, request: request()});
    assert.equal(out.admitted, false, mode);
    assert.equal(r.calls.length, 0, mode);
    assert.equal(r.adapter.state().revision, 0, mode);
    await r.adapter.close();
  }
});

test('a caller request mutated after the call cannot change the admitted reservation', async (t) => {
  const r = rig(t);
  const req = request();
  const pending = r.adapter.admit({expectedRevision: 0, request: req});
  req.attempt_id = 'mutated';
  req.job_id = 'mutated';
  req.budget_micro = 1;
  const out = await pending;
  assert.equal(out.admitted, true);
  assert.equal(r.adapter.state().attempts[0].id, 'attempt-1');
  assert.equal(r.adapter.state().attempts[0].job_id, 'job-1');
  await r.adapter.close();
});

test('a transition event mutated after the call cannot change what is applied', async (t) => {
  const r = rig(t);
  const event = {type: 'owner_absent', event_id: 'absent-1', at: NOW - HOUR_MS, confirmed: true};
  const pending = r.adapter.transition(event, {expectedRevision: 0});
  event.event_id = 'mutated';
  event.confirmed = false;
  const out = await pending;
  assert.equal(out.applied, true);
  assert.deepEqual(r.adapter.state().event_ids, ['absent-1']);
  await r.adapter.close();
});

test('a boolean zero-use report cannot release a started attempt', async (t) => {
  const r = rig(t, {effects: {request_cessation: async (effect) => { r.calls.push(['cessation', effect.attempt_id]); }}});
  await r.adapter.admit({expectedRevision: 0, request: request()});
  const started = await r.adapter.transition({type: 'launch_result', event_id: 'started-1', at: NOW + 1,
    attempt_id: 'attempt-1', result: 'started'}, {expectedRevision: 1});
  assert.equal(started.applied, true);
  const stop = await r.adapter.transition({type: 'stop', event_id: 'stop-1', at: NOW + 2}, {expectedRevision: 2});
  assert.equal(stop.applied, true);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'cessation'), [['cessation', 'attempt-1']]);
  const heldAfterControl = r.adapter.state().attempts[0].resources.map((x) => x.held_micro);
  assert.ok(heldAfterControl.every((held) => held > 0), 'a successful cessation request is not proof');
  // No burn was recorded for this started chunk, so a proof needs affirmative zero-use evidence. Without it, nothing is released.
  const bare = {type: 'cessation_proven', event_id: 'bare-1', at: NOW + 3, attempt_id: 'attempt-1',
    authoritative_cessation: true, usage_reconciled: true};
  assert.equal((await r.adapter.transition(bare, {expectedRevision: 3})).reason, 'usage_uncovered');
  assert.ok(r.adapter.state().attempts[0].resources.every((x) => x.held_micro > 0), 'the refused proof released nothing');
  const proof = {type: 'cessation_proven', event_id: 'ceased-1', at: NOW + 3, attempt_id: 'attempt-1',
    authoritative_cessation: true, usage_reconciled: true, zero_use_attested: true};
  assert.equal((await r.adapter.transition(proof, {expectedRevision: 3})).reason, 'usage_uncovered');
  const attempt = r.adapter.state().attempts[0];
  assert.notEqual(attempt.process_state, 'ceased');
  assert.notEqual(attempt.hold_closed, true);
  assert.ok(attempt.resources.every((x) => x.held_micro > 0));
  await r.adapter.close();
});

test('cessation-type events through the adapter refuse a duplicate id and an earlier timestamp', async (t) => {
  const r = rig(t);
  await r.adapter.admit({expectedRevision: 0, request: request()});
  const proven = {type: 'cleanup_proven', event_id: 'attempt-1:cleanup-proven:1', at: NOW + 2, attempt_id: 'attempt-1', cleanup_removed: true};
  assert.equal((await r.adapter.transition(proven, {expectedRevision: r.adapter.state().revision})).applied, true);
  const afterProof = r.adapter.state();
  assert.equal((await r.adapter.transition(proven, {expectedRevision: afterProof.revision})).reason, 'duplicate_event');
  const early = {type: 'cessation_proven', event_id: 'ceased-early', at: NOW + 1, attempt_id: 'attempt-1',
    authoritative_cessation: true, usage_reconciled: true, zero_use_attested: true, absence_proven: true};
  assert.equal((await r.adapter.transition(early, {expectedRevision: afterProof.revision})).reason, 'event_order');
  assert.deepEqual(r.adapter.state(), afterProof, 'the refused events change nothing');
  const cessation = {...early, event_id: 'ceased-1', at: NOW + 3};
  assert.equal((await r.adapter.transition(cessation, {expectedRevision: afterProof.revision})).applied, true);
  assert.equal((await r.adapter.transition(cessation, {expectedRevision: r.adapter.state().revision})).reason, 'duplicate_event');
  await r.adapter.close();
});

test('Stop cancels a not-started attempt and freezes admission immediately', async (t) => {
  const r = rig(t, {effects: {launch_chunk: async () => { throw new Error('not launched'); }}});
  await r.adapter.admit({expectedRevision: 0, request: request()});
  const stop = await r.adapter.transition({type: 'stop', event_id: 'stop-1', at: NOW + 1}, {expectedRevision: 1});
  assert.equal(stop.applied, true);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'cancel'), [['cancel', 'attempt-1']]);
  assert.equal(r.adapter.state().mode, 'off');
  const refused = await r.adapter.admit({expectedRevision: 2, request: request({attempt_id: 'attempt-2'})});
  assert.equal(refused.reason, 'adapter_frozen');
  await r.adapter.close();
});

test('an admission queued while a launch is pending is refused as frozen once Stop is requested', {timeout: 5000}, async (t) => {
  let entered;
  const launchStarted = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // Without the synchronous fence, the second admission would queue behind this launch; teardown must still unblock it.
  t.after(() => release());
  const r = rig(t, {effects: {launch_chunk: async (effect) => {
    r.calls.push(['launch', effect.attempt_id]);
    entered();
    await gate;
  }}});
  const first = r.adapter.admit({expectedRevision: 0, request: request()});
  await launchStarted;
  const stop = r.adapter.transition({type: 'stop', event_id: 'stop-1', at: NOW + 1}, {expectedRevision: 1});
  const second = await r.adapter.admit({expectedRevision: 1, request: request({attempt_id: 'attempt-2'})});
  assert.equal(second.reason, 'adapter_frozen');
  release();
  assert.equal((await first).admitted, true);
  assert.equal((await stop).applied, true);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'launch').map((c) => c[1]), ['attempt-1']);
  await r.adapter.close();
});

test('an admission queued before Stop is refused with its revision when it reaches the head of the queue', {timeout: 5000}, async (t) => {
  let entered;
  const launchStarted = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const r = rig(t, {effects: {launch_chunk: async (effect) => {
    r.calls.push(['launch', effect.attempt_id]);
    entered();
    await gate;
  }}});
  const first = r.adapter.admit({expectedRevision: 0, request: request()});
  await launchStarted;
  // Not yet frozen when called, so it queues behind the running launch. Stop then arrives behind it.
  const queued = r.adapter.admit({expectedRevision: 1, request: request({attempt_id: 'attempt-2'})});
  const stop = r.adapter.transition({type: 'stop', event_id: 'stop-1', at: NOW + 1}, {expectedRevision: 1});
  release();
  assert.equal((await first).admitted, true);
  const refused = await queued;
  assert.equal(refused.admitted, false);
  assert.equal(refused.reason, 'adapter_frozen');
  assert.equal(refused.revision, 1, 'the refusal reports the durable revision it was judged against');
  assert.equal(refused.effects_dispatched, false);
  assert.equal((await stop).applied, true);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'launch').map((c) => c[1]), ['attempt-1']);
  await r.adapter.close();
});

test('a failed Stop cessation is re-sent by recover with a stable effect id, and no launch is replayed', async (t) => {
  let cessations = 0;
  const r = rig(t, {effects: {request_cessation: async (effect) => {
    cessations += 1;
    r.calls.push(['cessation', effect.attempt_id, effect.effect_id]);
    if (cessations === 1) throw new Error('transient');
  }}});
  await r.adapter.admit({expectedRevision: 0, request: request()});
  await r.adapter.transition({type: 'launch_result', event_id: 'started-1', at: NOW + 1,
    attempt_id: 'attempt-1', result: 'started'}, {expectedRevision: 1});
  const stop = await r.adapter.transition({type: 'stop', event_id: 'stop-1', at: NOW + 2}, {expectedRevision: 2});
  assert.equal(stop.effects.find((e) => e.type === 'request_cessation').status, 'failed');
  const first = await r.adapter.recover();
  assert.deepEqual(first.effects.map((e) => [e.type, e.effect_id, e.status]),
    [['request_cessation', 'recover:request_cessation:attempt-1', 'dispatched']]);
  const second = await r.adapter.recover();
  assert.equal(second.effects[0].effect_id, 'recover:request_cessation:attempt-1');
  await r.adapter.close();
  const restarted = r.open();
  const third = await restarted.recover();
  assert.equal(third.effects[0].effect_id, 'recover:request_cessation:attempt-1', 'stable across restart');
  assert.equal(r.calls.filter((c) => c[0] === 'launch').length, 1);
  await restarted.close();
});

test('quiet admission refuses an unopened short window without reserving or opening it', async (t) => {
  const r = rig(t, {quiet: true});
  await r.adapter.transition({type: 'owner_absent', event_id: 'absent-1', at: NOW - HOUR_MS, confirmed: true},
    {expectedRevision: 0});
  const refused = await r.adapter.admit({expectedRevision: 1, request: request()});
  assert.equal(refused.admitted, false);
  assert.equal(refused.reason, 'window_not_open');
  assert.equal(r.adapter.state().revision, 1, 'refusal writes no reservation');
  assert.equal(r.adapter.state().opening_tokens[0].status, 'unused');
  assert.deepEqual(r.adapter.state().attempts, []);
  assert.deepEqual(r.calls.filter((call) => call[0] === 'open'), []);
  await r.adapter.close();
});

test('a restarted opening cannot launch without this process having armed its deadline', async (t) => {
  const r = await openingRig(t);
  const confirmation = {type: 'opening_confirmed', event_id: 'opened-1', at: NOW + 1, attempt_id: 'attempt-1',
    authoritative_opened: true, account: ACCOUNT, account_week_id: WEEK, epoch: 'epoch-1', resource_id: 'short',
    instance: 'short-quiet-1', anchor_at: NOW, resets_at: NOW + 5 * HOUR_MS, observed_at: NOW + 1};
  const applied = await r.adapter.transition(confirmation, {expectedRevision: 2});
  assert.equal(applied.applied, true);
  const launch = applied.effects.find((e) => e.type === 'launch_chunk');
  assert.equal(launch.status, 'failed');
  assert.match(launch.error, /not_armed_in_process/);
  assert.equal(r.calls.filter((c) => c[0] === 'launch').length, 0);
  assert.equal(r.adapter.state().opened_windows.length, 1);
  await r.adapter.close();
});

test('the launch gate refuses at the exact deadline and allows one millisecond before it', async (t) => {
  const deadline = NOW + 1.25 * HOUR_MS;
  for (const [moveTo, expectLaunch] of [[deadline, false], [deadline - 1, true]]) {
    const r = rig(t, {effects: {arm_cessation_deadline: async (effect) => {
      r.calls.push(['arm', effect.attempt_id, effect.resource_id]);
      r.clock.at = moveTo;
      return () => {};
    }}});
    const out = await r.adapter.admit({expectedRevision: 0, request: request()});
    const launch = out.effects.find((e) => e.type === 'launch_chunk');
    assert.equal(launch.status === 'dispatched', expectLaunch, `clock at ${moveTo}`);
    if (!expectLaunch) assert.match(launch.error, /deadline_passed/);
    await r.adapter.close();
  }
});

test('a confirmed opening keeps its account-week token and resource identity after restart', async (t) => {
  const r = await openingRig(t);
  const confirmation = {type: 'opening_confirmed', event_id: 'opened-1', at: NOW + 1, attempt_id: 'attempt-1',
    authoritative_opened: true, account: ACCOUNT, account_week_id: WEEK, epoch: 'epoch-1', resource_id: 'short',
    instance: 'short-quiet-1', anchor_at: NOW, resets_at: NOW + 5 * HOUR_MS, observed_at: NOW + 1};
  assert.equal((await r.adapter.transition(confirmation, {expectedRevision: 2})).applied, true);
  const cessation = {type: 'cessation_proven', event_id: 'ceased-1', at: NOW + 2, attempt_id: 'attempt-1',
    authoritative_cessation: true, usage_reconciled: true, zero_use_attested: true};
  await r.adapter.transition({type: 'cleanup_proven', event_id: 'attempt-1:cleanup-proven:1', at: NOW + 1,
    attempt_id: 'attempt-1', cleanup_removed: true}, {expectedRevision: 3});
  assert.equal((await r.adapter.transition(cessation, {expectedRevision: 4})).applied, true);
  await r.adapter.close();
  const restarted = r.open();
  assert.deepEqual(restarted.state().opening_tokens, [{account_week_id: WEEK, status: 'consumed', attempt_id: 'attempt-1'}]);
  assert.deepEqual(restarted.state().opened_windows, [{account_week_id: WEEK, resource_id: 'short',
    instance: 'short-quiet-1', epoch: 'epoch-1', anchor_at: NOW, resets_at: NOW + 5 * HOUR_MS, attempt_id: 'attempt-1'}]);
  await restarted.close();
});

test('malformed, wrong-version, wrong-account, and deleted-with-genesis state refuse to open and are left untouched', async (t) => {
  const cases = [
    ['truncated', (file) => fs.writeFileSync(file, '{"revision":'), 'pace50_state_unreadable'],
    ['wrong version', (file, state) => fs.writeFileSync(file, JSON.stringify({...state, version: 'estimated-pace50/state/2'})), 'pace50_state_invalid'],
    ['wrong account', (file, state) => fs.writeFileSync(file, JSON.stringify({...state, account: 'other-account'})), 'pace50_identity_mismatch'],
    ['deleted with genesis', (file) => fs.rmSync(file), 'pace50_state_missing'],
  ];
  for (const [label, damage, code] of cases) {
    const r = rig(t);
    await r.adapter.close();
    const before = fs.existsSync(r.file) ? fs.readFileSync(r.file, 'utf8') : null;
    const state = before ? JSON.parse(before) : null;
    damage(r.file, state);
    const after = fs.existsSync(r.file) ? fs.readFileSync(r.file, 'utf8') : null;
    assert.throws(() => r.open(), {code}, label);
    assert.equal(fs.existsSync(r.file) ? fs.readFileSync(r.file, 'utf8') : null, after, `${label}: file unchanged`);
  }
});

test('first open creates a durable revision-0 store with a genesis marker; reopen returns the same state', async (t) => {
  const r = rig(t);
  assert.equal(r.adapter.state().revision, 0);
  assert.ok(fs.existsSync(join(r.directory, 'lending-pace50-genesis.json')));
  await r.adapter.close();
  const leftover = join(r.directory, `lending-pace50-state.json.${randomUUID()}.tmp`);
  fs.writeFileSync(leftover, '{"half":');
  const reopened = r.open();
  assert.equal(fs.existsSync(leftover), false, 'a crashed temporary write is removed under the lock');
  assert.deepEqual(reopened.state(), r.disk());
  await reopened.close();
});

test('close releases the lock, reports live attempts, and refuses later calls', async (t) => {
  const r = rig(t);
  await r.adapter.admit({expectedRevision: 0, request: request()});
  const closed = await r.adapter.close();
  assert.deepEqual(closed.live_attempts.map((a) => a.id), ['attempt-1']);
  await assert.rejects(r.adapter.admit({expectedRevision: 1, request: request({attempt_id: 'late'})}), {code: 'pace50_closed'});
  assert.deepEqual(await r.adapter.close(), closed, 'close is idempotent');
  const again = r.open();
  await again.close();
});

test('a handler that re-enters the adapter is refused instead of deadlocking', {timeout: 5000}, async (t) => {
  const r = rig(t, {effects: {launch_chunk: async () => {
    await r.adapter.transition({type: 'stop', event_id: 'inner-stop', at: NOW + 1}, {expectedRevision: 1});
  }}});
  const out = await r.adapter.admit({expectedRevision: 0, request: request()});
  const launch = out.effects.find((e) => e.type === 'launch_chunk');
  assert.equal(launch.status, 'failed');
  assert.match(launch.error, /pace50_reentrant_call/);
  await r.adapter.close();
});

test('a timer armed by a handler may call the adapter after the handler returns', {timeout: 5000}, async (t) => {
  let later;
  const r = rig(t, {effects: {arm_cessation_deadline: async (effect) => {
    if (effect.resource_id === 'short') {
      later = new Promise((resolve) => {
        setTimeout(() => {
          resolve(r.adapter.transition({type: 'owner_absent', event_id: 'timer-absent', at: NOW + 1, confirmed: true},
            {expectedRevision: 1}));
        }, 0);
      });
    }
    return () => {};
  }}});
  await r.adapter.admit({expectedRevision: 0, request: request()});
  assert.equal((await later).applied, true);
  await r.adapter.close();
});

test('in-process disarm callbacks run when the attempt ceases and when the store closes', async (t) => {
  const r = rig(t);
  await r.adapter.admit({expectedRevision: 0, request: request()});
  await r.adapter.transition({type: 'cessation_proven', event_id: 'ceased-1', at: NOW + 1, attempt_id: 'attempt-1',
    authoritative_cessation: true, usage_reconciled: true, zero_use_attested: true, absence_proven: true}, {expectedRevision: 1});
  assert.equal(r.calls.filter((c) => c[0] === 'disarm').length, 2, 'both resource deadlines disarmed on cessation');
  await r.adapter.close();
  const second = rig(t);
  await second.adapter.admit({expectedRevision: 0, request: request()});
  await second.adapter.close();
  assert.equal(second.calls.filter((c) => c[0] === 'disarm').length, 2, 'both resource deadlines disarmed on close');
});

// Fence regression (review of f43b2699): an On-class event queued before an admission must not clear a
// Stop or owner-return fence that was requested after the admission was queued. Admission order is FIFO.
test('a Stop requested after a queued On fences the admission queued between them, even though the On applies first', {timeout: 5000}, async (t) => {
  const r = rig(t);
  const on = r.adapter.transition({type: 'on', event_id: 'on-1', at: NOW}, {expectedRevision: 0});
  const admitted = r.adapter.admit({expectedRevision: 1, request: request()});
  const stop = r.adapter.transition({type: 'stop', event_id: 'stop-1', at: NOW}, {expectedRevision: 1});
  const outcome = await admitted;
  assert.equal((await on).applied, true);
  assert.equal(outcome.admitted, false, 'the queued admission must not launch after Stop was requested');
  assert.equal(outcome.reason, 'adapter_frozen');
  assert.equal(r.calls.filter((c) => c[0] === 'launch').length, 0);
  assert.equal((await stop).applied, true);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'cancel').map((c) => c[1]), [], 'nothing was admitted, so nothing to cancel');
  await r.adapter.close();
});

test('an owner return requested after a queued On fences the admission queued between them', {timeout: 5000}, async (t) => {
  const r = rig(t);
  const on = r.adapter.transition({type: 'on', event_id: 'on-1', at: NOW}, {expectedRevision: 0});
  const admitted = r.adapter.admit({expectedRevision: 1, request: request()});
  const owner = r.adapter.transition({type: 'owner_return', event_id: 'return-1', at: NOW}, {expectedRevision: 1});
  const outcome = await admitted;
  assert.equal((await on).applied, true);
  assert.equal(outcome.admitted, false);
  assert.equal(outcome.reason, 'adapter_frozen');
  assert.equal(r.calls.filter((c) => c[0] === 'launch').length, 0);
  assert.equal((await owner).applied, true);
  await r.adapter.close();
});

test('control: a Stop or owner return with no earlier On refuses the admission queued after it', {timeout: 5000}, async (t) => {
  for (const type of ['stop', 'owner_return']) {
    const r = rig(t);
    const fence = r.adapter.transition({type, event_id: `${type}-1`, at: NOW}, {expectedRevision: 0});
    const outcome = await r.adapter.admit({expectedRevision: 0, request: request()});
    assert.equal(outcome.reason, 'adapter_frozen', type);
    assert.equal(r.calls.filter((c) => c[0] === 'launch').length, 0, type);
    assert.equal((await fence).applied, true);
    await r.adapter.close();
  }
});

test('control: an explicit On applied after a Stop re-enables admission, and the Stop does not outlive that On', {timeout: 5000}, async (t) => {
  const r = rig(t);
  assert.equal((await r.adapter.transition({type: 'stop', event_id: 'stop-1', at: NOW}, {expectedRevision: 0})).applied, true);
  assert.equal((await r.adapter.transition({type: 'on', event_id: 'on-1', at: NOW + 1}, {expectedRevision: 1})).applied, true);
  r.clock.at = NOW + 2;
  const out = await r.adapter.admit({expectedRevision: 2, request: request()});
  assert.equal(out.admitted, true, JSON.stringify(out.reason));
  assert.equal(r.calls.filter((c) => c[0] === 'launch').length, 1);
  await r.adapter.close();
});

test('control: a refused Stop still fences admission until an applied On, because a failed Stop is not a release', {timeout: 5000}, async (t) => {
  const r = rig(t);
  const refused = await r.adapter.transition({type: 'stop', event_id: 'stop-1', at: NOW}, {expectedRevision: 99});
  assert.equal(refused.applied, false);
  assert.equal((await r.adapter.admit({expectedRevision: 0, request: request()})).reason, 'adapter_frozen');
  assert.equal((await r.adapter.transition({type: 'on', event_id: 'on-1', at: NOW}, {expectedRevision: 0})).applied, true);
  r.clock.at = NOW + 1;
  assert.equal((await r.adapter.admit({expectedRevision: 1, request: request()})).admitted, true);
  await r.adapter.close();
});

test('control: an admission queued before close persists nothing and launches nothing', {timeout: 5000}, async (t) => {
  const r = rig(t);
  const admitted = r.adapter.admit({expectedRevision: 0, request: request()});
  const closing = r.adapter.close();
  assert.equal((await admitted).reason, 'adapter_frozen');
  assert.equal(r.adapter.state().revision, 0, 'nothing was persisted');
  assert.equal(r.calls.length, 0);
  await closing;
});

// Startup obligation: a crash inside a launch leaves a stored reservation that never recorded a result. A restarted
// process must ask the backend to cease it, keyed by attempt so that the key survives later revisions, and must not
// launch it again or release it.
test('startup recovery asks every unceased attempt to cease, keyed by attempt across revisions, and never relaunches', {timeout: 5000}, async (t) => {
  const r = rig(t, {effects: {request_cessation: async (effect) => {
    r.calls.push(['cessation', effect.attempt_id, effect.dedupe_key, effect.effect_id]);
  }}});
  await r.adapter.admit({expectedRevision: 0, request: request()});
  assert.deepEqual(r.calls.filter((c) => c[0] === 'launch').length, 1);
  await r.adapter.close();
  const restarted = r.open();
  const first = await restarted.recover();
  assert.deepEqual(first.effects.map((e) => [e.type, e.status]), [['request_cessation', 'dispatched']]);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'cessation'),
    [['cessation', 'attempt-1', 'request_cessation:attempt-1', 'recover:request_cessation:attempt-1']]);
  assert.equal(r.calls.filter((c) => c[0] === 'launch').length, 1, 'the unrecorded launch is not repeated');
  assert.equal(restarted.state().attempts[0].process_state, 'not_started', 'nothing was released');
  await restarted.transition({type: 'owner_absent', event_id: 'absent-2', at: NOW + 1, confirmed: true}, {expectedRevision: 1});
  const later = await restarted.recover();
  assert.equal(later.revision, 2);
  assert.equal(later.effects[0].effect_id, 'recover:request_cessation:attempt-1', 'the same request after a revision change');
  await restarted.close();
});

// A fake process reports its start from inside the launch callback. Awaiting the queue there would deadlock, so the
// observation is queued behind the launch and applied, in order, after it returns.
test('a backend observation delivered during a launch is applied after the handler returns, without deadlock', {timeout: 5000}, async (t) => {
  let delivered = null;
  const r = rig(t, {effects: {launch_chunk: async (effect) => {
    r.calls.push(['launch', effect.attempt_id]);
    delivered = await r.adapter.deliver({type: 'launch_result', event_id: 'started-1', at: NOW,
      attempt_id: effect.attempt_id, result: 'started'});
  }}});
  const out = await r.adapter.admit({expectedRevision: 0, request: request()});
  assert.equal(out.admitted, true);
  assert.deepEqual(delivered, {queued: true}, 'the launch was not kept waiting on the queue');
  // A later transition is queued behind the deferred observation, so awaiting it proves the observation has applied.
  assert.equal((await r.adapter.transition({type: 'owner_absent', event_id: 'absent-1', at: NOW, confirmed: true},
    {expectedRevision: 2})).applied, true);
  assert.equal(r.adapter.state().attempts[0].process_state, 'running');
  assert.equal(r.adapter.deferredResults()[0].applied, true);
  await r.adapter.close();
});

test('outside a handler, deliver applies the observation like transition and reports the outcome', {timeout: 5000}, async (t) => {
  const r = rig(t);
  await r.adapter.admit({expectedRevision: 0, request: request()});
  const applied = await r.adapter.deliver({type: 'launch_result', event_id: 'started-1', at: NOW,
    attempt_id: 'attempt-1', result: 'started'});
  assert.equal(applied.applied, true);
  assert.equal(applied.revision, 2);
  await r.adapter.close();
  await assert.rejects(r.adapter.deliver({type: 'owner_absent', event_id: 'late', at: NOW, confirmed: true}), {code: 'pace50_closed'});
});

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
test('a sandbox removed before its quiet window confirms does not launch when the window then opens', async (t) => {
  const r = await openingRig(t);
  const removed = await r.adapter.transition({type: 'cleanup_proven', event_id: 'attempt-1:cleanup-proven:3', at: NOW + 1,
    attempt_id: 'attempt-1', cleanup_removed: true}, {expectedRevision: 2});
  assert.equal(removed.applied, true, JSON.stringify(removed));
  const confirmed = await r.adapter.transition({type: 'opening_confirmed', event_id: 'opened-1', at: NOW + 2, attempt_id: 'attempt-1',
    authoritative_opened: true, account: ACCOUNT, account_week_id: WEEK, epoch: 'epoch-1', resource_id: 'short',
    instance: 'short-quiet-1', anchor_at: NOW, resets_at: NOW + 5 * HOUR_MS, observed_at: NOW + 2}, {expectedRevision: 3});
  assert.equal(confirmed.applied, true, JSON.stringify(confirmed));
  assert.deepEqual(confirmed.effects, [], 'no effect launches, cancels or reopens the removed process');
  assert.equal(r.calls.filter((c) => c[0] === 'launch').length, 0);
  const [attempt] = r.adapter.state().attempts;
  assert.deepEqual([attempt.process_state, attempt.cessation_proven, attempt.cleanup_proven, attempt.hold_closed],
    ['ceased', true, true, false], 'the cessation record and the open hold are unchanged');
  assert.equal(r.adapter.state().opened_windows.length, 1, 'the window itself is still recorded');
  await r.adapter.close();
});

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

const providerCases=[undefined,null,'','CODEX','openai','claude','codex',' codex','codex ',' claude','claude '];
const meterCases=[
 ['codex:10080','codex'],['seven_day','claude'],['unknown',null],[null,null],
 ['',null],[' codex:10080',null],['codex:10080 ',null],[' seven_day',null],['seven_day ',null],
 ['codex:0',null],['codex:01',null],['openai:10080',null],['CODEX:10080',null],['Codex:10080',null],['Seven_day',null],
];
for(const [weeklyId,owner] of meterCases)for(const provider of providerCases)for(const legacy of [false,true])
 test(`feedback preview and admission agree for meter ${JSON.stringify(weeklyId)}, provider ${String(provider)}, legacy ${legacy}`,async t=>{
  assert.equal(meterProvider(weeklyId),owner,'meter ownership uses exact canonical names');
  const r=rig(t,{open:{buildInput:async({now})=>{
   const original=ordinaryInput({now});
   const windows=original.windows.map(w=>({...w,id:w.kind==='weekly'?'codex:10080':'codex:300'}));
   return {...ordinaryInput({now,windows}),weekly_resource_id:weeklyId};
  }}});
  try {
   const rate={id:'seven_day',instance:'feedback-week',epoch:'feedback-epoch',
    anchor_at:NOW-HOUR_MS,resets_at:NOW+HOUR_MS,kappa_micro:100000,used_micro:0};
   assert.equal((await r.adapter.deliver({type:'meter_feedback',event_id:'pending-feedback',
    at:NOW,observed_at:NOW,account:ACCOUNT,resources:[rate]})).applied,true);
   if(legacy){
    await r.adapter.close();
    const state=r.disk();delete state.rate_feedback.pending;
    fs.writeFileSync(r.file,JSON.stringify(state));r.adapter=r.open();
   }
   const req=request(provider===undefined?{}:{provider});
   const before=r.adapter.state();
   const preview=await r.adapter.preview({request:req});
   const admit=await r.adapter.admit({expectedRevision:before.revision,request:req});
   assert.deepEqual({admitted:admit.admitted,reason:admit.reason},
    {admitted:preview.admitted,reason:preview.reason},'preview and admission must apply the same feedback fence');
   const allowed=owner==='codex'&&provider==='codex';
   assert.equal(preview.admitted,allowed);
   if(!allowed){
    assert.equal(preview.reason,'meter_coverage_required');
    assert.deepEqual(r.adapter.state(),before,'a feedback refusal never persists an attempt');
   }
  }finally{await r.adapter.close();}
 });

for(const pendingId of ['unknown','openai:10080','CODEX:10080','Codex:10080','Seven_day',' seven_day','codex:10080 ','codex:0','codex:01'])
 test(`unknown feedback meter ${pendingId} fences both canonical providers`,async t=>{
  const r=rig(t,{open:{buildInput:async({now})=>{
   const original=ordinaryInput({now});
   const windows=original.windows.map(w=>({...w,id:w.kind==='weekly'?'codex:10080':'codex:300'}));
   return {...ordinaryInput({now,windows}),weekly_resource_id:'codex:10080'};
  }}});
  try {
   assert.equal(meterProvider(pendingId),null);
   await r.adapter.deliver({type:'meter_feedback',event_id:'unknown-feedback',account:ACCOUNT,
    at:NOW,observed_at:NOW,resources:[{id:pendingId,instance:'unknown-week',epoch:'unknown-epoch',
     anchor_at:NOW-HOUR_MS,resets_at:NOW+HOUR_MS,kappa_micro:100000,used_micro:0}]});
   for(const provider of ['claude','codex']){
    const req=request({provider});
    const preview=await r.adapter.preview({request:req});
    const admit=await r.adapter.admit({expectedRevision:r.adapter.state().revision,request:req});
    assert.equal(preview.admitted,false);assert.equal(preview.reason,'meter_coverage_required');
    assert.equal(admit.reason,preview.reason);assert.equal(admit.admitted,preview.admitted);
   }
  }finally{await r.adapter.close();}
 });

for(const provider of ['claude','codex'])
 test(`unreadable meter evidence retains the feedback fence in preview and admission for ${provider}`,async t=>{
  const r=rig(t,{open:{buildInput:async()=>{throw new Error('meter evidence unreadable');}}});
  try {
   const out=await r.adapter.deliver({type:'meter_feedback',event_id:'unreadable-feedback',account:ACCOUNT,
    at:NOW,observed_at:NOW,resources:[{id:'seven_day',instance:'feedback-week',epoch:'feedback-epoch',
     anchor_at:NOW-HOUR_MS,resets_at:NOW+HOUR_MS,kappa_micro:100000,used_micro:0}]});
   assert.equal(out.applied,true);
   const before=r.adapter.state(),req=request({provider});
   const preview=await r.adapter.preview({request:req});
   const admit=await r.adapter.admit({expectedRevision:before.revision,request:req});
   assert.equal(preview.reason,'meter_coverage_required');
   assert.equal(admit.reason,preview.reason);
   assert.equal(preview.admitted,false);assert.equal(admit.admitted,false);
   assert.deepEqual(r.adapter.state(),before);
  }finally{await r.adapter.close();}
 });


function feedbackRate(id) {
  return {id, instance: 'feedback-week', epoch: 'feedback-epoch', anchor_at: NOW - HOUR_MS,
    resets_at: NOW + HOUR_MS, kappa_micro: 100000, used_micro: 0};
}

function providerInput(now, provider, patch = {}) {
  const original = ordinaryInput({now});
  const weeklyId = provider === 'claude' ? 'seven_day' : 'codex:10080';
  const windows = original.windows.map(w => ({...w,
    id: w.kind === 'weekly' ? weeklyId : provider === 'claude' ? 'five_hour' : 'codex:300'}));
  return {...ordinaryInput({now, windows}), weekly_resource_id: weeklyId, ...patch};
}

for (const provider of ['claude', 'codex']) {
  test(`pending feedback for both providers blocks ${provider} after building evidence once per call`, async t => {
    let builds = 0;
    const r = rig(t, {open: {buildInput: async ({now}) => {
      builds++;
      return providerInput(now, provider);
    }}});
    try {
      assert.equal((await r.adapter.deliver({type: 'meter_feedback', event_id: 'both-pending',
        at: NOW, observed_at: NOW, account: ACCOUNT,
        resources: [feedbackRate('seven_day'), feedbackRate('codex:10080')]})).applied, true);
      assert.equal(r.adapter.state().rate_feedback.pending.length, 2);
      const before = r.adapter.state();
      const bytes = fs.readFileSync(r.file);
      for (const method of ['preview', 'admit', 'preview', 'admit']) {
        const previousBuilds = builds;
        const out = await r.adapter[method]({expectedRevision: before.revision, request: request({provider})});
        assert.equal(out.admitted, false);
        assert.equal(out.reason, 'meter_coverage_required');
        assert.equal(out.revision, before.revision);
        assert.equal(builds, previousBuilds + 1, 'the fence is evaluated after one evidence build per call');
      }
      assert.deepEqual(fs.readFileSync(r.file), bytes);
      assert.deepEqual(r.calls, []);
    } finally { await r.adapter.close(); }
  });
}

for (const wrongAccount of [false, true]) {
  test(`Claude with pending Codex feedback ${wrongAccount ? 'refuses a different builder account' : 'admits with matching account'}`, async t => {
    const r = rig(t, {open: {buildInput: async ({now}) => providerInput(now, 'claude',
      wrongAccount ? {account: 'different-account'} : {})}});
    try {
      assert.equal((await r.adapter.deliver({type: 'meter_feedback', event_id: 'codex-pending',
        at: NOW, observed_at: NOW, account: ACCOUNT, resources: [feedbackRate('codex:10080')]})).applied, true);
      const before = r.adapter.state();
      const preview = await r.adapter.preview({request: request({provider: 'claude'})});
      const out = await r.adapter.admit({expectedRevision: before.revision, request: request({provider: 'claude'})});
      assert.equal(preview.admitted, !wrongAccount);
      assert.equal(out.admitted, preview.admitted);
      if (wrongAccount) {
        assert.equal(preview.reason, 'account_week_identity');
        assert.equal(out.reason, preview.reason);
        assert.deepEqual(r.adapter.state(), before);
        assert.deepEqual(r.calls, []);
      }
    } finally { await r.adapter.close(); }
  });
}

test('a feedback refusal leaves the verified week rollover, revision and event journal uncommitted', async t => {
  const r = rig(t, {open: {buildInput: async ({now}) => providerInput(now, 'claude',
    {account_week_id: 'synthetic-week-2'})}});
  try {
    assert.equal((await r.adapter.deliver({type: 'meter_feedback', event_id: 'claude-pending',
      at: NOW, observed_at: NOW, account: ACCOUNT, resources: [feedbackRate('seven_day')]})).applied, true);
    const before = r.adapter.state();
    const bytes = fs.readFileSync(r.file);
    const journal = Buffer.from(JSON.stringify(before.event_ids));
    const req = request({provider: 'claude'});
    const preview = await r.adapter.preview({request: req});
    assert.equal(preview.reason, 'meter_coverage_required');
    const out = await r.adapter.admit({expectedRevision: before.revision, request: req});
    assert.equal(out.admitted, false);
    assert.equal(out.reason, preview.reason);
    assert.deepEqual({bytes: fs.readFileSync(r.file), revision: out.revision,
      stateRevision: r.adapter.state().revision, journal: Buffer.from(JSON.stringify(r.adapter.state().event_ids))},
    {bytes, revision: before.revision, stateRevision: before.revision, journal},
    'feedback refusal must preserve the state bytes, returned revision and durable event journal');
    assert.deepEqual(r.adapter.state(), before);
    assert.deepEqual(r.calls, []);
  } finally { await r.adapter.close(); }
});

for (const closed of [undefined, true]) {
 test(`loading a legacy ceased hold reopens remaining exposure (closed=${closed})`, async t => {
  const r=rig(t);
  await r.adapter.admit({expectedRevision:0,request:request()});
  await r.adapter.transition({type:'cleanup_proven',event_id:'attempt-1:cleanup-proven:legacy',
   at:NOW,attempt_id:'attempt-1',cleanup_removed:true},{expectedRevision:1});
  await r.adapter.close();
  const old=r.disk();
  if(closed===undefined) delete old.attempts[0].hold_closed;
  else old.attempts[0].hold_closed=closed;
  fs.writeFileSync(r.file,JSON.stringify(old));
  const reopened=r.open();
  try {
  assert.equal(reopened.state().attempts[0].hold_closed,false,'remaining liability must reach the reset sweep');
  const attempt=reopened.state().attempts[0];
  const at=Math.max(...attempt.resources.map(r=>r.resets_at))+1;
  const out=await reopened.transition({type:'window_reset_settled',event_id:'legacy-own-reset',at,
   attempt_id:attempt.id,authoritative_cessation:true,resource_ids:attempt.resources.map(r=>r.id)},
   {expectedRevision:old.revision});
  assert.equal(out.applied,true,out.reason);
  assert.equal(reopened.state().attempts[0].hold_closed,true);
  assert.ok(reopened.state().attempts[0].resources.every(r=>r.held_micro===0&&r.unrepresented_micro===0));
  } finally { await reopened.close(); }
 });
}


test('owner release refuses an otherwise valid opening confirmation without launching',async t=>{
 const r=await openingRig(t);
 const beforeRelease=r.adapter.state();
 const confirmation={type:'opening_confirmed',event_id:'opened-after-release',at:NOW+2,attempt_id:'attempt-1',
  authoritative_opened:true,account:ACCOUNT,account_week_id:WEEK,epoch:'epoch-1',resource_id:'short',
  instance:'short-quiet-1',anchor_at:NOW,resets_at:NOW+5*HOUR_MS,observed_at:NOW+2};
 const {transitionEstimatedPace50State}=await import('../lib/v1/lending-policy.mjs');
 const control=transitionEstimatedPace50State(beforeRelease,confirmation);
 assert.equal(control.applied,true);
 assert.ok(control.effects.some(effect=>effect.type==='launch_chunk'),'control can launch');
 const release=await r.adapter.transition({type:'owner_release_hold',event_id:'attempt-1:owner-release-hold',
  at:NOW+1,attempt_id:'attempt-1',confirmed:true},{expectedRevision:beforeRelease.revision});
 assert.equal(release.applied,true);
 const before=structuredClone(r.adapter.state());
 const result=await r.adapter.transition(confirmation,{expectedRevision:before.revision});
 assert.equal(result.applied,false);
 assert.equal(result.reason,'manual_full_charge_pending');
 assert.deepEqual(r.adapter.state(),before);
 assert.deepEqual(result.effects,[]);
 await r.adapter.close();
});
