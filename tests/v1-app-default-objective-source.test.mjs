import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, waitFor, syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {LINES} from '../lib/v1/lending-status-copy.mjs';
import {lendingStatusLines} from '../lib/v1/status.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';
import {minimumMaxJobUsdForModel} from '../lib/v1/lender-pace50.mjs';
import {createContinuousDemandModel} from '../lib/v1/lending-continuous-model.mjs';

const claudeAdapters = () => [{spec:legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true,
  harnessVersion: 'synthetic-only', models: ['claude-haiku-5-5'], capabilities: []}];
const askAutoAdapters = () => [...claudeAdapters(), {spec:legacyProxyHarness('codex'),installed:true,signedIn:true,
  harnessVersion:'synthetic-only',models:['gpt-6-luna'],capabilities:[]}];

test('normal app startup owns a durable objective candidate and reports a specific unavailable-source hold', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect({adapters: claudeAdapters});
  const stateFile = join(lender.home, 'v1', 'lending-pace50-state.json');

  assert.equal(fs.existsSync(stateFile), true, 'normal startup creates the durable candidate state');
  const claudeAgent = (await api(lender.app, '/api/agents')).find(agent => agent.id === 'claude-code-subscription');
  assert.ok(claudeAgent.lendable_models?.includes('claude-haiku-5-5'),
    'normal startup advertises priced models without the old opt-in flag');
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {
    dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false,
  }});
  await api(lender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/agents/claude-code-subscription/run', {method: 'POST', body: {model: 'claude-haiku-5-5', effort: null}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,
    git:{url:'https://github.com/example/synthetic.git',commit:'1'.repeat(40)},
    prompt:'Synthetic Claude admission: no external execution.',harness:'claude-code-subscription'}});
  const reason=await waitFor(async()=>{
    const view=await api(lender.app,'/api/lending');
    const decision=view.objective?.accounts?.find(row=>row.provider==='claude')?.decision;
    return decision?.reason&&decision.reason!=='objective_evidence_unknown'?decision:null;
  },'the normal startup path to report a specific provider hold');
  assert.equal(reason.reason,'refresh_failed');
  assert.equal(reason.objective.reasonText,LINES.measured);
  assert.equal(reason.status.line,LINES.measured);
  assert.equal(lender.backend.calls.some(([kind])=>kind==='run'),false,'source failure never reaches the sandbox');
  await api(lender.app, '/api/agents/refresh', {method:'POST', body:{agents:['claude-code-subscription']}});
  const refreshed = await api(lender.app, '/api/lending');
  const unavailable = refreshed.objective.accounts.find(row => row.provider === 'claude').decision.availability;
  assert.equal(unavailable.probe.reason, 'probe_unavailable', 'a missing runner remains unavailable after a background check');
  const route=await api(lender.app,'/api/lending');
  const op=await api(lender.app,'/api/ops/lending.get',{method:'POST',body:{}});
  // batch8a stamps each assessment with assessedAt. A fresh assessment between the two reads moves only that stamp.
  const withoutStamp = value => JSON.parse(JSON.stringify(value, (key, field) => key === 'assessedAt' ? undefined : field));
  assert.deepEqual(withoutStamp(op.objective),withoutStamp(route.objective),'the operation registry carries the same objective explanation');
  // The CLI status prints the same status line the API and the operation registry carry.
  assert.ok(lendingStatusLines(route).some(line=>line.includes(LINES.measured)),'the CLI status shows the same line');
  const status=await api(lender.app,'/api/status');
  const statusDecision=status.lendingPolicy?.accounts?.find(row=>row.provider==='claude')?.decision;
  assert.ok(statusDecision,'the status read exposes the per-provider objective reason');
  assert.deepEqual(statusDecision.objective,route.objective.accounts.find(row=>row.provider==='claude').decision.objective,
    'status and lending reads project the same objective answer');
  assert.equal(fs.existsSync(stateFile),true);
});

