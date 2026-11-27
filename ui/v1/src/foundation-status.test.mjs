import test from 'node:test';
import assert from 'node:assert/strict';
import {withLendingProjection} from './lending-projection.fixture.mjs';
import {lendingQuotaLinesVM} from './view-models.mjs';
for (const own of [false, true]) {
 test('running quota row reports only current ' + (own ? 'own' : 'friend') + ' execution',()=>{
  const running = withLendingProjection({
   lending:{enabled:true,current:'active-job',agent:'codex'},
   execution:{own}, needs_you:[],
  },{intent:'on',intentState:'ready',admission:'allowed',execution:'running',executionJob:'active-job'});
  const expected = {key:'codex',label:'Codex',text:(own ? 'Running your job.' : 'Lending to a friend now.') + ' The next request gets a fresh allowance check.'};
  assert.deepEqual(lendingQuotaLinesVM({accounts:[{provider:'codex'}]},false,running),[expected]);
  // Missing or unrelated accounts cannot vacuously satisfy the running-row assertion.
  assert.deepEqual(lendingQuotaLinesVM({accounts:[]},false,running),[]);
  const other = lendingQuotaLinesVM({accounts:[{provider:'claude'}]},false,running);
  assert.equal(other.length,1);
  assert.equal(other[0].key,'claude/quota');
  assert.notEqual(other[0].text,expected.text);
  // Ambiguous same-provider accounts must not be labelled as the executing account.
  const ambiguous = lendingQuotaLinesVM({accounts:[{provider:'codex'},{provider:'codex'}]},false,running);
  assert.equal(ambiguous.length,2);
  assert.ok(ambiguous.every(row=>row.key==='codex/quota' && row.text!==expected.text));
 });
}
import {blockersInput, blockersFor, agentRowVM, agentCheckVM, trackAgentChecks, agentSectionsVM, lendPageVM, needsYouItems, needsYouCount, machineVM, lendingSubtitle, agentsCheckedVM} from './view-models.mjs';

test('the lending subtitle states off without claiming that the computer lends',()=>{
 assert.equal(lendingSubtitle('sandpiper',[{id:'codex',useForLending:true}],[{id:'a',name:'Weekend projects'}],'a',false),'sandpiper · lending is off');
});
import {StepRow} from './blockers.jsx';
import {h} from 'preact';
import {renderFixture} from './render.test-helper.mjs';
const now=Date.parse('2026-10-20T05:00:00Z');
const stored={items:[{key:'docker_installed',label:'Docker Sandboxes',status:'ok',detail:'Installed and running.'},{key:'docker_signin',label:'Docker sign-in',status:'ok',detail:'Signed in.'},{key:'lending',label:'Lending',status:'ok',detail:'On.'}],first:null,canLend:true};
const status=withLendingProjection({lending:{enabled:true,circle:'test'},intent:{on:true,state:'ready'},lending_blockers:stored},
 {intent:'on',intentState:'ready',admission:'allowed'});
const agent={id:'claude-code-subscription',installed:true,signedIn:true,useForLending:true};
test('Tessa’s exact state: selected and signed-in agents stay visible; timeout never becomes Ready',()=>{
 const agents=[{...agent,signInState:'Check failed',checkedAt:new Date(now).toISOString(),remedy:'Starting a test workspace took too long. Check agents again.'},{id:'codex',installed:null,signedIn:null,useForLending:true}];
 const items=[...stored.items,...agents.map(a=>({key:'agent',agent:a.id,label:a.id,status:'unknown',detail:'Checking…'}))];
 const home={...status,lending_blockers:{...stored,items}};
 const bl=blockersFor({status:home,agents});
 const row=agentRowVM(agents[0],bl.byAgent[agent.id]);
 assert.equal(row.word,"Couldn't finish checking (slow sandbox start)");
 assert.equal(bl.byAgent[agent.id].detail,row.word+'.');
 assert.equal(row.canEnable,false);
 assert.deepEqual(agentSectionsVM(agents).shown,agents);
 assert.equal(agentSectionsVM(agents).other.length,0);
 assert.doesNotMatch(JSON.stringify(row),/Check failed|"Ready"/);
});
test('a newer successful observation beats an older timeout',()=>{
 const a={...agent,signInState:'Check failed',checkedAt:new Date(now-20000).toISOString(),evidence:[{fact:'signed_in',value:true,observed_at:new Date(now).toISOString()}]};
 assert.equal(agentCheckVM(a,now).ready,true);
});
test('checks keep last good evidence, expose elapsed rechecking after ten seconds and end with a definite result',()=>{
 const first=trackAgentChecks([agent],[{...agent,checking:true}],now);
 const second=trackAgentChecks(first,[{...agent,checking:true}],now+12000);
 assert.equal(second[0].checkStartedAt,now);
 assert.deepEqual([agentCheckVM(second[0],now+12000).word,agentCheckVM(second[0],now+12000).note],['Ready','Re-checking · 12 s']);
 assert.equal(trackAgentChecks(second,[agent],now+13000)[0].checkStartedAt,null);
});


