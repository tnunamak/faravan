import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {homeLendingCardVM} from './home-lending.mjs';
import {lendPageVM,needsYouItems} from './view-models.mjs';
import {LendingCard} from './lend.jsx';
import {renderFixture,renderedText} from './render.test-helper.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';
import {effectiveState} from '../../../lib/v1/lending-state.mjs';
const agents=[{id:'codex',installed:true,signedIn:true,useForLending:true}];
const lending={enabled:false,circle:'shared',status:'idle'};
const vm=(isolationFailure)=>lendPageVM(withLendingProjection({intent:{on:false,state:'off'},lending,isolationFailure:typeof isolationFailure==='string'?isolationFailure:undefined},
 {intent:'off',intentState:'off',admission:'blocked',admissionReason:'off'}),{agents,readiness:{ready:true,checks:[]}});
test('Home off card describes the machine fix and leaves its action in the attention list',()=>{
 const page=vm('The sandbox could reach your home network. Check Docker Sandboxes, then resume lending.'),card=homeLendingCardVM(page);
 assert.equal(card.reason,'No new jobs start on this computer.');
 assert.equal(card.action,null);assert.equal(card.showSwitch,false);
 assert.equal(page.blockers.needsYou[0]?.action,'Resume lending','the prerequisite retains its own recovery action');
 const out=renderFixture(LendingCard,{vm:page,device:'Ana’s computer',circle:'shared',lending,agents,api:{},mutate:async()=>({}),refresh(){}});
 assert.match(renderedText(out),/No new jobs start on this computer/);assert.doesNotMatch(out,/<button/);
 assert.doesNotMatch(out,/role="switch"/);assert.doesNotMatch(renderedText(out),/Review what needs your attention/);
});
test('Home off card with no prerequisite blocker offers Turn lending on',()=>{
 const page=vm({id:'test-run',state:'passed',at:'2026-10-20T07:14:00Z',current:{runId:'test-run',at:'2026-10-20T07:14:00Z',configuration:{versions:{faravan:'0.12.0',sbx:'0.48.0',probe:{version:1,digest:'fixture'},adapters:{}},agents:['claude-code-subscription','codex']}}}),card=homeLendingCardVM(page);
 assert.equal(card.action.action,'Turn lending on');assert.equal(card.showSwitch,false);
 const out=renderFixture(LendingCard,{vm:page,device:'Ana’s computer',circle:'shared',lending,agents,api:{},mutate:async()=>({}),refresh(){}});
 assert.match(out,/<button[^>]*>Turn lending on<\/button>/);assert.doesNotMatch(out,/role="switch"/);
});

test('Home names every unchecked agent without duplicating their attention actions',()=>{
 const page=lendPageVM(withLendingProjection({intent:{on:false,state:'off'},lending,isolationFailure:typeof isolationFailure==='string'?isolationFailure:undefined},{intent:'off',intentState:'off',admission:'blocked',admissionReason:'off'}),{agents:[{id:'claude-code-subscription',installed:true,signedIn:null,useForLending:true},{id:'codex',installed:true,signedIn:null,useForLending:true}],readiness:{ready:true,checks:[]}});
 const card=homeLendingCardVM(page);
 assert.equal(card.reason,'No new jobs start on this computer.');assert.equal(card.action,null);assert.equal(card.showSwitch,false);
});

test('start failure offers Resume now on Lending, Home and one attention item',()=>{
 const home=withLendingProjection({intent:{on:true,state:'blocked',reason:'lending_not_started'},lending:{...lending,enabled:false}},
  {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'lending_not_started'});
 const page=lendPageVM(home,{agents,readiness:{ready:true,checks:[]}}),card=homeLendingCardVM(page);
 assert.equal(page.heroAction.action,'Resume now');
 assert.equal(page.reason,'Lending couldn’t start. Check lending for what is blocking it.');
 assert.equal(card.action.action,'Resume now');assert.equal(card.showSwitch,false);
 const attention=needsYouItems({home,agents,readiness:{ready:true,checks:[]}});
 assert.deepEqual(attention.filter(item=>item.kind==='blocker').map(item=>item.item.action),['Resume now']);
 const out=renderFixture(LendingCard,{vm:page,device:'Ana’s computer',circle:'shared',lending:home.lending,agents,api:{},mutate:async()=>({}),refresh(){}});
 assert.match(withoutMaskMarkers(out),/class="card home-lending-card recovery"/);
 assert.match(out,/<button[^>]*>Resume now<\/button>/);
});

