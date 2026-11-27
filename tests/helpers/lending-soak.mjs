import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createPace50Candidate} from '../../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK} from './pace50-fixtures.mjs';

export const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export const holdOpen = row => row.process_state !== 'ceased' || row.hold_closed === false;
export const KNOWN_FAILURES = Object.freeze({
  // Each flag guards one behavioral assertion. A newly passing assertion is an error.
  measurement_throw: true,
  measurement_drop: true,
});
export async function invariant(t, flag, incident, check) {
  if (process.env.SOAK_STRICT === '1' || !KNOWN_FAILURES[flag]) return check();
  let failure;
  try { await check(); } catch (error) {
    if (error.code !== 'ERR_ASSERTION' || !error.message.includes(incident)) throw error;
    failure = error;
  }
  assert.ok(failure, `KNOWN_FAILURE ${flag} now passes; remove its flag (${incident})`);
  t.diagnostic(`KNOWN_FAILURE ${flag}: ${failure.message.split('\n')[0]}`);
}

export function rig(t, options = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'lending-soak-'));
  const clock = {at: NOW}, rows = [], trace = [], running = new Set();
  let sequence = 0, sinkCalls = 0, pace;
  const meter = {age: 0, fail: false, native: false, reads: 0, used: 14_000_000};
  const source = createSyntheticPace50Source({start: NOW, used: {weekly: meter.used, short: meter.used},
    override: ({base, now}) => {
      meter.reads++;
      if (meter.fail) return {...base, refresh_succeeded: false, complete: false, resources: [], probe: {reason:'guest_failed'}};
      const resources = base.resources.map(row => {
        const duration = row.kind === 'weekly' ? 7 * DAY : 5 * HOUR;
        const firstReset = NOW + (row.kind === 'weekly' ? 42 * HOUR : 1.25 * HOUR);
        const n = Math.max(0, Math.floor((now - firstReset) / duration) + 1);
        return {...row, instance: `${row.id}-${n}`, anchor_at: firstReset + n * duration - duration,
          resets_at: firstReset + n * duration, observed_at: now - meter.age,
          used_micro: meter.used, owner_used_micro: meter.used,
          ...(meter.native ? {conversion:'native_window', kappa_micro:null, kappa_lower_micro:null} : {})};
      });
      return {...base, account_week_id: `${base.identity.account_id}:weekly:${resources.find(r => r.kind === 'weekly').resets_at}`,
        observed_at: now - meter.age, resources};
    }});
  const open = () => createPace50Candidate({directory, source, now: () => clock.at, account: ACCOUNT,
    account_week_id: WEEK, effectOverrides: {arm_cessation_deadline: async () => () => {}}, pendingRecords: () => [],
    nativeGuard: {setTimer: () => 1, clearTimer: () => {}},
    measurementHistory: {record(type, data) {
      sinkCalls++;
      if (options.sink === 'throw' && sinkCalls % 10 === 0) throw new Error('injected measurement failure');
      if (options.sink !== 'drop' || sinkCalls % 10 !== 0) rows.push({type, data});
      return `row-${sinkCalls}`;
    }}, ...options.candidate});
  pace = open();
  t.after(async () => {await pace.candidate.cancelObservations(); await pace.adapter.close(); fs.rmSync(directory, {recursive:true, force:true});});
  const api = {
    directory, clock, meter, rows, trace, running, source,
    get pace() {return pace;},
    args(id = `job-${sequence++}`, patch = {}) {
      return {attemptId:id, jobId:id, provider:'claude', model:'claude-haiku-5-5', automatic:false, ownerAbsent:true,
        job:{budget_v1:{max_list_usd:10}, requirements:{limits:{wall_seconds:60}},
          expires_at:new Date(clock.at + DAY).toISOString()}, ...patch};
    },
    async reserve(args = api.args()) {
      const out = await pace.candidate.reserve(args);
      trace.push([clock.at, 'reserve', args.attemptId, out.ok, out.policyReason ?? out.reason ?? null]);
      return out;
    },
    async restart() {
      const before = pace.adapter.state();
      await pace.candidate.cancelObservations(); await pace.adapter.close(); pace = open();
      assert.deepEqual(pace.adapter.state(), before, 'I7 restart preserves all durable fields');
    },
    async step(label, action, advance = MINUTE) {
      clock.at += advance;
      const out = await action();
      await pace.candidate.probeHeld();
      const state = pace.adapter.state();
      assert.ok(Number.isSafeInteger(state.revision));
      for (const row of state.attempts) {
        for (const resource of row.resources) assert.ok(resource.held_micro >= 0 && resource.spent_micro >= 0, `I2 ${label}: negative quota`);
        if (row.hold_closed === true) assert.ok(row.resources.every(r => r.held_micro === 0), `I1 ${label}: closed hold retains quota`);
      }
      trace.push([clock.at, label, state.revision, state.attempts.filter(holdOpen).length]);
      return out;
    },
    hash() {return createHash('sha256').update(JSON.stringify(trace)).digest('hex');},
  };
  return api;
}
