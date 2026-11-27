import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildValidatedJobSpec } from '../lib/executor.mjs';
import { DockerSbxBackend } from '../lib/docker-backend.mjs';
import { createSbxPolicy, sbxRunner, SBX_GLOBAL_RULES } from './helpers/sbx-policy-model.mjs';

// Review 3 P1: the per-sandbox rules denied three registry names and verified a few sentinels, but a sandbox
// still inherits every global allowance (sbx 0.48's default has ~190: **.amazonaws.com, **.googleapis.com, GitHub ...).
// These run against a stateful model of that policy, with extra allowances a user may have added.
const harness = { image: 'claude', egress_provider_hosts: ['**.anthropic.com', '**.claude.ai'] };
const spec = (options = {}) => buildValidatedJobSpec({ taskDigest: 'a'.repeat(64), harness, entrypointWithPrompt: 'true', ...options });
const extra = { id: 'user-added', name: 'user-added', scope: 'global', applies_to: 'all', resource_type: 'network', decision: 'allow',
  resources: ['uploads.example.org:443', '**.corp.example.org'], status: 'active', origin: 'local', layer: 'local' };

function setup({ globalRules = [...SBX_GLOBAL_RULES, extra], other } = {}) {
  const model = createSbxPolicy({ globalRules });
  const runner = sbxRunner(model, other ?? (async()=>({code:0,stdout:'',stderr:''})));
  const backend = new DockerSbxBackend({ runCommand: runner.run });
  return { model, runner, backend };
}
const EXFIL = ['s3.amazonaws.com', 'anything.amazonaws.com', 'storage.googleapis.com', 'uploads.example.org', 'x.corp.example.org',
  'github.com', 'api.github.com', 'gist.github.com', 'raw.githubusercontent.com', 'gitlab.com', 'registry-1.docker.io',
  'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'crates.io', 'proxy.golang.org', 'archive.ubuntu.com:80', 'example.com'];

test('a provider-only job inherits no global allowance it did not ask for', async () => {
  const { model, backend } = setup();
  const handle = await backend.prepare(spec({ network: 'provider-only' }));
  for (const target of EXFIL) assert.equal(model.allowed(handle.sandbox_id, target), false, target + ' must be denied');
  for (const target of ['api.anthropic.com', 'console.anthropic.com', 'claude.ai', 'x.claude.ai']) {
    if (target === 'claude.ai') continue; // `**.claude.ai` does not cover the apex
    assert.equal(model.allowed(handle.sandbox_id, target), true, target + ' is the provider');
  }
  assert.equal(model.allowed(handle.sandbox_id, '10.0.0.1'), false);
});

test('named registries stay open and nothing else does', async () => {
  const { model, backend } = setup();
  const handle = await backend.prepare(spec({ network: 'provider+registries', registries: ['npm'] }));
  assert.equal(model.allowed(handle.sandbox_id, 'registry.npmjs.org'), true);
  for (const target of EXFIL.filter(t => t !== 'registry.npmjs.org')) assert.equal(model.allowed(handle.sandbox_id, target), false, target);
});

test('an internet job is unrestricted by design, and still cannot reach private networks', async () => {
  const { model, backend } = setup();
  const handle = await backend.prepare(spec({ network: 'internet' }));
  assert.equal(model.allowed(handle.sandbox_id, 'uploads.example.org'), true);
  assert.equal(model.allowed(handle.sandbox_id, '192.168.1.1'), false);
});

test('an inherited allowance wider than the provider cannot be denied, so the job is refused and its sandbox removed', async () => {
  const wide = { ...extra, id: 'wide', resources: ['**.com:443'] };
  const { model, backend, runner } = setup({ globalRules: [...SBX_GLOBAL_RULES, wide] });
  await assert.rejects(backend.prepare(spec({ network: 'provider-only' })), e => {
    assert.equal(e.code, 'policy_unenforceable');
    assert.equal(e.cleanup_receipt.removed, true);
    return true;
  });
  assert.ok(runner.calls.some(args => args[0] === 'rm'));
  assert.ok(runner.calls.some(args=>args[0]==='ls'),'cleanup independently verifies removal');
  assert.equal(Object.keys(model.state.sandboxes).length, 0);
});

test('a policy listing that cannot be read refuses the job', async () => {
  const model = createSbxPolicy();
  const runner = sbxRunner({ ...model, run: args => args[1] === 'ls' ? { code: 0, stdout: 'not json', stderr: '' } : model.run(args),
    createSandbox: (...a) => model.createSandbox(...a), removeSandbox: (...a) => model.removeSandbox(...a) });
  const backend = new DockerSbxBackend({ runCommand: runner.run });
  await assert.rejects(backend.prepare(spec({ network: 'provider-only' })), e => e.code === 'policy_unenforceable');
});

test('the verification fails when a deny does not take effect', async () => {
  const model = createSbxPolicy();
  // A policy engine that ignores one rule: the check must catch it instead of trusting the installed rules.
  const leaky = { ...model, createSandbox: (...a) => model.createSandbox(...a), removeSandbox: (...a) => model.removeSandbox(...a),
    run: args => {
      const result = model.run(args);
      if (args[1] === 'check' && args.at(-1) === 'faravan-probe.amazonaws.com:443') return { code: 0, stdout: '{"allowed":true}', stderr: '' };
      return result;
    } };
  const backend = new DockerSbxBackend({ runCommand: sbxRunner(leaky).run });
  await assert.rejects(backend.prepare(spec({ network: 'provider-only' })), e => e.code === 'policy_unenforceable');
});

// --- Git source: GitHub only while the code is fetched ---
const COMMIT = 'b'.repeat(40);
const gitJob = () => ({ ...spec({ network: 'provider-only' }), source_hosts: ['github.com', 'codeload.github.com'] });
const gitOther = async args => args[0] === 'ls' ? { code: 0, stdout: '[]', stderr: '' }
  : { code: 0, stdout: args.includes('rev-parse') ? COMMIT : '', stderr: '' };

test('GitHub is reachable for the clone and closed again before the agent can run', async () => {
  const model = createSbxPolicy(), seen = [];
  const runner = sbxRunner(model, async args => {
    if (args[0] === 'exec' && args.at(-1).includes(' clone --no-checkout ')) {
      seen.push(['github.com', 'codeload.github.com', 'api.github.com', 'gist.github.com'].map(h => model.allowed(args[1], h)));
    }
    return gitOther(args);
  });
  const backend = new DockerSbxBackend({ runCommand: runner.run });
  const handle = await backend.prepare(gitJob());
  assert.equal(model.allowed(handle.sandbox_id, 'github.com'), true, 'open for the clone');
  await backend.cloneGitSource(handle, { url: 'https://github.com/example/repo', commit: COMMIT, kind: 'git' });
  assert.deepEqual(seen, [[true, true, true, true]], 'the clone could reach GitHub');
  for (const host of ['github.com', 'codeload.github.com', 'api.github.com', 'gist.github.com', 'raw.githubusercontent.com', 's3.amazonaws.com'])
    assert.equal(model.allowed(handle.sandbox_id, host), false, host + ' is closed once the clone is done');
  assert.equal(model.allowed(handle.sandbox_id, 'api.anthropic.com'), true, 'the provider is untouched');
  assert.equal(handle._execution.network_scope, 'clone_only');
});

test('a clone that cannot close GitHub afterwards fails the job instead of running with GitHub open', async () => {
  const model = createSbxPolicy();
  const runner = sbxRunner(model, gitOther);
  const base = runner.run;
  let closing = false;
  const backend = new DockerSbxBackend({ runCommand: async (args, o) => closing && args[1] === 'rm' && args[2] === 'network' ? { code: 1, stdout: '', stderr: 'boom' } : base(args, o) });
  const handle = await backend.prepare(gitJob());
  closing = true;
  await assert.rejects(backend.cloneGitSource(handle, { url: 'https://github.com/example/repo', commit: COMMIT, kind: 'git' }),
    e => e.code === 'policy_unenforceable');
});

test('a provider that is itself GitHub keeps it open, and says so', async () => {
  const model = createSbxPolicy();
  const backend = new DockerSbxBackend({ runCommand: sbxRunner(model, gitOther).run });
  const copilot = { ...buildValidatedJobSpec({ taskDigest: 'a'.repeat(64), harness: { image: 'claude', egress_provider_hosts: ['**.github.com', '**.githubcopilot.com'] },
    entrypointWithPrompt: 'true', network: 'provider-only' }), source_hosts: ['github.com', 'codeload.github.com'] };
  const handle = await backend.prepare(copilot);
  await backend.cloneGitSource(handle, { url: 'https://github.com/example/repo', commit: COMMIT, kind: 'git' });
  assert.equal(model.allowed(handle.sandbox_id, 'api.github.com'), true);
  assert.equal(handle._execution.network_scope, 'whole_run');
});

test('the task receipt carries network_scope from the run, for the lender to publish', async () => {
  const { buildTaskReceipt, runJob } = await import('../lib/executor.mjs');
  const model = createSbxPolicy();
  const runner = sbxRunner(model, async args => {
    if (args[0] === 'ls') return { code: 0, stdout: '[]', stderr: '' };
    if (args[0] === 'cp') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: args.at(-1)?.includes('FARAVAN_GIT_SOURCE_OK') ? 'FARAVAN_GIT_SOURCE_OK' : args.includes('rev-parse') ? COMMIT : '', stderr: '' };
  });
  const backend = new DockerSbxBackend({ runCommand: runner.run });
  backend.ensureGuestRuntime = async () => ({node:process.execPath});
  backend.collectDeclaredOutputs = async () => [];
  backend.probeCapabilities = async () => ({ available: true });
  const original = spec({ network: 'provider-only' });
  const result = await runJob({ jobSpec: original, backend,
    cloneGitSource: { kind: 'git', url: 'https://github.com/example/repo.git', commit: COMMIT, object_format: 'sha1' } });
  assert.equal(result.execution.network_scope, 'clone_only');
  const receipt = buildTaskReceipt({ taskDigest: 'a'.repeat(64), harnessId: 'codex', execution: { ...result.execution, stdout: '' } });
  assert.equal(receipt.network_scope, 'clone_only');
  assert.equal(buildTaskReceipt({ taskDigest: 'a'.repeat(64), harnessId: 'codex', execution: { stdout: '' } }).network_scope, undefined);
});

