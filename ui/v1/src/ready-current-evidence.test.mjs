import '../../../tests/helpers/home-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {agentRowVM, blockersFor, lendPageVM, lendingVerdictVM, setupVM} from './view-models.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';
import {lendingReadiness} from '../../../lib/v1/lending-readiness.mjs';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const AGENT = {id:'codex',installed:true,signedIn:true,useForLending:true};
const READINESS = {ready:true,checks:[
  {name:'sbx_install',ok:true},{name:'sbx_version',ok:true},
  {name:'sbx_daemon',ok:true},{name:'docker_login',ok:true},
]};
const CIRCLE = {id:'synthetic-circle',origin:'https://circle.invalid',name:'Test circle',
  enrollment:{state:'approved'},rosterMembershipVerified:true};
const clone = value => structuredClone(value);
function windows(c) {
  const at = c.observedAt ?? NOW, reset = c.resetAt ?? NOW+86400000;
  return [
    ...(c.missing ? [] : [{window_id:'weekly',window_minutes:10080,used_pct:c.used,
      observed_at:at,resets_at:reset,state:'open'}]),
    {window_id:'short',window_minutes:300,used_pct:4,
      observed_at:at,resets_at:NOW+3600000,state:'open'},
  ];
}
function current(c) {
  const admitted = c.admitted === true;
  const reason = admitted ? 'admitted' : c.reason ?? 'owner_reserve';
  return {admitted,reason,windows:windows(c),
    status:{id:admitted ? 'ready' : 'holding',
      line:admitted ? 'Ready for requests.' : 'Holding because current allowance is unavailable.',
      recovery:{who:'automatic'}},
    objective:{schemaVersion:1,policyVersion:'objective/m1',admission:admitted ? 'allowed' : 'held',
      reasonCode:reason,reasonText:admitted ? 'The request fits.' : 'Current evidence does not admit lending.',
      observedAt:new Date(c.observedAt ?? NOW).toISOString(),
      usedPoints:{weekly:c.used,short:4}},
  };
}
function accountFor(c) {
  const availability = current(c);
  return {id:'codex',provider:'codex',plan:'unknown',
    refresh_succeeded:c.refreshSucceeded !== false,
    identity:{account_id:c.mismatch ? 'different-synthetic-account' : 'synthetic-account'},
    readings:windows(c),decision:{...clone(availability),availability,windows:windows(c),lastJobDecision:null}};
}
function statusFor(accounts, {off = false, rowStatus = 'ok', rowDetail = 'Ready.'} = {}) {
  const server = {canLend:!off && rowStatus === 'ok',first:null,items:[
    {key:'docker_installed',status:'ok',detail:'Installed.'},
    {key:'docker_running',status:'ok',detail:'Running.'},
    {key:'docker_signin',status:'ok',detail:'Signed in.'},
    {key:'isolation_check',status:'ok',detail:'Passed.'},
    {key:'lending',status:off ? 'off' : 'ok',detail:off ? 'Off.' : 'On.'},
    {key:'agent',agent:'codex',status:rowStatus,detail:rowDetail},
  ]};
  const status = {state:off ? 'off' : 'ready',lending:{enabled:!off,status:'idle'},
    lendingPolicy:{accounts},lending_blockers:server};
  return off ? withLendingProjection(status,{
    intent:'off',intentState:'off',admission:'blocked',admissionReason:'off',
  }) : withLendingProjection(status);
}
function owner(status) {
  const blockers = blockersFor({status,agents:[AGENT],readiness:READINESS,now:NOW,zone:'UTC'});
  const account = status.lendingPolicy.accounts.find(a => a.provider === 'codex');
  return {blockers,row:agentRowVM(AGENT,blockers.byAgent.codex,{account,now:NOW}),
    verdict:lendingVerdictVM(status,blockers,'UTC',[AGENT]),
    page:lendPageVM(status,{agents:[AGENT],readiness:READINESS,now:NOW,zone:'UTC'})};
}

// Cause 1: these are public availability fixtures, not a second quota policy.
// Raw bad/stale readings are paired with their authoritative held decision.
test('[cause 1] T5 current evidence governs readiness, including zero and OFF controls', () => {
  const cases = [
    {name:'weekly zero admitted',used:0,admitted:true},
    {name:'weekly zero held',used:0,admitted:false},
    {name:'weekly 100',used:100},
    {name:'weekly above 100',used:101},
    {name:'weekly missing',missing:true,reason:'resources_incomplete'},
    {name:'weekly malformed',used:'not-a-percentage',reason:'usage_unknown'},
    {name:'weekly stale',used:0,observedAt:NOW-86400001,reason:'reading_stale'},
    {name:'failed refresh',used:0,refreshSucceeded:false,reason:'refresh_failed'},
    {name:'account mismatch',used:0,mismatch:true,reason:'identity_mismatch'},
    {name:'at reset boundary',used:0,resetAt:NOW,reason:'resource_reset_margin'},
  ];
  const actual = [], expected = [];
  for (const c of cases) {
    const {blockers,row,verdict,page} = owner(statusFor([accountFor(c)]));
    const admitted = c.admitted === true;
    actual.push({name:c.name,rowReady:row.state === 'ready',
      canLend:blockers.canLend,verdictReady:verdict.ready,
      readyHeadline:/\bready\b/i.test(page.headline)});
    expected.push({name:c.name,rowReady:admitted,canLend:admitted,
      verdictReady:admitted,readyHeadline:admitted});
    assert.equal(row.canEnable,true,c.name+': a quota hold must not masquerade as sign-out');
    assert.equal(page.switch.on,true,c.name+': a hold preserves the owner’s ON choice');
  }
  const off = owner(statusFor([accountFor({used:0,admitted:true})],{off:true}));
  assert.equal(off.page.switch.on,false);
  assert.equal(off.verdict.on,false);
  assert.equal(off.verdict.ready,false);
  assert.match(off.page.headline,/off/i);
  assert.equal(off.blockers.canLend,false);
  assert.deepEqual(actual,expected);
});

