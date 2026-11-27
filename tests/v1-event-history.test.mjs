import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventHistory, projectEvent, buildJobTimeline, HISTORY_RETENTION_DAYS } from '../lib/v1/event-history.mjs';

const DAY = 86400000, T0 = Date.parse('2026-10-20T12:00:00Z');
const digest = n => 'sha256:' + String(n).repeat(64).slice(0, 64);
// Writes are asynchronous: each test's histories are flushed before its directory is removed.
const opened = new Map();
async function dir(t) {
  const d = await mkdtemp(join(tmpdir(), 'sk-history-'));
  opened.set(d, []);
  t.after(async () => { await Promise.all(opened.get(d).map(h => h.flush())); await rm(d, { recursive: true, force: true }); });
  return d;
}
async function open(directory, options = {}) { const h = createEventHistory({ directory, ...options }); opened.get(directory)?.push(h); await h.load(); return h; }
const at = ms => new Date(ms).toISOString();

test('history survives a reopen and ids keep rising past any id handed out before it', async t => {
  const d = await dir(t); let clock = T0;
  const first = await open(d, { now: () => clock });
  const ids = [];
  for (const status of ['Waiting', 'Running', 'Finished']) {
    const id = first.nextId(); ids.push(id);
    first.record({ id, type: 'job', at: at(clock += 1000), data: { job_digest: digest(1), circle: 'c1', status } });
  }
  const unpersisted = first.nextId(); // A transient event (e.g. readiness) still uses an id.
  await first.flush();
  const second = await open(d, { now: () => clock });
  const page = second.page({});
  assert.deepEqual(page.events.map(e => e.data.status), ['Finished', 'Running', 'Waiting']);
  assert.deepEqual(page.events.map(e => e.id), [...ids].reverse());
  assert.ok(second.nextId() > unpersisted, 'a restarted app never reuses an SSE id');
});

test('history never stores prompts, titles, sources or other free text', async t => {
  const d = await dir(t), h = await open(d, { now: () => T0 });
  const job = { payload: { circle: 'c1', author: 'k-author', created_at: at(T0), prompt: 'SECRET-PROMPT', source: { git: 'https://token@example.com/x.git' } } };
  h.record({ id: h.nextId(), type: 'approval', at: at(T0), data: { id: 'a1', jobDigest: digest(2), job, prompt: 'SECRET-PROMPT', requester: 'k-author', source: job.payload.source, expiresAt: T0 + 60000 } });
  h.record({ id: h.nextId(), type: 'job', at: at(T0), data: { job_digest: digest(2), job, status: 'Waiting', title: 'SECRET-TITLE', inviteTask: { title: 'SECRET-TITLE' } } });
  h.record({ id: h.nextId(), type: 'attention', at: at(T0), data: { label: "Lending couldn't continue.", remedy: 'Check the circle connection.' } });
  h.record({ id: h.nextId(), type: 'attention', at: at(T0), data: { label: 'sbx: /home/ana/.claude/token=SECRET-OUTPUT', remedy: 'SECRET-OUTPUT' } });
  h.record({ id: h.nextId(), type: 'job', at: at(T0), data: { job_digest: digest(5), status: 'Failed: /home/ana/repo SECRET-OUTPUT',
    current_attempt: { attempt_id: 'att/../SECRET-OUTPUT', holder: 'https://SECRET-OUTPUT', state: 'failed' }, job: { payload: { author: 'ana /SECRET-OUTPUT' } } } });
  h.record({ id: h.nextId(), type: 'enrollment', at: at(T0), data: { circle: 'c1', state: 'pending', code: 'MATCH-1234', enrollmentId: 'e1', deviceName: 'Laptop' } });
  await h.flush();
  const raw = await readFile(join(d, 'events.jsonl'), 'utf8');
  for (const secret of ['SECRET-PROMPT', 'SECRET-TITLE', 'token@', 'MATCH-1234', 'SECRET-OUTPUT', '/home/', 'Check the circle']) assert.ok(!raw.includes(secret), secret + ' must not be stored');
  assert.equal(raw.trim().split('\n').length, 4, 'unknown attention text and a job event with no valid status are dropped');
  assert.deepEqual(h.page({ types: ['attention'] }).events.map(e => e.data), [{ code: 'lending_stopped' }], 'attention is stored as a code');
  assert.equal(projectEvent('readiness', { refresh: true }), null, 'transient refresh signals are not history');
  assert.equal(projectEvent('job', { job_digest: digest(2), title: 'renamed' }), null, 'a title change is not an observation');
});

