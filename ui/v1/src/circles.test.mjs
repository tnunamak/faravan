import {mount, click, flush, teardown, createFakeApi, act, installClock, advance, flushRendersWithoutEffects} from './mounted.test-helper.mjs';
import {h, render} from 'preact';
import {StartAnotherCircle} from './start-circle.jsx';
import {createMutationGate} from './api.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Circles, Circle, Devices, JoinDisclosure, InvitationDisclosure, InvitationProblem, invitationProblemText } from './circles.jsx';
import { renderFixture, renderedText } from './render.test-helper.mjs';
import { INVITATION_COPY, JOIN_COPY } from './safety-copy.mjs';
const circle={id:'circle-a',name:'Friends',owned:true,origin:'http://10.23.1.2:8787'};
const data={circles:[circle],devices:{name:'My laptop',fingerprint:'self',circles:[{circle:'circle-a',members:[{key_id:'self',device_name:'My laptop'},{key_id:'sha256:'+'a'.repeat(64),device_name:"Raj’s ThinkPad",requesterLimits:{usage:{jobs:1,milliseconds:60000}}}]}]}};
const props={circles:[circle],data,api:{},mutate(){},refresh(){}};
test('the circle list has rows and two secondary/quiet actions; no server form or empty hero', () => {
 const out=renderFixture(Circles,props), text=renderedText(out);
 assert.match(text,/Friends/);assert.match(text,/Start a circle Join with an invitation/);
 assert.doesNotMatch(text,/192\.168|Server address|Work with people you trust/);
 assert.doesNotMatch(out,/btn-primary/);
});
test('circle list loading is not the empty state', () => {
 const out=renderFixture(Circles,{...props,data:{}});
 assert.match(out,/aria-label="Loading"/);assert.doesNotMatch(renderedText(out),/Start a circle|Work with people/);
});
test('circle detail shows names, tabs and singular usage without identity internals', () => {
 const out=renderFixture(Circle,{...props,id:circle.id});const text=renderedText(out);
 assert.match(text,/Members Activity Invitations Settings/);assert.match(text,/Raj’s ThinkPad/);assert.match(text,/Today: 1 job, 1 min/);
 assert.doesNotMatch(text,/Member [12]|sha256|192\.168|Leave circle/);
 assert.match(out,/aria-label="Actions for Raj’s ThinkPad"/);
});
test('only a confirmed ask-each pending join asks the owner to compare and approve the match code', () => {
 const projected = (phase, invitationPolicy, enrollmentState = phase) => ({
  schemaVersion:2,kind:'membership',phase,evidence:{enrollmentState,origin:true},invitationPolicy,
 });
 const detail = circle => renderedText(renderFixture(Circle,{...props,circles:[circle],id:circle.id}));
 const pending = {...circle,owned:false,joinInfo:{ownerName:'Ana',code:'A1B2C3'},membershipProjection:projected('pending','each')};
 const each = detail(pending);
 assert.match(each,/Ask Ana to approve this computer/);
 assert.match(each,/compare the match code below with the code beside this computer in their approval list/);
 assert.match(each,/Match code A1B2C3/);

 const automatic = {...pending,membershipProjection:projected('pending','automatic')};
 const auto = detail(automatic);
 assert.match(auto,/Request sent\. Ana’s computer adds this one when it is online\./);
 assert.doesNotMatch(auto,/Ask Ana to approve this computer/);

 const unknown = {...pending,joinIntent:{outcome:'unknown'},membershipProjection:projected('unknown','each',null)};
 const uncertain = detail(unknown);
 assert.match(uncertain,/Couldn’t reach the host\. Faravan will retry this join\./);
 assert.doesNotMatch(uncertain,/Ask Ana to approve this computer/);
});
test('join and invitation disclosures explain data access and do not imply that joining lends', () => {
 const join=renderedText(renderFixture(JoinDisclosure,{lendingNote:'Lending is paused. Joining does not resume it.'}));
 assert.ok(join.includes(JOIN_COPY.noSideEffect));assert.ok(join.includes(JOIN_COPY.heading));
 for(const point of JOIN_COPY.points)assert.ok(join.includes(point));
 assert.match(join,/Lending is paused\. Joining does not resume it\./);
 const person=renderedText(renderFixture(InvitationDisclosure));
 assert.ok(person.includes(INVITATION_COPY.onePerson));assert.ok(person.includes(INVITATION_COPY.audience));
 assert.ok(person.includes(JOIN_COPY.noSideEffect));
 const group=renderedText(renderFixture(InvitationDisclosure,{group:true,approveEach:true}));
 assert.match(group,/Anyone with this link can ask to join, up to ten computers/);
 assert.ok(group.includes(INVITATION_COPY.audience));
 assert.doesNotMatch(person,/privately|private to this computer/);
});
test('Devices is the canonical computer list, with profile and circle links', () => {
 const out=renderFixture(Devices,props),text=renderedText(out);
 assert.match(text,/My laptop/);assert.match(text,/Raj’s ThinkPad/);assert.match(out,/href="#\/you\/profile"/);assert.match(out,/href="#\/circles"/);assert.doesNotMatch(text,/Your name|Save name|Connect a computer|View members/);
 assert.doesNotMatch(text,/Create a circle|Check again/);
 assert.match(renderFixture(Devices,{...props,data:{}}),/aria-label="Loading"/);
});

test('preview uncertainty never describes creation or an already submitted join', () => {
  for (const code of ['network_error', 'timeout', 'invite_unreachable', undefined]) {
    const text = invitationProblemText({code, outcome:'unknown'}, {kind:'preview'});
    assert.equal(text, 'Faravan couldn’t check this invitation. You haven’t submitted a join request from this review. Try Review invitation again when the host is back.');
    assert.doesNotMatch(text, /invitation was made|your invitation was created|create another|join is saved/);
  }
  assert.match(invitationProblemText({code:'network_error',outcome:'unknown'}, {kind:'join'}), /join is saved/);
  assert.match(invitationProblemText({code:'timeout'}, {kind:'invite'}), /your invitation was created/);
  assert.doesNotMatch(invitationProblemText({code:'timeout'}, {kind:'join'}), /invitation was made|your invitation was created/);
});

test('approval success describes membership effect without asserting current lending state', async () => {
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('./circles.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('success="Approved. Approving membership does not turn lending on."'));
  assert.ok(!source.includes('Approved. Lending remains off.'));
});

test('verified inviter decision includes trusted match-code guidance before approval', async () => {
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('./circles.jsx', import.meta.url), 'utf8');
  assert.match(source, /v\.verified && <p>Before approving, ask this person for the match code through your trusted conversation\. Approve only if it matches the code shown here\.<\/p>/);
  assert.match(source, /v\.verified && <Action once run=/);
  const guidance = source.indexOf('Before approving, ask this person');
  const approve = source.indexOf("'/approve'", guidance);
  assert.ok(approve > guidance, 'comparison guidance precedes the guarded approval action');
});

