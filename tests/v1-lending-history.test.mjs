import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLendingHistory } from '../lib/v1/lending-history.mjs';
import { createLendingLedger } from '../lib/v1/lending-ledger.mjs';
import { wholeWeekReserveBand } from '../lib/v1/lending-objective.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const RESOURCE = 'seven_day';

function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'm1-lending-history-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function makeLedger(entries = []) {
  return {
    entries(filter = {}) {
      return entries.filter(row => Object.entries(filter).every(([key, value]) => row[key] === value));
    },
  };
}

function history(t, { home = makeHome(t), ledger = makeLedger(), now } = {}) {
  return createLendingHistory({ home, account: 'claude', ledger, now: () => now });
}

function meterReading(epoch, day, usedPct, overrides = {}) {
  const start = epoch - WEEK;
  const observedAt = day === 6 ? epoch - HOUR : start + day * DAY + HOUR;
  return {
    window_id: RESOURCE,
    window_minutes: 10080,
    used_pct: usedPct,
    resets_at: epoch,
    observed_at: observedAt,
    state: 'open',
    account_week_epoch: epoch,
    censoring: { complete: true, limit_reached: false, owner_refused: false, owner_deferred: false },
    ...overrides,
  };
}

function recordWeek(store, epoch, valueForDay = day => day + 1, omitDays = [], censoringForDay = () => null) {
  for (let day = 0; day < 7; day++) {
    if (!omitDays.includes(day)) {
      const censoring = censoringForDay(day);
      store.record(meterReading(epoch, day, valueForDay(day), censoring === null ? {} : { censoring }));
    }
  }
}

test('weekly scores use reset epochs, include the start boundary, and exclude the end boundary', t => {
  const firstEpoch = 1_800_000_000_000;
  const secondEpoch = firstEpoch + WEEK;
  const activeEpoch = secondEpoch + WEEK;
  const store = history(t, { now: secondEpoch + 2 * HOUR });
  recordWeek(store, firstEpoch, day => day + 10);
  store.record({
    ...meterReading(secondEpoch, 0, 99),
    observed_at: firstEpoch,
  });
  store.record({
    ...meterReading(activeEpoch, 0, 100),
    observed_at: secondEpoch + HOUR,
  });

  const scores = store.weeklyScores(RESOURCE);
  assert.equal(scores.get(firstEpoch).complete, true);
  assert.equal(scores.get(firstEpoch).score, 16);
  assert.equal(scores.get(secondEpoch).complete, false);
  assert.equal(scores.get(secondEpoch).sampleCount, 1);
  assert.equal(scores.has(activeEpoch), false, 'the active provider week is not returned');
});

test('a reset moved before its advertised epoch censors the old week and keeps the new epoch distinct', t => {
  const oldEpoch = 1_800_000_000_000;
  const movedEpoch = oldEpoch + DAY;
  const store = history(t, { now: oldEpoch + 2 * DAY });
  for (let day = 0; day < 7; day++) {
    const epoch = day < 4 ? oldEpoch : movedEpoch;
    store.record(meterReading(epoch, day, day + 1));
  }

  const scores = store.weeklyScores(RESOURCE);
  assert.equal(scores.get(oldEpoch).complete, false);
  assert.equal(scores.get(oldEpoch).reason, 'reset_moved');
  assert.equal(scores.get(oldEpoch).score, Infinity);
  assert.equal(scores.has(movedEpoch), true);
  assert.equal(scores.get(movedEpoch).score, Infinity);
});

test('a missing observation day remains in history as an infinite score', t => {
  const epoch = 1_800_000_000_000;
  const store = history(t, { now: epoch + 1 });
  recordWeek(store, epoch, day => day + 1, [3]);

  const row = store.weeklyScores(RESOURCE).get(epoch);
  assert.equal(row.complete, false);
  assert.equal(row.reason, 'missing_days');
  assert.equal(row.coveredDays, 6);
  assert.equal(row.score, Infinity);
});

