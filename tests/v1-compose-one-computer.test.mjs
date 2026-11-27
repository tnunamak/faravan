import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api} from './helpers/v1-app-fixture.mjs';
import {json} from './helpers/v1-journey.mjs';
import {MODEL_EFFORT_PAIRS_CAPABILITY} from '../lib/v1/versions.mjs';

// One person, one computer: it hosts the circle and lends in it. The coordinator's presence page lists every member,
// this computer included, and the lender runs a job this computer signed as an own job. So the composer must list
// this computer's agents and pairs. Before this fix it dropped its own row and showed an empty Agent list.
const testOptions = {timeout: 120000};

async function oneComputer(t, rows) {
  const f = await appFixture(t);
  const owner = await f.start('owner', {pollMs: 250});
  await f.provisionFromHome('owner');
  const circle = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Tessa'}});
  const original = f.override;
  f.override = async args => {
    if (args.route === '/presence') {
      json(args.res, {now: new Date().toISOString(), online_seconds: 90, persons: [], devices: rows(owner.app.device.keyId)});
      return true;
    }
    return original(args);
  };
  return api(owner.app, '/api/circles/' + encodeURIComponent(circle.id) + '/compose');
}
const self = keyId => ({device: keyId, online: true, source: 'heartbeat', intent: {state: 'ready'},
  capabilities: [MODEL_EFFORT_PAIRS_CAPABILITY, 'budget_v1'], agents: [
    {adapter: 'codex', readiness: 'ready', models: ['example-model'], per_job_max_minutes: 20, model_efforts: [{model: 'example-model', effort: 'low'}]},
    {adapter: 'claude-code-subscription', readiness: 'ready', models: ['claude-opus-5-5'], per_job_max_minutes: 20,
      model_efforts: [{model: 'claude-opus-5-5', effort: 'medium'}]}]});

test('a computer that hosts and lends in its own circle offers its own agents to its composer', testOptions, async t => {
  let keyId;
  const state = await oneComputer(t, id => [self(keyId = id)]);
  assert.equal(state.presence, 'ok');
  assert.deepEqual(state.lenders, [{keyId, self: true, state: 'ready', label: state.host.label,
    agents: [{adapter: 'codex', readiness: 'ready'}, {adapter: 'claude-code-subscription', readiness: 'ready'}]}],
  'this computer is listed as a lender, marked as itself and named by its own name');
  assert.deepEqual(state.offers, [{harness: 'codex', model: 'example-model', effort: 'low'}, {harness: 'claude-code', model: 'claude-opus-5-5', effort: 'medium'}]);
});

test('a paused lender is listed with its state, so the composer does not call it lending', testOptions, async t => {
  const state = await oneComputer(t, id => [{...self(id), intent: {state: 'paused'}, agents: []}]);
  assert.deepEqual(state.lenders.map(l => [l.self, l.state]), [[true, 'paused']]);
});

test('a computer that does not lend in its own circle is not listed', testOptions, async t => {
  const state = await oneComputer(t, id => [{...self(id), intent: {state: 'off'}}]);
  assert.deepEqual(state.lenders, [], 'lending off: no lender, so the composer must say why');
  assert.deepEqual(state.offers, []);
});
