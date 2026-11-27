import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {agentRowVM, blockersFor, lendPageVM, lendingVerdictVM, machineVM} from '../ui/v1/src/view-models.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {withLendingProjection} from '../ui/v1/src/lending-projection.fixture.mjs';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const AGENT = {id:'codex', installed:true, signedIn:true, useForLending:true};
const READY = {ready:true, checks:[
  {name:'sbx_install',ok:true}, {name:'sbx_version',ok:true},
  {name:'sbx_daemon',ok:true}, {name:'docker_login',ok:true},
]};
const iso = at => new Date(at).toISOString();
const windows = (used, at = NOW) => [
  {window_id:'weekly',window_minutes:10080,used_pct:used,
    observed_at:at,resets_at:NOW+86400000,state:'open'},
  {window_id:'short',window_minutes:300,used_pct:4,
    observed_at:at,resets_at:NOW+3600000,state:'open'},
];
function projection(admitted, used, at = NOW) {
  const reason = admitted ? 'admitted' : 'owner_reserve';
  return {admitted,reason,windows:windows(used,at),objective:{
    schemaVersion:1,policyVersion:'objective/m1',
    admission:admitted ? 'allowed' : 'held',reasonCode:reason,
    reasonText:admitted ? 'The request fits.' : 'No weekly capacity is available.',
    protectionSource:'weekly_upper_band',observedAt:iso(at),
    usedPoints:{weekly:used,short:4},
    resetsAt:{weekly:iso(NOW+86400000),short:iso(NOW+3600000)},
  }};
}
const unknown = () => ({admitted:false,reason:'objective_evidence_unknown',objective:null});
const accountOf = view => view.accounts.find(account => account.provider === 'codex');
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(),'faravan-ready-evidence-'));
  const runtime = createLendingRuntime({
    directory,backend:{},now:()=>NOW,
    settings:()=>({enabled:true,intent:'on',limits:{lendingPolicy:{}}}),
    presence:async()=>false,...options,
    pace50:{measurementHistory:{record:()=>null},...options.pace50},
  });
  t.after(async () => {
    try { await runtime.close(); }
    finally { await rm(directory,{recursive:true,force:true}); }
  });
  return runtime;
}
function ownerStatus(accounts) {
  return withLendingProjection({
    state:'ready',lending:{enabled:true,status:'idle'},lendingPolicy:{accounts},
    lending_blockers:{canLend:true,first:null,items:[
      {key:'docker_installed',status:'ok',detail:'Installed.'},
      {key:'docker_running',status:'ok',detail:'Running.'},
      {key:'docker_signin',status:'ok',detail:'Signed in.'},
      {key:'isolation_check',status:'ok',detail:'Passed.'},
      {key:'lending',status:'ok',detail:'On.'},
      {key:'agent',agent:'codex',status:'ok',detail:'Ready.'},
    ]},
  });
}

// Causes 1+2: current admission is authoritative even with a retained accepted job.
// This deliberately tests transport/presentation, not the quota engine's math.
test('[causes 1,2] T5/T7 current runtime hold reaches owner readiness, not the last job', async t => {
  const held = projection(false,100);
  const runtime = await fixture(t,{statusRead:async provider =>
    provider === 'codex' ? {windows:windows(100),refresh_succeeded:true} : null});
  runtime.candidate.projectStatus = async ({provider}) =>
    structuredClone(provider === 'codex' ? held : unknown());
  runtime.candidate.lastJobDecisionFor = provider =>
    provider === 'codex' ? projection(true,0,NOW-1000) : null;
  const view = await runtime.view(), account = accountOf(view);
  assert.equal(account.decision.lastJobDecision.admitted,true);
  assert.equal(runtime.busy('codex'),false);
  assert.equal(account.decision.availability.admitted,false);
  assert.notEqual(account.decision.availability.status.id,'ready');
  const status = ownerStatus(view.accounts);
  const blockers = blockersFor({status,readiness:READY,agents:[AGENT],now:NOW,zone:'UTC'});
  const row = agentRowVM(AGENT,blockers.byAgent.codex,{account,now:NOW});
  const verdict = lendingVerdictVM(status,blockers,'UTC',[AGENT]);
  assert.deepEqual({
    rowReady:row.state === 'ready',readyWord:/\bready\b/i.test(row.word),
    canLend:blockers.canLend,verdictReady:verdict.ready,
  },{rowReady:false,readyWord:false,canLend:false,verdictReady:false});
});

