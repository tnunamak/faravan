import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api} from './helpers/offers-jobs-fixture.mjs';

// The job page reads the choice the person made from the signed job, so it can show it while the job waits, runs or fails.
test('the job the sender reads carries the automatic choice from the signed job, and a plain job carries none', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const {owner, circle} = await f.connect();
  const base = {circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), harness: 'codex'};
  const asked = await api(owner.app, '/api/jobs', {method: 'POST', body: {...base, prompt: 'Pick for me', auto_run_v1: {intent: 'cheapest'}}});
  const plain = await api(owner.app, '/api/jobs', {method: 'POST', body: {...base, prompt: 'Use the default'}});
  const read = async digest => api(owner.app, '/api/jobs/' + digest + '?circle=' + encodeURIComponent(circle.id));
  assert.equal((await read(asked.jobDigest)).requestedAutoRun, 'cheapest');
  assert.equal(Object.hasOwn(await read(plain.jobDigest), 'requestedAutoRun'), false);
});
