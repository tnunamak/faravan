import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';

// D9: the app's own rule follows a fresh, verified roster read and nothing else. Receipts are injected here so each case is exact;
// the last test checks the real read path that mints them.
const DAY = 86400000, D = 30 * DAY;
async function joined(t) {
  const f = await appFixture(t), {owner, lender, circle} = await f.connect({freshLending: 'automatic', resumeLending: false});
  const file = join(lender.home, 'v1', 'app-settings.json');
  await api(lender.app, '/api/circles/' + circle.id + '/check', {method: 'POST', body: {}});
  await waitFor(async () => (await readFile(file, 'utf8').then(JSON.parse, () => ({}))).standingRules?.length, 'the default rule is installed');
  const read = async () => JSON.parse(await readFile(file, 'utf8'));
  const acks = [];
  let held = null, last = null;
  const device = lender.app.device;
  device.rosterReceipt = id => (held && held.circle === id ? structuredClone(held) : null);
  device.ackRosterReceipt = (id, generation) => { acks.push(generation); if (held?.generation === generation) held = null; };
  let n = 0;
  const deliver = async ({fetchedAt, members, epoch}) => {
    held = {circle: circle.id, generation: 'g' + (++n), fetchedAt, rosterDigest: 'd' + n, ...(epoch === undefined ? {} : {epoch}), members: members.map(key_id => ({key_id}))};
    last = structuredClone(held);
    const generation = held.generation;
    await api(lender.app, '/api/circles/' + circle.id + '/check', {method: 'POST', body: {}});
    return generation;
  };
  const appRule = async () => { const s = await read(); return s.standingRules.find(r => r.id === s.appRuleIds[circle.id]); };
  const replay = async () => { held = structuredClone(last); await api(lender.app, '/api/circles/' + circle.id + '/check', {method: 'POST', body: {}}); };
  return {f, owner, lender, circle, file, read, acks, deliver, replay, appRule, device, held: () => held};
}

test('a fresh non-empty read renews the app rule in place to the read time plus 30 days, once', {timeout: 120000}, async t => {
  const x = await joined(t), before = await x.appRule(), v0 = (await x.read()).configVersion;
  // Joining applied a real read already; this one is a day newer, so it is not "now" and not older than what was applied.
  const fetchedAt = (await x.read()).rosterApplied[x.circle.id] + DAY;
  const g = await x.deliver({fetchedAt, members: ['member-a', 'member-b']});
  const after = await x.appRule(), saved = await x.read();
  assert.equal(after.id, before.id);
  assert.equal(after.expiresAt, fetchedAt + D, 'the read time, not the consumer\'s now');
  assert.deepEqual(after.people, ['member-a', 'member-b']);
  assert.deepEqual({...after, people: 0, expiresAt: 0}, {...before, people: 0, expiresAt: 0}, 'limits, schedule, agents and scope are untouched');
  assert.equal(saved.configVersion, v0 + 1);
  assert.equal(saved.rosterApplied[x.circle.id], fetchedAt);
  assert.ok(x.acks.includes(g));
  await x.replay();
  assert.equal((await x.read()).configVersion, v0 + 1, 'a replayed receipt renews nothing');
  assert.deepEqual(await x.appRule(), after);
  // The same receipt again (replay, or a crash between commit and acknowledgement) renews nothing.
  await api(x.lender.app, '/api/circles/' + x.circle.id + '/check', {method: 'POST', body: {}});
  assert.equal((await x.read()).configVersion, v0 + 1);
});

test('a replayed older receipt after a newer one changes nothing', {timeout: 120000}, async t => {
  const x = await joined(t), now = (await x.read()).rosterApplied[x.circle.id] + 10 * DAY;
  await x.deliver({fetchedAt: now + 1 * DAY, members: ['newer']});
  const mid = await x.read();
  await x.deliver({fetchedAt: now, members: ['older']});
  const after = await x.read();
  assert.deepEqual(after.standingRules, mid.standingRules);
  assert.equal(after.configVersion, mid.configVersion);
  assert.deepEqual((await x.appRule()).people, ['newer']);
});

