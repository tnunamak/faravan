import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opById } from '../lib/v1/ops/registry.mjs';
import { runOp } from '../lib/v1/ops/execute.mjs';
import { createLendingHistory } from '../lib/v1/lending-history.mjs';
import { buildImportedWeeklyScores, importLendingHistory, mergeWeeklyScores,
  createLocalLendingHistoryAdapter, parseClaudeSessionLog, parseCodexRolloutLog,
  readLocalAgentSessionLogs, readLocalAgentSessionLogsInWorker, importOwnerLendingHistory } from '../lib/v1/lending-history-import.mjs';

const fixture = name => readFileSync(new URL('./fixtures/lending/' + name, import.meta.url), 'utf8');
const iso = value => Date.parse(value);
const emptyTokens = () => ({fresh_input:0, cache_read:0, cache_write_5m:0, cache_write_1h:0, output:0, reasoning:0});
const usage = (at, fresh_input = 1_000_000) => ({account:'claude', provider:'claude', at, model:'claude-haiku-4-5-20251001',
  tokens:{...emptyTokens(), fresh_input}});
const period = (start_at, end_at, meter_points = 1) => ({account:'claude', resource:'claude:seven_day',
  account_week_id:end_at, week_start:start_at, start_at, end_at, meter_points});
const fixtureCalibration = pointsPerUsd => ({upper_micro:Math.round(pointsPerUsd * 1e6),
  provenance:{method:'test bound',boundReport:'fixture report',acceptedBy:'test fixture'}});
const fixtureKappa = pointsPerUsd => () => fixtureCalibration(pointsPerUsd);

test('Claude fixture parses per-message usage once per message id', () => {
  const parsed = parseClaudeSessionLog(fixture('claude-budget-stream.jsonl'), {account:'claude'});
  assert.equal(parsed.malformedLines, 0);
  assert.equal(parsed.usage.length, 4, 'two content-block records per message id count once');
  assert.deepEqual(parsed.usage.reduce((sum, row) => {
    for (const key of Object.keys(sum)) sum[key] += row.tokens[key];
    return sum;
  }, emptyTokens()), {fresh_input:34, cache_read:103485, cache_write_5m:0, cache_write_1h:18583, output:702, reasoning:0});
  assert.ok(parsed.usage.every(row => row.at === null), 'this stream fixture has no per-message timestamps');
});

test('Claude cache writes without a lifetime split use the conservative one-hour price', () => {
  const parsed = parseClaudeSessionLog(JSON.stringify({type:'assistant', timestamp:'2026-10-01T12:00:00Z', message:{id:'cache',
    model:'claude-haiku-4-5-20251001', usage:{input_tokens:1, output_tokens:1, cache_creation_input_tokens:100}}}), {account:'claude'});
  assert.deepEqual([parsed.usage[0].tokens.cache_write_5m, parsed.usage[0].tokens.cache_write_1h], [0, 100]);
});

test('Codex fixture uses per-turn token deltas and ignores duplicate cumulative snapshots', () => {
  const parsed = parseCodexRolloutLog(fixture('codex-rollout.jsonl'), {account:'codex'});
  assert.equal(parsed.malformedLines, 0);
  assert.equal(parsed.usage.length, 2);
  assert.deepEqual(parsed.usage.map(row => [row.model, row.at, row.tokens.fresh_input, row.tokens.cache_read, row.tokens.output]), [
    ['gpt-6-astra', iso('2026-10-20T15:47:02.000Z'), 2000, 8000, 500],
    ['gpt-6-luna', iso('2026-10-20T15:47:04.000Z'), 2000, 18000, 1000],
  ]);
});

test('Codex fixture usage is priced into a quota-point week', () => {
  const parsed = parseCodexRolloutLog(fixture('codex-rollout.jsonl'), {account:'codex'});
  const start = iso('2026-10-20T15:00:00Z');
  const rows = buildImportedWeeklyScores({usage:parsed.usage, meterPeriods:[{
    account:'codex', resource:'codex:10080', account_week_id:iso('2026-10-27T15:00:00Z'), week_start:start,
    start_at:start, end_at:iso('2026-10-27T15:00:00Z'), meter_points:0.000001,
  }], kappaForUsage:fixtureKappa(0.0001), minimumCoverage:0.001}).weeklyScores;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].censored, false);
  assert.ok(Number.isFinite(rows[0].score) && rows[0].score > 0);
});

test('usage buckets by the captured reset interval after a weekly reset moves', () => {
  const rows = buildImportedWeeklyScores({
    usage:[usage(iso('2026-10-07T14:59:59Z')), usage(iso('2026-10-07T15:00:00Z'))],
    meterPeriods:[period(iso('2026-10-01T09:00:00Z'), iso('2026-10-07T15:00:00Z')),
      period(iso('2026-10-07T15:00:00Z'), iso('2026-10-14T15:00:00Z'))],
    kappaForUsage:fixtureKappa(1), minimumCoverage:1,
  }).weeklyScores;
  assert.deepEqual(rows.map(row => [row.account_week_id, row.week_start, row.score, row.censored, row.source, row.coverage_ratio]), [
    [iso('2026-10-07T15:00:00Z'), iso('2026-10-01T09:00:00Z'), 1, false, 'import', 1],
    [iso('2026-10-14T15:00:00Z'), iso('2026-10-07T15:00:00Z'), 1, false, 'import', 1],
  ]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['account_week_id','censored','coverage_ratio','resource','score','source','week_start']);
});

test('Claude usage is scored separately for its five-hour and weekly resources', () => {
  const start = iso('2026-10-01T09:00:00Z'), end = iso('2026-10-08T09:00:00Z');
  const periods = ['claude:five_hour','claude:seven_day'].map(resource => ({...period(start, end), resource}));
  const rows = buildImportedWeeklyScores({usage:[usage(start + 1000)], meterPeriods:periods,
    kappaForUsage:fixtureKappa(1), minimumCoverage:1}).weeklyScores;
  assert.deepEqual(rows.map(row => row.resource), ['claude:five_hour','claude:seven_day']);
  assert.ok(rows.every(row => row.score === 1 && row.source === 'import'));
});

test('five-hour scores use the peak rolling window while weekly scores sum the reset week', () => {
  const start = iso('2026-10-01T09:00:00Z'), end = iso('2026-10-08T09:00:00Z');
  const rows = buildImportedWeeklyScores({usage:[usage(start + 1000), usage(start + 6 * 60 * 60 * 1000)],
    meterPeriods:[{...period(start, end, 1), resource:'claude:five_hour'}, {...period(start, end, 2), resource:'claude:seven_day'}],
    kappaForUsage:fixtureKappa(1), minimumCoverage:0.5}).weeklyScores;
  assert.ok(rows[0].score > 0);
  assert.ok(Math.abs(rows[1].score - 2 * rows[0].score) < 0.00001);
});

test('five-hour scoring handles 30,000 usage rows without quadratic rescanning', () => {
  const start=iso('2026-10-01T09:00:00Z'),end=start+5*60*60*1000;
  const rows=Array.from({length:30_000},(_,index)=>usage(start+index*500));
  const began=performance.now();
  const result=buildImportedWeeklyScores({usage:rows,kappaForUsage:fixtureKappa(1),meterPeriods:[{
    account:'claude',resource:'claude:five_hour',account_week_id:end,week_start:start,start_at:start,end_at:end,meter_points:1,
  }]});
  const elapsed=performance.now()-began;
  assert.ok(elapsed<1000,`30,000 usage rows took ${elapsed.toFixed(1)} ms`);
  assert.equal(result.weeklyScores.length,1);
});