// The server's own output for a failed start: the public reason says only `conditions_unavailable`, which many holds share.
// The cause stays in status.blockers, and that is what keeps Resume now and the start-failure sentence.
test('a failed start still offers Resume now when the public reason is conditions_unavailable',()=>{
 const start=blockReason=>{
  const effective=effectiveState({intent:'on',blockReason,agents:[{id:'codex',enabled:true,installed:true,signedIn:true}]});
  assert.equal(effective.intent.reason,'conditions_unavailable');
  return withLendingProjection({...effective,lending:{...lending,enabled:false}},
   {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:effective.intent.reason});
 };
 const home=start('lending_not_started');
 assert.deepEqual(home.blockers.map(blocker=>blocker.kind),['lending_not_started']);
 const page=lendPageVM(home,{agents,readiness:{ready:true,checks:[]}}),card=homeLendingCardVM(page);
 assert.equal(page.heroAction.action,'Resume now');
 assert.equal(page.reason,'Lending couldn’t start. Check lending for what is blocking it.');
 assert.equal(card.action.action,'Resume now');
 assert.deepEqual(needsYouItems({home,agents,readiness:{ready:true,checks:[]}}).filter(item=>item.kind==='blocker').map(item=>item.item.action),['Resume now']);
 // The same public reason with another cause is not a failed start: no Resume now, and the generic sentence.
 const other=lendPageVM(start('quota_unknown'),{agents,readiness:{ready:true,checks:[]}});
 assert.notEqual(other.heroAction?.action,'Resume now');
 assert.equal(other.reason,'Lending on this computer waits for the blocked step. You can still send jobs to another lender.');
});

test('Lending and Home share the unchecked-agent reason and the hero groups two checks',()=>{
 const unchecked=[{id:'claude-code-subscription',installed:true,signedIn:null,useForLending:true},{id:'codex',installed:true,signedIn:null,useForLending:true}];
 const page=lendPageVM(withLendingProjection({intent:{on:false,state:'off'},lending,isolationFailure:typeof isolationFailure==='string'?isolationFailure:undefined},{intent:'off',intentState:'off',admission:'blocked',admissionReason:'off'}),{agents:unchecked,readiness:{ready:true,checks:[]}});
 assert.equal(page.reason,'No new jobs start on this computer.');
 assert.equal(page.reason,homeLendingCardVM(page).reason);
 assert.equal(page.heroAction.action,'Check agents');
 const one=lendPageVM(withLendingProjection({intent:{on:false,state:'off'},lending,isolationFailure:typeof isolationFailure==='string'?isolationFailure:undefined},{intent:'off',intentState:'off',admission:'blocked',admissionReason:'off'}),{agents:unchecked.slice(0,1),readiness:{ready:true,checks:[]}});
 assert.equal(one.heroAction.action,'Check Claude Code');
 assert.equal(one.reason,homeLendingCardVM(one).reason);
});

test('Home keeps the fresh account hold beside its attention headline',()=>{
 const freshLine='Holding — your saved per-job limit cannot be read. This needs you: save the per-job limit again.';
 const home=withLendingProjection({intent:{on:true,state:'ready'},lending:{...lending,enabled:true},lendingPolicy:{accounts:[{provider:'codex',label:'Codex',decision:{admitted:true,
   objective:{admission:'allowed',reasonCode:'objective_lend',reasonText:'Ready to lend to a friend when a job arrives.'},
   status:{line:'Ready to lend to a friend when a job arrives.'},
   availability:{admitted:false,reason:'owner_settings_unreadable',objective:{admission:'held',reasonCode:'owner_settings_unreadable',reasonText:freshLine},
    status:{line:freshLine}},lastJobDecision:{admitted:true,reason:'objective_lend'}}}]}},
  {intent:'on',intentState:'ready',admission:'allowed'});
 const page=lendPageVM(home,{agents,readiness:{ready:true,checks:[]}});
 const card=homeLendingCardVM(page);
 assert.equal(page.headline,'Check lending accounts');
 assert.equal(page.reason,freshLine);
 assert.equal(card.reason,freshLine);
 const out=renderFixture(LendingCard,{vm:page,device:'This computer',circle:'shared',lending,agents,api:{},mutate:async()=>({}),refresh(){}});
 assert.match(renderedText(out),/Check lending accounts/);
 assert.match(renderedText(out),/Holding — your saved per-job limit cannot be read/);
 assert.doesNotMatch(renderedText(out),/Ready to lend to a friend when a job arrives/);
});

test('a hold that clears on its own keeps the Lending on headline and says when it clears',()=>{
 const line='Holding — your reserve covers everything spare. It clears on its own when spare quota grows or your own use drops.';
 const home=withLendingProjection({intent:{on:true,state:'ready'},lending:{...lending,enabled:true},lendingPolicy:{accounts:[{provider:'codex',label:'Codex',decision:{admitted:false,reason:'owner_reserve',
   availability:{admitted:false,reason:'owner_reserve',objective:{admission:'held',reasonCode:'owner_reserve',reasonText:line},
    status:{line,recovery:{who:'automatic',when:'spare quota grows or your own use drops'}}}}}]}},
  {intent:'on',intentState:'ready',admission:'allowed'});
 const page=lendPageVM(home,{agents,readiness:{ready:true,checks:[]}});
 assert.equal(page.headline,'Lending on');
 assert.equal(page.reason,line);
});

