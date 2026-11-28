import './helpers/no-browser.mjs';
import {borrowerRunRequest} from '../lib/v1/run-request.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildValidatedJobSpec, runJob } from '../lib/executor.mjs';
import { DockerSbxBackend, REGISTRY_HOSTS, admitDockerJob } from '../lib/docker-backend.mjs';
import { validateRequirements, canSatisfy, signEnvelope, verifyEnvelope, privateKeyFromSeed, exportPublicKey, fingerprint } from '../lib/protocol/index.mjs';
import { JOB_DEFAULTS } from '../lib/v1/cli.mjs';
import { createSbxPolicy } from './helpers/sbx-policy-model.mjs';

const harness = { image: 'claude', egress_provider_hosts: ['api.anthropic.com'] };
const spec = (options = {}) => buildValidatedJobSpec({
  taskDigest: 'a'.repeat(64), harness, entrypointWithPrompt: 'true', ...options,
});
const requirements = (extra = {}) => ({
  capabilities: [], egress: 'provider-only', limits: { ...JOB_DEFAULTS.limits }, ...extra,
});
const lender = { harnesses: ['claude'], models: [], capabilities: [],
  egress: ['provider-only', 'internet'], enforced_limits: Object.keys(JOB_DEFAULTS.limits),
  max_limits: { ...JOB_DEFAULTS.limits } };

test('legacy runtime defaults and signed requirements stay unchanged', () => {
  assert.equal(spec().egress, 'internet');
  for (const egress of ['internet', 'provider-only']) {
    const req = requirements({ egress });
    const before = JSON.stringify(req);
    assert.equal(validateRequirements(req).ok, true);
    assert.equal(canSatisfy(req, lender).ok, true);
    assert.equal(JSON.stringify(req), before);
  }
});

test('optional signed registry requirements fail closed for unsupported lenders', () => {
  const req = requirements({ network: 'provider+registries', registries: ['npm'] });
  assert.equal(validateRequirements(req).ok, true);
  assert.deepEqual(canSatisfy(req, lender), { ok: false, code: 'requirements_unsupported', unmet: ['network'] });
  assert.equal(canSatisfy(req, { ...lender, capabilities: ['network-registries-v1'] }).ok, true);
  for (const extra of [
    { network: 'provider+registries' }, { network: 'provider+registries', registries: [] },
    { network: 'provider+registries', registries: ['npm', 'npm'] },
    { network: 'provider+registries', registries: ['evil.example'] },
    { registries: ['npm'] }, { network: 'internet' },
    { network: 'provider-only', registries: ['npm'] },
  ]) assert.equal(validateRequirements(requirements(extra)).ok, false, JSON.stringify(extra));
  assert.equal(validateRequirements(requirements({ egress: 'internet', network: 'internet' })).ok, true);

  const key = privateKeyFromSeed(new Uint8Array(32).fill(7)), publicKey = exportPublicKey(key);
  const digest = 'sha256:' + 'a'.repeat(64);
  const payload = { schema: 'faravan.job.v1', circle: '00000000-0000-4000-8000-000000000001',
    author: fingerprint(publicKey), roster_epoch: 1, intent_id: '00000000-0000-4000-8000-000000000002',
    created_at: '2026-10-19T00:00:00Z', expires_at: '2026-10-20T00:00:00Z',
    source: { kind: 'archive', artifact: { digest, bytes: 0, media_type: 'application/gzip' } },
    prompt: { digest, bytes: 0, media_type: 'text/plain' }, requirements: req,
    input_protection: 'none', max_attempts: 1 };
  payload.runRequest=borrowerRunRequest({});payload.requirements.capabilities.push('run_request_v1');
  const envelope = signEnvelope('job', payload, key);
  assert.equal(verifyEnvelope('job', envelope, publicKey).ok, true);
  envelope.payload.requirements.registries = ['pypi'];
  assert.equal(verifyEnvelope('job', envelope, publicKey).code, 'invalid_signature');
});