test('the persisted Codex resource prefix bounds its score and censors weak five-hour coverage', () => {
  const start = iso('2026-10-01T09:00:00Z'), end = iso('2026-10-08T09:00:00Z');
  const codexUsage = at => ({account:'codex', provider:'codex', at, model:'gpt-6-astra', tokens:{
    fresh_input:10_000, cache_read:0, cache_write_5m:0, cache_write_1h:0, output:500, reasoning:0,
  }});
  const usageRows = [codexUsage(start + 1000), codexUsage(start + 6 * 60 * 60 * 1000)];
  const common = {kappaForUsage:fixtureKappa(1), minimumCoverage:0.8};
  const single = buildImportedWeeklyScores({...common, usage:[usageRows[0]], meterPeriods:[{
    account:'codex', resource:'codex:10080', account_week_id:end, week_start:start, start_at:start, end_at:end,
    meter_points:1,
  }]}).coverage[0].log_points;
  assert.ok(single > 0);
  const persistedResource = buildImportedWeeklyScores({...common, usage:usageRows, meterPeriods:[{
    account:'codex', resource:'codex:codex:300', account_week_id:end, week_start:start, start_at:start, end_at:end,
    meter_points:single * 1.5,
  }]});
  assert.equal(persistedResource.coverage[0].log_points, single);
  assert.ok(Math.abs(persistedResource.coverage[0].coverage_ratio - 2 / 3) < 1e-12);
  assert.equal(persistedResource.weeklyScores[0].score, Infinity);
  assert.equal(persistedResource.weeklyScores[0].censored, true);
});

for (const bucketResource of ['codex:alpha:300', 'codex:codex:alpha:300', 'codex:beta:300']) test(`bucketed ${bucketResource} bounds its score and censors weak five-hour coverage`, () => {
  const start = iso('2026-10-01T09:00:00Z'), end = iso('2026-10-08T09:00:00Z');
  const codexUsage = at => ({account:'codex', provider:'codex', at, model:'gpt-6-astra', tokens:{
    fresh_input:10_000, cache_read:0, cache_write_5m:0, cache_write_1h:0, output:500, reasoning:0,
  }});
  const usageRows = [codexUsage(start + 1000), codexUsage(start + 6 * 60 * 60 * 1000)];
  const common = {kappaForUsage:fixtureKappa(1), minimumCoverage:0.8};
  const single = buildImportedWeeklyScores({...common, usage:[usageRows[0]], meterPeriods:[{
    account:'codex', resource:'codex:10080', account_week_id:end, week_start:start, start_at:start, end_at:end,
    meter_points:1,
  }]}).coverage[0].log_points;
  assert.ok(single > 0);
  const persistedResource = buildImportedWeeklyScores({...common, usage:usageRows, meterPeriods:[{
    account:'codex', resource:bucketResource, account_week_id:end, week_start:start, start_at:start, end_at:end,
    meter_points:single * 1.5,
  }]});
  assert.equal(persistedResource.weeklyScores[0].resource, bucketResource);
  assert.equal(persistedResource.coverage[0].log_points, single);
  assert.ok(Math.abs(persistedResource.coverage[0].coverage_ratio - 2 / 3) < 1e-12);
  assert.equal(persistedResource.weeklyScores[0].score, Infinity);
  assert.equal(persistedResource.weeklyScores[0].censored, true);
});

test('coverage below the stated bound makes the imported weekly score unknown', () => {
  const {weeklyScores, coverage} = buildImportedWeeklyScores({
    usage:[usage(iso('2026-10-02T12:00:00Z'))],
    meterPeriods:[period(iso('2026-10-01T12:00:00Z'), iso('2026-10-08T12:00:00Z'), 10)],
    kappaForUsage:fixtureKappa(1), minimumCoverage:0.8,
  });
  assert.equal(weeklyScores[0].score, Infinity);
  assert.equal(weeklyScores[0].censored, true);
  assert.equal(weeklyScores[0].coverage_ratio, 0.1);
  assert.equal(coverage[0].coverage_ratio, 0.1);
});

test('an estimate above the history score range is censored instead of rejected at write time', () => {
  const rows = buildImportedWeeklyScores({usage:[usage(iso('2026-10-02T12:00:00Z'))],
    meterPeriods:[period(iso('2026-10-01T12:00:00Z'), iso('2026-10-08T12:00:00Z'), 0.01)],
    kappaForUsage:fixtureKappa(1000), minimumCoverage:0.5}).weeklyScores;
  assert.equal(rows[0].censored, true);
  assert.equal(rows[0].score, Infinity);
});

test('an unobserved meter interval is censored instead of treated as light', () => {
  const {weeklyScores} = buildImportedWeeklyScores({
    usage:[usage(iso('2026-10-02T12:00:00Z'))],
    meterPeriods:[period(iso('2026-10-01T12:00:00Z'), iso('2026-10-08T12:00:00Z'), null)],
    kappaForUsage:fixtureKappa(1), minimumCoverage:0.8,
  });
  assert.equal(weeklyScores[0].score, Infinity);
  assert.equal(weeklyScores[0].censored, true);
  assert.equal(weeklyScores[0].coverage_ratio, null);
});

test('history with no certified per-model, per-window bound is censored', () => {
  const {weeklyScores, coverage} = buildImportedWeeklyScores({
    usage:[usage(iso('2026-10-02T12:00:00Z'))],
    meterPeriods:[period(iso('2026-10-01T12:00:00Z'), iso('2026-10-08T12:00:00Z'), 1)],
    minimumCoverage:0.1,
  });
  assert.equal(weeklyScores[0].score, Infinity);
  assert.equal(weeklyScores[0].censored, true);
  assert.equal(coverage[0].coverage_ratio, null);
});

test('an imported week never replaces a meter-derived week with the same key', () => {
  const weekStart = iso('2026-10-01T12:00:00Z');
  const meter = {resource:'claude:seven_day', account_week_id:weekStart + 7 * 24 * 60 * 60 * 1000, week_start:weekStart,
    score:6, censored:false, source:'meter', coverage_ratio:1};
  const imported = { ...meter, score:1, source:'import' };
  const olderImport = {...imported, score:3};
  const next = mergeWeeklyScores([olderImport, meter], [imported]);
  assert.deepEqual(next, [meter]);
});

test('malformed JSONL lines are skipped and counted', () => {
  const contents = [
    '{not json',
    JSON.stringify({type:'assistant', timestamp:'2026-10-01T12:00:00Z', message:{id:'bad', model:'claude-haiku-4-5-20251001', usage:{input_tokens:null, output_tokens:2}}}),
    JSON.stringify({type:'assistant', timestamp:'2026-10-01T12:00:00Z', message:{id:'ok', model:'claude-haiku-4-5-20251001', usage:{input_tokens:1, output_tokens:2}}}),
  ].join('\n');
  const parsed = parseClaudeSessionLog(contents, {account:'claude'});
  assert.equal(parsed.usage.length, 1);
  assert.equal(parsed.malformedLines, 2);
  const imported = importLendingHistory({consent:true, loadSessionLogs:() => [{provider:'claude', account:'claude', contents}],
    meterPeriods:[period(iso('2026-10-01T12:00:00Z'), iso('2026-10-08T12:00:00Z'), 10)],
    kappaForUsage:fixtureKappa(1), minimumCoverage:0.1});
  assert.equal(imported.malformedLines, 2);
  assert.equal(imported.weeklyScores[0].score, Infinity);
  assert.equal(imported.weeklyScores[0].censored, true);
});

test('malformed log markers use the same normalized default account as parsed usage', () => {
  const contents = [
    '{not json',
    JSON.stringify({type:'assistant', timestamp:'2026-10-02T12:00:00Z', message:{id:'large-valid-message',
      model:'claude-haiku-4-5-20251001', usage:{input_tokens:100_000, output_tokens:0}}}),
  ].join('\n');
  const imported = importLendingHistory({consent:true,
    loadSessionLogs:() => [{provider:'claude', contents}],
    meterPeriods:[period(iso('2026-10-01T12:00:00Z'), iso('2026-10-08T12:00:00Z'), 0.01)],
    kappaForUsage:fixtureKappa(1), minimumCoverage:1});
  assert.equal(imported.malformedLines, 1);
  assert.equal(imported.weeklyScores[0].score, Infinity);
  assert.equal(imported.weeklyScores[0].censored, true);
});

