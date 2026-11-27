import './helpers/no-browser.mjs';
import {settleDurableAtBound} from './helpers/lending-settle-at-bound.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DEFAULT_PRIOR, WEEK_MS} from '../lib/v1/lending-continuous-model.mjs';
import {MICRO} from '../lib/v1/lending-objective.mjs';
import {claudeCallHeadroomUsd, emptyTokens, priceListUsd} from '../lib/v1/lending-meter.mjs';
import {lendableModelsFor} from '../lib/v1/lender-pace50.mjs';
import {LINES} from '../lib/v1/lending-status-copy.mjs';
import {matchingRule} from '../lib/v1/offers.mjs';
import {appFixture, api, waitFor, syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {meteringSandbox} from './helpers/pace50-app-sandbox.mjs';

const SHORT_MS = 5 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const WEEKLY_KAPPA = 50_000;
const SHORT_KAPPA = 1_000;
const ACCOUNT = 'm1-acceptance-account';
const WEEKLY_ID = 'seven_day';
const SHORT_ID = 'five_hour';
const HAIKU_MODEL = lendableModelsFor('claude').find(model => model.includes('haiku') && model.endsWith('-5-5'))
  ?? lendableModelsFor('claude').find(model => model.includes('haiku'));

function demandSource({clock, elapsed = 0.01, ownerWeeklyPoints = 0, importedRows = [], missingWeeklyMeter = false}) {
  const originAtMs = Math.round(clock() - elapsed * WEEK_MS);
  const weeklyResetAtMs = originAtMs + WEEK_MS;
  const state = {used: {weekly: ownerWeeklyPoints * MICRO, short: 0}, ownerUsed: {weekly: ownerWeeklyPoints * MICRO}};
  const history = {weeklyScores(resource) {
    if (resource !== WEEKLY_ID) return new Map();
    return new Map(importedRows.map((row, index) => {
      const end = originAtMs - index * WEEK_MS;
      return [end, {...row, epoch: end, start: end - WEEK_MS, end, resource}];
    }));
  }};
  const windowsAt = now => {
    const shortResetAtMs = Math.min(now + 30 * MINUTE_MS, weeklyResetAtMs - 30 * MINUTE_MS);
    const shortAnchorAtMs = shortResetAtMs - SHORT_MS;
    const weekly = {id: WEEKLY_ID, kind: 'weekly', instance: `${WEEKLY_ID}@${weeklyResetAtMs}`, state: 'open',
      anchor_at: originAtMs, resets_at: weeklyResetAtMs, duration_ms: WEEK_MS, observed_at: now,
      used_micro: state.used.weekly, owner_used_micro: state.ownerUsed.weekly,
      kappa_micro: WEEKLY_KAPPA, kappa_lower_micro: WEEKLY_KAPPA, uncertainty_micro: MICRO, origin: null};
    const short = {id: SHORT_ID, kind: 'short', instance: `${SHORT_ID}@${shortResetAtMs}`, state: 'open',
      anchor_at: shortAnchorAtMs, resets_at: shortResetAtMs, duration_ms: SHORT_MS, observed_at: now,
      used_micro: state.used.short, owner_used_micro: 0,
      kappa_micro: SHORT_KAPPA, kappa_lower_micro: SHORT_KAPPA, uncertainty_micro: MICRO, origin: 'owner'};
    if (missingWeeklyMeter) {
      delete weekly.used_micro;
      delete weekly.owner_used_micro;
    }
    return [weekly, short];
  };
  const source = {
    kind: 'm1-acceptance',
    weekResetAtMs: weeklyResetAtMs,
    accountWeekId: `${ACCOUNT}:weekly:${weeklyResetAtMs}`,
    stop_bound_ms: 60_000,
    uncertainty_ms: 0,
    state,
    history,
    async observe({provider, now}) {
      const resources = windowsAt(now);
      const weekly = resources.find(resource => resource.kind === 'weekly');
      return {refresh_succeeded: true, complete: true, resources, weekly_resource_id: WEEKLY_ID,
        identity: {verified: true, account_id: ACCOUNT},
        account_week_id: `${ACCOUNT}:weekly:${weekly.resets_at}`, epoch: weekly.instance,
        funding: {subscription_only: 'proven'}, executor: {single_executor: 'proven'},
        stop: {bounded_execution: 'proven'}, stop_bound_ms: 60_000, uncertainty_ms: 0,
        opening_anchor_known: true, resource_coupling_known: true, provider, observed_at: now};
    },
    convertUsage({units_micro, resources}) {
      if (!Number.isSafeInteger(units_micro) || units_micro < 0) return null;
      const rows = resources ?? [{id: WEEKLY_ID, kappa_micro: WEEKLY_KAPPA}, {id: SHORT_ID, kappa_micro: SHORT_KAPPA}];
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const converted = rows.map(resource => {
        if (!Number.isSafeInteger(resource?.kappa_micro) || resource.kappa_micro <= 0) return null;
        const amount = (BigInt(resource.kappa_micro) * BigInt(units_micro) + BigInt(MICRO - 1)) / BigInt(MICRO);
        return amount <= BigInt(Number.MAX_SAFE_INTEGER)
          ? {id: resource.id, ...(resource.instance ? {instance: resource.instance} : {}), amount_micro: Number(amount)}
          : null;
      });
      return converted.every(Boolean) ? converted : null;
    },
    setOwnerWeeklyPoints(points) {
      const borrowerUsage = state.used.weekly - state.ownerUsed.weekly;
      state.ownerUsed.weekly = points * MICRO;
      state.used.weekly = state.ownerUsed.weekly + borrowerUsage;
    },
  };
  return source;
}

function recordNativeBudgets(backend) {
  backend.nativeBudgets = [];
  const start = backend.start.bind(backend);
  backend.start = async (handle, options = {}) => {
    const limit = options.lendingBudget?.budget?.limit;
    if (Number.isFinite(limit)) backend.nativeBudgets.push(limit);
    return start(handle, options);
  };
  return backend;
}

function holdFirstStart(backend) {
  const original = backend.start.bind(backend);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  backend.startEntered = false;
  backend.releaseStart = release;
  backend.start = async (handle, options = {}) => {
    backend.startEntered = true;
    await gate;
    return original(handle, options);
  };
  return backend;
}

async function startLane(t, options = {}) {
  const {source, model = HAIKU_MODEL, maxJobUsd = 20, clock = Date.now, demandModel,
    mode = 'auto', standingRule = true, lendingRule = 'legacy'} = options;
  const f = await appFixture(t);
  const backend = typeof options.backend === 'function' ? options.backend(f.root) : options.backend;
  const appClock = () => Math.floor(clock() / 1000);
  // These M1 checks specify the continuous-gamma demand model, which now runs only as lendingRule 'legacy'. The default
  // fluid rule meets the ship bar in v1-rule-evidence and v1-app-fluid-rule-wiring; (c) also runs it here.
  const lenderOptions = {clock:appClock, lendingPace50:{source,postingLagBoundMs:0},lendingNow: clock, backend, lendingRule,
    adapters: () => [{spec:legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true,
      harnessVersion: 'synthetic-only', models: model ? [model] : [], capabilities: []}]};
  if (Object.hasOwn(options, 'demandModel')) lenderOptions.demandModel = demandModel;
  if (Object.hasOwn(options, 'lendingQueueReader')) lenderOptions.lendingQueueReader = options.lendingQueueReader;
  const {owner, lender, circle} = await f.connect(lenderOptions, {clock: appClock});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {
    dailyJobs: null, dailyMinutes: null, maxWallSeconds: null, idleOnly: false,
    lendingPolicy: {providerConsent: {claude: true}, protectionPosition: 'balanced',
      ...(Object.hasOwn(options,'perJobPct')?{strategyParams:{perJobPct:options.perJobPct}}:{})},
  }});
  await api(lender.app, '/api/lending/owner-settings', {method: 'POST', body: {
    maxJobUsd, reason: 'M1 synthetic acceptance fixture',
  }});
  const presence = await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  assert.equal(presence.active, false, 'the app records the owner as idle before automatic lending');
  if (model) {
    await api(lender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
    await api(lender.app, '/api/agents/claude-code-subscription/run', {method: 'POST', body: {model, effort: null}});
  }
  await api(lender.app, '/api/lending/rules', {method: 'POST', body: {rules: standingRule ? [{
    id: 'm1-acceptance-rule', circle: circle.id, people: [owner.app.device.keyId],
    agents: ['claude-code-subscription'], maxWallSeconds: null, dailyJobs: null, weeklyJobs: null,
    dailyMinutes: null, weeklyMinutes: null, expiresAt: clock() + 2 * WEEK_MS,
  }] : []}});
  const expectedOwnerRules = structuredClone((await api(lender.app, '/api/lending')).standingRules);
  assert.deepEqual(expectedOwnerRules.map(rule => rule.id), standingRule ? ['m1-acceptance-rule'] : []);
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  return {f, owner, lender, circle, source, backend, expectedOwnerRules};
}

