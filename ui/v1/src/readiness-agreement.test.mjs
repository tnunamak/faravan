import '../../../tests/helpers/home-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {agentRowVM, blockersFor, computerReadiness, homePageVM, homeProviderQuotaVM, lendPageVM, lendingVerdictVM, machineVM, setupVM} from './view-models.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';
import {homeLendingSummary} from './home-lending.mjs';
import {lendingStatus} from '../../../lib/v1/lending-status-copy.mjs';
import {lendingReadiness} from '../../../lib/v1/lending-readiness.mjs';

// Every surface answers "can this computer lend right now?" from the same current evidence.
// These cases run one set of account evidence through all of them and require one answer.
const NOW = Date.parse('2026-11-07T12:00:00Z');
const CODEX = {id:'codex',installed:true,signedIn:true,useForLending:true};
const CLAUDE = {id:'claude-code-subscription',installed:true,signedIn:true,useForLending:true};
const READINESS = {ready:true,checks:[
  {name:'sbx_install',ok:true},{name:'sbx_version',ok:true},
  {name:'sbx_daemon',ok:true},{name:'docker_login',ok:true},
]};
const CIRCLE = {id:'synthetic-circle',origin:'https://circle.invalid',name:'Test circle',
  enrollment:{state:'approved'},rosterMembershipVerified:true};
const AUTOMATIC = {who:'automatic'};

const reading = (admitted, extra = {}) => ({admitted,
  reason:admitted ? 'objective_lend' : 'owner_reserve',
  status:{id:admitted ? 'ready' : 'holding',
    line:admitted ? 'Ready to lend.' : 'Holding for your own use.',recovery:AUTOMATIC},
  objective:{admission:admitted ? 'allowed' : 'held',reasonText:admitted ? 'The request fits.' : 'Held.'},
  windows:[],...extra});
const withAvailability = (provider, admitted) => ({provider,decision:{...reading(admitted),availability:reading(admitted),lastJobDecision:null}});
// Retained job history with no availability of its own: it is a record of a past job, not current evidence.
const historyOnly = provider => ({provider,decision:{...reading(true),lastJobDecision:reading(true)}});
// Retained REJECTED job history with no availability of its own: also a record of a past job, not current evidence.
const rejectedHistory = provider => ({provider,decision:{...reading(false),assessmentSource:'last_job',lastJobDecision:reading(false)}});
// A current hold the owner clears by raising the per-job limit.
const ownerLimit = provider => {
  const held = reading(false,{reason:'owner_limit_too_low'});
  held.objective = {...held.objective,reasonCode:'owner_limit_too_low'};
  held.status = {id:'holding',line:'Your per-job limit is below this request.',recovery:{who:'owner'}};
  return {provider,decision:{...held,availability:held,lastJobDecision:null}};
};
const EVIDENCE = {
  rejectedHistory,
  ownerLimit,
  admitted:provider => withAvailability(provider,true),
  held:provider => withAvailability(provider,false),
  bare:provider => ({provider}),
  history:historyOnly,
  none:() => null,
};
const accountsOf = (codex, claude) => [EVIDENCE[codex]('codex'),EVIDENCE[claude]('claude')].filter(Boolean);

function statusOf(accounts, agents) {
  const server = {canLend:true,first:null,items:[
    {key:'docker_installed',status:'ok',detail:'Installed.'},
    {key:'docker_running',status:'ok',detail:'Running.'},
    {key:'docker_signin',status:'ok',detail:'Signed in.'},
    {key:'isolation_check',status:'ok',detail:'Passed.'},
    {key:'lending',status:'ok',detail:'On.'},
    ...agents.map(agent => ({key:'agent',agent:agent.id,status:'ok',detail:'Ready.'})),
  ]};
  return withLendingProjection({state:'ready',lending:{enabled:true,status:'idle'},
    lendingPolicy:{accounts},lending_blockers:server});
}
const passingChecks = (provider, overrides = {}) => lendingReadiness({provider,signedIn:true,observation:{
  refresh_succeeded:true,identity:{verified:true,account_id:'synthetic-account'},
  account_week_id:'synthetic-week',epoch:'synthetic-epoch',complete:true,weekly_resource_id:'weekly',
  funding:{subscription_only:'proven'},executor:{single_executor:'proven'},
  stop:{bounded_execution:'proven'},stop_bound_ms:1,uncertainty_ms:0,
  resources:[{id:'weekly',duration_ms:604800000,used_micro:0,observed_at:NOW,resets_at:NOW+86400000,state:'open',kappa_micro:1},
    {id:'short',duration_ms:18000000,used_micro:0,observed_at:NOW,resets_at:NOW+3600000,state:'open',kappa_micro:1}],
  ...overrides,
}});