test('unset caps offer priced models while saved caps filter models by worst-call cost', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  const {lender} = await f.connect({adapters: claudeAdapters});
  const settings = await api(lender.app, '/api/lending/owner-settings');
  const before = (await api(lender.app, '/api/agents')).find(agent => agent.id === 'claude-code-subscription');
  const tooLarge = settings.minimums.find(row => row.model.includes('opus') && row.minimumMaxJobUsd > 4);
  const smallEnough = settings.minimums.filter(row => row.minimumMaxJobUsd <= 4).map(row => row.model);
  assert.equal(settings.defaultMaxJobUsd, 9.28);
  assert.equal(settings.values, null, 'no cap has been saved');
  assert.ok(tooLarge, 'Opus has a worst-call minimum above the $4 default cap');
  assert.deepEqual(before.lendable_models, settings.minimums.map(row => row.model), 'unset limits cover every priced model');
  await api(lender.app, '/api/lending/owner-settings', {method:'POST', body:{maxJobUsd:4, reason:'test saved cap'}});
  const capped = (await api(lender.app, '/api/agents')).find(agent => agent.id === 'claude-code-subscription');
  assert.deepEqual(capped.lendable_models, smallEnough, 'a saved cap still excludes models whose call does not fit');

  await api(lender.app, '/api/lending/owner-settings', {method: 'POST', body: {
    maxJobUsd: tooLarge.minimumMaxJobUsd, reason: 'test model-specific cap',
  }});
  const after = (await api(lender.app, '/api/agents')).find(agent => agent.id === 'claude-code-subscription');
  assert.ok(after.lendable_models.includes(tooLarge.model), 'raising the cap to this model minimum makes it available');
  assert.equal((await api(lender.app, '/api/lending/owner-settings')).defaultMaxJobUsd, settings.defaultMaxJobUsd,
    'changing the saved cap does not change the default');
  assert.equal(minimumMaxJobUsdForModel(tooLarge.model), tooLarge.minimumMaxJobUsd);
});

test('a fresh lender in per-job approval mode gets an objective lendable amount after one meter reading', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  const source = createSyntheticPace50Source({start: Date.now(), used: {weekly: 0, short: 0}});
  const objectiveInputFor = source.objectiveInputFor.bind(source);
  source.objectiveInputFor = async args => {
    const input = await objectiveInputFor(args);
    input.job.worstCallUsdMicro = Math.ceil(claudeCallHeadroomUsd(args.request.model) * 1_000_000);
    return input;
  };
  const observed = [];
  const observe = source.observe.bind(source);
  // An admission-only observation is a read of the saved reading (the real source answers it from its cache and never probes), so
  // only the observations that can reach the provider count as meter reads. The lender's own job-less check runs on its own
  // schedule and may land before or after the status read.
  source.observe = async args => { if (!args.admissionOnly) observed.push(args.provider); return observe(args); };
  const {lender, circle} = await f.connect({adapters: claudeAdapters,
    lendingPace50: {source, account_week_id: 'synthetic-week-1'}});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {
    dailyJobs: null, dailyMinutes: null, maxWallSeconds: null, idleOnly: false,
    lendingPolicy: {accountPlans: {claude: 'max20'}},
  }});
  await api(lender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  observed.length = 0;
  await api(lender.app, '/api/agents/refresh', {method: 'POST', body: {agents: ['claude-code-subscription']}});

  const view = await api(lender.app, '/api/lending');
  const account = view.objective.accounts.find(row => row.provider === 'claude');
  assert.equal(observed.filter(provider => provider === 'claude').length, 1, 'one fresh meter read feeds the status projection');
  assert.equal(account.decision.availability.admitted, true, JSON.stringify(account.decision.availability));
  assert.ok(account.decision.availability.objective.lendablePoints.seven_day > 0,
    'the objective exposes weekly quota open to lend');
  assert.equal(account.decision.objective.reasonText, LINES.ready + ' You approve each job before it starts.',
    'the explanation agrees with the ready lending card before any real job arrives');
});

