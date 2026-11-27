import test from 'node:test';
import assert from 'node:assert/strict';
import {jobAnnouncements} from './announcements.mjs';
import {jobsListVM} from './view-models.mjs';

// PRODUCT-UX-FIELD-RESEARCH §14.2: job-state changes are spoken once through the polite notice region,
// deduplicated by job + run + state. The first load is never spoken; logs are never spoken.
const job = (digest, state, extra = {}) => ({job_digest: 'sha256:' + digest.padEnd(64, '0'), role: 'sent', state, title: 'Fix the date check', ...extra});

test('the first load seeds what is known and says nothing', () => {
  const out = jobAnnouncements(null, [job('a', 'Running')]);
  assert.deepEqual(out.messages, []);
  assert.equal(out.seen.size, 1);
});

test('a change of state is announced once, then not again on a re-read', () => {
  const first = jobAnnouncements(null, [job('a', 'Running')]);
  const ready = jobAnnouncements(first.seen, [job('a', 'Finished')]);
  assert.equal(ready.messages.length, 1);
  assert.match(ready.messages[0], /^Fix the date check: /);
  assert.deepEqual(jobAnnouncements(ready.seen, [job('a', 'Finished')]).messages, []);
});

test('a new run of the same job in the same state is a new announcement', () => {
  const a = jobAnnouncements(null, [job('a', 'Running', {current_attempt: {attempt_id: 'r1', state: 'active'}})]);
  const b = jobAnnouncements(a.seen, [job('a', 'Running', {current_attempt: {attempt_id: 'r2', state: 'active'}})]);
  assert.equal(b.messages.length, 1);
});

test('a job that appears after the first load is announced; a missing list changes nothing', () => {
  const a = jobAnnouncements(null, []);
  assert.equal(jobAnnouncements(a.seen, [job('b', 'Waiting')]).messages.length, 1);
  const kept = jobAnnouncements(a.seen, null);
  assert.equal(kept.seen, a.seen);
  assert.deepEqual(kept.messages, []);
});

test('several changes at once are one short sentence, not a stream', () => {
  const a = jobAnnouncements(null, [job('a', 'Running'), job('b', 'Running'), job('c', 'Running')]);
  const b = jobAnnouncements(a.seen, [job('a', 'Finished'), job('b', 'Failed'), job('c', 'Finished')]);
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0], '3 jobs changed. Open Jobs to see them.');
});

test('jobs folded into a batch row on the Jobs page are still announced one by one', () => {
  const now = Date.parse('2026-10-20T15:00:00Z');
  const ran = (digest, state) => job(digest, state, {role: 'ran', updated_at: '2026-10-20T14:0' + digest.charCodeAt(0) % 10 + ':00Z'});
  const jobs = [ran('a', 'Running'), ran('b', 'Running'), ran('c', 'Running')];
  const vm = jobsListVM(jobs, {now, computerZone: 'UTC'});
  assert.ok(vm.groups.some(g => g.items.some(i => i.batch && i.rows.length === 3)), 'the real view model batches these rows');
  const first = jobAnnouncements(null, jobs, {now, computerZone: 'UTC'});
  assert.equal(first.seen.size, 3);
  const next = jobAnnouncements(first.seen, [ran('a', 'Finished'), ran('b', 'Running'), ran('c', 'Running')], {now, computerZone: 'UTC'});
  assert.equal(next.messages.length, 1);
});

test('the open job page speaks for itself: the slower list never announces its status (r8 O16)', () => {
  const first = jobAnnouncements(null, [job('a', 'Running'), job('b', 'Running')], {open: 'sha256:' + 'a'.padEnd(64, '0')});
  const next = jobAnnouncements(first.seen, [job('a', 'Finished'), job('b', 'Finished')], {open: 'sha256:' + 'a'.padEnd(64, '0')});
  assert.equal(next.messages.length, 1, 'only the job that is not open');
  assert.equal(next.seen.size, 2, 'the open job is still recorded, so it is not announced when its page closes');
  const closed = jobAnnouncements(next.seen, [job('a', 'Finished'), job('b', 'Finished')]);
  assert.deepEqual(closed.messages, []);
});

test('retained history survives disappearance, reconnect and same-attempt state cycles', () => {
  const running = Object.freeze(job('history', 'Running', {current_attempt: Object.freeze({attempt_id: 'r1'})}));
  const jobs = Object.freeze([running]);
  const first = jobAnnouncements(null, jobs);
  const entries = [...first.seen], history = [...first.seen.history];
  const empty = jobAnnouncements(first.seen, []);
  assert.equal(empty.seen.size, 0, 'latest display snapshot stays separate');
  assert.deepEqual(jobAnnouncements(empty.seen, jobs).messages, []);
  const finished = jobAnnouncements(empty.seen, [job('history', 'Finished', {current_attempt: 'r1'})]);
  assert.equal(finished.messages.length, 1);
  const again = jobAnnouncements(finished.seen, jobs);
  assert.deepEqual(again.messages, []);
  assert.equal(jobAnnouncements(again.seen, [job('history', 'Running', {current_attempt: 'r2'})]).messages.length, 1);
  assert.deepEqual([...first.seen], entries, 'input snapshot is not mutated');
  assert.deepEqual([...first.seen.history], history, 'input history is not mutated');
  assert.notEqual(empty.seen.history, first.seen.history);
  for (const missing of [undefined, null, {}, 'unavailable']) {
    const out = jobAnnouncements(finished.seen, missing);
    assert.equal(out.seen, finished.seen);
    assert.deepEqual(out.messages, []);
  }
});

