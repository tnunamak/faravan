import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import './mounted.test-helper.mjs';
import {h} from 'preact';
import {mount,click,resetPage,teardown} from './mounted.test-helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Home} from './home.jsx';
import {Lend} from './lend.jsx';
import {needsYouCount,blockersFor} from './view-models.mjs';
import {renderFixture, renderedText, assertDomOrder} from './render.test-helper.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';

// The tester's case: Docker signed out, Claude not checked, Codex failed. Home and Lending tell the same story.
const circle = {id:'c1', name:'Weekend projects', origin:'http://x', owned:true};
const lending = {enabled:true, circle:'c1', mode:'ask', status:'idle', current:null, limits:{timeZone:'UTC', dailyJobs:3, dailyMinutes:60}};
const agents = [
  {id:'claude-code-subscription', useForLending:true, installed:true, signedIn:null, run:{}, signInSupported:true},
  {id:'codex', useForLending:true, installed:true, signedIn:true, signInState:'Check failed', run:{}},
];
const readiness = {ready:false, checks:[{name:'sbx_install', ok:true}, {name:'sbx_daemon', ok:true}, {name:'docker_login', ok:false}], docker:{expired_at:'2026-10-19T18:52:00Z'}};
const home = withLendingProjection({intent:{on:true,state:'blocked', reason:'docker_signed_out'}, state:'blocked', reason:'docker_signed_out', needs_you:[{kind:'safety_check_failed'}], lending, attention:[
  {label:'ChatGPT (Codex) needs a check before it can lend.', remedy:'Check agents on the Lend page.', agent:'codex'}], circles:[circle]},
  {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'docker_signed_out'});
const base = {api:{get: async () => []}, circles:[circle], agents, lending, circle:'c1', selected:circle, members:[], mutate: async () => ({}), refresh() {}, setDialog() {}, setCircle() {},
  data:{home, approvals:[], activity:[], devices:{name:'Ana’s MacBook', circles:[]}, readiness, agents}};
const homeHtml = renderFixture(Home, base), lendHtml = renderFixture(Lend, base);


// The real zone is the viewer's; the fixture's expired time is rendered in it, so only the shape is asserted.
test('Lending: the live defect reads as a Docker sign-in that expired, one fix, the switch still on', () => {
  const text = renderedText(lendHtml);
  assert.match(text, /Lending can’t start here Lending on this computer needs Docker sign-in\. You can still send jobs to another lender\./);
  assert.doesNotMatch(text, /safety check failed|Check failed|Not checked yet/);
  assert.match(lendHtml, /aria-label="Lending"[^>]*aria-checked="true"|aria-checked="true"[^>]*aria-label="Lending"/, 'a blocker never turns lending off');
  assert.equal((withoutMaskMarkers(lendHtml).match(/class="legacy blocker-signin primary"/g) || []).length, 1, 'one primary sign-in');
});

