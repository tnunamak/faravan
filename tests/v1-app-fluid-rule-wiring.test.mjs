import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {openDevice} from '../lib/v1/device.mjs';
import {appFixture, api} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {lagBoundsFor, PROVIDER_LAG_MS, BURN_RATE_MARGIN, COLD_START_POINTS_PER_HOUR} from '../lib/v1/lending-rule-defaults.mjs';

// The fluid rule inside the real lender app's admission path (startup option lendingRule === 'fluid').
// Every number is a synthetic test input. The registry, rounding, native-cost, ledger and owner-trace attestations
// are trusted startup inputs for this test only: the production server has no complete quota registry and no
// same-account ledger identity yet. The owner trace is a synthetic 2 points/hour probe, not provider evidence.
const MICRO = 1_000_000, H = 3_600_000;

const claudeAdapters = () => [{spec:legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true,
  harnessVersion: 'synthetic-only', models: ['claude-haiku-5-5'], capabilities: []}];

function attestation({start, used, resets, account}) {
  const weekly = 7 * 24 * H, short = 5 * H;
  const limit = (id, durationMs) => ({id, provider: 'claude', unit: 'quota_percent', capacity: 100, durationMs,
    reset: {kind: 'first-use'}, scope: {kind: 'account'},
    weights: {version: 'synthetic-exact/1', nativeUnit: 'usd', byModel: {'claude-haiku-5-5': 1, 'claude-sonnet-5-5': 1,
      'claude-opus-5-5': 1}}});
  return {
    quotaRegistry: {version: 'synthetic-attested/1', complete: true,
      limits: [limit('seven_day', weekly), limit('five_hour', short)]},
    registryProvenance: 'Synthetic complete account roster and exact USD weights (test attestation).',
    roundingPoints: 0,
    roundingProvenance: 'Synthetic exact provider rounding (test attestation).',
    nativeCostBounds: (requestedUsdMicro) => ({unit: 'usd', lower: 0, upper: requestedUsdMicro / MICRO}),
    ledgerSnapshot: {account, windows: [
      {window_id: 'seven_day', window_minutes: 10080, used_pct: used.weekly / MICRO, resets_at: start + resets.weekly,
        observed_at: start, state: 'open', lent_pct: 0, reserved_pct: 0},
      {window_id: 'five_hour', window_minutes: 300, used_pct: used.short / MICRO, resets_at: start + resets.short,
        observed_at: start, state: 'open', lent_pct: 0, reserved_pct: 0}]},
    entries: [],
    history: [],
    rateHistory: [['seven_day', weekly], ['five_hour', short]].map(([window_id, length_ms]) => ({window_id,
      start_at: start - 2 * H, resets_at: start - 2 * H + length_ms, length_ms, complete: false, censored: false,
      source: 'probe', rounding_points: 0, metadata: {measurement: 'exact'},
      trace: [[start - 2 * H, 0], [start - H, 2]]})),
  };
}

test('lag and rate defaults: 1.5 times the highest hourly burn in seven days, cold start with no usable interval', () => {
  const now = 1000 * H;
  const rows = [
    {window_id: 'seven_day', trace: [[now - 2 * H, 0], [now - H, 2], [now - H / 2, 2.5]]},
    {window_id: 'seven_day', trace: [[now - 200 * H, 0], [now - 199 * H, 50]]}, // outside seven days: ignored
  ];
  const bounds = lagBoundsFor({windows: [{id: 'seven_day'}, {id: 'five_hour'}], rows, now});
  assert.equal(bounds.providerLagMs.seven_day, PROVIDER_LAG_MS);
  assert.equal(bounds.maxPointsPerHour.seven_day, BURN_RATE_MARGIN * 2);
  assert.equal(bounds.maxPointsPerHour.five_hour, COLD_START_POINTS_PER_HOUR);
  assert.equal(bounds.providerLagProvenance, 'lead-chosen meter lag allowance');
  assert.equal(bounds.rateProvenance, 'cold-start default (lead-chosen)');
  assert.equal(lagBoundsFor({windows: [{id: 'seven_day'}], rows, now}).rateProvenance,
    'estimated from owner history x1.5 (lead-chosen)');
});