test('confirmed quota reads do not turn missing machine stop proof into a usage estimate', () => {
  for (const provider of ['claude', 'codex']) {
    const checks = passingChecks(provider, {stop:{}});
    const control = checks.find(check => check.id === 'job_control');
    assert.equal(checks.find(check => check.id === 'weekly_window')?.state, 'pass');
    assert.equal(control?.state, 'unknown');
    assert.match(control?.line ?? '', /job controls could not be confirmed/i);
    assert.match(control?.fix ?? '', /sandbox setup/i);
  }
  const blocker = lendingStatus({reason:'executor_unknown'});
  assert.equal(blocker.id, 'executor');
  assert.match(blocker.line, /job controls could not be confirmed/i);
  assert.match(blocker.recovery?.action ?? '', /sandbox setup.*try again/i);
  assert.doesNotMatch(blocker.line, /usage estimate/i);
  assert.equal(lendingStatus({reason:'conversion_unknown'}).id, 'usage_estimate');
  assert.equal(lendingStatus({admitted:true}).id, 'ready');
});

test('Setup and Lending prefer current Docker confirmation over a saved sign-in claim', () => {
  const base = statusOf([withAvailability('codex', true)], [CODEX]);
  const oldRow = {key:'docker_signin', label:'Docker sign-in', status:'blocked',
    detail:'Not signed in.', action:'Sign in to Docker', headline:'Lending stopped: sign in to Docker'};
  const status = {...base, summary:{headline:oldRow.headline, reason:oldRow.detail},
    lending_blockers:{items:[oldRow], first:oldRow, canLend:false}};
  const surfacesWith = check => {
    const readiness = {...READINESS, checks:READINESS.checks.map(row => row.name === 'docker_login' ? {...row,...check} : row)};
    const page = lendPageVM(status,{agents:[CODEX],readiness,now:NOW,zone:'UTC'});
    const setup = setupVM({status,agents:[CODEX],readiness,circle:CIRCLE,zone:'UTC'});
    return {page,setup};
  };
  const unavailable = surfacesWith({ok:false,unknown:true,cause:'docker_signin_refresh_unavailable'});
  assert.equal(unavailable.setup.headline, unavailable.page.headline);
  assert.equal(unavailable.page.headline, 'Checking Docker sign-in');
  assert.equal(unavailable.page.heroAction?.action, 'Check again');
  assert.deepEqual(unavailable.setup.steps.find(step => step.id === 'docker-account')?.actions, ['recheck']);
  assert.equal(unavailable.page.blockers.canLend, false);
  const signedOut = surfacesWith({ok:false,unknown:false});
  assert.equal(signedOut.setup.headline, signedOut.page.headline);
  assert.equal(signedOut.page.heroAction?.action, 'Sign in to Docker');
  assert.ok(signedOut.setup.steps.find(step => step.id === 'docker-account')?.actions?.includes('docker-signin'));
});

