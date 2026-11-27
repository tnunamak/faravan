import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, WEEK, NOW, request, ordinaryInput} from './helpers/pace50-fixtures.mjs';

function candidate(t, {ownerSettings = null, effects} = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'independent-pace50-'));
  const source = createSyntheticPace50Source({start: NOW});
  const opened = createPace50Candidate({directory, now: () => NOW, account: ACCOUNT, account_week_id: WEEK,
    source, ownerSettings, ...(effects ? {effects} : {})});
  t.after(async () => {await opened.adapter.close(); fs.rmSync(directory, {recursive: true, force: true});});
  return {...opened, source};
}
const args = {attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: 'claude-haiku-5-5',
  job: {budget_v1: {max_list_usd: 4}, requirements: {limits: {wall_seconds: 300}}}, automatic: true, ownerAbsent: true};
const effects = () => ({arm_cessation_deadline: async () => () => {}, launch_chunk: async () => {},
  open_short_window: async () => {}, cancel_pending_attempt: async () => {}, request_cessation: async () => {},
  request_fresh_complete_reconciliation: async () => {}});

test('saved stricter cap constrains the executable budget as well as its reservation', async (t) => {
  // M1 owner dollar caps replace the retired hourly-rate chunk cap.
  const r = candidate(t, {ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 4})}});
  const grant = await r.candidate.reserve(args);
  assert.equal(grant.ok, true);
  const ledger = r.adapter.state().attempts[0].resources.find(r => r.kind === 'weekly');
  const allowedBudgetMicro = Math.floor(ledger.initial_micro * 1e6 / ledger.kappa_micro) - 1320000; // exact fixture headroom
  console.log(JSON.stringify({probe: 'budget', reserved: ledger.initial_micro, allowedBudgetMicro,
    guardBudget: grant.lendingBudget.budget.limit}));
  assert.ok(Math.round(grant.lendingBudget.budget.limit * 1e6) <= allowedBudgetMicro, 'guard limit must not exceed the admitted quote');
});

test('a failed deadline arm refuses the executable grant', async (t) => {
  let launches = 0;
  const handlers = {...effects(), arm_cessation_deadline: async () => {throw new Error('injected arm failure');},
    launch_chunk: async () => {launches++;}};
  const r = candidate(t, {effects: handlers});
  const grant = await r.candidate.reserve(args);
  console.log(JSON.stringify({probe: 'arm', grantOk: grant.ok, launches,
    authorized: r.candidate.registry.entry(args.attemptId).authorized}));
  assert.equal(launches, 0);
  assert.equal(grant.ok, false, 'failed arm/launch effects must not authorize the real lender');
  const attempt=r.adapter.state().attempts[0];
  assert.equal(attempt.process_state,'ceased','the current reserve path proves preparation never began');
  assert.equal(attempt.hold_closed,true);
  assert.ok(attempt.resources.every(r=>r.spent_micro===0&&r.held_micro===0&&r.unrepresented_micro===0&&
    r.released_micro===r.initial_micro),'failed arming releases only its proven absent reservation');
});

test('a slow evidence read cannot bypass the production deadline gate', async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'independent-expired-arm-'));
  let now = NOW;
  const source = createSyntheticPace50Source({start: NOW});
  const observe = source.observe;
  source.observe = async input => {
    const reading = await observe(input);
    now = NOW + 65 * 60000; // pass the actual borrower deadline while gathering evidence
    return reading;
  };
  const r = createPace50Candidate({directory, now: () => now, account: ACCOUNT, account_week_id: WEEK, source});
  const grant = await r.candidate.reserve({...args, job:{...args.job, expires_at:new Date(NOW + 60 * 60000).toISOString()}});
  const authorized = r.candidate.registry.entry(args.attemptId).authorized;
  await r.adapter.close(); fs.rmSync(directory, {recursive: true, force: true});
  console.log(JSON.stringify({probe: 'expired-production-arm', grantOk: grant.ok, authorized}));
  assert.equal(authorized, false, 'production launch effect was correctly fenced');
  assert.equal(grant.ok, false, 'the candidate must preserve the production gate refusal');
  assert.equal(grant.policyReason, 'deadline', 'the refusal comes from the borrower deadline, not reading age');
});

test('cleanup alone cannot certify usage reconciliation for a started attempt', async (t) => {
  const r = candidate(t);
  assert.equal((await r.candidate.reserve(args)).ok, true);
  await r.candidate.started(args.attemptId, {ok: true});
  r.source.state.used.weekly += 125000; // independently observed provider spend
  r.source.state.used.short += 500000;
  r.candidate.recordCleanup(args.attemptId, {removed: true});
  await r.candidate.release(args.attemptId, {reason: 'execution_failed', prepared: true});
  const ledger = r.adapter.state().attempts[0].resources.find(r => r.kind === 'weekly');
  console.log(JSON.stringify({probe: 'error-release', actualSpend: 125000, ...ledger}));
  assert.ok(ledger.spent_micro + ledger.settled_micro + ledger.held_micro >= 125000,
    'unknown usage must remain charged or held after cleanup');
});

test('a completed run with missing usage must keep exposure rather than infer zero', async (t) => {
  const r = candidate(t);
  assert.equal((await r.candidate.reserve(args)).ok, true);
  await r.candidate.started(args.attemptId, {ok: true});
  r.candidate.recordCleanup(args.attemptId, {removed: true});
  const result = await r.candidate.finish({attemptId: args.attemptId, provider: 'claude',
    model: args.model, execution: {stdout: '', lending_meter: null}});
  const attempt = r.adapter.state().attempts[0];
  console.log(JSON.stringify({probe: 'missing-meter', result, attempt}));
  assert.ok(attempt.resources.some(r => r.held_micro > 0), 'missing usage is not authoritative zero');
});

test('close cannot wait forever behind a hung recovery handler', async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'independent-close-'));
  let unblock;
  const hold = new Promise(resolve => {unblock = resolve;});
  const adapter = createPace50Adapter({directory, account: ACCOUNT, account_week_id: WEEK,
    now: () => NOW, buildInput: async ({now}) => ordinaryInput({now}),
    effects: {...effects(), request_cessation: async () => hold}});
  assert.equal((await adapter.admit({expectedRevision: 0, request: request()})).admitted, true);
  const recovery = adapter.recover();
  const closing = adapter.close();
  let bound;
  const outcome = await Promise.race([closing.then(() => 'closed'),
    new Promise(resolve => {bound = setTimeout(() => resolve('blocked'), 150);})]);
  clearTimeout(bound);
  unblock(); await recovery; await closing;
  fs.rmSync(directory, {recursive: true, force: true});
  console.log(JSON.stringify({probe: 'close', outcome}));
  assert.equal(outcome, 'closed', 'close needs a bound independent of the handler queue');
});

for (const missing of ['identity', 'funding']) test(`${missing} unknown is a positive fail-closed control`, async (t) => {
  const r = candidate(t);
  const observe = r.source.observe;
  r.source.observe = async input => {const out = await observe(input);
    if (missing === 'identity') out.identity = {verified: false};
    else out.funding = {subscription_only: 'unknown'};
    return out;};
  const grant = await r.candidate.reserve(args);
  assert.equal(grant.ok, false);
  assert.equal(r.adapter.state().attempts.length, 0);
  assert.equal(r.candidate.registry.entry(args.attemptId).authorized, false);
});