function jobFor(circle, {model = HAIKU_MODEL, budgetUsd = 20, name = 'M1 acceptance task'} = {}) {
  return {circle: circle.id, git: {url: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40)},
    prompt: `Synthetic task: ${name}. No external execution.`, harness: 'claude-code-subscription', model,
    budget_v1: {max_list_usd: budgetUsd}};
}

async function submitJob(lane, options) {
  const result = await api(lane.owner.app, '/api/jobs', {method: 'POST', body: jobFor(lane.circle, options)});
  const signed = lane.f.jobs.get(result.jobDigest)?.job?.payload;
  assert.equal(signed?.budget_v1?.max_list_usd, options?.budgetUsd ?? 20, 'the requester budget survives app submission and signing');
  assert.ok(signed.requirements.capabilities.includes('budget_v1'), 'the signed requirements name the budget extension');
  return result;
}

async function decisionFor(lender) {
  const view = await api(lender.app, '/api/lending');
  return view.objective?.accounts?.find(row => row.provider === 'claude')?.decision ?? null;
}

async function waitForDecision(lender, predicate, label) {
  return waitFor(async () => {
    const decision = await decisionFor(lender);
    return decision && predicate(decision) ? decision : null;
  }, label, 30_000);
}

async function waitForOwnerReserve(lane) {
  try {
    return await waitForDecision(lane.lender, row => row.reason === 'owner_reserve',
      'the continuous model to protect the heavy owner');
  } catch (error) {
    const view = await api(lane.lender.app, '/api/lending').catch(() => null);
    throw new Error(`${error.message}; lending=${JSON.stringify(view)}; durable=${JSON.stringify(durableState(lane.lender))}; sourceWeek=${JSON.stringify({id:lane.source.accountWeekId,resetAt:lane.source.weekResetAtMs,now:lane.lender.app.clock?.()})}`);
  }
}

