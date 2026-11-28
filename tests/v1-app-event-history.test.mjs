import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as p from '../lib/protocol/index.mjs';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';

const jobPath = digest => '/api/jobs/' + encodeURIComponent(digest);
const submit = (owner, circle) => api(owner.app, '/api/jobs', { method: 'POST', headers: { 'faravan-confirm': 'yes' }, body: { circle: circle.id,
  git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt: 'SECRET-PROMPT task', harness: 'codex' } });

test('activity history survives an app restart, filters by circle and job, and never stores the prompt or source', { timeout: 30000 }, async t => {
  const f = await appFixture(t), { owner, circle } = await f.connect();
  const { jobDigest } = await submit(owner, circle);
  const first = await api(owner.app, '/api/activity/history?job=' + encodeURIComponent(jobDigest));
  assert.ok(first.events.some(e => e.type === 'job' && e.job === jobDigest && e.data.status === 'Waiting'));
  assert.equal(first.retention.days, 90);
  assert.equal(first.retention.durable, true);
  const lastId = Math.max(...(await api(owner.app, '/api/activity')).map(e => e.id));

  await owner.app.close();
  const raw = await readFile(join(owner.home, 'v1', 'history', 'events.jsonl'), 'utf8');
  for (const secret of ['SECRET-PROMPT', 'github.com', '1'.repeat(40)]) assert.ok(!raw.includes(secret), secret + ' is not history');

  const again = await f.start('owner', { pollMs: 250 });
  const after = await api(again.app, '/api/activity/history?job=' + encodeURIComponent(jobDigest));
  const kept = new Set(after.events.map(e => e.id));
  assert.ok(first.events.every(e => kept.has(e.id)), 'rows stored before the restart come back after it');
  const scoped = await api(again.app, '/api/activity/history?circle=' + encodeURIComponent(circle.id));
  assert.ok(scoped.events.length && scoped.events.every(e => e.circle === circle.id));
  assert.deepEqual((await api(again.app, '/api/activity/history?circle=not-a-circle')).events, []);

  // A new event after restart gets an id above every id the previous run handed out, stored or not.
  const second = await submit(again, circle);
  const fresh = (await api(again.app, '/api/activity')).filter(e => e.type === 'job' && e.data.job_digest === second.jobDigest);
  assert.ok(fresh.length && fresh.every(e => e.id > lastId), 'SSE ids keep rising across restart');

  await api(again.app, '/api/activity/history?limit=0', { status: 400 });
  await api(again.app, '/api/activity/history?before=x', { status: 400 });
  await api(again.app, '/api/activity/history?job=not-a-digest', { status: 400 });
  await api(again.app, '/api/activity/history?types=../x', { status: 400 });
});

test('job timeline route joins the signed job, coordinator attempt and stage reports, with honest gaps', { timeout: 30000 }, async t => {
  const f = await appFixture(t), { owner, circle } = await f.connect();
  const { jobDigest } = await submit(owner, circle);
  const base = f.override, attempt = '33333333-3333-4333-8333-333333333333', calls = [];
  f.override = async ctx => {
    if (!ctx.route.startsWith('/jobs/' + jobDigest.slice(7) + '/progress')) return base(ctx);
    const after = Number(new URL(ctx.req.url, 'http://x').searchParams.get('after') ?? 0);
    calls.push(after);
    const all = [
      { job: jobDigest, attempt, seq: 1, at: '2026-10-19T12:00:00Z', stage: 'preparing', elapsed_s: 0 },
      { job: jobDigest, attempt, seq: 2, at: '2026-10-19T12:00:20Z', step: 'Editing a.js', kind: 'step' },
      { job: jobDigest, attempt, seq: 3, at: '2026-10-19T12:00:21Z', stage: 'agent', elapsed_s: 21 },
    ].filter(e => e.seq > after).slice(0, 2);
    const bytes = Buffer.from(p.canonicalize({ job_digest: jobDigest, entries: all, next_after: all.at(-1)?.seq ?? after }));
    ctx.res.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length }); ctx.res.end(bytes);
    return true;
  };
  const timeline = await api(owner.app, jobPath(jobDigest) + '/timeline?circle=' + encodeURIComponent(circle.id));
  assert.deepEqual(calls, [0, 2, 3], 'pages through the progress channel until it stops advancing');
  assert.equal(timeline.job_digest, jobDigest);
  assert.equal(timeline.complete, false);
  const by = Object.fromEntries(timeline.stages.map(s => [s.key, s]));
  assert.equal(typeof by.sent.at, 'string');
  assert.equal(by.preparing.durationMs, 21000, 'lender monotonic clock');
  assert.ok(!('running' in by), 'agent progress alone is not coordinator evidence that execution started');
  assert.ok(!('finished' in by));
  assert.equal(timeline.retention.days, 90);
  assert.ok(!JSON.stringify(timeline).includes('Editing a.js'), 'steps (agent output) are not part of the timeline');
});
