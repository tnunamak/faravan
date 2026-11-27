import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture,api } from './helpers/v1-app-fixture.mjs';

test('update status and check are available through REST and registered ops without installing', {timeout:60000},async t=>{
  const f=await appFixture(t);let checks=0;
  const updater={startDelayMs:3600000,intervalMs:3600000,check:async()=>{checks++;return {current:'1.0.0',manifest:{version:'1.1.0',notes:'Session recovery'}};},tick:async()=>{throw Error('must not install');}};
  const {app}=await f.start('updates',{updater,faravanVersion:'1.0.0'});
  assert.equal((await api(app,'/api/updates')).owner,'faravan');
  const result=await api(app,'/api/ops/update.check',{method:'POST',body:{}});
  assert.equal(result.candidate,'1.1.0');assert.equal(checks,1);
  assert.equal((await api(app,'/api/ops/update.status',{method:'POST',body:{}})).state,'available');
});
test('checkout updates state names its owner without an update check', {timeout:60000},async t=>{
  const f=await appFixture(t);const {app}=await f.start('checkout-updates',{updater:null});
  assert.equal((await api(app,'/api/updates')).owner,'development');
  assert.equal((await api(app,'/api/updates/check',{method:'POST',body:{}})).automatic,false);
});

test('phone read and revocation operations exist without an agent operation to confirm pairing',async()=>{
 const {opById}=await import('../lib/v1/ops/registry.mjs');
 assert.equal(opById('phone.status').rest.path,'/api/phone');
 assert.equal(opById('phone.pair_start').safety,'write');
 assert.equal(opById('phone.revoke').safety,'consequential');
 assert.equal(opById('phone.pair_confirm'),null);
});

test('home exposes cached update availability and clears it without checking from GET', {timeout:60000},async t=>{
  const f=await appFixture(t);let checks=0,available=true,failCheck=false;
  const updater={startDelayMs:3600000,intervalMs:3600000,
    check:async()=>{checks++;if(failCheck)throw Error('offline fixture');return {current:'1.0.0',manifest:available?{version:'1.1.0',notes:'not in home',release_notes_url:'https://unused.invalid/'}:null};},
    tick:async()=>{throw Error('must not install');}};
  const {app}=await f.start('tray-updates',{updater,faravanVersion:'1.0.0'});
  assert.equal((await api(app,'/api/home')).updateStatus,null);assert.equal(checks,0);
  await api(app,'/api/updates/check',{method:'POST',body:{}});
  for(let i=0;i<2;i++)assert.deepEqual((await api(app,'/api/home')).updateStatus,{state:'available',candidate:'1.1.0',currentVersion:'1.0.0'});
  assert.equal(checks,1,'home must not perform a check');
  available=false;
  await api(app,'/api/updates/check',{method:'POST',body:{}});
  assert.equal((await api(app,'/api/home')).updateStatus,null);assert.equal(checks,2);
  available=true;
  await api(app,'/api/updates/check',{method:'POST',body:{}});
  assert.equal((await api(app,'/api/home')).updateStatus.state,'available');
  failCheck=true;
  await api(app,'/api/updates/check',{method:'POST',body:{}});
  assert.equal((await api(app,'/api/home')).updateStatus,null);assert.equal(checks,4);
});

test('tray update producer permits only complete available or staged snapshots', async()=>{
  const {trayUpdateProjection}=await import('../lib/v1/app.mjs');
  for(const state of ['available','staged'])assert.deepEqual(trayUpdateProjection({state,candidate:'2.0.0',currentVersion:'1.0.0',notesUrl:'https://unused.invalid/'}),{state,candidate:'2.0.0',currentVersion:'1.0.0'});
  for(const state of ['unknown','current','checking','failed','applied','idle','managed',undefined])
    assert.equal(trayUpdateProjection({state,candidate:'2.0.0',currentVersion:'1.0.0'}),null);
  for(const value of [null,{},'',42,' ','1.0.0','2.0.0\n','x'.repeat(129)])
    assert.equal(trayUpdateProjection({state:'available',candidate:value,currentVersion:'1.0.0'}),null);
  assert.equal(trayUpdateProjection({state:'available',candidate:'2.0.0'}),null);
  assert.equal(trayUpdateProjection(null),null);
});
