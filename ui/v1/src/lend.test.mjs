import { currentCapacityWait } from '../../../lib/v1/lending-summary.mjs';
import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const storedPass = {id:'test-run',state:'passed',at:'2026-10-19T09:12:00Z',current:{runId:'test-run',at:'2026-10-19T09:12:00Z',configuration:{versions:{faravan:'0.12.0',sbx:'0.48.0',probe:{version:1,digest:'fixture'},adapters:{}},agents:['claude-code-subscription','codex']}}};
import {h, render} from 'preact';
import {act} from 'preact/test-utils';
import {Window} from 'happy-dom';
import {Lend, AgentCard} from './lend.jsx';
import {AccountCard, WhoRules} from './lending-policy-view.jsx';
import {renderFixture, assertDomOrder, assertNoBannedWords, renderedText} from './render.test-helper.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';

// U3 render tests: the Lending page as a string, no browser. Synthetic data only.
const now = Date.now();
const circles = [{id:'weekend', name:'Weekend projects', origin:'http://x', rosterMembershipVerified:true}];
const agents = [
  {id:'claude-code-subscription', useForLending:true, installed:true, signedIn:true, run:{model:'Sonnet', effort:'medium'}, product:{}},
  {id:'codex', useForLending:true, installed:true, signedIn:true, run:{}, product:{}},
];
const lending = {enabled:true, circle:'weekend', mode:'ask', status:'idle', paused:false, current:null,
  limits:{timeZone:'UTC', dailyJobs:null, dailyMinutes:null, maxWallSeconds:null, quotaReserve:30}};
const props = (home = {}, extra = {}) => ({
  api:{}, agents, lending, circles, circle:'weekend', selected:circles[0], members:[], refresh() {}, setDialog() {}, setCircle() {},
  mutate: async () => ({}), data:{readiness:{ready:true,checks:[]},home:{state:'ready',lending:extra.lending ?? lending,...home}, approvals:[], activity:[]}, ...extra,
});
const page = (home, extra) => renderFixture(Lend, props(home, extra));

