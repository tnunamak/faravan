import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {jobCircles} from '../lib/v1/job-recipient.mjs';

// The default circle for a new job: the circle this computer lends in, then the last circle used, and only then any other.
const approved = circle => ({...circle, origin: 'https://' + circle.id + '.test', enrollment: {state: 'approved'}, rosterMembershipVerified: true});
const device = (circles, lastUsed) => ({
  listCircles: async () => circles,
  selectCircle: () => {
    const found = circles.find(c => c.id === lastUsed);
    if (!found) throw new Error('no active circle');
    return found;
  },
});
const selectedIds = list => list.filter(c => c.selected).map(c => c.id);

test('the default job circle is the one this computer lends in, even when another circle was used last', async () => {
  const circles = [approved({id: 'demo'}), approved({id: 'friends'})];
  assert.deepEqual(selectedIds(await jobCircles(device(circles, 'demo'), {lendingCircle: 'friends'})), ['friends']);
});

test('without a lending circle, the last circle used stays the default', async () => {
  const circles = [approved({id: 'demo'}), approved({id: 'friends'})];
  assert.deepEqual(selectedIds(await jobCircles(device(circles, 'demo'))), ['demo']);
  assert.deepEqual(selectedIds(await jobCircles(device(circles, 'demo'), {lendingCircle: null})), ['demo']);
});

test('a lending circle that cannot take jobs does not replace the last circle used', async () => {
  const circles = [approved({id: 'demo'}), {id: 'friends', origin: null, enrollment: {state: 'pending'}}];
  assert.deepEqual(selectedIds(await jobCircles(device(circles, 'demo'), {lendingCircle: 'friends'})), ['demo']);
});
