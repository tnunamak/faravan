import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadImagePins} from '../lib/sbx-image-pins.mjs';
import {HARNESS_ADAPTERS} from '../lib/harnesses/index.mjs';
import {buildValidatedJobSpec} from '../lib/executor.mjs';
import {DockerSbxBackend, admitDockerJob, sanitizedEnv} from '../lib/docker-backend.mjs';
import {createSbxPolicy, sbxRunner} from './helpers/sbx-policy-model.mjs';

// A fake marker stands in for a real provider key. It is never a working credential.
const FAKE_KEY = 'fake-provider-key-DO-NOT-LEAK-0123456789';
const KEY_VARS = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
const GUEST_VISIBLE = ['guest-env-api-key', 'provider-file-generation'];
const PROXY_ONLY = ['docker-native-oauth', 'docker-stored-secret', 'host-file-proxy', 'host-env-proxy'];

const specs = HARNESS_ADAPTERS.flatMap(adapter =>
  [adapter.spec, adapter.lendingSpec].filter(Boolean).map(spec => ({id: spec.harness_id + (spec === adapter.lendingSpec ? ' (lending)' : ''), spec})));

const borrowedJob = spec => buildValidatedJobSpec({taskDigest: '4'.repeat(64), harness: spec, executionScope: 'borrowed',
  entrypointWithPrompt: 'true', network: 'disabled'});

for (const {id, spec} of specs) {
  test(`borrowed ${id}: ${spec.auth_strategy} is ${GUEST_VISIBLE.includes(spec.auth_strategy) ? 'refused at admission' : 'not refused for its strategy'}`, () => {
    const result = admitDockerJob(borrowedJob(spec));
    if (GUEST_VISIBLE.includes(spec.auth_strategy)) {
      assert.equal(result.ok, false);
      assert.equal(result.code, 'native_credentials_owner_only');
      assert.match(result.reason, /proxy/i);
    } else {
      assert.equal(result.ok, true, JSON.stringify(result));
    }
  });
}

for (const strategy of GUEST_VISIBLE) {
  test(`borrowed ${strategy} is refused before any sandbox step, and no fake key reaches argv or env`, async t => {
    const home = await mkdtemp(join(tmpdir(), 'proxy-floor-'));
    const saved = Object.fromEntries(['FARAVAN_SBX_HOME', 'FARAVAN_SCRATCH_ROOT', ...KEY_VARS].map(name => [name, process.env[name]]));
    process.env.FARAVAN_SBX_HOME = home; process.env.FARAVAN_SCRATCH_ROOT = home;
    for (const name of KEY_VARS) process.env[name] = FAKE_KEY;
    t.after(async () => {
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      await rm(home, {recursive: true, force: true});
    });
    const runner = sbxRunner(createSbxPolicy({globalRules: []}));
    const pins = loadImagePins();
    const backend = new DockerSbxBackend({runCommand: runner.run, home, imagePins: {...pins, agents: {...pins.agents, opencode: 'sha256:' + '2'.repeat(64)}}});
    for (const image of ['opencode', 'claude', 'codex']) {
      const job = {...borrowedJob(specs.find(s => s.spec.harness_id === 'opencode').spec), image, auth_strategy: strategy};
      const before = runner.calls.length;
      assert.equal(admitDockerJob(job).code, 'native_credentials_owner_only');
      assert.equal((await backend.admitJob({...job, required_limits: ['guest_block_device_capacity']})).code, 'native_credentials_owner_only');
      await assert.rejects(backend.prepare(job), error => error.code === 'native_credentials_owner_only' && /proxy/i.test(error.message));
      assert.equal(runner.calls.length, before, 'no sbx command ran for a refused borrowed job');
    }
    assert.equal(JSON.stringify(runner.calls).includes(FAKE_KEY), false);
  });
}

test('borrowed proxy labels must match the image mechanism', () => {
  const base = borrowedJob(specs.find(s => s.id === 'gemini').spec);
  for (const strategy of PROXY_ONLY) assert.equal(admitDockerJob({...base, auth_strategy: strategy}).ok,
    strategy === 'docker-stored-secret', strategy);
});

test('owner jobs keep their guest-visible strategies', () => {
  for (const strategy of GUEST_VISIBLE) {
    const job = {...borrowedJob(specs.find(s => s.id === 'gemini').spec), execution_scope: 'owner', auth_strategy: strategy};
    assert.equal(admitDockerJob(job).ok, true, strategy);
  }
});