// Starts a lender with the given rule setting and an explicit 100% cap so the $20 job exercises the rule.
async function decisionFor(t, {lenderOptions, used, resets, position = 'share_more', strategy = {}, sourceOverride, importedRows}) {
  const start = Date.now();
  const f = await appFixture(t);
  const device = await openDevice({home:await f.home('lender')});
  const source = createSyntheticPace50Source({start, resets, used, kappa: {weekly: MICRO, short: MICRO}, override: sourceOverride});
  if (importedRows) {
    source.history.weeklyScores = () => importedRows(start);
    delete source.objectiveInputFor;
  }
  const {owner, lender, circle} = await f.connect({
    device, lendingPace50: {source, account_week_id: 'synthetic-week-1'}, adapters: claudeAdapters,
    ...lenderOptions(start, used, resets, device.keyId),
  });
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60,
    maxWallSeconds: 1200, idleOnly: false, lendingPolicy: {providerConsent: {claude: true}, protectionPosition: position, ...strategy,strategyParams:{perJobPct:100,...strategy.strategyParams}}}});
  await api(lender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(lender.app, '/api/lending/owner-settings', {method: 'POST', body: {maxJobUsd: 20,
    reason: 'Synthetic test: per-job limit for the fluid acceptance workload.'}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, git: 'https://github.com/example/synthetic.git',
    commit: '1'.repeat(40), prompt: 'Synthetic task: write a greeting. No external execution.', harness: 'claude-code-subscription',
    budget_v1: {max_list_usd: 20}}});
  const deadline = Date.now() + 30000;
  let decision = null;
  while (Date.now() < deadline) {
    const view = await api(lender.app, '/api/lending');
    decision = view.objective?.accounts?.[0]?.decision?.lastJobDecision ?? null;
    if (decision) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(decision, 'the lender decided the owner job within 30 seconds');
  return decision;
}

const fluid = (start, used, resets, account) => ({lendingRule: 'fluid', lendingRuleAttestation: attestation({start, used, resets, account})});
const plain = () => ({lendingRule: 'legacy'});
// A light owner: 10 points used, three hours before the weekly reset.
const light = {used: {weekly: 10 * MICRO, short: 0}, resets: {weekly: 3 * H, short: 1.25 * H}};
// A heavy owner: 80 points used by hour 42 of the 168-hour week (126 hours remain).
const heavy = {used: {weekly: 80 * MICRO, short: 0}, resets: {weekly: 126 * H, short: 1.25 * H}};

test('with lendingRule fluid at share_more, a light owner near reset is admitted and carries fluid_lend', {timeout: 120000}, async (t) => {
  const d = await decisionFor(t, {lenderOptions: fluid, ...light});
  assert.equal(d.admitted, true, JSON.stringify(d));
  assert.equal(d.objective.reasonCode, 'objective_lend');
  assert.equal(d.objective.ruleReasonCode, 'fluid_lend');
  assert.equal(d.objective.protectionSource.seven_day, 'injected_rule');
});

test('with lendingRule fluid at share_more, a heavy owner at hour 42 is held by the rule', {timeout: 120000}, async (t) => {
  const d = await decisionFor(t, {lenderOptions: fluid, ...heavy});
  assert.equal(d.admitted, false, JSON.stringify(d));
  assert.equal(d.objective.reasonCode, 'rule_resource_fit');
  // The seam shows its own limiting code on a hold that does not fit. The rule's fluid_allowance is not shown.
  assert.equal(d.objective.ruleReasonCode, 'seam_rule_allowance');
});

// Production evidence: no lendingRule option and no attestation. The registry, snapshot, rounding, rate bounds,
// owner history and native cost all come from lending-rule-defaults.mjs and the app's own stores.
const productionEvidence = () => ({});
test('by default, with production evidence, a light owner near reset is admitted by the fluid rule', {timeout: 120000}, async (t) => {
  const d = await decisionFor(t, {lenderOptions: productionEvidence, ...light});
  assert.equal(d.admitted, true, JSON.stringify(d));
  assert.equal(d.objective.ruleReasonCode, 'fluid_lend');
});
test('the fluid rule uses a fresh empty window when continuous-model history cannot be used', {timeout: 120000}, async t => {
  const decision = await decisionFor(t, {
    lenderOptions: productionEvidence, ...light, used:{weekly:0, short:0},
    importedRows:start => new Map([[start - 7 * 86400000, {source:'import', complete:false, score:0}]]),
  });
  assert.equal(decision.admitted, true, JSON.stringify(decision));
  assert.equal(decision.objective.ruleReasonCode, 'fluid_lend');
});