test('repeated identical observations are stored once', async t => {
  const d = await dir(t), h = await open(d, { now: () => T0 });
  for (let i = 0; i < 5; i++) h.record({ id: h.nextId(), type: 'lending', at: at(T0 + i), data: { circle: 'c1', status: 'idle', current: null, label: 'Waiting', counters: { jobs: i } } });
  h.record({ id: h.nextId(), type: 'lending', at: at(T0 + 9), data: { circle: 'c1', status: 'running', current: 'att-1' } });
  assert.deepEqual(h.page({}).events.map(e => e.data.status), ['running', 'idle']);
});

test(`events older than ${HISTORY_RETENTION_DAYS} days are dropped on load and the cutoff is stated`, async t => {
  const d = await dir(t); let clock = T0;
  const h = await open(d, { now: () => clock });
  h.record({ id: h.nextId(), type: 'lending-action', at: at(T0), data: { circle: 'c1', action: 'on' } });
  h.record({ id: h.nextId(), type: 'lending-action', at: at(T0 + 50 * DAY), data: { circle: 'c1', action: 'off' } });
  await h.flush();
  clock = T0 + 95 * DAY;
  const later = await open(d, { now: () => clock });
  const page = later.page({});
  assert.deepEqual(page.events.map(e => e.data.action), ['off']);
  assert.equal(page.retention.days, 90);
  assert.equal(page.retention.cutoff, at(clock - 90 * DAY));
  assert.ok(!(await readFile(join(d, 'events.jsonl'), 'utf8')).includes('"on"'), 'expired rows leave the disk too');
});

