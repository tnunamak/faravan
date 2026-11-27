import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appFixture, api, syntheticBackend, waitFor } from './helpers/v1-app-fixture.mjs';
import { dockerSignedOutFrom, DOCKER_SIGNED_OUT_MESSAGE } from '../lib/v1/docker-state.mjs';

const MESSAGE = "Sign in to Docker to lend.";
const ACTION = { kind: 'docker-signin', label: 'Sign in to Docker', href: '#/setup', step: 'docker-signin' };

test('dockerSignedOutFrom reads only the docker_login check', () => {
  assert.equal(DOCKER_SIGNED_OUT_MESSAGE, MESSAGE);
  assert.equal(dockerSignedOutFrom([{ name: 'docker_login', ok: false }, { name: 'network_policy', ok: false }]), true);
  assert.equal(dockerSignedOutFrom([{ name: 'docker_login', ok: true }]), false);
  assert.equal(dockerSignedOutFrom([{ name: 'network_policy', ok: false }]), null);
  assert.equal(dockerSignedOutFrom(undefined), null);
});

test('Docker signed out: one code on status, agents, agent checks, agent sign-in and starting lending', { timeout: 60000 }, async t => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root, {});
  let signedOut = true, probes = 0;
  backend.probeCapabilities = async () => { backend.calls.push(['probe']); return { available: true, preflight: { ok: !signedOut, checks: [
    { name: 'docker_login', ok: !signedOut, detail: "The sandbox service isn't signed in to Docker yet.", fix: 'sbx login' },
    { name: 'network_policy', ok: !signedOut, detail: 'policy', fix: 'sbx policy init' }] } }; };
  const { lender, circle } = await f.connect({ backend, identityProbe: async () => { probes++; return { providers: [] }; } });
  const app = lender.app;

  // Agent rows carry the code, the plain message and the action; none says "Check failed".
  const agents = await api(app, '/api/agents');
  assert.ok(agents.length > 0);
  for (const row of agents) {
    assert.equal(row.code, 'docker_signed_out'); assert.equal(row.message, MESSAGE); assert.equal(row.remedy, MESSAGE);
    assert.deepEqual(row.action, ACTION); assert.equal(row.signInState, 'Docker sign-in needed'); assert.notEqual(row.checkFailed, true);
  }
  // An agent check does not start a sandbox or run the identity probe while Docker is signed out.
  const refreshed = await api(app, '/api/agents/refresh', { method: 'POST', body: {} });
  assert.ok(refreshed.every(r => r.code === 'docker_signed_out'));
  assert.equal(probes, 0, 'no agent check was attempted');
  // Agent sign-in is refused up front with the same code, message and action, and starts no sandbox.
  const before = backend.calls.filter(([k]) => k === 'prepare').length;
  const refusal = await api(app, '/api/signin/codex', { method: 'POST', body: {}, status: 409 });
  assert.deepEqual([refusal.code, refusal.message, refusal.action], ['docker_signed_out', MESSAGE, ACTION]);
  assert.equal(backend.calls.filter(([k]) => k === 'prepare').length, before);
  // Home and status name it, as a blocker and as something that needs the person.
  const home = await api(app, '/api/status');
  assert.deepEqual(home.docker, { code: 'docker_signed_out', message: MESSAGE, action: ACTION });
  assert.ok(home.needs_you.some(n => n.kind === 'docker_signed_out')); assert.ok(home.blockers.some(b => b.kind === 'docker_signed_out'));
  // Turning lending on succeeds (a blocker never refuses or turns off the intent); the status names Docker's sign-in.
  await api(app, '/api/lending/limits', { method: 'POST', body: { dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false } });
  await api(app, '/api/lending/mode', { method: 'POST', body: { circle: circle.id, mode: 'ask' } });
  await api(app, '/api/agents/codex', { method: 'POST', body: { useForLending: true } });
  const on = await api(app, '/api/lending/on', { method: 'POST', body: { circle: circle.id } });
  assert.equal(on.enabled, true);
  const status = await api(app, '/api/status');
  assert.equal(status.state, 'blocked'); assert.equal(status.reason, 'docker_signed_out');
  assert.equal(status.intent.reason, 'docker_signed_out'); assert.equal(status.intent.on, true);
  assert.equal(JSON.parse(await readFile(join(lender.home, 'v1', 'app-settings.json'), 'utf8')).intent, 'on');
  // The readiness report carries it too.
  assert.equal((await api(app, '/api/readiness')).code, 'docker_signed_out');
  // After signing in again the agent rows lose the code and checks run.
  signedOut = false;
  const rows = await api(app, '/api/agents/refresh', { method: 'POST', body: {} });
  assert.ok(rows.every(r => r.code === undefined));
  assert.ok(probes > 0, 'agent checks run once Docker is signed in');
});

test('a timed-out Docker read is not a sign-out', () => {
  assert.equal(dockerSignedOutFrom([{ name: 'docker_login', ok: false, unknown: true }]), null);
});
