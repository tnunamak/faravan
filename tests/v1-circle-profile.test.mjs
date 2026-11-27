import './helpers/no-browser.mjs';
import { tempDir } from './helpers/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { openDevice } from '../lib/v1/device.mjs';
import * as p from '../lib/protocol/index.mjs';
import { realCoordinator } from './helpers/v1-short-invite.mjs';

// Hermetic loopback only: an in-process coordinator and disposable homes. Never ~/.faravan or live services.

async function circleWithMember(t, options = {}) {
  const c = await realCoordinator(t, {name: 'Critics', ...options});
  const member = await c.device('member');
  const links = await c.owner.createInviteLinks(c.circle.id);
  await member.joinCircle(links.long, {deviceName: 'Laptop', waitMs: 4000, pollMs: 50});
  await c.owner.approveEnrollments(c.circle.id);
  await member.refreshRoster(c.circle.id);
  return {c, owner: c.owner, member, id: c.circle.id};
}
const signedProfile = async (device, id) => (await device.rosterCache(id).get()).current.payload.profile;

test('an exact circle ID wins over another circle signed name', async t => {
  const home = await tempDir('faravan-circle-profile-');
  t.after(() => rm(home, {recursive: true, force: true}));
  const device = await openDevice({home, ensureDefault: false});
  const a = await device.createCircle(null, {name: 'A'});
  const b = await device.createCircle(null, {name: 'B'});
  await device.updateCircleProfile(a.id, {name: b.id});
  assert.deepEqual(await signedProfile(device, a.id), {name: b.id});
  assert.equal(device.selectCircle(b.id).id, b.id);
  assert.equal(device.selectCircle('B').id, b.id);
  assert.equal((await device.rosterCache(b.id).get()).current.payload.circle, b.id);
  await device.updateCircleProfile(b.id, {purpose: 'Still addressable'});
  assert.equal(device.selectCircle(b.id).purpose, 'Still addressable');
  await device.createCircle(null, {name: 'B', reuse: false});
  assert.throws(() => device.selectCircle('B'), e => e.code === 'circle_ambiguous');
});

test('a new circle keeps the legacy roster shape until its owner edits details', {timeout: 30000}, async t => {
  const {c, owner, id} = await circleWithMember(t);
  assert.equal(await signedProfile(owner, id), undefined);
  assert.equal((await c.provisioning()).roster.payload.profile, undefined);
});

test('owner rename and purpose reach a member after refresh', {timeout: 30000}, async t => {
  const {owner, member, id} = await circleWithMember(t);
  const result = await owner.updateCircleProfile(id, {name: 'Night critics', purpose: 'Review drafts before Friday'});
  assert.deepEqual({name: result.name, purpose: result.purpose}, {name: 'Night critics', purpose: 'Review drafts before Friday'});
  assert.equal(owner.selectCircle(id).name, 'Night critics');
  await member.refreshRoster(id);
  const seen = member.selectCircle(id);
  assert.equal(seen.name, 'Night critics');
  assert.equal(seen.purpose, 'Review drafts before Friday');
  // Clearing purpose; omitted name keeps the current one.
  await owner.updateCircleProfile(id, {purpose: null});
  await member.refreshRoster(id);
  assert.equal(member.selectCircle(id).name, 'Night critics');
  assert.equal(member.selectCircle(id).purpose, undefined);
  assert.deepEqual(await signedProfile(member, id), {name: 'Night critics'});
});

test('setting the same profile again keeps the epoch, and the result matches what is saved', {timeout: 30000}, async t => {
  const {owner, id} = await circleWithMember(t);
  const first = await owner.updateCircleProfile(id, {name: 'Same', purpose: 'Same purpose'});
  const again = await owner.updateCircleProfile(id, {name: ' Same ', purpose: 'Same purpose'});
  assert.deepEqual(again, first);
  assert.equal((await owner.rosterCache(id).get()).current.payload.epoch, first.epoch);
  const cleared = await owner.updateCircleProfile(id, {purpose: ''});
  assert.equal(cleared.purpose, null);
  assert.equal(cleared.epoch, first.epoch + 1);
  assert.deepEqual(await owner.updateCircleProfile(id, {purpose: null}), cleared);
  const saved = owner.selectCircle(id);
  assert.deepEqual({name: saved.name, purpose: saved.purpose ?? null}, {name: cleared.name, purpose: cleared.purpose});
});

