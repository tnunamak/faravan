import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createLender } from '../lib/v1/lender.mjs';
import { readArchiveFiles } from '../lib/archive.mjs';
import { lenderFixture, until } from './helpers/v1-lender-fixture.mjs';
import { makeRepo } from './helpers/git-guest.mjs';

function launch(f) {
  const controller = new AbortController();
  const lender = createLender({ client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async () => true, onEvent: event => f.events.push(event) });
  let failure; const settled = Promise.resolve(lender.start(controller.signal)).catch(error => { failure = error; });
  f.stop = async () => { controller.abort(); await settled; if (failure && failure.name !== 'AbortError' && failure.code !== 'aborted') throw failure; };
}
const finished = f => f.events.some(e => e.label?.startsWith('Finished.'));
// The fixture fakes the generic tree pack; run the real guest-side commands for output-folder packs.
function realPack(f) {
  const start = f.backend.start, collect = f.backend.collectDeclaredOutputs;
  f.backend.start = async (handle, opts) => {
    if (/^mkdir -p \.wf-result '/.test(handle._entrypoint)) { f.calls.push(['pack-output', handle._entrypoint]); execFileSync('sh', ['-c', handle._entrypoint], { cwd: handle.scratch_dir }); return; }
    if (/--append-system-prompt|developer_instructions/.test(handle._entrypoint)) f.calls.push(['framed', handle._entrypoint]);
    return start(handle, opts);
  };
  f.backend.collectDeclaredOutputs = async (handle, manifest) => f.calls.some(([k]) => k === 'pack-output')
    ? manifest.map(path => ({ path, bytes_content: execFileSync('cat', [join(handle.scratch_dir, path)]) }))
    : collect(handle, manifest);
}
const typedJob = (kind = 'message') => job => { job.source = { kind: 'none' }; job.result = { kind }; job.requirements.capabilities = ['results_v1']; };
const treeNames = bytes => readArchiveFiles(bytes, { gzip: true }).map(file => file.path).sort();

test('a no-source message job runs in an empty workspace and returns the faravan-output/ tree', { timeout: 20000 }, async t => {
  let seen;
  const f = await lenderFixture(t, { mutateJob: typedJob(), agent: async dir => {
    seen = await readdir(dir);
    await mkdir(join(dir, 'faravan-output'), { recursive: true });
    await writeFile(join(dir, 'faravan-output/chart.csv'), 'a,b\n');
    await writeFile(join(dir, 'scratch.txt'), 'not returned\n');
  } });
  realPack(f);
  launch(f); await until(() => finished(f), 'finished'); await f.stop();
  assert.deepEqual(seen, [], 'nothing was materialized before the agent started');
  assert.equal(f.calls.some(([k]) => k === 'clone'), false);
  const claim = f.requests.find(r => r.route === '/jobs/claim-next');
  assert.ok(claim.body.advertisement.capabilities.includes('results_v1'), 'new lenders advertise results_v1');
  assert.match(f.calls.find(([k]) => k === 'framed')[1], /final message is what they read/);
  const { candidate, receipt, output } = f.result.payload;
  assert.deepEqual(output, { kind: 'message' });
  assert.match(f.artifacts.get(f.result.payload.transcript.digest).toString(), /turn\.completed/, 'the final message travels in the signed transcript');
  assert.equal(candidate.media_type, 'application/gzip');
  assert.deepEqual(receipt.source, { kind: 'none' });
  assert.equal(receipt.candidate_format, 'tree');
  assert.equal(receipt.diff_unavailable, undefined);
  assert.deepEqual(receipt.capabilities_applied, ['results_v1']);
  assert.deepEqual(treeNames(f.artifacts.get(candidate.digest)), ['faravan-output/chart.csv']);
});

test('a message job whose agent saved no files returns an empty tree', { timeout: 20000 }, async t => {
  const f = await lenderFixture(t, { mutateJob: typedJob() });
  realPack(f);
  launch(f); await until(() => finished(f), 'finished'); await f.stop();
  assert.deepEqual(f.result.payload.output, { kind: 'message' });
  assert.deepEqual(treeNames(f.artifacts.get(f.result.payload.candidate.digest)), []);
});

test('a files job on a pinned git source returns faravan-output/, not a diff', { timeout: 20000 }, async t => {
  const repo = await makeRepo(); t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const f = await lenderFixture(t, { mutateJob: job => { job.source = { kind: 'git', url: 'https://github.com/example/synthetic.git', object_format: 'sha1', commit: repo.commit };
    job.result = { kind: 'files' }; job.requirements.capabilities = ['results_v1']; },
  onClone: handle => execFileSync('git', ['clone', '-q', repo.dir, join(handle.scratch_dir, 'repo')]),
  agent: async dir => { await writeFile(join(dir, 'repo/README.md'), 'edited\n'); await mkdir(join(dir, 'repo/faravan-output'));
    await writeFile(join(dir, 'repo/faravan-output/out.txt'), 'made\n'); } });
  realPack(f);
  launch(f); await until(() => finished(f), 'finished'); await f.stop();
  const { candidate, receipt, output } = f.result.payload;
  assert.deepEqual(output, { kind: 'files' });
  assert.equal(receipt.verified_commit, repo.commit);
  assert.equal(receipt.candidate_format, 'tree');
  assert.deepEqual(treeNames(f.artifacts.get(candidate.digest)), ['faravan-output/out.txt'], 'the source tree and edits stay out');
  assert.equal(f.calls.some(([k, cmd]) => k === 'run' && /faravan-git-base/.test(cmd ?? '')), false);
});

test('daily and requester minutes stop at run end before delayed delivery', {timeout: 60000}, async t => {
  const f = await lenderFixture(t, {hold: true});
  let deliveryStarted = false, finishDelivery;
  const delivery = new Promise(resolve => { finishDelivery = resolve; });
  const complete = f.client.completeAttempt.bind(f.client);
  f.client.completeAttempt = async (...args) => {
    deliveryStarted = true;
    await delivery;
    return complete(...args);
  };
  t.after(() => finishDelivery());
  launch(f);
  // The runtime contribution counts from the durable launch report, so wait for it before time passes.
  await until(() => f.events.some(event => event.status === 'running'), 'run started');
  f.clock.advance(15000);
  f.execution.resolve();
  await until(() => deliveryStarted, 'delivery started after removal');
  f.clock.advance(60000);
  finishDelivery();
  await until(() => finished(f) && f.saved().pending === null, 'final counters saved');
  await f.stop();
  const key = JSON.stringify([f.job.payload.circle, f.job.payload.author]);
  assert.equal(f.saved().milliseconds, 15000, 'delivery time is not daily runtime');
  assert.deepEqual(f.saved().requesters[key], {jobs: 1, milliseconds: 15000});
  const runtime = f.events.find(event => event.contribution?.kind === 'runtime').contribution;
  assert.equal(runtime.milliseconds, 15000);
});

test('legacy code-change jobs carry no output and keep their framing', { timeout: 20000 }, async t => {
  const f = await lenderFixture(t, {});
  realPack(f);
  launch(f); await until(() => finished(f), 'finished'); await f.stop();
  assert.equal(f.result.payload.output, undefined);
  assert.match(f.calls.find(([k]) => k === 'framed')[1], /reviews the changes/);
});
