import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

test('failed prepare with unverified removal must not be treated as authoritative sandbox absence', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root, {});
  const prepare = backend.prepare.bind(backend);
  const leftovers = [];
  t.after(async () => {for (const handle of leftovers) await backend.destroy(handle);});
  backend.prepare = async spec => {
    leftovers.push(await prepare(spec));
    throw Object.assign(new Error('injected prepare failure with unknown cleanup'), {
      code: 'sandbox_prepare_failed', cleanup_receipt: {removed: false},
    });
  };
  const source = createSyntheticPace50Source({start: Date.now()});
  const {owner, lender, circle} = await f.connect({backend, codexRun: {model: 'gpt-6-sol'}, shutdownProofMs: 500,
    lendingPace50: {source, account_week_id: 'synthetic-week-1'}});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60,
    maxWallSeconds: 1200, idleOnly: false, lendingPolicy: {providerConsent: {codex: true}}}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, git: 'https://github.com/example/synthetic.git',
    commit: '1'.repeat(40), prompt: 'Synthetic prepare cleanup proof probe.', harness: 'codex'}});
  const state = () => JSON.parse(fs.readFileSync(join(lender.home, 'v1/lending-pace50-state.json'), 'utf8'));
  // Wait until the lender has attempted the sandbox and no longer holds the job. A correct release never reaches ceased here.
  await waitFor(() => leftovers.length > 0, 'the failed prepare was attempted', 30000);
  await waitFor(async () => (await api(lender.app, '/api/lending')).current === null, 'the lender finished the failed attempt', 30000);
  const attempt = state().attempts[0];
  console.log(JSON.stringify({probe: 'prepare-unverified', remainingSandbox: leftovers.length,
    processState: attempt.process_state, released: attempt.resources.map(r => r.released_micro)}));
  assert.ok(attempt.resources.every(r => r.released_micro === 0), 'unverified preparation cleanup cannot release exposure');
});
