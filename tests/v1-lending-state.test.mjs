import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveState } from '../lib/v1/lending-state.mjs';
const ready={intent:'on',now:20000,launchedAt:0,agents:[{id:'codex',enabled:true,installed:true,signedIn:true}]};
// A blocker from the ordered model (lib/v1/blockers.mjs): Docker's sign-in is gone. It holds claims; it never changes the intent.
const DOCKER_OUT={docker:{installed:true,running:true,signedIn:false},agents:[{id:'codex',name:'Codex',enabled:true,installed:true,signedIn:true}]};
const cases=[
  [{},'off'],[ready,'ready'],[{...ready,intent:'off',pause_until:30000},'off'],
  [{...ready,intent:'off',blocking:DOCKER_OUT},'off'],
  [{...ready,pause_until:30000,blocking:DOCKER_OUT},'paused'],
  [{...ready,pause_until:30000,current:'attempt'},'paused'],
  [{...ready,pause_until:19999},'paused'],[{...ready,pause_until:20000},'paused'],
  [{...ready,pause_until:NaN},'ready'],
  [{...ready,blocking:DOCKER_OUT,current:'attempt'},'blocked'],
  [{...ready,blocking:DOCKER_OUT,blockReason:'network_error'},'blocked'],
  [{...ready,blockReason:'network_error'},'blocked'],
  [{...ready,blockReason:'update_required'},'blocked'],
  [{...ready,agents:[]},'blocked'],
  [{...ready,agents:[{enabled:false,installed:true,signedIn:true}]},'blocked'],
  [{...ready,agents:[{enabled:true,installed:false,signedIn:true}]},'blocked'],
  [{...ready,agents:[{enabled:true,installed:true,signedIn:false}]},'blocked'],
  [{...ready,now:9999,factsKnown:false,agents:[]},'starting'],
  [{...ready,now:10000,factsKnown:false,agents:[]},'blocked'],
  [{...ready,factsKnown:false},'ready'],[{...ready,current:'attempt',launched:true},'running'],
  [{...ready,current:'attempt',launched:true,restingReason:'daily_limit'},'running'],
  [{...ready,restingReason:'daily_limit'},'resting'],
  [{...ready,restingReason:'quota_reserve'},'resting'],
  [{...ready,restingReason:'schedule'},'resting'],
  [{...ready,restingReason:'user_active'},'resting'],
];
for(const [index,[input,state]] of cases.entries())test('effective-state precedence '+index+' -> '+state,()=>{
  const before=structuredClone(input),result=effectiveState(input);
  assert.equal(result.state,state);assert.deepEqual(input,before);
  assert.equal(result.until,state==='paused'?input.pause_until:null);
});
test('partial sign-out and approvals are a separate axis',()=>{
  const input={...ready,agents:[...ready.agents,{id:'claude',enabled:true,installed:true,signedIn:false}],
    needs_you:[{kind:'approval',approvalId:'review'}]};
  const result=effectiveState(input);
  assert.equal(result.state,'ready');assert.equal(result.reason,null);
  assert.deepEqual(result.needs_you,[{kind:'approval',approvalId:'review'},{kind:'agent_signed_out',agent:'claude'}]);
  result.needs_you[0].kind='changed';assert.equal(input.needs_you[0].kind,'approval');
});
test('resting reset, blocker reason and actionable blocker item',()=>{
  assert.equal(effectiveState({...ready,restingReason:'daily_limit',restingUntil:90000}).until,90000);
  const blocked=effectiveState({...ready,blocking:DOCKER_OUT});
  assert.equal(blocked.reason,'sandbox_cannot_start');
  assert.deepEqual(blocked.needs_you,[{kind:'docker_signed_out'}]);
});