test('reset timestamp jitter within a minute stays in one provider week', t => {
  const epoch = 1_800_000_000_000;
  const store = history(t, { now: epoch + 1 });
  for (let day = 0; day < 7; day++) {
    const jitter = day % 2 ? 30_000 : -20_000;
    store.record(meterReading(epoch + jitter, day, day + 1));
  }
  const scores = store.weeklyScores(RESOURCE);
  assert.equal(scores.size, 1);
  assert.equal(scores.get(epoch - 20_000).complete, true);
  assert.equal(store.completeWeekCount(RESOURCE), 1);
});

test('a wholly unobserved week stays infinite across a moved reset and three-day gap', t => {
  const firstEpoch = 1_800_000_000_000;
  const thirdEpoch = firstEpoch + 2 * WEEK + 3 * DAY;
  const store = history(t, { now: thirdEpoch + 1 });
  recordWeek(store, firstEpoch);
  recordWeek(store, thirdEpoch);

  const scores = store.weeklyScores(RESOURCE);
  const missing = scores.get(firstEpoch + WEEK);
  assert.equal(scores.size, 3, 'the shifted third reset must not create a phantom fourth week');
  assert.equal(scores.has(firstEpoch + 2 * WEEK), false);
  assert.equal(missing.complete, false);
  assert.equal(missing.reason, 'missing_readings');
  assert.equal(missing.score, Infinity);
  assert.equal(missing.source, 'missing');
  assert.equal(store.completeWeekCount(RESOURCE), 2);
});

test('weeks projected after the last reset anchor remain infinite during downtime', t => {
  const firstEpoch = 1_800_000_000_000;
  const store = history(t, { now: firstEpoch + 3 * WEEK + 1 });
  recordWeek(store, firstEpoch);

  const scores = store.weeklyScores(RESOURCE);
  assert.equal(scores.size, 4);
  assert.equal(scores.get(firstEpoch).complete, true);
  for (let weeks = 1; weeks <= 3; weeks++) {
    const row = scores.get(firstEpoch + weeks * WEEK);
    assert.equal(row.complete, false);
    assert.equal(row.score, Infinity);
    assert.equal(row.reason, 'missing_readings');
  }
  assert.equal(store.completeWeekCount(RESOURCE), 1);
});

test('reset anchors preserve missing weeks after old raw samples age out', t => {
  const home = makeHome(t);
  const firstEpoch = 1_800_000_000_000;
  const lastEpoch = firstEpoch + 30 * WEEK;
  const ledger = makeLedger();
  const earlier = createLendingHistory({ home, account: 'claude', ledger, now: () => firstEpoch + 1 });
  recordWeek(earlier, firstEpoch);

  const restarted = createLendingHistory({ home, account: 'claude', ledger, now: () => lastEpoch + 1 });
  recordWeek(restarted, lastEpoch);
  const scores = restarted.weeklyScores(RESOURCE);
  const persisted = JSON.parse(readFileSync(join(home, 'v1', 'lending-history-claude.json'), 'utf8'));

  assert.equal(scores.size, 26);
  assert.equal(scores.get(lastEpoch - WEEK).complete, false);
  assert.equal(scores.get(lastEpoch - WEEK).score, Infinity);
  assert.equal(restarted.completeWeekCount(RESOURCE), 1);
  assert.ok(persisted.readings.every(row => row.weekEpoch === lastEpoch), 'old samples were pruned');
  assert.ok(persisted.weekEpochs.includes(firstEpoch), 'the older reset anchor survived');
});

test('a week without a recent reset-edge reading remains censored', t => {
  const epoch = 1_800_000_000_000;
  const store = history(t, { now: epoch + 1 });
  for (let day = 0; day < 7; day++) {
    const reading = meterReading(epoch, day, day + 1);
    if (day === 6) reading.observed_at = epoch - 23 * HOUR;
    store.record(reading);
  }

  const row = store.weeklyScores(RESOURCE).get(epoch);
  assert.equal(row.coveredDays, 7);
  assert.equal(row.complete, false);
  assert.equal(row.reason, 'missing_week_end');
  assert.equal(row.score, Infinity);
});