test('status projects Ask and Auto with their own objective rules', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  const source = createSyntheticPace50Source({start: Date.now(), used: {weekly: 0, short: 0}});
  const automaticModes = [], automaticProviders = new Set();
  const objectiveInputFor = source.objectiveInputFor.bind(source);
  source.objectiveInputFor = async args => {
    automaticModes.push(args.context?.automatic);
    if (args.context?.automatic) automaticProviders.add(args.context.provider);
    if (args.context?.automatic === true) return {refuse: 'demand_model_unavailable'};
    return objectiveInputFor(args);
  };
  const {lender, circle} = await f.connect({adapters: askAutoAdapters,
    lendingPace50: {source, account_week_id: 'synthetic-week-1'}});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {
    dailyJobs: null, dailyMinutes: null, maxWallSeconds: null, idleOnly: false,
    lendingPolicy: {accountPlans: {claude: 'max20'}, providerConsent: {claude: true, codex: true}},
  }});
  await api(lender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  // Joining defaults to Automatic; this control explicitly chooses Ask.
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(lender.app, '/api/agents/refresh', {method: 'POST', body: {agents: ['claude-code-subscription','codex']}});
  automaticModes.length = 0;

  const ask = await api(lender.app, '/api/lending');
  const askAccount = ask.objective.accounts.find(row => row.provider === 'claude');
  assert.equal(ask.mode, 'ask');
  assert.equal(askAccount.decision.availability.admitted, true, 'Ask mode shows current capacity with per-job review');
  assert.ok(askAccount.decision.availability.objective.lendablePoints.seven_day > 0,
    'Ask mode shows the positive amount open to lend');
  assert.deepEqual(automaticModes, [], 'Ask mode does not request automatic demand evidence');

  automaticProviders.clear();
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/agents/refresh', {method: 'POST', body: {agents: ['claude-code-subscription','codex']}});
  const callsBeforeGet = automaticModes.length;
  const automatic = await api(lender.app, '/api/lending');
  const autoAccount = automatic.objective.accounts.find(row => row.provider === 'claude');
  assert.equal(automatic.mode, 'auto');
  assert.deepEqual([...automaticProviders].sort(), ['claude','codex'],
    'both signed-in account projections use automatic evidence when the cached revision is built');
  assert.equal(automaticModes.length, callsBeforeGet, 'GET reuses the same cached status revision');
  assert.equal(autoAccount.decision.availability.admitted, false,
    'a missing automatic estimate cannot borrow the positive manual estimate');
  assert.equal(autoAccount.decision.reason, 'demand_model_unavailable');
  assert.equal(autoAccount.decision.objective.reasonText, LINES.model_unavailable);
  assert.equal(autoAccount.decision.status.line, LINES.model_unavailable,
    'the card and objective explanation use the same automatic hold');
  assert.equal(autoAccount.decision.availability.objective.lendablePoints, undefined,
    'a held automatic estimate exposes no open quota amount');

  const infeasibleFixture = await appFixture(t);
  const infeasibleSource = createSyntheticPace50Source({start: Date.now(), used: {weekly: 98_000_000, short: 90_000_000}});
  const infeasibleModes = [];
  const infeasibleInputFor = infeasibleSource.objectiveInputFor.bind(infeasibleSource);
  infeasibleSource.objectiveInputFor = async args => {
    infeasibleModes.push(args.context?.automatic);
    if (args.context?.automatic !== true) return infeasibleInputFor(args);
    const supplied = await infeasibleInputFor(args);
    const modelDataByResource = Object.fromEntries(args.input.windows.map(window => [window.id, {
      originAtMs: window.anchor_at, initialOwnerUsedMicro: 0,
    }]));
    return {...supplied, demandModel: createContinuousDemandModel({alpha0: 2, b0: 90}),
      modelDataByResource, frozenProtectionSource: 'model'};
  };
  // The continuous demand model's own infeasible code is a legacy-path result; the fluid rule does not read that model.
  const {lender: infeasibleLender, circle: infeasibleCircle} = await infeasibleFixture.connect({adapters: claudeAdapters, lendingRule: 'legacy',
    lendingPace50: {source: infeasibleSource, account_week_id: 'synthetic-week-1'}});
  await api(infeasibleLender.app, '/api/lending/limits', {method: 'POST', body: {
    dailyJobs: null, dailyMinutes: null, maxWallSeconds: null, idleOnly: false,
    lendingPolicy: {accountPlans: {claude: 'max20'}, providerConsent: {claude: true}},
  }});
  await api(infeasibleLender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  await api(infeasibleLender.app, '/api/lending/on', {method: 'POST', body: {circle: infeasibleCircle.id}});
  await api(infeasibleLender.app, '/api/lending/mode', {method: 'POST', body: {circle: infeasibleCircle.id, mode: 'auto'}});
  infeasibleModes.length=0;
  await api(infeasibleLender.app, '/api/agents/refresh', {method:'POST',body:{agents:['claude-code-subscription']}});
  assert.ok(infeasibleModes.includes(true), 'the explicitly refreshed Claude projection uses automatic evidence');
  const infeasibleCallsBeforeGet = infeasibleModes.length;
  const automaticInfeasible = await api(infeasibleLender.app, '/api/lending');
  const infeasibleAccount = automaticInfeasible.objective.accounts.find(row => row.provider === 'claude');
  assert.equal(infeasibleAccount.decision.availability.admitted, false,
    'an infeasible automatic owner-use estimate remains held');
  assert.equal(infeasibleAccount.decision.availability.objective.reasonCode, 'objective_predictive_infeasible');
  assert.equal(infeasibleAccount.decision.status.line, LINES.reserve,
    'the status names the automatic protection hold');
  assert.equal(infeasibleAccount.decision.availability.objective.lendablePoints, null,
    'an infeasible automatic estimate exposes no open quota amount');
  assert.equal(infeasibleModes.length, infeasibleCallsBeforeGet, 'GET reuses the refreshed automatic hold');
});