function surfaces(accounts, agents) {
  const status = statusOf(accounts,agents);
  const blockers = blockersFor({status,agents,readiness:READINESS,now:NOW,zone:'UTC'});
  const verdict = lendingVerdictVM(status,blockers,'UTC',agents);
  const page = lendPageVM(status,{agents,readiness:READINESS,now:NOW,zone:'UTC'});
  const chip = machineVM(status,{name:'This computer'},{readiness:READINESS,agents,zone:'UTC'});
  const setup = setupVM({readiness:READINESS,agents,status,circle:CIRCLE,zone:'UTC',devices:{name:'Synthetic computer'},
    lendingReadiness:{agents:agents.map(agent => ({id:agent.id,checks:passingChecks(agent.id === 'codex' ? 'codex' : 'claude')}))}});
  return {status,blockers,verdict,page,chip,setup,
    readiness:computerReadiness({status,projection:status.lendingProjection,agents})};
}
const answerOf = s => ({
  state:s.readiness.state,canLend:s.blockers.canLend,verdictReady:s.verdict.ready,
  pageReady:s.page.headline === 'Ready for requests',
  setupReady:s.setup.headline === 'This computer is ready to lend',
  chipReady:s.chip.line === 'Ready for requests',
});
const READY = {state:'ready',canLend:true,verdictReady:true,pageReady:true,setupReady:true,chipReady:true};
const NOT_READY = state => ({state,canLend:false,verdictReady:false,pageReady:false,setupReady:false,chipReady:false});

// Rules: current holding evidence is never Ready (R1); one current admitted lent account is enough (R2);
// no current evidence is Checking while lending is on (R3).
const CASES = [
  {name:'both admitted',codex:'admitted',claude:'admitted',expected:READY},
  {name:'admitted and held',codex:'admitted',claude:'held',expected:READY},
  {name:'held and admitted',codex:'held',claude:'admitted',expected:READY},
  {name:'admitted and no account',codex:'admitted',claude:'none',expected:READY},
  {name:'admitted and a bare account',codex:'admitted',claude:'bare',expected:READY},
  {name:'admitted and retained history only',codex:'admitted',claude:'history',expected:READY},
  {name:'admitted and owner-limit held',codex:'admitted',claude:'ownerLimit',expected:READY},
  {name:'owner-limit held and admitted',codex:'ownerLimit',claude:'admitted',expected:READY},
  {name:'admitted and retained rejected history only',codex:'admitted',claude:'rejectedHistory',expected:READY},
  {name:'owner-limit held and no account',codex:'ownerLimit',claude:'none',expected:NOT_READY('holding')},
  {name:'both held',codex:'held',claude:'held',expected:NOT_READY('holding')},
  {name:'held and no account',codex:'held',claude:'none',expected:NOT_READY('holding')},
  {name:'held and retained history only',codex:'held',claude:'history',expected:NOT_READY('holding')},
  {name:'no accounts',codex:'none',claude:'none',expected:NOT_READY('checking')},
  {name:'bare accounts',codex:'bare',claude:'bare',expected:NOT_READY('checking')},
  {name:'retained history only',codex:'history',claude:'history',expected:NOT_READY('checking')},
  {name:'retained rejected history only',codex:'rejectedHistory',claude:'rejectedHistory',expected:NOT_READY('checking')},
  {name:'held and retained rejected history only',codex:'held',claude:'rejectedHistory',expected:NOT_READY('holding')},
];

test('every readiness surface agrees on the same current evidence', () => {
  const actual = [], expected = [];
  for (const c of CASES) {
    const fixture = surfaces(accountsOf(c.codex,c.claude),[CODEX,CLAUDE]);
    assert.equal(homeLendingSummary(fixture.page), fixture.page.headline, c.name);
    actual.push({name:c.name,...answerOf(fixture)});
    expected.push({name:c.name,...c.expected});
  }
  assert.deepEqual(actual,expected);
});