test('a verified empty roster clears the members, keeps id and expiry, and never renews', {timeout: 120000}, async t => {
  const x = await joined(t), before = await x.appRule();
  await x.deliver({fetchedAt: Date.now(), members: []});
  const after = await x.appRule();
  assert.deepEqual(after.people, []);
  assert.equal(after.id, before.id);
  assert.equal(after.expiresAt, before.expiresAt);
});

test('no renewal for Ask, an expired rule or a rule the owner edited', {timeout: 120000}, async t => {
  const x = await joined(t), now = Date.now();
  // The owner edits a limit: the rule becomes theirs and is never renewed.
  const view = await api(x.lender.app, '/api/lending'), rules = view.standingRules.map(({appOwned, ...r}) => r);
  const mine = rules.map(r => r.circle === x.circle.id ? {...r, dailyJobs: (r.dailyJobs ?? 5) + 1, weeklyJobs: (r.dailyJobs ?? 5) * 7 + 7} : r);
  await api(x.lender.app, '/api/lending/rules', {method: 'POST', body: {rules: mine, version: view.configVersion}});
  const edited = await x.read();
  await x.deliver({fetchedAt: now, members: ['someone']});
  assert.deepEqual((await x.read()).standingRules, edited.standingRules, 'a custom rule is not renewed');
  // Ask removes the rule: a later receipt creates nothing.
  await api(x.lender.app, '/api/lending/mode', {method: 'POST', body: {circle: x.circle.id, mode: 'ask'}});
  const asked = await x.read();
  await x.deliver({fetchedAt: now + 1000, members: ['someone']});
  assert.deepEqual((await x.read()).standingRules, asked.standingRules);
});

test('an expired app rule is not renewed', {timeout: 120000}, async t => {
  const x = await joined(t);
  await x.lender.app.close();
  const s = await x.read();
  s.standingRules = s.standingRules.map(r => r.id === s.appRuleIds[x.circle.id] ? {...r, expiresAt: Date.now() - DAY} : r);
  await writeFile(x.file, JSON.stringify(s));
  const app = (await x.f.start('lender')).app;
  const device = app.device;
  let held = {circle: x.circle.id, generation: 'e1', fetchedAt: Date.now(), rosterDigest: 'd', members: [{key_id: 'new'}]};
  device.rosterReceipt = () => held;
  device.ackRosterReceipt = () => { held = null; };
  await api(app, '/api/circles/' + x.circle.id + '/check', {method: 'POST', body: {}});
  assert.deepEqual((await x.read()).standingRules, s.standingRules);
  assert.equal(held, null, 'the receipt is dropped');
});

test('the real current-roster read mints one receipt; only that read does, and an old acknowledgement keeps a newer one', {timeout: 120000}, async t => {
  const f = await appFixture(t), {lender, circle} = await f.connect({freshLending: 'automatic', resumeLending: false});
  const device = lender.app.device;
  while (device.rosterReceipt(circle.id)) device.ackRosterReceipt(circle.id, device.rosterReceipt(circle.id).generation);
  await device.refreshRoster(circle.id);
  const receipt = device.rosterReceipt(circle.id);
  assert.ok(receipt, 'a fresh GET minted a receipt');
  assert.equal(typeof receipt.generation, 'string');
  assert.ok(Number.isFinite(receipt.fetchedAt));
  assert.ok(receipt.members.some(m => m.key_id === device.keyId));
  device.ackRosterReceipt(circle.id, 'not-this-generation');
  assert.ok(device.rosterReceipt(circle.id), 'an unrelated acknowledgement erases nothing');
  device.ackRosterReceipt(circle.id, device.rosterReceipt(circle.id).generation);
  assert.equal(device.rosterReceipt(circle.id), null);
  // A read from the cache alone mints nothing.
  await device.rosterCache(circle.id).get();
  assert.equal(device.rosterReceipt(circle.id), null);
});