// Policy commands go to a stateful model of sbx's policy (global allowances included), not to fixed verdicts.
function policyFixture(job) {
  const model = createSbxPolicy(), calls = [], backend = new DockerSbxBackend();
  model.createSandbox('fixture', { kitAllow: [] });
  const handle = { sandbox_id: 'fixture', _egress: job.egress, _providerHosts: job.provider_hosts,
    _registryHosts: (job.registries || []).flatMap(name => REGISTRY_HOSTS[name]),
    _sourceHosts: job.source_hosts || [], _execution: { egress_evidence: null } };
  backend._runJobCommand = async (_, args) => { calls.push(args); return model.run(args) ?? { code: 0, stdout: '', stderr: '' }; };
  // Everything the job may reach by its own sandbox rules (inherited allowances it did not ask for are denied).
  const allowed = () => calls.filter(args => args[0] === 'policy' && args[1] === 'allow').flatMap(args => args.at(-1).split(','));
  return { backend, handle, calls, allowed, model };
}

test('registry policies use exact named hosts and retain private-network denials', async () => {
  for (const [network, registries, expected] of [
    ['provider-only', undefined, ['api.anthropic.com']],
    ['provider+registries', ['npm'], ['api.anthropic.com', 'registry.npmjs.org']],
    ['provider+registries', ['pypi'], ['api.anthropic.com', 'pypi.org', 'files.pythonhosted.org']],
  ]) {
    const job = spec({ network, registries });
    assert.equal(admitDockerJob(job).ok, true);
    const f = policyFixture(job);
    await f.backend._configureEgress(f.handle);
    assert.deepEqual(f.allowed(), expected);
    assert.equal(f.handle._policyVerification['registry.npmjs.org'], registries?.includes('npm') ? 'allowed' : 'denied');
    assert.equal(f.handle._policyVerification['example.com'], 'denied');
    assert.ok(f.calls.find(args => args[1] === 'deny').at(-1).includes('10.0.0.0/8'));
  }
  assert.throws(() => spec({ network: 'provider+registries' }), /registries required/);
  assert.throws(() => spec({ network: 'provider-only', registries: ['npm'] }), /invalid registries/);
  assert.throws(() => spec({ network: 'provider+registries', registries: ['npmjs.org'] }), /invalid registries/);
});

test('provider-only lent GitHub job installs clone hosts and clones the pinned source before starting', async () => {
  const commit = 'b'.repeat(40), original = spec({ network: 'provider-only' });
  const f = policyFixture(original);
  let prepared, cloned = false, starts = 0;
  f.backend.probeCapabilities = async () => ({ available: true });
  f.backend.prepare = async job => {
    prepared = job;
    f.handle._sourceHosts = job.source_hosts || [];
    await f.backend._configureEgress(f.handle);
    return f.handle;
  };
  const policyCommand = f.backend._runJobCommand;
  f.backend._runJobCommand = async (handle, args) => {
    if (args[0] !== 'exec') return policyCommand(handle, args);
    if (args.at(-1).includes(' clone --no-checkout ')) {
      assert.ok(f.allowed().includes('github.com'));
      assert.ok(f.allowed().includes('codeload.github.com'));
      assert.equal(f.allowed().includes('registry.npmjs.org'), false);
      cloned = true;
    }
    return { code: 0, stdout: args.includes('rev-parse') ? commit : '', stderr: '' };
  };
  f.backend.ensureGuestRuntime = async () => ({node:process.execPath});
  f.backend.start = async handle => { assert.equal(cloned, true); if(handle._sourcePreparation)handle._lastExecStdout='FARAVAN_GIT_SOURCE_OK'; starts++; };
  f.backend.collectDeclaredOutputs = async () => [];
  f.backend.destroy = async () => ({ removed: true, scratch_removed: true });
  const result = await runJob({ jobSpec: original, backend: f.backend,
    cloneGitSource: { kind: 'git', url: 'https://github.com/example/repo.git', commit, object_format: 'sha1' } });
  assert.deepEqual(prepared.source_hosts, ['github.com', 'codeload.github.com']);
  assert.equal(original.source_hosts, undefined);
  assert.equal(result.execution.verified_commit, commit);
  assert.ok(starts > 0);
});

test('standalone requirements schema continues to reference the signed job definition', async () => {
  const schema = JSON.parse(await readFile(new URL('../docs/protocol/requirements.schema.json', import.meta.url)));
  assert.equal(schema.$ref, 'job.schema.json#/$defs/requirements');
});