test('malformed Codex log markers use the provider-default account as parsed usage does', () => {
  const start = iso('2026-10-20T15:00:00Z'), end = iso('2026-10-27T15:00:00Z');
  const imported = importLendingHistory({consent:true,
    loadSessionLogs:() => [{provider:'codex', contents:'{not json\n' + fixture('codex-rollout.jsonl')}],
    meterPeriods:[{account:'codex', resource:'codex:10080', account_week_id:end, week_start:start,
      start_at:start, end_at:end, meter_points:0.01}],
    kappaForUsage:fixtureKappa(1), minimumCoverage:0.5});
  assert.equal(imported.malformedLines, 1);
  assert.equal(imported.weeklyScores[0].score, Infinity);
  assert.equal(imported.weeklyScores[0].censored, true);
});

test('imports retain timestamped per-session usage alongside weekly scores', () => {
  const start = iso('2026-10-01T12:00:00Z'), end = iso('2026-10-08T12:00:00Z');
  const log = (at, id) => JSON.stringify({type:'assistant', timestamp:new Date(at).toISOString(), message:{id,
    model:'claude-haiku-4-5-20251001', usage:{input_tokens:100_000, output_tokens:0}}});
  const imported = importLendingHistory({consent:true, loadSessionLogs:() => [
    {provider:'claude', contents:log(start + 60_000, 'session-a')},
    {provider:'claude', contents:log(start + 2 * 60 * 60 * 1000, 'session-b')},
  ], meterPeriods:[period(start, end, 0.1)], kappaForUsage:fixtureKappa(1), minimumCoverage:0.5});
  assert.equal(imported.weeklyScores[0].censored, false);
  assert.deepEqual(imported.usageSamples.map(row => [row.at, row.resource, row.account_week_id]), [
    [start + 60_000, 'claude:seven_day', end],
    [start + 2 * 60 * 60 * 1000, 'claude:seven_day', end],
  ]);
  assert.equal(new Set(imported.usageSamples.map(row => row.session_id)).size, 2);
  assert.ok(imported.usageSamples.every(row => /^session-[a-f0-9]{64}$/.test(row.session_id)));
  assert.ok(imported.usageSamples.every(row => Number.isFinite(row.points) && row.points > 0));
});

test('history imports report sessions that lack reset anchors without inventing account weeks', () => {
  const contents = JSON.stringify({type:'assistant', timestamp:'2026-10-02T12:00:00Z', message:{id:'unanchored',
    model:'claude-haiku-4-5-20251001', usage:{input_tokens:1000, output_tokens:0}}});
  const imported = importLendingHistory({consent:true, loadSessionLogs:() => [{provider:'claude', contents}],
    meterPeriods:[], kappaForUsage:fixtureKappa(1), minimumCoverage:0.9});
  assert.deepEqual(imported.weeklyScores, []);
  assert.equal(imported.unmapped_sessions, 1);
});

test('local discovery reads only the supplied Claude project and Codex rollout fixture trees', () => {
  const home = mkdtempSync(join(tmpdir(), 'lending-history-import-fixtures-'));
  try {
    const claude = join(home, '.claude', 'projects', 'fixture-project');
    const codex = join(home, '.codex', 'sessions', 'fixture-session');
    mkdirSync(claude, {recursive:true}); mkdirSync(codex, {recursive:true});
    writeFileSync(join(claude, 'session.jsonl'), fixture('claude-budget-stream.jsonl'));
    writeFileSync(join(codex, 'rollout-fixture.jsonl'), fixture('codex-rollout.jsonl'));
    writeFileSync(join(codex, 'not-a-rollout.jsonl'), 'must not be read');
    const logs = [...readLocalAgentSessionLogs(home)];
    assert.deepEqual(logs.map(row => [row.provider, row.account]), [['claude', 'claude'], ['codex', 'codex']]);
    assert.deepEqual(logs.map(row => row.contents), [fixture('claude-budget-stream.jsonl'), fixture('codex-rollout.jsonl')]);
  } finally { rmSync(home, {recursive:true, force:true}); }
});

test('history import refuses to read or process anything without explicit consent', () => {
  let loaded = false;
  assert.throws(() => importLendingHistory({consent:false, loadSessionLogs:() => { loaded = true; return []; }}), {code:'consent_required'});
  assert.equal(loaded, false);
});

test('the ops registry exposes local history import as a confirmed operation', () => {
  const op = opById('lending.history.import');
  assert.ok(op);
  assert.equal(op.safety, 'consequential');
  assert.equal(typeof op.confirm, 'function');
  assert.equal(Object.hasOwn(op.input.properties, 'kappa_points_per_usd'), false,
    'only shipped calibration data may price imported usage');
});

test('the history import op asks for confirmation before calling its local adapter', async () => {
  let adapterCalled = false;
  await assert.rejects(runOp('lending.history.import', {}, {
    confirmed:false, historyAdapter:() => { adapterCalled = true; },
  }), {code:'confirmation_required'});
  assert.equal(adapterCalled, false);
});

test('the confirmed ops path reads fixtures and writes only mapped scores through the local adapter', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lending-history-import-op-fixtures-'));
  try {
    const claude = join(home, '.claude', 'projects', 'fixture-project');
    const codex = join(home, '.codex', 'sessions', 'fixture-session');
    mkdirSync(claude, {recursive:true}); mkdirSync(codex, {recursive:true});
    writeFileSync(join(claude, 'session.jsonl'), fixture('claude-budget-stream.jsonl'));
    writeFileSync(join(codex, 'rollout-fixture.jsonl'), fixture('codex-rollout.jsonl'));
    const codexStart = iso('2026-10-20T15:00:00Z');
    const meter = {resource:'codex:10080', account_week_id:iso('2026-10-27T15:00:00Z'), week_start:codexStart,
      score:6, censored:false, source:'meter', coverage_ratio:1};
    let persisted;
    const output = await runOp('lending.history.import', {}, {
      confirmed:true, home:join(home, 'faravan-state'), sessionHomeDir:home,
      kappaForUsage:fixtureKappa(1),
      historyAdapter:async ({homeDir, sessionHomeDir}) => {
        assert.equal(homeDir, join(home, 'faravan-state'));
        assert.equal(sessionHomeDir, home);
        return {meterPeriods:[
          {account:'claude', resource:'claude:seven_day', account_week_id:iso('2026-10-27T15:00:00Z'),
            week_start:iso('2026-10-20T15:00:00Z'), start_at:iso('2026-10-20T15:00:00Z'), end_at:iso('2026-10-27T15:00:00Z'), meter_points:1},
          {account:'codex', resource:'codex:10080', account_week_id:iso('2026-10-27T15:00:00Z'), week_start:codexStart,
            start_at:codexStart, end_at:iso('2026-10-27T15:00:00Z'), meter_points:1},
        ], existingScores:[meter], writeImportedScores:rows => { persisted=rows; }};
      },
    });
    assert.deepEqual([output.imported_weeks, output.censored_weeks, output.malformed_lines], [1, 1, 0]);
    assert.equal(output.coverage.length, 2);
    assert.ok(output.coverage.every(row => Object.keys(row).sort().join(',') === 'account_week_id,coverage_ratio,resource,week_start'));
    assert.ok(output.coverage.some(row => row.resource === 'claude:seven_day' && row.coverage_ratio === null));
    assert.deepEqual(persisted.map(row => [row.resource, row.account_week_id, row.censored, row.source]), [
      ['claude:seven_day', iso('2026-10-27T15:00:00Z'), true, 'import'],
    ]);
  } finally { rmSync(home, {recursive:true, force:true}); }
});