test('rejected invitation prefill clears the fragment and exposes only a one-shot non-secret notice', async () => {
  const {takeJoinPrefill, takeJoinPrefillRejection} = await import('./join-prefill.mjs');
  for (const fragment of ['%', encodeURIComponent('x'.repeat(16385)), encodeURIComponent('javascript:secret-value')]) {
    takeJoinPrefillRejection();
    const location = {hash:'#/circles?join=' + fragment,pathname:'/app',search:'?local=1'};
    let replacement;
    const history = {state:{},replaceState(_state,_title,url){replacement=url;}};
    assert.equal(takeJoinPrefill(location,history),'');
    assert.equal(replacement,'/app?local=1#/circles');
    const html = renderFixture(Circles,{...props,takeJoinLink:()=>''});
    assert.match(renderedText(html),/This invitation couldn’t be opened\. Paste the link from your inviter/);
    assert.doesNotMatch(html,/secret-value|javascript:/);
    assert.equal(takeJoinPrefillRejection(),false);
  }
  const noLink = {hash:'#/circles',pathname:'/app',search:''};
  assert.equal(takeJoinPrefill(noLink,{replaceState(){assert.fail('no fragment to remove');}}),'');
  assert.equal(takeJoinPrefillRejection(),false);
  assert.doesNotMatch(renderedText(renderFixture(Circles,props)),/This invitation couldn’t be opened/);
});

const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function choose(view,value) {
  await act(()=>{const select=view.$('select');select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});
  await flush();
}
test('F1 pending preset changes cannot relabel a received link', async () => {
  const request=deferred(), api=createFakeApi(); const calls=[];
  try {
    const view=await mount(h(Circle,{...props,id:circle.id,api,mutate:(path,body)=>{calls.push({path,body});return request.promise;}}));
    await click(view.button('Invite someone'));await choose(view,'group');await click(view.button('Create invitation'));
    assert.equal(view.$('select').disabled,true);
    await choose(view,'person'); // force even a disabled control's event
    assert.equal(calls[0].body.preset,'group');
    await view.rerender(h(Circle,{...props,id:circle.id,api,circles:[{...circle,approveEach:true}],mutate:()=>request.promise}));
    request.resolve({invite:'invitation-fixture'});await flush();
    assert.equal(view.$('textarea[readonly]').value,'invitation-fixture');
    assert.match(view.text(),/up to ten computers|10 computers/i,'the disclosure matches the preset that was requested');
    await choose(view,'person');
    assert.equal(view.$('textarea[readonly]'),null,'a different preset never keeps a link made for another');
  } finally {await teardown();}
});
test('F4 malformed replacement retains the old link and never announces created', async () => {
  const api=createFakeApi();let response={invite:'first-link'};
  try {
    const view=await mount(h(Circle,{...props,id:circle.id,api,mutate:async()=>response}));
    await click(view.button('Invite someone'));await click(view.button('Create invitation'));
    for(const malformed of [undefined,null,{}, {error:'failed'}, {invite:''}]) {
      response=malformed;await click(view.button('Create another invitation'));
      assert.equal(view.$('textarea[readonly]').value,'first-link');
      assert.match(view.text(),/can’t tell whether your invitation was created/);
      assert.doesNotMatch(view.text(),/Invitation created\./);
    }
  } finally {await teardown();}
});
test('F3 cached circles including empty cache explicitly report stale read failure', () => {
  const failure={code:'network_error'};
  for(const cached of [[circle],[]]) {
    const text=renderedText(renderFixture(Circles,{...props,circles:cached,data:{...data,circles:cached},errors:{circles:failure}}));
    assert.match(text,/last-known information/);assert.match(text,/Retry circles/);
    assert.doesNotMatch(text,/Work with people you trust/);
    if(cached.length)assert.match(text,/Friends/);
  }
  const memberText=renderedText(renderFixture(Circle,{...props,id:circle.id,errors:{devices:failure}}));
  assert.match(memberText,/Retry members/);assert.match(memberText,/last-known/);assert.match(memberText,/Raj’s ThinkPad/);
});
test('F3 people failure and F5 approvals retry recover through their own read', async () => {
  const api=createFakeApi();
  try {
    const view=await mount(h(Circle,{...props,id:circle.id,api}));
    await api.fail('circles/circle-a/people',new Error('read failed'));
    assert.match(view.text(),/Could not refresh people/);
    const before=api.count('circles/circle-a/people');
    await click(view.button('Retry people'));
    assert.ok(api.count('circles/circle-a/people')>before);
    await api.fail('circles/circle-a/approvals',new Error('read failed'));
    await click(view.button('Settings'));
    assert.ok(view.button('Retry approvals'));
    const approvals=api.count('circles/circle-a/approvals');
    await click(view.button('Retry approvals'));
    assert.ok(api.count('circles/circle-a/approvals')>approvals);
    await api.answer('circles/circle-a/approvals',[]);
    assert.match(view.text(),/No computers are waiting for approval/);
    assert.equal(view.button('Retry approvals'),null);
  } finally {await teardown();}
});
test('F5 clipboard denial exposes sanitized selectable details without success', async () => {
  const descriptor=Object.getOwnPropertyDescriptor(navigator,'clipboard');
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('denied');}}});
  try {
    const view=await mount(h(InvitationProblem,{problem:{code:'network_error',status:503,problem:{diagnosticId:'unsafe secret / value'}}}));
    await click(view.button('Copy details'));
    const details=view.$('textarea[readonly]');assert.ok(details);
    assert.deepEqual(JSON.parse(details.value),{code:'network_error',status:503,diagnosticId:null});
    assert.doesNotMatch(view.text(),/Details copied\./);
  } finally {if(descriptor)Object.defineProperty(navigator,'clipboard',descriptor);else delete navigator.clipboard;await teardown();}
});