function durableState(lender) {
  return JSON.parse(readFileSync(join(lender.home, 'v1', 'lending-pace50-state.json'), 'utf8'));
}

async function waitForAccepted(lane, label, timeout = 60_000) {
  try {
    return await waitFor(() => [...lane.f.jobs.values()].find(view => view.state === 'result-accepted'), label, timeout);
  } catch (error) {
    const jobs = [...lane.f.jobs.values()].map(view => ({state:view.state, reason:view.reason ?? null,
      reasonText:view.reason_text ?? null, currentAttempt:view.current_attempt &&
        {state:view.current_attempt.state,reason:view.current_attempt.reason,started:view.current_attempt.execution_started_at}}));
    const decision = await decisionFor(lane.lender).catch(cause => ({readError:cause.message}));
    const calls = lane.backend?.calls?.map(([kind, spec]) => [kind, spec?.harness ?? spec?.model ?? null]) ?? null;
    const trace = lane.f.networkTrace?.slice(-32).map(({device,method,route,status,code,error:networkError}) =>
      ({device,method,route,status,code,error:networkError})) ?? null;
    const config = await api(lane.lender.app, '/api/lending').catch(() => null);
    const payload = [...lane.f.jobs.values()][0]?.job?.payload;
    const matching = payload && matchingRule(config?.standingRules ?? [], payload, 'claude-code-subscription', {now: Date.now()});
    const coordinatorErrors = lane.f.failures?.slice(-4).map(cause => cause?.stack ?? String(cause)) ?? [];
    const capabilityRequests = lane.f.rawRequests?.filter(request => request.url.endsWith('/capabilities')).slice(-3).map(request => {
      let proof = null;
      try { proof = JSON.parse(Buffer.from(request.headers['faravan-proof'], 'base64url')).payload; } catch {}
      return {url:request.url,keyId:proof?.key_id,rosterEpoch:proof?.roster_epoch,method:proof?.method,target:proof?.target,
        created:proof?.created,bodyDigest:proof?.body_digest,contentLength:proof?.content_length,contentType:proof?.content_type,
        artifactMediaType:proof?.artifact_media_type,idempotencyKey:proof?.idempotency_key};
    }) ?? [];
    throw new Error(`${error.message}; jobs=${JSON.stringify(jobs)}; decision=${JSON.stringify(decision)}; rule=${JSON.stringify({mode:config?.mode,enabled:config?.enabled,count:config?.standingRules?.length,matching:Boolean(matching)})}; requirements=${JSON.stringify(payload?.requirements)}; backendCalls=${JSON.stringify(calls)}; phases=${JSON.stringify({owner:lane.owner?.phases,lender:lane.lender?.phases})}; coordinatorErrors=${JSON.stringify(coordinatorErrors)}; capabilityRequests=${JSON.stringify(capabilityRequests)}; trace=${JSON.stringify(trace)}`);
  }
}