test('every readiness surface agrees for a single lent agent', () => {
  const single = [
    {name:'admitted',codex:'admitted',expected:READY},
    {name:'held',codex:'held',expected:NOT_READY('holding')},
    {name:'no account',codex:'none',expected:NOT_READY('checking')},
    {name:'bare account',codex:'bare',expected:NOT_READY('checking')},
    {name:'retained history only',codex:'history',expected:NOT_READY('checking')},
    {name:'retained rejected history only',codex:'rejectedHistory',expected:NOT_READY('checking')},
  ];
  const actual = [], expected = [];
  for (const c of single) {
    const accounts = [EVIDENCE[c.codex]('codex')].filter(Boolean);
    actual.push({name:c.name,...answerOf(surfaces(accounts,[CODEX]))});
    expected.push({name:c.name,...c.expected});
  }
  assert.deepEqual(actual,expected);
});

// Finding 3: the sidebar chip is one of the surfaces.
test('the machine chip reads Checking with lending on and no account evidence', () => {
  const s = surfaces([],[CODEX]);
  assert.deepEqual({line:s.chip.line,kind:s.chip.kind,word:s.chip.word},
    {line:'Checking this computer…',kind:'wait',word:'Checking'});
});

// Finding 4: an account without current evidence is checking, not an owner-action hold.
test('an account with no current evidence reads Checking, not Needs attention', () => {
  for (const shape of ['bare','history']) {
    const s = surfaces(accountsOf(shape,'none'),[CODEX]);
    assert.equal(s.page.headline,'Checking this computer…',shape);
    assert.equal(s.verdict.headline,'Checking this computer…',shape);
    assert.equal(s.page.accountHold,false,shape);
    assert.equal(s.page.ownerHold,false,shape);
    assert.equal(s.verdict.accountHold,null,shape);
    assert.equal(s.chip.kind,'wait',shape);
    assert.equal(s.readiness.perAccount.find(a => a.agent === 'codex').evidence,'missing',shape);
  }
});

// Finding 5 / R2: the held account keeps its own wait; the computer is ready.
test('one admitted account makes the computer ready and the held account keeps its own wait', () => {
  const s = surfaces(accountsOf('admitted','held'),[CODEX,CLAUDE]);
  assert.equal(s.readiness.state,'ready');
  assert.deepEqual(s.readiness.perAccount.map(a => [a.agent,a.evidence]),
    [['codex','admitted'],['claude-code-subscription','held']]);
  assert.equal(s.page.accountHold,false);
  const claude = s.page.agentStates.find(a => a.name === 'Claude Code');
  assert.deepEqual([claude.kind,claude.state === 'lending'],['wait',false]);
  assert.equal(s.blockers.byAgent['claude-code-subscription'].holding,true);
});

// R1 for the pure derivation: holding evidence wins over missing evidence, and lending off keeps today's sign-in rows.
test('current holding evidence is holding; with lending off missing evidence is left to the sign-in rows', () => {
  const held = surfaces(accountsOf('held','none'),[CODEX,CLAUDE]);
  assert.equal(held.readiness.state,'holding');
  const off = withLendingProjection(statusOf([],[CODEX]),{intent:'off',intentState:'off',admission:'blocked',admissionReason:'off'});
  const verdict = computerReadiness({status:off,projection:off.lendingProjection,agents:[CODEX]});
  assert.equal(verdict.state,'inactive');
  assert.equal(verdict.perAccount[0].evidence,'missing');
  const blockers = blockersFor({status:off,agents:[CODEX],readiness:READINESS,now:NOW,zone:'UTC'});
  assert.equal(blockers.byAgent.codex.status,'ok','sign-in rows are unchanged while lending is off');
  assert.equal(blockers.canLend,true);
});

test('a signed-out lent agent is sign-in, not checking', () => {
  const signedOut = {...CODEX,signedIn:false};
  const status = statusOf([],[signedOut]);
  const verdict = computerReadiness({status,projection:status.lendingProjection,agents:[signedOut]});
  assert.equal(verdict.state,'signin');
});

