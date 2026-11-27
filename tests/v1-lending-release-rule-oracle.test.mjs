import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createEstimatedPace50State, evaluateEstimatedPace50, transitionEstimatedPace50State, executionProvenAbsent}
  from '../lib/v1/lending-policy.mjs';
import {RESET_JITTER_MS as J} from '../lib/v1/window-origin.mjs';
import {ordinaryInput, request, weekly, short, ACCOUNT, WEEK, NOW, HOUR_MS, DAY_MS}
  from './helpers/pace50-fixtures.mjs';

// An independent release oracle, not a copy of lateCarryBound or a check of its
// return value. All state comes from admission or accepted public reducer events.
// "none" adds no evidence after C is recorded; "cleanup only" re-presents that
// same cleanup receipt (a duplicate is not a newer cessation time).
// The reset event's authoritative_cessation flag is not durable C: once C exists it cannot
// shorten C+D; with no C it settles a warm, non-late window at its reset.
// This is a reducer contract test, not a claim about every runtime call site.
const KINDS = ['warm short', 'warm weekly', 'cold short'];
const LATES = ['not late', 'late unresolved', 'carried successor'];
const POSITIONS = ['none', 'R-J-1', 'R-J', 'R-1', 'R', 'R+1'];
const EVIDENCE = ['none', 'reset proof', 'cleanup only', 'absence only', 'covering reading'];
const TIMES = ['R-1', 'R', 'C+D-1', 'max(R,C+D)'];
const allRows = [];
const duration = kind => kind === 'warm weekly' ? 7 * DAY_MS : 5 * HOUR_MS;
const cAt = (position, R) => ({
  none: null, 'R-J-1': R - J - 1, 'R-J': R - J, 'R-1': R - 1, R, 'R+1': R + 1,
})[position];
const display = (at, R) => at === null ? 'none' : `R${at < R ? '' : '+'}${at - R}`;
const liability = resource => resource.held_micro + resource.unrepresented_micro;

function allowedAt(kind, R, D, C, noUse, attempt, late) {
  // A reservation that never launched, with verified sandbox cleanup (C) and a zero-use attestation, releases at once (ship's
  // unstarted-reservation rule). Without C the claim is unproved and nothing releases.
  if (noUse) return C === null ? Infinity : -Infinity;
  // No durable cessation proof: the reset event's own authoritative_cessation settles a warm window at its reset (ship's
  // rule, see v1-lending-account-week-rollover); a cold-open window below still needs its reading proof.
  // A late run with no carry is refused (late_carry_required) until a carry or a durable bound exists.
  if (C === null && kind !== 'cold short' && late !== 'late unresolved') return R;
  if (C === null) return Infinity;
  // A cold-open window settles only through a reading-backed reset proof (coldWindowResetProven); this oracle's events carry no
  // such reading, so a cold hold must never release here, whatever the deadline.
  if (kind === 'cold short') return Infinity;
  return kind !== 'cold short' && late === 'not late' && C < R - J ? R : Math.max(R, C + D);
}