test('same digest in different circles binds each attempt to its own circle', () => {
  const a = job('shared', 'Running', {circle: {id: 'a'}, current_attempt: 'a1'});
  const b = job('shared', 'Running', {circle: {id: 'b'}, current_attempt: 'b1'});
  const first = jobAnnouncements(null, [a, b]);
  const changed = jobAnnouncements(first.seen, [{...a, current_attempt: 'a2'}, b]);
  assert.equal(changed.messages.length, 1);
  assert.deepEqual(jobAnnouncements(changed.seen, [b, {...a, current_attempt: 'a2'}]).messages, []);
  const newCircle = jobAnnouncements(changed.seen, [{...a, circle: {id: 'c'}, current_attempt: 'a2'}]);
  assert.equal(newCircle.messages.length, 1);
});

test('tuple identity does not collide at delimiter boundaries', () => {
  const a = job('unused', 'Running', {job_digest: 'digest|circle', circle: {id: 'tail'}, current_attempt: 'r'});
  const b = job('unused', 'Running', {job_digest: 'digest', circle: {id: 'circle|tail'}, current_attempt: 'r'});
  const first = jobAnnouncements(null, [a]);
  const second = jobAnnouncements(first.seen, [b]);
  assert.equal(second.messages.length, 1);
  assert.deepEqual(jobAnnouncements(second.seen, [a]).messages, []);
});

test('history retains 512 identities, evicts oldest deterministically, and rereads do not refresh age', () => {
  const jobs = Array.from({length: 513}, (_, i) => job('bounded-' + String(i).padStart(4, '0'), 'Running', {title: 'Bounded job ' + i}));
  const first = jobAnnouncements(null, jobs.slice(0, 512));
  assert.deepEqual(first.messages, []);
  assert.equal(first.seen.history.size, 512);
  const original = [...first.seen.history];
  const reread = jobAnnouncements(first.seen, [jobs[0]]);
  assert.deepEqual([...reread.seen.history], original);
  const added = jobAnnouncements(reread.seen, [jobs[512]]);
  assert.equal(added.messages.length, 1);
  assert.equal(added.seen.history.size, 512);
  assert.deepEqual([...added.seen.history].slice(0, 511), original.slice(1));
  assert.deepEqual(jobAnnouncements(added.seen, [jobs[1]]).messages, []);
  assert.equal(jobAnnouncements(added.seen, [jobs[0]]).messages.length, 1, 'evicted identities may be announced again');
  const oversized = jobAnnouncements(null, jobs);
  assert.deepEqual(oversized.messages, []);
  assert.equal(oversized.seen.history.size, 512);
  assert.deepEqual([...oversized.seen.history], [...added.seen.history]);

  // The immutable entry history knows 512 rows even if output insertion evicts one.
  // Exercise the actual view model, with distinct titles exposing which row spoke.
  let current = oversized.seen;
  const traversals = [jobs, jobs, [...jobs].reverse(), [...jobs].reverse(),
    jobs.flatMap(item => [item, item]), [...jobs].reverse().flatMap(item => [item, item]), jobs];
  for (const [index, traversal] of traversals.entries()) {
    const entries = [...current], history = [...current.history];
    const entryIds = new Set(history.map(signature => JSON.parse(signature)[0]));
    assert.equal(entryIds.has(jobs[index].job_digest), false, 'the next FIFO identity is absent at call entry');
    for (const item of jobs.filter(item => item !== jobs[index]))
      assert.equal(entryIds.has(item.job_digest), true, 'every other identity is retained at entry');
    const expectedRow = jobsListVM([jobs[index]]).groups[0].rows[0];
    assert.equal(expectedRow.title, 'Bounded job ' + index);
    const output = jobAnnouncements(current, traversal);
    assert.deepEqual(output.messages, [expectedRow.title + ': ' + expectedRow.word + '.'],
      'only the entry-absent identity speaks, once, regardless of traversal or duplicates');
    assert.equal(output.seen.size, 513, 'latest snapshot still contains every job');
    assert.equal(output.seen.history.size, 512, 'bounded output never grows');
    assert.deepEqual([...output.seen.history].slice(0, 511), history.slice(1),
      'known rereads do not refresh FIFO age');
    assert.equal(JSON.parse([...output.seen.history].at(-1))[0], jobs[index].job_digest);
    assert.deepEqual([...current], entries, 'input Map stays unchanged');
    assert.deepEqual([...current.history], history, 'input history stays unchanged');
    assert.notEqual(output.seen, current);
    assert.notEqual(output.seen.history, current.history);
    current = output.seen;
  }
});

test('open-job suppression is retained after disappearance and page close', () => {
  const a = job('open-history', 'Running');
  const first = jobAnnouncements(null, []);
  const open = jobAnnouncements(first.seen, [a], {open: a.job_digest});
  assert.deepEqual(open.messages, []);
  const empty = jobAnnouncements(open.seen, []);
  assert.deepEqual(jobAnnouncements(empty.seen, [a]).messages, []);
});
