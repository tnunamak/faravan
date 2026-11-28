import './helpers/no-browser.mjs';
import {testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSbxBackend } from '../lib/docker-backend.mjs';
import { createLender } from '../lib/v1/lender.mjs';
import { lenderFixture, until } from './helpers/v1-lender-fixture.mjs';

for (const guarded of [false, true]) for (const stream of ['stdout', 'stderr', 'both']) {
  test('M3: raw ' + stream + ' is bounded before ' + (guarded ? 'guard filtering' : 'log forwarding'), async t => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-output-test-'));
    const executable = join(root, 'sbx');
    const output = stream === 'both' ? 'process.stdout.write("line\\n".repeat(16)); process.stderr.write("line\\n".repeat(16));' :
      'process.' + stream + '.write("safe line\\n".repeat(100));';
    await writeFile(executable, '#!' + process.execPath + '\n' + output + '\n', { mode: 0o700 });
    const previous = process.env.FARAVAN_SBX_BIN;
    process.env.FARAVAN_SBX_BIN = executable;
    t.after(async () => {
      if (previous === undefined) delete process.env.FARAVAN_SBX_BIN; else process.env.FARAVAN_SBX_BIN = previous;
      await rm(root, { recursive: true, force: true });
    });
    const calls = [], logs = [];
    const backend = new DockerSbxBackend({ cleanupDirectory: join(root, 'journal'), guestRuntime:async()=>({node:'/data/node',sha256:'0'.repeat(64)}), runCommand: async args => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    } });
    backend.assertActive=async()=>{};backend._dispatchProtected=async(_h,signal,launch)=>{signal?.throwIfAborted();return launch();}; // This fixture supplies admission and exercises raw output accounting.
    const scratch = join(root, 'scratch', 'wf-job-wf-0123456789abcdef-output');
    await mkdir(scratch, { recursive: true });
    const previousScratch = process.env.FARAVAN_SCRATCH_ROOT;
    process.env.FARAVAN_SCRATCH_ROOT = join(root, 'scratch');
    t.after(() => { if (previousScratch === undefined) delete process.env.FARAVAN_SCRATCH_ROOT; else process.env.FARAVAN_SCRATCH_ROOT = previousScratch; });
    const handle = { ...testSbxRuntimeFields(),sandbox_id: 'wf-0123456789abcdef', scratch_dir: scratch, _entrypoint: 'true',
      _resources: { output_bytes: 128 },
      job_id: 'wf-pull-0000000000000000-81234567',
      _deadline: { controller: new AbortController(), endsAt: performance.now() + 60_000 } };
    // Stopping a sandbox needs the record that this dispatch created it.
    backend.cleanupJournal.register(handle);
    backend.cleanupJournal.mark(handle, { create: 'dispatched', compute_created: true });
    await assert.rejects(backend.start(handle, { onLog: entry => logs.push(entry),
      ...(guarded ? { lendingBudget: { agent: 'claude' } } : {}) }), { code: 'output_too_large' });
    assert.ok(logs.reduce((n, entry) => n + entry.chunk.byteLength, 0) <= 128);
    assert.ok(calls.some(args => args[0] === 'stop'), 'kill the sandbox, not just the host exec client');
    assert.equal(handle._lastExecStdout, undefined, 'oversized output is not retained as a result');
  });
}

for (const stream of ['stdout', 'stderr']) test('M3: lender cancels a cumulative ' + stream + ' flood before collection', async t => {
  const f = await lenderFixture(t, { mutateJob: job => { job.requirements.limits.output_bytes = 2048; } });
  const start = f.backend.start.bind(f.backend);
  f.backend.start = async (handle, options = {}) => {
    await start(handle, options);
    if (handle._lastExecStdout?.includes('turn.completed')) {
      for (let n = 0; n < 100; n++) options.onLog?.({ stream, chunk: Buffer.from('ordinary progress line\n'.repeat(5)) });
    }
  };
  f.backend.cancel = async () => { f.calls.push(['cancel']); };
  const controller = new AbortController();
  const lender = createLender({...f.runOptions, client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy,
    clock: f.clock, approve: async () => true, credentialValues: async () => [], onEvent: event => f.events.push(event) });
  const running = lender.start(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  await until(() => f.events.some(event => ['failed', 'stopped', 'finished'].includes(event.status)), 'terminal result');
  assert.ok(f.calls.some(([kind]) => kind === 'cancel'), 'output overflow cancels immediately');
  assert.ok(f.calls.some(([kind]) => kind === 'destroy'));
  assert.equal(f.calls.some(([kind]) => kind === 'collect'), false);
  assert.ok(f.events.filter(event => event.status === 'transcript').reduce((n, event) => n + Buffer.byteLength(event.chunk), 0) <= 2048);
  assert.ok(f.events.some(event => event.reason === 'output_too_large'));
});
