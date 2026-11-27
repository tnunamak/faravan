import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPetnameStore, normalizePetname, MAX_PETNAMES } from '../lib/v1/petnames.mjs';
import { createBorrowerOutcomeStore } from '../lib/v1/job-meta.mjs';
import { appFixture, api, waitFor } from './helpers/triage-small-app-fixture.mjs';

const testOptions = {timeout: 60000};
const ROOT = 'sha256:' + 'a'.repeat(64), ROOT2 = 'sha256:' + 'b'.repeat(64);
const CIRCLE = '11111111-1111-4111-8111-111111111111', CIRCLE2 = '22222222-2222-4222-8222-222222222222';
const KEY = 'sha256:' + '1'.repeat(64), KEY2 = 'sha256:' + '2'.repeat(64);
const gitInput = circle => ({circle:circle.id,git:'https://github.com/example/synthetic.git',
  commit:'1'.repeat(40),prompt:'Synthetic task: write a greeting.',harness:'codex'});
async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-petnames-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

test('labels are NFC, trimmed, 1 to 64 characters, with no control or bidi characters', () => {
  assert.equal(normalizePetname('  Café  '), 'Café');
  assert.equal(normalizePetname('x'.repeat(64)).length, 64);
  for (const bad of ['', '   ', 'x'.repeat(65), 'a\nb', 'a\u0000b', 'evil‮gpj', 'a​b', 'a b', 'a⁦b', 7, null, undefined])
    assert.throws(() => normalizePetname(bad), {code: 'invalid_petname'}, String(bad));
});

test('records are bound to root, circle and full key, and never inherited', async t => {
  const dir = await scratch(t), store = createPetnameStore(join(dir, 'petnames.json'));
  const saved = await store.save({root: ROOT, circle: CIRCLE, key: KEY}, 'Maya from design');
  assert.equal(saved.revision, 1);
  assert.equal((await store.get({root: ROOT, circle: CIRCLE, key: KEY})).label, 'Maya from design');
  // Same key in another circle, same key under another root, and another key in the same circle: all empty.
  assert.equal(await store.get({root: ROOT, circle: CIRCLE2, key: KEY}), null);
  assert.equal(await store.get({root: ROOT2, circle: CIRCLE, key: KEY}), null);
  assert.equal(await store.get({root: ROOT, circle: CIRCLE, key: KEY2}), null);
  assert.deepEqual(await store.list({root: ROOT, circle: CIRCLE2}), []);
  // The same text can label different keys in different circles without a collision.
  await store.save({root: ROOT, circle: CIRCLE2, key: KEY2}, 'Maya from design');
  assert.equal((await store.list({root: ROOT, circle: CIRCLE})).length, 1);
  // Short or display-string keys are not identities.
  for (const key of [KEY.slice(0, 20), 'Maya', '']) {
    await assert.rejects(store.get({root: ROOT, circle: CIRCLE, key}), {code: 'invalid_request'});
    await assert.rejects(store.save({root: ROOT, circle: CIRCLE, key}, 'x'), {code: 'invalid_request'});
  }
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(dir, 'petnames.json'), 'utf8'))), ['version', 'records']);
});

test('save is explicit: revisions change only on a changed label, delete removes only that record', async t => {
  const dir = await scratch(t); let clock = Date.parse('2026-10-13T00:00:00Z');
  const store = createPetnameStore(join(dir, 'petnames.json'), {now: () => clock});
  const a = {root: ROOT, circle: CIRCLE, key: KEY}, b = {root: ROOT, circle: CIRCLE, key: KEY2};
  assert.equal(await store.get(a), null, 'nothing is created by reading or listing');
  const first = await store.save(a, 'Maya');
  clock += 1000;
  assert.deepEqual(await store.save(a, ' Maya '), first, 'the same label is a no-op');
  const second = await store.save(a, 'Maya K');
  assert.equal(second.revision, 2);
  assert.equal(second.createdAt, first.createdAt);
  assert.notEqual(second.updatedAt, first.updatedAt);
  await store.save(b, 'Sam');
  assert.equal(await store.delete(a), true);
  assert.equal(await store.delete(a), false);
  assert.equal(await store.get(a), null);
  assert.equal((await store.get(b)).label, 'Sam');
  // A later label for the same key starts again; nothing was kept from the deleted one.
  assert.equal((await store.save(a, 'Maya')).revision, 1);
});

