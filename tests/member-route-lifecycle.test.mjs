import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {connect} from 'node:net';
import {join} from 'node:path';
import {appFixture,waitFor} from './helpers/v1-app-fixture.mjs';
import {provider,approved,publicOrigin,digest} from './helpers/fake-gozar-provider.mjs';

// The member's own Gozar route lifecycle through the ordinary app entry point (owner-offline topology).
// The provider is an injected fake that models only what the shared hosting wrapper asks of Gozar: a route
// forwards to exactly the target it was installed for, a close removes exactly its own handle, and a route
// installed for another owner is never touched. No network, no credentials, no real route.

const accepts=port=>new Promise(resolve=>{
  const socket=connect({host:'127.0.0.1',port},()=>{socket.destroy();resolve(true);});
  socket.on('error',()=>resolve(false));
});

test('the member route serves exactly its own listener, only after approval, and withdraws on route loss',{timeout:180000},async t=>{
  const f=await appFixture(t),fake=provider();
  const {app,home}=await f.start('member',{memberGozar:fake.api,memberRecheckMs:20});
  const {target,port}=await app.memberListener.start();
  assert.notEqual(String(port),new URL(app.origin).port,'the listener is not the tray port');

  // No route and no origin before a valid approval, however the member asks.
  const listed=await app.memberExposure.offers();
  assert.equal(listed.spec.target,target,'the offer is for exactly the protocol-only listener');
  assert.deepEqual(fake.log.catalog.map(query=>[query.owner,query.target]),[['faravan-member',target]]);
  assert.equal(listed.offers.some(offer=>'approval' in offer),false,'the approval token never leaves the hosting wrapper');
  await assert.rejects(()=>app.memberExposure.start(),{code:'consent_required'});
  await assert.rejects(()=>app.memberExposure.approve({providerId:'fake',consentFactsDigest:'sha256:stale'}),{code:'candidate_stale'});
  await assert.rejects(()=>app.memberExposure.start(),{code:'consent_required'});
  assert.equal(fake.log.ensure.length,0,'the provider was never asked to install a route');
  assert.equal(app.memberExposure.origin(),null);

  await approved(app,fake);
  assert.equal(fake.log.ensure.length,0,'approval alone installs nothing');
  const started=await app.memberExposure.start();
  assert.equal(started.origin,publicOrigin);
  assert.equal(app.memberExposure.origin(),publicOrigin);
  assert.equal(fake.log.ensure.length,1);
  const [request]=fake.log.ensure;
  assert.equal(request.owner,'faravan-member','its own owner scope, not the coordinator, tray or gateway');
  assert.equal(request.target,target);
  assert.equal(request.approval.consentFactsDigest,digest,'the approved offer is what the provider received');
  assert.equal(fake.routes.get(started.route.handle.id).target,target,'the route forwards to exactly the listener target');
  const saved=JSON.parse(await readFile(join(home,'v1','me','exposure.json'),'utf8'));
  assert.equal(saved.handle.id,started.route.handle.id,'owner, operation and handle are on disk');
  assert.equal(saved.routeOperationId,started.route.operationId);
  await assert.rejects(readFile(join(home,'v1','ce','exposure.json')),{code:'ENOENT'},'the ChatGPT scope is separate');

  // A lost proof withdraws the origin and it is never published again by this route.
  fake.lose(started.route.handle.id);
  await waitFor(()=>app.memberExposure.origin()===null,'withdrawal on route loss');
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(app.memberExposure.origin(),null,'a lost route stays withdrawn');

  // Closing removes only the member's own route.
  await app.close();
  assert.deepEqual([...fake.routes.keys()].sort(),['coordinator-route','foreign-route'],'foreign and coordinator routes survive');
  assert.deepEqual(fake.log.close.map(call=>call.handle.id),[started.route.handle.id]);
  assert.equal(fake.log.close[0].mode,'remove');
});

test('close racing an in-progress start leaves no published origin and removes the late owned route',{timeout:180000},async t=>{
  const f=await appFixture(t),fake=provider();
  const {app}=await f.start('late',{memberGozar:fake.api,memberRecheckMs:20});
  await approved(app,fake);
  let release;
  fake.state.gate=new Promise(resolve=>{release=resolve;});
  const entered=new Promise(resolve=>{fake.state.entered=resolve;});
  const starting=app.memberExposure.start();
  starting.catch(()=>{});
  await entered;
  const closing=app.close();
  closing.catch(()=>{});
  await waitFor(()=>app.memberExposure.state==='retiring','the fence');
  assert.equal(app.memberExposure.origin(),null);
  await assert.rejects(()=>app.memberExposure.start(),{code:'operation_conflict'},'no new start after the fence');
  await assert.rejects(()=>app.memberListener.start(),{code:'app_closing'},'no new listener after the fence');
  release();
  await assert.rejects(starting,{code:'operation_conflict'},'the late result is never published');
  assert.equal(app.memberExposure.origin(),null);
  await closing;
  assert.equal(fake.log.ensure.length,1);
  assert.deepEqual(fake.log.close.map(call=>call.handle.id),['route-2'],'the late owned route was retired by its exact handle');
  assert.deepEqual([...fake.routes.keys()].sort(),['coordinator-route','foreign-route']);
  assert.equal(app.memberListener.port,null);
});

test('a listener bind that loses to the fence is released, never handed out',{timeout:120000},async t=>{
  const f=await appFixture(t),fake=provider();
  const {app}=await f.start('bind',{memberGozar:fake.api});
  const binding=app.memberListener.start();
  binding.catch(()=>{});
  app.memberListener.fence();
  await assert.rejects(binding,{code:'app_closing'});
  assert.equal(app.memberListener.port,null);
  assert.equal(app.memberListener.server?.listening??false,false);
  await app.close();
});

test('unconfirmed cleanup keeps the exact owner, operation and handle, and the next open retries it',{timeout:180000},async t=>{
  const f=await appFixture(t),fake=provider();
  const first=await f.start('reopen',{memberGozar:fake.api,memberRecheckMs:20});
  await approved(first.app,fake);
  const started=await first.app.memberExposure.start();
  const {port}=await first.app.memberListener.start();
  fake.state.refuse=true;
  await first.app.close().catch(()=>{});
  assert.equal(fake.log.close.length,1);
  assert.deepEqual(fake.log.close[0].handle,started.route.handle);
  assert.ok(fake.routes.has(started.route.handle.id),'an unconfirmed removal leaves the route in place');
  const file=join(first.home,'v1','me','exposure.json');
  const retained=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(retained.handle,started.route.handle);
  assert.equal(retained.routeOperationId,started.route.operationId);
  assert.equal(await accepts(port),false,'the listener closed even though cleanup is pending');

  fake.state.refuse=false;
  const second=await f.start('reopen',{memberGozar:fake.api,memberRecheckMs:20});
  await waitFor(()=>!fake.routes.has(started.route.handle.id),'exact retry on reopen');
  const retries=fake.log.close.slice(1);
  assert.ok(retries.length>=1);
  for(const call of retries){assert.deepEqual(call.handle,started.route.handle);assert.equal(call.mode,'remove');}
  assert.deepEqual([...fake.routes.keys()].sort(),['coordinator-route','foreign-route']);
  await waitFor(async()=>JSON.parse(await readFile(file,'utf8')).handle===undefined,'the retained handle is cleared');
  assert.equal(second.app.memberExposure.origin(),null,'recovery publishes nothing');
});
