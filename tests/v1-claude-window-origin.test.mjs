import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as originModule from '../lib/v1/window-origin.mjs';
import * as realSource from './helpers/real-source.mjs';
import {withOwnMeasurement} from './helpers/own-measurement.mjs';
const source = withOwnMeasurement(realSource);
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
// The real meter/conversion remains under test; only objective demand evidence is synthetic.
const objectiveInputFor = createSyntheticPace50Source().objectiveInputFor;
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';

// A window's origin is "lending" only when a lent attempt opened it, and "owner" when the owner attests it or when the lender sees
// it open with no lent opening confirmed and no lent attempt live. Anything else stays unknown (null).
const T = Date.parse('2026-10-23T06:40:00Z');
const FIVE = Date.parse('2026-10-23T08:40:00Z');
const NEXT_FIVE = FIVE + 5 * 3600000;
const openShort = (resets, observedAt = T) => ({window_id: 'five_hour', window_minutes: 300, used_pct: 24, resets_at: resets,
  observed_at: observedAt, state: 'open'});
const fresh = () => mkdtempSync(join(tmpdir(), 'window-origin-'));
const attest = (store, windows, instance, now = T) => store.attestOwnerOpening({windows, instance, by: 'owner',
  reason: 'the owner opened this window by using Claude', now});