test('profile text is bounded and validated', {timeout: 30000}, async t => {
  const {owner, id} = await circleWithMember(t);
  await assert.rejects(owner.updateCircleProfile(id, {name: 'x'.repeat(257)}), e => e.code === 'invalid_circle_profile');
  await assert.rejects(owner.updateCircleProfile(id, {purpose: 'y'.repeat(257)}), e => e.code === 'invalid_circle_profile');
  await assert.rejects(owner.updateCircleProfile(id, {name: '   '}), e => e.code === 'invalid_circle_profile');
  // 256 visible characters (astral code points count once) is allowed.
  const r = await owner.updateCircleProfile(id, {name: '🙂'.repeat(256), purpose: 'z'.repeat(256)});
  assert.equal([...r.name].length, 256);
});

test('an older host refuses settings before any roster bytes change',async t=>{
  const c=await realCoordinator(t),owner=await c.device('owner',{fetch:async(url,options)=>{
    const response=await c.traced(url,options);
    if(String(url).endsWith('/capabilities')&&response.ok){const body=await response.json();body.capabilities=body.capabilities.filter(name=>name!=='circle_profile_v1');return Response.json(body);}
    return response;
  }});
  const file=join(owner.directory,'circles',c.circle.id,'roster.json'),before=await readFile(file,'utf8');
  await assert.rejects(owner.updateCircleProfile(c.circle.id,{name:'New name'}),e=>e.code==='host_too_old');
  assert.equal(await readFile(file,'utf8'),before);
});

test('an unchanged roster cache takes no lock and does no fsync; a changed one is written', {timeout: 30000}, async t => {
  const {member, id} = await circleWithMember(t);
  const file = join(member.directory, 'circles', id, 'roster.json');
  const cache = await member.rosterCache(id).get();
  const renames = t.mock.method(fs, 'renameSync');
  const fsyncs = t.mock.method(fs, 'fsyncSync');
  const lockDirs = t.mock.method(fs, 'mkdirSync');
  const rewrites = () => renames.mock.calls.filter(call => call.arguments[1] === file).length;
  await member.rosterCache(id).set(cache);
  // No roster or state write, no fsync (the lock's directory sync included), and no lock directory touched.
  assert.equal(rewrites(), 0);
  assert.equal(fsyncs.mock.callCount(), 0);
  assert.equal(lockDirs.mock.calls.filter(call => String(call.arguments[0]).includes('owners-v1')).length, 0);
  await writeFile(file, JSON.stringify({current: null, history: [], highestAcceptedEpoch: 0}));
  await member.rosterCache(id).set(cache);
  assert.equal(rewrites(), 1);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), cache);
});

test('a roster whose circle state never recorded its digest is applied again, not skipped', {timeout: 30000}, async t => {
  // A crash between the roster write and the state write leaves the same roster bytes with stale state.
  const {member, id} = await circleWithMember(t);
  const cache = await member.rosterCache(id).get();
  const stateFile = join(member.directory, 'state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.circles.find(circle => circle.id === id).rosterDigest = 'stale';
  await writeFile(stateFile, JSON.stringify(state));
  const renames = t.mock.method(fs, 'renameSync');
  await member.rosterCache(id).set(cache);
  assert.equal(renames.mock.calls.filter(call => call.arguments[1] === stateFile).length, 1);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).circles.find(circle => circle.id === id).rosterDigest, cache.highestAcceptedDigest);
});