test('confirmed ops write imported censor rows through the persisted history API', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lending-history-import-store-fixtures-'));
  try {
    const sessionHome = join(home, 'session-home');
    const claude = join(sessionHome, '.claude', 'projects', 'fixture-project');
    mkdirSync(claude, {recursive:true});
    const now = Date.now(), week = 7 * 24 * 60 * 60 * 1000;
    const anchor = Math.floor((now - 3 * week) / week) * week;
    const logAt = new Date(anchor + week / 2).toISOString();
    writeFileSync(join(claude, 'session.jsonl'), JSON.stringify({type:'assistant', timestamp:logAt,
      message:{id:'fixture-message', model:'claude-haiku-4-5-20251001', usage:{input_tokens:1000, output_tokens:50}}}));
    const stateHome = join(home, 'faravan-state');
    const initial = createLendingHistory({home:stateHome, account:'claude', ledger:{entries:() => []}});
    initial.record({window_id:'seven_day', window_minutes:10080, used_pct:5, resets_at:anchor,
      observed_at:anchor - 60 * 60 * 1000, account_week_epoch:anchor, state:'open',
      censoring:{complete:true, limit_reached:false, owner_refused:false, owner_deferred:false}});

    const output = await runOp('lending.history.import', {}, {
      confirmed:true, home:stateHome, sessionHomeDir:sessionHome,
    });
    assert.ok(output.imported_weeks > 0);
    assert.equal(output.censored_weeks, output.imported_weeks);
    assert.ok(output.coverage.some(row => row.coverage_ratio === null));
    const saved = createLendingHistory({home:stateHome, account:'claude', ledger:{entries:() => []}}).weeklyScores('seven_day');
    assert.equal(saved.get(anchor).source, 'meter');
    assert.equal(saved.get(anchor).sampleCount, 1);
    assert.equal(saved.get(anchor + week).source, 'import');
    assert.equal(saved.get(anchor + week).score, Infinity);
    assert.equal(saved.get(anchor + week).coverage_ratio, null);
  } finally { rmSync(home, {recursive:true, force:true}); }
});

test('the lending-history adapter preserves a moved reset week start', () => {
  const home = mkdtempSync(join(tmpdir(), 'lending-history-import-moved-reset-'));
  try {
    const history = createLendingHistory({home, account:'claude', ledger:{entries:() => []}});
    const weekStart = iso('2026-10-01T09:00:00Z'), accountWeekId = iso('2026-10-07T15:00:00Z');
    assert.equal(history.bootstrapFromSessionLogs({readWeeklyUsage:() => [{resource:'seven_day', account_week_id:accountWeekId,
      week_start:weekStart, score:3, censored:false, source:'import', coverage_ratio:1}]}), 1);
    const row = history.weeklyScores('seven_day').get(accountWeekId);
    assert.equal(row.start, weekStart);
    assert.equal(row.score, 3);
    assert.equal(row.source, 'import');
    assert.equal(row.coverage_ratio, 1);
  } finally { rmSync(home, {recursive:true, force:true}); }
});

test('the local adapter maps and persists imported per-session usage separately from its weekly score', () => {
  const home = mkdtempSync(join(tmpdir(), 'lending-history-import-samples-'));
  try {
    const now = iso('2026-10-20T00:00:00Z');
    const adapter = createLocalLendingHistoryAdapter({homeDir:home, now:() => now});
    const weekStart = iso('2026-10-01T12:00:00Z'), accountWeekId = iso('2026-10-08T12:00:00Z');
    const contents = JSON.stringify({type:'assistant', timestamp:new Date(weekStart + 60_000).toISOString(),
      message:{id:'persisted-session', model:'claude-haiku-4-5-20251001', usage:{input_tokens:100_000, output_tokens:0}}});
    const imported = importLendingHistory({consent:true, loadSessionLogs:() => [{provider:'claude', contents}],
      meterPeriods:[period(weekStart, accountWeekId, 0.1)], kappaForUsage:fixtureKappa(1), minimumCoverage:0.5});
    assert.equal(imported.importedWeeklyScores[0].censored, false);
    assert.equal(imported.usageSamples.length, 1);
    adapter.writeImportedScores(imported.importedWeeklyScores, imported.usageSamples);
    const history = createLendingHistory({home, account:'claude', ledger:{entries:() => []}, now:() => now});
    const sample = imported.usageSamples[0];
    const {resource:_contractResource, ...sampleFields} = sample;
    assert.deepEqual(history.usageSamples('seven_day'), [{...sampleFields, resource:'seven_day',
      coverage_ratio:imported.importedWeeklyScores[0].coverage_ratio, source:'import'}]);
    assert.equal(history.weeklyScores('seven_day').get(accountWeekId).score, imported.importedWeeklyScores[0].score);
  } finally { rmSync(home, {recursive:true, force:true}); }
});

test('complete meter weeks keep imported samples through write and reopen', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lending-history-import-meter-samples-'));
  try {
    const sessionHome = join(home, 'session-home');
    const claude = join(sessionHome, '.claude', 'projects', 'fixture-project');
    mkdirSync(claude, {recursive:true});
    const stateHome = join(home, 'faravan-state');
    const now = iso('2026-10-20T12:00:00Z');
    const day = 24 * 60 * 60 * 1000, week = 7 * day, hour = 60 * 60 * 1000;
    const epoch = iso('2026-10-19T12:00:00Z'), start = epoch - week;
    const initial = createLendingHistory({home:stateHome, account:'claude', ledger:{entries:() => []}, now:() => now});
    for (let index = 0; index < 7; index++) {
      initial.record({window_id:'seven_day', window_minutes:10080, used_pct:index + 10, resets_at:epoch,
        observed_at:index === 6 ? epoch - hour : start + index * day + hour, account_week_epoch:epoch,
        state:'open', censoring:{complete:true, limit_reached:false, owner_refused:false, owner_deferred:false}});
    }
    const logAt = new Date(start + 3 * day + hour).toISOString();
    writeFileSync(join(claude, 'session.jsonl'), JSON.stringify({type:'assistant', timestamp:logAt,
      message:{id:'meter-backed-session', model:'claude-haiku-4-5-20251001', usage:{input_tokens:1_000_000, output_tokens:0}}}));

    const output = await importOwnerLendingHistory({consent:true, homeDir:stateHome, sessionHomeDir:sessionHome,
      kappaForUsage:fixtureKappa(1), minimumCoverage:0.01});
    const reopened = createLendingHistory({home:stateHome, account:'claude', ledger:{entries:() => []}, now:() => now});
    const score = reopened.weeklyScores('seven_day').get(epoch);
    const samples = reopened.usageSamples('seven_day');
    assert.equal(score.source, 'meter');
    assert.equal(score.score, 16);
    assert.equal(output.usage_samples, 1);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].at, Date.parse(logAt));
    assert.ok(samples[0].points > 0);
  } finally { rmSync(home, {recursive:true, force:true}); }
});

