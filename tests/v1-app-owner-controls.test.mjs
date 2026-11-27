import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {lendableModelsFor, minimumMaxJobUsdForModel} from '../lib/v1/lender-pace50.mjs';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';

// The owner's controls, end to end through the operations API (POST /api/ops/<id>), in a running app with the candidate on.
// Consequential controls need confirmation on every surface; the reads show what was saved and audited.
const evidence = () => ({source: createSyntheticPace50Source({start: Date.now()}), account_week_id: 'synthetic-week-1'});
const CODEX_RUN = {model: 'gpt-6-sol'};
const gitInput = (circle) => ({circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40),
  prompt: 'Synthetic task: write a greeting. No external execution.', harness: 'codex'});
const CONFIRM = {'faravan-confirm': 'yes'};
const call = (app, id, body = {}, headers = {}, status = 200) => api(app, '/api/ops/' + id, {method: 'POST', body, headers, status});

async function lendAutomatically(lender, circle) {
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
}

test('the owner sets the saved limit through the operations API: confirmation is required, the change is audited, and a bad value is refused', {timeout: 180000}, async (t) => {
  const f = await appFixture(t);
  const {lender} = await f.connect({lendingPace50: evidence(), codexRun: CODEX_RUN});
  const unconfirmed = await call(lender.app, 'lending.set_owner_settings', {maxJobUsd: 2, reason: 'owner decision'}, {}, 428);
  assert.equal(unconfirmed.code, 'confirmation_required');
  const before = await call(lender.app, 'lending.owner_settings', {});
  assert.equal(before.values, null, 'nothing is saved without confirmation');
  const haiku = before.minimums.find(row => row.model === 'claude-haiku-5-5');
  assert.equal(haiku.minimumMaxJobUsd, minimumMaxJobUsdForModel('claude-haiku-5-5'));
  assert.ok(haiku.minimumMaxJobUsd * 1_000_000 > Math.ceil(claudeCallHeadroomUsd('claude-haiku-5-5') * 1_000_000),
    'Haiku minimum clears the engine worst-call bound');
  assert.deepEqual(before.minimums.map(row => row.model), lendableModelsFor('claude'));
  await call(lender.app, 'lending.set_owner_settings', {maxJobUsd: 0, reason: 'owner decision'}, CONFIRM, 400);
  const saved = await call(lender.app, 'lending.set_owner_settings', {maxJobUsd: 2, reason: 'owner decision'}, CONFIRM);
  assert.equal(saved.values.maxJobUsd, 2);
  assert.equal(saved.audit.at(-1).by, 'owner');
  assert.deepEqual(await call(lender.app, 'lending.owner_settings', {}), saved, 'the read shows what was saved and the engine minimums');
});

test('the owner allows one job through the operations API: it is listed, audited, and a bad request is refused', {timeout: 180000}, async (t) => {
  const f = await appFixture(t);
  const {lender} = await f.connect({lendingPace50: evidence(), codexRun: CODEX_RUN});
  const digest = 'sha256:' + 'b'.repeat(64);
  await call(lender.app, 'lending.allow_once', {digest, reason: 'run this one now', minutes: 45}, CONFIRM, 400);
  await call(lender.app, 'lending.allow_once', {digest: 'job-1', reason: 'run this one now'}, CONFIRM, 400);
  await call(lender.app, 'lending.allow_once', {digest, reason: 'run this one now', minutes: 15}, {}, 428);
  const granted = await call(lender.app, 'lending.allow_once', {digest, reason: 'run this one now', minutes: 15}, CONFIRM);
  assert.deepEqual(granted.active.map((entry) => entry.job_id), [digest], 'the one job is listed as allowed');
  assert.deepEqual(granted.audit.map((entry) => entry.event), ['requested'], 'the request is audited');
  assert.deepEqual((await call(lender.app, 'lending.presence', {})).active.map((entry) => entry.job_id), [digest]);
});

test('the owner attests a window the lender has seen open, and an unseen window is refused', {timeout: 180000}, async (t) => {
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect({lendingPace50: evidence(), codexRun: CODEX_RUN});
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}}); // the owner is away
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  const seen = await waitFor(async () => {
    const view = await call(lender.app, 'lending.window_origins', {});
    return view.seen.length ? view : null;
  }, 'the lender saw an open window');
  const instance = seen.seen[0].instance;
  await call(lender.app, 'lending.attest_window', {instance: 'five_hour@1', reason: 'never seen'}, CONFIRM, 400);
  const attested = await call(lender.app, 'lending.attest_window', {instance, reason: 'I opened this window by using Claude'}, CONFIRM);
  assert.ok(attested.records.some((record) => record.instance === instance && record.origin === 'owner' && record.attested_by === 'owner'),
    'the owner\'s attestation is recorded');
});
