import test from 'node:test';
import assert from 'node:assert/strict';
import {savedCopyNote} from './saved-copy.mjs';

const now = Date.parse('2026-10-21T06:00:00Z'), circles = [{id: 'c1', name: 'Weekend projects'}, {id: 'c2', name: 'Lab'}];
test('live rows say nothing', () => {
  assert.equal(savedCopyNote([{job_digest: 'a', circle: {id: 'c1'}}], circles, {now}), '');
  assert.equal(savedCopyNote(null, circles, {now}), '');
});
test('a saved copy names the unreachable circle once, with its age and no status code', () => {
  const rows = [{circle: {id: 'c1'}, savedAt: '2026-10-21T05:57:00Z'}, {circle: {id: 'c1'}, savedAt: '2026-10-21T05:58:00Z'}];
  assert.equal(savedCopyNote(rows, circles, {now}), 'The circle “Weekend projects” is unreachable. Showing what Faravan saved 3 min ago.');
  assert.doesNotMatch(savedCopyNote(rows, circles, {now}), /\d{3}|error/);
});
test('a job page record names its circle by id; two circles are both named', () => {
  assert.equal(savedCopyNote({circle: 'c2', savedAt: '2026-10-21T05:59:30Z'}, circles, {now}), 'The circle “Lab” is unreachable. Showing what Faravan saved just now.');
  assert.match(savedCopyNote([{circle: {id: 'c1'}, savedAt: '2026-10-21T05:59:30Z'}, {circle: {id: 'c2'}, savedAt: '2026-10-21T05:59:30Z'}], circles, {now}), /^The circle “Weekend projects” and the circle “Lab” are unreachable\./);
  assert.match(savedCopyNote({circle: 'zz', savedAt: '2026-10-21T05:59:30Z'}, circles, {now}), /^The circle’s host is unreachable\./);
});
// Judge r10 R1: a copy served because the host was busy is never called unreachable, on any computer.
test('a copy saved because the host was busy says Faravan is catching up, never unreachable', () => {
  const busy = [{circle: {id: 'c1'}, savedAt: '2026-10-21T05:58:00Z', savedReason: 'busy'}];
  assert.equal(savedCopyNote(busy, circles, {now}), 'Faravan is catching up with the circle “Weekend projects”. Showing what it saved 2 min ago.');
  assert.doesNotMatch(savedCopyNote(busy, circles, {now}), /unreachable/);
  const mixed = [...busy, {circle: {id: 'c2'}, savedAt: '2026-10-21T05:59:30Z', savedReason: 'unreachable'}];
  assert.match(savedCopyNote(mixed, circles, {now}), /^The circle “Lab” is unreachable\./, 'only the circle that did not answer is unreachable');
  assert.doesNotMatch(savedCopyNote(mixed, circles, {now}), /Weekend projects/);
});
