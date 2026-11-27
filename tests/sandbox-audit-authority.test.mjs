import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerSbxBackend } from '../lib/docker-backend.mjs';
import { restrictCredentialScope } from '../lib/sandbox-credentials.mjs';
import { createSbxPolicy, sbxRunner } from './helpers/sbx-policy-model.mjs';

const noGithub = '{"secrets":[],"custom_secrets":[],"shadowed_services":[],"env_only_count":0}';
function job(image) {
  return { job_id: 'audit-authority-' + image, image, entrypoint: 'true',
    execution_scope: 'borrowed', auth_strategy: 'docker-native-oauth',
    resources: { cpu: 1, memory_mib: 512, storage_mib: 512, wall_seconds: 60,
      output_bytes: 4096, network_bytes: 1, max_processes: 1 },
    inputs: [], output_manifest: [], egress: 'internet',
    provider_hosts: [image === 'codex' ? '**.openai.com' : '**.anthropic.com'] };
}
function fixture(secretResult) {
  const model = createSbxPolicy();
  const runner = sbxRunner(model, args => args[0] === 'secret' ? secretResult :
    { code: 0, stdout: args[0] === 'ls' ? '[]' : '', stderr: '' }, { secretResult });
  return { backend: new DockerSbxBackend({ runCommand: runner.run }), calls: runner.calls };
}

for (const image of ['claude', 'codex']) {
  test('B1: ordinary internet ' + image + ' job refuses a saved global GitHub credential before creation', async () => {
    const { backend, calls } = fixture({ code: 0, stdout: JSON.stringify({secrets:[{scope:'global',type:'service',name:'github'}],custom_secrets:[],shadowed_services:[],env_only_count:0}), stderr: '' });
    let handle;
    try {
      await assert.rejects(async () => { handle = await backend.prepare(job(image)); }, { code: 'credential_scope_unenforceable' });
      assert.equal(calls.some(args => args[0] === 'run'), false);
    } finally { if (handle) await backend.destroy(handle); }
  });
}

test('B1: an explicitly empty GitHub secret listing permits ordinary agent preparation', async () => {
  const { backend } = fixture({ code: 0, stdout: noGithub, stderr: '' });
  const handle = await backend.prepare(job('claude'));
  await backend.destroy(handle);
});

test('R2: the selected provider credential permits ordinary agent preparation', async () => {
  const listing={secrets:[{scope:'global',type:'service',name:'openai'}],custom_secrets:[],shadowed_services:[],env_only_count:0};
  const {backend}=fixture({code:0,stdout:JSON.stringify(listing),stderr:''});
  const handle=await backend.prepare(job('codex'));
  await backend.destroy(handle);
});

test('M2: the shared MCP gateway is denied from creation, including internet jobs', async () => {
  const model = createSbxPolicy();
  const runner = sbxRunner(model, args => ({ code: 0, stdout: args[0] === 'secret' ? noGithub : args[0] === 'ls' ? '[]' : '', stderr: '' }));
  const backend = new DockerSbxBackend({ runCommand: runner.run });
  const handle = await backend.prepare(job('claude'));
  try {
    const create = runner.calls.find(args => args[0] === 'create');
    assert.ok(create.some((arg, i) => arg === '--deny-network' && create[i + 1] === 'mcp-gateway.docker.internal'));
    assert.equal(model.allowed(handle.sandbox_id, 'mcp-gateway.docker.internal:80'), false);
    // A later MCP registration must not change the guest's network authority.
    model.createSandbox(handle.sandbox_id, { kitAllow: ['mcp-gateway.docker.internal'] });
    assert.equal(model.allowed(handle.sandbox_id, 'mcp-gateway.docker.internal:80'), false);
  } finally { await backend.destroy(handle); }
});

for (const result of [{ code: 1, stdout: noGithub }, { code: 0, stdout: '' }, { code: 0, stdout: 'unrecognized output' }]) {
  test('B1: unreadable GitHub credential state refuses preparation: ' + JSON.stringify(result), async () => {
    const { backend, calls } = fixture(result);
    let handle;
    try {
      await assert.rejects(async () => { handle = await backend.prepare(job('codex')); }, { code: 'credential_scope_unenforceable' });
      assert.equal(calls.some(args => args[0] === 'run'), false);
    } finally { if (handle) await backend.destroy(handle); }
  });
}

for (const variant of ['custom', 'sandbox-service', 'registry']) {
  test('R2: ordinary job refuses undeclared ' + variant + ' credentials', async () => {
    const spec = { ...job('claude'), job_id: 'credential-' + variant }, listing = { secrets: [], custom_secrets: [], shadowed_services: [], env_only_count: 0 };
    if (variant === 'custom') listing.custom_secrets.push({ scope: 'global', targets: ['api.github.com'], env: 'TEST_TOKEN', placeholder: 'synthetic' });
    if (variant === 'sandbox-service') {
      // Each dispatch gets a fresh name, so the audit sees the name it will create.
      const sandboxId = 'wf-' + 'e'.repeat(16);
      listing.secrets.push({ scope: sandboxId, type: 'service', name: 'github', secret: '(stored)' });
      await assert.rejects(restrictCredentialScope(async () => ({ code: 0, stdout: JSON.stringify(listing) }), spec, sandboxId), { code: 'credential_scope_unenforceable' });
      return;
    }
    if (variant === 'registry') listing.secrets.push({ scope: 'global', type: 'registry', name: 'registry.example.invalid', secret: '(stored)' });
    const runner = sbxRunner(createSbxPolicy(), args => ({ code: 0, stdout: args[0] === 'ls' ? '[]' : '' }));
    const backend = new DockerSbxBackend({ runCommand: args => args[0] === 'secret' && args.includes('--json')
      ? { code: 0, stdout: JSON.stringify(listing) } : runner.run(args) });
    let handle;
    try { await assert.rejects(async () => { handle = await backend.prepare(spec); }, { code: 'credential_scope_unenforceable' }); }
    finally { if (handle) await backend.destroy(handle); }
  });
}

test('R2: SSH forwarding is explicitly disabled even with a configured socket path', async () => {
  const runner = sbxRunner(createSbxPolicy(), args => ({ code: 0, stdout: args[0] === 'ls' ? '[]' : '' }));
  let disabled = false, cleared = false;
  const backend = new DockerSbxBackend({ runCommand: args => {
    if (args.join(' ') === 'settings set ssh.agentForwardingEnabled false') disabled = true;
    if (args.join(' ') === 'settings set ssh.agentSocketPath ') cleared = true;
    return runner.run(args);
  } });
  const handle = await backend.prepare(job('claude'));
  try { assert.equal(disabled, true); assert.equal(cleared, true); }
  finally { await backend.destroy(handle); }
});