test('an expired reset reading cannot make the completed prior week look incomplete or low', t => {
  const epoch = 1_800_000_000_000;
  const store = history(t, { now: epoch + DAY });
  recordWeek(store, epoch, day => day + 1);
  const stale = meterReading(epoch, 0, 100, { observed_at: epoch + HOUR });
  assert.equal(store.record(stale).known, false);

  const scores = store.weeklyScores(RESOURCE);
  assert.equal(scores.get(epoch).complete, true);
  assert.equal(scores.get(epoch).score, 7);
  assert.equal(scores.has(epoch + WEEK), false, 'the inferred next week is still active');
});

test('a short-window weekly score needs coverage near each resource reset', t => {
  const epoch = 1_800_000_000_000;
  const start = epoch - WEEK;
  const store = history(t, { now: epoch + 1 });
  for (let day = 0; day < 7; day++) {
    const observedAt = day === 6 ? epoch - 2 * HOUR : start + day * DAY + HOUR;
    store.record({
      window_id: 'five_hour',
      window_minutes: 300,
      used_pct: day + 1,
      resets_at: observedAt + HOUR,
      observed_at: observedAt,
      state: 'open',
      account_week_epoch: epoch,
      censoring: { complete: true, limit_reached: false, owner_refused: false, owner_deferred: false },
    });
  }

  const row = store.weeklyScores('five_hour').get(epoch);
  assert.equal(row.coveredDays, 7);
  assert.equal(row.complete, false);
  assert.equal(row.reason, 'missing_resource_windows');
  assert.equal(row.score, Infinity);
});

test('restart reloads durable weeks from FARAVAN_HOME', t => {
  const home = makeHome(t);
  const epoch = 1_800_000_000_000;
  const previousHome = process.env.FARAVAN_HOME;
  process.env.FARAVAN_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.FARAVAN_HOME;
    else process.env.FARAVAN_HOME = previousHome;
  });
  const now = () => epoch + 1;
  const first = createLendingHistory({ account: 'claude', ledger: makeLedger(), now });
  recordWeek(first, epoch, day => day + 2);

  const restarted = createLendingHistory({ account: 'claude', ledger: makeLedger(), now });
  const row = restarted.weeklyScores(RESOURCE).get(epoch);
  assert.equal(row.complete, true);
  assert.equal(row.score, 8);
  assert.equal(readFileSync(join(home, 'v1', 'lending-history-claude.json'), 'utf8').length > 0, true);
});

test('history reads attributed ledger entries without rewriting the declared plan', t => {
  const home = makeHome(t);
  const ledgerFile = join(home, 'v1', 'lending-ledger.json');
  const epoch = 1_800_000_000_000;
  const now = () => epoch + 1;
  const ledger = createLendingLedger({ file: ledgerFile, now });
  ledger.snapshot('claude', { plan: 'max20' });

  const store = createLendingHistory({ home, account: 'claude', ledger, now });
  assert.equal(store.record(meterReading(epoch, 0, 7)).known, true);

  const saved = JSON.parse(readFileSync(ledgerFile, 'utf8'));
  assert.equal(saved.accounts.claude.plan, 'max20');
});

test('a corrupt history file is unknown: reads fail for the pace fallback, writes refuse and the bytes survive', t => {
  const home = makeHome(t), file = join(home, 'v1', 'lending-history-claude.json');
  mkdirSync(join(home, 'v1'), { recursive: true });
  const cases = ['{broken', JSON.stringify({ schema_version: 1, account: 'claude', readings: 'x', bootstrap: [], weekEpochs: [] })];
  for (const bytes of cases) {
    writeFileSync(file, bytes);
    const store = history(t, { home, now: 1_900_000_000_000 });
    assert.throws(() => store.weeklyScores(RESOURCE), { code: 'state_unknown' });
    assert.throws(() => store.resources(), { code: 'state_unknown' });
    assert.throws(() => store.record(meterReading(1_800_000_000_000, 0, 7)), { code: 'state_unknown' });
    assert.equal(readFileSync(file, 'utf8'), bytes);
  }
  rmSync(file);
  assert.equal(history(t, { home, now: 1_900_000_000_000 }).weeklyScores(RESOURCE).size, 0, 'a missing file is an empty history');
});

