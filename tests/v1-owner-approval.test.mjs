import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../lib/protocol/index.mjs';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireProcessLockSync } from '../lib/v1/lock.mjs';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';
import { runV1Command, joinMessage } from '../lib/v1/cli.mjs';

const testOptions = {timeout: 60000};
const epoch = (app, id) => app.device.rosterCache(id).get().then(c => c.current.payload.epoch);
const members = (app, id) => app.device.rosterCache(id).get().then(c => c.current.payload.members);
const events = (app, state) => api(app, '/api/activity').then(list => list.filter(e => e.type === 'enrollment' && (!state || e.data.state === state)));

async function setup(t, {ownerOptions = {autoApprove: true}, lenderOptions = {joinWaitMs: 5000}} = {}) {
  const f = await appFixture(t);
  const owner = await f.start('owner', ownerOptions), lender = await f.start('lender', lenderOptions);
  await f.provisionFromHome('owner');
  await api(lender.app, '/api/devices', {method: 'POST', body: {name: 'Maya’s laptop'}});
  const circle = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Critics'}});
  const invite = async () => (await api(owner.app, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}})).invite;
  return {f, owner, lender, circle, invite};
}

test('repeat approval returns the same success without another roster, decision, or event', testOptions, async t => {
  const {f, owner, lender, circle, invite} = await setup(t, {ownerOptions: {autoApprove: false}, lenderOptions: {joinWaitMs: 0}});
  const joined = await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  const approve = () => api(owner.app, '/api/circles/' + circle.id + '/approve', {method: 'POST', body: {enrollmentId: joined.enrollment.enrollment_id}});
  const first = await approve();
  assert.deepEqual(first.approved, [lender.app.device.keyId]);
  const roster = await owner.app.device.rosterCache(circle.id).get();
  const decisions = await owner.app.device.intentStore(circle.id).list();
  const activity = await events(owner.app, 'approved');
  const writes = f.requests.filter(r => r.method === 'POST').length;
  assert.deepEqual(await approve(), first);
  assert.deepEqual(await approve(), first);
  assert.deepEqual(await owner.app.device.rosterCache(circle.id).get(), roster);
  assert.deepEqual(await owner.app.device.intentStore(circle.id).list(), decisions);
  assert.deepEqual(await events(owner.app, 'approved'), activity, 'repeat does not announce a second approval');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, writes, 'repeat never republishes the roster');
});

test('approval still fails after decline or removal and never accepts an unknown or other-circle request', testOptions, async t => {
  const {f, owner, lender, circle, invite} = await setup(t, {ownerOptions: {autoApprove: false}, lenderOptions: {joinWaitMs: 0}});
  const prefix = '/api/circles/' + circle.id;
  const declined = await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  const rejectedId = declined.enrollment.enrollment_id;
  await api(owner.app, prefix + '/reject', {method: 'POST', body: {enrollmentId: rejectedId}});
  const rejection = await api(owner.app, prefix + '/approve', {method: 'POST', status: 409, body: {enrollmentId: rejectedId}});
  assert.equal(rejection.code, 'enrollment_rejected');
  assert.equal(await epoch(owner.app, circle.id), 1);
  const joined = await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  const enrollmentId = joined.enrollment.enrollment_id;
  await api(owner.app, prefix + '/approve', {method: 'POST', body: {enrollmentId}});
  const otherCircle = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Other circle'}});
  const wrongCircle = await api(owner.app, '/api/circles/' + otherCircle.id + '/approve', {method: 'POST', status: 404, body: {enrollmentId}});
  assert.equal(wrongCircle.code, 'not_found');
  const missing = await api(owner.app, prefix + '/approve', {method: 'POST', status: 404, body: {enrollmentId: '00000000-0000-4000-8000-000000000000'}});
  assert.equal(missing.code, 'not_found');
  await api(owner.app, prefix + '/remove-member', {method: 'POST', body: {keyId: lender.app.device.keyId}});
  const removedRoster = await owner.app.device.rosterCache(circle.id).get();
  const removed = await api(owner.app, prefix + '/approve', {method: 'POST', body: {enrollmentId}});
  assert.deepEqual(removed.approved, []);
  assert.deepEqual(removed.rejected, [{enrollment_id: enrollmentId, code: 'enrollment_conflict'}]);
  assert.deepEqual(await owner.app.device.rosterCache(circle.id).get(), removedRoster);
  // A fresh invitation can re-add the key, but cannot revive the old approval.
  const fresh = await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  await api(owner.app, prefix + '/approve', {method: 'POST', body: {enrollmentId: fresh.enrollment.enrollment_id}});
  const rejoinedRoster = await owner.app.device.rosterCache(circle.id).get();
  await api(owner.app, prefix + '/approve', {method: 'POST', status: 404, body: {enrollmentId}});
  assert.deepEqual(await owner.app.device.rosterCache(circle.id).get(), rejoinedRoster);
});