test('an unchanged intent write or absent intent delete rewrites nothing', {timeout: 30000}, async t => {
  const {member, id} = await circleWithMember(t);
  const store = member.intentStore(id);
  await store.set('probe', {value: 1});
  const renames = t.mock.method(fs, 'renameSync');
  await store.set('probe', {value: 1});
  await store.delete('absent-key');
  assert.equal(renames.mock.callCount(), 0);
  assert.deepEqual(await store.get('probe'), {value: 1});
});

test('a non-owner cannot change the circle profile', {timeout: 30000}, async t => {
  const {member, id} = await circleWithMember(t);
  await assert.rejects(member.updateCircleProfile(id, {name: 'Hijacked'}), e => e.code === 'not_owner');
});

test('an old invitation cannot replace the name in a newer verified roster',async t=>{
  const {owner,member,id}=await circleWithMember(t);
  const oldInvite=(await owner.createInviteLinks(id)).long;
  await owner.updateCircleProfile(id,{name:'Renamed',purpose:'Keep this purpose'});
  await member.refreshRoster(id);
  await member.joinCircle(oldInvite,{deviceName:'Laptop',waitMs:0}).catch(()=>{});
  assert.equal(member.selectCircle(id).name,'Renamed');
  assert.equal(member.selectCircle(id).purpose,'Keep this purpose');
});

test('a tampered profile is rejected and never adopted', {timeout: 30000}, async t => {
  const {owner, member, id} = await circleWithMember(t);
  const cached = await owner.rosterCache(id).get(), current = cached.current;
  const forged = structuredClone(current);
  forged.payload = {...forged.payload, epoch: current.payload.epoch + 1, profile: {name: 'Forged'}};
  assert.equal(p.verifyRoster(forged, {rootFingerprint: owner.selectCircle(id).pinnedRootFingerprint, circle: id,
    now: () => Math.floor(Date.now() / 1000)}).ok, false);
  const memberCache = await member.rosterCache(id).get();
  await assert.rejects(member.rosterCache(id).set({...memberCache, current: forged,
    highestAcceptedEpoch: forged.payload.epoch, highestAcceptedDigest: p.digest(forged.payload)}));
  assert.equal(member.selectCircle(id).name, 'Critics');
  // A root other than the pinned one cannot rename the circle either.
  const otherRoot = p.generateRootKeyPair().privateKey;
  const foreign = p.signEnvelope('roster', {...current.payload, root_public_key: p.exportPublicKey(otherRoot),
    epoch: current.payload.epoch + 1, profile: {name: 'Foreign'}}, otherRoot);
  await assert.rejects(member.rosterCache(id).set({...memberCache, current: foreign,
    highestAcceptedEpoch: foreign.payload.epoch, highestAcceptedDigest: p.digest(foreign.payload)}));
  assert.equal(member.selectCircle(id).name, 'Critics');
});

test('membership changes and renewal keep the signed profile', {timeout: 30000}, async t => {
  let offset = 0;
  const {owner, member, id, c} = await circleWithMember(t, {clock: () => Math.floor(Date.now() / 1000) + offset});
  await owner.updateCircleProfile(id, {name: 'Kept', purpose: 'Kept purpose'});
  // Approve a second device.
  const second = await c.device('second');
  await second.joinCircle((await owner.createInviteLinks(id)).long, {deviceName: 'Second'});
  const approved = await owner.approveEnrollments(id);
  assert.equal(approved.approved.length, 1);
  assert.deepEqual(await signedProfile(owner, id), {name: 'Kept', purpose: 'Kept purpose'});
  // Remove it again.
  await owner.removeMember(id, second.keyId);
  assert.deepEqual(await signedProfile(owner, id), {name: 'Kept', purpose: 'Kept purpose'});
  // Renewal past half-life re-signs a new epoch.
  const before = (await owner.rosterCache(id).get()).current.payload.epoch;
  offset = 4 * 86400; // past half of the seven-day validity, for owner and coordinator alike
  await owner.refreshRoster(id);
  const renewed = (await owner.rosterCache(id).get()).current.payload;
  assert.ok(renewed.epoch > before);
  assert.deepEqual(renewed.profile, {name: 'Kept', purpose: 'Kept purpose'});
  await member.refreshRoster(id);
  assert.equal(member.selectCircle(id).purpose, 'Kept purpose');
});