test('a label equal after NFC and case folding is refused for another key in the same circle', async t => {
  const dir = await scratch(t), store = createPetnameStore(join(dir, 'petnames.json'));
  await store.save({root: ROOT, circle: CIRCLE, key: KEY}, 'Straße Maya');
  for (const label of ['STRASSE MAYA', 'straße maya', 'Straße Maya'])
    await assert.rejects(store.save({root: ROOT, circle: CIRCLE, key: KEY2}, label), {code: 'petname_label_taken', status: 409});
  assert.equal(await store.get({root: ROOT, circle: CIRCLE, key: KEY2}), null);
  await store.save({root: ROOT, circle: CIRCLE, key: KEY2}, 'Straße Maya (work)');
  // The owner of a label can re-save it, and other circles are free to reuse it.
  await store.save({root: ROOT, circle: CIRCLE, key: KEY}, 'straße maya');
  await store.save({root: ROOT, circle: CIRCLE2, key: KEY2}, 'Straße Maya');
});

test('a corrupt or missing file reads as empty, and a save keeps the bad bytes aside', async t => {
  const dir = await scratch(t), file = join(dir, 'petnames.json'), store = createPetnameStore(file);
  const a = {root: ROOT, circle: CIRCLE, key: KEY};
  assert.deepEqual(await store.list(a), []);
  for (const bad of ['{not json', '[]', '{"version":2,"records":[]}', '{"version":1,"records":"x"}', '\u0000\u0001']) {
    await writeFile(file, bad);
    assert.equal(await store.get(a), null);
    assert.deepEqual(await store.list(a), []);
  }
  await writeFile(file, '{not json');
  await store.save(a, 'Maya');
  assert.equal((await store.get(a)).label, 'Maya');
  assert.equal((await readdir(dir)).filter(name => name.includes('.corrupt-')).length, 1);
  // Individually malformed records are dropped; valid ones survive.
  await writeFile(file, JSON.stringify({version: 1, records: [{nonsense: true}, {...a, label: 'Maya', revision: 1, createdAt: 'x', updatedAt: 'x'}]}));
  assert.equal((await store.list(a)).length, 1);
});

test('concurrent saves are serialized and none is lost', async t => {
  const dir = await scratch(t), store = createPetnameStore(join(dir, 'petnames.json'));
  const keys = Array.from({length: 12}, (_, i) => 'sha256:' + i.toString(16).padStart(64, '0'));
  await Promise.all(keys.map((key, i) => store.save({root: ROOT, circle: CIRCLE, key}, 'Person ' + i)));
  assert.equal((await store.list({root: ROOT, circle: CIRCLE})).length, 12);
});

async function addDevice(f, owner, circle, name) {
  const device = await f.start(name);
  const {invite} = await api(owner.app, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}});
  await api(device.app, '/api/circles/join', {method: 'POST', body: {link: invite}});
  await api(owner.app, '/api/circles/' + circle.id + '/approve', {method: 'POST', body: {}});
  await device.app.device.refreshRoster(circle.id);
  return device;
}
const members = async (app, circleId) =>(await api(app, '/api/devices')).circles.find(c => c.circle === circleId).members;
const save = (app, circle, keyId, label, status) =>api(app, '/api/circles/' + circle.id + '/petnames', {method: 'POST', body: {keyId, label}, status});