test('a tampered pending replay cannot use a prior successful approval', testOptions, async t => {
  const {f, owner, lender, circle, invite} = await setup(t, {ownerOptions: {autoApprove: false}, lenderOptions: {joinWaitMs: 0}});
  const joined = await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  const prefix = '/api/circles/' + circle.id;
  const [pending] = await api(owner.app, prefix + '/approvals');
  await api(owner.app, prefix + '/approve', {method: 'POST', body: {enrollmentId: joined.enrollment.enrollment_id}});
  const before = await owner.app.device.rosterCache(circle.id).get();
  f.override = async ({circleId, route, req, res}) => {
    if (circleId !== circle.id || route !== '/enrollments' || req.method !== 'GET') return false;
    const replay = {enrollment_id: pending.enrollment_id, state: 'pending', invite_id: pending.invite_id,
      device_public_key: pending.device_public_key, created_at: pending.created_at,
      enrollment_proof: {...pending.enrollment_proof, signature: {...pending.enrollment_proof.signature, value: 'A'.repeat(86)}}};
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(canonicalize({items: [replay], next_cursor: null}));return true;
  };
  const result = await api(owner.app, prefix + '/approve', {method: 'POST', body: {enrollmentId: pending.enrollment_id}});
  assert.deepEqual(result.approved, []);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(await owner.app.device.rosterCache(circle.id).get(), before);
});

test('a redeemed one-time invite is approved with no click and the joiner reports success', testOptions, async t => {
  const {f, owner, lender, circle, invite} = await setup(t);
  assert.equal(await epoch(owner.app, circle.id), 1);
  const joined = await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  // The join call itself waited for the owner's device and returned an approved enrollment.
  assert.equal(joined.enrollment.state, 'approved');
  assert.equal(joined.joinInfo.approval, 'automatic');
  assert.equal(joinMessage(joined), 'Circle joined: Critics.');
  assert.equal(await epoch(owner.app, circle.id), 2);
  const roster = await members(owner.app, circle.id);
  assert.equal(roster.length, 2);
  assert.equal(roster.find(m => m.key_id === lender.app.device.keyId).device_name, 'Maya’s laptop');
  const [event] = await events(owner.app, 'approved');
  assert.equal(event.data.automatic, true);
  assert.equal(event.data.deviceName, 'Maya’s laptop');
  assert.equal(event.data.code, lender.app.device.matchCode(lender.app.device.keyId));
  assert.equal(f.requests.some(r => r.route === '/enrollments' && r.method === 'GET'), true);
  // A fresh invite approves another device the same way.
  const second = await f.start('second', {joinWaitMs: 5000});
  const again = await api(second.app, '/api/circles/join', {method: 'POST', body: {link: (await api(owner.app, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}})).invite}});
  assert.equal(again.enrollment.state, 'approved', 'a fresh invite approves a new device');
  assert.equal(await epoch(owner.app, circle.id), 3);
});

