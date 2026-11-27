import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';
import { runV1Command } from '../lib/v1/cli.mjs';
import { createJobMetaStore, defaultTitle, cleanTitle } from '../lib/v1/job-meta.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testOptions = {timeout: 60000};
const git = 'https://github.com/example/synthetic.git';
const COMMIT = '1'.repeat(40);
const list = (app, circle) => api(app, '/api/jobs?circle=' + encodeURIComponent(circle.id));
const detail = (app, circle, digest) => api(app, '/api/jobs/' + encodeURIComponent(digest) + '?circle=' + encodeURIComponent(circle.id));

test('title defaults to the first non-empty prompt line and is shortened', () => {
  assert.equal(defaultTitle('\n  Fix the login bug  \nMore detail'), 'Fix the login bug');
  assert.equal([...defaultTitle('x'.repeat(200))].length, 80);
  assert.ok(defaultTitle('x'.repeat(200)).endsWith('…'));
  assert.equal(defaultTitle('   '), '');
  assert.equal(cleanTitle('  a‮b\nc  '), 'a b c');
});

test('the submitting device lists and shows its own title, agent, model and source, also after a restart', testOptions, async t => {
  const f = await appFixture(t), {owner, lender, circle} = await f.connect();
  const submitted = await api(lender.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, git, commit: COMMIT,
    prompt: '\nFix the login bug\nThe session cookie is dropped on redirect.', harness: 'codex', model: 'example-model'}});
  const digest = submitted.jobDigest;
  const check = (local, title) => {
    assert.equal(local.title, title);
    assert.equal(local.prompt, '\nFix the login bug\nThe session cookie is dropped on redirect.');
    assert.equal(local.agent, 'codex');
    assert.equal(local.model, 'example-model');
    assert.equal(local.source, 'github.com/example/synthetic.git @ 11111111');
    assert.match(local.submittedAt, /^\d{4}-\d{2}-\d{2}T[0-9:]+Z$/);
  };
  const [row] = await list(lender.app, circle);
  assert.equal(row.job_digest, digest);
  check(row.local, 'Fix the login bug');
  check((await detail(lender.app, circle, digest)).local, 'Fix the login bug');
  // Never sent to the circle: the coordinator-side job carries no title.
  assert.doesNotMatch(JSON.stringify(f.jobs.get(digest).job), /Fix the login bug/);
  // Another member sees the job without local facts: it did not submit it.
  assert.equal((await list(owner.app, circle))[0].local, undefined);
  // Editing the title persists; a blank title is refused.
  const edited = await api(lender.app, '/api/jobs/' + encodeURIComponent(digest) + '/title', {method: 'POST', body: {title: 'Login redirect bug'}});
  assert.equal(edited.title, 'Login redirect bug');
  await api(lender.app, '/api/jobs/' + encodeURIComponent(digest) + '/title', {method: 'POST', status: 400, body: {title: 7}});
  await api(lender.app, '/api/jobs/' + encodeURIComponent(digest) + '/title', {method: 'POST', status: 400, body: {title: '   '}});
  await api(lender.app, '/api/jobs/sha256:' + '0'.repeat(64) + '/title', {method: 'POST', status: 404, body: {title: 'Unknown job'}});
  // Restart the app on the same home.
  await lender.app.close();
  const again = await f.start('lender');
  check((await list(again.app, circle))[0].local, 'Login redirect bug');
  check((await detail(again.app, circle, digest)).local, 'Login redirect bug');
});

test('the CLI submit path records the same local facts and uploads say what they sent', testOptions, async t => {
  const f = await appFixture(t), {lender, circle} = await f.connect();
  let out = '';
  const status = await runV1Command(['job', 'submit', '--yes', '--git', git + '@' + COMMIT, '--prompt', 'CLI job title\nbody', '--harness', 'codex',
    '--circle', circle.id, '--json'], {device: lender.app.device, home: lender.home, stdout: {write: x => { out += x; }}, stderr: {write() {}}});
  assert.equal(status, 0, out);
  const upload = await api(lender.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, prompt: 'Review the files', harness: 'codex',
    files: [{path: 'README.md', base64: Buffer.from('hello\n').toString('base64')}]}});
  const rows = await list(lender.app, circle);
  const byTitle = Object.fromEntries(rows.map(row => [row.local.title, row.local]));
  assert.equal(byTitle['CLI job title'].agent, 'codex');
  assert.equal(byTitle['CLI job title'].model, null);
  assert.equal(byTitle['Review the files'].source, 'Uploaded files · 1 file');
  assert.equal(byTitle['Review the files'].sourcePath, undefined, 'temporary uploads are not reusable source folders');
  assert.equal(rows.find(row => row.job_digest === upload.jobDigest).local.title, 'Review the files');
});

test('recent activity gives an honest count of members who could take a waiting job', testOptions, async t => {
  const f = await appFixture(t), {owner, lender, circle} = await f.connect();
  const {jobDigest} = await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, git, commit: COMMIT, prompt: 'Waiting job', harness: 'codex'}});
  const presence = () => api(owner.app, '/api/circles/' + circle.id + '/presence');
  assert.deepEqual(await presence(), {online: 0, total: 1, basis: 'recent-activity'});
  // The other member currently holds an attempt on some job in the circle: it was active just now.
  const view = f.jobs.get(jobDigest);
  const claimed = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  Object.assign(view, {state: 'claimed', current_attempt: {attempt_id: '11111111-1111-4111-8111-111111111111', job_digest: jobDigest, generation: 1,
    holder: lender.app.device.keyId, state: 'active', claimed_at: claimed, lease_expires_at: claimed, reason: null, compute_stopped: false, stopped_at: null, execution_started_at: null}});
  assert.deepEqual(await presence(), {online: 1, total: 1, basis: 'recent-activity'});
});

test('settled waits for in-flight metadata writes so close never races directory removal', async t => {
  const {mkdtemp, rm, readFile} = await import('node:fs/promises');
  const {join} = await import('node:path'); const {tmpdir} = await import('node:os');
  const {createJobMetaStore} = await import('../lib/v1/job-meta.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'faravan-meta-test-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const store = createJobMetaStore(dir), digest = 'sha256:' + 'c'.repeat(64);
  store.record(digest, {title: 'One', circle: 'c', submittedAt: '2026-10-20T15:00:00Z'});
  await store.settled();
  assert.equal(JSON.parse(await readFile(join(dir, 'job-meta.json'), 'utf8'))[digest].title, 'One');
});

test('a follow-up sorts before its parent when both were submitted in the same second', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-meta-test-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const store = createJobMetaStore(dir);
  // The parent's digest sorts above the follow-up's, so a digest tie-break would put the parent first.
  const parent = 'sha256:' + 'f'.repeat(64), child = 'sha256:' + '0'.repeat(64), sameSecond = '2026-10-20T15:00:00Z';
  await store.record(parent, {title: 'Parent', circle: 'c', submittedAt: sameSecond});
  await store.record(child, {title: 'Follow-up', circle: 'c', submittedAt: sameSecond, parentJob: parent, parentResult: 'sha256:' + 'e'.repeat(64)});
  assert.deepEqual((await store.thread(child, 'c')).map(row => row.job_digest), [child, parent]);
});
