import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobMetaStore } from '../../lib/v1/job-meta.mjs';

// Conservative assumption: observe receives an already verified coordinator view.
// This tests local persistence, not signature validation or exactly-once external apply.
test('verified first completion survives restart and duplicate observation keeps one attempt', async () => {
  const home = await mkdtemp(join(tmpdir(), 'foundation-results-'));
  const directory = join(home, 'jobs');
  const digest = 'sha256:' + 'a'.repeat(64);
  const resultDigest = 'sha256:' + 'b'.repeat(64);
  let store = createJobMetaStore(directory);
  try {
    await store.record(digest, { prompt: 'synthetic', circle: 'test-circle', submittedAt: '2026-01-01T00:00:00Z' });
    const completion = { current_attempt: {
      attempt_id: '00000000-0000-4000-8000-000000000001',
      generation: 1, state: 'completed',
    }, result_digest: resultDigest };
    await store.observe(digest, completion);
    await store.settled();
    store = createJobMetaStore(directory);
    assert.deepEqual((await store.get(digest)).runs, [{
      ...completion.current_attempt, result_digest: resultDigest,
    }]);
    await Promise.all([store.observe(digest, completion), store.observe(digest, completion)]);
    await store.observe(digest, { current_attempt: { ...completion.current_attempt, state: 'running' } });
    const runs = (await store.get(digest)).runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state, 'completed');
    assert.equal(runs[0].result_digest, resultDigest);
  } finally { await store.settled(); await rm(home, { recursive: true, force: true }); }
});

test('conservative assumption: signed payload still needs exact retained attempt and executor checks', async () => {
  const { checkAttempt, checkExecutor, checkJobDigest } = await import('../../lib/protocol/index.mjs');
  const holder = 'sha256:' + 'c'.repeat(64);
  const job = 'sha256:' + 'a'.repeat(64);
  const attempt = { attempt_id: '00000000-0000-4000-8000-000000000001', generation: 2, holder };
  const result = { ...attempt, executor: holder, job_digest: job };
  assert.equal(checkAttempt(result, attempt).ok, true);
  assert.equal(checkExecutor(result, holder, attempt).ok, true);
  assert.equal(checkJobDigest(result, job).ok, true);
  assert.equal(checkAttempt({ ...result, generation: 1 }, attempt).code, 'stale_attempt');
  assert.equal(checkAttempt({ ...result, attempt_id: '00000000-0000-4000-8000-000000000002' }, attempt).code, 'stale_attempt');
  assert.equal(checkExecutor(result, 'sha256:' + 'd'.repeat(64), attempt).code, 'executor_mismatch');
  assert.equal(checkJobDigest(result, 'sha256:' + 'e'.repeat(64)).code, 'wrong_job_digest');
});