test('after a stop, Lending says why it is off and offers no pause',()=>{
 const off={intent:'off',intentState:'off',admission:'blocked',admissionReason:'off'};
 const page=extra=>lendPageVM(withLendingProjection({intent:{on:false,state:'off'},lending,...extra},off),{agents,readiness:{ready:true,checks:[]}});
 const stopped=page({stoppedJob:{requester:'Alex Example'}});
 assert.equal(stopped.reason,'Lending is off because you stopped Alex Example’s job. Turn it on to take the next job.');
 assert.equal(stopped.canPause,false);
 assert.equal(page({stoppedJob:{requester:null}}).reason,'Lending is off because you stopped a job. Turn it on to take the next job.');
 assert.equal(page({}).reason,'No new jobs start on this computer.');
 // While the stop finishes, lending is already off: Pause would pause something that is not on.
 const job='sha256:'+'a'.repeat(64);
 const stopping=lendPageVM(withLendingProjection({intent:{on:false,state:'off'},execution:{state:'stopping',job,person:'Alex Example'},lending},
  {...off,execution:'stopping',executionJob:job}),{agents,readiness:{ready:true,checks:[]}});
 assert.equal(stopping.kind,'running');assert.equal(stopping.canPause,false);
});

test('during a host outage, Lending names the circle and its host and never blames the passed checks',()=>{
 const circle={key:'circle',label:'Weekend projects',status:'blocked',detail:'Can’t reach Alex Example, which hosts the circle.',hostName:'Alex Example'};
 const lending_blockers={headline:'Lending waits: can’t reach Alex Example',first:circle,canLend:false,
  items:[{key:'docker_installed',label:'Docker Sandboxes',status:'ok',detail:'Installed and running.'},{key:'lending',label:'Lending',status:'ok',detail:'On.'},circle]};
 const page=hostName=>lendPageVM(withLendingProjection({intent:{on:true,state:'blocked',reason:'circle_unreachable'},lending:{enabled:true,circle:'shared'},
  lending_blockers:{...lending_blockers,first:{...circle,hostName},items:lending_blockers.items.map(item=>item.key==='circle'?{...circle,hostName}:item)}},
  {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'circle_unreachable'}),{agents,readiness:{ready:true,checks:[]}});
 assert.equal(page('Alex Example').reason,'The circle “Weekend projects” is unreachable. Jobs start again when Alex Example’s computer is back.');
 assert.equal(page(undefined).reason,'The circle “Weekend projects” is unreachable. Jobs start again when the host’s computer is back.');
 assert.doesNotMatch(page('Alex Example').reason,/checks below/);
});

test('Home keeps the Lending meter label and value in reading order',()=>{
 const page={...vm('The sandbox could reach your home network. Check Docker Sandboxes, then resume lending.'),meters:[{label:'Claude Code this week',value:'85%',of:'of your week left'}]};
 const out=renderFixture(LendingCard,{vm:page,device:'Laptop',lending,agents,api:{},mutate:async()=>({}),refresh(){}});
 assert.match(renderedText(out),/Claude Code this week · 85% of your week left/);
 assert.doesNotMatch(renderedText(out),/left claude code/);
});

test('Home offers the held agent’s sign-in on its lending card, the same control as Lending',async()=>{
 const {lendingStatus}=await import('../../../lib/v1/lending-status-copy.mjs');
 const reason='identity_mismatch',held=[{id:'codex',installed:true,signedIn:true,useForLending:true,signInSupported:true,lendingSignInTarget:'codex-lending',lendingSignInSupported:true,proxySignedIn:true}];
 const home=withLendingProjection({intent:{on:true,state:'ready'},lending:{...lending,enabled:true},
  lendingPolicy:{accounts:[{provider:'codex',decision:{admitted:false,reason,status:lendingStatus({reason})}}]}},{intent:'on',intentState:'ready',admission:'allowed'});
 const page=lendPageVM(home,{agents:held,readiness:{ready:true,checks:[]}});
 assert.equal(page.headline,'Check lending accounts');
 assert.equal(page.identityHold.target,'codex-lending');
 const out=renderFixture(LendingCard,{vm:page,device:'This computer',circle:'shared',lending:home.lending,agents:held,api:{},mutate:async()=>({}),refresh(){}});
 assert.match(renderedText(out),/different account is signed in to Codex/);
 assert.match(out,/<button[^>]*>Sign in to Codex<\/button>/,'the one next action is on the card');
});