test('Check again refreshes capacity; a cancelled shared read drains before shutdown and GET stays cache-only', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  let time=Date.now();
  const clock={now:()=>time};
  const source=createSyntheticPace50Source({start:time,used:{weekly:0,short:0}});
  const observe=source.observe.bind(source);
  let hold=false, entered, heldSignal, releaseHeld;
  const started=new Promise(resolve=>{entered=resolve;});
  source.observe=async args=>{
    if(!hold||args.forceRefresh!==true)return observe(args);
    heldSignal=args.signal;
    entered();
    return new Promise(resolve=>{releaseHeld=async()=>resolve(await observe(args));});
  };
  const {lender,circle}=await f.connect({clock,lendingNow:()=>time,adapters:claudeAdapters,
    lendingPace50:{source,account_week_id:'synthetic-week-1'}});
  t.after(async()=>{await releaseHeld?.();await lender.app.close();});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:null,dailyMinutes:null,maxWallSeconds:null,idleOnly:false,
    lendingPolicy:{accountPlans:{claude:'max20'}}}});
  await api(lender.app,'/api/agents/claude-code-subscription',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  time+=120_000;
  hold=true;
  const refresh=fetch(lender.app.origin+'/api/agents/refresh',{method:'POST',
    headers:{'x-faravan-session-token':lender.app.token,'content-type':'application/json'},
    body:JSON.stringify({agents:['claude-code-subscription']})});
  await started;
  assert.ok(heldSignal instanceof AbortSignal,'the explicit check carries its owned signal to the source');
  const waiting=await api(lender.app,'/api/lending');
  const waitingCapacity=waiting.objective.accounts.find(row=>row.provider==='claude').decision.availability;
  assert.equal(waitingCapacity.reason,'objective_evidence_unknown','GET stays responsive and does not use a pending refresh');

  let closed=false;
  const closing=lender.app.close().then(()=>{closed=true;});
  await waitFor(()=>heldSignal.aborted,'app shutdown aborts the shared capacity observation');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closed,false,'shutdown waits for the source callback and its owned work to drain');
  releaseHeld();
  await closing;
  const response=await refresh.catch(()=>null);
  if(response)assert.equal(response.status,503,'shutdown cancels the in-flight refresh response');
});

test('explicit capacity refresh forwards one signal through the probe and backend capability check', {timeout: 180000}, async t => {
  const f=await appFixture(t);
  const backend=syntheticBackend(f.root),probeCapabilities=backend.probeCapabilities.bind(backend);
  let capabilitySignal=null,runnerSignal=null;
  backend.probeCapabilities=async options=>{
    if(options?.signal)capabilitySignal=options.signal;
    return {...await probeCapabilities(),backend_id:'synthetic-only',version:'synthetic-version'};
  };
  const body={five_hour:{utilization:5,resets_at:new Date(Date.now()+5*3600000).toISOString()},
    seven_day:{utilization:10,resets_at:new Date(Date.now()+7*86400000).toISOString()},extra_usage:{is_enabled:false}};
  const runner=async({provider,signal})=>{
    assert.equal(provider,'claude');runnerSignal=signal;
    return {exitCode:0,stdout:JSON.stringify({faravan_probe:1,status:200,body,
      identity:{status:200,account_sha256_16:'1111222233334444',email_sha256_16:'aaaabbbbccccdddd'},
      guest_auth:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}}),
      executor:{backend_id:'synthetic-only',sbx_version:'synthetic-version'},
      stop:{delivered:true,fallback:null,latency_ms:1,removed:true}};
  };
  const {lender,circle}=await f.connect({backend,adapters:claudeAdapters,lendingProbeRunner:runner});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:null,dailyMinutes:null,maxWallSeconds:null,idleOnly:false,
    lendingPolicy:{accountPlans:{claude:'max20'}}}});
  await api(lender.app,'/api/agents/claude-code-subscription',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await api(lender.app,'/api/agents/refresh',{method:'POST',body:{agents:['claude-code-subscription']}});
  assert.ok(runnerSignal instanceof AbortSignal,'the explicit probe receives its owned abort signal');
  assert.ok(capabilitySignal instanceof AbortSignal,'backend capability preflight receives a cancellation signal');
});