// Codex's kit provisions GitHub, Docker and Ubuntu access. Execution must remove
// those permissions and the overlapping inherited allowances.
import { CODEX_KIT_ALLOW, CLAUDE_KIT_ALLOW } from './helpers/sbx-policy-model.mjs';
const codexHarness = { image: 'codex', egress_provider_hosts: ['**.openai.com', '**.chatgpt.com'] };
const withKit = (kitAllow, harnessSpec) => {
  const model = createSbxPolicy({ globalRules: [...SBX_GLOBAL_RULES, extra] });
  const runner = sbxRunner(model, async args => args[0] === 'ls' ? { code: 0, stdout: '[]', stderr: '' } : { code: 0, stdout: args.includes('rev-parse') ? COMMIT : '', stderr: '' }, { kitAllow });
  return { model, backend: new DockerSbxBackend({ runCommand: runner.run }),
    job: (options = {}) => buildValidatedJobSpec({ taskDigest: 'a'.repeat(64), harness: harnessSpec, entrypointWithPrompt: 'true', network: 'provider-only', ...options }) };
};

test('Codex starts with only provider permissions; kit extras stay denied', async () => {
  const { model, backend, job } = withKit(CODEX_KIT_ALLOW, codexHarness);
  const handle = await backend.prepare(job());
  const sandbox = handle.sandbox_id;
  assert.equal(model.allowed(sandbox, 'api.openai.com'), true);
  for (const target of ['download.docker.com', 'github.com', 'api.github.com', 'archive.ubuntu.com:80', 'release-assets.githubusercontent.com'])
    assert.equal(model.allowed(sandbox, target), false, target + ' is outside the provider');
  for (const target of ['s3.amazonaws.com', 'anything.amazonaws.com', 'storage.googleapis.com', 'uploads.example.org', 'x.corp.example.org', 'gitlab.com',
    'registry-1.docker.io', 'registry.npmjs.org', 'pypi.org', 'crates.io', 'example.com', 'bitbucket.org'])
    assert.equal(model.allowed(sandbox, target), false, target + ' was not requested');
  const kit = handle._execution.network_kit;
  assert.ok(!kit.hosts.includes('github.com') && !kit.hosts.includes('download.docker.com') && kit.hosts.includes('api.openai.com'));
  assert.equal(kit.hosts.includes('registry.npmjs.org'), false, 'the kit\'s npm allowance is not a registry the job asked for');
  assert.deepEqual(kit.wider, []);
});