// The agent row reads the same classified evidence as every other surface.
test('each agent row shows the state its classified evidence gives', () => {
  const rowOf = (s, agent) => {
    const row = agentRowVM(agent,s.blockers.byAgent[agent.id],{now:NOW,lendingOn:true,
      account:s.status.lendingPolicy.accounts.find(a => a.provider === (agent.id === 'codex' ? 'codex' : 'claude'))});
    return [row.state,row.word === 'Checking' || row.state === 'ready' ? row.word : 'wait text',row.kind];
  };
  const byEvidence = {
    admitted:['ready','Ready','on'], held:['reserved','wait text','wait'], ownerLimit:['holding','wait text','wait'],
    bare:['checking','Checking','wait'], history:['checking','Checking','wait'], rejectedHistory:['checking','Checking','wait'],
  };
  const actual = [], expected = [];
  for (const evidence of Object.keys(byEvidence)) {
    const s = surfaces(accountsOf(evidence,evidence),[CODEX,CLAUDE]);
    actual.push({evidence,codex:rowOf(s,CODEX),claude:rowOf(s,CLAUDE)});
    expected.push({evidence,codex:byEvidence[evidence],claude:byEvidence[evidence]});
  }
  assert.deepEqual(actual,expected);
});

test('Home quotas keep a zero reading and never guess across stale or ambiguous accounts', () => {
  const weekly = (provider, used_pct, observed_at = NOW - 2000) => ({provider, decision:{availability:{
    windows:[{window_id: provider === 'claude' ? 'seven_day' : 'codex:10080', state:'open', used_pct, observed_at}],
  }}});
  const claude = weekly('claude', 100), codex = weekly('codex', 62);
  const view = (accounts, options = {}, agents = [CLAUDE, CODEX]) =>
    homeProviderQuotaVM({lendingPolicy:{accounts}}, agents, {now:NOW, zone:'UTC', ...options});
  assert.deepEqual(view([codex, claude]).map(row => [row.title, row.meter?.value]),
    [['Claude Code', '0%'], ['Codex', '38%']]);
  assert.deepEqual(view([claude, codex, weekly('codex', 40)]).map(row => row.meter?.value), ['0%', undefined]);
  assert.deepEqual(view([claude, weekly('codex', 62, NOW - 86400000)]).map(row => row.meter?.value), ['0%', undefined]);
  assert.ok(view([claude, codex], {stale:true}).every(row => row.meter === null));
  assert.deepEqual(view([claude, codex], {}, [CODEX]).map(row => row.provider), ['codex']);
});

test('Home uses the same Docker confirmation row as Lending', () => {
  const agents = [CODEX];
  const home = statusOf(accountsOf('admitted', 'none'), agents);
  const readiness = {ready:false, checks:READINESS.checks.map(check => check.name === 'docker_login'
    ? {...check, ok:false, unknown:true, cause:'docker_signin_state_unavailable'}
    : check)};
  const options = {agents, readiness, now:NOW, zone:'UTC'};
  const lending = lendPageVM(home, options);
  const overview = homePageVM({home, ...options});
  const blocker = lending.blockers.needsYou.find(item => item.key === 'docker_signin');
  assert.equal(blocker?.action, 'Check again');
  assert.deepEqual(overview.blockerItems.find(entry => entry.item.key === 'docker_signin')?.item, blocker);
});

test('Home, Lending, and the computer chip show a scheduled listing retry as checking', () => {
  const agents = [CODEX];
  const home = statusOf(accountsOf('admitted', 'none'), agents);
  delete home.lending_blockers;
  home.lendingProjection = {...home.lendingProjection, admission:'blocked', admissionReason:'machine_checking'};
  const readiness = {ready:false,checks:[{name:'sbx_daemon',ok:false,unknown:true,
    reason:'machine_checking',label:'Checking the sandbox service again.'}]};
  const options = {readiness, agents, now:NOW, zone:'UTC'};
  const lending = lendPageVM(home, options);
  assert.equal(lending.headline, 'Checking this computer…');
  assert.equal(lending.checks.ready, false);
  assert.deepEqual(lending.blockers.needsYou, []);
  assert.deepEqual(homePageVM({home,...options}).blockerItems, []);
  assert.equal(machineVM(home, {}, options).line, lending.headline);
});