test('a jobless Codex status in Auto is judged as the default run model, not refused for a missing model', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  const source = createSyntheticPace50Source({start: Date.now(), used: {weekly: 0, short: 0}});
  const {lender, circle} = await f.connect({adapters: askAutoAdapters,
    lendingPace50: {source, account_week_id: 'synthetic-week-1'}});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {
    dailyJobs: null, dailyMinutes: null, maxWallSeconds: null, idleOnly: false,
    lendingPolicy: {providerConsent: {claude: true, codex: true}},
  }});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/agents/refresh', {method: 'POST', body: {agents: ['codex']}});
  const view = await api(lender.app, '/api/lending');
  const codex = view.objective.accounts.find(row => row.provider === 'codex');
  assert.ok(codex, 'the Codex account has a status');
  assert.notEqual(codex.decision.reason, 'rule_evidence_request_identity_missing',
    'a status check that names no model is judged as the model a job would run');
  assert.notEqual(codex.decision.status.line, LINES.proof, 'the status names a specific reason');
  assert.notEqual(codex.decision.reason, 'budget_too_small', 'the synthetic status budget does not invent a per-job limit problem');
  const readiness = await api(lender.app, '/api/lending/readiness');
  const row = readiness.agents.find(agent => agent.id === 'codex');
  assert.deepEqual(row.checks.map(check => check.id), ['signed_in','account','subscription','job_control','usage_estimate']);
});

test('jobless readiness uses the same local probe reading as the weekly status without probing again', {timeout:180000}, async t => {
  const f=await appFixture(t);
  let calls=0;
  const runner=async ({provider})=>{
    assert.equal(provider,'codex'); calls++;
    return {exitCode:0,stdout:JSON.stringify({faravan_probe:1,status:200,
      body:{plan_type:'pro',spend_control:{reached:false},rate_limit:{allowed:true,limit_reached:false,secondary_window:null,
        primary_window:{used_percent:58,limit_window_seconds:604800,reset_after_seconds:259200}}},
      identity:{status:200,account_sha256_16:'1111222233334444',email_sha256_16:'aaaabbbbccccdddd'}}),
      host_read:true};
  };
  let executorMatches=true;
  // Stop proof is the machine's receipt, never part of a reading.
  const stopEvidenceStore={receipt:async()=>({backend_id:'synthetic-only',sbx_version:'synthetic-version',measured_at:Date.now(),
    delivered:true,fallback:null,latency_ms:1,removed:true})};
  const {lender,circle}=await f.connect({adapters:askAutoAdapters,lendingProbeRunner:runner,stopEvidenceStore,
    lendingExpectedIdentity:()=>({account_sha256_16:'1111222233334444'}),
    lendingExpectedExecutor:()=>({backend_id:'synthetic-only',accepts:version=>executorMatches && version==='synthetic-version'})});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await api(lender.app,'/api/agents/refresh',{method:'POST',body:{agents:['codex']}});
  const status=await api(lender.app,'/api/lending');
  assert.equal(status.objective.accounts.find(row=>row.provider==='codex').readings[0].used_pct,58);
  const before=calls;
  const row=(await api(lender.app,'/api/lending/readiness')).agents.find(a=>a.id==='codex');
  assert.equal(calls,before,'readiness never starts a probe');
  assert.equal(row.hasReading,true);
  // Required setup facts stay separate from the allowance estimate; no per-job read is promised.
  assert.deepEqual(row.checks.map(check=>check.state),['pass','pass','pass','pass','pass']);
  assert.equal(row.checks[4].id,'usage_estimate');
  assert.match(row.checks[4].note,/Usage estimate:/);
  assert.doesNotMatch(row.checks[4].note,/checks each job against the live meter/);
  executorMatches=false;
  const mismatch=(await api(lender.app,'/api/lending/readiness')).agents.find(a=>a.id==='codex');
  assert.equal(mismatch.checks.find(check=>check.id==='job_control').state,'unknown');
  assert.equal(calls,before,'checking the executor does not run another provider probe');
});
