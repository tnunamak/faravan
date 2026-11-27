import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appFixture, api, syntheticBackend, waitFor } from './helpers/v1-app-fixture.mjs';

// S1.1c (BUILD-PLAN v4): a blocker never turns lending off. The tester's live defect: a failed docker_login check latched
// safetyBlocked and switched lending off; the person had to find the switch and turn it on again.
const gitInput = circle => ({ circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt: 'Synthetic task.', harness: 'codex' });
const checks = ok => [{ name: 'sbx_install', ok: true }, { name: 'sbx_daemon', ok: true }, { name: 'docker_login', ok, detail: 'The sandbox service isn\'t signed in to Docker yet.', fix: 'sbx login' },
  { name: 'network_policy', ok: true }];

function dockerBackend(root) {
  const backend = syntheticBackend(root, {});
  const state = { signedOut: false };
  backend.probeCapabilities = async () => ({ available: true, preflight: { ok: !state.signedOut, checks: checks(!state.signedOut) } });
  const capabilities = backend.lenderCapabilities;
  backend.lenderCapabilities = () => ({ ...capabilities(), available: !state.signedOut });
  return { backend, state };
}

test('Docker signed out and back in leaves the intent on throughout, and claims resume without a click', { timeout: 120000 }, async t => {
  const f = await appFixture(t);
  const { backend, state } = dockerBackend(f.root);
  const { owner, lender, circle } = await f.connect({ backend, blockerRecheckMs: 50 });
  const app = lender.app, settingsPath = join(lender.home, 'v1', 'app-settings.json');
  await api(app, '/api/lending/limits', { method: 'POST', body: { dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false } });
  await api(app, '/api/agents/codex', { method: 'POST', body: { useForLending: true } });
  await api(app, '/api/lending/mode', { method: 'POST', body: { circle: circle.id, mode: 'ask' } });
  await api(app, '/api/lending/on', { method: 'POST', body: { circle: circle.id } });
  await waitFor(async () => (await api(app, '/api/status')).state === 'ready', 'lending ready');
  const intentOn = async where => {
    const status = await api(app, '/api/status');
    assert.equal(status.intent.on, true, where + ': the person\'s setting is still on');
    assert.equal((await api(app, '/api/lending')).enabled, true, where + ': the lender is still enabled');
    const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal(saved.intent, 'on', where); assert.equal(saved.safetyBlocked, undefined, where + ': no latch is saved');
    return status;
  };
  await intentOn('before');

  // Docker's sign-in expires. Lending stays on; the model says why nothing runs; no job is claimed.
  state.signedOut = true;
  await api(app, '/api/readiness?refresh=true');
  const blocked = await intentOn('signed out');
  assert.equal(blocked.reason, 'docker_signed_out');
  assert.equal(blocked.lending_blockers.first.key, 'docker_signin');
  assert.match(blocked.headline, /^Lending stopped: your Docker sign-in expired/, 'it was signed in before, so it expired');
  assert.deepEqual(blocked.lending_blockers.items.filter(x => x.key === 'agent' && x.agent === 'codex').map(x => [x.status, x.waits_for]), [['waits', 'docker_signin']]);
  assert.equal(blocked.lending_blockers.canLend, false);
  await api(owner.app, '/api/jobs', { method: 'POST', body: gitInput(circle) });
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.deepEqual(await api(app, '/api/approvals'), [], 'a blocker prevents claims');
  await intentOn('still signed out');

  // Docker is signed in again. Nobody touches lending: the next check lets the waiting job come.
  state.signedOut = false;
  const card = await waitFor(async () => (await api(app, '/api/approvals'))[0], 'the waiting job is claimed once the blocker clears', 30000);
  assert.ok(card);
  const status = await intentOn('signed back in');
  assert.equal(status.docker, null);
  assert.equal(status.lending_blockers.first, null);
});

test('a restart while Docker is signed out keeps the intent and resumes when it is signed in again', { timeout: 120000 }, async t => {
  const f = await appFixture(t);
  const { backend, state } = dockerBackend(f.root);
  const options = { backend, blockerRecheckMs: 50 };
  const { lender, circle } = await f.connect(options);
  await api(lender.app, '/api/lending/limits', { method: 'POST', body: { dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false } });
  await api(lender.app, '/api/agents/codex', { method: 'POST', body: { useForLending: true } });
  await api(lender.app, '/api/lending/mode', { method: 'POST', body: { circle: circle.id, mode: 'ask' } });
  await api(lender.app, '/api/lending/on', { method: 'POST', body: { circle: circle.id } });
  await lender.app.close();
  state.signedOut = true;
  const restarted = await f.start('lender', options);
  await new Promise(resolve => setTimeout(resolve, 500));
  const status = await api(restarted.app, '/api/status');
  assert.equal(status.intent.on, true);
  assert.equal(status.reason, 'docker_signed_out');
  state.signedOut = false;
  await waitFor(async () => (await api(restarted.app, '/api/status')).state === 'ready', 'lending is ready again without a click', 30000);
  assert.equal((await api(restarted.app, '/api/status')).intent.on, true);
});

test('turning lending on while Docker is signed out keeps it on and says what waits', { timeout: 60000 }, async t => {
  const f = await appFixture(t);
  const { backend, state } = dockerBackend(f.root);
  state.signedOut = true;
  const { lender, circle } = await f.connect({ backend, blockerRecheckMs: 50 });
  await api(lender.app, '/api/lending/limits', { method: 'POST', body: { dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false } });
  await api(lender.app, '/api/agents/codex', { method: 'POST', body: { useForLending: true } });
  await api(lender.app, '/api/lending/mode', { method: 'POST', body: { circle: circle.id, mode: 'ask' } });
  const on = await api(lender.app, '/api/lending/on', { method: 'POST', body: { circle: circle.id } });
  assert.equal(on.enabled, true);
  const status = await api(lender.app, '/api/status');
  assert.deepEqual([status.intent.on, status.reason], [true, 'docker_signed_out']);
});
