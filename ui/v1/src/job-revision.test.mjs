import test from 'node:test';
import assert from 'node:assert/strict';
import {JOB_REVISIONS, reviseForEvent, reviseForShell, jobRevisionOf} from './job-revision.mjs';

const A = 'sha256:' + 'a'.repeat(64), B = 'sha256:' + 'b'.repeat(64);

test('an event for one job revises that job and no other', () => {
  const next = reviseForEvent(JOB_REVISIONS, {type: 'job', data: {job_digest: A, status: 'Working'}});
  assert.notEqual(jobRevisionOf(next, A), jobRevisionOf(JOB_REVISIONS, A));
  assert.equal(jobRevisionOf(next, B), jobRevisionOf(JOB_REVISIONS, B));
});
test('lending state ticks that name no job (two accounts alternating) revise no job', () => {
  let state = JOB_REVISIONS;
  for (const account of ['claude:0', 'codex:0', 'claude:0'])
    state = reviseForEvent(state, {type: 'lending', data: {circle: 'c1', account, status: 'idle'}});
  assert.equal(jobRevisionOf(state, A), jobRevisionOf(JOB_REVISIONS, A));
});
test('a lending, approval or transcript event that names a job revises only that job', () => {
  const base = jobRevisionOf(JOB_REVISIONS, A);
  assert.notEqual(jobRevisionOf(reviseForEvent(JOB_REVISIONS, {type: 'lending', data: {status: 'working', jobDigest: A}}), A), base);
  assert.notEqual(jobRevisionOf(reviseForEvent(JOB_REVISIONS, {type: 'approval', data: {state: 'accepted', jobDigest: A}}), A), base);
  assert.equal(jobRevisionOf(reviseForEvent(JOB_REVISIONS, {type: 'lending', data: {status: 'transcript', jobDigest: A, chunk: 'x'}}), A), base);
});
test('a job event with no digest revises every job', () => {
  const next = reviseForEvent(JOB_REVISIONS, {type: 'job', data: {refresh: true}});
  assert.notEqual(jobRevisionOf(next, A), jobRevisionOf(JOB_REVISIONS, A));
  assert.notEqual(jobRevisionOf(next, B), jobRevisionOf(JOB_REVISIONS, B));
});
test('a changed Jobs list revises only the rows that changed; the first load revises none', () => {
  const rows = [{job_digest: A, state: 'waiting'}, {job_digest: B, state: 'running'}];
  assert.equal(reviseForShell(JOB_REVISIONS, 'jobs', undefined, rows), JOB_REVISIONS);
  const next = reviseForShell(JOB_REVISIONS, 'jobs', rows, [{job_digest: A, state: 'waiting'}, {job_digest: B, state: 'result-accepted'}]);
  assert.equal(jobRevisionOf(next, A), jobRevisionOf(JOB_REVISIONS, A));
  assert.notEqual(jobRevisionOf(next, B), jobRevisionOf(JOB_REVISIONS, B));
});
test('other shell resources never revise a job page', () => {
  assert.equal(reviseForShell(JOB_REVISIONS, 'devices', {a: 1}, {a: 2}), JOB_REVISIONS);
});
test('a reset event revises every job and a digest-less lending tick still revises none', () => {
  const next = reviseForEvent(JOB_REVISIONS, {type: 'reset', data: {refresh: true}});
  assert.notEqual(jobRevisionOf(next, A), jobRevisionOf(JOB_REVISIONS, A));
  assert.notEqual(jobRevisionOf(next, B), jobRevisionOf(JOB_REVISIONS, B));
});
test('a Jobs read that differs only by the status observation time revises no job', () => {
  const row = at => ({job_digest: A, state: 'queued', statusContract: {lifecycle: 'waiting', explanation: 'Waiting.', observedAt: at}});
  const next = reviseForShell(JOB_REVISIONS, 'jobs', [row('2026-10-21T00:00:00.000Z')], [row('2026-10-21T00:00:05.000Z')]);
  assert.equal(next, JOB_REVISIONS);
  const moved = reviseForShell(JOB_REVISIONS, 'jobs', [row('2026-10-21T00:00:00.000Z')], [{...row('2026-10-21T00:00:05.000Z'), state: 'claimed'}]);
  assert.notEqual(jobRevisionOf(moved, A), jobRevisionOf(JOB_REVISIONS, A));
});
test('job and approval polls ignore only projection observation-time changes', () => {
  const row = observedAt => ({job_digest:A,state:'running',jobProjection:{
    phase:'running',reasonCode:null,evidence:{rawState:'running',executionStartedAt:'2026-10-21T00:00:00.000Z'},
    version:{jobDigest:A,revision:7},times:{observedAt,validUntil:'2026-10-21T00:01:00.000Z',nextTransitionAt:'2026-10-21T00:00:30.000Z'},
  }});
  const before=row('2026-10-21T00:00:00.000Z'), observedAgain=row('2026-10-21T00:00:05.000Z');
  for (const resource of ['jobs','approvals'])
    assert.equal(reviseForShell(JOB_REVISIONS,resource,[before],[observedAgain]),JOB_REVISIONS,
      resource+' observation timestamp alone is not a transition');

  const changes=[
    ['phase',{...before.jobProjection,phase:'stopped'}],
    ['reason',{...before.jobProjection,reasonCode:'compute_stopped'}],
    ['evidence',{...before.jobProjection,evidence:{...before.jobProjection.evidence,computeStopped:true}}],
    ['version',{...before.jobProjection,version:{...before.jobProjection.version,revision:8}}],
    ['validUntil',{...before.jobProjection,times:{...before.jobProjection.times,validUntil:'2026-10-21T00:02:00.000Z'}}],
    ['nextTransitionAt',{...before.jobProjection,times:{...before.jobProjection.times,nextTransitionAt:'2026-10-21T00:00:45.000Z'}}],
  ];
  for (const [field,jobProjection] of changes) {
    const next=reviseForShell(JOB_REVISIONS,'jobs',[before],[{...before,jobProjection}]);
    assert.notEqual(jobRevisionOf(next,A),jobRevisionOf(JOB_REVISIONS,A),field+' changes are meaningful');
  }
});
test('polls and heartbeats of online computers are observations; an offline computer\'s last-seen time and any readiness change are not', () => {
  const dev = (online, poll, beat, extra = {}) => ({device: 'd1', online, source: 'poll', last_poll_at: poll, last_heartbeat_at: beat, ...extra});
  const row = devices => ({job_digest: A, state: 'queued', presence: {devices}});
  const same = reviseForShell(JOB_REVISIONS, 'jobs', [row([dev(true, 1, 1)])], [row([dev(true, 2, 31)])]);
  assert.equal(same, JOB_REVISIONS);
  for (const [name, before, after] of [
    ['went offline', dev(true, 1, 1), dev(false, 1, 1)],
    ['source changed', dev(true, 1, 1), dev(true, 1, 1, {source: 'heartbeat'})],
    ['offline last seen moved', dev(false, 1, 1), dev(false, 2, 1)],
  ]) assert.notEqual(jobRevisionOf(reviseForShell(JOB_REVISIONS, 'jobs', [row([before])], [row([after])]), A), 0, name);
});