test('T13: a receipt does not survive leaving the circle, and a circle that is gone takes no new one', {timeout: 120000}, async t => {
  const f = await appFixture(t), {lender, circle} = await f.connect({freshLending: 'automatic', resumeLending: false});
  const device = lender.app.device;
  await device.refreshRoster(circle.id);
  assert.ok(device.rosterReceipt(circle.id), 'a fresh read minted a receipt');
  await device.leaveCircle(circle.id);
  assert.equal(device.rosterReceipt(circle.id), null, 'leaving discards it');
  await assert.rejects(device.refreshRoster(circle.id), 'a circle that is gone cannot be read');
  assert.equal(device.rosterReceipt(circle.id), null, 'and no receipt appears for it');
});

test('T13: leave, rejoin, then a roster read gives a new app rule, never a renewed old one', {timeout: 120000}, async t => {
  const f = await appFixture(t), {owner, lender, circle} = await f.connect({freshLending: 'automatic', resumeLending: false});
  const file = join(lender.home, 'v1', 'app-settings.json'), read = async () => JSON.parse(await readFile(file, 'utf8'));
  await api(lender.app, '/api/circles/' + circle.id + '/check', {method: 'POST', body: {}});
  await waitFor(async () => (await read()).standingRules?.length, 'the default rule');
  const old = (await read()).standingRules[0];
  await api(lender.app, '/api/circles/' + circle.id + '/leave', {method: 'POST', body: {}});
  let s = await read();
  assert.equal(s.appRuleIds[circle.id], undefined, 'leaving ends the app\'s own permission');
  assert.equal(s.standingRules.some(r => r.circle === circle.id), false);
  assert.equal(s.modes[circle.id], undefined);
  const {invite} = await api(owner.app, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}});
  await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: invite}});
  await api(owner.app, '/api/circles/' + circle.id + '/approve', {method: 'POST', body: {}});
  await lender.app.device.refreshRoster(circle.id);
  await api(lender.app, '/api/circles/' + circle.id + '/check', {method: 'POST', body: {}});
  await waitFor(async () => (await read()).appRuleIds?.[circle.id], 'a fresh app rule after the rejoin');
  s = await read();
  assert.notEqual(s.appRuleIds[circle.id], old.id, 'a new rule, not the old one renewed');
  assert.equal(s.standingRules.some(r => r.id === old.id), false);
});

test('T13: leaving keeps a rule the person made, and ends only the app rule', {timeout: 120000}, async t => {
  const f = await appFixture(t), {owner, lender, circle} = await f.connect({freshLending: 'automatic', resumeLending: false});
  const file = join(lender.home, 'v1', 'app-settings.json'), read = async () => JSON.parse(await readFile(file, 'utf8'));
  await api(lender.app, '/api/circles/' + circle.id + '/check', {method: 'POST', body: {}});
  await waitFor(async () => (await read()).standingRules?.length, 'the default rule');
  const mine = {id: 'my-own-rule', circle: circle.id, people: [owner.app.device.keyId], agents: ['codex'], maxWallSeconds: 600, dailyJobs: 2, weeklyJobs: 14,
    dailyMinutes: null, weeklyMinutes: null, schedule: null, timeZone: 'UTC', expiresAt: Date.now() + 5 * DAY};
  const view = await api(lender.app, '/api/lending');
  await api(lender.app, '/api/lending/rules', {method: 'POST', body: {rules: [...view.standingRules.map(({appOwned, ...r}) => r), mine], version: view.configVersion}});
  await api(lender.app, '/api/circles/' + circle.id + '/leave', {method: 'POST', body: {}});
  const s = await read();
  assert.equal(s.appRuleIds[circle.id], undefined);
  assert.deepEqual(s.standingRules.filter(r => r.circle === circle.id).map(r => r.id), ['my-own-rule']);
});