test('F4 creation success without a circle id shows an error and does not navigate', async () => {
  const submit=async view=>{await act(()=>{view.$('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();};
  const before=location.hash;let calls=0;
  try {
    const view=await mount(h(StartAnotherCircle,{mutate:async()=>{calls++;return {};}}));
    await act(()=>{const input=view.$('input');input.value='Weekend';input.dispatchEvent(new Event('input',{bubbles:true}));});await flush();
    await submit(view);
    assert.match(view.text(),/couldn’t confirm the new circle/);
    assert.equal(location.hash,before);
    assert.equal(view.$('button[type="submit"]').getAttribute('aria-disabled'),'true','an unknown outcome cannot repeat the same name');
    await click(view.$('button[type="submit"]'));await submit(view);
    assert.equal(calls,1,'both button activation and forced submit remain blocked');
  } finally {await teardown();}
});

const enterCircleName=async(view,name)=>{await act(()=>{const input=view.$('input');input.value=name;input.dispatchEvent(new Event('input',{bubbles:true}));});await flush();};
const submitCircle=async view=>{await act(()=>{view.$('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();};

const withCircleNavigation = async run => {
  const saved=globalThis.location, destinations=[];
  let hash='#/start-circle';
  globalThis.location={href:saved.href,origin:saved.origin,get hash(){return hash;},set hash(value){hash=value;destinations.push(value);}};
  try {await run(destinations);} finally {try{await teardown();}finally{globalThis.location=saved;}}
};
for(const mode of ['synchronous throw','async rejection']){
  test('Check Circles navigates once after '+mode+' without replaying create',async()=>{
    await withCircleNavigation(async destinations=>{
      let creates=0,reads=0;
      const refresh=()=>{reads++;if(mode==='synchronous throw')throw new Error('read failed');return Promise.reject(new Error('read failed'));};
      const view=await mount(h(StartAnotherCircle,{mutate:async()=>{creates++;throw {code:'timeout'};},refresh}));
      await enterCircleName(view,'Weekend');await submitCircle(view);
      await click(view.button('Check Circles'));
      assert.equal(reads,1);assert.equal(creates,1);assert.deepEqual(destinations,['#/circles']);
      await submitCircle(view);assert.equal(creates,1,'navigation does not clear uncertain name');
    });
  });
}
test('pending Check Circles ignores repeated control clicks and navigates once',async()=>{
  await withCircleNavigation(async destinations=>{
    const request=deferred();let creates=0,reads=0;
    const refresh=()=>{reads++;return request.promise;};
    const view=await mount(h(StartAnotherCircle,{mutate:async()=>{creates++;throw {code:'timeout'};},refresh}));
    await enterCircleName(view,'Weekend');await submitCircle(view);
    const check=view.button('Check Circles');await click(check);
    await act(()=>{check.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));check.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));});await flush();
    assert.equal(reads,1);assert.equal(creates,1);assert.deepEqual(destinations,[]);
    request.resolve();await flush();
    assert.deepEqual(destinations,['#/circles']);assert.equal(reads,1);assert.equal(creates,1);
  });
});
for(const settlement of ['resolve','reject']){
  test('unmounted Check Circles ignores late '+settlement+' without navigating successor',async()=>{
    await withCircleNavigation(async destinations=>{
      const request=deferred();let creates=0,reads=0;
      const refresh=()=>{reads++;return request.promise;};
      const view=await mount(h(StartAnotherCircle,{mutate:async()=>{creates++;throw {code:'timeout'};},refresh}));
      await enterCircleName(view,'Weekend');await submitCircle(view);await click(view.button('Check Circles'));
      await view.unmount();
      await mount(h(StartAnotherCircle,{mutate:async()=>{throw new Error('successor must not create');}}));
      request[settlement](settlement==='reject'?new Error('late failure'):undefined);await flush();
      assert.deepEqual(destinations,[]);assert.equal(reads,1);assert.equal(creates,1);
    });
  });
}
for(const response of [{error:'internal_error',code:'internal_error'},{problem:{code:'internal_error'}}]){
  test('conservative direct internal_error envelope keeps attempted name uncertain '+JSON.stringify(response),async()=>{
    await withCircleNavigation(async destinations=>{
      let creates=0;const refresh=()=>Promise.resolve();
      const view=await mount(h(StartAnotherCircle,{mutate:async()=>{creates++;return response;},refresh}));
      await enterCircleName(view,'Weekend');await submitCircle(view);
      assert.ok(view.button('Check Circles'));assert.match(view.text(),/couldn’t confirm the new circle/);
      await click(view.$('button[type="submit"]'));await submitCircle(view);
      assert.equal(creates,1);assert.deepEqual(destinations,[]);
    });
  });
}
test('confirmed created id navigates directly without a refresh prerequisite',async()=>{
  await withCircleNavigation(async destinations=>{
    let creates=0,reads=0;const refresh=()=>{reads++;throw new Error('not a success prerequisite');};
    const view=await mount(h(StartAnotherCircle,{mutate:async()=>{creates++;return {id:'circle/confirmed'};},refresh}));
    await enterCircleName(view,'Weekend');await submitCircle(view);
    assert.deepEqual(destinations,['#/circle/circle%2Fconfirmed']);assert.equal(creates,1);assert.equal(reads,0);
  });
});

for (const [label, response] of [
  ['missing id', {}],
  ['error with id', {id:'unconfirmed',error:'internal_error'}],
  ['problem with id', {id:'unconfirmed',problem:{code:'internal_error'}}],
]) test('an unconfirmed create keeps the shared hold after remount: '+label, async()=>{
  await withCircleNavigation(async destinations=>{
    const writes=[];
    const mutate=createMutationGate({post:async(path,body)=>{
      writes.push({path,body});
      return writes.length===1?response:{id:'unexpected-second-create'};
    }});
    const refresh=async()=>{throw Error('list unavailable');};
    const first=await mount(h(StartAnotherCircle,{mutate,refresh}));
    await enterCircleName(first,'Weekend');await submitCircle(first);
    await click(first.button('Check Circles'));
    await first.unmount();
    const successor=await mount(h(StartAnotherCircle,{mutate,refresh}));
    await enterCircleName(successor,'Different name');await submitCircle(successor);
    assert.deepEqual(writes,[{path:'circles',body:{name:'Weekend'}}]);
    assert.deepEqual(destinations,['#/circles']);
    assert.match(successor.text(),/couldn’t confirm the new circle/);
  });
});

test('a confirmed create settling after unmount does not redirect its successor',async()=>{
  await withCircleNavigation(async destinations=>{
    const pending=deferred();
    let creates=0;
    const mutate=createMutationGate({post:async()=>{
      if(++creates===1)return pending.promise;
      return {id:'current-circle'};
    }});
    const first=await mount(h(StartAnotherCircle,{mutate}));
    await enterCircleName(first,'Weekend');await submitCircle(first);
    assert.equal(creates,1);
    await first.unmount();
    const successor=await mount(h(StartAnotherCircle,{mutate}));
    pending.resolve({id:'old-circle'});await flush();
    assert.deepEqual(destinations,[]);
    await enterCircleName(successor,'Current');await submitCircle(successor);
    assert.equal(creates,2,'the genuine confirmation settled the existing gate');
    assert.deepEqual(destinations,['#/circle/current-circle']);
  });
});

test('R3 F1 unknown creation blocks only attempted names and Check Circles refreshes', async()=>{
  let calls=0,refreshes=0;
  try {
    const view=await mount(h(StartAnotherCircle,{mutate:async()=>{calls++;throw {code:'timeout'};},refresh:async()=>{refreshes++;}}));
    await enterCircleName(view,'Weekend');await submitCircle(view);
    assert.equal(view.$('input').value,'Weekend');
    assert.equal(view.$('button[type="submit"]').getAttribute('aria-disabled'),'true');
    await click(view.$('button[type="submit"]'));await submitCircle(view);
    assert.equal(calls,1,'button activation and forced submit cannot repeat unknown name');
    await enterCircleName(view,'Different');assert.equal(view.$('button[type="submit"]').getAttribute('aria-disabled'),null);
    await submitCircle(view);assert.equal(calls,2);
    await enterCircleName(view,' Weekend ');assert.equal(view.$('button[type="submit"]').getAttribute('aria-disabled'),'true');
    await click(view.button('Check Circles'));assert.equal(refreshes,1);
    assert.equal(location.hash,'#/circles');
  } finally {await teardown();}
});
test('R3 F1 definite coded rejection permits same-name retry',async()=>{
  let calls=0;
  try {
    const view=await mount(h(StartAnotherCircle,{mutate:async()=>{calls++;throw {code:'invalid_name'};}}));
    await enterCircleName(view,'Weekend');await submitCircle(view);
    assert.equal(view.$('button[type="submit"]').getAttribute('aria-disabled'),null);
    await submitCircle(view);assert.equal(calls,2);
    assert.equal(view.button('Check Circles'),null);
  } finally {await teardown();}
});
test('R3 F4 error and problem envelopes with ids never navigate',async()=>{
  for(const response of [{id:'missing-circle',error:'failed'},{id:'missing-circle',problem:{code:'invalid_name'}}]){
    const before=location.hash;
    try {
      const view=await mount(h(StartAnotherCircle,{mutate:async()=>response}));
      await enterCircleName(view,'Weekend');await submitCircle(view);
      assert.equal(location.hash,before);assert.ok(view.$('[role="alert"]'));
    } finally {await teardown();}
  }
});
test('R3 F2 shared circle and member freshness notices survive all tabs and Retry uses refresh',async()=>{
  const api=createFakeApi();let refreshes=0;
  try {
    const view=await mount(h(Circle,{...props,id:circle.id,api,errors:{circles:{code:'network_error'},devices:{code:'network_error'}},refresh:async()=>{refreshes++;}}));
    for(const tab of ['Members','Settings','Activity']){
      await click(view.button(tab));
      assert.match(view.text(),/Circle details shown are last-known information/);
      assert.match(view.text(),/rows and counts shown are last-known information/);
      await click(view.button('Retry circles'));await click(view.button('Retry members'));
    }
    assert.equal(refreshes,6);
  } finally {await teardown();}
});
test('R3 F2 missing circle after read failure offers Retry rather than unavailable',async()=>{
  let refreshes=0;
  try {
    const view=await mount(h(Circle,{...props,id:circle.id,circles:[],data:{},api:createFakeApi(),errors:{circles:{code:'network_error'}},refresh:async()=>{refreshes++;}}));
    assert.match(view.text(),/Could not refresh circles/);assert.doesNotMatch(view.text(),/Circle unavailable/);
    await click(view.button('Retry circles'));assert.equal(refreshes,1);
  } finally {await teardown();}
});
test('R3 list Retry circles invokes its supplied refresh callback',async()=>{
  let refreshes=0;
  try {
    const view=await mount(h(Circles,{...props,api:createFakeApi(),errors:{circles:{code:'network_error'}},refresh:async()=>{refreshes++;}}));
    await click(view.button('Retry circles'));assert.equal(refreshes,1);
  } finally {await teardown();}
});
test('R3 stale approvals never produce a waiting badge',async()=>{
  installClock();
  const api=createFakeApi();
  try {
    const view=await mount(h(Circle,{...props,id:circle.id,api,revision:0}));
    await api.answer('circles/circle-a/approvals',[{id:'pending-fixture'}]);
    assert.ok(view.button('1 waiting to join'));
    // Respect useResource's default 5-second minimum interval before invalidation.
    await advance(5001);
    await view.rerender(h(Circle,{...props,id:circle.id,api,revision:1}));
    assert.equal(api.openReads('circles/circle-a/approvals').length,1,'the refreshed read must exist before it fails');
    await api.fail('circles/circle-a/approvals',new Error('read failed'));
    assert.equal(view.button('1 waiting to join'),null);
  } finally {await teardown();}
});
test('R3 F3 circle transition hides old invitation before passive cleanup and deferred A response',async()=>{
  const api=createFakeApi(),request=deferred(),other={...circle,id:'circle-b',name:'Other'};let calls=0,copied=[];
  const descriptor=Object.getOwnPropertyDescriptor(navigator,'clipboard');
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{copied.push(value);}}});
  const base={...props,api,circles:[circle,other],mutate:async()=>++calls===1?{invite:'a-link'}:request.promise};
  try {
    const view=await mount(h(Circle,{...base,id:circle.id}));
    await click(view.button('Invite someone'));await click(view.button('Create invitation'));
    assert.ok(view.button('Copy invitation link'));assert.equal(view.button('Copy invitation message'),null);
    await click(view.button('Copy invitation link'));assert.deepEqual(copied,['a-link']);
    await click(view.button('Create another invitation'));
    installClock();
    await flushRendersWithoutEffects(()=>render(h(Circle,{...base,id:other.id}),view.container));
    assert.equal(view.$('textarea[readonly]'),null);
    assert.equal(view.button('Copy invitation link'),null);
    await flushRendersWithoutEffects(()=>request.resolve({invite:'late-a-link'}));
    assert.equal(view.$('textarea[readonly]'),null);
  } finally {if(descriptor)Object.defineProperty(navigator,'clipboard',descriptor);else delete navigator.clipboard;await teardown();}
});
test('R3 F3 A to B to A invalidates deferred generation before passive cleanup',async()=>{
  const api=createFakeApi(),request=deferred(),other={...circle,id:'circle-b',name:'Other'};
  const base={...props,api,circles:[circle,other],mutate:()=>request.promise};
  try {
    const view=await mount(h(Circle,{...base,id:circle.id}));
    await click(view.button('Invite someone'));await click(view.button('Create invitation'));
    installClock();
    await flushRendersWithoutEffects(()=>render(h(Circle,{...base,id:other.id}),view.container));
    await flushRendersWithoutEffects(()=>render(h(Circle,{...base,id:circle.id}),view.container));
    await flushRendersWithoutEffects(()=>request.resolve({invite:'obsolete-a-link'}));
    assert.equal(view.$('textarea[readonly]'),null);
    assert.doesNotMatch(view.text(),/Invitation created\./);
  } finally {await teardown();}
});

test('R3 F1 absent refresh binding offers an honest navigation fallback',async()=>{
  try {
    const view=await mount(h(StartAnotherCircle,{mutate:async()=>({})}));
    await enterCircleName(view,'Weekend');await submitCircle(view);
    assert.equal(view.button('Check Circles'),null);
    assert.equal(view.button('Open Circles').getAttribute('href'),'#/circles');
    assert.match(view.text(),/Refresh is unavailable here/);
  } finally {await teardown();}
});


test('authoritative empty roster replaces a mounted positive list count and matches detail',async()=>{
  const api=createFakeApi(),empty={...data,devices:{...data.devices,circles:[{circle:circle.id,rosterHeld:true,members:[]}]}};
  try {
    const view=await mount(h(Circles,{...props,api}));
    assert.match(view.text(),/2 computers/);
    await view.rerender(h(Circles,{...props,api,data:empty}));
    assert.match(view.text(),/0 computers/);
    assert.doesNotMatch(view.text(),/2 computers|last-known/);
    await view.rerender(h(Circle,{...props,api,id:circle.id,data:empty}));
    assert.match(view.text(),/0 computers/);
    assert.match(view.text(),/No members are listed yet/);
    assert.doesNotMatch(view.text(),/last-known/);
  } finally {await teardown();}
});
test('unavailable roster never invents zero and error counts are explained as stale',async()=>{
  const api=createFakeApi();let refreshes=0;
  try {
    const base={...props,api,refresh:async()=>{refreshes++;}};
    const view=await mount(h(Circles,base));
    await view.rerender(h(Circles,{...base,data:{...data,devices:undefined}}));
    assert.doesNotMatch(view.text(),/0 computers/);
    await view.rerender(h(Circles,{...base,errors:{devices:{code:'network_error'}}}));
    assert.match(view.text(),/2 computers/);
    assert.match(view.text(),/Any counts shown are last-known information/);
    await click(view.button('Retry members'));assert.equal(refreshes,1);
    await view.rerender(h(Circle,{...base,id:circle.id,errors:{devices:{code:'network_error'}}}));
    assert.match(view.text(),/2 computers/);
    assert.match(view.text(),/rows and counts shown are last-known information/);
  } finally {await teardown();}
});
test('M2 an empty list without a held roster keeps the last count',async()=>{
  const api=createFakeApi(),unheld={...data,devices:{...data.devices,circles:[{circle:circle.id,rosterHeld:false,members:[]}]}};
  try {
    const view=await mount(h(Circles,{...props,api}));
    assert.match(view.text(),/2 computers/);
    await view.rerender(h(Circles,{...props,api,data:unheld}));
    assert.match(view.text(),/2 computers/);
    assert.doesNotMatch(view.text(),/0 computers/);
  } finally {await teardown();}
});


const circlePurposeInput=view=>{const label=Array.from(view.container.querySelectorAll('label')).find(label=>label.textContent.trim()==='Purpose');return label&&view.container.ownerDocument.getElementById(label.htmlFor);};
const editCirclePurpose=async(view,value)=>{await act(()=>{const input=circlePurposeInput(view);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));});await flush();};
test('purpose-only draft guards tab change, Stay preserves it and Discard explicitly clears it',async()=>{
  try {
    const view=await mount(h(Circle,{...props,id:circle.id,api:createFakeApi()}));
    await click(view.button('Settings'));await editCirclePurpose(view,'Unsaved purpose');
    await click(view.button('Members'));
    assert.ok(view.$('[role="alertdialog"]'));
    assert.equal(circlePurposeInput(view).value,'Unsaved purpose');
    await click(view.button('Stay in Settings'));
    assert.equal(view.$('[role="alertdialog"]'),null);
    assert.equal(circlePurposeInput(view).value,'Unsaved purpose');
    await click(view.button('Members'));await click(view.button('Discard changes'));
    await click(view.button('Settings'));
    assert.equal(circlePurposeInput(view).value,'');
  } finally {await teardown();}
});
test('verified profile refresh clears dirty guard; changing circle never carries the old draft',async()=>{
  const api=createFakeApi(),other={...circle,id:'circle-b',name:'Other',purpose:'Other purpose'};
  let saved,calls=[];
  const base={...props,api,id:circle.id,circles:[circle,other],mutate:async(path,body)=>{calls.push({path,body});saved={...circle,...body};return saved;}};
  try {
    const view=await mount(h(Circle,base));
    await click(view.button('Settings'));await editCirclePurpose(view,'Saved purpose');
    await click(view.button('Save circle'));
    assert.deepEqual(calls,[{path:'circles/circle-a/profile',body:{name:'Friends',purpose:'Saved purpose'}}]);
    await view.rerender(h(Circle,{...base,circles:[saved,other]}));
    await click(view.button('Members'));assert.equal(view.$('[role="alertdialog"]'),null);
    await click(view.button('Settings'));assert.equal(circlePurposeInput(view).value,'Saved purpose');
    await editCirclePurpose(view,'Unrelated draft');
    await view.rerender(h(Circle,{...base,id:other.id,circles:[saved,other]}));
    await click(view.button('Settings'));
    assert.equal(circlePurposeInput(view).value,'Other purpose');
    await click(view.button('Members'));assert.equal(view.$('[role="alertdialog"]'),null);
  } finally {await teardown();}
});