for (const strategy of [undefined, 'docker-stored-secret']) {
  test(`borrowed opencode refuses ${strategy ?? 'absent strategy'} at admission and prepare`, async () => {
    const job = {...borrowedJob(specs.find(s => s.id === 'opencode').spec), auth_strategy: strategy};
    const calls = [];
    const backend = new DockerSbxBackend({runCommand: async args => { calls.push(args); throw new Error('unexpected sandbox call'); },
      storage: {supported: async () => { throw new Error('unexpected storage probe'); }}});
    assert.equal(admitDockerJob(job).code, 'native_credentials_owner_only');
    assert.equal((await backend.admitJob({...job, required_limits: ['guest_block_device_capacity']})).code, 'native_credentials_owner_only');
    await assert.rejects(backend.prepare(job), {code: 'native_credentials_owner_only'});
    assert.deepEqual(calls, []);
  });
}

// Inspect only files created under this test's synthetic home and scratch root.
async function assertNoMarker(directory) {
  for (const item of await readdir(directory, {withFileTypes: true})) {
    const file = join(directory, item.name);
    if (item.isDirectory()) await assertNoMarker(file);
    else if (item.isFile()) assert.equal((await readFile(file)).includes(Buffer.from(FAKE_KEY)), false, file);
  }
}

const lendingSpecs = HARNESS_ADAPTERS.map(adapter => adapter.lendingSpec ?? adapter.spec);
for (const image of new Set(lendingSpecs.map(spec => spec.install))) {
  test(`borrowed ${image}: synthetic provider values never enter guest env, argv or files`, async t => {
    const home = await mkdtemp(join(tmpdir(), 'pf2-'));
    const envNames = ['FARAVAN_SBX_HOME', 'FARAVAN_SCRATCH_ROOT', ...KEY_VARS, 'GH_TOKEN', 'CODEX_API_KEY',
      'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
    const saved = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
    for (const name of envNames) process.env[name] = name.endsWith('HOME') || name.endsWith('ROOT') ? home : FAKE_KEY;
    t.after(async () => {
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      await rm(home, {recursive: true, force: true});
    });
    assert.equal(JSON.stringify(sanitizedEnv(Object.fromEntries(envNames.slice(2).map(name => [name, FAKE_KEY])))).includes(FAKE_KEY), false);
    const runner = sbxRunner(createSbxPolicy({globalRules: []}));
    const copies = [];
    const backend = new DockerSbxBackend({home, runCommand: async (args, options) => {
      assert.equal(JSON.stringify({args, env: options?.env, input: options?.input}).includes(FAKE_KEY), false);
      if (args[0] === 'cp') copies.push(await readFile(args[1]));
      return runner.run(args, options);
    }, hostDisk: {free: async () => ({free: 2 ** 40})},
    imagePins: {...loadImagePins(), agents: {...loadImagePins().agents, gemini: 'sha256:' + '1'.repeat(64)}}});
    const spec = lendingSpecs.find(spec => spec.install === image);
    const job = borrowedJob(spec);
    // A missing label must not silently select the image's proxy or guest mechanism.
    await assert.rejects(backend.prepare({...job, auth_strategy: undefined}), {code: 'native_credentials_owner_only'});
    if (spec.credential_in_guest) {
      await assert.rejects(backend.prepare(job), {code: 'native_credentials_owner_only'});
      assert.deepEqual(runner.calls, []);
    } else {
      const handle = await backend.prepare(job);
      try {
        assert.equal(JSON.stringify(handle._credentialEnv ?? []).includes(FAKE_KEY), false);
        assert.equal(handle._credentialEnv, undefined, 'borrowed guests receive no native credential environment');
        assert.ok(runner.calls.some(args => ['create', 'run'].includes(args[0])), 'positive control reaches sandbox creation');
        await assertNoMarker(home);
        for (const bytes of copies) assert.equal(bytes.includes(Buffer.from(FAKE_KEY)), false);
      } finally { await backend.destroy(handle); }
    }
    assert.equal(JSON.stringify(runner.calls).includes(FAKE_KEY), false);
  });
}

// A broker account job's only guest secret is a one-job broker key (the provider credential stays on the host), so a
// harness built for that may run borrowed through an account. Without the account flag the floor is unchanged.
test('borrowed pi: refused as a plain job, admitted only as a broker account job; a native file strategy is never admitted', () => {
  const pi = specs.find(s => s.spec.harness_id === 'pi').spec;
  assert.equal(admitDockerJob(borrowedJob(pi)).code, 'native_credentials_owner_only');
  assert.equal(admitDockerJob(borrowedJob(pi), {accountBroker: true}).ok, true);
  for (const strategy of GUEST_VISIBLE.filter(s => s !== 'guest-env-api-key'))
    assert.equal(admitDockerJob({...borrowedJob(pi), auth_strategy: strategy}, {accountBroker: true}).code, 'native_credentials_owner_only');
  // The image and strategy must still match the catalog spec.
  assert.equal(admitDockerJob({...borrowedJob(pi), image: 'claude'}, {accountBroker: true}).code, 'native_credentials_owner_only');
});