test('two verified rosters read at the same time: the newer epoch is applied, a replay or an older receipt is not', {timeout: 120000}, async t => {
  const x = await joined(t), at = (await x.read()).rosterApplied[x.circle.id] + DAY;
  await x.deliver({fetchedAt: at, epoch: 5, members: ['old']});
  const first = await x.appRule(), before = await x.read();
  // The same clock reading (a frozen or same-second clock) with the friend published: a distinct newer roster, not a replay.
  await x.deliver({fetchedAt: at, epoch: 6, members: ['old', 'friend']});
  const after = await x.appRule(), saved = await x.read();
  assert.deepEqual(after.people, ['old', 'friend']);
  assert.equal(after.expiresAt, at + D, 'expiry stays the read time plus 30 days');
  assert.deepEqual({...after, people: 0}, {...first, people: 0}, 'limits, schedule, agents and expiry are untouched');
  assert.equal(saved.configVersion, before.configVersion + 1);
  assert.equal(saved.rosterAppliedEpoch[x.circle.id], 6);
  await x.replay();
  assert.deepEqual(await x.appRule(), after, 'a replay does not renew or change members');
  assert.equal((await x.read()).configVersion, saved.configVersion);
  await x.deliver({fetchedAt: at, epoch: 5, members: ['old']});
  assert.deepEqual((await x.appRule()).people, ['old', 'friend'], 'an older racing receipt does not roll members back');
  assert.equal((await x.read()).configVersion, saved.configVersion);
  await x.deliver({fetchedAt: at + 1000, epoch: 5, members: ['old']});
  assert.deepEqual((await x.appRule()).people, ['old', 'friend'], 'a later-read receipt of an older epoch cannot roll members back either');
});

test('a renewal never moves the expiry back: a rule made after the read keeps its later expiry', {timeout: 120000}, async t => {
  const x = await joined(t), applied = (await x.read()).rosterApplied[x.circle.id];
  // Switching Automatic off and on again makes a new rule that expires 30 days from now, in milliseconds. A roster read
  // from before that moment is still new to the app, so it updates members, but it must not shorten the expiry.
  await api(x.lender.app, '/api/lending/mode', {method: 'POST', body: {circle: x.circle.id, mode: 'ask'}});
  await api(x.lender.app, '/api/lending/mode', {method: 'POST', body: {circle: x.circle.id, mode: 'auto'}});
  const made = await x.appRule();
  assert.ok(made.expiresAt > applied + D, 'the new rule expires after the last read time plus 30 days');
  await x.deliver({fetchedAt: applied, epoch: (await x.read()).rosterAppliedEpoch[x.circle.id] + 1, members: ['member-a']});
  const after = await x.appRule();
  assert.deepEqual(after.people, ['member-a'], 'the newer roster is applied');
  assert.equal(after.expiresAt, made.expiresAt, 'the expiry is not moved back');
});

test('a new read that changes nothing is still recorded, so an older read cannot roll members back afterwards', {timeout: 120000}, async t => {
  const x = await joined(t), s0 = await x.read(), at = s0.rosterApplied[x.circle.id], e = s0.rosterAppliedEpoch[x.circle.id];
  await api(x.lender.app, '/api/lending/mode', {method: 'POST', body: {circle: x.circle.id, mode: 'ask'}});
  await api(x.lender.app, '/api/lending/mode', {method: 'POST', body: {circle: x.circle.id, mode: 'auto'}});
  const made = await x.appRule();
  // The newest read has the rule's own members and an earlier expiry: the rule stays as it is.
  await x.deliver({fetchedAt: at, epoch: e + 2, members: made.people});
  assert.deepEqual(await x.appRule(), made);
  assert.equal((await x.read()).rosterAppliedEpoch[x.circle.id], e + 2, 'the read is recorded as applied');
  await x.deliver({fetchedAt: at, epoch: e + 1, members: ['old']});
  assert.deepEqual(await x.appRule(), made, 'an older read that arrives later changes nothing');
});