// Cause 3: use the real candidate with a fake source, not a mocked projectStatus.
// No cache-key assertion: the preserved public hold and one source call are the oracle.
test('[cause 3] T6 refresh and snapshot status agree for absent and explicit plans', async t => {
  const cases = [
    {name:'Codex absent',provider:'codex',plans:{}},
    {name:'Codex explicit unknown',provider:'codex',plans:{codex:'unknown'}},
    {name:'Codex real plan',provider:'codex',plans:{codex:'pro'}},
    {name:'Claude absent',provider:'claude',plans:{}},
    {name:'Claude explicit null',provider:'claude',plans:{claude:null}},
  ];
  const actual = [], expected = [];
  for (const c of cases) {
    let calls = 0;
    const probe = {reason:'provider_error',status_class:'5xx',
      provider:c.provider,failure_class:'other'};
    const runtime = await fixture(t,{
      settings:()=>({enabled:true,intent:'on',limits:{lendingPolicy:{accountPlans:c.plans}}}),
      pace50:{account:'synthetic-ready-test',account_week_id:'synthetic-week',source:{
        observe:async () => {
          calls++;
          return {refresh_succeeded:false,complete:false,resources:[],probe};
        },
      }},
    });
    const refreshed = await runtime.refreshCapacity(c.provider);
    const account = (await runtime.view()).accounts.find(a => a.provider === c.provider);
    const current = account.decision.availability;
    actual.push({name:c.name,refresh:refreshed.reason,current:current.reason,
      admitted:current.admitted,probe:current.probe,calls});
    expected.push({name:c.name,refresh:'refresh_failed',current:'refresh_failed',
      admitted:false,probe,calls:1});
  }
  assert.deepEqual(actual,expected);
});

// Cause 2: an admitted public result must contain one coherent set of evidence.
// A fix may preserve paired decision windows or fail closed; it need not expose a cache key.
test('[cause 2] T7 older and newer display snapshots cannot create mixed Ready', async t => {
  const mismatches = [];
  for (const [name,delta] of [['display newer',1000],['display older',-1000]]) {
    const admitted = projection(true,0,NOW);
    const runtime = await fixture(t,{now:()=>NOW+2000,statusRead:async provider =>
      provider === 'codex' ? {windows:windows(100,NOW+delta),refresh_succeeded:true} : null});
    runtime.candidate.projectStatus = async ({provider}) =>
      structuredClone(provider === 'codex' ? admitted : unknown());
    const account = accountOf(await runtime.view()), available = account.decision.availability;
    if (!available.admitted) {
      assert.notEqual(available.status.id,'ready',name);
      continue;
    }
    const observedAt = Date.parse(available.objective.observedAt);
    for (const [surface,rows] of [
      ['availability.windows',available.windows],
      ['decision.windows',account.decision.windows],
      ['account.readings',account.readings],
    ]) {
      const facts = (rows ?? []).map(w => [w.window_id,w.used_pct,
        typeof w.observed_at === 'number' ? w.observed_at : Date.parse(w.observed_at)]);
      const expected = [
        ['weekly',available.objective.usedPoints.weekly,observedAt],
        ['short',available.objective.usedPoints.short,observedAt],
      ];
      if (JSON.stringify(facts) !== JSON.stringify(expected)) mismatches.push({name,surface,facts,expected});
    }
  }
  assert.deepEqual(mismatches,[],'Ready must not join a decision to different display evidence');
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise,resolve};
}