test('M1 acceptance (a): a light owner lends nearly all weekly spare through the real app and meter', {timeout: 240_000}, async t => {
  let now = Date.now();
  const clock = () => now;
  const source = demandSource({clock, elapsed: 0.99, ownerWeeklyPoints: 10});
  let backend;
  const lane = await startLane(t, {source, model: HAIKU_MODEL, maxJobUsd: 1792, perJobPct:100, clock,
    backend: root => (backend = recordNativeBudgets(meteringSandbox(root, {source, tokens: {input: 1000, output: 200},
      cost_usd: 2000, model: HAIKU_MODEL})))});
  now = Date.now();
  // This spare-capacity replay explicitly raises the per-job cap to 100%.
  // The weekly spare is 100 - 10 owner points - 1 meter unit = 89 points, or 1780 USD at 20 USD per point. The request is 88.5 points.
  // The whole-point unit lowers spare by one point, so the request and the floor below are sized to the declared unit: a request
  // above the spare holds, and the old 1792 USD request (89.6 points) would have been held.
  await submitJob(lane, {budgetUsd: 1770, name: 'light owner late-week workload'});
  const accepted = await waitForAccepted(lane, 'the light-owner borrower result');

  const borrowerPoints = source.state.used.weekly - source.state.ownerUsed.weekly;
  assert.ok(borrowerPoints >= 88.4 * MICRO, `borrower used ${(borrowerPoints / MICRO).toFixed(6)} weekly points`);
  assert.ok(source.state.used.weekly <= 100 * MICRO, 'owner and borrower spend stay within the weekly allowance');
  assert.equal(source.state.ownerUsed.weekly, 10 * MICRO, 'the observed owner demand remains 10 points');
  assert.equal(accepted.result.payload.receipt.budget_v1.model, HAIKU_MODEL,
    'the real result carries a canonical budget receipt for the admitted model');
  assert.equal(accepted.result.payload.receipt.budget_v1.tokens.fresh_input, 1000);
  assert.equal(accepted.result.payload.receipt.budget_v1.tokens.output, 200);
  assert.equal(backend.nativeBudgets[0], 1770 - claudeCallHeadroomUsd(HAIKU_MODEL),
    'the native budget is the signed gross ceiling less the actual Haiku worst-call headroom');
  const decision=await waitForDecision(lane.lender,row=>row.lastJobDecision?.objective?.reasonCode==='objective_lend','the admitted last-job decision');
  await lane.lender.app.close();
  await settleDurableAtBound({home:lane.lender.home,source,postingLagBoundMs:0});
  const attempt=durableState(lane.lender).attempts[0];
  assert.equal(attempt.process_state,'ceased');
  assert.ok(attempt.resources.every(resource=>resource.held_micro===0&&resource.unrepresented_micro===0));
  assert.equal(decision.lastJobDecision.objective.admission, 'allowed');
  assert.equal(attempt.resources.find(resource => resource.id === WEEKLY_ID).demand_model.model_id,
    'continuous-gamma-v1', 'the durable issuance records the model that admitted the request');
});