test('a legacy roster without a profile still verifies, and renewal does not add one', async t => {
  const home = await tempDir('faravan-circle-profile-');
  t.after(() => rm(home, {recursive: true, force: true}));
  const device = await openDevice({home, ensureDefault: false});
  const circle = await device.createCircle(null, {name: 'Legacy'});
  const root = createPrivateKey(await readFile(join(device.directory, 'roots', circle.id + '.pem')));
  const cache = await device.rosterCache(circle.id).get();
  const {profile, ...legacy} = {...cache.current.payload, epoch: 2};
  assert.equal(profile, undefined);
  const envelope = p.signEnvelope('roster', legacy, root);
  await device.rosterCache(circle.id).set({current: envelope, history: [cache.current], highestAcceptedEpoch: 2,
    highestAcceptedDigest: p.digest(legacy)});
  assert.equal(device.selectCircle(circle.id).name, 'Legacy');
  // An offline circle can still be renamed; that is the first roster to carry a profile.
  const r = await device.updateCircleProfile(circle.id, {purpose: 'Offline notes'});
  assert.deepEqual({name: r.name, purpose: r.purpose, epoch: r.epoch}, {name: 'Legacy', purpose: 'Offline notes', epoch: 3});
});

test('a legacy roster at a coordinator is accepted by a member and keeps the invite name', {timeout: 30000}, async t => {
  const {owner, member, id} = await circleWithMember(t);
  const root = createPrivateKey(await readFile(join(owner.directory, 'roots', id + '.pem')));
  const cached = await owner.rosterCache(id).get();
  const {profile, ...legacy} = {...cached.current.payload, epoch: cached.current.payload.epoch + 1};
  await owner.client(id).then(api => api.publishRoster(p.signEnvelope('roster', legacy, root)));
  await member.refreshRoster(id);
  assert.equal((await member.rosterCache(id).get()).current.payload.profile, undefined);
  assert.equal(member.selectCircle(id).name, 'Critics');
});

test('reuse:false starts a new circle even when an offline one has the same name', async t => {
  const home = await tempDir('faravan-circle-profile-');
  t.after(() => rm(home, {recursive: true, force: true}));
  const device = await openDevice({home, ensureDefault: false});
  const a = await device.createCircle(null, {name: 'Same'});
  const b = await device.createCircle(null, {name: 'Same'});
  assert.equal(a.id, b.id, 'default reuse keeps today\'s behaviour');
  const c = await device.createCircle(null, {name: 'Same', reuse: false});
  assert.notEqual(c.id, a.id);
});

test('corrupt roster JSON is classified without replacing replay history', async t => {
  const home = await tempDir('faravan-roster-corrupt-');
  t.after(() => rm(home, {recursive: true, force: true}));
  const device = await openDevice({home, ensureDefault: false});
  const circle = await device.createCircle(null, {name: 'Corrupt cache'});
  const cache = device.rosterCache(circle.id), accepted = await cache.get();
  const file = join(device.directory, 'circles', circle.id, 'roster.json');
  const corrupt = '{"current": "PRIVATE CORRUPT CONTENT"';
  await writeFile(file, corrupt);
  const classified = error => {
    assert.equal(error.code, 'roster_cache_corrupt');
    assert.equal(error.path, file);
    assert.equal(error.message, 'The local roster cache is corrupt. Ask the circle owner for help repairing it.');
    assert.equal(error.message.includes('PRIVATE CORRUPT CONTENT'), false);
    return true;
  };
  for (const operation of [
    () => cache.get(),
    () => cache.set(accepted),
    () => device.refreshRoster(circle.id),
  ]) {
    await assert.rejects(operation(), classified);
    assert.equal(await readFile(file, 'utf8'), corrupt, 'corruption must not reset the replay floor');
  }
});