function admission(kind, sourceReset) {
  const at = sourceReset - (kind === 'cold short' ? 5 * HOUR_MS : HOUR_MS);
  const native = {conversion: 'native_window', kappa_micro: null, used_micro: 0};
  const target = kind === 'warm weekly'
    ? weekly(at, {...native, id: 'seven_day', instance: 'oracle-week',
      resets_at: sourceReset, anchor_at: sourceReset - duration(kind)})
    : short(at, {...native, id: 'five_hour', instance: 'oracle-short',
      resets_at: sourceReset, anchor_at: sourceReset - duration(kind),
      ...(kind === 'cold short' ? {cold_open: true, origin: 'cold'} : {})});
  // A short-resource admission still requires a weekly mapping. Its unrelated
  // weekly hold does not expire during this case and cannot mask target timing.
  const windows = kind === 'warm weekly' ? [target] : [
    weekly(at, {...native, id: 'seven_day', instance: 'oracle-companion',
      resets_at: sourceReset + 2 * DAY_MS, anchor_at: sourceReset + 2 * DAY_MS - 7 * DAY_MS}),
    target,
  ];
  const input = ordinaryInput({now: at, windows});
  input.weekly_resource_id = 'seven_day';
  input.state = createEstimatedPace50State({account: ACCOUNT, account_week_id: WEEK});
  input.request = request({attempt_id: 'oracle', job_id: 'oracle-job', wall_ms: 1000,
    stop_ms: 1000, uncertainty_ms: 0, expires_at: sourceReset + 10 * DAY_MS,
    provider: 'claude', model: 'claude-sonnet-5-5'});
  input.objective.job.requestedUsdMicro = input.request.requested_usd_micro;
  // The same invented, zero-owner-demand fixture used by the existing tests.
  // Native mode takes its reservation from the actual admission allocator.
  const out = evaluateEstimatedPace50(input);
  assert.equal(out.admitted, true, `fixture admission: ${out.reason}`);
  return {state: out.proposed_state, targetId: target.id, createdAt: at,
    sequence: [`admit(${target.id},R0=${sourceReset})@${at}`]};
}