test('session ids stay stable per source and distinct across sources when import order changes', () => {
  const start = iso('2026-10-01T09:00:00Z'), end = iso('2026-10-08T09:00:00Z');
  const timestamp = new Date(start + 60_000).toISOString();
  const logs = [
    {source:'/fixture/claude-a.jsonl', provider:'claude', contents:JSON.stringify({type:'assistant', timestamp,
      message:{id:'a', model:'claude-haiku-4-5-20251001', usage:{input_tokens:1_000_000, output_tokens:0}}})},
    {source:'/fixture/claude-b.jsonl', provider:'claude', contents:JSON.stringify({type:'assistant', timestamp,
      message:{id:'b', model:'claude-sonnet-4-5-20250929', usage:{input_tokens:1_000_000, output_tokens:0}}})},
  ];
  const importLogs = orderedLogs => importLendingHistory({consent:true, loadSessionLogs:() => orderedLogs,
    meterPeriods:[period(start, end, 1)], kappaForUsage:fixtureKappa(1), minimumCoverage:0.5});
  const first = new Map(importLogs(logs).usageSamples.map(sample => [sample.model, sample.session_id]));
  const reordered = new Map(importLogs(logs.slice().reverse()).usageSamples.map(sample => [sample.model, sample.session_id]));
  assert.equal(first.size, 2);
  assert.equal(new Set(first.values()).size, 2);
  assert.deepEqual(reordered, first);
  assert.ok([...first.values()].every(id => /^session-[a-f0-9]{64}$/.test(id)));
});

test('same-timestamp messages retain distinct identity and repeated imports deduplicate', () => {
  const home = mkdtempSync(join(tmpdir(), 'lending-history-import-message-id-'));
  try {
    const start = iso('2026-10-01T12:00:00Z'), end = iso('2026-10-08T12:00:00Z');
    const timestamp = new Date(start + 60_000).toISOString();
    const message = (id, tokens) => JSON.stringify({type:'assistant', timestamp,
      message:{id, model:'claude-haiku-4-5-20251001', usage:{input_tokens:tokens, output_tokens:0}}});
    const logs = [{provider:'claude', source:'/fixture/same-time.jsonl', contents:
      `${message('message-100k', 100_000)}\n${message('message-200k', 200_000)}`}];
    const meterPeriods = [period(start, end, 0.25)];
    const options = {consent:true, loadSessionLogs:() => logs, meterPeriods, kappaForUsage:fixtureKappa(1), minimumCoverage:0.5};
    const imported = importLendingHistory(options);
    assert.equal(imported.usageSamples.length, 2);
    assert.deepEqual(imported.usageSamples.map(sample => sample.message_id), ['message-100k', 'message-200k']);
    const adapter = createLocalLendingHistoryAdapter({homeDir:home, now:() => iso('2026-10-20T00:00:00Z')});
    adapter.writeImportedScores(imported.importedWeeklyScores, imported.usageSamples, imported.usageSampleWeeks);
    const history = createLendingHistory({home, account:'claude', ledger:{entries:() => []}, now:() => iso('2026-10-20T00:00:00Z')});
    assert.deepEqual(history.usageSamples('seven_day').map(sample => [sample.message_id, sample.points]),
      imported.usageSamples.map(sample => [sample.message_id, sample.points]));

    const repeated = importLendingHistory(options);
    adapter.writeImportedScores(repeated.importedWeeklyScores, repeated.usageSamples, repeated.usageSampleWeeks);
    assert.equal(history.usageSamples('seven_day').length, 2);
  } finally { rmSync(home, {recursive:true, force:true}); }
});

test('a censored re-import invalidates old samples for that week', () => {
  const home = mkdtempSync(join(tmpdir(), 'lending-history-import-censored-reimport-'));
  try {
    const start = iso('2026-10-01T12:00:00Z'), end = iso('2026-10-08T12:00:00Z');
    const contents = JSON.stringify({type:'assistant', timestamp:new Date(start + 60_000).toISOString(),
      message:{id:'reimport-message', model:'claude-haiku-4-5-20251001', usage:{input_tokens:1_000_000, output_tokens:0}}});
    const logs = [{provider:'claude', source:'/fixture/reimport.jsonl', contents}];
    const adapter = createLocalLendingHistoryAdapter({homeDir:home, now:() => iso('2026-10-20T00:00:00Z')});
    const initial = importLendingHistory({consent:true, loadSessionLogs:() => logs, meterPeriods:[period(start, end, 1)],
      kappaForUsage:fixtureKappa(1), minimumCoverage:0.5});
    assert.equal(initial.usageSamples.length, 1);
    adapter.writeImportedScores(initial.importedWeeklyScores, initial.usageSamples, initial.usageSampleWeeks);
    assert.equal(createLendingHistory({home, account:'claude', ledger:{entries:() => []}, now:() => iso('2026-10-20T00:00:00Z')})
      .usageSamples('seven_day').length, 1);

    const censored = importLendingHistory({consent:true, loadSessionLogs:() => logs, meterPeriods:[period(start, end, 100)],
      existingScores:initial.weeklyScores, kappaForUsage:fixtureKappa(1), minimumCoverage:0.5});
    assert.equal(censored.weeklyScores[0].score, Infinity);
    assert.equal(censored.usageSamples.length, 0);
    adapter.writeImportedScores(censored.importedWeeklyScores, censored.usageSamples, censored.usageSampleWeeks);
    const reopened = createLendingHistory({home, account:'claude', ledger:{entries:() => []}, now:() => iso('2026-10-20T00:00:00Z')});
    assert.equal(reopened.weeklyScores('seven_day').get(end).score, Infinity);
    assert.deepEqual(reopened.usageSamples('seven_day'), []);
  } finally { rmSync(home, {recursive:true, force:true}); }
});

test('fresh bootstrap rows retain their nested imported samples', () => {
  const home = mkdtempSync(join(tmpdir(), 'lending-history-import-nested-samples-'));
  try {
    const weekStart = iso('2026-10-01T12:00:00Z'), accountWeekId = iso('2026-10-08T12:00:00Z');
    const sample = (message_id, points) => ({session_id:'session-fixture', message_id,
      at:weekStart + 60_000, points, model:'claude-haiku-4-5-20251001'});
    const row = {resource:'seven_day', account_week_id:accountWeekId, week_start:weekStart,
      score:3, censored:false, source:'import', coverage_ratio:1,
      usage_samples:[sample('message-a', 0.1), sample('message-b', 0.2)]};
    const history = createLendingHistory({home, account:'claude', ledger:{entries:() => []},
      now:() => iso('2026-10-20T00:00:00Z')});

    assert.equal(history.bootstrapFromSessionLogs({readWeeklyUsage:() => [row]}), 1);
    assert.deepEqual(history.usageSamples('seven_day').map(sample => sample.message_id), ['message-a', 'message-b']);
  } finally { rmSync(home, {recursive:true, force:true}); }
});

test('Codex token counts with distinct message ids survive same-time deduplication', () => {
  const timestamp = '2026-10-20T15:47:02.000Z';
  const record = id => JSON.stringify({timestamp, type:'event_msg', payload:{id, model:'gpt-6-astra', type:'token_count', info:{
    last_token_usage:{input_tokens:100_000, cached_input_tokens:80_000, output_tokens:500, reasoning_output_tokens:200},
  }}});
  const parsed = parseCodexRolloutLog(`${record('a')}\n${record('b')}`);

  assert.equal(parsed.malformedLines, 0);
  assert.equal(parsed.usage.length, 2);
  assert.deepEqual(parsed.usage.map(row => row.message_id), ['a', 'b']);
});

test('a Codex step whose cached tokens grew more than its input is rejected, not priced negative', () => {
  const row = (at, total) => JSON.stringify({timestamp:at, type:'event_msg', payload:{type:'token_count', model:'gpt-5', info:{total_token_usage:total}}});
  const parsed = parseCodexRolloutLog([
    row('2026-10-20T00:00:00Z', {input_tokens:100, cached_input_tokens:50, output_tokens:10, reasoning_output_tokens:0}),
    row('2026-10-20T00:01:00Z', {input_tokens:110, cached_input_tokens:70, output_tokens:20, reasoning_output_tokens:0}),
    row('2026-10-20T00:02:00Z', {input_tokens:130, cached_input_tokens:75, output_tokens:30, reasoning_output_tokens:5}),
  ].join('\n'), {account:'codex'});
  assert.equal(parsed.malformedLines, 1);
  assert.deepEqual(parsed.usage.map(u => u.tokens.fresh_input), [50, 15]);
  assert.ok(parsed.usage.every(u => Object.values(u.tokens).every(n => n >= 0)));
});