test('one corrupt roster cache leaves a healthy circle and a reopen working', async t => {
  const home = await tempDir('faravan-roster-corrupt-two-');
  t.after(() => rm(home, {recursive: true, force: true}));
  const device = await openDevice({home, ensureDefault: false});
  const a = await device.createCircle(null, {name: 'Circle A'});
  const b = await device.createCircle(null, {name: 'Circle B', reuse: false});
  // Accepting each circle's own roster records approval, as a joined device's state does.
  for (const id of [a.id, b.id]) await device.rosterCache(id).set(await device.rosterCache(id).get());
  const stateFile = join(device.directory, 'state.json'), saved = JSON.parse(await readFile(stateFile, 'utf8'));
  for (const c of saved.circles) {
    c.rosterMembershipVerified = true;
    c.rosterDigest = (await device.rosterCache(c.id).get()).highestAcceptedDigest;
  }
  await writeFile(stateFile, JSON.stringify(saved));
  assert.equal(device.selectCircle(a.id).rosterMembershipVerified, true);
  assert.equal(device.selectCircle(b.id).rosterMembershipVerified, true);
  const file = join(device.directory, 'circles', a.id, 'roster.json');
  const corrupt = '{"current": "PRIVATE CORRUPT CONTENT"';
  await writeFile(file, corrupt);
  assert.equal(device.selectCircle(b.id).rosterMembershipVerified, true, 'B is unaffected');
  assert.equal(device.selectCircle(a.id).rosterMembershipVerified, false, 'A cannot prove approval');
  assert.equal((await device.listCircles()).find(c => c.id === b.id).rosterMembershipVerified, true);
  await assert.rejects(device.rosterCache(a.id).get(), {code: 'roster_cache_corrupt'});
  await openDevice({home, ensureDefault: true});
  assert.equal(await readFile(file, 'utf8'), corrupt, 'corruption must not reset the replay floor');
});

for (const [reader, validReads] of [['governanceFor', 1], ['currentRoster', 2]]) {
  test(`profile signing classifies corrupt ${reader} cache reads without writing data`, async t => {
    const home = await tempDir('faravan-roster-sign-corrupt-');
    t.after(() => rm(home, {recursive: true, force: true}));
    const device = await openDevice({home, ensureDefault: false});
    const circle = await device.createCircle(null, {name: 'Keep this name'});
    const file = join(device.directory, 'circles', circle.id, 'roster.json');
    const stateFile = join(device.directory, 'state.json');
    const intentsFile = join(device.directory, 'circles', circle.id, 'intents.json');
    const accepted = await readFile(file, 'utf8');
    const stateBefore = await readFile(stateFile, 'utf8');
    assert.equal(fs.existsSync(intentsFile), false);
    const corrupt = '{"current": "PRIVATE CORRUPT CONTENT"';
    await writeFile(file, corrupt);
    // Preserve the in-flight valid snapshot(s), then expose the actual corrupt file
    // at the signing read. Corrupt-at-entry alone only exercises rosterCache.get.
    const originalRead = fs.readFileSync;
    let rosterReads = 0;
    t.mock.method(fs, 'readFileSync', function (target, ...args) {
      if (target === file && ++rosterReads <= validReads) return accepted;
      return originalRead.call(this, target, ...args);
    });
    const renames = t.mock.method(fs, 'renameSync');
    await assert.rejects(device.updateCircleProfile(circle.id, {name: 'Must not be saved'}), error => {
      assert.equal(error.code, 'roster_cache_corrupt');
      assert.equal(error.path, file);
      assert.equal(error.message.includes('PRIVATE CORRUPT CONTENT'), false);
      return true;
    });
    assert.equal(rosterReads, validReads + 1, 'the selected signing read must reject');
    assert.equal(renames.mock.calls.filter(call =>
      [file, stateFile, intentsFile].includes(call.arguments[1])).length, 0);
    assert.equal(await readFile(file, 'utf8'), corrupt);
    assert.equal(await readFile(stateFile, 'utf8'), stateBefore);
    assert.equal(fs.existsSync(intentsFile), false);
  });
}