// Cause 2: pause exactly after an old decision, then complete a newer held view first.
test('[cause 2] T7 an older async view cannot complete Ready after a newer hold', {timeout:5000}, async t => {
  const entered = deferred(), release = deferred();
  let current = projection(true,0), displayCalls = 0;
  const runtime = await fixture(t,{now:()=>NOW+2000,statusRead:async provider => {
    if (provider !== 'codex') return null;
    if (++displayCalls === 1) {
      entered.resolve();
      await release.promise;
      return {windows:windows(0,NOW),refresh_succeeded:true};
    }
    return {windows:windows(100,NOW+1000),refresh_succeeded:true};
  }});
  runtime.candidate.projectStatus = async ({provider}) =>
    structuredClone(provider === 'codex' ? current : unknown());
  const oldPending = runtime.view();
  let oldView, newerView, phase;
  try {
    phase = await Promise.race([
      entered.promise.then(() => 'paused'), oldPending.then(() => 'completed'),
    ]);
    current = projection(false,100,NOW+1000);
    newerView = await runtime.view();
  } finally {
    release.resolve();
    oldView = await oldPending;
  }
  assert.equal(accountOf(newerView).decision.availability.admitted,false);
  assert.equal(accountOf(await runtime.view()).decision.availability.admitted,false,
    'the newest held snapshot remains current');
  // A coherent implementation may stop consulting statusRead entirely. In that
  // case the old view already completed before the new one, so it is not stale.
  if (phase === 'paused') {
    assert.equal(accountOf(oldView).decision.availability.admitted,false,
      'a caller must not receive obsolete Ready after the newer hold completed');
    assert.notEqual(accountOf(oldView).decision.availability.status.id,'ready');
  }
});

// Guard against a "never Ready" regression: the real candidate, fed one complete fresh observation by a fake source,
// admits, and that admission reads Ready all the way through the runtime, the status and the view models.
const SYNTHETIC_IDS = {weekly:'codex:10080', short:'codex:300'};
const sourceWindows = (at = NOW) => [
  {window_id:SYNTHETIC_IDS.weekly,window_minutes:10080,used_pct:20,observed_at:at,resets_at:NOW+86400000,state:'open'},
  {window_id:SYNTHETIC_IDS.short,window_minutes:300,used_pct:40,observed_at:at,resets_at:NOW+3600000,state:'open'},
];
async function freshObservationFixture(t, display = sourceWindows()) {
  const runtime = await fixture(t,{
    settings:()=>({enabled:true,intent:'on',limits:{lendingPolicy:{accountPlans:{codex:'pro'}}}}),
    statusRead:async provider => provider === 'codex' ? {windows:structuredClone(display),refresh_succeeded:true} : null,
    pace50:{account:'synthetic-account',account_week_id:'synthetic-week-1',source:createSyntheticPace50Source({start:NOW})},
  });
  // The real candidate evaluates the fake source's observation; the status read then uses its cached, current answer.
  const refreshed = await runtime.refreshCapacity('codex');
  assert.equal(refreshed.admitted,true,refreshed.reason);
  return runtime;
}
function presentation(view) {
  const status = ownerStatus(view.accounts), account = accountOf(view);
  const blockers = blockersFor({status,readiness:READY,agents:[AGENT],now:NOW,zone:'UTC'});
  const row = agentRowVM(AGENT,blockers.byAgent.codex,{account,now:NOW});
  const verdict = lendingVerdictVM(status,blockers,'UTC',[AGENT]);
  const page = lendPageVM(status,{agents:[AGENT],readiness:READY,now:NOW,zone:'UTC'});
  const chip = machineVM(status,{name:'This computer'},{readiness:READY,agents:[AGENT],zone:'UTC'});
  return {canLend:blockers.canLend,rowState:row.state,rowWord:row.word,verdictReady:verdict.ready,
    pageHeadline:page.headline,chipLine:chip.line,chipKind:chip.kind};
}
const READY_PRESENTATION = {canLend:true,rowState:'ready',rowWord:'Ready',verdictReady:true,
  pageHeadline:'Ready for requests',chipLine:'Ready for requests',chipKind:'on'};

