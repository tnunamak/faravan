import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDevice } from '../lib/v1/device.mjs';
import { acquireProcessLock } from '../lib/v1/lock.mjs';

// A circle this computer joined: not owned, no coordinator. Leaving it needs no network, so the only waits are the locks.
const JOINED = {id: '11111111-1111-4111-8111-111111111111', name: 'Friends', origin: null, owned: false, lifecycle: 'active', pinnedRootFingerprint: null, lanMode: false};

async function openWithJoinedCircle(t) {
  const home = await mkdtemp(join(tmpdir(), 'spk-leave-own-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const device = await openDevice({home, origin: null});
  const stateFile = join(home, 'v1', 'state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.circles.push(JOINED);
  await writeFile(stateFile, JSON.stringify(state));
  return {device, home, stateFile};
}

// What an ownership transfer does to this device's state: the saved roster names this device as owner.
async function becomeOwner(stateFile) {
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  for (const circle of state.circles) if (circle.id === JOINED.id) Object.assign(circle, {owned: true, lifecycle: 'active'});
  await writeFile(stateFile, JSON.stringify(state));
}

test('leave does not forget a circle that became owned while it waited for the owner lock', async t => {
  const {device, home, stateFile} = await openWithJoinedCircle(t);
  // A transfer that accepts ownership holds the owner lock while it saves the roster that names this device owner.
  const transfer = await acquireProcessLock(join(home, 'v1', 'owner-' + JOINED.id + '.lock'), {timeoutMs: 0});
  const leaving = device.leaveCircle(JOINED.id).then(value => ({value}), error => ({error}));
  await becomeOwner(stateFile);
  transfer();
  const outcome = await leaving;
  assert.equal(outcome.error?.code, 'ownership_transfer_required', JSON.stringify(outcome));
  assert.equal((await device.listCircles()).some(c => c.id === JOINED.id && c.owned === true), true, 'the circle this device now owns stays');
});

test('leave re-checks ownership under the state lock before it removes the membership', async t => {
  const {device, home, stateFile} = await openWithJoinedCircle(t);
  // A roster saved without the owner lock (a background refresh) holds only the state lock while it writes.
  const save = await acquireProcessLock(join(home, 'v1', 'state.lock'), {timeoutMs: 0});
  const leaving = device.leaveCircle(JOINED.id).then(value => ({value}), error => ({error}));
  await becomeOwner(stateFile);
  save();
  const outcome = await leaving;
  assert.equal(outcome.error?.code, 'ownership_transfer_required', JSON.stringify(outcome));
  assert.equal((await device.listCircles()).some(c => c.id === JOINED.id && c.owned === true), true, 'the circle this device now owns stays');
});

test('leave still forgets a circle this device does not own when nothing changes', async t => {
  const {device} = await openWithJoinedCircle(t);
  const result = await device.leaveCircle(JOINED.id);
  assert.deepEqual([result.left, result.leaveRequested], [true, false]);
  assert.equal((await device.listCircles()).some(c => c.id === JOINED.id), false);
});