function construct(kind, late, position, evidence, label) {
  const D = duration(kind), sourceReset = NOW + 5 * HOUR_MS;
  const R = late === 'carried successor' ? sourceReset + D : sourceReset;
  const C = cAt(position, R);
  // With no C the two C-relative slots have no time. Do not silently substitute R.
  const at = label === 'R-1' ? R - 1 : label === 'R' ? R
    : C === null ? null : label === 'C+D-1' ? C + D - 1 : Math.max(R, C + D);
  const row = {kind, late, C: position, evidence, time: label, at: display(at, R)};
  const f = admission(kind, sourceReset);
  let targetAttempt = 'oracle', cleanupEvent = null;
  const stop = reason => ({...row, status: 'UNCONSTRUCTIBLE', reason, sequence: f.sequence.join(' > ')});
  const emit = (type, when, extra = {}, required = true) => {
    const event = {type, event_id: `oracle:${type}:${f.sequence.length}`, attempt_id: 'oracle',
      at: when, ...extra};
    const out = transitionEstimatedPace50State(f.state, event, {postingLagBoundMs:evidence==='covering reading'?J:undefined});
    f.sequence.push(`${type}@${display(when, R)}[${out.reason}]`);
    if (required) assert.equal(out.applied, true, `fixture ${type}: ${out.reason}`);
    f.state = out.state;
    return {out, event};
  };
  if (at === null) return stop('C-relative evaluation time is undefined without durable C');
  if (evidence === 'reset proof')
    return stop('This base exports no resource reset-proof/omission-proof event; window_reset_settled accepts no proof payload');
  if (evidence === 'cleanup only' && C === null)
    return stop('An accepted cleanup proof itself creates C, so cleanup-only with no C is inconsistent');
  if (evidence === 'absence only' && late !== 'not late')
    return stop('A started or carried attempt cannot be a proven never-started reservation');

  // Absence means an explicit authoritative zero-use/cessation attestation for
  // a reservation for which no launch event was issued. Merely launch_state
  // reserved, or owner_absent, is not used as evidence.
  const noUse = evidence === 'absence only';
  if (!noUse) emit('launch_result', f.createdAt + 1, {result: 'started'});

  if (late === 'carried successor') {
    if (kind === 'warm weekly' && C === null)
      return stop('Public weekly carry requires prior durable cleanup; a weekly successor with no original C cannot be built');
    emit('late_ack', sourceReset, C === null ? {} : {authoritative_cessation: true});
    if (kind === 'warm weekly')
      emit('cleanup_proven', sourceReset, {event_id: 'oracle:cleanup-proven:carry', cleanup_removed: true});
    const original = f.state.attempts.find(a => a.id === 'oracle');
    const source = original.resources.find(r => r.id === f.targetId);
    const cur = {id: source.id, kind: source.kind, instance: 'oracle-successor',
      epoch: original.epoch, anchor_at: sourceReset, resets_at: R,
      duration_ms: D, kappa_micro: null, used_micro: 0};
    const accountWeek = kind === 'warm weekly' ? `${ACCOUNT}:weekly:${R}` : WEEK;
    const carried = emit('late_start_carried', sourceReset, {epoch: original.epoch, account: ACCOUNT,
      account_week_id: accountWeek, identity_verified: true, complete: true, refresh_succeeded: true,
      observed_at: sourceReset, carries: [{from_id: source.id, from_instance: source.instance, resource: cur}],
      ...(kind === 'warm weekly' ? {weekly_mapping: {account: ACCOUNT, account_week_id: accountWeek,
        epoch: original.epoch, observed_at: sourceReset, resource_id: cur.id, instance: cur.instance,
        anchor_at: cur.anchor_at, resets_at: cur.resets_at}} : {})}, kind !== 'cold short');
    // A cold-open window carries only with a verified post-cleanup reading (coldWindowResetProven); the oracle's
    // carry event has none, so the reducer's refusal is the rule under test, not a fixture error.
    if (kind === 'cold short' && !carried.out.applied) {
      assert.equal(carried.out.reason, 'cold_window_unresolved');
      return stop('A cold-open window cannot carry without a verified post-cleanup reading');
    }
    targetAttempt = `oracle:carry:${source.id}:${source.instance}`;
    if (C !== null) {
      // The later original-attempt event is the durable upper bound inherited
      // by the successor. Never stamp the successor with an invented cleanup.
      emit('late_ack', C, {authoritative_cessation: true});
      if (['cleanup only','covering reading'].includes(evidence))
        cleanupEvent = emit('cleanup_proven', C,
          {event_id: 'oracle:cleanup-proven:original', cleanup_removed: true}).event;
    }
  } else {
    if (late === 'late unresolved') emit('late_ack', f.createdAt + 2);
    if (C !== null) {
      cleanupEvent = emit('cleanup_proven', C,
        {event_id: 'oracle:cleanup-proven:original', cleanup_removed: true}).event;
    }
    const original = f.state.attempts.find(a => a.id === 'oracle');
    if (late === 'not late' && original.late_ack_unresolved)
      return stop('cleanup_proven automatically marks this overlapping C late; public events cannot preserve not-late');
  }
  if (at < f.state.updated_at)
    return stop('Evaluation precedes durable C/carry; reducer forbids backward event time');

  if (cleanupEvent && evidence === 'cleanup only') {
    // Repeating an existing proof changes neither C nor late state.
    const duplicate = transitionEstimatedPace50State(f.state, cleanupEvent);
    assert.equal(duplicate.reason, 'duplicate_event');
    f.sequence.push('cleanup_receipt_replayed[duplicate_event]');
  }
  const beforeResource=f.state.attempts.find(a=>a.id===targetAttempt).resources.find(r=>r.id===f.targetId);
  const beforeHeld=beforeResource.held_micro,beforeRefund=beforeResource.released_micro;
  if (evidence==='covering reading') {
    const target=f.state.attempts.find(a=>a.id===targetAttempt);
    emit('usage_covered',at,{attempt_id:targetAttempt,account:ACCOUNT,account_week_id:target.account_week_id,epoch:target.epoch,
      complete:true,compatible:true,refresh_succeeded:true,observed_at:at,
      resources:target.resources.map(r=>({id:r.id,instance:r.instance,anchor_at:r.anchor_at,resets_at:r.resets_at,used_micro:r.baseline_used_micro+1000000}))},false);
    if(at>=R)emit('window_reset_settled',at,{attempt_id:targetAttempt,resource_ids:[f.targetId],authoritative_cessation:true},false);
  } else if (noUse) {
    const original = f.state.attempts.find(a => a.id === 'oracle');
    if (original.launch_state !== 'reserved')
      return stop('No public proof establishes never-started for this launch state');
    // Without a durable cleanup proof (C) the absence of execution is unproved: the reducer refuses with
    // usage_unknown and the hold stays, which allowedAt() also expects (C === null never releases).
    const absence = emit('cessation_proven', at, {authoritative_cessation: true, usage_reconciled: true,
      zero_use_attested: true}, C !== null);
    if (C === null) assert.equal(absence.out.reason, 'usage_unknown');
  } else {
    emit('window_reset_settled', at, {attempt_id: targetAttempt,
      resource_ids: [f.targetId], authoritative_cessation: true}, false);
  }
  const resource = f.state.attempts.find(a => a.id === targetAttempt).resources.find(r => r.id === f.targetId);
  const released = liability(resource) === 0, allowed = allowedAt(kind, R, D, C, noUse, f.state.attempts.find(a => a.id === targetAttempt), late);
  let status = released && at < allowed ? 'EARLY' : !released && at >= allowed ? 'DEAD' : 'PASS';
  if(evidence==='covering reading'&&at<R){
    const qualifies=kind!=='cold short'&&C!==null&&C<R-J&&at>=C+J;
    const expected=qualifies?Math.max(0,beforeHeld-Math.max(0,2000000-(beforeResource.spent_micro+beforeResource.settled_micro))):0;
    const actual=resource.released_micro-beforeRefund;
    status=actual>expected?'EARLY':actual<expected?'DEAD':'PASS';
  }
  return {...row, status, allowed: Number.isFinite(allowed) ? display(allowed, R) : String(allowed),
    liability: liability(resource), sequence: f.sequence.join(' > ')};
}