// Intent and execution are separate axes: a running job is never hidden by the intent.
const RUN={current:'attempt',launched:true,person:'Sam',stopsBy:Date.UTC(2026,9,19,15,1),timeZone:'UTC'};
const axes=[
  ['ready, job running',{...ready,...RUN},{state:'ready'},'running',"Lending is on · Sam's job is running, stops by 3:01 PM",'running'],
  ['paused, job finishing',{...ready,...RUN,pause_until:30000},{state:'paused',until:30000},'finishing',"Paused · Running jobs continue within their saved limits. It stops by 3:01 PM.",'paused'],
  ['off, job finishing',{...ready,...RUN,intent:'off'},{state:'off'},'finishing',"Lending is off · Running jobs continue within their saved limits. It stops by 3:01 PM.",'off'],
  ['blocked by Docker sign-in, job finishing',{...ready,...RUN,blocking:DOCKER_OUT},{state:'blocked',reason:'sandbox_cannot_start'},'finishing',"Lending stopped: sign in to Docker · Running jobs continue within their saved limits. It stops by 3:01 PM.",'blocked'],
  ['no agent, job finishing',{...ready,...RUN,agents:[]},{state:'blocked',reason:'no_accounts'},'finishing',"Lending stopped · Running jobs continue within their saved limits. It stops by 3:01 PM.",'blocked'],
  ['ready, stop requested',{...ready,...RUN,stopping:true},{state:'ready'},'stopping',"Lending is on · Stop requested for Sam's job",'running'],
  ['paused, stop requested',{...ready,...RUN,pause_until:30000,stopping:true},{state:'paused'},'stopping',"Paused · Stop requested for Sam's job",'paused'],
  ['rest does not hide a running job',{...ready,...RUN,restingReason:'daily_limit'},{state:'ready'},'running',"Lending is on · Sam's job is running, stops by 3:01 PM",'running'],
  ['no person known',{...ready,current:'attempt',launched:true},{state:'ready'},'running',"Lending is on · A job is running",'running'],
];
for(const [name,input,intent,execution,headline,legacy] of axes)test('intent/execution: '+name,()=>{
  const r=effectiveState(input);
  for(const [k,v] of Object.entries(intent))assert.equal(r.intent[k],v,k);
  assert.equal(r.execution.state,execution);assert.equal(r.headline,headline);
  assert.equal(r.state,legacy,'the old single state is unchanged for older clients');
  if(execution!=='idle'){assert.equal(r.execution.job,'attempt');assert.equal(r.execution.person,input.person??null);}
});
test('idle headlines per intent and blockers as a list',()=>{
  assert.equal(effectiveState(ready).headline,'Lending is on');
  assert.equal(effectiveState(ready).execution.state,'idle');
  assert.equal(effectiveState({...ready,pause_until:Date.UTC(2026,9,19,16),now:Date.UTC(2026,9,19,15),timeZone:'UTC'}).headline,'Paused until 4:00 PM');
  assert.equal(effectiveState({}).headline,'Lending is off');
  assert.equal(effectiveState({...ready,outsideNextStart:Date.UTC(2026,9,19,22),timeZone:'UTC'}).intent.state,'outside');
  assert.equal(effectiveState({...ready,updateRequired:true}).intent.state,'update');
  const partial=effectiveState({...ready,agents:[...ready.agents,{id:'claude',enabled:true,installed:true,signedIn:false}]});
  assert.equal(partial.intent.state,'ready');assert.deepEqual(partial.blockers,[{kind:'agent_signed_out',agent:'claude'}]);
  assert.deepEqual(effectiveState({...ready,agents:[]}).blockers,[{kind:'no_agents'}]);
});

test('a blocker is its own reason, blocker and need, and never changes the intent', () => {
  const r = effectiveState({ ...ready, blocking: DOCKER_OUT });
  assert.equal(r.state, 'blocked'); assert.equal(r.reason, 'sandbox_cannot_start'); assert.equal(r.intent.reason, 'sandbox_cannot_start');
  assert.equal(r.intent.on, true, 'the person\'s setting is still on');
  assert.deepEqual(r.blockers, [{ kind: 'docker_signed_out' }]); assert.deepEqual(r.needs_you, [{ kind: 'docker_signed_out' }]);
  assert.equal(r.lending_blockers.first.key, 'docker_signin');
  assert.deepEqual(r.lending_blockers.items.filter(x => x.key === 'agent').map(x => [x.status, x.waits_for]), [['waits', 'docker_signin']]);
  // Off stays off, and paused stays paused: the blocker is listed, not headlined over a choice.
  assert.deepEqual([effectiveState({ ...ready, intent: 'off', blocking: DOCKER_OUT }).state, effectiveState({ ...ready, intent: 'off', blocking: DOCKER_OUT }).intent.on], ['off', false]);
  assert.equal(effectiveState({ ...ready, pause_until: 30000, blocking: DOCKER_OUT }).state, 'paused');
  // No facts, no blocker: callers that do not know stay as they were.
  assert.equal(effectiveState({ ...ready }).state, 'ready');
});

