import '../../../tests/helpers/home-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {agentRowVM, agentSectionsVM, blockersFor, homePageVM, lendPageVM, needsYouCount, setupVM} from './view-models.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';

// A lent agent whose automatic checks used their budget says so wherever its readiness shows, and the sentence
// names the button that sits next to it on that surface.
const NOW = Date.parse('2026-11-07T12:00:00Z');
const READINESS = {ready:true,checks:[{name:'sbx_install',ok:true},{name:'sbx_version',ok:true},{name:'sbx_daemon',ok:true},{name:'docker_login',ok:true}]};
const CIRCLE = {id:'synthetic-circle',origin:'https://circle.invalid',name:'Test circle',enrollment:{state:'approved'},rosterMembershipVerified:true};
const SERVER_LINE = 'Automatic checks stopped after 3 failures. Press Check agents to try again.';
const line = button => 'Automatic checks stopped after 3 failures. Press ' + button + ' to try again.';
const stopped = {id:'codex',installed:true,signedIn:null,proxySignedIn:null,ownerSignedIn:true,useForLending:true,
  signInState:"Can't check",signInReason:'proxy_unconfirmed',remedy:SERVER_LINE,automaticChecksStopped:true,checking:false};
const unstopped = {...stopped,automaticChecksStopped:undefined,remedy:'Check agents to retry.'};
const serverStatus = item => withLendingProjection({state:'ready',lending:{enabled:true,status:'idle'},lendingPolicy:{accounts:[]},
  lending_blockers:{canLend:false,first:null,items:[
    {key:'docker_installed',status:'ok',detail:'Installed.'},{key:'docker_running',status:'ok',detail:'Running.'},
    {key:'docker_signin',status:'ok',detail:'Signed in.'},{key:'isolation_check',status:'ok',detail:'Passed.'},{key:'lending',status:'ok',detail:'On.'},
    item]}});
const unknownItem = {key:'agent',agent:'codex',status:'unknown',detail:SERVER_LINE,action:'Check agents',automaticChecksStopped:true};
const codexItem = model => model.items.find(item => item.agent === 'codex');

test('the readiness list says the checks stopped and names the per-agent button beside it', () => {
  const model = blockersFor({status:serverStatus(unknownItem),agents:[stopped],readiness:READINESS,now:NOW,zone:'UTC'});
  const item = codexItem(model);
  assert.equal(item.detail, line('Check Codex'));
  assert.equal(item.action, 'Check Codex');
  assert.equal(item.automaticChecksStopped, true);
});

test('the same sentence reaches the Lend page blockers', () => {
  const page = lendPageVM(serverStatus(unknownItem),{agents:[stopped],readiness:READINESS,now:NOW,zone:'UTC'});
  assert.equal(codexItem(page.blockers).detail, line('Check Codex'));
});

test('without the server row, the client model still carries the stop', () => {
  const status = withLendingProjection({state:'ready',lending:{enabled:true,status:'idle'},lendingPolicy:{accounts:[]}});
  const model = blockersFor({status,agents:[stopped],readiness:READINESS,now:NOW,zone:'UTC'});
  assert.equal(codexItem(model).detail, line('Check Codex'));
});

test('Setup reads the same row', () => {
  const status = serverStatus(unknownItem);
  const setup = setupVM({readiness:READINESS,agents:[stopped],status,circle:CIRCLE,zone:'UTC',devices:{name:'Synthetic computer'}});
  const step = setup.steps.find(row => row.id === 'agent:codex');
  assert.equal(step.detail, 'Automatic checks stopped after 3 failures. Open Lending and press Check agents again to try again.');
  assert.equal(step.link.href, '#/lend');
  assert.equal(step.retryLendingChecks, undefined);
});

test('the agent row on Lend shows the stop beside its own Check button', () => {
  const row = agentRowVM(stopped, null, {now:NOW});
  assert.equal(row.note, line('Check Codex'));
  assert.equal(row.canCheck, true);
});

test('the agents section names its own Check agents again button', () => {
  assert.equal(agentSectionsVM([stopped]).stoppedNote, line('Check agents again'));
  assert.equal(agentSectionsVM([unstopped]).stoppedNote, undefined);
});

test('after a Check lifts the stop, the usual wording returns', () => {
  const model = blockersFor({status:serverStatus({...unknownItem,detail:'Checking…',automaticChecksStopped:undefined,action:undefined}),agents:[unstopped],readiness:READINESS,now:NOW,zone:'UTC'});
  assert.doesNotMatch(codexItem(model).detail, /Automatic checks stopped/);
  assert.equal(agentRowVM(unstopped, null, {now:NOW}).note, '');
});

test('Home lists the stopped agent as something to fix, with the per-agent button wording', () => {
  const home = serverStatus(unknownItem);
  const vm = homePageVM({home, readiness:READINESS, agents:[stopped], jobs:[], approvals:[], now:NOW, zone:'UTC'});
  const card = vm.blockerItems.find(({item}) => item.agent === 'codex');
  assert.equal(card?.item.detail, line('Check Codex'));
  assert.equal(card.item.action, 'Check Codex');
  assert.equal(needsYouCount({home, readiness:READINESS, agents:[stopped], zone:'UTC'}), 1);
  const lifted = homePageVM({home:serverStatus({...unknownItem,detail:'Checking…',automaticChecksStopped:undefined,action:undefined}),
    readiness:READINESS, agents:[unstopped], jobs:[], approvals:[], now:NOW, zone:'UTC'});
  assert.equal(lifted.blockerItems.some(({item}) => item.automaticChecksStopped), false);
});

// The owner's sign-in is remembered (ownerSignedIn) and the proxy never confirmed it. Lend reads this row through
// lendingAgentVM, so the stop stands; Home must read it the same way.
const rememberedOwner = {...stopped,lendingSignInTarget:'codex',lendingSignInSupported:true,signedIn:true,signInState:'Signed in',signInReason:undefined};
test('Home still shows the stop when the owner sign-in is remembered but the proxy did not confirm it', () => {
  const home = serverStatus(unknownItem);
  const vm = homePageVM({home, readiness:READINESS, agents:[rememberedOwner], jobs:[], approvals:[], now:NOW, zone:'UTC'});
  const card = vm.blockerItems.find(({item}) => item.agent === 'codex');
  assert.equal(card?.item.detail, line('Check Codex'));
  assert.equal(card.item.action, 'Check Codex');
  assert.ok(needsYouCount({home, readiness:READINESS, agents:[rememberedOwner], zone:'UTC'}) >= 1);
});
