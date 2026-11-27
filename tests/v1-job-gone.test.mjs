import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';

// Judge r13 triage (item 3): a tracked job the coordinator no longer has leaves its watch and is not asked for again. A watch
// 404 used to start a legacy poll that read the vanished job every interval for as long as the app ran.
test('a tracked job the coordinator no longer has is dropped, not polled', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const {owner, circle} = await f.connect();
  const sent = await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, git: 'https://github.com/example/synthetic.git',
    commit: '1'.repeat(40), prompt: 'Synthetic job the coordinator forgets', harness: 'codex'}});
  const route = '/jobs/' + sent.jobDigest.slice(7);
  await waitFor(() => (f.jobWatches.get(sent.jobDigest)?.size ?? 0) > 0, 'the owner watch parks on the job');
  // The coordinator forgets the job: its record and its watch both answer job_not_found from here on.
  const previous = f.override;
  let counting = false, reads = 0;
  f.override = async record => {
    const gone = !f.jobs.has(sent.jobDigest);
    if (record.req.method === 'GET' && record.route === route && record.req.headers['x-test-device'] === 'owner') {
      if (counting) reads++;
      if (gone) {
        record.res.writeHead(404, {'content-type': 'application/problem+json'});
        record.res.end(JSON.stringify({code: 'job_not_found', status: 404}));
        return true;
      }
    }
    return previous(record);
  };
  try {
    f.jobs.delete(sent.jobDigest);
    counting = true;
    for (const wake of [...(f.jobWatches.get(sent.jobDigest) ?? [])]) wake();
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.ok(reads <= 3, `the owner asked for a job the coordinator no longer has ${reads} times in 1.5 s`);
  } finally {
    f.override = previous;
  }
});