// The order of the reasons follows the model: Docker installed, running, signed in; the sandbox test; the host; then agents.
test('the status reason is the first blocker of the ordered model', () => {
  const agents = [{ id: 'codex', name: 'Codex', enabled: true, installed: true, signedIn: true }];
  const reasonOf = blocking => effectiveState({ ...ready, blocking: {agents,...blocking} }).reason;
  assert.equal(reasonOf({ docker: { installed: false } }), 'sandbox_cannot_start');
  assert.equal(reasonOf({ docker: { installed: true, running: false, signedIn: false } }), 'sandbox_cannot_start', 'running before sign-in');
  assert.equal(reasonOf({docker: { installed: true, running: true, signedIn: false }}), 'sandbox_cannot_start', 'sign-in before the test');
  assert.equal(reasonOf({docker: {installed:true,running:true,signedIn:true},isolationFailure:'The sandbox could read your agent sign-in. Resume lending to try again.'}), 'sandbox_cannot_start');
  assert.equal(reasonOf({ docker: { installed: true, running: true, signedIn: true }, circle: { reachable: false, host: 'Ana' } }), 'circle_unreachable');
  assert.equal(reasonOf({ docker: { installed: true, running: true, signedIn: true }, circle: { hostVersion: '0.11.0', needVersion: '0.12.0' } }), 'cannot_run_here');
  assert.equal(reasonOf({ docker: { installed: true, running: true, signedIn: true } }), null);
  assert.equal(reasonOf({ docker: { installed: true, running: false }, circle: { reachable: false } }), 'sandbox_cannot_start', 'Docker before the host');
});

test('a finished job whose sandbox is not proven gone still reads as stopping, whatever the intent', () => {
  const r = effectiveState({ ...ready, intent: 'off', cessationPending: true });
  assert.deepEqual([r.intent.state, r.execution.state, r.execution.job], ['off', 'stopping', null]);
  assert.match(r.headline, /not confirmed yet/);
  assert.equal(effectiveState({ ...ready, cessationPending: false }).execution.state, 'idle');
});

// Dot server review of the state projection, P1: a running safety test or unknown Docker facts are not evidence that
// this computer can take a job. Unknown machine readiness must never project as ready or admission allowed.
test('unknown machine readiness never projects as ready or allowed',async()=>{
  const {projectLendingState}=await import('../lib/v1/state-projection.mjs');
  const agents=[{id:'codex',name:'Codex',enabled:true,installed:true,signedIn:true}];
  for(const [label,blocking] of [

    ['unknown Docker facts',{docker:{installed:null,running:null,signedIn:null},agents}],
    ['an unknown Docker sign-in',{docker:{installed:true,running:true,signedIn:null},agents}],
  ]) {
    const effective=effectiveState({...ready,blocking});
    assert.notEqual(effective.intent.state,'ready',label+' is not ready');
    assert.equal(effective.intent.on,true,label+' keeps the switch on');
    const projection=projectLendingState({effective,dailyLimitReached:false});
    assert.notEqual(projection.admission,'allowed',label+' is not admission allowed');
  }
  const passed=effectiveState({...ready,blocking:{docker:{installed:true,running:true,signedIn:true},agents}});
  assert.equal(passed.intent.state,'ready','known good machine facts are still ready');
});
test('a job already running is still running while machine facts are re-checked',()=>{
  const blocking={docker:{installed:true,running:true,signedIn:null},agents:[{id:'codex',name:'Codex',enabled:true,installed:true,signedIn:true}]};
  const unobserved=effectiveState({...ready,blocking,current:'attempt',launched:false});
  assert.equal(unobserved.intent.state,'starting');assert.equal(unobserved.execution.state,'idle');
  const launched=effectiveState({...ready,blocking,current:'attempt',launched:true});
  assert.equal(launched.execution.state,'running');
});
test('definite reasons still name themselves while machine facts are checked; the old answer says starting',()=>{
  const blocking={docker:{installed:true,running:true,signedIn:null},agents:[{id:'codex',name:'Codex',enabled:true,installed:true,signedIn:true}]};
  assert.equal(effectiveState({...ready,blocking,outsideNextStart:30000}).intent.state,'outside');
  assert.equal(effectiveState({...ready,blocking,restingReason:'daily_limit'}).intent.state,'resting');
  assert.deepEqual([effectiveState({...ready,blocking}).state,effectiveState({...ready,blocking}).reason],['starting','sandbox_check_pending']);
  assert.equal(effectiveState({...ready,blocking,current:'attempt',launched:true}).state,'running','a launched job is still running in the old answer');
});


test('expired timed pause remains Paused until the durable resume clears it',()=>{
  const status=effectiveState({...ready,pause_until:ready.now-1});
  assert.equal(status.state,'paused');assert.equal(status.intent.state,'paused');
});
test('in-flight timed resume remains Paused after the saved deadline is cleared',()=>{
  const status=effectiveState({...ready,resuming:true});
  assert.equal(status.state,'paused');assert.equal(status.intent.resuming,true);
  assert.match(status.headline,/Resuming/);
});
test('failed timed resume is visible and never reports On',()=>{
  const status=effectiveState({...ready,resumeError:'network_error'});
  assert.equal(status.state,'paused');assert.equal(status.intent.reason,'conditions_unavailable');
  assert.equal(status.intent.resumeError,'network_error');assert.match(status.headline,/could not resume/);
});

