import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateBuildInput} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {MICRO, NOW} from './helpers/pace50-fixtures.mjs';

// The owner's strategy and its numbers travel from the policy context into the objective the allocator decides from, beside
// the protection position they already travel with. The owner's dollar cap comes from the request as before. Synthetic only.
test('the candidate objective carries the owner strategy, its numbers and the owner cap', async () => {
  const source = createSyntheticPace50Source({start: NOW});
  // A plain builder: this test is about the context reaching the objective, not about the objective's contents.
  const build = candidateBuildInput({source, objectiveInputFor: async () => ({owner: {scenarios: []}, job: {friendValue: 1}})});
  const request = {job_id: 'job-1', model: 'claude-haiku-5-5', plan: 'max20', requested_usd_micro: 3 * MICRO,
    worst_call_usd_micro: 1_320_000, wall_ms: 60_000, stop_ms: 60_000, uncertainty_ms: 30_000, owner_max_job_usd_micro: 2 * MICRO};
  const context = {provider: 'claude', protectionPosition: 'balanced', plan: 'max20', consent: true,
    strategy: 'fixed_share', strategyParams: {fixedSharePct: 20, keepPct: 30, perJobPct: 5}};
  const built = await build({state: {account: 'synthetic-account'}, request, now: NOW, context});
  assert.equal(built.refuse, undefined, built.refuse);
  assert.equal(built.objective.position, 'balanced');
  assert.equal(built.objective.strategy, 'fixed_share');
  assert.deepEqual(built.objective.strategyParams, {fixedSharePct: 20, keepPct: 30, perJobPct: 5});
  assert.equal(built.objective.ownerMaxJobUsdMicro, 2 * MICRO);
});

test('a reading taken during the build is never later than the time the objective is judged at', async () => {
  // A probe that runs inside the build stamps its readings when it finishes, after the build started.
  const source = createSyntheticPace50Source({start: NOW + 40_000});
  let judgedAt = null;
  const build = candidateBuildInput({source, clock: () => NOW + 41_000,
    objectiveInputFor: async ({now}) => { judgedAt = now; return {owner: {scenarios: []}, job: {friendValue: 1}}; }});
  const request = {job_id: 'job-1', model: 'claude-haiku-5-5', plan: 'max20', requested_usd_micro: 3 * MICRO,
    worst_call_usd_micro: 1_320_000, wall_ms: 60_000, stop_ms: 60_000, uncertainty_ms: 30_000, owner_max_job_usd_micro: 2 * MICRO};
  const built = await build({state: {account: 'synthetic-account'}, request, now: NOW, context: {provider: 'claude', consent: true}});
  assert.equal(built.refuse, undefined, built.refuse);
  assert.equal(judgedAt, NOW + 41_000, 'judged after the reading, not at the build start');
});

test('manual and automatic admissions use cached evidence without forcing a probe as it ages', async () => {
  // The former fixed one-minute expiry no longer triggers admission-side probes.
  const synthetic = createSyntheticPace50Source({start: NOW});
  const readAt = async (args, at) => {
    const observed = await synthetic.observe(args);
    return {...observed, resources: observed.resources.map((r) => ({...r, observed_at: at}))};
  };
  const request = {job_id: 'job-2', model: 'claude-haiku-5-5', plan: 'max20', requested_usd_micro: 3 * MICRO,
    worst_call_usd_micro: 1_320_000, wall_ms: 60_000, stop_ms: 60_000, uncertainty_ms: 30_000, owner_max_job_usd_micro: 2 * MICRO};
  for (const automatic of [false, true]) {
    const forced = [];
    const source = {...synthetic, observe: async (args) => { forced.push(args.forceRefresh === true); return readAt(args, args.forceRefresh ? NOW + 1_500 : NOW - 59_300); }};
    let judged = null;
    const build = candidateBuildInput({source, clock: () => NOW + 2_200,
      objectiveInputFor: async ({input}) => { judged = input.windows.map((w) => w.observed_at); return {owner: {scenarios: []}, job: {friendValue: 1}}; }});
    await build({state: {account: 'synthetic-account'}, request, now: NOW, context: {provider: 'claude', consent: true, automatic}});
    assert.deepEqual(forced, [false], 'neither approval mode refreshes from the admission read');
    assert.ok(judged.every(at => at === NOW - 59_300), 'the cached reading is retained for headroom assessment');
  }
});