test('native sign-in is visibly owner-only and has no lending switch',()=>{
 const out=page({}, {agents:[{id:'codex',installed:true,signedIn:true,useForLending:true,auth_strategy:'provider-file-generation',credential_in_guest:true}]});
 assert.match(renderedText(out),/This sign-in is only for your own jobs and is never lent/);
 assert.match(renderedText(out),/access and refresh tokens/);
 assert.doesNotMatch(out,/aria-label="Lend with Codex"/);
 assert.doesNotMatch(renderedText(out),/agent’s API key|Available inside each job/);
 const failed=page({}, {agents:[{id:'codex',installed:true,signedIn:true,useForLending:false,
   auth_strategy:'provider-file-generation',signInState:'Check failed',checkedAt:new Date(now).toISOString()}]});
 assert.doesNotMatch(renderedText(failed),/Signed in for your own jobs/);
 assert.match(renderedText(failed),/Couldn’t finish checking|Couldn't finish checking/);
});

test('the ready page: hero, agents, limits, who can use it, in order', () => {
  const out = page({lendingPolicy:{accounts:[{provider:'claude',decision:{availability:{admitted:true}}},{provider:'codex',decision:{availability:{admitted:true}}}]}});
  assertDomOrder(out, ['class="headline">Ready for requests', 'A new request is checked against the quota available when it arrives.', 'Agents you lend', 'id="agent-claude-code-subscription"', 'id="agent-codex"',
    'What you lend', '<h2>Lends to</h2>', '<span class="row-title">Weekend projects</span>']);
  assert.match(withoutMaskMarkers(out), /role="switch" class="switch xl" aria-checked="true" aria-label="Lending"/);
  assert.match(withoutMaskMarkers(out), /class="switch xl"/);
  assert.match(renderedText(out), /Jobs per day No cap Minutes per day No cap Time per job Must fit before reset Keep for yourself 30% of your weekly Claude allowance/);
  assert.doesNotMatch(out, /Weekly sharing cap/);
  assert.doesNotMatch(out, /Weekly sharing cap[^<]*(?:button|href=)/i, 'the unavailable cap has no edit action');
  assert.match(out, /href="#\/lend\/limits"/);
  assertNoBannedWords(out);
});

test('the lending card uses the selected account’s objective hold', () => {
  const objective = {admission:'held', reasonCode:'owner_settings_unreadable',
    reasonText:'Holding — your saved per-job limit cannot be read. This needs you: save the per-job limit again.'};
  const current = {admitted:false, reason:'owner_settings_unreadable', objective,
    status:{id:'owner_settings', line:objective.reasonText}};
  const snapshot = {accounts:[{provider:'codex', decision:{admitted:true,
    objective:{admission:'allowed', reasonCode:'objective_lend', reasonText:'Ready to lend to a friend when a job arrives.'},
    status:{id:'ready', line:'Ready to lend to a friend when a job arrives.'}, availability:current,
    lastJobDecision:{admitted:true, reason:'objective_lend'}}}]};
  const out = page({lendingPolicy:snapshot}, {agents:[{id:'codex',useForLending:true,installed:true,signedIn:true,run:{}}]});
  const text = renderedText(out);
  assert.match(text, /Check lending accounts/);
  assert.match(text, /Holding — your saved per-job limit cannot be read\. This needs you: save the per-job limit again\./);
  assert.doesNotMatch(text, /Ready for requests/);
});

test('the Lend page shows open quota for each account and window, or its hold reason', () => {
  const snapshot = {accounts:[
    {provider:'claude', decision:{availability:{admitted:true, objective:{lendablePoints:{seven_day:24.2,five_hour:8.6}}},
      windows:[{window_id:'seven_day',window_minutes:10080},{window_id:'five_hour',window_minutes:300}]}},
    {provider:'codex', decision:{status:{line:'Ready to lend to a friend when a job arrives.'},
      availability:{admitted:false, objective:{lendablePoints:{'codex:10080':null}},
        status:{line:'Holding — the last quota reading could not be checked.'}},
      windows:[{window_id:'codex:10080',window_minutes:10080}]}}
  ]};
  const text = renderedText(page({lendingPolicy:snapshot}));
  assert.match(text, /Allowance/);
  assert.match(text, /Claude Code · this week: About 24\.2% of this week's quota is open to lend now; you approve each job\./);
  assert.match(text, /Claude Code · this 5-hour window: About 8\.6% of this 5-hour window's quota is open to lend now; you approve each job\./);
  assert.match(text, /Codex · this week: Holding — the last quota reading could not be checked\./);
});

test('the Lend page shows no quota line for an account this computer does not lend', () => {
  const snapshot = {accounts:[
    {provider:'claude', decision:{availability:{admitted:true, objective:{lendablePoints:{seven_day:24.2}}},
      windows:[{window_id:'seven_day',window_minutes:10080}]}},
    {provider:'codex', decision:{availability:{admitted:false, status:{line:'Waiting for your first quota reading. It clears on its own when it arrives.'}}}}
  ]};
  const text = renderedText(page({lendingPolicy:snapshot}, {agents:[{id:'claude-code-subscription',useForLending:true,installed:true,signedIn:true,run:{}},
    {id:'codex',useForLending:false,installed:true,signedIn:true,run:{}}]}));
  assert.match(text, /Claude Code · this week: About 24\.2%/);
  assert.doesNotMatch(text, /Codex · /);
});

test('the Lend page keeps an early settings hold visible when no meter windows are available', () => {
  const line = 'Holding — your saved per-job limit cannot be read. This needs you: save the per-job limit again.';
  const snapshot = {accounts:[{provider:'claude', decision:{admitted:false, reason:'owner_settings_unreadable',
    status:{line}, availability:{admitted:false, reason:'owner_settings_unreadable', status:{line}, objective:{reasonText:line}},
    windows:[]}}]};
  const text = renderedText(page({lendingPolicy:snapshot}));
  assert.match(text, /Claude Code · quota: Holding — your saved per-job limit cannot be read/);
});

test('Ask adds per-job approval; Auto with consent shows the same open amount without it', () => {
  const snapshot = {accounts:[{provider:'claude', decision:{availability:{admitted:true,
    objective:{lendablePoints:{seven_day:18.4}}}, windows:[{window_id:'seven_day',window_minutes:10080}]}}]};
  const policy = providerConsent => ({...lending, limits:{...lending.limits,
    lendingPolicy:{providerConsent:{claude:providerConsent}}}});
  const ask = renderedText(page({lendingPolicy:snapshot}, {lending:{...policy(false), mode:'ask'}}));
  assert.match(ask, /About 18\.4% of this week's quota is open to lend now; you approve each job\./);
  const automatic = renderedText(page({lendingPolicy:snapshot}, {lending:{...policy(true), mode:'auto'}}));
  assert.match(automatic, /About 18\.4% of this week's quota is open to lend now\./);
  assert.doesNotMatch(automatic, /you approve each job/);
});

test('the page offers controls for this computer only', () => {
  const text = renderedText(page());
  assert.doesNotMatch(text, /Remind me|20 more minutes|another computer/);
  assert.equal((page().match(/aria-label="Lending"/g) || []).length, 1, 'one lending switch');
  assert.equal((page().match(/aria-label="Learn from my local agent logs"/g) || []).length, 1, 'one local-log switch, for this computer');
  assert.equal((page().match(/role="switch"/g) || []).length, 4, 'lending, local-log learning, plus one switch per agent, none per circle');
});

test('the agent list says what choosing an agent starts', () => {
  assert.match(renderedText(page()), /In circles set to Automatic, friends’ jobs start on their own within your limits once an agent is chosen\./);
});

test('"Lends to" has one radio row per circle, with purpose or approval mode', () => {
  const one = page();
  assert.match(one, /class="lending-circle-row"/);assert.match(renderedText(one),/Selected/);assert.match(one,/type="radio"/);
  assert.match(renderedText(one), /Weekend projects Ask me each time/);
  const two = [...circles, {id:'crew', name:'Booking site crew', purpose:'Build our booking site', origin:'http://x', rosterMembershipVerified:true}];
  const out = page({lending:{...lending, enabled:false}, state:'off'}, {circles:two, lending:{...lending, enabled:false}});
  assert.match(out, /role="radiogroup" aria-label="Choose a circle"/);
  assert.equal((out.match(/type="radio"/g)||[]).length,2);
  assert.equal((out.match(/class="row-title">Weekend projects</g)||[]).length,1);
  assert.match(renderedText(out), /Weekend projects Ask me each time/);
  assert.match(renderedText(out), /Booking site crew Build our booking site/);
  const inputs=out.match(/<input[^>]+>/g).filter(tag=>tag.includes('type="radio"'));
  assert.match(inputs.find(tag=>tag.includes('value="weekend"')),/ checked(?:[ =/>])/);
  assert.doesNotMatch(inputs.find(tag=>tag.includes('value="crew"')),/ checked(?:[ =/>])/);
  assert.ok(inputs.every(tag=>tag.includes('name="lending-circle"')),'native radio group provides arrow-key navigation');
  const picker=out.slice(out.indexOf('class="card lending-circles"'));
  assert.doesNotMatch(picker, /<select|<option/);
  assert.match(renderedText(out),/Choose which circle your computer lends to\./);
  assert.doesNotMatch(renderedText(out), /Switching circles is not available here yet/);
  const auto=page({circles:[{id:'weekend',lendingMode:'auto'}]});
  assert.match(renderedText(auto), /Weekend projects Automatic: rules and limits decide/);
});

test('circle radios cannot switch an enabled lender or a running job',()=>{
  const two=[...circles,{id:'crew',name:'Booking site crew',origin:'http://x',rosterMembershipVerified:true}];
  for(const state of [lending,{...lending,enabled:false,current:'job'}]){
    const out=page({},{circles:two,lending:state});
    const inputs=(out.match(/<input[^>]+>/g)||[]).filter(tag=>tag.includes('type="radio"'));
    assert.equal(inputs.length,2);assert.ok(inputs.every(tag=>/ disabled(?:[ =/>])/.test(tag)));
  }
});

test('a partial block keeps the switch on and lists the signed-out agent among the steps, with its sign-in', () => {
  const out = page({lendingProjection:{schemaVersion:2,kind:'lending',intent:'on',admission:'blocked',admissionReason:'agent_signed_out',execution:'idle',executionJob:null,
      evidence:{intentState:'ready',dailyLimitReached:false,executionState:'idle'},version:'fixture'},needs_you:[{kind:'agent_signed_out', agent:'claude-code-subscription'}]},
    {agents:[{...agents[0], signedIn:false, signInSupported:true}, agents[1]]});
  assertDomOrder(withoutMaskMarkers(out), ['Jobs can’t start', 'No job can start until a lent agent is signed in.', 'class="legacy blocker-signin primary"', 'Workspace checks passed', 'Agents you lend', 'Signed out']);
  assert.match(withoutMaskMarkers(out), /class="signin"/);
  assert.match(out, /aria-checked="true"/);
  assert.doesNotMatch(renderedText(out), /count(ed)? (toward|against)/);
});

test('safety stop, off, paused, running and resting each show their own hero', () => {
  const stopped = page({state:'blocked', reason:'safety_check_failed', needs_you:[{kind:'safety_check_failed'}]});
  assert.match(renderedText(stopped), /Jobs can’t start Lending on this computer waits for the blocked step\. You can still send jobs to another lender\./, 'blocked lending never leads with "Lending is on" (I09)');
  assert.doesNotMatch(renderedText(stopped), /a safety check failed/);
  assert.match(stopped, /aria-label="Lending"/, 'a blocker never takes the switch away');
  assert.match(renderedText(page({state:'off'}, {lending:{...lending, enabled:false}})), /Lending is off No new jobs start on this computer\./);
  assert.match(renderedText(page({state:'paused'})), /Lending is paused Paused\. No new jobs start\./);
  assert.match(page({state:'paused'}), />Resume now</);
  const running = page(withLendingProjection({execution:{state:'running',job:'attempt-1'},runningJob:{requester:'Sam'}},
    {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'sandbox_not_ready',execution:'running',executionJob:'attempt-1'}), {lending:{...lending, status:'running', current:'attempt-1'}});
  assert.match(renderedText(running), /Running Sam’s job/);
  assert.match(running, /Stop Sam’s job…|Stop this job…/);
  assert.match(renderedText(page({state:'resting', reason:'daily_limit'})), /Done for today/);
});


test('a new-work block keeps a running job reachable even with no requester label', () => {
  const active = {...lending, status:'running', current:'attempt-1'};
  const home = withLendingProjection({lending:active, execution:{state:'running',job:'attempt-1'}},
    {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'sandbox_not_ready',
      execution:'running',executionJob:'attempt-1'});
  const out = page(home, {lending:active, data:{readiness:{ready:false,checks:[]},home,approvals:[],activity:[],
    jobs:[{job_digest:'sha256:existing',circle:{id:'weekend'},current_attempt:{attempt_id:'attempt-1'}}]}});
  assert.match(out, /href="#\/job\/sha256%3Aexisting\/weekend"/);
  assert.match(renderedText(out), /Stop this job…/);
  assert.match(renderedText(out), /This job uses your saved limits\./);
});
test('a cleared legacy circle offers Resume now instead of telling a member to join', () => {
  const stopped={...lending,enabled:false,circle:null};
  const out=page({intent:{on:true,state:'blocked',reason:'lending_not_started'},state:'blocked'}, {lending:stopped});
  assert.match(out,/>Resume now<\/button>/);
  assert.doesNotMatch(renderedText(out),/Join or start a circle before/);
});

test('a pending approval makes Review the Lending hero action without claiming a running job', () => {
  const card = {id:'a1', requester:'k', requesterName:'Sam', prompt:'Fix it', harness:'codex', model:[], runtimeSeconds:1200,
    source:{kind:'archive', size_bytes:1}, network:'provider-only', protection:{satisfied:true, enforced:[], unenforced:[]},
    expiresAt:now + 600000};
  const out = page({}, {data:{readiness:{ready:true,checks:[]},home:{state:'ready',lending}, approvals:[card], activity:[]}});
  assert.doesNotMatch(renderedText(out), /Jobs needing your review/);
  assert.match(out, /href="#\/request\/a1"/);
  assert.match(renderedText(out), /Review/);
  assert.doesNotMatch(renderedText(out), /job is running/);
  assert.doesNotMatch(renderedText(out), /Fix it ChatGPT/);
  assert.doesNotMatch(renderedText(out), /Accept and run|Run this job for/, 'no second place to answer');
});

test('Pause all agents states the waiting-review and running-work consequences', () => {
  const out = page({lendingPolicy:{accounts:[{provider:'claude',decision:{availability:{admitted:true}}},{provider:'codex',decision:{availability:{admitted:true}}}]}});
  assertDomOrder(out, ['class="headline">Ready for requests', '>Pause all agents…<', 'aria-label="Pause all agents"']);
  assert.match(renderedText(out), /Pause all agents\. Waiting offers are held, not declined, and return on Resume if still available\. Running jobs continue within their saved limits\./);
  assert.doesNotMatch(renderedText(out), /waiting requests are declined|stopped before reset/i);
  assert.match(out, />For 1 hour</);
  assert.match(out, />Until tomorrow, 7 AM</);
  assert.match(out, />Until I resume</);
  assert.doesNotMatch(renderedText(page({state:'off'}, {lending:{...lending, enabled:false}}).split('aria-label="Pause all agents"')[0]), /Pause all agents…/);
  const running = page(withLendingProjection({execution:{state:'running',job:'a',person:'Sam'}, runningJob:{requester:'Sam'}},
    {intent:'on',intentState:'ready',admission:'allowed',execution:'running',executionJob:'a'}), {lending:{...lending, status:'running', current:'a'}});
  assert.match(running, />Pause all agents…</, 'a running job finishes, so the setting can still be paused');
  assert.match(renderedText(running), /Running jobs continue within their saved limits/);
  assertDomOrder(running, ['Running Sam’s job', 'This job uses your saved limits.', 'Stop Sam’s job…', '>Pause all agents…<']);
  const paused = page(withLendingProjection({intent:{on:true,state:'paused'},execution:{state:'finishing',job:'a',person:'Sam'}, runningJob:{requester:'Sam'}},
    {intent:'paused',intentState:'paused',admission:'blocked',admissionReason:'paused',execution:'finishing',executionJob:'a'}), {lending:{...lending, current:'a', status:'running'}});
  assertDomOrder(paused, ['<h2 class="headline">Finishing Sam’s job', 'Paused. No new jobs start.', 'Stop Sam’s job…', '>Resume now<']);
});

// Review P1: while paused, choosing circle B changed the draft but the list still showed the saved circle A,
// and turning lending on sent B.
test('while lending is off, the row shows the circle a turn-on will use', () => {
  const two = [...circles, {id:'crew', name:'Booking site crew', origin:'http://x', rosterMembershipVerified:true}];
  const off = {...lending, enabled:false, circle:'weekend'};
  const checked = out => (out.match(/<input[^>]+>/g)||[]).filter(tag=>tag.includes('type="radio"')&&/ checked(?:[ =/>])/.test(tag)).map(tag=>/value="([^"]*)"/.exec(tag)[1]);
  const draftB = page({state:'off', intent:{state:'off'}}, {circles:two, lending:off, circle:'crew', selected:two[1]});
  assert.deepEqual(checked(draftB), ['weekend'], 'the saved server circle is what a turn-on uses');
  const draftA = page({state:'off', intent:{state:'off'}}, {circles:two, lending:off, circle:'weekend', selected:two[0]});
  assert.deepEqual(checked(draftA), ['weekend']);
  const on = page({}, {circles:two, lending:{...lending, circle:'weekend'}, circle:'crew', selected:two[1]});
  assert.deepEqual(checked(on), ['weekend'], 'while lending is on the saved circle is shown');
});



test('first run shows ready Claude Code and signed-out Codex, and hides unfinished adapters',()=>{
 const firstRun=[
  {id:'claude-code-subscription',installed:true,signedIn:true,useForLending:false,run:{model:'Sonnet'}},
  {id:'codex',installed:true,signedIn:false,useForLending:false,signInSupported:true},
  {id:'claude-code-api-key',installed:true,signedIn:true}, {id:'gemini',installed:false},
  {id:'gh-cli',installed:true,signedIn:null}, {id:'opencode',installed:false},
 ];
 const out=page({}, {agents:firstRun}), text=renderedText(out);
 assert.equal((withoutMaskMarkers(out).match(/class="lagent"/g)||[]).length,2);
 assertDomOrder(out,['id="agent-claude-code-subscription"','Signed in · ready · Sonnet','id="agent-codex"','Signed out','Sign in to Codex']);
 assert.match(out,/aria-label="Lend with Codex"/);
 assert.doesNotMatch(text,/Show \d+ more agents|Claude Code \(API key\)|Gemini|GitHub CLI|OpenCode/);
});

test('F3: quota display uses raw small-positive amounts before rounding, per provider window',async()=>{
 const {lendingQuotaLinesVM}=await import('./view-models.mjs');
 for(const admitted of [true,false]){
  for(const amount of [0,0.01,0.04,0.06,0.099,0.1,null]){
   const rows=lendingQuotaLinesVM({accounts:[{provider:'claude',decision:{
    availability:{admitted,status:{line:'Waiting for a quota reading.'},
     objective:{lendablePoints:{seven_day:amount,five_hour:amount}}},
    windows:[{window_id:'seven_day',window_minutes:10080},{window_id:'five_hour',window_minutes:300}]
   }}]});
   const text=rows.map(row=>row.text).join(' ');
   if(amount===null){assert.match(text,/Waiting for a quota reading/);assert.doesNotMatch(text,/About null|About 0%/);}
   else if(amount>0&&amount<0.1){
    assert.equal((text.match(/less than 0\.1%/gi)||[]).length,2);
    assert.doesNotMatch(text,/about (?:0|0\.1)%/i);
   }else if(amount===0)assert.equal((text.match(/0%/g)||[]).length,2);
   else assert.equal((text.match(/about 0\.1%/gi)||[]).length,2);
   if(admitted){assert.equal(rows[0].label,'Claude Code · this week');assert.equal(rows[1].label,'Claude Code · this 5-hour window');}
  }
 }
});

test('walk copy: circle change names Off rather than timed Pause', () => {
  const two=[...circles,{id:'crew',name:'Crew',origin:'http://x',rosterMembershipVerified:true}];
  const out=page({}, {circles:two});
  assert.match(renderedText(out), /Turn lending off and let the running job finish before you choose another circle\./);
  assert.match(out, />Turn off to change circle<\/button>/);
  assert.doesNotMatch(out, /Pause to change circle/);
});

test('walk copy: pending approval is Review request and Resume is secondary', () => {
  const local={...lending,paused:true};
  const home=withLendingProjection({state:'paused',lending:local},
    {intent:'paused',intentState:'paused',admission:'blocked',admissionReason:'paused',execution:'idle'});
  const out=page({}, {lending:local,data:{home,readiness:{ready:true,checks:[]},approvals:[{id:'request-1'}],activity:[]}});
  const hero=out.slice(out.indexOf('class="hero'),out.indexOf('class="cols"'));
  const review=hero.match(/<a[^>]*>Review request<\/a>/)?.[0] ?? '';
  assert.match(review, /btn-primary/);
  assert.match(review, /href="#\/request\/request-1"/);
  assert.match(hero, /class="btn btn-secondary btn-sm"[^>]*>Resume now<\/button>/);
  assert.equal((hero.match(/btn-primary/g)||[]).length,1);
});

test('walk copy: no supported agents offers Setup without claiming discovery completeness', () => {
  const p=props({}, {agents:[]});
  p.data={...p.data,agents:[]};
  const out=renderFixture(Lend,p);
  assert.match(renderedText(out), /No supported agents were found\. Open Setup to install or connect one\./);
  assert.match(out, /href="#\/setup">Open Setup<\/a>/);
});

test('walk copy: allowance heading and limits edit link name their scope', () => {
  const snapshot={accounts:[{provider:'claude',decision:{availability:{admitted:true,
    objective:{lendablePoints:{seven_day:18.4}}},windows:[{window_id:'seven_day',window_minutes:10080}]}}]};
  const out=page({lendingPolicy:snapshot});
  assert.match(out, />Allowance<\/h2>/);
  assert.match(out, /href="#\/lend\/limits">Edit lending limits<\/a>/);
});

test('walk copy: no approved circle offers to join or create one', () => {
  const out=page({}, {circles:[]});
  assert.match(renderedText(out), /No approved circle yet\./);
  assert.match(out, /href="#\/circles">Join or create a circle<\/a>/);
});

test('walk copy: effort savings are qualified rather than guaranteed', () => {
  assert.match(renderedText(page()), /Lower effort usually uses less of your allowance\./);
  assert.doesNotMatch(renderedText(page()), /Lower effort uses less of your allowance/);
});

test('scheduled stop copy distinguishes a running limit from unconfirmed cessation', () => {
  for (const state of ['running', 'finishing', 'stopping']) {
    const home = withLendingProjection({execution:{state,job:'attempt-1',person:'Sam',stops_by:now - 60000}},
      {intent:'on',intentState:'ready',admission:'allowed',execution:state,executionJob:'attempt-1'});
    const text = renderedText(page(home));
    assert.doesNotMatch(text, /[Ss]tops by/);
    if (state === 'stopping') {
      assert.match(text, /Scheduled stop: .+\. Waiting for confirmation that the job has stopped\./);
    } else {
      assert.match(text, /Time limit: /);
      assert.doesNotMatch(text, /Waiting for confirmation that the job has stopped/);
    }
  }
});

test('account plan does not offer a second lending permission toggle', () => {
  const out = renderFixture(AccountCard, {account:{provider:'claude'}, setPlan() {}});
  assert.match(renderedText(out), /Claude plan/);
  assert.doesNotMatch(out, /role="switch"/);
});

test('legacy automatic mode is conditional on account permissions and limits', () => {
  const out = renderFixture(WhoRules, {lending:{mode:'auto',circle:'weekend'}, mutate() {}});
  assert.match(renderedText(out), /Automatic mode can run jobs from this circle when account permissions and limits allow it\./);
  assert.doesNotMatch(renderedText(out), /Jobs from this circle run without asking/);
});

test('AgentCard shows the choice at once, confirms it from its own saved row, and holds it when the reply does not confirm', async () => {
  const window = new Window(), saved = new Map();
  for (const [key,value] of Object.entries({window,document:window.document})) {
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const root=document.createElement('div');document.body.append(root);
  // The save route answers with every agent, as lib/v1/app.mjs `agents/<id>` does.
  const off={...agents[0],useForLending:false};
  let resolve,reject,calls=0;
  const mutate=()=>{calls++;return new Promise((yes,no)=>{resolve=yes;reject=no;});};
  const card=agent=>h(AgentCard,{agent,api:{},mutate,refresh(){}});
  const reset=()=>act(()=>render(null,root));
  const settle=value=>act(async()=>{resolve(value);await Promise.resolve();});
  try {
    await act(()=>render(card(off),root));
    const control=root.querySelector('[role="switch"]');
    control.click();
    assert.equal(control.getAttribute('aria-busy'),'true');
    assert.match(root.textContent,/Working…/);
    assert.equal(control.getAttribute('aria-checked'),'true','the choice shows at once');
    control.click();assert.equal(calls,1,'a second tap waits for the first');
    await settle([{...off,useForLending:true}]);
    assert.equal(control.getAttribute('aria-busy'),null);
    await act(()=>render(card({...off,useForLending:true}),root));
    assert.equal(control.getAttribute('aria-checked'),'true','the saved row is what the card shows');
    assert.equal(root.querySelector('[role="alert"]'),null);

    for (const reply of [undefined, [], [{id:'other-agent',useForLending:true}], [{id:off.id,useForLending:false}], [{id:off.id,useForLending:'true'}]]) {
      await reset();
      await act(()=>render(card(off),root));
      const held=root.querySelector('[role="switch"]'), before=calls;
      held.click();
      await settle(reply);
      assert.equal(held.getAttribute('aria-checked'),'true','a reply that does not confirm holds the value asked for');
      assert.equal(held.getAttribute('aria-disabled'),'true');
      assert.equal(held.getAttribute('aria-busy'),null);
      assert.match(root.textContent,/could not be confirmed.*Reload this page/);
      assert.match(root.textContent,/Reload page to confirm agent status/);
      held.click();assert.equal(calls,before+1,'a held switch does not invite a blind retry');
    }

    // Once the saved value changes, the hold releases and the card shows that value.
    await reset();
    await act(()=>render(card(off),root));
    const released=root.querySelector('[role="switch"]');
    released.click();
    await settle([]);
    await act(()=>render(card({...off,useForLending:true}),root));
    assert.equal(released.getAttribute('aria-checked'),'true');
    assert.equal(released.getAttribute('aria-disabled'),null);
    assert.doesNotMatch(root.textContent,/could not be confirmed/);

    // A failed save says so, keeps the saved value, and offers the status check.
    await reset();
    await act(()=>render(card(off),root));
    const failing=root.querySelector('[role="switch"]');
    failing.click();
    await act(async()=>{reject({code:'offline'});await Promise.resolve();});
    assert.equal(failing.getAttribute('aria-checked'),'false','a failed save does not claim success');
    assert.equal(failing.getAttribute('aria-busy'),null);
    assert.match(root.querySelector('[role="alert"]').textContent,/Review this agent’s status before trying again/);
    assert.match(root.textContent,/Check agent status/);
  } finally {
    render(null,root);root.remove();window.happyDOM.abort();
    for(const [key,descriptor] of saved){
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
    }
  }
});

test('mounted owner-reserve wait replaces its ETA at the deadline without offering Start or Resume', async t => {
  const window = new Window(), saved = new Map();
  for (const [key,value] of Object.entries({window,document:window.document})) {
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const root = document.createElement('div');
  document.body.append(root);
  const deadline = Date.UTC(2026, 10, 17, 19, 1);
  let nowMs = deadline - 1;
  const ticks = new Map();
  const setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval;
  t.mock.method(Date, 'now', () => nowMs);
  t.mock.method(globalThis, 'setInterval', (callback, delay, ...args) => {
    if (delay !== 30000) return setInterval(callback, delay, ...args);
    const timer = Symbol('mounted lending clock');
    ticks.set(timer, () => callback(...args));
    return timer;
  });
  t.mock.method(globalThis, 'clearInterval', handle => {
    if (!ticks.delete(handle)) clearInterval(handle);
  });

  const account = {provider:'codex', decision:{availability:{
    admitted:false, reason:'owner_reserve', objective:{strategyId:'pace'},
    wait:{accountKey:'codex',reason:'owner_reserve',strategyId:'pace',source:'window_reset',nextEvaluationAtMs:deadline},
    status:{line:'Saved wait text',recovery:{who:'automatic'}},
  }}};
  const home = withLendingProjection({lendingPolicy:{accounts:[account]}},
    {intent:'on',intentState:'ready',admission:'allowed',execution:'idle'});
  const controls = () => [...root.querySelectorAll('.hero button, .hero a')]
    .map(element => element.getAttribute('aria-label') || element.textContent.trim());
  const assertHeld = () => {
    assert.equal(root.querySelector('.hero .headline').textContent, 'Lending on');
    assert.doesNotMatch(root.querySelector('.hero').textContent, /Ready for requests/);
    assert.equal(controls().some(label => /^(Start|Resume)\b/i.test(label)), false);
  };
  let writes = 0;
  try {
    await act(() => render(h(Lend, props(home, {
      api: {get: async () => ({enabled:false})},
      agents: [agents[1]],
      mutate: async () => { writes += 1; return {}; },
    })), root));
    assert.ok(ticks.size > 0, 'the rendered page subscribes to the clock');
    assertHeld();
    const reason = () => root.querySelector('.hero .lstate .grow p').textContent;
    assert.match(reason(), /resets at /);
    assert.doesNotMatch(reason(), /fresh allowance check/);

    nowMs = deadline;
    await act(() => {for (const tick of ticks.values()) tick();});
    assertHeld();
    assert.match(reason(), /fresh allowance check is needed before another job can start/);
    assert.doesNotMatch(reason(), /resets at /);
    assert.equal(writes, 0);
  } finally {
    await act(() => render(null, root));
    root.remove();
    window.happyDOM.abort();
    for (const [key,descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor);
      else delete globalThis[key];
    }
  }
  assert.equal(ticks.size, 0, 'unmount retires the hooked lending clocks');
});

// Item 7 (1102 review): the Agents section's check names its scope, so it is not confused with Setup's whole-computer check.
test('the Agents section check says it re-checks agents, not the whole computer', () => {
  const out = page({}, {agents:[{id:'codex',installed:true,signedIn:true,useForLending:true,auth_strategy:'provider-file-generation',credential_in_guest:true}]});
  assert.match(out, /<h2>Agents you lend<\/h2>[\s\S]*?>Check agents again<\/button>/);
  assert.doesNotMatch(out, />Check again<\/button>/);
});

test('finished-job history is hidden when no finished jobs exist',()=>{
 assert.doesNotMatch(renderedText(page()),/View finished jobs/);
 const p=props();p.data.jobs=[{state:'failed',job_digest:'a'.repeat(64)}];
 assert.match(renderedText(renderFixture(Lend,p)),/View finished jobs/);
});

const cleanupZeros={data_cleanup_pending:0,policy_cleanup_pending:0,policy_cleanup_blocked:0,compute_cleanup_pending:0,unknown:0};
function cleanupPage(snapshot, extra={}) {
 const window=new Window();
 window.document.body.innerHTML=page({cleanup:snapshot},extra);
 const section=window.document.querySelector('[aria-label="Cleanup"]');
 assert.ok(section,'cleanup diagnostics remain reachable');
 const details=section.querySelector('details');
 assert.ok(details);assert.equal(details.open,false);
 const diagnostic=details.textContent;
 details.remove();
 const visible=section.textContent;
 window.happyDOM.abort();
 return {visible,diagnostic};
}
test('Lend omits cleanup diagnostics when there is no known cleanup work',()=>{
 const window=new Window();
 window.document.body.innerHTML=page({cleanup:{...cleanupZeros,shared_watch:{}}});
 assert.equal(window.document.querySelector('[aria-label="Cleanup"]'), null);
 window.happyDOM.abort();
});
test('Lend names independent active cleanup obligations without default counters',()=>{
 const {visible,diagnostic}=cleanupPage({...cleanupZeros,data_cleanup_pending:2,policy_cleanup_pending:3,
  policy_cleanup_blocked:1,compute_cleanup_pending:4,unknown:5,create_watch:6,shared_watch:{healthy:true,count:7}});
 for(const line of ['Waiting for jobs to stop.','Removing job data.','Removing network rules.',
  'Some network rules could not be removed.','Some cleanup could not be confirmed.','Checking that workspaces are gone.'])assert.ok(visible.includes(line),line);
 assert.doesNotMatch(visible,/watcher|pending|[0-9]/i);
 assert.match(diagnostic,/Data removal pending.*2/);
 assert.match(diagnostic,/Compute stop pending.*4/);
});
test('Lend labels stale cleanup as unknown and keeps old facts in Details',()=>{
 const {visible,diagnostic}=cleanupPage({...cleanupZeros,data_cleanup_pending:2,shared_watch:{healthy:true,count:7}},
  {errors:{home:new Error('offline')}});
 assert.match(visible,/Cleanup status could not be refreshed/);
 assert.doesNotMatch(visible,/Removing|Watching|2|7/);
 assert.match(diagnostic,/Last known counts/);
 assert.match(diagnostic,/Data removal pending.*2/);
});
test('Lend keeps genuine cleanup uncertainty and running-job Stop available',()=>{
 const {visible}=cleanupPage({...cleanupZeros,unreadable_records:1,shared_watch:{healthy:true,count:0}});
 assert.match(visible,/Some cleanup could not be confirmed/);
 const home=withLendingProjection({cleanup:{...cleanupZeros,compute_cleanup_pending:1},execution:{state:'running',job:'attempt-1',person:'Sam'},runningJob:{requester:'Sam'}},
  {intent:'on',intentState:'ready',admission:'allowed',execution:'running',executionJob:'attempt-1'});
 assert.match(page(home,{lending:{...lending,status:'running',current:'attempt-1'}}),/Stop Sam’s job…|Stop this job…/);
});

test('owner reserve distinguishes a dated reset from an automatic check', () => {
  const now = new Date(2026, 10, 17, 12).getTime();
  const deadline = new Date(2026, 10, 18, 9).getTime();
  const wait = (source, clock = now) => currentCapacityWait({provider:'codex',
    decision:{availability:{admitted:false,reason:'owner_reserve',objective:{strategyId:'pace'},
      wait:{accountKey:'codex',reason:'owner_reserve',strategyId:'pace',nextEvaluationAtMs:deadline,source}}}},
    {now:clock});
  assert.match(wait('window_reset').line, /resets at Nov 18/);
  assert.match(wait('probe_retry_at').line, /checked again automatically at Nov 18/);
  assert.equal(wait('window_reset', deadline).state, 'expired');
  assert.equal(wait('probe_retry_at', deadline).state, 'expired');
  assert.equal(wait('unknown').state, 'unknown');
});