test('purpose input immediately followed by tab activation cannot outrun dirty tracking',async()=>{
  try {
    const view=await mount(h(Circle,{...props,id:circle.id,api:createFakeApi()}));
    await click(view.button('Settings'));
    await act(()=>{
      const input=circlePurposeInput(view);input.value='Fast draft';
      input.dispatchEvent(new Event('input',{bubbles:true}));
      view.button('Members').click();
    });await flush();
    assert.ok(view.$('[role="alertdialog"]'));
    assert.equal(circlePurposeInput(view).value,'Fast draft');
  } finally {await teardown();}
});

test('the draft prompt takes focus, and Stay or Discard returns focus to the chosen tab',async()=>{
  try {
    const view=await mount(h(Circle,{...props,id:circle.id,api:createFakeApi()}));
    await click(view.button('Settings'));await editCirclePurpose(view,'Unsaved purpose');
    await click(view.button('Members'));
    // Compare ids, not elements: a failing assert.equal on DOM nodes inspects the whole tree.
    assert.equal(document.activeElement?.id,'circle-draft-stay');
    await click(view.button('Stay in Settings'));
    assert.equal(document.activeElement?.id,'circle-tab-settings');
    await click(view.button('Members'));await click(view.button('Discard changes'));
    assert.equal(document.activeElement?.id,'circle-tab-members');
  } finally {await teardown();}
});
test('a whitespace-only edit does not ask to discard changes',async()=>{
  try {
    const view=await mount(h(Circle,{...props,id:circle.id,api:createFakeApi()}));
    await click(view.button('Settings'));await editCirclePurpose(view,'   ');
    await click(view.button('Members'));
    assert.ok(!view.$('[role="alertdialog"]'),'no discard prompt');
  } finally {await teardown();}
});