test('the file stays under its byte cap and says history was trimmed', async t => {
  const d = await dir(t), h = await open(d, { now: () => T0, maxBytes: 4096 });
  for (let i = 0; i < 200; i++) h.record({ id: h.nextId(), type: 'lending-action', at: at(T0 + i), data: { circle: 'c' + i, action: i % 2 ? 'on' : 'off' } });
  await h.flush();
  const lines = (await readFile(join(d, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).id);
  assert.equal(new Set(lines).size, lines.length, 'a compaction and the appends queued behind it never store a row twice');
  assert.ok((await stat(join(d, 'events.jsonl'))).size <= 4096);
  const page = h.page({ limit: 200 });
  assert.equal(page.events[0].data.circle, 'c199', 'newest kept');
  assert.ok(page.events.length < 200);
  assert.equal(typeof page.retention.trimmedBefore, 'string');
  const reopened = await open(d, { now: () => T0, maxBytes: 4096 });
  assert.equal(reopened.page({}).retention.trimmedBefore, page.retention.trimmedBefore, 'the trim note survives restart');
});

test('a corrupt line is skipped, not fatal', async t => {
  const d = await dir(t);
  const good = JSON.stringify({ id: 7, at: at(T0), type: 'lending-action', circle: 'c1', job: null, data: { circle: 'c1', action: 'on' } });
  await writeFile(join(d, 'events.jsonl'), good + '\n{"id":8,"at":\n');
  const h = await open(d, { now: () => T0 });
  assert.deepEqual(h.page({}).events.map(e => e.id), [7]);
  assert.ok(h.nextId() > 8);
});

test('filters are strict by circle and job, and pages walk back with an explicit cursor', async t => {
  const d = await dir(t), h = await open(d, { now: () => T0 });
  const N = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five'];
  for (let i = 0; i < 6; i++) h.record({ id: h.nextId(), type: 'job', at: at(T0 + i), data: { job_digest: digest(i % 2 + 1), circle: i % 3 ? 'c1' : 'c2', status: N[i] } });
  h.record({ id: h.nextId(), type: 'agents', at: at(T0 + 7), data: { id: 'codex', useForLending: true } });
  assert.deepEqual(h.page({ circle: 'c2' }).events.map(e => e.data.status), ['Three', 'Zero']);
  assert.deepEqual(h.page({ job: digest(1) }).events.map(e => e.data.status), ['Four', 'Two', 'Zero']);
  assert.deepEqual(h.page({ circle: 'c1', job: digest(2) }).events.map(e => e.data.status), ['Five', 'One']);
  assert.ok(!h.page({ circle: 'c1' }).events.some(e => e.type === 'agents'), 'device events have no circle');
  const one = h.page({ circle: 'c1', limit: 2 });
  assert.deepEqual(one.events.map(e => e.data.status), ['Five', 'Four']);
  const two = h.page({ circle: 'c1', limit: 2, before: one.nextBefore });
  assert.deepEqual(two.events.map(e => e.data.status), ['Two', 'One']);
  assert.equal(two.nextBefore, null);
  assert.throws(() => h.page({ limit: 0 }), /invalid_request/);
  assert.throws(() => h.page({ before: -1 }), /invalid_request/);
});

test('an approval decision is linked to its job even though the decision event names only the card', async t => {
  const d = await dir(t), h = await open(d, { now: () => T0 });
  h.record({ id: h.nextId(), type: 'approval', at: at(T0), data: { id: 'a1', jobDigest: digest(3), job: { circle: 'c1', author: 'k' }, prompt: 'x' } });
  await h.flush();
  const reopened = await open(d, { now: () => T0 });
  reopened.record({ id: reopened.nextId(), type: 'approval', at: at(T0 + 5000), data: { id: 'a1', state: 'accepted' } });
  assert.deepEqual(reopened.page({ job: digest(3) }).events.map(e => e.data.state), ['accepted', 'waiting']);
});

test('timeline: real stages only, durations only from one clock, missing times say so', () => {
  const job = { job_digest: digest(4), state: 'result-accepted', job: { payload: { created_at: '2026-10-20T12:00:00Z' } },
    current_attempt: { attempt_id: 'att', state: 'completed', claimed_at: '2026-10-20T12:01:00Z', execution_started_at: '2026-10-20T12:02:00Z', execution_observed_at: '2026-10-20T12:02:10Z', stopped_at: '2026-10-20T12:09:00Z' } };
  const progress = [
    { seq: 1, at: '2026-10-20T12:01:30Z', stage: 'preparing', elapsed_s: 0 },
    { seq: 2, at: '2026-10-20T12:02:15Z', step: 'Editing a.js', kind: 'step' },
    { seq: 3, at: '2026-10-20T12:02:20Z', stage: 'agent', elapsed_s: 41 },
    { seq: 4, at: '2026-10-20T12:08:40Z', stage: 'sending', elapsed_s: 420 },
  ];
  const history = [
    { id: 1, at: '2026-10-20T12:01:05Z', type: 'approval', data: { approvalId: 'a', state: 'waiting' } },
    { id: 2, at: '2026-10-20T12:01:25Z', type: 'approval', data: { approvalId: 'a', state: 'accepted' } },
  ];
  const t = buildJobTimeline({ view: job, progress, history });
  assert.deepEqual(t.stages.map(s => s.key), ['sent', 'picked_up', 'approval', 'preparing', 'running', 'sending', 'finished']);
  const by = Object.fromEntries(t.stages.map(s => [s.key, s]));
  assert.equal(by.preparing.durationMs, 41000, 'from the lender monotonic clock');
  assert.equal(by.running.durationMs, 379000);
  assert.equal(by.sending.durationMs, null, 'no shared clock to the end');
  assert.equal(by.approval.durationMs, 20000, 'both ends on this computer');
  assert.equal(by.approval.outcome, 'accepted');
  assert.equal(by.sent.durationMs, null, 'sender and coordinator clocks differ');
  assert.equal(by.running.at, '2026-10-20T12:02:10.000Z', 'execution start beats the delayed progress report; times are normalized ISO');
  assert.equal(by.finished.outcome, 'completed');
  assert.ok(t.stages.every(s => s.at === null || typeof s.at === 'string'));

  const borrower = buildJobTimeline({ view: { ...job, state: 'claimed', current_attempt: { ...job.current_attempt, state: 'active', execution_started_at: null, execution_observed_at: null, stopped_at: null } }, progress: [], history: [] });
  assert.deepEqual(borrower.stages.map(s => s.key), ['sent', 'picked_up']);
  assert.equal(borrower.complete, false);

  const requestOnly = buildJobTimeline({ view: { ...job, state: 'claimed', current_attempt: { ...job.current_attempt,
    state: 'active', execution_observed_at: null, stopped_at: null } },
    progress: [{ seq: 1, at: '2026-10-20T12:02:20Z', stage: 'agent', elapsed_s: 41 }], history: [] });
  assert.ok(!requestOnly.stages.some(stage => stage.key === 'running'), 'agent progress is not launch evidence');

  const durableAttempt = projectEvent('job', { job_digest: digest(7), status: 'Working', current_attempt: {
    attempt_id: 'att', execution_started_at: '2026-10-20T12:02:00Z', execution_observed_at: null } }).data.current_attempt;
  assert.equal(Object.hasOwn(durableAttempt, 'execution_observed_at'), true, 'explicit unknown survives durable projection');
  assert.equal(durableAttempt.execution_observed_at, null);
  const oldAttempt = projectEvent('job', { job_digest: digest(7), status: 'Working', current_attempt: {
    attempt_id: 'att', execution_started_at: '2026-10-20T12:02:00Z' } }).data.current_attempt;
  assert.equal(Object.hasOwn(oldAttempt, 'execution_observed_at'), false, 'legacy rows are not backfilled');

  const unknown = buildJobTimeline({ view: { job_digest: digest(4), state: 'failed', job: { payload: {} }, current_attempt: null }, progress: [], history: [{ id: 9, at: '2026-10-20T13:00:00Z', type: 'job', data: { status: 'Failed' } }] });
  assert.deepEqual(unknown.stages.map(s => [s.key, s.at, s.noticed]), [['sent', null, false], ['finished', '2026-10-20T13:00:00.000Z', true]]);
});

test('a disk failure never throws into the app: events keep ids and the page says history is not durable', async t => {
  const d = await dir(t), blocked = join(d, 'not-a-directory');
  await writeFile(blocked, 'x'); // mkdir/append under a regular file fail with ENOTDIR.
  const h = createEventHistory({ directory: join(blocked, 'v1'), now: () => T0 });
  const loaded = await h.load();
  assert.equal(loaded.durable, false);
  const first = h.nextId(), second = h.nextId();
  assert.ok(second > first);
  assert.ok(h.record({ id: second, type: 'lending-action', at: at(T0), data: { circle: 'c1', action: 'on' } }));
  await h.flush();
  const page = h.page({});
  assert.equal(page.events.length, 1, 'still served from memory');
  assert.equal(page.retention.durable, false);
});

test('deduplication remembers retained rows only after the history cap trims older jobs',async t=>{
 const d=await dir(t),h=await open(d,{now:()=>T0,maxBytes:2048});
 const row={job_digest:digest(1),circle:'c1',status:'Waiting'};
 h.record({id:h.nextId(),type:'job',at:at(T0),data:row});
 for(let i=0;i<50;i++)h.record({id:h.nextId(),type:'lending-action',at:at(T0+i+1),data:{circle:'circle'+i,action:'off'}});
 assert.equal(h.page({job:digest(1)}).events.length,0);
 assert.ok(h.record({id:h.nextId(),type:'job',at:at(T0+60),data:row}));
 assert.equal(h.page({job:digest(1)}).events.length,1);
});


test('measurement failure diagnostics survive sanitized disk restoration', async t => {
  const {createMeasurementHistory} = await import('../lib/v1/event-history.mjs');
  const directory = await dir(t);
  const first = createMeasurementHistory({directory,now:()=>T0});
  const classes = ['probe_busy','probe_deferred','probe_unavailable','probe_cancelled','usage_http_503',
    'rate_limited','identity_failed','sandbox_start_failed','parse_failed','timeout','other'];
  for (const failure_class of classes) first.record('observation_failed',{
    classification:'new_source',reason:'refresh_failed',
    started_wall_ms:T0,started_monotonic_ns:'1',completed_wall_ms:T0,completed_monotonic_ns:'2',
    probe:{reason:'guest_failed',provider:'codex',failure_class,retry_at:T0+300_000,
      token:'SECRET_TOKEN',body:'SECRET_BODY',account_id:'SECRET_ACCOUNT'}});
  first.record('observation_failed',{classification:'new_source',reason:'refresh_failed',
    probe:{reason:'SECRET_REASON',provider:'SECRET_PROVIDER',failure_class:'SECRET_CLASS',retry_at:Infinity}});
  await first.flush(); first.close();
  const file = join(first.directory,'measurements.jsonl');
  const original = await readFile(file,'utf8');
  assert.doesNotMatch(original,/SECRET_|account_id|token|body/);
  // Force a rewrite through the restore projection, not just an unchanged disk read.
  await writeFile(file,original+'{broken\n');
  const reopened = createMeasurementHistory({directory,now:()=>T0});
  try {
    await reopened.flush();
    const raw = await readFile(file,'utf8');
    const rows = raw.trim().split('\n').map(JSON.parse).filter(row=>row.type==='observation_failed');
    assert.deepEqual(rows.slice(0,classes.length).map(row=>row.data.probe.failure_class),classes);
    assert.ok(rows.slice(0,classes.length).every(row=>row.data.probe.provider==='codex'));
    assert.equal(rows.find(row=>row.data.probe.failure_class==='rate_limited').data.probe.retry_at,T0+300_000);
    assert.ok(rows.filter(row=>row.data.probe.failure_class!=='rate_limited').every(row=>!Object.hasOwn(row.data.probe,'retry_at')));
    assert.deepEqual(rows.at(-1).data.probe,{reason:'unreadable'});
    assert.doesNotMatch(raw,/SECRET_|account_id|token|body/);
  } finally { await reopened.flush(); reopened.close(); }
});

test('deferred measurement rows survive readback, strip secrets and reject malformed reasons or retry times', async t => {
  const {createMeasurementHistory} = await import('../lib/v1/event-history.mjs');
  const directory = await dir(t);
  const first = createMeasurementHistory({directory,now:()=>T0});
  const data = reason => ({classification:'new_source',reason,
    started_wall_ms:T0,started_monotonic_ns:'1',completed_wall_ms:T0,completed_monotonic_ns:'2',
    probe:{reason,provider:'codex',failure_class:'rate_limited',deferral_cause:'rate_limited',retry_at:T0+300_000,
      body:'SECRET_BODY',token:'SECRET_TOKEN'}});
  for (const reason of ['account_busy','probe_deferred']) assert.ok(first.record('observation_deferred',data(reason)));
  assert.equal(first.record('observation_deferred',data('rate_limited')),null);
  await first.flush(); first.close();
  const file = join(first.directory,'measurements.jsonl');
  const raw = await readFile(file,'utf8');
  const original = raw.trim().split('\n').map(JSON.parse);
  const deferred = original.filter(row=>row.type==='observation_deferred');
  assert.equal(deferred.length,2);
  assert.equal(original.filter(row=>row.type==='observation_failed').length,0);
  assert.equal(deferred[1].data.probe.failure_class,'probe_deferred');
  assert.equal(deferred[1].data.probe.deferral_cause,'rate_limited');
  assert.equal(deferred[0].data.probe.retry_at,undefined);
  assert.doesNotMatch(raw,/SECRET_/);
  let sequence = Math.max(...original.map(row=>row.sequence));
  const invalid = [
    {...deferred[1].data,reason:'refresh_failed'},
    {...deferred[1].data,probe:{...deferred[1].data.probe,retry_at:-1}},
    {...deferred[1].data,probe:{...deferred[1].data.probe,deferral_cause:'SECRET_CAUSE'}},
    {...deferred[1].data,probe:{...deferred[1].data.probe,failure_class:'rate_limited'}},
  ].map(data=>({...deferred[1],sequence:++sequence,data}));
  await writeFile(file,raw+invalid.map(row=>JSON.stringify(row)+'\n').join(''));
  const reopened = createMeasurementHistory({directory,now:()=>T0});
  try {
    await reopened.flush();
    const restored = (await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(restored.filter(row=>row.type==='observation_deferred'),deferred);
    assert.equal(restored.filter(row=>row.type==='observation_failed').length,0);
    assert.ok(restored.some(row=>row.type==='capture_gap'&&row.data.reason==='invalid_record'));
    assert.doesNotMatch(JSON.stringify(restored),/SECRET_/);
  } finally {await reopened.flush();reopened.close();}
});

test('measurement history at its cap does not rewrite the whole file for every new row', async t => {
  const {createMeasurementHistory} = await import('../lib/v1/event-history.mjs');
  const {rename} = await import('node:fs/promises');
  const directory = await dir(t);
  let rewrites = 0;
  const writer = {async rewrite(path, content) { rewrites++; await writeFile(path + '.t', content); await rename(path + '.t', path); }};
  const history = createMeasurementHistory({directory, now:()=>T0, maxBytes:64 * 1024, writer});
  const row = i => ({classification:'new_source',reason:'refresh_failed',started_wall_ms:T0,started_monotonic_ns:String(i),
    completed_wall_ms:T0,completed_monotonic_ns:String(i + 1),probe:{reason:'guest_failed',provider:'codex',failure_class:'timeout'}});
  // About 100 rows fill 64 KiB; the next 300 arrive at the cap. Before the fix each of them rewrote the file.
  for (let i = 0; i < 400; i++) { assert.ok(history.record('observation_failed', row(i))); await history.flush(); }
  history.close();
  assert.ok(rewrites * 10 < 300, `300 rows at the cap caused ${rewrites} whole-file rewrites`);
  const size = (await stat(join(directory, 'measurements', 'measurements.jsonl'))).size;
  assert.ok(size <= 64 * 1024, `file stays under its cap (${size})`);
});

test('a restart marker below the cap keeps every measurement row', async t => {
  const {createMeasurementHistory} = await import('../lib/v1/event-history.mjs');
  const directory = await dir(t), maxBytes = 64 * 1024;
  const row = i => ({classification:'new_source',reason:'refresh_failed',started_wall_ms:T0,started_monotonic_ns:String(i),
    completed_wall_ms:T0,completed_monotonic_ns:String(i + 1),probe:{reason:'guest_failed',provider:'codex',failure_class:'timeout'}});
  const first = createMeasurementHistory({directory, now:()=>T0, maxBytes});
  const file = join(first.directory, 'measurements.jsonl');
  // Fill to about 80% of the cap: above the 75% low-water mark, below the cap.
  for (let i = 0; (await stat(file).then(s => s.size, () => 0)) < maxBytes * 0.8; i++) { first.record('observation_failed', row(i)); await first.flush(); }
  first.close();
  // No capture_epoch_ended row was recorded, so the reopen appends an unclean_restart marker.
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  const before = lines.filter(line => JSON.parse(line).type === 'observation_failed').length;
  const reopened = createMeasurementHistory({directory, now:()=>T0, maxBytes});
  try {
    await reopened.flush();
    const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(r => r.type === 'observation_failed').length, before);
    assert.equal(rows.at(-1).data.reason, 'unclean_restart');
  } finally { await reopened.flush(); reopened.close(); }
});

test('a refusal from a limit window that is missing or unreadable keeps its reason in the decision history', async t => {
  const {createMeasurementHistory} = await import('../lib/v1/event-history.mjs');
  const directory = await dir(t);
  const history = createMeasurementHistory({directory, now: () => T0});
  const reasons = ['lending_window_missing', 'lending_window_memory_unreadable', 'lending_window_invalid'];
  for (const reason of reasons)
    assert.ok(history.record('admission_decided', {outcome: 'refused', reason, policy_version: 'objective/m1', dial: 'balanced'}));
  await history.flush(); history.close();
  const rows = (await readFile(join(history.directory, 'measurements.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.filter(row => row.type === 'admission_decided').map(row => row.data.reason), reasons);
});
