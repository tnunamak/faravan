import {durableWrite} from '../durable-write.mjs';
// Durable runner for the estimated-pace50 lending state. The policy module decides
// what a proposed transition or admission means. This module makes three things true
// around it: the proposed state is persisted before any provider-facing effect; writers
// are serialized by one process lock and a revision compare-and-swap; and effects run in
// the policy's order under explicit gates. It reads no provider data and never turns a
// callback result into authoritative evidence. Only later authoritative events move
// exposure, and the policy decides those.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {acquireProcessLockSync} from './lock.mjs';
import {createEstimatedPace50State, evaluateEstimatedPace50, transitionEstimatedPace50State, rateFeedbackBlocksProvider} from './lending-policy.mjs';
import {settleWithin} from './settle-within.mjs';
import {mergeServedModelEvidence} from './attempt-evidence.mjs';

const STATE_FILE = 'lending-pace50-state.json';
const GENESIS_FILE = 'lending-pace50-genesis.json';
const GENESIS_VERSION = 'pace50-genesis/1';
const TEMPORARY = /^lending-pace50-[a-z]+\.json\.[0-9a-f-]{36}\.tmp$/;
const PERSIST = new Set(['persist_proposed_state', 'persist_proposed_state_before_provider_action']);
// Informational effects describe state the caller already holds. They dispatch nothing.
const INFORMATIONAL = new Set(['stop_admissions', 'freeze_new_chunks', 'require_fresh_admission_checks',
  'retain_reservation_and_opening_token', 'opening_token_released_by_authoritative_no_opening_evidence',
  'cross_reset_exposure_reconciled', 'arm_native_guard']);
const ARM = 'arm_cessation_deadline';
// Actions create provider exposure. They are gated, and this module never replays them.
const ACTIONS = new Set(['launch_chunk', 'open_short_window']);
// Controls are idempotent requests. Recovery may re-send them with the same effect id.
const CONTROLS = new Set(['cancel_pending_attempt', 'request_cessation', 'request_fresh_complete_reconciliation']);
const REQUIRED_HANDLERS = [ARM, ...ACTIONS, ...CONTROLS];
const STOP_EVENTS = new Set(['stop', 'owner_stop', 'pause', 'owner_return']);
const ON_EVENTS = new Set(['on', 'owner_absent']);

// Frames mark code that runs inside a handler or evidence builder. A call back into this
// serialized adapter from such code would wait on itself, so it is refused instead.
const frames = new AsyncLocalStorage();
const inCallback = () => frames.getStore()?.active === true;
function callback(fn) {
  const frame = {active: true};
  return frames.run(frame, async () => {
    try {
      return await fn();
    } finally {
      frame.active = false;
    }
  });
}

function coded(code, detail, cause) {
  const message = detail ? `${code}: ${detail}` : code;
  return Object.assign(new Error(message, cause === undefined ? undefined : {cause}), {code});
}

function classify(type) {
  if (PERSIST.has(type)) return 'persist';
  if (INFORMATIONAL.has(type)) return 'informational';
  if (type === ARM) return 'arm';
  if (ACTIONS.has(type)) return 'action';
  if (CONTROLS.has(type)) return 'control';
  throw coded('pace50_unknown_effect', type);
}

const armKey = (attemptId, resourceId) => `${attemptId}\u0000${resourceId}`;
const clone = (value) => structuredClone(value);
const nonempty = (value) => typeof value === 'string' && value.trim() !== '';
// The policy answers a probe event it does not know with `unknown_event` only when the state itself is valid.
const isValid = (state) => transitionEstimatedPace50State(state, {
  type: '__pace50_validate__', event_id: `validate:${randomUUID()}`, at: state?.updated_at ?? 0,
}).reason === 'unknown_event';

// The policy's outcome without the proposed state (persisted separately) and the raw effect list (reported as results).
function publicOutcome(out) {
  const copy = {...out};
  delete copy.proposed_state;
  delete copy.effects;
  return copy;
}

function assertRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('expectedRevision must be a non-negative integer');
}

// Filesystem seam for the write path only. Tests replace one syscall at a time.
const nodeIo = {
  openSync: (file, flags, mode) => fs.openSync(file, flags, mode),
  writeAllSync: (fd, data) => fs.writeFileSync(fd, data),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (from, to) => fs.renameSync(from, to),
  unlinkSync: (file) => fs.unlinkSync(file),
  fsyncDirectory: (directory) => {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
};

export function createPace50Adapter({directory, account, account_week_id: initialWeek, buildInput,
  effects: handlers, now = Date.now, io: ioOverrides = {}, readOnlyPreview = false, decide, postingLagBoundMs} = {}) {
  const transition = (state,event) => transitionEstimatedPace50State(state,event,{postingLagBoundMs});
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('pace50 needs an absolute directory');
  if (typeof account !== 'string' || account.trim() === '') throw coded('pace50_identity_required', 'account');
  if (typeof buildInput !== 'function') throw new TypeError('pace50 needs buildInput');
  if (typeof now !== 'function') throw new TypeError('pace50 needs a now function');
  for (const type of REQUIRED_HANDLERS) {
    if (typeof handlers?.[type] !== 'function') throw coded('pace50_handler_missing', type);
  }
  if (decide !== undefined && typeof decide !== 'function') throw new TypeError('pace50 rule must be a function');
  // Trusted executable dependency is deliberately outside serializable builder evidence.
  // Builder-supplied functions still fail cloning; we never extract or serialize them.
  function decisionInput(built) {
    const input = clone(built);
    // The rule applies where the builder bound its evidence; an objective without ruleEvidence keeps its strategy path.
    if (decide !== undefined && input.objective?.ruleEvidence !== undefined) input.objective = {...input.objective, decide};
    return input;
  }
  const io = {...nodeIo, ...ioOverrides};
  const file = path.join(directory, STATE_FILE);
  const genesis = path.join(directory, GENESIS_FILE);

  // Reads are direct and validated. Writes happen only inside the serialized queue.
  function readState() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (cause) { throw coded('pace50_state_unreadable', STATE_FILE, cause); }
    let state;
    try { state = JSON.parse(text); } catch (cause) { throw coded('pace50_state_unreadable', STATE_FILE, cause); }
    if (!isValid(state)) throw coded('pace50_state_invalid', STATE_FILE);
    // Old ceased records can still owe exposure. Reopen their holds before any caller filters the sweep.
    for (const attempt of state.attempts) {
      if (attempt.process_state === 'ceased' &&
          attempt.resources.some(r => r.held_micro > 0 || r.unrepresented_micro > 0)) attempt.hold_closed = false;
    }
    return state;
  }

  // Write path. Any syscall failure leaves the old or the new revision on disk and never
  // reports success. The caller decides nothing here, so the temporary file is removed.
  function writeAtomic(target,value) {durableWrite(target,JSON.stringify(value),{io});}

  // A failed persist may have renamed the new revision already. The open instance can no
  // longer tell which revision is durable, so it refuses further work and must be reopened.
  let poisoned = null;
  function writeState(next) {
    try {
      writeAtomic(file, next);
    } catch (cause) {
      poisoned = coded('pace50_store_poisoned', 'reopen the store to read the durable revision', cause);
      throw coded('pace50_persist_failed', undefined, cause);
    }
  }

  function bootstrap() {
    for (const name of fs.readdirSync(directory)) {
      if (TEMPORARY.test(name)) fs.unlinkSync(path.join(directory, name));
    }
    if (!fs.existsSync(file)) {
      // A missing state beside a genesis marker means the store was lost, not that it is new.
      if (fs.existsSync(genesis)) throw coded('pace50_state_missing', STATE_FILE);
      writeAtomic(file, createEstimatedPace50State({account, account_week_id: initialWeek}));
    }
    const state = readState();
    if (state.account !== account) throw coded('pace50_identity_mismatch', STATE_FILE);
    if (!fs.existsSync(genesis)) writeAtomic(genesis, {version: GENESIS_VERSION, account});
  }

  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const release = acquireProcessLockSync(file + '.owner.lock');
  try {
    bootstrap();
  } catch (error) {
    release();
    throw error;
  }

  let closed = false, closing = null, released = false, queue = Promise.resolve();
  // stopRequests counts Stop-class requests not yet settled. stopFence is sticky: any Stop-class request sets it, and only
  // an applied On-class event with no Stop-class request still queued behind it clears it. A refused Stop still fences.
  let stopRequests = 0, stopFence = false, feedbackRequests = 0;
  const fenced = () => stopRequests > 0 || stopFence || feedbackRequests > 0;
  // Armed deadlines for this process only. A restarted process has none, so no launch from before it can proceed.
  const armed = new Map();
  // Resource ids that must be armed before this process may launch an admitted attempt.
  const expectedArms = new Map();

  function enqueue(task) {
    const run = queue.then(() => {
      if (poisoned) throw poisoned;
      // Once the lock is released, a task that was still queued refuses before it writes.
      if (released) throw coded('pace50_closed');
      return task();
    });
    queue = run.catch(() => {});
    return run;
  }

  function guardCall() {
    if (closed) throw coded('pace50_closed');
    if (inCallback()) throw coded('pace50_reentrant_call');
    if (poisoned) throw poisoned;
  }

  function disposeArm(key) {
    const entry = armed.get(key);
    if (!entry) return;
    armed.delete(key);
    entry.dispose();
  }

  // An attempt that ceased durably needs no timer. A disposer failure cannot undo that
  // durable fact, so it is not allowed to fail the transition that recorded it.
  function retire(state) {
    for (const attempt of state.attempts) {
      if (attempt.process_state !== 'ceased') continue;
      for (const resource of expectedArms.get(attempt.id) ?? []) {
        try { disposeArm(armKey(attempt.id, resource)); } catch { /* the attempt already ceased */ }
      }
      expectedArms.delete(attempt.id);
    }
  }

  // Returns a gate reason, or null when this process may run the action now.
  function launchGate(attemptId) {
    if (closed || fenced()) return coded('pace50_frozen_before_action');
    const expected = expectedArms.get(attemptId);
    if (!expected) return coded('pace50_attempt_not_armed_in_process', attemptId);
    for (const resource of expected) {
      const entry = armed.get(armKey(attemptId, resource));
      if (!entry) return coded('pace50_deadline_not_armed', attemptId);
      if (now() >= entry.deadline_at) return coded('pace50_deadline_passed', attemptId);
    }
    return null;
  }

  async function perform(kind, effect, state) {
    if (kind === 'arm') {
      if (!(effect.deadline_at > now())) throw coded('pace50_deadline_not_future', effect.attempt_id);
      const dispose = await callback(() => handlers[ARM](clone(effect), clone(state)));
      // An arm that returns after the lock was released must not leave a timer behind.
      if (released) {
        if (typeof dispose === 'function') { try { dispose(); } catch { /* the store is closed */ } }
        throw coded('pace50_closed');
      }
      if (typeof dispose !== 'function') throw coded('pace50_arm_without_disposer', effect.attempt_id);
      const key = armKey(effect.attempt_id, effect.resource_id);
      disposeArm(key);
      armed.set(key, {deadline_at: effect.deadline_at, dispose});
      return;
    }
    if (kind === 'action') {
      const gate = launchGate(effect.attempt_id);
      if (gate) throw gate;
    }
    await callback(() => handlers[effect.type](clone(effect), clone(state)));
  }

  async function runEffects(effects, state, idFor) {
    const results = [];
    for (const [index, effect] of effects.entries()) {
      const kind = classify(effect.type);
      const row = {effect_id: idFor(index, effect), type: effect.type, attempt_id: effect.attempt_id ?? null};
      if (kind === 'informational' || kind === 'persist') {
        results.push({...row, status: 'informational'});
        continue;
      }
      try {
        // Controls are idempotent per attempt. Handlers dedupe on dedupe_key, which does not change with the revision.
        const handlerEffect = {...effect, effect_id: row.effect_id};
        if (kind === 'control') handlerEffect.dedupe_key = `${effect.type}:${effect.attempt_id}`;
        await perform(kind, handlerEffect, state);
        results.push({...row, status: 'dispatched'});
      } catch (error) {
        results.push({...row, status: 'failed', error: error.message});
      }
    }
    return results;
  }

  // Persist first, then dispatch. `policyEffects` starts with the persist instruction.
  async function commit(nextState, policyEffects, expectedRevision, admittedAttempt) {
    const [persist, ...effects] = policyEffects;
    if (!persist || !PERSIST.has(persist.type) || nextState.revision !== expectedRevision + 1) {
      throw coded('pace50_policy_contract', 'persist instruction does not match the revision');
    }
    for (const effect of effects) classify(effect.type);
    if (!isValid(nextState)) throw coded('pace50_policy_contract', 'proposed state is invalid');
    writeState(nextState);
    if (admittedAttempt !== null) {
      expectedArms.set(admittedAttempt, effects.filter((e) => e.type === ARM).map((e) => e.resource_id));
    }
    retire(nextState);
    const results = await runEffects(effects, nextState, (index) => `r${nextState.revision}.${index}`);
    return {
      revision: nextState.revision,
      effects: results,
      effects_dispatched: results.every((r) => r.status === 'dispatched' || r.status === 'informational'),
    };
  }

  function refusal(reason, revision, hints = [], detail = null) {
    return {admitted: false, reason, revision, effects: [], effects_dispatched: false, hints, ...(detail ? {detail} : {})};
  }

  // A week change is trusted only when the fresh build proves that its account still matches
  // this adapter and that the provider mapped the new weekly resource to an account week.
  // Preview projects this event; admission persists it through the same serialized queue.
  function verifiedWeekAdvance(state, built, at) {
    // The move names the provider's weekly meter and its reset, so the policy can keep each provider's week moving forward.
    const weekly = Array.isArray(built?.windows) ? built.windows.find(w => w?.id === built.weekly_resource_id) : null;
    if (!nonempty(built?.weekly_resource_id) || !Number.isSafeInteger(weekly?.resets_at)) return null;
    if (state.account !== account || built?.account !== state.account ||
      !nonempty(built.account_week_id) || built.account_week_id === state.account_week_id ||
      built.evidence?.complete !== true || built.evidence?.refresh_succeeded !== true ||
      built.evidence?.identity_compatible !== true || built.evidence?.account_week_mapping_known !== true) return null;
    // Weeks of two providers can alternate, so the same week can be entered again: the id names this revision's change.
    return transition(state, {
      type: 'advance_account_week',
      account: state.account,
      weekly_account_id: built.weekly_account_id ?? built.account,
      event_id: `advance-account-week:${state.account}:${built.account_week_id}:r${state.revision}`,
      at,
      account_week_id: built.account_week_id,
      account_week_mapping_known: true,
      weekly_resource_id: built.weekly_resource_id,
      weekly_resets_at: weekly.resets_at,
    });
  }

  // This is the one policy invocation for previews and durable admission. The accompanying
  // projection is numeric/allowlisted; it never exports account identity, prompts, or raw evidence.
  function evaluateAdmission(built, state, request, decisionAt, ledgerAttemptCount = state.attempts.length) {
    const input = {...decisionInput(built), now: decisionAt, state, request, ledger_attempt_count: ledgerAttemptCount};
    if (rateFeedbackBlocksProvider(state, request?.provider, built?.weekly_resource_id))
      return {...refusal('meter_coverage_required', state.revision), proposed_state: state};
    // A different provider week may be unverified because its evidence is incomplete.
    // Report that gate, not an internal identity failure. This branch only refuses:
    // it never projects/persists a week change or dispatches provider actions.
    if (built?.account === state.account && nonempty(built.account_week_id) &&
      built.account_week_id !== state.account_week_id) {
      const gates = {complete: 'resources_incomplete', refresh_succeeded: 'refresh_failed',
        identity_compatible: 'identity_unknown', account_week_mapping_known: 'account_week_mapping_unknown'};
      for (const [key, reason] of Object.entries(gates)) {
        if (built.evidence?.[key] !== true) {
          return {...refusal(reason, state.revision), proposed_state: state};
        }
      }
    }
    let out = evaluateEstimatedPace50(input);
    // Keep the policy's specific hold; exhausted saved headroom can only remove an admission.
    if (out.admitted && built.admission_headroom_failure)
      out = {...refusal(built.admission_headroom_failure, state.revision), proposed_state:state};
    const number = value => Number.isFinite(value) ? value : null;
    const inputs = {now: decisionAt, stateRevision: state.revision,
      requestedUsdMicro: number(request?.requested_usd_micro),
      ownerMaxJobUsdMicro: number(request?.owner_max_job_usd_micro),
      wallMs: number(request?.wall_ms), stopMs: number(request?.stop_ms),
      uncertaintyMs: number(request?.uncertainty_ms), expiresAt: number(request?.expires_at),
      estimateUsdMicro: number(built?.objective?.job?.estimateUsdMicro),
      worstCallUsdMicro: number(built?.objective?.job?.worstCallUsdMicro),
      friendValue: number(built?.objective?.job?.friendValue),
      laterBurnCapacityMicro: number(built?.objective?.laterBurnCapacityMicro),
      windows: (Array.isArray(built?.windows) ? built.windows : []).map(window => ({id: window?.id ?? null,
        usedMicro: number(window?.used_micro), ownerUsedMicro: number(window?.owner_used_micro ?? window?.used_micro),
        observedAt: number(window?.observed_at), resetsAt: number(window?.resets_at),
        anchorAt: number(window?.anchor_at), durationMs: number(window?.duration_ms),
        pointsPerUsdMicro: number(window?.kappa_micro), kappaLabel: window?.kappa_provenance?.label ?? null, uncertaintyMicro: number(window?.uncertainty_micro ?? 0)}))};
    return {...out, inputs};
  }

  // Only observations are replaced. Identity, conversion, controls, owner evidence, and the
  // durable state stay exactly as built. Missing/unreadable values stay unknown, never zero.
  function fixtureReadings(built, readings) {
    const supplied = Array.isArray(readings) ? readings : readings?.windows;
    const rows = Array.isArray(supplied) ? supplied : [];
    const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
    return {...built, windows: (Array.isArray(built?.windows) ? built.windows : []).map(window => {
      if (!window || typeof window !== 'object') return window;
      const row = rows?.find(item => (item?.window_id ?? item?.id) === window.id);
      if (!row || readings?.refresh_succeeded === false || row.readable === false || row.known === false)
        return {...window, used_micro: null, state: 'unknown'};
      const out = {...window};
      if (Object.hasOwn(row, 'used_micro')) out.used_micro = row.used_micro;
      else if (Object.hasOwn(row, 'used_pct')) out.used_micro = Number.isFinite(row.used_pct)
        ? Math.ceil(Number((row.used_pct * 1_000_000).toFixed(6))) : null;
      else out.used_micro = null;
      if (Object.hasOwn(row, 'owner_used_micro')) out.owner_used_micro = row.owner_used_micro;
      if (Object.hasOwn(row, 'observed_at')) out.observed_at = timestamp(row.observed_at);
      if (Object.hasOwn(row, 'state')) out.state = row.state;
      if (Object.hasOwn(row, 'resets_at')) {
        out.resets_at = timestamp(row.resets_at);
        out.anchor_at = out.resets_at - out.duration_ms;
      }
      return out;
    })};
  }

  const deferred = [];
  function recordDeferred(result) {
    deferred.push(result);
    if (deferred.length > 100) deferred.shift();
  }

  // Shared by transition and deliver. A null revision applies the event to the revision current when it is processed.
  function requestTransition(event, expectedRevision) {
    const frozenEvent = clone(event);
    const stopClass = STOP_EVENTS.has(frozenEvent?.type);
    const feedbackClass = ['meter_feedback','meter_feedback_pending'].includes(frozenEvent?.type);
    if (feedbackClass) feedbackRequests += 1;
    // Synchronous fence, raised in call order: an admission that has not reached the queue head yet is refused.
    if (stopClass) {
      stopRequests += 1;
      stopFence = true;
    }
    return enqueue(async () => {
      try {
        const state = readState();
        const expected = expectedRevision ?? state.revision;
        if (state.revision !== expected) {
          return {applied: false, reason: 'revision_conflict', revision: state.revision, effects: [], effects_dispatched: false};
        }
        // Week changes are derived from the fresh, same-account observation in preview/admit.
        // Callers cannot assert a provider mapping by submitting the durable event directly.
        if (frozenEvent?.type === 'advance_account_week') {
          return {applied: false, reason: 'account_week_identity', revision: state.revision,
            effects: [], effects_dispatched: false};
        }
        const out = transition(state, frozenEvent);
        if (!out.applied) {
          return {applied: false, reason: out.reason, revision: state.revision, effects: [], effects_dispatched: false};
        }
        const result = await commit(out.state, out.effects, expected, null);
        // An On-class event was queued before any Stop still in the queue, so only a Stop-free queue may release the fence.
        if (ON_EVENTS.has(frozenEvent.type) && stopRequests === 0) {
          stopFence = out.state.mode !== 'on' || out.state.owner_present;
        }
        return {applied: true, ...result};
      } finally {
        if (stopClass) stopRequests -= 1;
        if (feedbackClass) feedbackRequests -= 1;
      }
    });
  }

  return {
    state() {
      // A poisoned store cannot tell which revision is durable, so a read refuses too, until the store is reopened.
      if (poisoned) throw poisoned;
      return readState();
    },

    // Read-only decision used by the manager and status view. It runs the same builder and objective policy as admit,
    // against the current durable state, without writing state or dispatching effects.
    async preview({request, context = null, snapshotOnly = false, ...options} = {}) {
      guardCall();
      // An injected builder may perform arbitrary I/O. Offer snapshots need an explicit startup
      // assertion that its evidence callbacks are read-only; a per-offer option cannot grant it.
      // The status view's snapshot ran this same builder before it was marked snapshotOnly, so the
      // gate does not apply to it: the snapshot path only removes writes it used to make.
      if (snapshotOnly && readOnlyPreview !== true && request?.status_snapshot !== true)
        return refusal('objective_evidence_unknown', null);
      const frozenRequest = clone(request);
      const frozenContext = clone(context);
      if (fenced()) return refusal('adapter_frozen', null);
      const assess = async () => {
        const state = readState();
        // A recheck re-decides an issued attempt at its own place in the risk ledger: only the attempts issued before it
        // count toward its ordinal, while every other attempt's hold, earlier or later, still counts against the windows.
        let ledgerAttemptCount = state.attempts.length;
        if (options.replacingAttemptId) {
          const own = state.attempts.findIndex(a => a.id === options.replacingAttemptId);
          if (own >= 0) {
            state.attempts.splice(own, 1);
            ledgerAttemptCount = own;
          }
        }
        if (closed || fenced()) return refusal('adapter_frozen', state.revision);
        let built;
        try {
          built = await callback(() => buildInput({state: clone(state), request: clone(frozenRequest),
            context: clone(frozenContext), now: now(), snapshotOnly}));
        } catch {
          return refusal(rateFeedbackBlocksProvider(state, frozenRequest?.provider, null)
            ? 'meter_coverage_required' : 'evidence_builder_failed', state.revision);
        }
        if (typeof built?.refuse === 'string' && built.refuse.length > 0) return refusal(built.refuse, state.revision, [], built.detail);
        if (snapshotOnly && Object.hasOwn(options, 'readings')) built = fixtureReadings(clone(built), clone(options.readings));
        const decisionAt = now();
        const rollover = verifiedWeekAdvance(state, built, decisionAt);
        const decisionState = rollover?.applied === true ? rollover.state : state;
        const out = evaluateAdmission(built, decisionState, frozenRequest, decisionAt, ledgerAttemptCount);
        return {...publicOutcome(out), revision: state.revision};
      };
      // A pure preview neither joins nor publishes to the writer queue. Its result names the
      // exact state revision read; a later reservation must assess again, as it always has.
      return snapshotOnly ? assess() : enqueue(assess);
    },

    async admit({expectedRevision, request, context = null} = {}) {
      assertRevision(expectedRevision);
      guardCall();
      const frozenRequest = clone(request);
      const frozenContext = clone(context);
      // Fast refusal while Stop is pending. It does not wait behind a running launch, so it reports no revision.
      if (fenced()) return refusal('adapter_frozen', null);
      return enqueue(async () => {
        const state = readState();
        if (closed || fenced()) return refusal('adapter_frozen', state.revision);
        if (state.revision !== expectedRevision) return refusal('revision_conflict', state.revision);
        const at = now();
        let built;
        try {
          built = await callback(() => buildInput({state: clone(state), request: clone(frozenRequest),
            context: clone(frozenContext), now: at}));
        } catch {
          return refusal(rateFeedbackBlocksProvider(state, frozenRequest?.provider, null)
            ? 'meter_coverage_required' : 'evidence_builder_failed', state.revision);
        }
        // A builder that knows a fact is missing refuses by name. Nothing is persisted or dispatched.
        if (typeof built?.refuse === 'string' && built.refuse.length > 0) return refusal(built.refuse, state.revision, [], built.detail);
        const input = clone(built);
        if (closed || fenced()) return refusal('adapter_frozen', state.revision);
        // The decision time is read after the evidence is gathered: a probe stamps its readings when it finishes, so a time taken
        // before the build would place those readings after the decision and make them look stale.
        const decisionAt = now();
        const rollover = verifiedWeekAdvance(state, input, decisionAt);
        const decisionState = rollover?.applied === true ? rollover.state : state;
        const out = evaluateAdmission(input, decisionState, frozenRequest, decisionAt);
        // Pending feedback refuses the job without invalidating queued requests at this revision.
        if (!out.admitted && out.reason === 'meter_coverage_required')
          return {...publicOutcome(out), ...refusal(out.reason, state.revision)};
        // Exhausted saved headroom must not write even a verified week change.
        if (!out.admitted && input.admission_headroom_failure && out.reason === input.admission_headroom_failure)
          return {...publicOutcome(out), ...refusal(out.reason, state.revision)};
        if (rollover?.applied === true) {
          await commit(rollover.state, rollover.effects, state.revision, null);
        }
        if (!out.admitted) return {...publicOutcome(out), ...refusal(out.reason, decisionState.revision, out.effects)};
        const result = await commit(out.proposed_state, out.effects, decisionState.revision, frozenRequest.attempt_id);
        return {...publicOutcome(out), ...result, admitted: true};
      });
    },

    async transition(event, {expectedRevision} = {}) {
      assertRevision(expectedRevision);
      guardCall();
      return requestTransition(event, expectedRevision);
    },

    // Finish normally piggybacks model evidence on an accounting event. Zero-use
    // without cleanup and failed conversion have no such event. Record only the
    // missing metadata, on the serialized current revision and without advancing
    // the accounting watermark or dispatching provider-facing effects.
    async recordServedModel(attemptId, servedModel) {
      guardCall();
      const evidence = clone(servedModel);
      return enqueue(async () => {
        const state = readState();
        const attempt = state.attempts.find(row => row.id === attemptId);
        const merged = mergeServedModelEvidence(attempt?.served_model, evidence);
        if (attempt && JSON.stringify(attempt.served_model) === JSON.stringify(merged))
          return {applied: false, reason: 'already_recorded', revision: state.revision, effects: [], effects_dispatched: true};
        // Equality above is the retry guard. A genuinely improved report gets a
        // new event id even after an earlier fallback was recorded for this run.
        const out = transition(state, {type: 'served_model', event_id: `${attemptId}:served-model:r${state.revision}`,
          at: state.updated_at, attempt_id: attemptId, served_model: merged});
        if (!out.applied)
          return {applied: false, reason: out.reason, revision: state.revision, effects: [], effects_dispatched: false};
        return {applied: true, ...await commit(out.state, out.effects, state.revision, null)};
      });
    },

    // Backend observations, for example a process that starts or exits while a handler is running. A call made from
    // inside a handler is queued behind that handler and applied, in order, after it returns. The handler is not made
    // to wait, because waiting would deadlock the queue it is running in. Outside a handler this behaves like transition.
    async deliver(event) {
      if (inCallback()) {
        if (closed) return Promise.resolve({queued: false, reason: 'pace50_closed'});
        if (poisoned) return Promise.resolve({queued: false, reason: 'pace50_store_poisoned'});
        requestTransition(event, null).then(
          (result) => recordDeferred(result),
          (error) => recordDeferred({applied: false, error: error.message}));
        return Promise.resolve({queued: true});
      }
      guardCall();
      return requestTransition(event, null);
    },

    // Outcomes of deliveries that were queued behind a handler. Bounded, and a copy.
    deferredResults() {
      return clone(deferred);
    },

    // Startup recovery. A crash can leave work running that this process never recorded, including a launch that reached
    // the backend and was not acknowledged. So every unceased attempt is asked to cease, whatever its stored state. This
    // never launches, opens or releases. Only a cessation proof releases exposure. Identifiers depend on the attempt and
    // the control, not on the revision, so a repeated request is the same request.
    async recover() {
      guardCall();
      return enqueue(async () => {
        const state = readState();
        const pending = new Map();
        for (const attempt of state.attempts) {
          if (attempt.process_state === 'ceased') continue;
          const want = (type) => pending.set(`${type}:${attempt.id}`, {type, attempt_id: attempt.id});
          want('request_cessation');
          if (attempt.process_state === 'cancel_requested') want('cancel_pending_attempt');
          if (attempt.late_ack_unresolved) want('request_fresh_complete_reconciliation');
        }
        const effects = [...pending.values()].map((effect) => ({...effect, reason: 'recovery'}));
        const results = await runEffects(effects, state, (index, effect) => `recover:${effect.type}:${effect.attempt_id}`);
        return {revision: state.revision, effects: results};
      });
    },

    // Waits up to drainMs for queued work, then releases in-process deadlines and the lock. It reports
    // unfinished attempts: work may still be running, so the caller must stop it first.
    close({drainMs = 100} = {}) {
      if (closing) return closing;
      if (inCallback()) return Promise.reject(coded('pace50_reentrant_call'));
      closed = true;
      // A handler that never returns cannot hold the lock or the process open: at the bound the lock is released, and a task that
      // was still queued refuses before it writes.
      closing = settleWithin(queue, drainMs).then(() => {
        released = true;
        let liveAttempts = null;
        try {
          liveAttempts = readState().attempts.filter((a) => a.process_state !== 'ceased')
            .map((a) => ({id: a.id, launch_state: a.launch_state, process_state: a.process_state}));
        } catch { /* unreadable state is reported by the next open */ }
        const failures = [];
        for (const key of [...armed.keys()]) {
          try { disposeArm(key); } catch (error) { failures.push(error); }
        }
        expectedArms.clear();
        release();
        if (failures.length) throw failures[0];
        return {live_attempts: liveAttempts};
      });
      return closing;
    },
  };
}