test('M1 acceptance (b): heavy-owner replay holds early, then lends only late spare without reducing owner service', {timeout: 300_000}, async t => {
  let now = Date.now();
  const clock = () => now;
  const source = demandSource({clock, elapsed: 0.25, ownerWeeklyPoints: 80});
  let backend;
  const lane = await startLane(t, {source, model: HAIKU_MODEL, maxJobUsd: 191, clock,
    backend: root => (backend = recordNativeBudgets(meteringSandbox(root, {source, tokens: {input: 1000, output: 200},
      cost_usd: 1000, model: HAIKU_MODEL})))});
  now = Date.now();
  const early = await submitJob(lane, {budgetUsd: 20, name: 'heavy owner early request'});
  const held = await waitForOwnerReserve(lane);
  assert.equal(held.reason, 'owner_reserve');
  assert.equal(held.objective.reasonCode, 'objective_predictive_infeasible');
  assert.equal(held.status.id, 'reserve');
  assert.match(held.status.line, /reserve covers everything spare/);
  assert.equal(backend.calls.some(([kind]) => kind === 'run'), false, 'the early request never reaches the executor');
  await api(lane.owner.app, '/api/jobs/' + encodeURIComponent(early.jobDigest) + '/cancel',
    {method: 'POST', body: {circle: lane.circle.id}});

  const noLendingBaseline = [];
  noLendingBaseline.push(source.state.ownerUsed.weekly);
  now = now + Math.round(0.25 * WEEK_MS);
  source.setOwnerWeeklyPoints(90);
  noLendingBaseline.push(source.state.ownerUsed.weekly);
  assert.deepEqual(noLendingBaseline, [80 * MICRO, 90 * MICRO], 'the paired no-lending replay serves both owner events');
  assert.equal(source.state.used.weekly, 90 * MICRO, 'the held request spends no allowance before owner demand');
  now = Math.round(now + 0.49 * WEEK_MS);
  // After the owner's 90 points the spare is 100 - 90 - 1 = 9 points, or 180 USD. The request is 8.9 points. The whole-point unit
  // lowers spare by one point, so this request is sized to the declared-unit spare, not to the exact-meter 10 points.
  const late = await submitJob(lane, {budgetUsd: 178, name: 'heavy owner late request'});
  await waitForAccepted(lane, 'the late heavy-owner borrower result');

  const borrowerPoints = source.state.used.weekly - source.state.ownerUsed.weekly;
  assert.ok(borrowerPoints <= 9.5 * MICRO, `late borrower use ${(borrowerPoints / MICRO).toFixed(6)} points`);
  assert.equal(source.state.ownerUsed.weekly, 90 * MICRO, 'the owner receives the same 90 points as the no-lending baseline');
  assert.ok(source.state.used.weekly <= 100 * MICRO, 'the replay never exceeds the weekly allowance');
  const attempt = durableState(lane.lender).attempts.find(row => row.job_id === late.jobDigest);
  assert.equal(attempt.resources.find(resource => resource.id === WEEKLY_ID).demand_model.update_index, 1,
    'the early hold did not spend the first issuance');
});

test('M1 acceptance (c): current Haiku, Sonnet and Opus models admit priced work on day one', {timeout: 600_000}, async t => {
  const models = lendableModelsFor('claude');
  for (const [family, lendingRule] of [['haiku', 'legacy'], ['sonnet', 'legacy'], ['opus', 'legacy'],
    ['haiku', 'fluid'], ['sonnet', 'fluid'], ['opus', 'fluid']]) {
    await t.test(`${family} (${lendingRule})`, {timeout: 180_000}, async child => {
      const model = models.find(candidate => candidate.includes(family) && candidate.endsWith('-5-5'))
        ?? models.find(candidate => candidate.includes(family));
      assert.ok(model, `a current priced ${family} model is available`);
      let now = Date.now();
      const clock = () => now;
      const source = demandSource({clock, elapsed: 0, ownerWeeklyPoints: 0});
      const tokens = {...emptyTokens(), fresh_input: 1000, output: 200};
      const workload = priceListUsd(model, tokens);
      const headroom = claudeCallHeadroomUsd(model);
      assert.equal(workload.priced, true);
      assert.ok(Number.isFinite(headroom) && headroom > 0);
      let backend;
      const lane = await startLane(child, {source, model, maxJobUsd: 20, clock, lendingRule,
        backend: root => (backend = recordNativeBudgets(meteringSandbox(root, {source,
          tokens: {input: 1000, output: 200}, cost_usd: workload.usd, model})))});
      now = Date.now();
      await submitJob(lane, {model, budgetUsd: 20, name: `${family} day-one workload`});
      await waitForAccepted(lane, `${family} result acceptance`);

      assert.ok(backend.calls.some(([kind]) => kind === 'run'), `${family} reaches the stub executor`);
      assert.ok(Math.abs(backend.nativeBudgets[0] - (20 - headroom)) < 1e-9,
        `${family} native ceiling subtracts real worst-call headroom`);
      await lane.lender.app.close();
      await settleDurableAtBound({home:lane.lender.home,source,postingLagBoundMs:0});
      const attempt=durableState(lane.lender).attempts[0];
      assert.equal(attempt.process_state,'ceased');
      assert.ok(attempt.resources.every(resource => resource.held_micro === 0 && resource.unrepresented_micro === 0));
      const weekly = attempt.resources.find(resource => resource.id === WEEKLY_ID);
      if (lendingRule === 'fluid') {
        assert.equal(weekly.protection_source, 'injected_rule', `${family} durable issuance records the fluid rule`);
        return;
      }
      assert.equal(weekly.demand_model.prior_state.version, DEFAULT_PRIOR.version,
        'the first day uses the declared default prior without waiting for a whole window');
      assert.equal(weekly.demand_model.prior_state.alpha0, 2);
      assert.equal(weekly.demand_model.prior_state.b0, DEFAULT_PRIOR.b0);
      assert.equal(weekly.demand_model.prior_state.K, 1);
      assert.equal(weekly.demand_model.model_id, 'continuous-gamma-v1',
        `${family} durable issuance records the model that admitted the request`);
    });
  }
});