test('badge and machine chip use the same attention list and hide attention when it is empty',()=>{
 const agents=[agent];const args={home:status,agents};
 assert.equal(needsYouItems(args).length,0);assert.equal(needsYouCount(args),0);
 const admitted={...status,lendingPolicy:{accounts:[{provider:'claude',decision:{availability:{admitted:true}}}]}};
 assert.equal(machineVM(admitted,{name:'sandpiper'},{agents}).line,'Ready for requests');
 assert.equal(machineVM(status,{name:'sandpiper'},{agents}).line,'Checking this computer…','lending on with no current reading is checking');
 const requests=[{id:'one'}];assert.equal(needsYouCount({...args,approvals:requests}),1);
});
test('machine chip and Home headline agree when a selected account is held for the owner',()=>{
 const held={provider:'claude',label:'Claude',decision:{admitted:false,reason:'objective_evidence_unknown',status:{id:'stopped',line:'Stopped for new jobs; running jobs continue within their saved limits.',recovery:{who:'owner'}}}};
 const home={...status,lendingPolicy:{accounts:[held]}};
 const page=lendPageVM(home,{agents:[agent]}),chip=machineVM(home,{name:'sandpiper'},{agents:[agent]});
 assert.equal(page.headline,'Check lending accounts');
 assert.equal(chip.line,page.headline);assert.equal(chip.kind,'need');
 // A hold that clears on its own is not attention, but it starts no new job either: both surfaces say "Lending on", and the chip's dot waits.
 const auto={...held,decision:{...held.decision,status:{...held.decision.status,recovery:{who:'automatic'}}}};
 const autoHome={...status,lendingPolicy:{accounts:[auto]}};
 assert.equal(lendPageVM(autoHome,{agents:[agent]}).headline,'Lending on');
 const autoChip=machineVM(autoHome,{name:'sandpiper'},{agents:[agent]});
 assert.equal(autoChip.line,'Lending on');assert.equal(autoChip.kind,'wait','a hold starts no new job: the dot is amber, not green');
});
test('StepRow supports a native Details child and a trailing action',()=>{
 const html=renderFixture(StepRow,{item:stored.items[2],children:h('details',null,h('summary',null,'Details'),'Stored run'),action:h('button',null,'Run again')});
 assert.match(html,/<details><summary>Details/);assert.match(html,/class="row-end"><button>Run again/);
});


test('Lending subtitle uses selected agents and the saved shared circle',()=>{
 assert.equal(lendingSubtitle('sandpiper',[agent,{id:'codex',useForLending:true}],[{id:'test',name:'Faravan test'}],'test'),'sandpiper · lends Claude Code and Codex to Faravan test');
 assert.equal(lendingSubtitle('sandpiper',[agent],[{id:'private',name:'My devices'}],'private'),'sandpiper · this computer');
});
test('computer checks fold independently of paused intent; pause times use the computer zone',()=>{
 const page=lendPageVM(withLendingProjection({...status,intent:{on:true,state:'paused',until:'2026-10-20T15:00:00Z'},lending:{enabled:true,limits:{timeZone:'UTC'}}},
  {intent:'paused',intentState:'paused',admission:'blocked',admissionReason:'paused'}),{agents:[agent],zone:'America/Chicago',now});
 assert.equal(page.checks.ready,true);assert.match(page.reason,/10:00 AM/);
});
test('agent outcome never announces a failed record as ready',()=>{
 assert.equal(agentsCheckedVM([{...agent,signInState:'Check failed'}]),'Checked. Claude Code couldn’t be checked.');
});


test('definite agent evidence also wins over a masked server row without replacing its machine primary',()=>{
 const safety={key:'isolation_check',label:'Sandbox isolation',status:'blocked',detail:'The sandbox could reach your home network. Check Docker Sandboxes, then resume lending.',action:'Resume lending'};
 const status={lending:{enabled:true},lending_blockers:{canLend:false,first:safety,items:[safety,{key:'agent',agent:'codex',label:'Codex',status:'waits',detail:'Waits for the sandbox safety test.'}]}};
 const model=blockersFor({status,agents:[{id:'codex',installed:true,signedIn:false,useForLending:true,signInReason:'credential_missing'}]});
 assert.equal(model.first.key,'isolation_check');assert.equal(model.needsYou[0].action,'Resume lending');
 assert.equal(model.byAgent.codex.status,'blocked');assert.equal(model.byAgent.codex.detail,'Signed out.');
});