test('an open window stays unknown when the caller does not rule out a live lent attempt: no origin and no record', () => {
  const dir = fresh();
  try {
    const store = originModule.createWindowOriginStore({directory: dir});
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [], now: T});
    assert.equal(store.originFor(`five_hour@${FIVE}`), null);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'window-origin.json'), 'utf8')).records, [], 'nothing was recorded');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('an owner opening is recorded only when the owner attests it for a window open now, with who and when, and it survives a restart', () => {
  const dir = fresh();
  try {
    const store = originModule.createWindowOriginStore({directory: dir});
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [], now: T});
    attest(store, [openShort(FIVE)], `five_hour@${FIVE}`);
    assert.equal(store.originFor(`five_hour@${FIVE}`), 'owner');
    const restarted = originModule.createWindowOriginStore({directory: dir});
    assert.equal(restarted.originFor(`five_hour@${FIVE}`), 'owner', 'the attested origin survives a restart');
    const [record] = JSON.parse(readFileSync(join(dir, 'window-origin.json'), 'utf8')).records;
    assert.equal(record.attested_by, 'owner');
    assert.equal(record.attested_at, T);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('an attestation is refused for a window that is not open now, for a missing owner or reason, and over a lending record', () => {
  const dir = fresh();
  try {
    const store = originModule.createWindowOriginStore({directory: dir});
    assert.throws(() => attest(store, [openShort(FIVE)], `five_hour@${NEXT_FIVE}`), /origin_attestation_invalid/, 'the instance is not open now');
    assert.throws(() => store.attestOwnerOpening({windows: [openShort(FIVE)], instance: `five_hour@${FIVE}`, by: '', reason: 'x', now: T}),
      /origin_attestation_invalid/, 'an owner is required');
    assert.throws(() => store.attestOwnerOpening({windows: [openShort(FIVE)], instance: `five_hour@${FIVE}`, by: 'owner', reason: ' ', now: T}),
      /origin_attestation_invalid/, 'a reason is required');
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [`five_hour@${FIVE}`], now: T});
    assert.throws(() => attest(store, [openShort(FIVE)], `five_hour@${FIVE}`), /origin_attestation_conflict/, 'a lent opening is not re-labelled');
    assert.equal(store.originFor(`five_hour@${FIVE}`), 'lending');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('an owner record without an attestation (the old default) is not proof of an owner opening', () => {
  const dir = fresh();
  try {
    const legacy = {version: 1, records: [{instance: `five_hour@${FIVE}`, window_id: 'five_hour', origin: 'owner',
      resets_at: FIVE, recorded_at: T}]};
    writeFileSync(join(dir, 'window-origin.json'), JSON.stringify(legacy), 'utf8');
    const store = originModule.createWindowOriginStore({directory: dir});
    assert.equal(store.originFor(`five_hour@${FIVE}`), null, 'an unattested owner record is unknown');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a window a lent attempt opened is recorded as lending, not owner', () => {
  const dir = fresh();
  try {
    const store = originModule.createWindowOriginStore({directory: dir});
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [`five_hour@${FIVE}`], now: T});
    assert.equal(store.originFor(`five_hour@${FIVE}`), 'lending');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a new window instance after a reset inherits no origin, and an expired instance is pruned', () => {
  const dir = fresh();
  try {
    const store = originModule.createWindowOriginStore({directory: dir});
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [], now: T});
    attest(store, [openShort(FIVE)], `five_hour@${FIVE}`);
    assert.equal(store.originFor(`five_hour@${NEXT_FIVE}`), null, 'the old attestation does not carry over');
    store.observeOpen({windows: [openShort(NEXT_FIVE, NEXT_FIVE - 60000)], lendingInstances: [], now: NEXT_FIVE + 60000});
    assert.equal(store.originFor(`five_hour@${NEXT_FIVE}`), null, 'a new instance seen open is still unknown until attested');
    assert.equal(store.originFor(`five_hour@${FIVE}`), null, 'the expired instance was reconciled away');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('an unreadable origin file yields no origin and is never overwritten', () => {
  const dir = fresh();
  try {
    const path = join(dir, 'window-origin.json');
    writeFileSync(path, '{"records": [', 'utf8');
    const store = originModule.createWindowOriginStore({directory: dir});
    assert.equal(store.originFor(`five_hour@${FIVE}`), null);
    assert.throws(() => store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [], now: T}), /unreadable_window_origin/);
    assert.throws(() => attest(store, [openShort(FIVE)], `five_hour@${FIVE}`), /unreadable_window_origin/);
    assert.equal(readFileSync(path, 'utf8'), '{"records": [', 'the unreadable file is left as it was');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('the source takes the origin from the durable record: unknown until attested, then owner', async () => {
  const dir = fresh();
  try {
    const store = originModule.createWindowOriginStore({directory: dir});
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [], now: T});
    const withOrigin = source.createRealPace50Source({readings: async () => ({windows: [openShort(FIVE)]}),
      windowOrigin: async (provider, resources) => originModule.originMapFor(store, resources)});
    assert.equal((await withOrigin.observe({provider: 'claude'})).resources[0].origin, null, 'unattested, so unknown');
    attest(store, [openShort(FIVE)], `five_hour@${FIVE}`);
    assert.equal((await withOrigin.observe({provider: 'claude'})).resources[0].origin, 'owner');
    const bare = source.createRealPace50Source({readings: async () => ({windows: [openShort(FIVE)]})});
    assert.equal((await bare.observe({provider: 'claude'})).resources[0].origin, null, 'no origin source, no origin');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('with no lent opening confirmed and no lent attempt live, an open short window is recorded as the owner\'s, inferred', () => {
  const dir = fresh();
  try {
    const store = originModule.createWindowOriginStore({directory: dir});
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [], lentAttemptLive: false, now: T});
    assert.equal(store.originFor(`five_hour@${FIVE}`), 'owner');
    const [record] = JSON.parse(readFileSync(join(dir, 'window-origin.json'), 'utf8')).records;
    assert.equal(record.inferred, 'no_lent_opening', 'the record says it was inferred, not attested');
    assert.equal(record.attested_by, undefined);
    assert.equal(originModule.createWindowOriginStore({directory: dir}).originFor(`five_hour@${FIVE}`), 'owner', 'it survives a restart');
    attest(store, [openShort(FIVE)], `five_hour@${FIVE}`);
    const upgraded = JSON.parse(readFileSync(join(dir, 'window-origin.json'), 'utf8')).records;
    assert.equal(upgraded.length, 1);
    assert.equal(upgraded[0].attested_by, 'owner', 'an attestation replaces the inference');
    assert.equal(upgraded[0].inferred, undefined);
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [`five_hour@${FIVE}`], lentAttemptLive: false, now: T});
    assert.equal(store.originFor(`five_hour@${FIVE}`), 'owner', 'a lent opening never replaces an attestation');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a live lent attempt blocks the inference, and a confirmed lent opening replaces an inferred owner record', () => {
  const dir = fresh();
  try {
    const store = originModule.createWindowOriginStore({directory: dir});
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [], lentAttemptLive: true, now: T});
    assert.equal(store.originFor(`five_hour@${FIVE}`), null, 'the live attempt may have opened the window now open');
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [], lentAttemptLive: false, now: T});
    assert.equal(store.originFor(`five_hour@${FIVE}`), 'owner');
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [`five_hour@${FIVE}`], lentAttemptLive: false, now: T});
    assert.equal(store.originFor(`five_hour@${FIVE}`), 'lending');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('an owner attestation is never replaced by a lending record', () => {
  const dir = fresh();
  try {
    const store = originModule.createWindowOriginStore({directory: dir});
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [], now: T});
    attest(store, [openShort(FIVE)], `five_hour@${FIVE}`);
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [`five_hour@${FIVE}`], lentAttemptLive: false, now: T});
    assert.equal(store.originFor(`five_hour@${FIVE}`), 'owner');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('the owner may attest only a window the lender has seen open recently', () => {
  const dir = fresh();
  try {
    const store = originModule.createWindowOriginStore({directory: dir});
    store.observeOpen({windows: [openShort(FIVE)], lendingInstances: [], now: T});
    const seen = store.seenOpen({now: T});
    assert.equal(seen.length, 1);
    assert.equal(seen[0].window_id, 'five_hour');
    assert.equal(store.seenOpen({now: T + 11 * 60000}).length, 0, 'an old observation no longer counts');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

// The production candidate records the origins it sees and takes each window's origin from the record. It never opens a short
// window itself, so a window it sees open with no lent opening is the owner's, and a job is admitted without an attestation.
const ADMISSIBLE = {account: 'f12e3786d2837824', email: 'aaaa0000bbbb1111', org: '5555666677778888'};
function originCandidate(directory, windowOrigins) {
  const admissible = source.createRealPace50Source({
    readings: async () => ({windows: [
      {window_id: 'seven_day', window_minutes: 10080, used_pct: 5, resets_at: 1793325600000, observed_at: T, state: 'open'},
      {window_id: 'five_hour', window_minutes: 300, used_pct: 24, resets_at: 1792744800000, observed_at: T, state: 'open'},
    ]}),
    funding: async () => ({extra_usage: 'disabled', observed_at: T, guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'},
      identity: {account_sha256_16: ADMISSIBLE.account, email_sha256_16: ADMISSIBLE.email, org_sha256_16: ADMISSIBLE.org},
      executor: {backend_id: 'docker-sbx', sbx_version: 'sbx version v0.49.2'}, stop: {delivered: true, fallback: null, latency_ms: 700, removed: true}}),
    expectedIdentity: async () => ({email_sha256_16: ADMISSIBLE.email}),
    expectedExecutor: {backend_id: 'docker-sbx', accepts: () => true}, stopBoundMs: 30000,
  });
  return createPace50Candidate({objectiveInputFor, contextFor: () => ({plan: 'max20'}), directory, now: () => T, account: ADMISSIBLE.account,
    account_week_id: `${ADMISSIBLE.account}:weekly:1793325600000`, source: admissible, ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 1.5})},
    windowOrigins});
}