test('owner usage subtracts only exact ledger attribution proven in the aggregate', t => {
  const epoch = 1_800_000_000_000;
  const charge = {
    account: 'claude', window_id: RESOURCE, resets_at: epoch + 30_000,
    started_at: epoch - WEEK + DAY + 2 * HOUR, ended_at: epoch - WEEK + 2 * DAY,
    attribution: 'exact', represented_at: epoch - WEEK + 2 * DAY, lent_pts: 20,
  };
  const store = history(t, { ledger: makeLedger([charge]), now: epoch + 1 });
  recordWeek(store, epoch, day => day < 2 ? 10 + day : 30 + day);

  const row = store.weeklyScores(RESOURCE).get(epoch);
  assert.equal(row.complete, true);
  assert.equal(row.ownerUsagePct, 16);
  assert.equal(row.score, 16);

  const unrepresented = { ...charge };
  delete unrepresented.represented_at;
  const aggregateStore = history(t, { ledger: makeLedger([unrepresented]), now: epoch + 1 });
  recordWeek(aggregateStore, epoch, day => day < 2 ? 10 + day : 30 + day);
  assert.equal(aggregateStore.weeklyScores(RESOURCE).get(epoch).ownerUsagePct, 36,
    'an exact charge without a post-charge aggregate observation is not subtracted');
});

test('null-reset ledger entries are scoped to the current resource window', t => {
  const epoch = 1_800_000_000_000;
  const unrelated = {
    account: 'claude', window_id: RESOURCE, resets_at: null,
    started_at: epoch - 2 * WEEK + 10 * 60_000, ended_at: epoch - 2 * WEEK + 30 * 60_000,
    attribution: 'reset_split', lent_pts: 20, lent_lower_pts: 0,
  };
  const store = history(t, { ledger: makeLedger([unrelated]), now: epoch + 1 });
  recordWeek(store, epoch);
  const unaffected = store.weeklyScores(RESOURCE).get(epoch);
  assert.equal(unaffected.complete, true);
  assert.equal(unaffected.score, 7);

  const overlapping = {
    ...unrelated,
    started_at: epoch - WEEK + 20 * 60_000,
    ended_at: epoch - WEEK + 90 * 60_000,
  };
  const ambiguousStore = history(t, { ledger: makeLedger([overlapping]), now: epoch + 1 });
  recordWeek(ambiguousStore, epoch);
  const ambiguous = ambiguousStore.weeklyScores(RESOURCE).get(epoch);
  assert.equal(ambiguous.complete, false);
  assert.equal(ambiguous.reason, 'ledger_ambiguous');
  assert.equal(ambiguous.score, Infinity);
});

test('an uncertain borrower estimate does not subtract more than its proven lower bound', t => {
  const epoch = 1_800_000_000_000;
  // The estimated upper amount is 20, but the borrower actually used 10; only the
  // aggregate meter (30) and that upper estimate are available without a lower bound.
  const estimate = {
    account: 'claude', window_id: RESOURCE, resets_at: epoch,
    started_at: epoch - WEEK + DAY, ended_at: epoch - WEEK + 2 * DAY,
    attribution: 'overlapped', represented_at: epoch - WEEK + 2 * DAY, lent_pts: 20,
  };
  const store = history(t, { ledger: makeLedger([estimate]), now: epoch + 1 });
  recordWeek(store, epoch, () => 30);
  const row = store.weeklyScores(RESOURCE).get(epoch);
  assert.equal(row.complete, true);
  assert.equal(row.ownerUsagePct, 30, 'the 20 point estimate is not a proven lower bound');

  const boundedEstimate = { ...estimate,
    started_at: epoch - WEEK + 10 * 60_000,
    ended_at: epoch - WEEK + 30 * 60_000,
    represented_at: epoch - WEEK + 40 * 60_000,
    lent_lower_pts: 10,
  };
  const boundedStore = history(t, { ledger: makeLedger([boundedEstimate]), now: epoch + 1 });
  recordWeek(boundedStore, epoch, () => 30);
  assert.equal(boundedStore.weeklyScores(RESOURCE).get(epoch).ownerUsagePct, 20);
});

