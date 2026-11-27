import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {restrictCredentialScope} from '../lib/sandbox-credentials.mjs';

// A Codex account lent from a subscription or an API key is bound to one sandbox under its own service name.
// The same name as a global value would reach every sandbox, so it is refused; the scoped value for this one sandbox passes.
const SERVICE = 'faravan-codex-0a1b2c3d';
const row = (name, scope) => ({type: 'service', scope, name});
const listing = secrets => ({secrets, custom_secrets: [], shadowed_services: [], env_only_count: 0});
const runner = value => async args => ({code: 0, stdout: args[0] === 'secret' ? JSON.stringify(value) : args[1] === 'get' && args[2] === 'ssh.agentForwardingEnabled' ? 'false' : '', stderr: ''});
const codex = {image: 'codex', egress: 'provider-only'};

test('a global value under the scoped account service name is refused', async () => {
  const run = runner(listing([row('openai', 'sb-1'), row(SERVICE, 'global')]));
  await assert.rejects(restrictCredentialScope(run, codex, 'sb-1', null, null, {scopedService: SERVICE}),
    error => error.code === 'credential_scope_unenforceable' && error.condition === 'scoped_service_global');
});

test('a retried prepare with its own scoped value passes', async () => {
  const run = runner(listing([row('openai', 'sb-1'), row(SERVICE, 'sb-1')]));
  const services = await restrictCredentialScope(run, codex, 'sb-1', null, null, {scopedService: SERVICE});
  assert.ok(Array.isArray(services));
});