const outcomeRow = phase => ({...circle, owned:false, membershipProjection:{
  schemaVersion:2, kind:'membership', phase, evidence:{enrollmentState:phase,origin:true}, invitationPolicy:'each',
}});
const joinPreview = {name:'Friends', origin:circle.origin, lanMode:false};
test('join outcome uses only a newer successful raw snapshot to exclude or override a receipt', async()=>{
  const {joinOutcomeVM} = await import('./circles-view.mjs');
  const receipt=outcomeRow('approved');
  const approved=joinOutcomeVM(receipt);
  assert.equal(approved.joined,true);
  assert.equal(joinOutcomeVM(null),null);
  for(const snapshot of [null,{readId:6,rows:[]},{readId:7,rows:[]},{readId:8,rows:null},{readId:8.5,rows:[]}])
    assert.deepEqual(joinOutcomeVM(receipt,[],{snapshot,afterReadId:7}),approved);
  assert.equal(joinOutcomeVM(receipt,[receipt],{snapshot:{readId:8,rows:[]},afterReadId:7}),null,
    'a projected receipt cannot defeat authoritative exclusion');
  for(const phase of ['approved','pending','revoked']) {
    const raw={...outcomeRow(phase),name:'Current name'};
    assert.deepEqual(joinOutcomeVM(receipt,[receipt],{snapshot:{readId:8,rows:[raw]},afterReadId:7}),
      joinOutcomeVM(raw,[]),'raw membership wins over the stale approved projection: '+phase);
  }
  assert.deepEqual(joinOutcomeVM(receipt,[]),approved,'immediate success formatting needs no read metadata');
});