test('unknown meter evidence and absent censor evidence cannot become a light week', t => {
  const epoch = 1_800_000_000_000;
  const unknownStore = history(t, { now: epoch + 1 });
  recordWeek(unknownStore, epoch, day => day + 1);
  unknownStore.record(meterReading(epoch, 3, 0, { state: 'unknown', observed_at: epoch - WEEK + 3 * DAY + 2 * HOUR }));
  const unknown = unknownStore.weeklyScores(RESOURCE).get(epoch);
  assert.equal(unknown.complete, false);
  assert.equal(unknown.reason, 'meter_unknown');
  assert.equal(unknown.score, Infinity);

  const noEvidenceStore = history(t, { now: epoch + 1 });
  recordWeek(noEvidenceStore, epoch, day => day + 1, [], () => undefined);
  const noEvidence = noEvidenceStore.weeklyScores(RESOURCE).get(epoch);
  assert.equal(noEvidence.complete, false);
  assert.equal(noEvidence.reason, 'demand_evidence_unknown');
  assert.equal(noEvidence.score, Infinity);

  const ambiguousCharge = {
    account: 'claude', window_id: RESOURCE, resets_at: epoch,
    started_at: epoch - WEEK + DAY, ended_at: epoch - WEEK + 2 * DAY,
    attribution: 'unknown', lent_pts: 20,
  };
  const ledgerStore = history(t, { ledger: makeLedger([ambiguousCharge]), now: epoch + 1 });
  recordWeek(ledgerStore, epoch, day => day + 1);
  const ambiguous = ledgerStore.weeklyScores(RESOURCE).get(epoch);
  assert.equal(ambiguous.complete, true, 'aggregate use remains a conservative upper bound');
  assert.equal(ambiguous.score, 7);
});

test('any owner refusal censors all resource cells for the whole account-week', t => {
  const epoch = 1_800_000_000_000;
  const store = history(t, { now: epoch + 1 });
  recordWeek(store, epoch, day => day + 1);
  store.record(meterReading(epoch, 5, 2, {
    window_id: 'five_hour',
    window_minutes: 300,
    resets_at: epoch - 2 * HOUR,
    observed_at: epoch - 3 * HOUR,
    censoring: { complete: true, limit_reached: false, owner_refused: true, owner_deferred: false },
  }));
  const weekly = store.weeklyScores(RESOURCE).get(epoch);
  assert.equal(weekly.complete, false);
  assert.equal(weekly.reason, 'owner_demand_censored');
  assert.equal(weekly.score, Infinity);
  assert.equal(store.completeWeekCount(RESOURCE), 0);
});

test('provider limit and owner deferral also censor the account-week', t => {
  const epoch = 1_800_000_000_000;
  for (const flag of ['limit_reached', 'owner_deferred']) {
    const store = history(t, { now: epoch + 1 });
    recordWeek(store, epoch);
    const censoring = { complete: true, limit_reached: false, owner_refused: false, owner_deferred: false };
    censoring[flag] = true;
    const event = flag === 'limit_reached'
      ? meterReading(epoch, 5, 1, { window_id: 'five_hour', window_minutes: 300,
        observed_at: epoch - 4 * HOUR, resets_at: epoch - 3 * HOUR, censoring })
      : meterReading(epoch, 5, 1, { censoring });
    store.record(event);
    const row = store.weeklyScores(RESOURCE).get(epoch);
    assert.equal(row.complete, false, flag);
    assert.equal(row.score, Infinity, flag);
  }
});