test('Claude still starts and discloses its kit hosts', async () => {
  const { model, backend, job } = withKit(CLAUDE_KIT_ALLOW, harness);
  const handle = await backend.prepare(job());
  assert.equal(model.allowed(handle.sandbox_id, 'platform.claude.com'), false, 'this fixture only declares anthropic.com and claude.ai');
  assert.equal(model.allowed(handle.sandbox_id, 's3.amazonaws.com'), false);
  assert.deepEqual(handle._execution.network_kit.wider, []);
});

test('a Codex job closes GitHub after cloning despite its kit permissions', async () => {
  const { model, backend, job } = withKit(CODEX_KIT_ALLOW, codexHarness);
  const handle = await backend.prepare({ ...job(), source_hosts: ['github.com', 'codeload.github.com'] });
  await backend.cloneGitSource(handle, { url: 'https://github.com/example/repo', commit: COMMIT, kind: 'git' });
  assert.equal(handle._execution.network_scope, 'clone_only');
  assert.equal(model.allowed(handle.sandbox_id, 'github.com'), false);
  assert.equal(model.allowed(handle.sandbox_id, 's3.amazonaws.com'), false);
});

test('a kit cannot make a whole-TLD wildcard acceptable, and a wildcard wider than a requested host is refused', async () => {
  const wide = { ...extra, id: 'tld', resources: ['**.com:443'] };
  const model = createSbxPolicy({ globalRules: [...SBX_GLOBAL_RULES, wide] });
  const backend = new DockerSbxBackend({ runCommand: sbxRunner(model, async a => a[0] === 'ls' ? { code: 0, stdout: '[]', stderr: '' } : { code: 0, stdout: '', stderr: '' }, { kitAllow: CODEX_KIT_ALLOW }).run });
  await assert.rejects(backend.prepare(buildValidatedJobSpec({ taskDigest: 'a'.repeat(64), harness: codexHarness, entrypointWithPrompt: 'true', network: 'provider-only' })),
    e => e.code === 'policy_unenforceable');
});