test('open-window calibration scores retained past weeks and preserves its assumption provenance', () => {
  const end = iso('2026-10-26T00:00:00Z'), week = 7*24*60*60*1000;
  const rows = [usage(end-week+1000), usage(end+1000)];
  const result = buildImportedWeeklyScores({usage:rows, kappaForUsage:fixtureKappa(1), currentWindows:[{
    account:'claude', resource:'claude:seven_day', account_week_id:end+week,
    start_at:end, end_at:end+week, observed_at:end+2000, meter_points:1,
  }]});
  assert.equal(result.weeklyScores.length, 1);
  assert.equal(result.weeklyScores[0].source, 'import-open-window');
  assert.equal(result.weeklyScores[0].censored, false);
  assert.equal(result.weeklyScores[0].coverage_ratio, 1);
  assert.equal(result.weeklyScores[0].calibration_window.start_at, end);
});

test('weak open coverage censors past usage; absent current reading cannot manufacture weeks', () => {
  const end = iso('2026-10-26T00:00:00Z'), week = 7*24*60*60*1000;
  const rows = [usage(end-week+1000), usage(end+1000)];
  const options = {usage:rows, kappaForUsage:fixtureKappa(1)};
  assert.equal(buildImportedWeeklyScores(options).weeklyScores.length, 0);
  const result = buildImportedWeeklyScores({...options,currentWindows:[{
    account:'claude', resource:'claude:seven_day', account_week_id:end+week,
    start_at:end, end_at:end+week, observed_at:end+2000, meter_points:10,
  }]});
  assert.equal(result.weeklyScores[0].censored, true);
  assert.equal(result.weeklyScores[0].score, Infinity);
});

test('missing intermediate log week remains censored under good current coverage', () => {
  const end = iso('2026-10-26T00:00:00Z'), week = 7*24*60*60*1000;
  const result = buildImportedWeeklyScores({usage:[usage(end-2*week+1000),usage(end+1000)],
    kappaForUsage:fixtureKappa(1), currentWindows:[{account:'claude',resource:'claude:seven_day',
      account_week_id:end+week,start_at:end,end_at:end+week,observed_at:end+2000,meter_points:1}]});
  assert.equal(result.weeklyScores.find(row=>row.account_week_id===end).score, Infinity);
});