async function acceptMountedJoin(view) {
  if(!view.button('Join circle')) {
    await click(view.button('Join with an invitation'));
    await act(()=>{const input=view.$('textarea');input.value='fixture-invitation';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await flush();await click(view.button('Review invitation'));
  }
  await click(view.button('Join circle'));await flush();
}
test('two sequential ordinary pending joins hand off when their own newer approved raw snapshot is delivered',async()=>{
  // Assumption: the producer delivers an authoritative post-join read. This
  // is a compatibility regression, not proof that the host triggers that read.
  const row=(id,phase)=>({...outcomeRow(phase),id,name:id,
    membershipProjection:{...outcomeRow(phase).membershipProjection,invitationPolicy:'automatic'}});
  const aPending=row('join-a','pending'),aApproved=row('join-a','approved');
  const bPending=row('join-b','pending'),bApproved=row('join-b','approved');
  let receipt=aPending,barrier=10,projected=[aPending],snapshot=null;
  const joins=[];
  const api={...createFakeApi(),post:async()=>({...joinPreview,name:receipt.name})};
  const base={...props,api,takeJoinLink:()=> 'fixture-invitation',
    mutate:async(path)=>{assert.equal(path,'circles/join');joins.push(receipt.id);return receipt;},
    getCirclesReadBarrier:()=>barrier};
  const renderProps=()=>({...base,circles:projected,data:{...props.data,circles:projected},circlesSnapshot:snapshot});
  const outcome=view=>view.$('.join-outcome');
  const firstJob=view=>outcome(view)?.querySelector('a[href="#/new"]');
  try {
    const view=await mount(h(Circles,renderProps()));
    await acceptMountedJoin(view);
    assert.match(outcome(view)?.textContent??'',/Request sent/);
    assert.equal(Boolean(firstJob(view)),false);
    snapshot={readId:11,rows:[aApproved]};
    await view.rerender(h(Circles,renderProps()));
    assert.equal(firstJob(view)?.textContent,'Send your first job');
    assert.ok(outcome(view)?.querySelector('a[href="#/circle/join-a"]'));

    // Same mounted component, a different receipt and a new acceptance barrier.
    receipt=bPending;barrier=11;projected=[aApproved,bPending];
    await view.rerender(h(Circles,renderProps()));
    await acceptMountedJoin(view);
    assert.deepEqual(joins,['join-a','join-b']);
    assert.match(outcome(view)?.textContent??'',/Request sent/);
    assert.equal(Boolean(firstJob(view)),false,'approval of A must not approve B');
    snapshot={readId:11,rows:[aApproved,bApproved]};
    await view.rerender(h(Circles,renderProps()));
    assert.equal(Boolean(firstJob(view)),false,'a read at the acceptance barrier is not newer');
    snapshot={readId:12,rows:[aApproved,bApproved]};
    await view.rerender(h(Circles,renderProps()));
    assert.equal(firstJob(view)?.textContent,'Send your first job',
      'new raw approval overrides B pending in the projected list');
    assert.ok(outcome(view)?.querySelector('a[href="#/circle/join-b"]'));
    assert.equal(Boolean(outcome(view)?.querySelector('a[href="#/circle/join-a"]')),false);

    projected=[aApproved,bApproved];
    snapshot={readId:13,rows:[aApproved,row('join-b','revoked')]};
    await view.rerender(h(Circles,renderProps()));
    assert.equal(Boolean(firstJob(view)),false,'new revocation defeats the approved overlay');
    snapshot={readId:14,rows:[aApproved]};
    await view.rerender(h(Circles,renderProps()));
    assert.equal(Boolean(outcome(view)),false,'new omission retires the second receipt');
  } finally {await teardown();}
});
test('mounted outcome survives unknown/failed reads, then exclusion stays retired through errors and reappearance',async()=>{
  const receipt=outcomeRow('approved'), api={...createFakeApi(),post:async()=>joinPreview};
  let barrier=4;
  const base={...props,api,circles:[receipt],data:{},takeJoinLink:()=> 'fixture-invitation',
    mutate:async()=>receipt,getCirclesReadBarrier:()=>barrier};
  try {
    const view=await mount(h(Circles,base));await acceptMountedJoin(view);
    assert.ok(view.$('.join-outcome a'),'initial undefined raw cache does not disprove join');
    await view.rerender(h(Circles,{...base,errors:{circles:{code:'network_error'}},revision:12}));
    assert.ok(view.$('.join-outcome a'),'failure and unrelated revision cannot disprove join');
    await view.rerender(h(Circles,{...base,data:{circles:[]},circlesSnapshot:{readId:4,rows:[]}}));
    assert.ok(view.$('.join-outcome a'),'read begun before receipt acceptance is ineligible');
    await view.rerender(h(Circles,{...base,data:{circles:[]},circlesSnapshot:{readId:5,rows:[]}}));
    assert.ok(view.$('.join-outcome')===null,'new successful exclusion hides outcome despite projected receipt');
    await view.rerender(h(Circles,{...base,data:{circles:[]},circles:[{...receipt}],errors:{circles:{code:'network_error'}},circlesSnapshot:{readId:6,rows:[receipt]}}));
    assert.ok(view.$('.join-outcome')===null,'neither error nor later reappearance revives an old receipt');
    barrier=7;
    await acceptMountedJoin(view);
    assert.ok(view.$('.join-outcome a'),'a genuinely new join stores a new receipt');
    await view.rerender(h(Circles,{...base,circlesSnapshot:{readId:7,rows:[]}}));
    assert.ok(view.$('.join-outcome a'),'old in-flight exclusion cannot retire the rejoin');
    await view.rerender(h(Circles,{...base,circlesSnapshot:{readId:8,rows:[]}}));
    assert.ok(view.$('.join-outcome')===null,'next eligible exclusion retires only the new receipt');
  } finally {await teardown();}
});
test('join captures the live barrier at acceptance, not the render that started the mutation',async()=>{
  const receipt=outcomeRow('approved'), request=deferred();
  let barrier=2;
  const base={...props,api:{...createFakeApi(),post:async()=>joinPreview},circles:[],
    takeJoinLink:()=> 'fixture-invitation',mutate:()=>request.promise,getCirclesReadBarrier:()=>barrier};
  try {
    const view=await mount(h(Circles,base));
    await click(view.button('Join circle'));
    barrier=9;request.resolve(receipt);await flush();
    await view.rerender(h(Circles,{...base,circlesSnapshot:{readId:9,rows:[]}}));
    assert.ok(view.$('.join-outcome a'),'a read started during mutation remains behind acceptance boundary');
    await view.rerender(h(Circles,{...base,circlesSnapshot:{readId:10,rows:[]}}));
    assert.ok(view.$('.join-outcome')===null);
  } finally {await teardown();}
});
test('Members tab passes archived and closed lifecycle to loaded people',async()=>{
  const api=createFakeApi(), member=data.devices.circles[0].members[1];
  try {
    const view=await mount(h(Circle,{...props,id:circle.id,api}));
    await api.answer('circles/circle-a/people',[{personId:'person-a',name:'Raj',role:'member',computers:[member]}]);
    assert.ok(view.$('[aria-label="People in this circle"]'));
    for(const lifecycle of ['archived','closed']) {
      await view.rerender(h(Circle,{...props,id:circle.id,api,circles:[{...circle,lifecycle}]}));
      assert.ok(view.text().includes('Circle '+lifecycle+' · No new jobs'));
      assert.doesNotMatch(view.text(),/Online · Lending enabled/);
    }
  } finally {await teardown();}
});


import {JoinOutcome} from './circles.jsx';
import {joinOutcomeVM} from './circles-view.mjs';
test('approved joins and circle details hand off to the first job, not pending joins', () => {
  for (const phase of ['approved','pending','unknown','rejected','expired','revoked']) {
    const row=outcomeRow(phase);
    const outcome=renderFixture(JoinOutcome,{outcome:joinOutcomeVM(row)});
    const detail=renderFixture(Circle,{...props,id:row.id,circles:[row]});
    if (phase==='approved') assert.match(outcome,/href="#\/new"[^>]*>Send your first job</);
    else assert.doesNotMatch(outcome,/Send your first job/);
    if (phase==='approved') assert.match(detail,/href="#\/new"[^>]*>Send a job</);
    else assert.doesNotMatch(detail,/>Send a job</);
    if (phase==='approved') {
      assert.match(renderedText(outcome),/View circle/);
      assert.doesNotMatch(renderedText(outcome)+renderedText(detail),/last circle|before sending/);
    }
  }
});

import {composeIn} from './circles.jsx';
test('Send a job from a circle opens the composer on that circle', () => {
  const saved=new Map(),before=globalThis.localStorage;
  globalThis.localStorage={setItem:(k,v)=>saved.set(k,v),getItem:k=>saved.get(k)??null};
  try {composeIn('circle-b')();assert.equal(saved.get('faravan-compose-circle'),'circle-b');}
  finally {globalThis.localStorage=before;}
});

// Item 5 (1102 review): an owner of an approved circle gets one primary action. Alone in the circle, Invite someone is
// the first step; with other computers in it, Send a job is primary and Invite someone steps down to secondary.
const withMembers = (keys) => ({...data, devices:{...data.devices, circles:[{circle:'circle-a', members:keys.map(key => ({key_id:key, device_name:key}))}]}});
test('an owner of an approved circle has one primary action: Invite while it has only this computer, Send a job once others are in it', () => {
  const alone = renderFixture(Circle, {...props, id:'circle-a', circles:[circle], data:withMembers(['self'])});
  assert.match(alone, /class="btn btn-primary"[^>]*>Invite someone<\/button>/);
  assert.match(alone, /<a class="btn btn-secondary" href="#\/new"[^>]*>Send a job<\/a>/);
  const shared = renderFixture(Circle, {...props, id:'circle-a', circles:[circle], data:withMembers(['self', 'sha256:' + 'a'.repeat(64)])});
  assert.match(shared, /class="btn btn-secondary"[^>]*>Invite someone<\/button>/);
  assert.match(shared, /<a class="btn btn-primary" href="#\/new"[^>]*>Send a job<\/a>/);
  assert.equal((shared.match(/class="btn btn-primary"/g) || []).length, 1, 'only one primary action in the header and row');
});

// Item 10 (1102 review): the irreversible removal of a computer is named as removal, not as the reversible "Block".
test('removing a computer from an owned circle is named as removal, not as Block', () => {
  const out = renderFixture(Circle, {...props, id:'circle-a', circles:[circle]});
  assert.match(out, />Remove this computer<\/button>/);
  assert.doesNotMatch(out, />Block this computer<\/button>/);
});

test('D6 ordinary approved join needs no extra approval while explicit each stays pending',async()=>{
  for(const [phase,invitationPolicy] of [['approved','automatic'],['pending','each']]) {
    const receipt={...outcomeRow(phase),membershipProjection:{...outcomeRow(phase).membershipProjection,invitationPolicy}};
    const calls=[];
    const api={...createFakeApi(),post:async()=>joinPreview};
    try {
      const view=await mount(h(Circles,{...props,api,circles:[],data:{circles:[]},
        takeJoinLink:()=> 'fixture-invitation',
        mutate:async(path,body)=>{calls.push({path,body});return receipt;}}));
      await click(view.button('Join circle'));await flush();
      assert.deepEqual(calls.map(call=>call.path),['circles/join'],'the UI never grants approval itself');
      if(phase==='approved') {
        assert.ok(view.$('.join-outcome a[href="#/new"]'),'approved join exposes first-job handoff');
        assert.equal(view.button('Join circle'),null);
        assert.doesNotMatch(view.text(),/Ask .*approve this computer/);
      } else {
        assert.equal(view.$('.join-outcome a[href="#/new"]'),null,'pending membership never becomes usable');
        assert.ok(view.$('.join-outcome'),'pending receipt remains visible');
      }
    } finally {await teardown();}
  }
});
test('D6 rejected invitation review never offers Join or submits a membership mutation',async()=>{
  for(const code of ['invite_expired','invite_revoked','invalid_invite']) {
    let mutations=0;
    try {
      const api={...createFakeApi(),post:async()=>{throw {code};}};
      const view=await mount(h(Circles,{...props,api,circles:[],data:{circles:[]},
        takeJoinLink:()=> 'invalid-fixture-invitation',mutate:async()=>{mutations++;throw new Error('unexpected join');}}));
      await flush();
      assert.equal(view.button('Join circle'),null);
      assert.ok(view.$('[role="alert"]'));
      assert.equal(mutations,0);
      assert.equal(view.$('.join-outcome a[href="#/new"]'),null);
    } finally {await teardown();}
  }
});

 test('Circles renders verified people counts and omits unknown counts', () => {
  const known={...circle,personCount:2};
  const text=renderedText(renderFixture(Circles,{...props,circles:[known]}));
  assert.match(text,/2 people · 2 computers/);
  const unknown=renderedText(renderFixture(Circles,props));
  assert.match(unknown,/2 computers/);
  assert.doesNotMatch(unknown,/\d+ (?:people|person)\b/);
});


test('circle Jobs history clears a failure warning only on verified empty recovery', async () => {
  const {circleJobsStatus} = await import('./circles-view.mjs');
  const circleId = 'first-circle';
  assert.equal(circleJobsStatus(circleId, undefined), null, 'legacy empty is not verified');
  assert.equal(circleJobsStatus(circleId, [{circleId,state:'skipped'}]), null);
  const fallback = [{circleId,state:'unavailable',reason:'busy',cachedRows:1}];
  assert.deepEqual(circleJobsStatus(circleId, fallback), {
    message:'The circle host is busy. Job history could not be refreshed. Saved jobs may still be shown.',warning:true,
  });
  assert.equal(circleJobsStatus(circleId, [{circleId,state:'unavailable',reason:'unreachable',cachedRows:0}]).warning, true,
    'a failed read whose cached rows are all filtered still warns');
  assert.match(circleJobsStatus(circleId, [{circleId,state:'unavailable',reason:'missing'}]).message,/no longer available/);
  const recovered = [{circleId,state:'verified_empty'}];
  assert.equal(circleJobsStatus(circleId, recovered, [], {status:403}).warning, true, 'a failed refresh cannot leave a verified-empty label');
  assert.deepEqual(circleJobsStatus(circleId, recovered), {
    message:'No jobs were found in the latest check.',warning:false,
  });
});

test('circle Jobs history says a member-only list is partial, never verified or empty', async () => {
  const {circleJobsStatus} = await import('./circles-view.mjs');
  const circleId = 'first-circle', savedAt = '2026-11-22T10:30:00.000Z';
  const live = circleJobsStatus(circleId, [{circleId,state:'partial',reason:'unreachable',liveRows:0,cachedRows:0,members:[]}]);
  assert.equal(live.warning, true, 'a partial check is never a verified-empty label');
  assert.match(live.message, /member computers confirmed/);
  assert.doesNotMatch(live.message, /No jobs were found/);
  assert.equal(live.savedAt, undefined);
  const withSaved = circleJobsStatus(circleId, [{circleId,state:'partial',reason:'unreachable',liveRows:1,cachedRows:2,savedAt}]);
  assert.match(withSaved.message, /Saved jobs may still be shown/);
  assert.equal(withSaved.savedAt, savedAt);
  const {circlesListVM} = await import('./circles-view.mjs');
  const [row] = circlesListVM([{id:circleId,name:'Friends',origin:'https://host.invalid',rosterMembershipVerified:true}],
    undefined, null, {uncheckedCircles:[{id:circleId,reason:'partial'}]});
  assert.match(row.meta, /Host offline/, 'a member-only list still means the host was unreachable');
});

test('selected circle Jobs distinguishes a saved empty list from a missing receipt', async () => {
  const {markSaved, selectedJobListCoverage} = await import('../../../lib/v1/saved-reads.mjs');
  const {circleJobsStatus} = await import('./circles-view.mjs');
  const circleId = 'first-circle', savedAt = '2026-11-22T10:30:00.000Z';
  const saved = selectedJobListCoverage(circleId, [], savedAt, 'unreachable');
  assert.deepEqual(saved, {
    items: [],
    circleCoverage: [{circleId,state:'unavailable',reason:'unreachable',cachedRows:0,savedAt}],
  });
  assert.match(circleJobsStatus(circleId, saved.circleCoverage).message, /no jobs in the saved view/i);
  assert.equal(circleJobsStatus(circleId, saved.circleCoverage).savedAt, savedAt);
  assert.equal(circleJobsStatus('different-circle', saved.circleCoverage), null);
  assert.equal(circleJobsStatus(circleId, saved.circleCoverage, [], {status:403}).savedAt, undefined);
  const missing = circleJobsStatus(circleId, [{circleId,state:'unavailable',reason:'unreachable'}]);
  assert.equal(missing.savedAt, undefined);
  assert.doesNotMatch(missing.message, /empty|no jobs/i);
  assert.equal(circleJobsStatus(circleId, [{...saved.circleCoverage[0],savedAt:'unknown'}]).savedAt, undefined);
  assert.deepEqual(markSaved([], savedAt, 'unreachable'), [], 'legacy callers still receive a raw array');
  assert.equal(selectedJobListCoverage(circleId, []).circleCoverage[0].state, 'verified_empty');
});