test('routes: explicit save, per-circle projection, same remote name on two keys, no inheritance', testOptions, async t => {
  // The owner is the viewer: its signed roster is current as members join, which a stale lender's cache is not in this fixture.
  const f = await appFixture(t), {owner, lender, circle} = await f.connect();
  const third = await addDevice(f, owner, circle, 'third');
  const lenderKey = lender.app.device.keyId, thirdKey = third.app.device.keyId, ownerKey = owner.app.device.keyId;
  const row = async key => (await members(owner.app, circle.id)).find(m => m.key_id === key);
  // Nothing exists until the viewer saves; viewing and listing create nothing.
  assert.ok((await members(owner.app, circle.id)).every(m => m.localName === null));
  assert.deepEqual(await api(owner.app, '/api/circles/' + circle.id + '/petnames'), []);
  assert.equal((await readdir(join(owner.home, 'v1'))).includes('petnames.json'), false);
  // Two different keys that assert the same remote device name.
  const remote = (await row(lenderKey)).device_name;
  assert.equal(typeof remote, 'string');
  assert.equal((await row(thirdKey)).device_name, remote);

  const saved = await save(owner.app, circle, lenderKey, '  Maya from design ');
  assert.deepEqual([saved.keyId, saved.label, saved.revision], [lenderKey, 'Maya from design', 1]);
  assert.equal((await row(lenderKey)).localName, 'Maya from design');
  assert.equal((await row(lenderKey)).device_name, remote, 'the remote device name stays in its own field');
  assert.equal((await row(thirdKey)).localName, null, 'the other key with the same remote name inherits nothing');
  assert.equal((await row(ownerKey)).localName, null);
  assert.ok((await members(lender.app, circle.id)).every(m => m.localName === null), 'only the viewer who saved has it');

  // Renaming a device on the remote side does not touch the viewer's label.
  await api(lender.app, '/api/devices', {method: 'POST', body: {name: 'Renamed laptop'}});
  assert.equal((await row(lenderKey)).localName, 'Maya from design');

  // A label equal after case folding is refused with a code the UI can turn into a qualifier prompt.
  assert.equal((await save(owner.app, circle, thirdKey, 'MAYA FROM DESIGN', 409)).code, 'petname_label_taken');
  assert.equal((await row(thirdKey)).localName, null);
  await save(owner.app, circle, thirdKey, 'Maya from design (work)');

  // Invalid input and non-members are refused; state is unchanged.
  assert.equal((await save(owner.app, circle, thirdKey, 'bad‮label', 400)).code, 'invalid_petname');
  assert.equal((await save(owner.app, circle, thirdKey, '', 400)).code, 'invalid_petname');
  await save(owner.app, circle, 'sha256:' + '9'.repeat(64), 'Stranger', 404);
  await save(owner.app, circle, lenderKey.slice(0, 20), 'Short', 404);
  await api(owner.app, '/api/circles/' + circle.id + '/petnames', {method: 'POST', body: {keyId: lenderKey, label: 'x', extra: 1}, status: 400});
  await api(owner.app, '/api/circles/' + circle.id + '/petnames', {method: 'POST', token: null, body: {keyId: lenderKey, label: 'x'}, status: 401});
  assert.equal((await row(lenderKey)).localName, 'Maya from design');

  // Delete removes only the chosen key's label.
  assert.deepEqual(await api(owner.app, '/api/circles/' + circle.id + '/petnames/delete', {method: 'POST', body: {keyId: lenderKey}}), {removed: true});
  assert.equal((await row(lenderKey)).localName, null);
  assert.equal((await row(thirdKey)).localName, 'Maya from design (work)');
  const file = JSON.parse(await readFile(join(owner.home, 'v1', 'petnames.json'), 'utf8'));
  assert.deepEqual(file.records.map(r => [r.root, r.circle, r.key]), [[circle.pinnedRootFingerprint, circle.id, thirdKey]]);
});

test('the same key in two circles has two independent local names', testOptions, async t => {
  const f = await appFixture(t), {owner, lender, circle} = await f.connect();
  const second = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Second circle'}});
  await f.provisionFromHome('owner');
  const {invite} = await api(owner.app, '/api/circles/' + second.id + '/invite', {method: 'POST', body: {}});
  await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: invite}});
  await api(owner.app, '/api/circles/' + second.id + '/approve', {method: 'POST', body: {}});
  await lender.app.device.refreshRoster(second.id);
  const ownerKey = owner.app.device.keyId;
  await save(lender.app, circle, ownerKey, 'Maya');
  assert.equal((await members(lender.app, second.id)).find(m => m.key_id === ownerKey).localName, null);
  await save(lender.app, second, ownerKey, 'Maya');
  await save(lender.app, second, ownerKey, 'Maya at work');
  assert.equal((await members(lender.app, circle.id)).find(m => m.key_id === ownerKey).localName, 'Maya');
  assert.equal((await members(lender.app, second.id)).find(m => m.key_id === ownerKey).localName, 'Maya at work');
  assert.notEqual(second.pinnedRootFingerprint, circle.pinnedRootFingerprint);
});

test('a corrupt petname file leaves the app usable and shows no local names', testOptions, async t => {
  const f = await appFixture(t), {owner, lender, circle} = await f.connect();
  await save(lender.app, circle, owner.app.device.keyId, 'Maya');
  await writeFile(join(lender.home, 'v1', 'petnames.json'), '{broken');
  const list = await members(lender.app, circle.id);
  assert.ok(list.length >= 2 && list.every(m => m.localName === null));
  assert.deepEqual(await api(lender.app, '/api/circles/' + circle.id + '/petnames'), []);
  await save(lender.app, circle, owner.app.device.keyId, 'Maya again');
  assert.equal((await members(lender.app, circle.id)).find(m => m.key_id === owner.app.device.keyId).localName, 'Maya again');
});