test('M1 acceptance (d): status names the lending reason and tracks an active reservation through settlement', {timeout: 240_000}, async t => {
  let now = Date.now();
  const clock = () => now;
  const source = demandSource({clock, elapsed: 0, ownerWeeklyPoints: 0});
  let backend;
  const lane = await startLane(t, {source, model: HAIKU_MODEL, maxJobUsd: 20, clock,
    backend: root => (backend = holdFirstStart(recordNativeBudgets(meteringSandbox(root, {source,
      tokens: {input: 1000, output: 200}, cost_usd: 0.01, model: HAIKU_MODEL}))))});
  now = Date.now();
  t.after(() => backend.releaseStart());
  await submitJob(lane, {budgetUsd: 20, name: 'status lifecycle workload'});
  await waitFor(() => backend.startEntered, 'the admitted job to reach the held stub executor');

  const active = await decisionFor(lane.lender);
  assert.equal(active.objective.reasonCode, 'objective_lend');
  assert.equal(active.objective.protectionSource, 'model');
  assert.equal(active.status.id, 'lend');
  assert.equal(active.status.line, LINES.lend);
  assert.match(active.objective.detail, /Lending .* points: .* spare after protecting your expected use\./);
  assert.match(active.objective.detail, /Protection source: model/);

  backend.releaseStart();
  await waitForAccepted(lane, 'the status workload to settle');
  await api(lane.lender.app, '/api/agents/refresh', {method: 'POST', body: {agents: ['claude-code-subscription']}});
  const settled = await decisionFor(lane.lender);
  assert.equal(settled.lastJobDecision.objective.reasonCode, 'objective_lend');
  assert.equal(settled.availability.reason, 'owner_reserve');
  assert.equal(settled.status.id, 'reserve');
  assert.equal(settled.status.line, LINES.reserve);
  assert.equal(durableState(lane.lender).attempts[0].process_state, 'ceased');
});

