import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createTar } from '../lib/tar-writer.mjs';
import { digestBytes } from '../lib/protocol/index.mjs';
import { createLender } from '../lib/v1/lender.mjs';
import { lenderFixture, until } from './helpers/v1-lender-fixture.mjs';
import { extractSourceArchive } from '../lib/source-archive.mjs';
import { runJob, buildValidatedJobSpec } from '../lib/executor.mjs';
import { deferred } from './helpers/v1-lender-fixture.mjs';

for (const kind of ['expanded bytes', 'entry count']) test('M4: remote source cannot exceed lender ' + kind, async t => {
  const entries = kind === 'expanded bytes' ? [{ name: 'bomb', data: Buffer.alloc(20 * 1024 * 1024 + 1), type: '0' }] :
    Array.from({ length: 1001 }, (_, i) => ({ name: 'entry-' + i, data: Buffer.alloc(0), type: '0' }));
  const bytes = gzipSync(createTar(entries.map(entry => ({ ...entry, mode: 0o644 }))));
  const artifact = { digest: digestBytes(bytes), bytes: bytes.length, media_type: 'application/gzip' };
  const f = await lenderFixture(t, { mutateJob: job => { job.source = { kind: 'archive', artifact }; } });
  f.artifacts.set(artifact.digest, bytes);
  const controller = new AbortController();
  const lender = createLender({ client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy,
    clock: f.clock, approve: async () => true, credentialValues: async () => [], onEvent: event => f.events.push(event) });
  const running = lender.start(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  await until(() => f.events.some(event => ['declined', 'failed', 'finished'].includes(event.status)), 'source outcome');
  assert.ok(f.events.some(event => event.status === 'declined' && event.reason === 'too_large'));
  assert.equal(f.calls.some(([kind]) => kind === 'run'), false);
  assert.ok(f.calls.some(([kind]) => kind === 'destroy'));
  assert.deepEqual(await readdir(f.root), [], 'validation rejects before writing any member');
});

test('M4: small source budgets reject bytes and headers before writes; valid executable sources still extract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'source-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tar = createTar([{ name: 'run.sh', data: Buffer.from('echo ok\n'), mode: 0o755, type: '0' }]);
  await assert.rejects(extractSourceArchive(gzipSync(tar), root, { limits: { maxTotalBytes: 7 } }), { code: 'too_large' });
  await assert.rejects(extractSourceArchive(tar, root, { limits: { maxEntries: 0 } }), { code: 'too_large' });
  assert.deepEqual(await readdir(root), []);
  await extractSourceArchive(gzipSync(tar), root);
  assert.equal(await readFile(join(root, 'run.sh'), 'utf8'), 'echo ok\n');
  assert.equal((await stat(join(root, 'run.sh'))).mode & 0o777, 0o755);
});

test('M4: extraction deadline leaves the event loop responsive and joins the worker before returning', async t => {
  const root = await mkdtemp(join(tmpdir(), 'source-worker-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tar = createTar([{ name: 'never-written', data: Buffer.alloc(100), mode: 0o644, type: '0' }]);
  let responsive = false;
  const tick = new Promise(resolve => setImmediate(() => { responsive = true; resolve(); }));
  await assert.rejects(extractSourceArchive(gzipSync(tar), root, { timeoutMs: 1 }), { code: 'source_timeout' });
  await tick;
  assert.equal(responsive, true);
  assert.deepEqual(await readdir(root), []);
});

test('M4: cancellation waits for source writes to stop before deleting scratch', async () => {
  const entered = deferred(), stopped = deferred(), calls = [];
  const controller = new AbortController();
  const jobSpec = buildValidatedJobSpec({ taskDigest: 'a'.repeat(64),
    harness: { image: 'claude', egress_provider_hosts: ['api.anthropic.com'] }, entrypointWithPrompt: 'true' });
  const backend = { admitJob: () => ({ ok: true }), probeCapabilities: async () => ({ available: true }),
    prepare: async () => ({ scratch_dir: '/synthetic-source', _entrypoint: 'true' }),
    cancel: async () => { calls.push('cancel'); }, destroy: async () => { calls.push('destroy'); return { removed: true }; } };
  const execution = runJob({ jobSpec, backend, signal: controller.signal,
    materializeSource: async () => { entered.resolve(); await stopped.promise; calls.push('writer-stopped'); } });
  execution.catch(() => {});
  await entered.promise;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  const destroyedEarly = calls.includes('destroy');
  stopped.resolve();
  await assert.rejects(execution);
  assert.equal(destroyedEarly, false, 'no deletion while source writes can still recreate the workspace');
  assert.ok(calls.indexOf('writer-stopped') < calls.indexOf('destroy'));
});
