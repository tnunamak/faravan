import {flush, mount, resetPage, teardown, click} from './mounted.test-helper.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {App} from './main.jsx';
import {createApi} from './api.mjs';

// The member address flow, driven through the production Circle settings controls against a real app fixture
// (owner, declining peer and lender are real apps over a real signed-roster coordinator). The only fake is the
// Gozar provider. No browser, no network beyond loopback, no real route or credential.

const {appFixture,api,waitFor}=await import('../../../tests/helpers/v1-app-fixture.mjs');
const {provider,approved,publicOrigin}=await import('../../../tests/helpers/fake-gozar-provider.mjs');
const p=await import('../../../lib/protocol/index.mjs');

afterEach(teardown);

const liveApi=app=>createApi(app.token,(path,options)=>fetch(app.origin+path,options));
const rosterOf=async(app,id)=>(await app.device.rosterCache(id).get()).current.payload;
const pageText=view=>view.text();

// Real timers: this journey crosses real loopback requests, so waits poll the DOM instead of moving a clock.
async function until(view,check,label,timeout=15000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {
    await flush();
    const value=check();
    if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.fail('Timed out waiting for '+label+'. Page: '+(t=>t.slice(Math.max(0,t.indexOf('Address for this computer')),Math.max(0,t.indexOf('Address for this computer'))+700))(pageText(view))+' | dialogs: '+view.container.querySelectorAll('dialog').length);
}
const press=async(view,label)=>{const button=await until(view,()=>view.button(label),'button '+label);await click(button);return button;};
async function open(app,circle,id) {
  resetPage('#/circle/'+encodeURIComponent(circle));
  const view=await mount(h(App,{api:liveApi(app),takeJoinLink:()=>''}),{id});
  await press(view,'Settings');
  return view;
}
const dialogButton=(view,label)=>[...view.container.querySelectorAll('dialog button')].find(el=>el.textContent.trim()===label)??null;
const confirm=async(view,label)=>{const button=await until(view,()=>dialogButton(view,label),'dialog button '+label);await click(button);};

test('a member sends their verified address from Circle settings and the publisher approves exactly that request',{timeout:240000},async t=>{
  const f=await appFixture(t),fake=provider();
  const {owner,declining,lender,circle}=await f.realConnect({lenderOptions:{memberGozar:fake.api,memberRecheckMs:20}});
  const id=circle.id,lenderId=lender.app.device.keyId,ownerId=owner.app.device.keyId,otherId=declining.app.device.keyId;
  const initial=await rosterOf(owner.app,id);

  const member=await open(lender.app,id,'member');
  await until(member,()=>/Address for this computer/.test(member.text()),'the address card');
  assert.match(member.text(),/Nothing is shared with the circle until you send the address and an owner approves it/);
  assert.equal(fake.log.catalog.length+fake.log.ensure.length,0,'opening the page asks the provider for nothing');
  await press(member,'Review address');
  await until(member,()=>/Open an address for this computer\?/.test(member.text()),'the consent dialog');
  assert.equal(fake.log.ensure.length,0);
  const consent=member.$('dialog').textContent.replace(/\s+/g,' ');
  assert.match(consent,/fake will give this computer an internet address/);
  assert.match(consent,/Nothing is shared with the circle yet/);

  // A route the provider cannot start is never shown as an address.
  fake.state.failEnsure=true;
  await confirm(member,'Approve address');
  await until(member,()=>/Address approved/.test(member.text()),'approved, not started');
  await press(member,'Start address');
  await until(member,()=>/The address did not start, so nothing was shared/.test(member.text()),'start failure note');
  assert.equal(lender.app.memberExposure.origin(),null);
  assert.doesNotMatch(member.text(),/member\.example|works/);
  assert.equal((await api(owner.app,'/api/circles/'+id+'/member-origins')).items.length,0);
  fake.state.failEnsure=false;
  await press(member,'Review address');
  await confirm(member,'Approve address');
  await press(member,'Start address');
  await until(member,()=>/member\.example works/.test(member.text()),'verified address');
  assert.equal(lender.app.memberExposure.origin(),publicOrigin);
  assert.equal((await api(owner.app,'/api/circles/'+id+'/member-origins')).items.length,0,'a verified route alone sends nothing');

  // The page never shows the provider handle or the local listener target.
  const {target}=await lender.app.memberListener.start();
  const route=[...fake.routes.values()].find(row=>row.owner==='faravan-member');
  for(const secret of [target,String(new URL(lender.app.origin).port),route.handle.id,route.operationId,'127.0.0.1'])
    assert.equal(member.container.innerHTML.includes(secret),false,'the page shows no '+secret);

  // An older host cannot take an address: a plain note, and nothing is shown as sent.
  const send=lender.app.device.proposeMemberOrigin;
  lender.app.device.proposeMemberOrigin=async()=>{throw Object.assign(new Error('not_found'),{code:'not_found',status:404});};
  await press(member,'Send for approval');
  await until(member,()=>/runs an older Faravan and cannot take an address yet/.test(member.text()),'older host note');
  assert.doesNotMatch(member.text(),/Sent member\.example/);
  // A host that does not answer is an ordinary connection problem: nothing is shown as sent and the same button stays.
  lender.app.device.proposeMemberOrigin=async()=>{throw Object.assign(new Error('offline'),{code:'network_error',status:502});};
  await press(member,'Send for approval');
  await until(member,()=>/host did not answer\. Send the address again when it is back/.test(member.text()),'offline note');
  assert.doesNotMatch(member.text(),/Sent member\.example/);
  assert.ok(member.button('Send for approval'),'the next action stays');
  lender.app.device.proposeMemberOrigin=send;

  await press(member,'Send for approval');
  await until(member,()=>/Sent member\.example for approval/.test(member.text()),'sent');
  assert.match(member.text(),/Other computers do not see it until an owner approves it/);
  const [first]=(await api(owner.app,'/api/circles/'+id+'/member-origins')).items;
  assert.deepEqual([first.keyId,first.state,first.address],[lenderId,'proposed','member.example']);
  const name=first.name;

  // The proposer cannot approve its own address, in the page or in the API.
  assert.equal(member.button('Approve address for '+name),null);
  const refused=await api(lender.app,'/api/circles/'+id+'/member-origins/accept',{method:'POST',status:403,
    body:{keyId:lenderId,proposalDigest:first.proposalDigest,rosterEpoch:first.rosterEpoch}});
  assert.equal(refused.code,'not_owner');
  assert.equal((await rosterOf(owner.app,id)).epoch,initial.epoch);

  // The publisher opens the same circle's settings and sees exactly that request.
  const publisher=await open(owner.app,id,'publisher');
  await until(publisher,()=>/Offers the address member\.example/.test(publisher.text()),'the request');
  assert.equal(publisher.button('Review address'),null,'the owner has no member address card');

  // The member's route is lost and replaced while the publisher still shows the old request: that approval is
  // refused as changed, and the page refreshes to the current request instead of publishing the old one.
  fake.lose(route.handle.id);
  await waitFor(()=>lender.app.memberExposure.origin()===null,'route loss');
  await waitFor(async()=>(await api(owner.app,'/api/circles/'+id+'/member-origins')).items[0]?.state==='withdrawn','withdrawn request');
  const lost=await open(lender.app,id,'member-lost');
  await until(lost,()=>/The address stopped working\. Review it again/.test(lost.text()),'lost route');
  await press(lost,'Review address');
  await confirm(lost,'Approve address');
  await press(lost,'Start address');
  await until(lost,()=>/member\.example works/.test(lost.text()),'second route');
  await press(lost,'Send for approval');
  await until(lost,()=>/Sent member\.example for approval/.test(lost.text()),'second send');

  await press(publisher,'Approve address for '+name);
  await until(publisher,()=>/Approve member\.example for /.test(publisher.text()),'approval dialog');
  await confirm(publisher,'Approve address');
  await until(publisher,()=>/changed\. Review the current request/.test(publisher.text()),'changed note');
  assert.equal((await rosterOf(owner.app,id)).epoch,initial.epoch,'the old request published nothing');
  await until(publisher,()=>publisher.button('Approve address for '+name),'the refreshed request');

  // The exact current request is approved: the signed member entry changes, and nothing else does.
  await press(publisher,'Approve address for '+name);
  await confirm(publisher,'Approve address');
  await until(publisher,()=>/member\.example is in the signed member list/.test(publisher.text()),'approved');
  await lender.app.device.refreshRoster(id);await declining.app.device.refreshRoster(id);
  for(const view of [await rosterOf(owner.app,id),await rosterOf(lender.app,id),await rosterOf(declining.app,id)]) {
    assert.equal(view.epoch,initial.epoch+1);
    assert.equal(p.findMember(view,lenderId).origin,publicOrigin);
    assert.equal(view.coordinator,initial.coordinator);
    for(const key of [ownerId,otherId])assert.deepEqual(p.findMember(view,key),p.findMember(initial,key));
  }

  // The member learns it from the signed roster.
  await press(lost,'Check for approval');
  await until(lost,()=>/An owner approved member\.example/.test(lost.text()),'signed');
  assert.equal(lost.button('Send for approval'),null);
  await lender.app.close();
  assert.deepEqual([...fake.routes.keys()].sort(),['coordinator-route','foreign-route']);
});
