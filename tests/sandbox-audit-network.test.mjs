import './helpers/no-browser.mjs';
import {testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerSbxBackend } from '../lib/docker-backend.mjs';
import { planNetworkDeny } from '../lib/network-policy.mjs';
import { createSbxPolicy, CODEX_KIT_ALLOW } from './helpers/sbx-policy-model.mjs';
import { resolveHarness } from '../lib/executor.mjs';

const unrelated = ['github.com', 'api.github.com', 'download.docker.com', 'archive.ubuntu.com:80',
  'security.ubuntu.com:80', 'ports.ubuntu.com:80', 'uploads.attacker.example'];
for (const source of [false, true]) test('M1: provider-only closes kit destinations' + (source ? ' after cloning' : ''), async () => {
  const model = createSbxPolicy();
  const handle = { ...testSbxRuntimeFields(),sandbox_id: 'wf-audit-network', _egress: 'provider-only',
    _providerHosts: ['**.openai.com', '**.chatgpt.com', 'openai.com', 'chatgpt.com'], _registryHosts: [],
    _sourceHosts: source ? ['github.com', 'codeload.github.com'] : [] };
  model.createSandbox(handle.sandbox_id, { kitAllow: [...CODEX_KIT_ALLOW, 'uploads.attacker.example:443'] });
  const backend = new DockerSbxBackend({ runCommand: async args => model.run(args) });
  await backend._configureEgress(handle);
  if (source) {
    assert.equal(model.allowed(handle.sandbox_id, 'github.com'), true);
    await backend._closeSourceWindow(handle);
    assert.equal(handle._execution.network_scope, 'clone_only');
  }
  for (const host of unrelated) assert.equal(model.allowed(handle.sandbox_id, host), false, host);
  assert.equal(model.allowed(handle.sandbox_id, 'api.openai.com'), true);
});

test('M1: kit declarations cannot retain inherited GitHub and Docker wildcards', () => {
  const plan = planNetworkDeny({ inherited: ['**.github.com:443', '**.docker.com:443'],
    agent: ['**.openai.com'], kit: ['api.github.com:443', 'download.docker.com:443'] });
  assert.ok(plan.deny.includes('**.github.com:443'));
  assert.ok(plan.deny.includes('**.docker.com:443'));
  assert.deepEqual(plan.kitWider, []);
});

test('M1: the restricted Codex policy retains its declared model and authentication endpoints', async () => {
  const model = createSbxPolicy(), harness = resolveHarness('codex');
  const handle = { ...testSbxRuntimeFields(),sandbox_id: 'wf-codex-auth', _egress: 'provider-only',
    _providerHosts: harness.egress_provider_hosts, _registryHosts: [], _sourceHosts: [] };
  model.createSandbox(handle.sandbox_id, { kitAllow: CODEX_KIT_ALLOW });
  await new DockerSbxBackend({ runCommand: async args => model.run(args) })._configureEgress(handle);
  for (const host of harness.provider_domains) assert.equal(model.allowed(handle.sandbox_id, host), true, host);
});
