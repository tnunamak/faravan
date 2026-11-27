import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';

// Judge r13 triage (item 2): deleting a job stops the owner's parked watch, and a job the host no longer has is not polled.
// The host goes terminal without waking the owner's watch, and the owner then deletes the job.
const jobInput = circle => ({circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40),
  prompt: 'Synthetic job the owner deletes', harness: 'codex'});

// The host's answers for one job: it goes terminal silently, accepts the owner's delete, and answers 404 afterwards.
async function deletedWhileWatched(t) {
  const f = await appFixture(t);
  const {owner, circle} = await f.connect();
  const sent = await api(owner.app, '/api/jobs', {method: 'POST', body: jobInput(circle)});
  const hex = sent.jobDigest.slice(7);
  await waitFor(() => (f.jobWatches.get(sent.jobDigest)?.size ?? 0) > 0, 'the owner watch parks on the job');
  const previous = f.override;
  const counts = {reads: 0, counting: false};
  f.override = async record => {
    const owned = record.req.headers['x-test-device'] === 'owner';
    if (owned && record.req.method === 'POST' && record.route === '/jobs/' + hex + '/delete') {
      f.jobs.delete(sent.jobDigest);
      record.res.writeHead(200, {'content-type': 'application/json'});
      // The client accepts only canonical JSON, which sorts its keys.
      record.res.end(JSON.stringify({at: new Date().toISOString(), deleted: true, job_digest: sent.jobDigest}));
      return true;
    }
    if (owned && record.req.method === 'GET' && record.route === '/jobs/' + hex) {
      if (counts.counting) counts.reads++;
      if (!f.jobs.has(sent.jobDigest)) {
        record.res.writeHead(404, {'content-type': 'application/problem+json'});
        record.res.end(JSON.stringify({code: 'job_not_found', status: 404}));
        return true;
      }
    }
    return previous(record);
  };
  f.jobs.get(sent.jobDigest).state = 'cancelled';
  await api(owner.app, '/api/jobs/' + sent.jobDigest + '/delete', {method: 'POST', body: {circle: circle.id}});
  return {f, sent, counts};
}

test('deleting a job stops its parked watch', {timeout: 60000}, async t => {
  const {f, sent} = await deletedWhileWatched(t);
  await waitFor(() => (f.jobWatches.get(sent.jobDigest)?.size ?? 0) === 0, 'the delete stops the owner watch', 1500);
});

test('a job the host deleted is not polled after its watch answers 404', {timeout: 60000}, async t => {
  const {f, sent, counts} = await deletedWhileWatched(t);
  counts.counting = true;
  for (const wake of [...(f.jobWatches.get(sent.jobDigest) ?? [])]) wake();
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.ok(counts.reads <= 2, `the owner read a deleted job ${counts.reads} times after the host answered 404`);
});