function table(rows) {
  return ['kind | late state | C | evidence | time | result | allowed/reason | event sequence',
    ...rows.map(r => [r.kind, r.late, r.C, r.evidence, `${r.time} (${r.at})`, r.status,
      r.reason ?? `${r.allowed}; liability=${r.liability}`, r.sequence].join(' | '))].join('\n');
}

// Nine top-level tests, each with a complete 96-row case table. Gather failures
// before asserting so one red boundary never prevents the other cases running.
for (const kind of KINDS) for (const late of LATES) {
  test(`lending release-rule oracle: ${kind} / ${late}`, async t => {
    const rows = [];
    for (const position of POSITIONS) for (const evidence of EVIDENCE) for (const time of TIMES)
      rows.push(construct(kind, late, position, evidence, time));
    allRows.push(...rows);
    const failures = rows.filter(r => r.status === 'EARLY' || r.status === 'DEAD');
    const unconstructible = rows.filter(r => r.status === 'UNCONSTRUCTIBLE');
    t.diagnostic(`cases=${rows.length}; PASS=${rows.filter(r => r.status === 'PASS').length}; EARLY=${failures.filter(r => r.status === 'EARLY').length}; DEAD=${failures.filter(r => r.status === 'DEAD').length}; UNCONSTRUCTIBLE=${unconstructible.length}`);
    t.diagnostic(table(unconstructible));
    assert.equal(failures.length, 0, '\n' + table(failures));
  });
}
process.on('exit', () => {
  const counts = Object.fromEntries(['PASS', 'EARLY', 'DEAD', 'UNCONSTRUCTIBLE']
    .map(status => [status, allRows.filter(row => row.status === status).length]));
  console.log('RELEASE_ORACLE_TOTALS ' + JSON.stringify({cases: allRows.length, expected: 1080, pass: counts.PASS, fail: counts.EARLY+counts.DEAD, knownRed: 0, changedLateHistoryExpectations:allRows.filter(row=>row.status!=='UNCONSTRUCTIBLE'&&row.kind.startsWith('warm')&&row.late!=='not late'&&row.C==='R-J-1').length, changedNoUseExpectations: allRows.filter(row => row.evidence==='absence only'&&row.status!=='UNCONSTRUCTIBLE').length, ...counts}));
});