test('owner refusals prevent nineteen low charge-only weeks from becoming calibration scores', t => {
  const firstEpoch = 1_700_000_000_000;
  const lastEpoch = firstEpoch + 18 * WEEK;
  const targetWeekStart = firstEpoch + 19 * WEEK + 1;
  const charges = Array.from({ length: 19 }, (_, week) => {
    const epoch = firstEpoch + week * WEEK;
    return {
      account: 'claude', window_id: RESOURCE, resets_at: epoch,
      started_at: epoch - WEEK + 10 * 60_000, ended_at: epoch - WEEK + 30 * 60_000,
      attribution: 'exact', represented_at: epoch - WEEK + 30 * 60_000, lent_pts: 90, lent_lower_pts: 90,
    };
  });
  const store = history(t, { ledger: makeLedger(charges), now: lastEpoch + 1 });
  for (let week = 0; week < 19; week++) {
    const epoch = firstEpoch + week * WEEK;
    recordWeek(store, epoch, () => 100, [], day => day === 0
      ? { complete: true, limit_reached: false, owner_refused: true, owner_deferred: false }
      : null);
  }
  const rows = [...store.weeklyScores(RESOURCE)];
  assert.equal(rows.length, 19);
  assert.ok(rows.every(([, row]) => row.ownerUsagePct === null && row.score === Infinity && !row.complete));
  assert.equal(store.completeWeekCount(RESOURCE), 0);
  const band = wholeWeekReserveBand({
    position: 'keep_more_for_me', weekStart: targetWeekStart, epoch: 'provider-week-v1',
    procedure: 'owner-usage-v1', domain: [RESOURCE],
    weeks: rows.map(([weekEpoch, row]) => ({ id: 'week-' + weekEpoch, end: weekEpoch,
      epoch: 'provider-week-v1', procedure: 'owner-usage-v1', complete: row.complete,
      upperScores: { [RESOURCE]: row.score } })),
    forecasts: [{ id: RESOURCE, domain: RESOURCE, prediction: 0, scale: 1 }],
  });
  assert.equal(band.rank, 18);
  assert.equal(band.threshold, Infinity);
});

test('weekly scores feed the reference exact epsilon ranks for n=9 and n=19', t => {
  const firstEpoch = 1_700_000_000_000;
  const lastEpoch = firstEpoch + 18 * WEEK;
  const targetWeekStart = firstEpoch + 19 * WEEK + 1;
  const store = history(t, { now: lastEpoch + 1 });
  for (let week = 0; week < 19; week++) {
    recordWeek(store, firstEpoch + week * WEEK, () => week + 1);
  }
  const rows = [...store.weeklyScores(RESOURCE)];
  const band = selected => wholeWeekReserveBand({
    position: 'keep_more_for_me',
    weekStart: targetWeekStart,
    epoch: 'provider-week-v1',
    procedure: 'owner-usage-v1',
    domain: [RESOURCE],
    weeks: selected.map(([epoch, row]) => ({
      id: 'week-' + epoch,
      end: epoch,
      epoch: 'provider-week-v1',
      procedure: 'owner-usage-v1',
      complete: row.complete,
      upperScores: { [RESOURCE]: row.score },
    })),
    forecasts: [{ id: RESOURCE, domain: RESOURCE, prediction: 0, scale: 1 }],
  });

  assert.equal(rows.length, 19);
  assert.equal(band(rows.slice(0, 9)).rank, 9);
  assert.equal(band(rows.slice(0, 9)).threshold, 9);
  assert.equal(band(rows).rank, 18);
  assert.equal(band(rows).threshold, 18);
});

test('session-log bootstrap is explicit and consumes only its supplied fixture adapter', t => {
  const home = makeHome(t);
  const fixturePath = new URL('./fixtures/lending/session-usage.json', import.meta.url);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const store = history(t, { home, now: fixture.weekly_usage[0].epoch + 1 });

  assert.equal(store.weeklyScores(RESOURCE).size, 0);
  assert.equal(store.bootstrapFromSessionLogs({ readWeeklyUsage: () => fixture.weekly_usage }), 1);
  const row = store.weeklyScores(RESOURCE).get(fixture.weekly_usage[0].epoch);
  assert.equal(row.source, 'session_log_bootstrap');
  assert.equal(row.score, 42.5);
  assert.equal(row.complete, true);
  assert.throws(() => store.bootstrapFromSessionLogs({ readWeeklyUsage: () => [{
    resource: RESOURCE, epoch: fixture.weekly_usage[0].epoch, owner_usage_pct: 1, complete: true,
  }] }), /uncensored normalized weekly usage/);
});
