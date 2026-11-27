import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, writeFile, access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';

// D6 / item 19: a home written by this build is opened by the published .73 build, saved there, and opened here again.
// Set FARAVAN_REL73 to a read-only copy of the published .73 tree (lib/ plus node_modules). Unset, the test is skipped. Set, it
// must run: a tree that does not load, or is not the published .73, fails the test. The home is a throwaway; usage is mocked.
const REL73 = process.env.FARAVAN_REL73;
const skip = REL73 ? false : 'set FARAVAN_REL73 to the published .73 tree to run this';
// The tree has no version string, so it is identified by content: the published .73 app module, and none of this build's reader.
const PUBLISHED_73_APP_SHA256 = '2a114ae4a60fe837428908ba54dfc147cda9d4e253cff4bc0b675cd85b546372';
const old = REL73 ? await import(join(REL73, 'lib/v1/app.mjs')) : null;

const filesOf = async (root, rel = '') => {
  const out = {};
  for (const entry of await readdir(join(root, rel), {withFileTypes: true}).catch(() => [])) {
    const path = join(rel, entry.name);
    if (entry.isDirectory()) Object.assign(out, await filesOf(root, path));
    else if (entry.isFile()) out[path] = await readFile(join(root, path));
  }
  return out;
};

test('settings written here survive a .73 open and save, and reopen here with the same choices', {timeout: 240000, skip}, async t => {
  const digest = createHash('sha256').update(await readFile(join(REL73, 'lib/v1/app.mjs'))).digest('hex');
  assert.equal(digest, PUBLISHED_73_APP_SHA256, 'FARAVAN_REL73 is the published .73 tree');
  await assert.rejects(access(join(REL73, 'lib/v1/usage-host-reader.mjs')), 'the frozen tree has none of this build\'s modules');
  assert.equal(typeof old.startApp, 'function');
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({freshLending: 'automatic', resumeLending: false});
  const file = join(lender.home, 'v1', 'app-settings.json');
  await api(lender.app, '/api/circles/' + circle.id + '/check', {method: 'POST', body: {}});
  await waitFor(async () => (await readFile(file, 'utf8').then(JSON.parse, () => ({}))).standingRules?.length, 'the default rule is installed');
  const read = async () => JSON.parse(await readFile(file, 'utf8'));
  const view = () => api(lender.app, '/api/lending');
  const post = (path, body, status) => api(lender.app, '/api/lending/' + path, {method: 'POST', body, status});
  const person = 'person-key';
  const rules = (await view()).standingRules.map(({appOwned, ...r}) => r);
  await post('rules', {rules: [...rules, {id: 'custom-person-rule', circle: circle.id, people: [person], agents: ['codex'], maxWallSeconds: 600,
    dailyJobs: 2, weeklyJobs: 5, dailyMinutes: 30, weeklyMinutes: 90, schedule: null, timeZone: 'UTC', expiresAt: Date.now() + 5 * 86400000}], version: (await view()).configVersion});
  const lendingBefore = await view();
  await lender.app.close();
  // An upgrade notice, in the shape the startup migration writes, so the round trip carries one.
  await writeFile(file, JSON.stringify({...await read(), noticesShown: {[circle.id]: {kind: 'automatic', at: Date.now(), dismissed: false}}}));
  const before = await read();
  const files74 = await filesOf(lender.home);

  // .73 opens the home this build wrote, reads the rules, and saves one limit.
  const down = await f.start('lender', {startApp: old.startApp, resumeLending: false, freshLending: 'automatic'});
  const seen73 = await api(down.app, '/api/lending');
  assert.deepEqual(seen73.standingRules.map(r => r.id).sort(), lendingBefore.standingRules.map(r => r.id).sort(), '.73 sees the same rules');
  await api(down.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 4, version: seen73.configVersion}});
  const rules73 = (await api(down.app, '/api/lending')).standingRules.map(({appOwned, ...r}) => r);
  await api(down.app, '/api/lending/rules', {method: 'POST', body: {version: (await api(down.app, '/api/lending')).configVersion,
    rules: [...rules73, {id: 'rule-saved-by-73', circle: circle.id, people: [person], agents: ['codex'], maxWallSeconds: 300, dailyJobs: 1, weeklyJobs: 2,
      dailyMinutes: 10, weeklyMinutes: 20, schedule: null, timeZone: 'UTC', expiresAt: Date.now() + 3 * 86400000}]}});
  // The retired notice is still an older .73 presentation contract, not a current-app one.
  const status73 = await api(down.app, '/api/status');
  assert.equal(Object.hasOwn(status73, 'automaticNotices'), false, 'the pinned .73 runtime has no notice projection');
  await down.app.close();
  const files73 = await filesOf(lender.home);
  const mid = await read();

  // .74 opens it again.
  const up = await f.start('lender', {resumeLending: false, freshLending: 'automatic'});
  const lendingAfter = await api(up.app, '/api/lending');
  const home = await api(up.app, '/api/home');
  const statusAfter = await api(up.app, '/api/status');
  await up.app.close();
  const after = await read();
  const files74b = await filesOf(lender.home);

  // Nothing this build wrote is lost to a .73 save, and no startup refusal happened in either direction (both apps started).
  for (const key of Object.keys(before)) assert.ok(key in mid && key in after, key + ' survives the round trip');
  const changed = (a, b) => Object.keys(a).filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key])).sort();
  // .73 changes only what it was asked to change, its own older presence marker, and `enabled`: both builds start with
  // resumeLending:false here, which leaves lending paused whichever build opens the home (checked with .74 in .73's place).
  assert.deepEqual(changed(before, mid), ['configVersion', 'enabled', 'limits', 'presenceDefaultsVersion', 'standingRules']);
  assert.equal(mid.limits.dailyJobs, 4);
  assert.deepEqual({...mid.limits, dailyJobs: null}, {...before.limits, dailyJobs: null}, 'no other limit moved');
  // Reopening here changes nothing but the marker, and it keeps the .73 save (no copy-back).
  assert.deepEqual(changed(mid, after), ['presenceDefaultsVersion']);
  assert.equal(after.presenceDefaultsVersion, before.presenceDefaultsVersion);
  assert.equal(after.limits.dailyJobs, 4);
  assert.deepEqual(after.standingRules, mid.standingRules, 'the rule .73 saved is kept as .73 wrote it');
  assert.ok(after.standingRules.some(r => r.id === 'rule-saved-by-73') && after.standingRules.some(r => r.id === 'custom-person-rule'));
  for (const key of ['modes', 'appRuleIds', 'noticesShown', 'presence', 'lendingAuth', 'rosterApplied', 'pendingDefaultRules', 'agents'])
    assert.deepEqual(after[key], before[key], key + ' is the same after the round trip');
  // The effective choices: rule ids, consent and the presence pair, as the app presents them.
  assert.deepEqual(lendingAfter.standingRules.map(r => r.id).sort(), [...lendingBefore.standingRules.map(r => r.id), 'rule-saved-by-73'].sort());
  assert.deepEqual(lendingAfter.limits.idleOnly, lendingBefore.limits.idleOnly);
  assert.deepEqual(lendingAfter.lendingPolicy?.stopOnReturn, lendingBefore.lendingPolicy?.stopOnReturn);
  // Current presentation omits retired notices; persisted choices above remain compatible.
  assert.equal(Object.hasOwn(statusAfter, 'automaticNotices'), false);
  assert.equal(Object.hasOwn(home.lending, 'presenceNotice'), false);
  // Every file the settings route does not own is byte-identical across both directions.
  const runtime = path => /^v1\/(app-settings|decisions|support-readiness)\.json$|^v1\/(history|prices)\//.test(path);
  for (const [k, bytes] of Object.entries(files74)) if (!runtime(k)) {
    assert.ok(files73[k]?.equals(bytes), k + ' is untouched by .73');
    assert.ok(files74b[k]?.equals(bytes), k + ' is untouched by the reopen');
  }
  for (const k of Object.keys(files73)) if (!runtime(k)) assert.ok(k in files74, k + ' was not created by .73');
  for (const k of Object.keys(files74b)) if (!runtime(k)) assert.ok(k in files74, k + ' was not created by the reopen');
});