test('manual approval skips an unknown predictive estimate but keeps measured capacity and spend guards', {timeout: 420_000}, async t => {
  const acceptAsk = async (lane, jobOptions) => {
    const submitted = await submitJob(lane, jobOptions);
    const card = await waitFor(async () => (await api(lane.lender.app, '/api/approvals'))[0] ?? null,
      'the ask-mode review card', 30_000);
    assert.equal(card.requestAdmission.admission, 'allowed', 'unset daily caps do not disable hand approval');
    const config = await api(lane.lender.app, '/api/lending');
    assert.equal(config.mode, 'ask');
    // Ask removes only the rule the app made itself; a rule the owner wrote stays, and the request still waits for review.
    assert.deepEqual(config.standingRules.map(rule => rule.id), ['m1-acceptance-rule'], 'Ask retains exactly the owner rule');
    assert.deepEqual(config.standingRules, lane.expectedOwnerRules, 'Ask leaves owner rule contents unchanged');
    await api(lane.lender.app, '/api/approvals/' + card.id + '/accept', {method: 'POST', body: {}});
    return submitted;
  };
  const laneFor = async (child, {ownerWeeklyPoints = 0} = {}) => {
    let now = Date.now();
    const clock = () => now;
    const source = demandSource({clock, elapsed: 0.5, ownerWeeklyPoints});
    let backend;
    const lane = await startLane(child, {source, model: HAIKU_MODEL, maxJobUsd: 20, clock,
      demandModel: null, mode: 'ask',
      lendingQueueReader: async () => ({known: false}),
      backend: root => (backend = holdFirstStart(recordNativeBudgets(meteringSandbox(root, {source,
        tokens: {input: 1000, output: 200}, cost_usd: 0.01, model: HAIKU_MODEL}))))});
    now = Date.now();
    child.after(() => backend.releaseStart());
    return {...lane, backend};
  };

  await t.test('an unknown automatic estimate is reviewable and manual reserve uses meter plus guard', {timeout: 180_000}, async child => {
    const lane = await laneFor(child);
    const submitted = await acceptAsk(lane, {budgetUsd: 20, name: 'unknown model manual approval'});
    await waitFor(() => lane.backend.startEntered, 'the approved job to reach the held executor');
    const active = await decisionFor(lane.lender);
    assert.equal(active.status.id, 'lend');
    assert.equal(active.objective.strategyId, 'manual_approval');
    assert.match(active.objective.detail, /after your approval/);
    lane.backend.releaseStart();
    await waitForAccepted(lane, 'the manually approved job');
    assert.equal(lane.backend.calls.some(([kind]) => kind === 'run'), true,
      'the missing predictive model does not block the hand-approved job');
    assert.ok(lane.backend.nativeBudgets[0] > 0);
    assert.ok(lane.backend.nativeBudgets[0] <= 20 - claudeCallHeadroomUsd(HAIKU_MODEL));
    const decision=await decisionFor(lane.lender);
    await lane.lender.app.close();
    await settleDurableAtBound({home:lane.lender.home,source:lane.source,postingLagBoundMs:0});
    const attempt=durableState(lane.lender).attempts.find(row=>row.job_id===submitted.jobDigest);
    assert.equal(attempt.process_state, 'ceased');
    assert.ok(attempt.resources.every(resource => resource.held_micro === 0));
    assert.equal(attempt.resources.find(resource => resource.id === WEEKLY_ID).demand_model, undefined,
      'manual admission did not create a predictive-model issuance');
    assert.equal(decision.lastJobDecision?.objective?.strategyId,'manual_approval');
    assert.match(decision.lastJobDecision?.objective?.strategyExplanation, /measured spare capacity/);
  });

  await t.test('zero measured spare capacity still blocks a hand-approved request', {timeout: 120_000}, async child => {
    const lane = await laneFor(child, {ownerWeeklyPoints: 100});
    await acceptAsk(lane, {budgetUsd: 20, name: 'manual approval with no spare capacity'});
    const decision = await waitForDecision(lane.lender, row => row.reason === 'owner_reserve',
      'the definite zero-capacity hold');
    assert.equal(decision.admitted, false);
    assert.equal(lane.backend.calls.some(([kind]) => kind === 'run'), false);
    assert.equal(durableState(lane.lender).attempts.length, 0, 'a refused manual request persists no reservation');
  });

  await t.test('a signed budget below one worst-case call remains blocked', {timeout: 120_000}, async child => {
    const lane = await laneFor(child);
    const belowWorstCall = Math.ceil(claudeCallHeadroomUsd(HAIKU_MODEL)) - 1;
    assert.ok(belowWorstCall >= 1 && belowWorstCall < claudeCallHeadroomUsd(HAIKU_MODEL));
    await acceptAsk(lane, {budgetUsd: belowWorstCall, name: 'manual approval below the provider guard'});
    const decision = await waitForDecision(lane.lender, row => row.lastJobDecision?.reason === 'budget_too_small',
      'the signed budget guard');
    assert.equal(decision.lastJobDecision.admitted, false);
    assert.equal(lane.backend.calls.some(([kind]) => kind === 'run'), false);
    assert.equal(durableState(lane.lender).attempts.length, 0, 'a budget guard refusal persists no reservation');
  });
});