// Cause 1: neither the no-account path nor reconciliation may promote sign-in to capacity.
test('[cause 1] T5 missing availability stays pending and fresh sign-in does not clear a hold', () => {
  const missing = [
    {name:'no account',accounts:[]},
    {name:'no decision',accounts:[{provider:'codex'}]},
    {name:'no current availability',accounts:[{provider:'codex',decision:{
      ...current({used:0,admitted:true}),lastJobDecision:current({used:0,admitted:true}),
    }}]},
  ];
  const failures = [];
  for (const c of missing) {
    const {blockers,row,verdict,page} = owner(statusFor(c.accounts));
    if (blockers.canLend || verdict.ready || row.state === 'ready' ||
        /\bready\b/i.test(row.word) || /\bready\b/i.test(page.headline) ||
        !/check|unknown|unavailable|waiting|not confirmed/i.test([row.word,row.note].join(' '))) {
      failures.push({name:c.name,row:row.word,state:row.state,canLend:blockers.canLend,
        verdictReady:verdict.ready,headline:page.headline});
    }
  }
  for (const [rowStatus,rowDetail] of [
    ['ok','Ready.'], ['unknown','Checking…'], ['blocked','Signed out.'],
  ]) {
    const status = statusFor([accountFor({used:100})],{rowStatus,rowDetail});
    const {blockers} = owner(status);
    if (blockers.canLend || blockers.byAgent.codex?.status === 'ok')
      failures.push({name:'reconcile '+rowStatus,canLend:blockers.canLend,
        agentStatus:blockers.byAgent.codex?.status});
  }
  assert.deepEqual(failures,[]);
});

// Cause 1: "the weekly window was read" is a proof fact, not capacity permission.
test('[cause 1] T5 passing proof checks cannot produce a ready-to-lend setup headline at 100%', () => {
  const observation = {
    refresh_succeeded:true,identity:{verified:true,account_id:'synthetic-account'},
    account_week_id:'synthetic-week',epoch:'synthetic-epoch',complete:true,weekly_resource_id:'weekly',
    funding:{subscription_only:'proven'},executor:{single_executor:'proven'},
    stop:{bounded_execution:'proven'},stop_bound_ms:1,uncertainty_ms:0,
    resources:windows({used:100}).map(w => ({
      id:w.window_id,duration_ms:w.window_minutes*60000,used_micro:w.used_pct*1000000,
      observed_at:w.observed_at,resets_at:w.resets_at,state:w.state,kappa_micro:1,
    })),
  };
  const checks = lendingReadiness({provider:'codex',signedIn:true,observation});
  assert.ok(checks.every(check => check.state === 'pass'),
    'the fixture demonstrates that setup proofs pass even when capacity is exhausted');
  const status = statusFor([accountFor({used:100})]);
  const vm = setupVM({readiness:READINESS,agents:[AGENT],status,circle:CIRCLE,zone:'UTC',
    devices:{name:'Synthetic computer'},lendingReadiness:{agents:[{id:'codex',checks}]}});
  assert.doesNotMatch(vm.headline,/\bready\s+(?:for\s+requests|to\s+lend)\b/i);
  // Setup may remain complete; do not require vm.ready (setup completeness) to become false.
});

// Causes 1+2: current availability controls idle UI, never a retained accepted job.
test('[causes 1,2] T7 a retained admitted job cannot supply missing or held idle availability', () => {
  const past = current({used:0,admitted:true});
  const failures = [];
  for (const mode of ['held','missing']) {
    const account = accountFor({used:100});
    account.decision = {...clone(past),windows:windows({used:100}),lastJobDecision:clone(past)};
    if (mode === 'held') account.decision.availability = current({used:100});
    const {row,blockers,verdict,page} = owner(statusFor([account]));
    if (row.state === 'ready' || blockers.canLend || verdict.ready ||
        /\bready\b/i.test(page.headline))
      failures.push({mode,row:row.word,canLend:blockers.canLend,
        verdictReady:verdict.ready,headline:page.headline});
    assert.equal(account.decision.lastJobDecision.admitted,true,
      'retaining history is allowed; using it as current permission is not');
  }
  assert.deepEqual(failures,[]);
});
