import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture, api} from './helpers/v1-app-fixture.mjs';

// Restart is not permission to grant a rule to a previously joined circle.
const create = (f, app, name) => api(app, '/api/circles', {method: 'POST', body: {origin: f.origin, name}});
const disk = home => join(home, 'v1', 'app-settings.json');
const saved = async home => JSON.parse(await readFile(disk(home), 'utf8'));
const rule = (circle, extra = {}) => ({id: 'owner-rule-' + circle, circle, people: [], agents: ['codex'], maxWallSeconds: 600,
  dailyJobs: 1, weeklyJobs: 2, dailyMinutes: 10, weeklyMinutes: 20, schedule: null, timeZone: 'UTC', expiresAt: Date.now() + 5 * 86400000, ...extra});

// Two joined circles on an install whose settings file predates modes: no mode, no rule, no ownership record, no notices.
async function legacy(t, edit = () => {}) {
  const f = await appFixture(t), {owner, circle: first} = await f.connect({resumeLending: false});
  const second = await create(f, owner.app, 'Second');
  const priorDefaults = (await api(owner.app, '/api/decisions')).events.filter(e => e.source === 'install_default').length;
  await owner.app.close();
  const old = await saved(owner.home);
  old.modes = {}; old.standingRules = []; delete old.appRuleIds; delete old.noticesShown; delete old.joinMode; delete old.pendingJoinedDefaults;
  old.intent = 'off';
  edit(old, {first, second, owner});
  await writeFile(disk(owner.home), JSON.stringify(old));
  return {f, owner, first, second, priorDefaults, restart: () => f.start('owner')};
}
test('unconfigured joined circles stay inert across restarts', {timeout: 120000}, async t => {
  const x = await legacy(t);
  for (let i = 0; i < 2; i++) {
    const up = await x.restart(), state = await saved(x.owner.home);
    assert.deepEqual(state.modes, {});
    assert.deepEqual(state.standingRules, []);
    assert.equal(state.intent, 'off');
    assert.equal(state.noticesShown, undefined);
    const status = await api(up.app, '/api/status');
    assert.equal(status.automaticNotices, undefined);
    assert.deepEqual(status.lendingPrompts.map(p => p.circle).sort(), [x.first.id, x.second.id].sort());
    assert.equal((await api(up.app, '/api/decisions')).events.filter(e => e.source === 'install_default').length, x.priorDefaults, 'restart adds no default-grant audit');
    await up.app.close();
  }
});

for (const mode of ['ask', 'off', 'auto']) test('restart preserves explicit ' + mode + ' and existing rules', {timeout: 120000}, async t => {
  let mine;
  const x = await legacy(t, (old, {first, owner}) => {
    old.modes = {[first.id]: mode};
    mine = rule(first.id, {people: [owner.app.device.keyId]});
    old.standingRules = [mine];
  });
  for (let i = 0; i < 2; i++) {
    const up = await x.restart(), state = await saved(x.owner.home);
    assert.deepEqual(state.modes, {[x.first.id]: mode});
    assert.deepEqual(state.standingRules, [mine]);
    assert.equal(state.noticesShown, undefined);
    await up.app.close();
  }
});

test('owner can explicitly enable an unconfigured circle through normal settings', {timeout: 120000}, async t => {
  const x = await legacy(t), up = await x.restart();
  await api(up.app, '/api/lending/mode', {method: 'POST', body: {circle: x.first.id, mode: 'auto'}});
  const state = await saved(x.owner.home);
  assert.equal(state.modes[x.first.id], 'auto');
  assert.equal(state.standingRules.filter(r => r.circle === x.first.id).length, 1);
  assert.equal(state.modes[x.second.id], undefined);
  assert.ok(!state.standingRules.some(r => r.circle === x.second.id));
  assert.ok((await api(up.app, '/api/decisions')).events.some(e => e.circle === x.first.id && e.rule?.mode === 'auto'));
});

test('a genuinely new circle still receives its normal join default', {timeout: 120000}, async t => {
  const x = await legacy(t), up = await x.restart();
  const joined = await create(x.f, up.app, 'Created later'), state = await saved(x.owner.home);
  assert.equal(state.modes[joined.id], 'auto');
  assert.equal(state.standingRules.filter(r => r.circle === joined.id).length, 1);
  assert.equal(state.modes[x.first.id], undefined);
  assert.equal(state.noticesShown, undefined);
  assert.equal((await api(up.app, '/api/status')).automaticNotices, undefined);
});