test('the production candidate infers the owner for a window open with no lent opening, and admits without an attestation', {timeout: 30000}, async () => {
  const dir = fresh();
  try {
    const store = originModule.createWindowOriginStore({directory: join(dir, 'origin')});
    const {candidate, adapter} = originCandidate(join(dir, 'pace50'), store);
    const reserve = (attemptId) => candidate.reserve({attemptId, jobId: 'job-origin', provider: 'claude', model: 'claude-haiku-5-5',
      job: {requirements: {limits: {wall_seconds: 240}}, expires_at: null, budget_v1: {max_list_usd: 1.5}}, automatic: true, ownerAbsent: true});
    const admitted = await reserve('attempt-inferred');
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(store.originFor('five_hour@1792744800000'), 'owner');
    await adapter.close();
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('the production candidate tells the store a lent attempt is live once one is admitted, so no window is inferred then', {timeout: 30000}, async () => {
  const dir = fresh();
  try {
    const store = originModule.createWindowOriginStore({directory: join(dir, 'origin')});
    const live = [];
    const spy = {...store, observeOpen: (args) => { live.push(args.lentAttemptLive); return store.observeOpen(args); }};
    const {candidate, adapter} = originCandidate(join(dir, 'pace50'), spy);
    const reserve = (attemptId, jobId) => candidate.reserve({attemptId, jobId, provider: 'claude', model: 'claude-haiku-5-5',
      job: {requirements: {limits: {wall_seconds: 240}}, expires_at: null, budget_v1: {max_list_usd: 1.5}}, automatic: true, ownerAbsent: true});
    assert.equal((await reserve('attempt-first', 'job-first')).ok, true);
    assert.equal(live.at(-1), false, 'no lent attempt was live before the first admission');
    await reserve('attempt-second', 'job-second');
    assert.equal(live.at(-1), true, 'the first attempt has not ceased');
    await adapter.close();
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('the origin store names a window instance by the same whole second for any sub-second reset noise', () => {
  const reset = Date.UTC(2026, 9, 27, 23, 20, 0);
  assert.deepEqual([11, 499, 501, 921].map((ms) => originModule.instanceOf('five_hour', reset + ms)),
    Array(4).fill(`five_hour@${reset}`));
});
