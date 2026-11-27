import test from 'node:test';
import assert from 'node:assert/strict';
import {invitationVM} from './invitations-view.mjs';
import {InvitationList, Invitations, invitationTime} from './invitations.jsx';
import {renderFixture,renderedText} from './render.test-helper.mjs';
const item={id:'test-invite',state:'issued',createdAt:'2026-10-20T12:00:00Z',expiresAt:'2026-10-21T12:00:00Z',approved:0,waiting:0,maxUses:1};
test('invitation view distinguishes pending, used, expired and uncertain revokes without secret links',()=>{
  for(const [state,label] of Object.entries({issued:'Issued',join_status_unavailable:'Join status unavailable',approval_unconfirmed:'Approval not confirmed',waiting:'Waiting for approval',claimed:'Used',expired:'Expired',revoked:'Revoked',revocation_unconfirmed:'Revoke not confirmed',publication_unconfirmed:'Publication not confirmed'})) {
    const view=invitationVM({...item,state},x=>x);
    assert.equal(view.state,label);assert.equal(view.canRevoke,!['expired','revoked'].includes(state));
  }
});
test('invitation list shows limits, expiry and revocation; error does not imply empty history',()=>{
  const out=renderFixture(InvitationList,{items:[item],circleId:'c1',mutate(){},setDialog(){}}),text=renderedText(out);
  assert.match(text,/Issued/);assert.match(text,/Up to 1 computer/);assert.match(text,/Expires/);assert.match(text,/Revoke invitation/);
  assert.doesNotMatch(text,/test-invite|https?:|sha256/);
  assert.match(renderedText(renderFixture(InvitationList,{items:[],error:{message:'Unavailable'},refresh(){}})),/Retry invitations/);
});

test('offline invitation counts stay unavailable rather than turning into zero',()=>{
 const view=invitationVM({...item,waiting:null},x=>x);
 assert.match(view.usage,/Waiting count unavailable/);assert.doesNotMatch(view.usage,/null|0 waiting/);
});

test('unreadable invitation counts use plain unavailable labels',()=>{
 const view=invitationVM({...item,approved:null,unconfirmed:null,waiting:null},x=>x);
 assert.equal(view.usage,'Approval count unavailable · Not-confirmed count unavailable · Waiting count unavailable · Up to 1 computer');
 assert.doesNotMatch(view.usage,/null|undefined/);
});

test('invitation audience is the heading and state is a separate pill',()=>{
 const single=renderFixture(InvitationList,{items:[item],circleId:'c1'});
 assert.match(single,/<h3[^>]*>One computer<\/h3>/);
 assert.match(single,/<span class="pill[^"]*">Issued<\/span>/);
 const group=renderFixture(InvitationList,{items:[{...item,maxUses:10,state:'revoked'}],circleId:'c1'});
 assert.match(group,/<h3[^>]*>Group chat<\/h3>/);
 assert.doesNotMatch(group,/>Revoke invitation</);
 const labelled=invitationVM({...item,label:'For Morgan'},x=>x);
 assert.equal(labelled.title,'For Morgan');
});
test('history has one short explanation and a styled refresh without repeating its tab heading',()=>{
 const html=renderFixture(Invitations,{circleId:'c1',api:{get(){}}});
 assert.doesNotMatch(html,/<h2[^>]*>Invitations</);
 assert.match(html,/<button[^>]*class="btn btn-secondary"[^>]*>Refresh invitations<\/button>/);
 assert.match(renderedText(html),/Created on this computer\./);
});
test('invitation times use minutes without seconds',()=>{
 const time=invitationTime('2026-10-20T12:00:00Z');
 assert.match(time,/2026/);assert.doesNotMatch(time,/\d+:\d+:\d+/);
 assert.equal(invitationTime('not-a-date'),'');
});

test("revoking an invitation explicitly reloads its own history after the write",async()=>{
 const calls=[];let dialog;
 const tree=InvitationList({items:[item],circleId:"c1",mutate:async()=>{calls.push("write");},refresh:()=>{calls.push("reload");},setDialog:d=>{dialog=d;}});
 const nodes=[];const visit=n=>{if(!n||typeof n!=="object")return;if(Array.isArray(n)){n.forEach(visit);return;}nodes.push(n);visit(n.props?.children);};visit(tree);
 nodes.find(n=>n.props?.children==="Revoke invitation").props.onClick();
 await dialog.onConfirm();assert.deepEqual(calls,["write","reload"]);
});

test('H7 loaded empty history states local provenance once',async()=>{
 const {mount,teardown,resetPage,createFakeApi}=await import('./mounted.test-helper.mjs');
 const {h}=await import('preact');
 resetPage();const api=createFakeApi();
 try {
   const app=await mount(h(Invitations,{circleId:'c1',api}));
   await api.answer('circles/c1/invitations',[]);
   assert.match(app.text(),/No invitations created on this computer yet/);
   assert.equal((app.text().match(/on this computer/g)||[]).length,1);
 } finally {await teardown();}
});