test('fluid admits a bounded native-window job without inventing converted gross', {timeout: 120000}, async t => {
  const decision = await decisionFor(t, {
    lenderOptions:productionEvidence, ...light, used:{weekly:0, short:0},
    sourceOverride:({base}) => ({...base, resources:base.resources.map(window =>
      ({...window, conversion:'native_window', kappa_micro:null, kappa_lower_micro:null}))}),
  });
  assert.equal(decision.admitted, true, JSON.stringify(decision));
  assert.equal(decision.objective.ruleReasonCode, 'fluid_lend');
  assert.ok(Object.values(decision.objective.lendablePoints).every(points => points > 0));
});

test('by default, with production evidence, a heavy owner at hour 42 is held', {timeout: 120000}, async (t) => {
  const d = await decisionFor(t, {lenderOptions: productionEvidence, ...heavy});
  assert.equal(d.admitted, false, JSON.stringify(d));
  assert.equal(typeof d.objective?.ruleReasonCode, 'string', JSON.stringify(d));
});

// The fluid rule is the Automatic strategy. An owner's Fixed share choice keeps its own numbers under the default.
test('by default, a Fixed share choice is judged by its own share, not the fluid rule', {timeout: 120000}, async (t) => {
  const d = await decisionFor(t, {lenderOptions: productionEvidence, ...light,
    strategy: {strategy: 'fixed_share', strategyParams: {fixedSharePct: 50, keepPct: 30}}});
  assert.equal(d.objective.strategyId, 'fixed_share', JSON.stringify(d));
  assert.equal(Object.hasOwn(d.objective, 'ruleReasonCode'), false);
  assert.equal(d.admitted, true, JSON.stringify(d));
});

test('with lendingRule legacy the light owner takes today\'s path and carries no rule code', {timeout: 120000}, async (t) => {
  const d = await decisionFor(t, {lenderOptions: plain, ...light});
  assert.equal(d.admitted, true, JSON.stringify(d));
  assert.equal(d.objective.reasonCode, 'objective_lend');
  assert.equal(Object.hasOwn(d.objective, 'ruleReasonCode'), false);
});

test('with lendingRule legacy the heavy owner takes today\'s path and is held by the default strategy', {timeout: 120000}, async (t) => {
  const d = await decisionFor(t, {lenderOptions: plain, ...heavy});
  assert.equal(d.admitted, false, JSON.stringify(d));
  assert.equal(d.reason, 'exceeds_spare');
  assert.equal(d.objective.reasonCode, 'objective_exceeds_spare');
  assert.equal(Object.hasOwn(d.objective, 'ruleReasonCode'), false);
});

test('production attestations: live rate rows, cold-start floor, registry from the live roster, supported history only', async () => {
  const {liveRateRows, registryFor, ruleHistoryFor, nativeCostBounds} = await import('../lib/v1/lending-rule-defaults.mjs');
  const now = 1000 * H;
  const windows = [{id: 'seven_day', anchor_at: now - 100 * H, resets_at: now + 68 * H, duration_ms: 168 * H, used_micro: 40 * MICRO, kappa_micro: 370000},
    {id: 'five_hour', anchor_at: now - H, resets_at: now + 4 * H, duration_ms: 5 * H, used_micro: 30 * MICRO, kappa_micro: 2_000_000}];
  const live = liveRateRows(windows, now);
  assert.deepEqual(live.map(r => r.trace), [[[now - 100 * H, 0], [now, 40]], [[now - H, 0], [now, 30]]]);
  // No owner history: the five-hour window's live burn (30/h) x1.5 beats the 20/h floor; the weekly gets the floor.
  const bounds = lagBoundsFor({windows, rows: [], liveRows: live, now});
  assert.equal(bounds.maxPointsPerHour.seven_day, COLD_START_POINTS_PER_HOUR);
  assert.equal(bounds.maxPointsPerHour.five_hour, 45);
  const registry = registryFor({provider: 'claude', model: 'claude-haiku-5-5', windows});
  assert.equal(registry.complete, true);
  assert.deepEqual(registry.limits.map(l => l.weights.byModel['claude-haiku-5-5']), [0.37, 2]);
  assert.equal(registryFor({provider: 'claude', model: 'claude-haiku-5-5', windows: [{...windows[0], id: 'mystery'}]}), null);
  assert.equal(registryFor({provider: 'claude', model: 'claude-haiku-5-5', windows: [{...windows[0], kappa_micro: 0}]}), null);
  assert.deepEqual(nativeCostBounds(2_890_000), {unit: 'usd', lower: 0, upper: 2.89});
  const good = {window_id: 'seven_day', start_at: now - 300 * H, resets_at: now - 132 * H, length_ms: 168 * H, complete: true, censored: false,
    source: 'import', rounding_points: 0, metadata: {measurement: 'exact'}, trace: [[now - 300 * H, 0], [now - 132 * H, 10]]};
  const censored = {...good, censored: true, trace: [], metadata: {measurement: null, excluded_reason: 'account_week_censored'}};
  const {history, rateHistory} = ruleHistoryFor([good, censored], now);
  assert.deepEqual(history, [good]);
  assert.deepEqual(rateHistory, [good]);
});