test('an unexpected kit host receives no execution allowance', async () => {
  const { model, backend, job } = withKit(['only-this-kit.example.net:443', 'api.anthropic.com:443'], harness);
  const handle = await backend.prepare(job());
  assert.equal(model.allowed(handle.sandbox_id, 'only-this-kit.example.net'), false);
  assert.equal(model.allowed(handle.sandbox_id, 'other.example.net'), false);
});

test('the lender receipt names the kit hosts the sandbox really had', async () => {
  const { buildTaskReceipt } = await import('../lib/executor.mjs');
  const kit = { hosts: ['github.com'], wider: ['**.github.com'] };
  assert.deepEqual(buildTaskReceipt({ taskDigest: 'a'.repeat(64), harnessId: 'codex', execution: { stdout: '', network_kit: kit } }).network_kit, kit);
});

// sbx 0.50 refuses `policy rm` on a kit rule, so the kit's allowances stay. The job must still reach only what it asked for:
// each kept kit resource is a provider host or is denied, and a deny beats an allow.
const withManagedKit = (kitAllow, harnessSpec) => {
  const model = createSbxPolicy({ globalRules: [...SBX_GLOBAL_RULES, extra], kitManaged: true });
  const runner = sbxRunner(model, async args => args[0] === 'ls' ? { code: 0, stdout: '[]', stderr: '' } : { code: 0, stdout: args.includes('rev-parse') ? COMMIT : '', stderr: '' }, { kitAllow });
  return { model, runner, backend: new DockerSbxBackend({ runCommand: runner.run }),
    job: (options = {}) => buildValidatedJobSpec({ taskDigest: 'a'.repeat(64), harness: harnessSpec, entrypointWithPrompt: 'true', network: 'provider-only', ...options }) };
};