test('approve-each mode shows the signed name and a matching code, and approves one request at a time', testOptions, async t => {
  const {f, owner, lender, circle, invite} = await setup(t);
  assert.deepEqual(await api(owner.app, '/api/circles/' + circle.id + '/approval-mode', {method: 'POST', body: {approveEach: true}}), {approveEach: true});
  assert.equal((await api(owner.app, '/api/circles')).find(c => c.id === circle.id).approveEach, true);
  const other = await f.start('other', {joinWaitMs: 5000});
  await api(other.app, '/api/devices', {method: 'POST', body: {name: 'Sam’s desktop'}});
  const joined = await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  const joinedOther = await api(other.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  // The joining devices wait for a person, name the owner, and show the code the owner will see.
  for (const result of [joined, joinedOther]) {
    assert.equal(result.enrollment.state, 'pending');
    assert.equal(result.joinInfo.approval, 'each');
    assert.equal(result.joinInfo.ownerName, (await api(owner.app, '/api/devices')).ownerName);
    assert.match(joinMessage(result), new RegExp('^Waiting for ' + result.joinInfo.ownerName + ' to approve this computer\\.\\nMatch code: ' + result.joinInfo.code));
  }
  assert.match(joined.joinInfo.code, /^[0-9A-F]{6}$/);
  const pending = await waitFor(async () => {
    const list = await api(owner.app, '/api/circles/' + circle.id + '/approvals');
    return list.length === 2 && list;
  }, 'two pending requests');
  const maya = pending.find(item => item.device_name === 'Maya’s laptop'), sam = pending.find(item => item.device_name === 'Sam’s desktop');
  assert.equal(maya.device_code, joined.joinInfo.code);
  assert.equal(sam.device_code, joinedOther.joinInfo.code);
  assert.equal(maya.proof_valid, true);
  // Nobody was approved without a click, and the owner was told.
  assert.equal(await epoch(owner.app, circle.id), 1);
  await waitFor(async () => (await events(owner.app, 'pending')).length === 2, 'two pending notifications');
  const home = await api(owner.app, '/api/home');
  assert.ok(home.attention.some(item => /2 computers are waiting for your approval/.test(item.label)));
  assert.equal(home.circles.find(c => c.id === circle.id).approveEach, true);
  // Approve one request only.
  await api(owner.app, '/api/circles/' + circle.id + '/approve', {method: 'POST', body: {enrollmentId: maya.enrollment_id}});
  assert.equal(await epoch(owner.app, circle.id), 2);
  assert.deepEqual((await members(owner.app, circle.id)).map(m => m.key_id).sort(), [owner.app.device.keyId, lender.app.device.keyId].sort());
  assert.equal((await events(owner.app, 'approved'))[0].data.automatic, false);
  const left = await api(owner.app, '/api/circles/' + circle.id + '/approvals');
  assert.deepEqual(left.map(item => item.device_name), ['Sam’s desktop']);
  // Reject the other; it is never added.
  await api(owner.app, '/api/circles/' + circle.id + '/reject', {method: 'POST', body: {enrollmentId: sam.enrollment_id}});
  await new Promise(done => setTimeout(done, 200));
  assert.equal(await epoch(owner.app, circle.id), 2);
  assert.equal((await members(owner.app, circle.id)).length, 2);
  // The approved joiner notices through its own sweep.
  await lender.app.device.refreshRoster(circle.id);
  assert.equal(lender.app.device.selectCircle(circle.id).enrollment.state, 'approved');
  // Turning the mode off sends later invites back to automatic approval.
  await api(owner.app, '/api/circles/' + circle.id + '/approval-mode', {method: 'POST', body: {approveEach: false}});
  const third = await f.start('third', {joinWaitMs: 5000});
  const auto = await api(third.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  assert.equal(auto.joinInfo.approval, 'automatic');
  assert.equal(auto.enrollment.state, 'approved');
  await api(owner.app, '/api/circles/' + circle.id + '/approval-mode', {method: 'POST', status: 400, body: {approveEach: 'yes'}});
});

test('a tampered enrollment proof is never approved, automatically or by hand', testOptions, async t => {
  const {f, owner, lender, circle, invite} = await setup(t, {lenderOptions: {joinWaitMs: 400}});
  const base = f.override;
  // The coordinator (untrusted) swaps in a bad proof every time the owner lists requests.
  f.override = async args => {
    if (args.route === '/enrollments' && args.req.method === 'GET')
      for (const e of f.circles.get(args.circleId)?.enrollments ?? []) e.enrollment_proof = {...e.enrollment_proof, signature: {...e.enrollment_proof.signature, value: 'A'.repeat(86)}};
    return base(args);
  };
  const joined = await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  assert.equal(joined.enrollment.state, 'pending');
  await waitFor(async () => (await events(owner.app, 'rejected')).length === 1, 'rejection notice');
  await new Promise(done => setTimeout(done, 300));
  assert.equal(await epoch(owner.app, circle.id), 1, 'no roster was published');
  assert.equal((await members(owner.app, circle.id)).length, 1);
  // By hand too: the request is listed as unverified, and approving it adds nothing.
  const [item] = await api(owner.app, '/api/circles/' + circle.id + '/approvals');
  assert.equal(item.proof_valid, false);
  assert.equal(item.device_name, null);
  const result = await api(owner.app, '/api/circles/' + circle.id + '/approve', {method: 'POST', body: {enrollmentId: item.enrollment_id}});
  assert.deepEqual(result.approved, []);
  assert.equal(await epoch(owner.app, circle.id), 1);
  assert.equal((await events(owner.app, 'approved')).length, 0);
});

test('circle approve --device approves only the request with that code', testOptions, async t => {
  const {f, owner, lender, circle, invite} = await setup(t, {ownerOptions: {}, lenderOptions: {}});
  const other = await f.start('other');
  await api(other.app, '/api/devices', {method: 'POST', body: {name: 'Sam’s desktop'}});
  await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  await api(other.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  const code = lender.app.device.matchCode(lender.app.device.keyId);
  const run = async argv => {
    let out = '', err = '';
    const status = await runV1Command(argv, {device: owner.app.device, stdout: {write: x => { out += x; }}, stderr: {write: x => { err += x; }}});
    return {status, out, err};
  };
  const wrong = await run(['circle', 'approve', '--circle', circle.id, '--device', 'ZZZZZZ']);
  assert.notEqual(wrong.status, 0);
  assert.equal(await epoch(owner.app, circle.id), 1);
  const ok = await run(['circle', 'approve', '--circle', circle.id, '--device', code.toLowerCase(), '--json']);
  assert.equal(ok.status, 0, ok.err);
  assert.deepEqual(JSON.parse(ok.out).approved, [lender.app.device.keyId]);
  assert.equal(await epoch(owner.app, circle.id), 2);
  assert.deepEqual((await api(owner.app, '/api/circles/' + circle.id + '/approvals')).map(i => i.device_name), ['Sam’s desktop']);
  // Without --device the command still approves every verified request, as before.
  const all = await run(['circle', 'approve', '--circle', circle.id]);
  assert.equal(all.status, 0, all.err);
  assert.match(all.out, /Approved 1 circle membership request\(s\)/);
});

test('the CLI join message names the owner only in approve-each mode', () => {
  const base = {name: 'Critics', origin: 'https://critics.example', enrollment: {state: 'pending'}};
  assert.equal(joinMessage({...base, enrollment: {state: 'approved'}, rosterMembershipVerified: true}), 'Circle joined: Critics.');
  assert.equal(joinMessage({...base, joinInfo: {approval: 'each', ownerName: 'Tessa’s laptop', code: 'A1B2C3'}}),
    'Waiting for Tessa’s laptop to approve this computer.\nMatch code: A1B2C3 (the owner sees the same code).');
  assert.doesNotMatch(joinMessage({...base, joinInfo: {approval: 'automatic', ownerName: 'Tessa’s laptop', code: 'A1B2C3'}}), /Waiting for/);
});

test('Check again asks the queue for the signed roster, so a pending joiner learns it was approved', testOptions, async t => {
  const {owner, lender, circle, invite} = await setup(t, {lenderOptions: {joinWaitMs: 0}});
  await api(owner.app, '/api/circles/' + circle.id + '/approval-mode', {method: 'POST', body: {approveEach: true}});
  const joined = await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  assert.equal(joined.enrollment.state, 'pending');
  const check = () => api(lender.app, '/api/circles/' + circle.id + '/check', {method: 'POST', body: {}});
  const waiting = await check();
  assert.equal(waiting.state, 'pending', 'still waiting for the owner');
  assert.equal(waiting.membershipProjection.phase, 'pending', 'a pending enrollment is not approved');
  await api(owner.app, '/api/circles/' + circle.id + '/approve', {method: 'POST', body: {}});
  // The lender app does not sweep on its own here, so only the check can notice the approval.
  assert.equal((await api(lender.app, '/api/circles')).find(c => c.id === circle.id).enrollment.state, 'pending');
  const approved = await check();
  assert.equal(approved.state, 'approved');
  assert.equal(approved.membershipProjection.phase, 'approved', 'approval is confirmed by the signed roster');
  assert.equal((await api(lender.app, '/api/circles')).find(c => c.id === circle.id).enrollment.state, 'approved');
  assert.equal((await members(lender.app, circle.id)).length, 2);
  assert.equal((await events(lender.app, 'joined')).length, 1);
  const alreadyApproved = await check();
  assert.equal(alreadyApproved.state, 'approved', 'checking again after joining is harmless');
  assert.equal(alreadyApproved.membershipProjection.phase, 'approved');
  assert.equal((await events(lender.app, 'joined')).length, 1, 'no second join event');
});

test('manual approve waits for a background sweep holding the owner lock', {...testOptions,timeout:90000}, async t => {
  const {f, owner, lender, circle, invite} = await setup(t, {lenderOptions: {joinWaitMs: 0}});
  await api(owner.app, '/api/circles/' + circle.id + '/approval-mode', {method: 'POST', body: {approveEach: true}});
  const joined = await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: await invite()}});
  assert.equal(joined.enrollment.state, 'pending');
  const base = f.override;
  let releaseSweep, held = false, started = false, settled = false, pending;
  const gate = new Promise(resolve => {releaseSweep = resolve;});
  const approve = owner.app.device.approveEnrollment;
  // Only the actual timer-driven sweep is listing now. Pause its network reply
  // after it acquired the owner lock, rather than hoping two requests collide.
  f.override = async args => {
    if (!held && args.circleId === circle.id && args.route === '/enrollments' && args.req.method === 'GET') {
      held = true;
      await gate;
    }
    return base(args);
  };
  owner.app.device.approveEnrollment = (...args) => {started = true;return approve(...args);};
  try {
    await waitFor(() => held, 'background sweep holding the owner lock');
    pending = api(owner.app, '/api/circles/' + circle.id + '/approve', {
      method: 'POST', body: {enrollmentId: joined.enrollment.enrollment_id},
    }).then(value => {settled = true;return {value};}, error => {settled = true;return {error};});
    await waitFor(() => started, 'manual approve entering the device lock');
    // Exceed the former 3 second foreground deadline while the background lock stays held.
    await sleep(3250);
    assert.equal(settled, false, 'approve must keep waiting, not return device_busy');
    releaseSweep();
    const result = await pending;
    if (result.error) throw result.error;
    assert.deepEqual(result.value.approved, [lender.app.device.keyId]);
    assert.equal(await epoch(owner.app, circle.id), 2);
    assert.equal((await members(owner.app, circle.id)).length, 2);
  } finally {
    releaseSweep();
    f.override = base;
    owner.app.device.approveEnrollment = approve;
    await pending;
  }
});