test('disabled durable learning switch prevents even adapter and log access in a synthetic home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'history-learning-off-'));
  try {
    mkdirSync(join(home,'v1'),{recursive:true});
    writeFileSync(join(home,'v1','app-settings.json'), JSON.stringify({learnFromLocalAgentLogs:false}));
    const result = await importOwnerLendingHistory({consent:true, homeDir:home, sessionHomeDir:home,
      historyAdapter:()=>{throw new Error('disabled importer must not access adapter');}});
    assert.equal(result.skipped,true);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('disabling while adapter is pending fences reads and writes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'history-learning-race-'));
  let enabled = true, release, writes = 0;
  try {
    const pending = importOwnerLendingHistory({consent:true,homeDir:home,sessionHomeDir:home,
      shouldContinue:()=>enabled, historyAdapter:()=>new Promise(resolve=>{release=resolve;})});
    enabled = false;
    release({meterPeriods:[],existingScores:[],writeImportedScores:()=>writes++});
    assert.equal((await pending).skipped,true);
    assert.equal(writes,0);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('deleting imports preserves meter records and is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'history-learning-delete-'));
  const end = iso('2026-10-20T00:00:00Z'), week = 7*24*60*60*1000;
  try {
    const history = createLendingHistory({home, account:'claude', ledger:{entries:()=>[]},now:()=>end+1000});
    history.bootstrapFromSessionLogs({readWeeklyUsage:()=>[{resource:'seven_day',account_week_id:end,
      week_start:end-week,score:1,censored:false,source:'import-open-window',coverage_ratio:1,
      calibration_window:{start_at:end,end_at:end+week,observed_at:end+500,meter_points:1}}]});
    history.record({window_id:'seven_day',observed_at:end+100,window_minutes:10080,resets_at:end+week,state:'unknown'});
    const file = join(home,'v1','lending-history-claude.json');
    const before = JSON.parse(readFileSync(file,'utf8'));
    history.deleteImportedHistory(); history.deleteImportedHistory();
    const after = JSON.parse(readFileSync(file,'utf8'));
    assert.equal(before.readings.length,1);
    assert.deepEqual(after.readings,before.readings);
    assert.deepEqual(after.weekEpochs,before.weekEpochs);
    assert.equal(after.bootstrap.length,0); assert.equal(after.usageSamples.length,0);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('synthetic home open-window import rerun is idempotent and persists flagged calibration', async () => {
  const home = mkdtempSync(join(tmpdir(),'history-open-import-'));
  const end = iso('2026-10-26T00:00:00Z'), week = 7*24*60*60*1000;
  try {
    mkdirSync(join(home,'.claude','projects','fixture'),{recursive:true});
    const records = [end-week+1000,end+1000].map((at,i)=>JSON.stringify({type:'assistant',timestamp:new Date(at).toISOString(),
      message:{id:`message-${i}`,model:'claude-haiku-4-5-20251001',usage:{input_tokens:1_000_000,output_tokens:0}}}));
    writeFileSync(join(home,'.claude','projects','fixture','session.jsonl'),records.join('\n'));
    let saved = [], samples = [];
    const historyAdapter = ()=>({meterPeriods:[],existingScores:saved,currentWindows:[{account:'claude',resource:'claude:seven_day',
      account_week_id:end+week,start_at:end,end_at:end+week,observed_at:end+2000,meter_points:1}],
      writeImportedScores:(rows,usage)=>{saved=rows;samples=usage;}});
    const options={consent:true,homeDir:home,sessionHomeDir:home,historyAdapter,kappaForUsage:fixtureKappa(1)};
    await importOwnerLendingHistory(options); const first=JSON.stringify({saved,samples});
    await importOwnerLendingHistory(options);
    assert.equal(JSON.stringify({saved,samples}),first);
    assert.equal(saved[0].source,'import-open-window');
    assert.equal(saved[0].calibration_window.start_at,end);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('owner import keeps the event loop responsive and preserves synchronous scores', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-responsive-'));
  const start=iso('2026-10-20T00:00:00Z'),end=iso('2026-10-27T00:00:00Z');
  const claude=join(home,'.claude','projects','fixture'),codex=join(home,'.codex','sessions','fixture');
  mkdirSync(claude,{recursive:true});mkdirSync(codex,{recursive:true});
  const bulk='x'.repeat(256);
  const claudeNoise=Array.from({length:200_000},()=>JSON.stringify({type:'user',content:bulk}));
  const claudeUsage=JSON.stringify({type:'assistant',timestamp:new Date(start+1000).toISOString(),
    message:{id:'claude-usage',model:'claude-haiku-4-5-20251001',usage:{input_tokens:1000,output_tokens:10}}});
  const claudeText=[...claudeNoise,claudeUsage].join('\n');
  const codexNoise=Array.from({length:200_000},()=>JSON.stringify({payload:{type:'user_message',content:bulk}}));
  const codexUsage=JSON.stringify({timestamp:new Date(start+2000).toISOString(),
    payload:{type:'token_count',model:'gpt-6-luna',message_id:'codex-usage',info:{last_token_usage:{input_tokens:1000,cached_input_tokens:0,output_tokens:10}}}});
  const codexText=[...codexNoise,codexUsage].join('\n');
  writeFileSync(join(claude,'session.jsonl'),claudeText);writeFileSync(join(codex,'rollout-fixture.jsonl'),codexText);
  const logs=[{provider:'claude',account:'claude',source:join(claude,'session.jsonl'),contents:claudeText},
    {provider:'codex',account:'codex',source:join(codex,'rollout-fixture.jsonl'),contents:codexText}];
  const meterPeriods=['claude','codex'].map(account=>({account,resource:`${account}:seven_day`,account_week_id:end,
    week_start:start,start_at:start,end_at:end,meter_points:1000}));
  let writes=[];
  try {
    const expected=importLendingHistory({consent:true,loadSessionLogs:()=>logs,meterPeriods,kappaForUsage:fixtureKappa(1),minimumCoverage:0.5}).weeklyScores;
    let finished=false;
    const importing=importOwnerLendingHistory({consent:true,homeDir:home,sessionHomeDir:home,kappaForUsage:fixtureKappa(1),minimumCoverage:0.5,
      historyAdapter:()=>({meterPeriods,existingScores:[],writeImportedScores(rows){writes=rows;}})});
    importing.then(()=>{finished=true;},()=>{finished=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(finished,false,'the import is still pending when the queued event-loop callback runs');
    const result=await importing;
    assert.deepEqual(writes,expected);
    assert.equal(result.imported_weeks,expected.length);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('owner import reads backdated files so recent usage cannot be hidden by mtime', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-old-files-'));
  const stale=join(home,'.claude','projects','old','session.jsonl');
  mkdirSync(join(home,'.claude','projects','old'),{recursive:true});
  writeFileSync(stale,'not-json\n');
  const old=new Date('2020-01-01T00:00:00Z');
  const {utimesSync}=await import('node:fs');utimesSync(stale,old,old);
  const start=iso('2026-10-20T00:00:00Z'),end=iso('2026-10-27T00:00:00Z');
  let writes=[];
  try {
    const result=await importOwnerLendingHistory({consent:true,homeDir:home,sessionHomeDir:home,kappaForUsage:fixtureKappa(1),
      historyAdapter:()=>({meterPeriods:[period(start,end)],existingScores:[],writeImportedScores(rows){writes=rows;}})});
    assert.equal(result.malformed_lines,1,'the backdated file was opened and its malformed line counted');
    assert.equal(writes.length,1);
    assert.equal(writes[0].censored,true);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('owner import skips an oversized file and reports its byte count', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-size-cap-'));
  const large=join(home,'.claude','projects','large','session.jsonl');
  mkdirSync(join(home,'.claude','projects','large'),{recursive:true});
  writeFileSync(large,'');
  truncateSync(large,65*1024*1024);
  try {
    let written=[];
    const result=await importOwnerLendingHistory({consent:true,homeDir:home,sessionHomeDir:home,kappaForUsage:fixtureKappa(1),
      historyAdapter:()=>({meterPeriods:[period(Date.now()-1000,Date.now())],existingScores:[],writeImportedScores(rows){written=rows;}})});
    assert.equal(result.skipped_files,1);
    assert.equal(result.skipped_bytes,65*1024*1024);
    assert.equal(result.incomplete,true);
    assert.deepEqual(result.skipped_file_paths,[large]);
    assert.equal(written[0].incomplete,true);
    assert.equal(written[0].censored,true);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('worker processes newest files first so the total byte cap drops the oldest file', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-newest-first-'));
  const root=join(home,'.claude','projects','ordered');mkdirSync(root,{recursive:true});
  const files=Array.from({length:5},(_,index)=>join(root,`file-${index}.jsonl`));
  try {
    files.forEach((file,index)=>{
      writeFileSync(file,'\n');truncateSync(file,64*1024*1024);
      const mtime=new Date(Date.UTC(2026,0,1,index));utimesSync(file,mtime,mtime);
    });
    const result=await readLocalAgentSessionLogsInWorker(home);
    assert.deepEqual(result.skippedFilePaths,[files[0]]);
    assert.deepEqual(result.droppedItems.find(item=>item.mtimeMs===Date.UTC(2026,0,1,0)),
      {provider:'claude',account:'claude',mtimeMs:Date.UTC(2026,0,1,0)});
    assert.equal(result.skippedFiles,1);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('a dropped old file censors every period for its account', () => {
  const first=iso('2026-10-01T00:00:00Z'),second=iso('2026-10-08T00:00:00Z'),third=iso('2026-10-15T00:00:00Z');
  const result=buildImportedWeeklyScores({usage:[usage(first+1000),usage(second+1000)],
    meterPeriods:[period(first,second),period(second,third)],kappaForUsage:fixtureKappa(1),minimumCoverage:1,
    droppedItems:[{provider:'claude',account:'claude',mtimeMs:iso('2026-10-05T00:00:00Z')}]});
  assert.equal(result.weeklyScores[0].score,Infinity);
  assert.equal(result.weeklyScores[0].incomplete,true);
  assert.equal(result.weeklyScores[0].coverage_ratio,null);
  assert.equal(result.weeklyScores[1].score,Infinity);
  assert.equal(result.weeklyScores[1].incomplete,true);
});

test('a dropped file for provider A does not taint provider B periods', () => {
  const start=iso('2026-10-20T15:00:00Z'),end=iso('2026-10-27T15:00:00Z');
  const codexUsage={account:'codex',provider:'codex',at:start+1000,model:'gpt-6-luna',tokens:{
    fresh_input:10_000,cache_read:0,cache_write_5m:0,cache_write_1h:0,output:500,reasoning:0}};
  const result=buildImportedWeeklyScores({usage:[codexUsage],meterPeriods:[{account:'codex',resource:'codex:10080',
    account_week_id:end,week_start:start,start_at:start,end_at:end,meter_points:0.000001}],kappaForUsage:fixtureKappa(0.0001),
    minimumCoverage:0.001,droppedItems:[{provider:'claude',account:'claude',mtimeMs:end}]});
  assert.ok(Number.isFinite(result.weeklyScores[0].score));
  assert.equal(result.weeklyScores[0].incomplete,undefined);
});

test('a dropped item without an mtime conservatively taints every period', () => {
  const start=iso('2026-10-01T00:00:00Z'),middle=iso('2026-10-08T00:00:00Z'),end=iso('2026-10-15T00:00:00Z');
  const result=buildImportedWeeklyScores({usage:[usage(start+1000),usage(middle+1000)],
    meterPeriods:[period(start,middle),period(middle,end)],kappaForUsage:fixtureKappa(1),minimumCoverage:1,
    droppedItems:[{provider:'claude',account:'claude'}]});
  assert.ok(result.weeklyScores.every(row=>row.censored&&row.incomplete===true));
});

test('a worker timeout still taints every period', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-timeout-global-'));
  const start=iso('2026-10-01T00:00:00Z'),middle=iso('2026-10-08T00:00:00Z'),end=iso('2026-10-15T00:00:00Z');
  try {
    const loaded=await readLocalAgentSessionLogsInWorker(home,{timeoutMs:1});
    assert.equal(loaded.errorCode,'history_worker_timeout');
    const scored=buildImportedWeeklyScores({usage:[usage(start+1000),usage(middle+1000)],
      meterPeriods:[period(start,middle),period(middle,end)],kappaForUsage:fixtureKappa(1),minimumCoverage:1,
      incomplete:Boolean(loaded.errorCode),droppedItems:loaded.droppedItems});
    assert.equal(scored.weeklyScores.length,2);
    assert.ok(scored.weeklyScores.every(row=>row.censored&&row.incomplete===true));
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('owner import skips and counts an oversized JSONL line', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-line-cap-'));
  const root=join(home,'.claude','projects','line-cap');
  mkdirSync(root,{recursive:true});
  const start=iso('2026-10-20T00:00:00Z'),end=iso('2026-10-27T00:00:00Z');
  const valid=JSON.stringify({type:'assistant',timestamp:new Date(start+1000).toISOString(),message:{id:'kept',
    model:'claude-haiku-4-5-20251001',usage:{input_tokens:1000,output_tokens:1}}});
  writeFileSync(join(root,'session.jsonl'),`{"type":"user","content":"${'x'.repeat(1024*1024)}"}\n${valid}\n`);
  try {
    let written=[];
    const result=await importOwnerLendingHistory({consent:true,homeDir:home,sessionHomeDir:home,kappaForUsage:fixtureKappa(1),minimumCoverage:0.000001,
      historyAdapter:()=>({meterPeriods:[period(start,end,0.000001)],existingScores:[],writeImportedScores(rows){written=rows;}})});
    assert.equal(result.skipped_lines,1);
    assert.equal(result.malformed_lines,1);
    assert.equal(result.incomplete,true);
    assert.equal(written.length,1);
    assert.equal(written[0].incomplete,true);
    assert.equal(written[0].censored,true);
    assert.equal(written[0].score,Infinity);
    const adapter=createLocalLendingHistoryAdapter({homeDir:home,now:()=>end+1000});
    adapter.writeImportedScores(written,[],written);
    const stored=JSON.parse(readFileSync(join(home,'v1','lending-history-claude.json'),'utf8'));
    const partial=stored.bootstrap.find(row=>row.resource==='seven_day'&&row.epoch===end);
    assert.equal(partial.complete,false);
    assert.equal(partial.reason,'import_incomplete');
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('a watchdog timeout names and counts the file being processed', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-watchdog-file-'));
  const file=join(home,'.claude','projects','slow','session.jsonl');
  const oversized=join(home,'.claude','projects','a-large','session.jsonl');
  mkdirSync(join(home,'.claude','projects','slow'),{recursive:true});
  mkdirSync(join(home,'.claude','projects','a-large'),{recursive:true});
  writeFileSync(oversized,'');truncateSync(oversized,65*1024*1024);
  writeFileSync(file,Array.from({length:500_000},()=>'{"type":"user","content":"noise"}').join('\n'));
  try {
    const result=await readLocalAgentSessionLogsInWorker(home,{timeoutMs:300});
    assert.equal(result.incomplete,true);
    assert.equal(result.errorCode,'history_worker_timeout');
    assert.equal(result.skippedFiles,1);
    assert.deepEqual(result.skippedFilePaths,[file]);
    assert.deepEqual(result.droppedItems.map(({provider,account})=>({provider,account})),[{provider:'claude',account:'claude'}]);
    assert.ok(Number.isFinite(result.droppedItems[0].mtimeMs));
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('a worker without progress times out with a structured incomplete result', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-watchdog-'));
  try {
    const result=await readLocalAgentSessionLogsInWorker(home,{timeoutMs:1});
    assert.equal(result.incomplete,true);
    assert.equal(result.errorCode,'history_worker_timeout');
    assert.deepEqual(result.logs,[]);
    assert.equal(result.workerExited,true);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('a throwing shouldContinue callback cancels without escaping the importer', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-throwing-continue-'));
  let checks=0,writes=0;
  try {
    const result=await importOwnerLendingHistory({consent:true,homeDir:home,sessionHomeDir:home,
      shouldContinue(){if(++checks===2)throw new Error('synthetic cancellation check failure');return true;},
      historyAdapter:()=>({meterPeriods:[period(Date.now()-1000,Date.now())],existingScores:[],writeImportedScores(){writes++;}})});
    assert.equal(result.skipped,true);
    assert.equal(writes,0);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('owner import stops between files when shouldContinue becomes false', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-stop-'));
  try {
    for(const [root,name] of [[join(home,'.claude','projects','a'),'a.jsonl'],[join(home,'.codex','sessions','b'),'rollout-b.jsonl']]){
      mkdirSync(root,{recursive:true});writeFileSync(join(root,name),'{}\n');
    }
    let checks=0,writes=0;
    const result=await importOwnerLendingHistory({consent:true,homeDir:home,sessionHomeDir:home,shouldContinue:()=>++checks<6,
      historyAdapter:()=>({meterPeriods:[period(Date.now()-1000,Date.now())],existingScores:[],writeImportedScores(){writes++;}})});
    assert.equal(result.skipped,true);
    assert.equal(writes,0);
    const workerResult=await readLocalAgentSessionLogsInWorker(home,{meterPeriods:[period(Date.now()-1000,Date.now())],shouldContinue:()=>false});
    assert.equal(workerResult.aborted,true);
    assert.equal(workerResult.workerExited,true);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('a stateful continuation predicate is called once per file decision', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-stateful-continue-'));
  try {
    const root=join(home,'.claude','projects','one');mkdirSync(root,{recursive:true});
    writeFileSync(join(root,'one.jsonl'),'{}\n');
    let checks=0;
    const result=await readLocalAgentSessionLogsInWorker(home,{shouldContinue:()=>++checks===1});
    assert.equal(result.aborted,true);
    assert.ok(checks>=2);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('sync reader rejects excess records before worker import', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-cache-bound-'));
  const root=join(home,'.claude','projects','many');mkdirSync(root,{recursive:true});
  const message=index=>JSON.stringify({type:'assistant',timestamp:'2026-10-20T00:00:00Z',message:{id:`message-${index}`,
    model:'claude-haiku-4-5-20251001',usage:{input_tokens:1,output_tokens:1}}});
  writeFileSync(join(root,'many.jsonl'),Array.from({length:50_001},(_,index)=>message(index)).join('\n'));
  try {
    assert.throws(()=>[...readLocalAgentSessionLogs(home,{incremental:true})],/history.*record/i);
    const result=await readLocalAgentSessionLogsInWorker(home);
    assert.equal(result.incomplete,true);
    assert.equal(result.skippedRows,25_001);
    assert.equal(result.logs.length,1);
    assert.equal(result.logs[0].parsed.usage.length,25_000);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('worker deduplicates hardlinked session files by device and inode', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-hardlinks-'));
  const root=join(home,'.claude','projects','fixture');mkdirSync(root,{recursive:true});
  const first=join(root,'a.jsonl'),second=join(root,'b.jsonl');
  writeFileSync(first,JSON.stringify({type:'assistant',timestamp:'2026-10-20T00:00:00Z',message:{id:'same-file',
    model:'claude-haiku-4-5-20251001',usage:{input_tokens:100,output_tokens:1}}}));
  linkSync(first,second);
  try {
    const result=await readLocalAgentSessionLogsInWorker(home);
    assert.equal(result.logs.length,1);
    assert.equal(result.logs[0].parsed.usage.length,1);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('worker Codex totals advance across a malformed timestamp line', async () => {
  const home=mkdtempSync(join(tmpdir(),'history-worker-codex-bad-time-'));
  const root=join(home,'.codex','sessions','fixture');mkdirSync(root,{recursive:true});
  const total=input=>({input_tokens:input,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0});
  const row=(timestamp,input,message_id)=>JSON.stringify({timestamp,message_id,payload:{type:'token_count',model:'gpt-6-luna',
    info:{total_token_usage:total(input)}}});
  writeFileSync(join(root,'rollout-worker.jsonl'),[
    row('2026-10-20T00:00:00Z',100,'one'),row('malformed timestamp',200,'two'),row('2026-10-20T00:02:00Z',300,'three'),
  ].join('\n'));
  try {
    const result=await readLocalAgentSessionLogsInWorker(home);
    const parsed=result.logs[0].parsed;
    assert.equal(parsed.malformedLines,1);
    assert.deepEqual(parsed.usage.map(item=>item.tokens.fresh_input),[100,100,100]);
  } finally {rmSync(home,{recursive:true,force:true});}
});