test('[real path] a fresh admitted reading from a fake source reads Ready through status and the view models', async t => {
  const runtime = await freshObservationFixture(t);
  const view = await runtime.view(), account = accountOf(view), available = account.decision.availability;
  assert.equal(available.admitted,true);
  assert.equal(available.reason,'objective_lend');
  assert.equal(Date.parse(available.objective.observedAt),NOW);
  assert.deepEqual(available.windows.map(w => w.observed_at),[NOW,NOW],'display windows carry the decision reading');
  assert.equal(account.decision.lastJobDecision,null);
  assert.deepEqual(presentation(view),READY_PRESENTATION);
});

// A job finished earlier leaves lastJobDecision on the account. Only retained history WITHOUT a fresh reading is missing
// evidence; a fresh admitted reading taken after the job is current and reads Ready.
test('[real path] a fresh admitted reading after a job still reads Ready beside its retained lastJobDecision', async t => {
  const runtime = await freshObservationFixture(t);
  runtime.candidate.lastJobDecisionFor = provider => provider === 'codex' ? projection(true,0,NOW-1000) : null;
  const view = await runtime.view(), account = accountOf(view);
  assert.equal(account.decision.lastJobDecision.admitted,true,'the job history is retained');
  assert.equal(account.decision.availability.admitted,true,'the fresh reading is current');
  assert.deepEqual(presentation(view),READY_PRESENTATION);
});

// A retained HELD job is the request status, but it was observed earlier than the fresh reading. Its top-level decision must not
// carry the fresh display windows: each published window carries its own decision's observation time, and fresh usage stays with
// the fresh availability.
test('[activity guard] a retained held job keeps its own observation; fresh usage stays with fresh availability', async t => {
  const runtime = await freshObservationFixture(t);
  runtime.candidate.lastJobDecisionFor = provider => provider === 'codex' ? projection(false,100,NOW-1000) : null;
  const view = await runtime.view(), account = accountOf(view), {decision} = account;
  assert.equal(decision.lastJobDecision.admitted,false,'the held job history is retained');
  assert.equal(decision.availability.admitted,true);
  assert.deepEqual(decision.availability.windows.map(w => w.observed_at),[NOW,NOW],'fresh availability keeps the fresh windows');
  const decisionAt = Date.parse(decision.objective.observedAt);
  assert.ok(decision.windows.every(w => w.observed_at === decisionAt),
    'every window published with the top-level decision carries that decision\'s reading');
  assert.deepEqual(presentation(view),READY_PRESENTATION);
});

// Activity guard: every published display window carries the decision's own observation time.
test('[activity guard] an extra display window from another reading cannot join an admitted decision', async t => {
  const runtime = await freshObservationFixture(t,[
    ...sourceWindows(),
    {window_id:'codex:extra',window_minutes:60,used_pct:1,observed_at:NOW+1000,resets_at:NOW+1800000,state:'open'},
  ]);
  const available = accountOf(await runtime.view()).decision.availability;
  assert.equal(available.admitted,false);
  assert.equal(available.reason,'usage_unknown');
  assert.notEqual(available.status.id,'ready');
});

test('[activity guard] a conflicting duplicate display window cannot join an admitted decision', async t => {
  const runtime = await freshObservationFixture(t,[
    ...sourceWindows(),
    {...sourceWindows(NOW+1000)[0]},
  ]);
  const available = accountOf(await runtime.view()).decision.availability;
  assert.equal(available.admitted,false);
  assert.equal(available.reason,'usage_unknown');
  assert.notEqual(available.status.id,'ready');
});

test('[activity guard] a priced window missing from the display set still fails closed', async t => {
  const runtime = await freshObservationFixture(t,[sourceWindows()[0]]);
  assert.equal(accountOf(await runtime.view()).decision.availability.admitted,false);
});