test('sbx 0.50: a Claude job starts although its kit rule cannot be removed, and reaches only its provider', async () => {
  const { model, backend, job } = withManagedKit(CLAUDE_KIT_ALLOW, harness);
  const handle = await backend.prepare(job());
  assert.ok(Object.values(model.state.sandboxes[handle.sandbox_id]).some(rule => rule.id.startsWith('kit-')), 'the kit rule is still there');
  assert.equal(model.allowed(handle.sandbox_id, 'api.anthropic.com'), true);
  assert.equal(model.allowed(handle.sandbox_id, 'platform.claude.com'), false, 'a kit host the job did not declare is denied');
  for (const target of EXFIL) assert.equal(model.allowed(handle.sandbox_id, target), false, target + ' must be denied');
});

test('sbx 0.50: a Codex job keeps its kit rule, yet GitHub, Docker and Ubuntu stay denied and GitHub closes after the clone', async () => {
  const { model, backend, job } = withManagedKit(CODEX_KIT_ALLOW, codexHarness);
  const handle = await backend.prepare({ ...job(), source_hosts: ['github.com', 'codeload.github.com'] });
  for (const target of ['download.docker.com', 'api.github.com', 'archive.ubuntu.com:80', 'release-assets.githubusercontent.com', 's3.amazonaws.com'])
    assert.equal(model.allowed(handle.sandbox_id, target), false, target + ' is outside the provider');
  await backend.cloneGitSource(handle, { url: 'https://github.com/example/repo', commit: COMMIT, kind: 'git' });
  assert.equal(handle._execution.network_scope, 'clone_only');
  assert.equal(model.allowed(handle.sandbox_id, 'github.com'), false);
  assert.equal(model.allowed(handle.sandbox_id, 'api.openai.com'), true);
});

test('sbx 0.50: a kept kit rule that grows a host after removal was tried refuses the job', async () => {
  const model = createSbxPolicy({ globalRules: [...SBX_GLOBAL_RULES, extra], kitManaged: true });
  const runner = sbxRunner(model, async args => args[0] === 'ls' ? { code: 0, stdout: '[]', stderr: '' } : { code: 0, stdout: '', stderr: '' }, { kitAllow: CLAUDE_KIT_ALLOW });
  // The kit rule gains a host while our denies are installed: no deny of ours covers it, so only the kept-rule check can refuse.
  const run = async (args, options) => {
    const result = await runner.run(args, options);
    if (args[0] === 'policy' && args[1] === 'deny')
      for (const rule of Object.values(model.state.sandboxes).flat()) if (rule.id.startsWith('kit-') && !rule.resources.includes('exfil.example:443')) rule.resources.push('exfil.example:443');
    return result;
  };
  const backend = new DockerSbxBackend({ runCommand: run });
  await assert.rejects(backend.prepare(buildValidatedJobSpec({ taskDigest: 'a'.repeat(64), harness, entrypointWithPrompt: 'true', network: 'provider-only' })),
    e => e.code === 'policy_unenforceable' && /grant more than this job asked for/.test(e.message));
});