test('a stuck live owner makes sweeps skip and foreground approval time out safely', {...testOptions,timeout:90000}, async t => {
  const {owner, circle} = await setup(t, {ownerOptions: {autoApprove: false}, lenderOptions: {joinWaitMs: 0}});
  const lock = join(owner.app.device.directory, 'owner-' + circle.id + '.lock');
  const release = acquireProcessLockSync(lock);
  const isBusy = error => error.code === 'device_busy' && error.status === 409 && error.retryable === true;
  try {
    for (const operation of ['listEnrollments', 'approveEnrollments']) {
      const started = performance.now();
      await assert.rejects(owner.app.device[operation](circle.id, {background: true}), isBusy);
      assert.ok(performance.now() - started < 1000, 'a background sweep must not wait for the foreground budget');
    }
    const started = performance.now();
    await assert.rejects(owner.app.device.approveEnrollments(circle.id), isBusy);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 9950 && elapsed < 15000, '10 second owner lock budget with 5 second scheduling margin: ' + elapsed + ' ms');
    assert.throws(() => acquireProcessLockSync(lock), {code: 'lock_busy'}, 'timeout must not steal the live owner lock');
    assert.equal(await epoch(owner.app, circle.id), 1);
  } finally {release();}
  assert.deepEqual((await owner.app.device.approveEnrollments(circle.id)).approved, [], 'a timed-out waiter leaves no lock behind');
});

test('a role removed while a mode change waits for the owner lock refuses the write', testOptions, async t => {
  const {owner, circle} = await setup(t, {ownerOptions: {autoApprove: false}, lenderOptions: {joinWaitMs: 0}});
  const directory = owner.app.device.directory, stateFile = join(directory, 'state.json');
  const release = acquireProcessLockSync(join(directory, 'owner-' + circle.id + '.lock'));
  let pending;
  const keepAlive = setInterval(() => {}, 1000);
  try {
    pending = owner.app.device.setApproveEach(circle.id, true).then(() => null, error => error);
    await sleep(100);
    // The person's role is withdrawn while the change waits.
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    Object.assign(state.circles.find(c => c.id === circle.id), {owned: false, steward: false, admin: false});
    await writeFile(stateFile, JSON.stringify(state));
  } finally {release();}
  const error = await pending;
  clearInterval(keepAlive);
  assert.equal(error?.code, 'not_owner', 'the write is refused');
  const after = JSON.parse(await readFile(stateFile, 'utf8')).circles.find(c => c.id === circle.id);
  assert.notEqual(after.approveEach, true, 'the setting is not changed');
});