test('an open-ended pause with a running job is Paused with a way to resume, never Off (r8 O6)',()=>{
 // The base carries the paused projection the server sends; the shared on/ready projection of `status` would
 // outrank the pause intent and hide the very state under test.
 const base=withLendingProjection({...status,intent:{on:true,state:'paused',until:null},lending:{enabled:false,status:'running',current:'j',limits:{timeZone:'UTC'}},
  execution:{state:'finishing',person:'Alex Example',stops_by:Date.parse('2026-10-20T15:00:00Z')}},
  {intent:'paused',intentState:'paused',admission:'blocked',admissionReason:'paused',execution:'finishing',executionJob:'j'});
 const page=lendPageVM(base,{agents:[agent],zone:'UTC'});
 // Execution outranks intent: the running job leads, and the page still says Paused; the running job finishes (exec.finishing).
 assert.equal(page.kind,'running');
 assert.equal(page.headline,'Finishing Alex Example’s job');
 assert.doesNotMatch(page.headline+page.reason,/Lending is off|Lending is on/);
 assert.equal(page.reason,'Paused. No new jobs start.','the pause stays visible beside the job that is allowed to finish');
 assert.equal(page.lendingProjection.intent,'paused','the running job does not turn the pause into on or ready');
 assert.equal(page.exec.finishing,true);assert.match(page.exec.text,/Alex Example’s job is finishing/);
});

// A held account with a fresh weekly reading: the reading is shown, the hold stays, and a passive wait is not "Needs you".
import {lentAgentState} from './view-models.mjs';
const freshNow=Date.parse('2026-11-22T04:18:00Z');
const deferred=(provider,used,extra={})=>({provider,decision:{admitted:false,reason:'probe_deferred',status:{id:'usage_estimate',line:'Usage estimate: lending uses available readings or the starting estimate; history improves it.'},
 windows:[{window_id:provider==='codex'?'codex:10080':'seven_day',state:'open',used_pct:used,observed_at:freshNow-51_000}],...extra}});
for (const [provider,used,id] of [['codex',40,'codex'],['claude',4,'claude-code-subscription']]) {
 test('held '+provider+' account with a fresh weekly reading shows the reading, not a missing one',()=>{
  const a={id,installed:true,signedIn:true,useForLending:true};
  const state=lentAgentState(a,deferred(provider,used),'UTC',freshNow);
  assert.equal(state.state,'holding');
  assert.doesNotMatch(state.reason,/waiting for a quota reading/i);
  assert.match(state.reason,new RegExp((100-used)+'% of your week left'));
  assert.match(state.reason,/does not mean|not yet|next request/i);
  const [line]=lendingQuotaLinesVM({accounts:[deferred(provider,used)]},false,status,{now:freshNow,zone:'UTC'});
  assert.doesNotMatch(JSON.stringify(line),/waiting for a quota reading/i);
  assert.match(JSON.stringify(line),new RegExp((100-used)+'%'));
 });
}
test('a held account with no fresh reading keeps the missing-reading copy',()=>{
 const a={id:'codex',installed:true,signedIn:true,useForLending:true};
 assert.match(lentAgentState(a,deferred('codex',40,{windows:[]}),'UTC',freshNow).reason,/waiting for a quota reading/i);
 const stale=deferred('codex',40);stale.decision.windows[0].observed_at=freshNow-2*86400000;
 assert.match(lentAgentState(a,stale,'UTC',freshNow).reason,/waiting for a quota reading/i);
});
test('a held account with a fresh reading still shows concrete reserve and identity holds',()=>{
 const a={id:'codex',installed:true,signedIn:true,useForLending:true};
 const reserve=deferred('codex',40,{reason:'owner_reserve',status:{id:'reserve',line:'Holding: your reserve covers everything spare.'}});
 assert.match(lentAgentState(a,reserve,'UTC',freshNow).reason,/reserve/i);
});
test('a passive automatic account wait is Waiting in the sidebar; a real owner action is still Needs you',()=>{
 const a={id:'codex',installed:true,signedIn:true,useForLending:true};
 const home={...status,needs_you:[],lendingPolicy:{accounts:[deferred('codex',40)]}};
 const chip=machineVM(home,{name:'sandpiper'},{agents:[a],now:freshNow,zone:'UTC'});
 assert.equal(chip.kind,'wait');assert.notEqual(chip.word,'Needs you');
 const withApproval=machineVM({...home,needs_you:[{kind:'approval'}]},{name:'sandpiper'},{agents:[a],now:freshNow,zone:'UTC'});
 assert.equal(withApproval.word,'Needs you');
 const automatic=deferred('codex',40,{status:{id:'usage_estimate',recovery:{who:'automatic'}}});
 const automaticWithApproval=machineVM({...home,needs_you:[{kind:'approval'}],lendingPolicy:{accounts:[automatic]}},
   {name:'sandpiper'},{agents:[a],now:freshNow,zone:'UTC'});
 assert.equal(automaticWithApproval.word,'Needs you');
 const owner=deferred('codex',40,{reason:'owner_settings',status:{id:'owner_settings',line:'Set the limit.',recovery:{who:'owner',action:'set the limit'}}});
 const needs=machineVM({...home,lendingPolicy:{accounts:[owner]}},{name:'sandpiper'},{agents:[a],now:freshNow,zone:'UTC'});
 assert.equal(needs.kind,'need');assert.equal(needs.word,'Needs you');
});