// The public reason is a closed list; the cause a person acts on stays in `blockers`, whose kinds are raw.
test('a host that is too old keeps its own next step beside the public reason',async()=>{
  const {opById}=await import('../lib/v1/ops/registry.mjs');
  const agents=[{id:'codex',enabled:true,installed:true,signedIn:true}];
  const status=effectiveState({intent:'on',agents,blocking:{docker:{installed:true,running:true,signedIn:true},agents,checking:{machine:false,agents:[]},
    readiness:{ready:true,checks:[]},circle:{name:'Friends',host:'Sam',owner:'Sam',reachable:true,hostVersion:'1.0.0',needVersion:'1.2.0'}}});
  assert.equal(status.intent.reason,'cannot_run_here');
  assert.deepEqual(status.blockers,[{kind:'circle_update_needed'}]);
  const circle=status.lending_blockers.items.find(item=>item.key==='circle');
  assert.match(circle.detail,/Ask Sam to update\./);
  const value=await opById('status.blockers').handler({call:async id=>id==='status.get'?status:id==='readiness.get'?{ready:true,checks:[]}:id==='agents.list'?[{id:'codex',useForLending:true,installed:true,signedIn:true}]:[]},{});
  assert.deepEqual(value.next_steps,['circle_update_needed: The circle host needs a newer Faravan.']);
});

test('a start that failed names itself in the summary while the public reason stays conditions_unavailable',async()=>{
  const {lendingSummary}=await import('../lib/v1/lending-summary.mjs');
  const status=effectiveState({...ready,blockReason:'lending_not_started'});
  assert.equal(status.intent.reason,'conditions_unavailable');
  assert.deepEqual(status.blockers,[{kind:'lending_not_started'}]);
  const projection={schemaVersion:2,kind:'lending',intent:'on',admission:'blocked',admissionReason:status.intent.reason,execution:'idle',executionJob:null,
    evidence:{intentState:'blocked',dailyLimitReached:false,executionState:'idle'},version:'fixture'};
  assert.equal(lendingSummary(projection,{startFailed:true,circleName:'Weekend projects'}).reason,'Lending couldn’t start for the circle “Weekend projects”. Check lending for what is blocking it.');
  assert.equal(lendingSummary(projection,{startFailed:true}).reason,'Lending couldn’t start. Check lending for what is blocking it.');
  assert.equal(lendingSummary(projection).reason,'Lending on this computer waits for the blocked step. You can still send jobs to another lender.');
});

test('a hold named by its public reason still offers the operation that clears it',async()=>{
  const {lendingSummary}=await import('../lib/v1/lending-summary.mjs');
  const hold=admissionReason=>({schemaVersion:2,kind:'lending',intent:'on',admission:'blocked',admissionReason,execution:'idle',executionJob:null,
    evidence:{intentState:'blocked',dailyLimitReached:false,executionState:'idle'},version:'fixture'});
  const signedOut=lendingSummary(hold('account_signed_out'));
  assert.deepEqual(signedOut.action,{label:'Sign in to the account',op:'signin.start'},'faravan status and MCP offer sign-in');
  assert.equal(lendingSummary(hold('lending_off')).action?.op,'agents.select','an unchosen agent is chosen, not lending turned on again');
  for(const reason of ['sandbox_cannot_start','no_accounts','provider_limit_reached','circle_access_refused','cleanup_pending'])
    assert.equal(lendingSummary(hold(reason)).action?.op,'status.blockers',reason+' reads what blocks lending');
  assert.equal(lendingSummary(hold('no_spare')).action,null,'a wait for spare allowance clears by itself');
});

test('a failed readiness requirement reads as Setup, not as a check still running',()=>{
  const agents=[{id:'codex',enabled:true,installed:true,signedIn:true}];
  const base={docker:{installed:true,running:true,signedIn:true},agents,checking:{machine:false,agents:[]},readiness:{ready:false,checks:[]}};
  const status=effectiveState({intent:'on',agents,blocking:{...base,readinessRequirements:[{cause:'sbx_version',label:'Docker Sandboxes is too old.',remedy:'Update Docker Sandboxes'}]}});
  assert.equal(status.intent.reason,'sandbox_cannot_start');
  assert.deepEqual(status.blockers,[{kind:'sandbox_not_ready'}],'the raw kind stays for the repair steps');
  assert.equal(effectiveState({intent:'on',agents,blocking:{docker:{installed:null,running:null,signedIn:null},agents,checking:{machine:false,agents:[]}}}).intent.reason,'sandbox_check_pending');
});
