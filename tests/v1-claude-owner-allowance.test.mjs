import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as realSource from '../lib/v1/lending-pace50-source.mjs';
import {withOwnMeasurement} from './helpers/own-measurement.mjs';
const source = withOwnMeasurement(realSource);

const T = Date.parse('2026-10-23T06:40:00Z');
const FIVE = Date.parse('2026-10-23T08:40:00Z');
const WEEK = Date.parse('2026-10-30T02:00:00Z');
const H = {account: '1111222233334444', email: 'aaaa0000bbbb1111', org: '5555666677778888'};
const CLAUDE_AUTH = {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'};
const IDENTITY = {account_sha256_16: H.account, email_sha256_16: H.email, org_sha256_16: H.org};
const windows = [
  {window_id: 'seven_day', window_minutes: 10080, used_pct: 5, resets_at: WEEK, observed_at: T, state: 'open'},
  {window_id: 'five_hour', window_minutes: 300, used_pct: 24, resets_at: FIVE, observed_at: T, state: 'open'},
];
const EXECUTOR = {backend_id: 'docker-sbx', sbx_version: 'sbx version v0.49.2 5d40fd43027b33ed1f1a39c14fb07e2503d6998f'};
const STOP = {delivered: true, fallback: null, latency_ms: 700, removed: true};

// The R6.1 allowance/overrun assertions are removed: the objective sizes each chunk from spare capacity.
// A window converts only with the account's own measurement; the shipped bound is a floor under it.
const observe = ({model = 'claude-haiku-5-5', plan = 'max20', ...overrides} = {}) => source.createRealPace50Source({
  readings: async () => ({windows}),
  funding: async () => ({extra_usage: 'disabled', observed_at: T, guest_auth: CLAUDE_AUTH, identity: IDENTITY}),
  stopEvidence: async () => ({executor: EXECUTOR, stop: STOP, measured_at: T}),
  expectedIdentity: async () => ({email_sha256_16: H.email}),
  expectedExecutor: {backend_id: 'docker-sbx', accepts: () => true}, stopBoundMs: 30000,
  ...overrides,
}).observe({provider: 'claude', model, plan});

test('a measurement below the shipped Claude bound is raised to it, with the shipped provenance', async () => {
  const obs = await observe();
  const weekly = obs.resources.find(resource => resource.kind === 'weekly');
  const short = obs.resources.find(resource => resource.kind === 'short');
  assert.equal(weekly.kappa_micro, 534900);
  assert.equal(short.kappa_micro, 1583100);
  assert.equal(weekly.kappa_lower_micro, null);
  assert.equal(short.kappa_lower_micro, null);
  assert.deepEqual(weekly.kappa_provenance, {
    label: 'shipped bound', // The measurement (1) is below the floor, so the floor and its provenance apply.
    method: 'accepted Default calibration bound',
    calibration: 'calibration-final/calibration.json',
    boundReport: 'calibration-final/differential/RESULTS.json',
    acceptedBy: 'lead decision, 2026-10-23',
  });
  assert.deepEqual(short.kappa_provenance, weekly.kappa_provenance);
});

// Was "no measurement holds by conversion_unknown"; an account with no measurement now lends natively. An unpriced model still holds.
test('an unpriced model holds by conversion_unknown; an account with no measurement lends natively', async () => {
  // The plan is a label: an unknown plan with a measurement still converts.
  assert.ok((await observe({plan: 'unknown'})).resources.every(resource => resource.kappa_micro > 0));
  const unpriced = await observe({model: 'unpriced-model'});
  assert.ok(unpriced.resources.every(resource => resource.kappa_micro === null && resource.conversion === null));
  assert.deepEqual(source.paceInputFromObservation(unpriced, {now: T, context: {}}), {refuse: 'conversion_unknown'});
  const unmeasured = await observe({kappaForUsage: () => null});
  assert.ok(unmeasured.resources.every(resource => resource.kappa_micro === null && resource.conversion === 'native_window'));
  assert.equal(source.paceInputFromObservation(unmeasured, {now: T, context: {}}).refuse, undefined);
});