test('the approval card carries the viewer-local name beside the unchanged requester key, and no petname leaves the device', testOptions, async t => {
  const f = await appFixture(t), {owner, lender, circle} = await f.connect();
  const label = 'Zorblax petname 7731', ownerKey = owner.app.device.keyId;
  await save(lender.app, circle, ownerKey, label);
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  const card = await waitFor(async () => (await api(lender.app, '/api/approvals'))[0], 'review card');
  assert.equal(card.requester, ownerKey, 'the key is still the requester identity');
  assert.equal(card.localName, label);
  // The viewer's own rename re-shows the open card at once, under a new ID and without a warning.
  await api(lender.app, '/api/circles/' + circle.id + '/petnames/delete', {method: 'POST', body: {keyId: ownerKey}});
  assert.equal((await api(lender.app, '/api/approvals'))[0].localName, null);
  await save(lender.app, circle, ownerKey, label);
  await api(lender.app, '/api/approvals/' + card.id + '/accept', {method: 'POST', body: {}, status: 404});
  const refreshed = (await api(lender.app, '/api/approvals'))[0];
  assert.notEqual(refreshed.id, card.id);
  assert.equal(refreshed.localName, label);
  assert.equal(refreshed.identityNotice, null);
  await api(lender.app, '/api/approvals/' + refreshed.id + '/accept', {method: 'POST', body: {}});
  await waitFor(() => [...f.jobs.values()].some(job => job.state === 'result-accepted'), 'job result');

  // Everything the coordinator saw, from every device: request lines, headers (including decoded proofs) and bodies.
  assert.ok(f.rawRequests.length > 5);
  const variants = [label, Buffer.from(label).toString('base64'), Buffer.from(label).toString('base64url'), Buffer.from(label).toString('hex')];
  for (const request of f.rawRequests) {
    const proof = request.headers['faravan-proof'];
    const seen = [request.url, JSON.stringify(request.headers), request.body, proof ? Buffer.from(proof, 'base64url').toString() : ''].join('\n');
    for (const variant of variants) assert.equal(seen.includes(variant), false, request.method + ' ' + request.url);
  }
  assert.equal(JSON.stringify([...f.jobs.values()]).includes(label), false, 'no job or result carries it');
  assert.equal(JSON.stringify(f.circles.get(circle.id).roster).includes(label), false, 'the roster does not carry it');
});

test('the petname store is bounded: a new key past the cap is refused, an existing key can still change', async t => {
  const dir = await scratch(t), file = join(dir, 'petnames.json'), at = new Date(0).toISOString();
  const root = 'sha256:' + '1'.repeat(64), circle = '00000000-0000-4000-8000-000000000000';
  const key = i => 'sha256:' + i.toString(16).padStart(64, '0');
  const records = Array.from({length: MAX_PETNAMES}, (_, i) => ({root, circle, key: key(i), label: 'n' + i, revision: 1, createdAt: at, updatedAt: at}));
  await writeFile(file, JSON.stringify({version: 1, records}));
  const store = createPetnameStore(file);
  await assert.rejects(store.save({root, circle, key: key(MAX_PETNAMES)}, 'One too many'), {code: 'petname_store_full'});
  assert.equal((await store.save({root, circle, key: key(0)}, 'Renamed')).label, 'Renamed');
});

test('a damaged verdict file reads as empty, and the next save keeps the bad bytes aside', async t => {
  const dir = await scratch(t), store = createBorrowerOutcomeStore(dir), digest = 'sha256:' + 'b'.repeat(64);
  await writeFile(join(dir, 'borrower-outcomes.json'), '{not json');
  assert.equal(await store.get('circle-A', digest), null);
  await store.set('circle-A', digest, {verdict: 'used'});
  assert.equal((await store.get('circle-A', digest)).verdict, 'used');
  const kept = (await readdir(dir)).filter(name => name.startsWith('borrower-outcomes.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(await readFile(join(dir, kept[0]), 'utf8'), '{not json');
});

test('the verdict store is bounded: a new job past the cap is refused', async t => {
  const dir = await scratch(t), all = {};
  for (let i = 0; i < 10000; i++) all[JSON.stringify(['c', 'sha256:' + i.toString(16).padStart(64, '0')])] = {verdict: 'used', note: '', checks: ''};
  await writeFile(join(dir, 'borrower-outcomes.json'), JSON.stringify(all));
  const store = createBorrowerOutcomeStore(dir);
  await assert.rejects(store.set('c', 'sha256:' + 'f'.repeat(64), {verdict: 'unused'}), {code: 'verdict_store_full'});
  await store.set('c', 'sha256:' + '0'.repeat(64), {verdict: 'unused'});
});