test('Lending keeps computer steps in order and agent status only on its own row', () => {
  assertDomOrder(lendHtml, ['What lending needs, in order','data-blocker="docker_installed"','data-blocker="docker_signin"','Agents you lend','id="agent-claude-code-subscription"','id="agent-codex"']);
  assert.doesNotMatch(lendHtml,/data-blocker="agent:|data-blocker="lending"/);
  assert.equal((withoutMaskMarkers(lendHtml).match(/class="legacy blocker-signin primary"/g)||[]).length,1);
});

test('Home puts the one Docker fix in the attention queue, with a quiet computer summary', () => {
 const text=renderedText(homeHtml);
 assert.match(text,/Needs your attention/);assert.match(text,/Docker sign-in Expired at/);
 assert.equal((text.match(/Expired at/g)||[]).length,1);
 assert.equal((withoutMaskMarkers(homeHtml).match(/class="legacy blocker-signin primary"/g)||[]).length,1);
 assert.doesNotMatch(text,/See all 4 steps|Your next step|wait for the Docker sign-in/);
});

test('the Home badge does not count blockers: they are the lending card’s, and the machine chip says "Needs you"', () => {
  assert.equal(needsYouCount({approvals: [], home: {needs_you: []}}), 0);
});

test('a disk requirement offers Check again as a readiness re-check, not a sentence-long link',async()=>{
 const {BlockerAction}=await import('./blockers.jsx');
 const html=renderFixture(BlockerAction,{item:{key:'readiness_requirement',cause:'host_disk',status:'blocked',action:'Check again'},api:{},refresh(){}});
 assert.match(renderedText(html),/^\s*Check again\s*$/m);
 assert.doesNotMatch(html,/href="#\/setup"/);
});
test('a blocked network policy offers an in-app repair retry', async () => {
  const {BlockerAction}=await import('./blockers.jsx');
  const html=renderFixture(BlockerAction,{item:{key:'readiness_requirement',cause:'network_policy',status:'blocked',action:'Retry network setup'},api:{},refresh(){}});
  assert.match(html, /<button/);
  assert.match(html, /Retry network setup/);
  assert.doesNotMatch(html, /href=|sbx policy|doctor/);
});

test('a shared daemon restart offers one confirmation button instead of a setup link', async()=>{
  const {BlockerAction}=await import('./blockers.jsx');
  const html=renderFixture(BlockerAction,{item:{key:'docker_running',action:'Restart Docker Sandboxes'},api:{},refresh(){}});
  assert.match(html,/<button/);
  assert.match(html,/Restart Docker Sandboxes/);
  assert.doesNotMatch(html,/href=|terminal|sbx daemon/);
});

test('a workspace timeout on a healthy Docker is one Check again on every projection, never a restart',async()=>{
  const {BlockerAction}=await import('./blockers.jsx');
  const {lendingBlockers}=await import('./blockers.mjs');
  const {lendingBlockers:serverBlockers}=await import('../../../lib/v1/blockers.mjs');
  const docker={installed:true,running:true,signedIn:true};
  const requirement=[{cause:'test_workspace',label:'The test workspace took too long to start.',remedy:'Choose Check again.'}];
  const timeout=model=>model.items.find(item=>item.key==='readiness_requirement'&&item.cause==='test_workspace');
  for(const [name,build] of [['local',lendingBlockers],['server',serverBlockers]]){
    const item=timeout(build({docker,intent:{on:true},readinessRequirements:requirement}));
    assert.equal(item.action,'Check again',name);
    assert.doesNotMatch(item.detail,/Restart/,name);
  }
  // A server-projected item is used as given; the same control renders, and no restart is ever offered for it.
  const projected={key:'readiness_requirement',cause:'test_workspace',label:'Sandbox setup',status:'blocked',detail:'The test workspace took too long to start.',action:'Check again',headline:'Lending is blocked by a readiness requirement'};
  const model=blockersFor({agents:[],status:{lending_blockers:{items:[projected],first:projected,canLend:false,headline:projected.headline}}});
  assert.equal(model.first.action,'Check again');
  const html=renderFixture(BlockerAction,{item:model.first,api:{},refresh(){}});
  assert.match(html,/aria-label="Check again"/);
  assert.doesNotMatch(html,/Restart Docker Sandboxes/);
  // A genuine daemon mismatch keeps its confirmation control.
  assert.match(renderFixture(BlockerAction,{item:{key:'docker_running',action:'Restart Docker Sandboxes'},api:{},refresh(){}}),/Restart Docker Sandboxes/);
});

test('permanent repair failures link to support settings without retrying',async()=>{
  const {BlockerAction}=await import('./blockers.jsx');
  const html=renderFixture(BlockerAction,{item:{key:'readiness_requirement',cause:'network_policy',status:'blocked',action:'Open Settings'}});
  assert.match(html,/href="#\/settings\/data"/);
  assert.doesNotMatch(html,/Retry|reset|Restart/);
});

test('F6 network retry accessible name preserves the visible action',async()=>{
 const {BlockerAction}=await import('./blockers.jsx');
 const html=renderFixture(BlockerAction,{item:{cause:'network_policy',status:'blocked'},api:{},refresh(){}});
 assert.match(html,/aria-label="Retry network setup"/);
 assert.doesNotMatch(html,/aria-label="Check readiness again"/);
});
test('F7 unreachable host supplies a real recheck and does not promise automatic refresh',async()=>{
 const {lendingBlockers}=await import('./blockers.mjs');
 const {BlockerList}=await import('./blockers.jsx');
 const model=lendingBlockers({circle:{host:'Ana’s Mac',reachable:false}});
 const item=model.items.find(row=>row.key==='circle');
 assert.equal(item.action,'Check again');assert.match(item.detail,/Check that Ana’s Mac is online and Faravan is running/);
 const html=renderFixture(BlockerList,{model,api:{},refresh(){}});
 assert.match(renderedText(html),/After fixing it, check readiness again/);
 assert.doesNotMatch(renderedText(html),/Fix the first one and the rest are checked again/);
});

test('F7 unreachable-host recheck button calls the forced-read endpoint',async t=>{
 t.after(teardown);resetPage();
 const {BlockerAction}=await import('./blockers.jsx');const paths=[];
 const view=await mount(h(BlockerAction,{item:{key:'circle',action:'Check again'},api:{get:async path=>{paths.push(path);return {};}},refresh:async()=>{}}));
 const button=view.button('Check again');assert.ok(button);assert.equal(button.tagName,'BUTTON');
 await click(button);assert.deepEqual(paths,['readiness?refresh=true']);
});

test('copy audit B distinguishes unreadable disk from low space and credential exposure from success',async()=>{
 const {lendingBlockers}=await import('./blockers.mjs');
 const base={docker:{installed:true,running:true,signedIn:true},intent:{on:true},agents:[{id:'codex',name:'Codex',enabled:true,installed:true,signedIn:true}]};
 const disk=kind=>lendingBlockers({...base,readinessRequirements:[{cause:kind==='unreadable'?'host_disk_unreadable':'host_disk_low',label:'Check disk space.',remedy:'Check again'}]});
 assert.equal(disk('unreadable').headline,'Lending stopped: Faravan could not read free disk space');
 assert.equal(disk('low').headline,'Lending stopped: this computer is low on disk space');
 assert.equal(disk('unreadable').first.action,'Check again');
 const failed=lendingBlockers({...base,isolationFailure:'The sandbox could read your agent sign-in. Check Docker Sandboxes, then resume lending.'});
 assert.match(failed.first.detail,/could read your agent sign-in/);
 assert.equal(failed.first.action,'Resume lending');
 assert.equal(failed.canLend,false);
 const owner=lendingBlockers({...base,circle:{reachable:true,hostVersion:'1',needVersion:'2'}});
 assert.match(owner.items.find(x=>x.key==='circle').detail,/Ask the person who hosts this circle to update/);
});

test('fresh sign-in repairs stale blockers and recalculates the lending verdict',async()=>{
 const {blockersFor}=await import('./view-models.mjs');
 const ready={id:'codex',useForLending:true,installed:true,signedIn:true};
 const row={key:'agent',agent:'codex',label:'Codex',status:'blocked',detail:'Signed out.',action:'Sign in to Codex',headline:'Lending stopped: Codex is signed out'};
 const model=blockersFor({agents:[ready],status:{lending_blockers:{items:[row],first:row,canLend:false,headline:row.headline}}});
 assert.equal(model.byAgent.codex.status,'ok');assert.equal(model.byAgent.codex.detail,'Ready.');
 assert.equal(model.first,null);assert.equal(model.active,false);assert.equal(model.canLend,true);assert.equal(model.headline,'Lending is on');assert.equal(model.needsYou.length,0);
});
test('fresh agent downgrade recalculates first headline active and canLend without stopping a healthy peer',async()=>{
 const {blockersFor}=await import('./view-models.mjs');
 for(const installed of [true,false])for(const peer of [false,true]){
  const rows=[{key:'agent',agent:'codex',status:'ok',detail:'Ready.'},...(peer?[{key:'agent',agent:'claude-code-subscription',status:'ok',detail:'Ready.'}]:[])];
  const agents=[{id:'codex',useForLending:true,installed,signedIn:false},...(peer?[{id:'claude-code-subscription',useForLending:true,installed:true,signedIn:true}]:[])];
  const model=blockersFor({agents,status:{lending_blockers:{items:rows,first:null,canLend:true,headline:'Lending is on'}}});
  assert.equal(model.byAgent.codex.detail,installed?'Signed out.':'Not installed.');
  assert.equal(model.canLend,peer);assert.equal(model.active,!peer);
  assert.equal(model.first?.agent??null,peer?null:'codex');
  assert.equal(model.headline,peer?'Lending is on':installed?'Lending stopped: Codex is signed out':'Lending stopped: Codex isn’t installed');
 }
});
test('recovered sign-in preserves machine dependencies and unrelated credential failures',async()=>{
 const {blockersFor}=await import('./view-models.mjs');
 const agent={id:'codex',useForLending:true,installed:true,signedIn:true};
 const machine={key:'docker_installed',status:'blocked',label:'Docker Sandboxes',detail:'Not installed.',action:'Install Docker Sandboxes',headline:'Lending needs Docker Sandboxes'};
 const signedOut={key:'agent',agent:'codex',status:'blocked',detail:'Signed out.',action:'Sign in to Codex'};
 const model=blockersFor({agents:[agent],status:{lending_blockers:{items:[machine,signedOut],first:machine,canLend:false,headline:machine.headline}}});
 assert.equal(model.byAgent.codex.status,'waits');assert.equal(model.byAgent.codex.waitsFor,'docker_installed');
 assert.equal(model.canLend,false);assert.equal(model.first.key,'docker_installed');
 const credential={...signedOut,detail:'Its sign-in could be read inside the sandbox.',action:'Run the test again'};
 const preserved=blockersFor({agents:[agent],status:{lending_blockers:{items:[credential],first:credential,canLend:false,headline:'Credential test failed'}}});
 assert.equal(preserved.byAgent.codex.detail,credential.detail);assert.equal(preserved.byAgent.codex.action,'Run the test again');assert.equal(preserved.canLend,false);
});
test('unknown agent becoming ready recalculates the old checking verdict',async()=>{
 const {blockersFor}=await import('./view-models.mjs');
 const model=blockersFor({agents:[{id:'codex',useForLending:true,installed:true,signedIn:true}],status:{lending_blockers:{items:[{key:'agent',agent:'codex',status:'unknown',detail:'Checking…'}],first:null,canLend:false,headline:'Checking this computer…'}}});
 assert.equal(model.canLend,true);assert.equal(model.headline,'Lending is on');assert.equal(model.first,null);
});
test('Check agents notices retain waiting context and single-agent scope',async t=>{
 t.after(teardown);
 const {BlockerList}=await import('./blockers.jsx');
 for(const single of [false,true]){
  resetPage();const calls=[];
  const agents=[{id:'codex',useForLending:true,installed:true,signedIn:true},{id:'claude-code-subscription',useForLending:true,installed:true,signedIn:true}];
  const waiting={key:'agent',agent:'codex',label:'Codex',status:'waits',detail:'Waits for Docker Sandboxes.',waitsFor:'docker_installed'};
  const action=single?{...waiting,action:'Check Codex'}:{key:'agent',status:'unknown',label:'Coding agents',detail:'Checking…',action:'Check agents'};
  const model={items:single?[action]:[action,waiting],needsYou:[action],byAgent:{codex:waiting}};
  const view=await mount(h(BlockerList,{model,agents,mutate:async(path,body)=>{calls.push([path,body]);return agents;}}));
  await click(view.button(single?'Check Codex':'Check agents'));
  assert.match(view.text(),/Checked\. .*Codex is waiting for Docker Sandboxes/);
  assert.doesNotMatch(view.text(),/Codex is ready/);
  if(single){assert.doesNotMatch(view.text(),/Claude Code is ready/);assert.deepEqual(calls,[['agents/refresh',{agents:['codex']}]]);}
  await view.unmount();
 }
});

test('reconciliation preserves off paused waiting and unselected lending verdicts',async()=>{
 const {blockersFor}=await import('./view-models.mjs');
 const unknown={key:'agent',agent:'codex',status:'unknown',detail:'Checking…'};
 for(const prerequisite of [
  {key:'lending',status:'blocked',detail:'Turned off.',headline:'Lending is off'},
  {key:'lending',status:'blocked',detail:'Paused until tomorrow.',headline:'Paused until tomorrow'},
  {key:'circle',status:'waits',detail:'Waits for the host.'},
  null
 ]){
  const agent={id:'codex',useForLending:Boolean(prerequisite),installed:true,signedIn:true};
  const items=[...(prerequisite?[prerequisite]:[]),unknown],first=prerequisite?.status==='blocked'?prerequisite:null;
  const model=blockersFor({agents:[agent],status:{lending_blockers:{items,first,canLend:false,headline:first?.headline??'Checking this computer…'}}});
  assert.equal(model.canLend,false);assert.notEqual(model.headline,'Lending is on');
  assert.equal(model.headline,first?.headline??'Lending is waiting');
 }
});

test('checked lending-target aliases retain canonical waiting context',async t=>{
 t.after(teardown);resetPage();
 const {BlockerAction}=await import('./blockers.jsx');
 const agent={id:'codex',lendingSignInTarget:'codex-lending',proxySignedIn:true,useForLending:true,installed:true,signedIn:true};
 const calls=[],byAgent={codex:{status:'waits',detail:'Waits for Docker Sandboxes.'}};
 const view=await mount(h(BlockerAction,{item:{key:'agent',action:'Check agents'},agents:[agent],byAgent,mutate:async(path,body)=>{calls.push([path,body]);return [agent];}}));
 await click(view.button('Check agents'));
 assert.deepEqual(calls,[['agents/refresh',{agents:['codex-lending']}]]);
 assert.match(view.text(),/Checked\. Codex is waiting for Docker Sandboxes\./);
 assert.doesNotMatch(view.text(),/No agents were found|Codex is ready/);
});

test('a Docker sign-in refresh failure renders the doctor message on Home and Lend', async () => {
  const {DOCKER_SIGNIN_REFRESH_MESSAGE:message} = await import('../../../lib/v1/docker-state.mjs');
  const {lendingBlockers} = await import('./blockers.mjs');
  const model = lendingBlockers({docker:{installed:true,running:true,signedIn:false,signinDetail:message},intent:{on:true},agents:[]});
  const props = {...base,data:{...base.data,home:{...home,lending_blockers:model},readiness:{...readiness,checks:readiness.checks.map(c=>c.name==='docker_login'?{...c,label:message,cause:'docker_signin_refresh_unavailable'}:c)}}};
  for (const component of [Home,Lend]) {
    const html = renderFixture(component,props);
    assert.ok(renderedText(html).includes(message));
    assert.ok(renderedText(html).includes('Open Docker Desktop and check you are signed in.'));
    assert.doesNotMatch(html, /Sign in to Docker<|data-target="docker"/);
    if(component===Lend) assert.match(html,/data-blocker="docker_signin" data-state="blocked"/);
    else assert.match(html,/<h3[^>]*>Docker sign-in<\/h3>/);
  }
});

test('Docker guidance uses in-app sign-in without a Desktop remedy', async () => {
  const {BlockerAction} = await import('./blockers.jsx');
  const view = await mount(h(BlockerAction, {item:{key:'docker_signin',status:'blocked',action:'Open Setup and select Sign in to Docker.'},
    api:{}, refresh:async()=>{}}));
  assert.ok(view.button('Sign in to Docker'));
  assert.doesNotMatch(view.text(), /Docker Desktop/);
});