// The window memory inside the real lender app (production evidence: no attested registry). The synthetic source
// stops reporting the five-hour window after the first reply; the lender's clock is moved by hand.
test('a five-hour window that stops being reported is refused, then accepted after a full window and logged once', {timeout: 120000}, async (t) => {
  const {readFile} = await import('node:fs/promises');
  const {join} = await import('node:path');
  const start = Date.now();
  let at = start, dropShort = false;
  const f = await appFixture(t);
  const device = await openDevice({home: await f.home('lender')});
  const source = createSyntheticPace50Source({start, resets: {weekly: 60 * H, short: 30 * H}, used: light.used, kappa: {weekly: MICRO, short: MICRO},
    override: ({base}) => dropShort ? {...base, resources: base.resources.filter(w => w.id !== 'five_hour')} : base});
  const {owner, lender, circle} = await f.connect({device, lendingPace50: {source, account_week_id: 'synthetic-week-1'},
    adapters: claudeAdapters, lendingNow: () => at});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60,
    maxWallSeconds: 1200, idleOnly: false, lendingPolicy: {providerConsent: {claude: true}, protectionPosition: 'share_more'}}});
  await api(lender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  const removals = async () => (await readFile(join(lender.home, 'v1', 'lending-errors.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(JSON.parse).filter(e => e.code === 'lending_window_removed');
  await api(lender.app, '/api/lending/owner-settings', {method: 'POST', body: {maxJobUsd: 20,
    reason: 'Synthetic test: per-job limit for the fluid acceptance workload.'}});
  let jobs = 0;
  const decide = async () => {
    await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, git: 'https://github.com/example/synthetic.git',
      commit: '1'.repeat(40), prompt: 'Synthetic task ' + (jobs += 1), harness: 'claude-code-subscription', budget_v1: {max_list_usd: 20}}});
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const d = (await api(lender.app, '/api/lending')).objective?.accounts?.[0]?.decision?.lastJobDecision;
      if (d?.assessedAt === at) return d;
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('no decision');
  };
  await decide(); // first reply: both windows reported and remembered
  assert.deepEqual(await removals(), []);
  dropShort = true;
  const gap = at + H;
  at = gap;
  assert.equal((await decide()).reason, 'lending_window_missing');
  at = gap + 4.9 * H; // 4.9 hours without the five-hour window
  assert.equal((await decide()).reason, 'lending_window_missing');
  assert.deepEqual(await removals(), [], 'nothing is logged while the window is still refused');
  at = gap + 5 * H; // a full five-hour window of replies without it
  const accepted = await decide();
  assert.notEqual(accepted.reason, 'lending_window_missing', JSON.stringify(accepted));
  const logged = await removals();
  assert.equal(logged.length, 1);
  assert.deepEqual({code: logged[0].code, provider: logged[0].provider, window: logged[0].window, absent_ms: logged[0].absent_ms},
    {code: 'lending_window_removed', provider: 'claude', window: 'five_hour', absent_ms: 5 * H});
  await decide();
  assert.equal((await removals()).length, 1, 'the removal is logged once');
});

test('a provider reply with no windows refuses lending', {timeout: 120000}, async (t) => {
  const d = await decisionFor(t, {lenderOptions: productionEvidence, ...light,
    sourceOverride: ({base}) => ({...base, resources: []})});
  assert.equal(d.admitted, false, JSON.stringify(d));
});
