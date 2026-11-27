import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {createFakeRegistry} from '../lib/v1/providers/fixtures.mjs';

// The local account surface over the real app server: authenticated, backed by the real broker and store, with synthetic provider
// effects. No native CLI store is read, and no response carries a host-private field.
const opts={timeout:60000};
const SECRETS=/SYNTHETIC-HOST-ONLY|secretRef|"secret"/;
async function start(t,extra={}) {
  const f=await appFixture(t);
  const {app}=await f.start('owner',{backend:syntheticBackend(f.root),...extra});
  return app;
}
const enroll=(app,label,operationId)=>api(app,'/api/accounts',{method:'POST',body:{providerId:'claude',label,operationId}});

test('the accounts surface needs the local session',opts,async t=>{
  const app=await start(t,{accountProviders:createFakeRegistry()});
  await api(app,'/api/accounts',{token:null,status:401});
  await api(app,'/api/accounts',{token:'wrong-token',status:401});
  await api(app,'/api/accounts',{method:'POST',body:{providerId:'claude',label:'x',operationId:'op1'},token:null,status:401});
});

test('enroll, complete, settings, replay and remove run through the real broker and store',opts,async t=>{
  const app=await start(t,{accountProviders:createFakeRegistry()});
  const empty=await api(app,'/api/accounts');
  assert.deepEqual(empty.accounts,[]);
  assert.deepEqual(empty.providers.map(provider=>provider.id).sort(),['claude','codex','generic-api-key','pi']);
  assert.equal(empty.capabilities.mutations.includes('enroll'),true);

  const started=await enroll(app,'Work','op-enroll-1');
  assert.equal(started.ok,true);
  const flowId=started.value.flowId;
  // The same operation replays; a different request under the same operation id is a conflict.
  const again=await enroll(app,'Work','op-enroll-1');
  assert.equal(again.value.flowId,flowId);
  await api(app,'/api/accounts',{method:'POST',body:{providerId:'claude',label:'Other',operationId:'op-enroll-1'},status:409});
  assert.equal((await api(app,'/api/accounts/flows/'+flowId)).value.flowId,flowId);

  const done=await api(app,'/api/accounts/flows/'+flowId+'/complete',{method:'POST',body:{answer:'person@example.invalid'}});
  assert.equal(done.ok,true);
  const listed=await api(app,'/api/accounts');
  assert.equal(listed.accounts.length,1);
  assert.doesNotMatch(JSON.stringify(listed),SECRETS,'no host-private field reaches the surface');
  const accountId=listed.accounts[0].id;
  await api(app,'/api/accounts/flows/'+flowId,{status:410});

  // Settings are a compare-and-swap on the revision.
  const revision=listed.revision;
  const changed=await api(app,'/api/accounts/'+accountId+'/settings',{method:'POST',body:{expectedRevision:revision,enabled:false}});
  assert.equal(changed.ok,true);
  await api(app,'/api/accounts/'+accountId+'/settings',{method:'POST',body:{expectedRevision:revision,enabled:true},status:409});
  await api(app,'/api/accounts/'+accountId+'/settings',{method:'POST',body:{expectedRevision:revision+1,modelOrder:['no-such-model']},status:400});
  await api(app,'/api/accounts/'+accountId+'/settings',{method:'POST',body:{expectedRevision:revision+1,color:'red'},status:400});
  assert.equal((await api(app,'/api/accounts')).accounts[0].enabled,false);

  const removed=await api(app,'/api/accounts/'+accountId+'/remove',{method:'POST',body:{operationId:'op-remove-1'}});
  assert.equal(removed.ok,true);
  const replay=await api(app,'/api/accounts/'+accountId+'/remove',{method:'POST',body:{operationId:'op-remove-1'}});
  assert.equal(replay.ok,true);
  assert.deepEqual((await api(app,'/api/accounts')).accounts,[]);
  await api(app,'/api/accounts/'+accountId+'/settings',{method:'POST',body:{expectedRevision:revision+1,enabled:true},status:404});
});

test('a cancelled sign-in leaves no account and a bad request is refused before any effect',opts,async t=>{
  const app=await start(t,{accountProviders:createFakeRegistry()});
  const started=await enroll(app,'Spare','op-cancel-1');
  await api(app,'/api/accounts/flows/'+started.value.flowId+'/cancel',{method:'POST',body:{}});
  assert.deepEqual((await api(app,'/api/accounts')).accounts,[]);
  await api(app,'/api/accounts',{method:'POST',body:{providerId:'nope',label:'x',operationId:'op-x'},status:404});
  await api(app,'/api/accounts',{method:'POST',body:{providerId:'claude',operationId:'op-y'},status:400});
});

test('default app constructs independent subscription providers without native credential discovery',opts,async t=>{
  const app=await start(t);
  const listed=await api(app,'/api/accounts');
  assert.deepEqual(listed.providers.map(p=>p.id).sort(),['claude','codex']);assert.deepEqual(listed.accounts,[]);
  assert.ok(listed.providers.every(p=>p.signInKind==='browser_oauth'&&p.models.length>0));
  assert.ok(listed.capabilities.mutations.length>0);assert.ok(listed.capabilities.settings.length>0);
  const result=await api(app,'/api/accounts',{method:'POST',body:{providerId:'not-configured',label:'Native',operationId:'op-native'},status:404});
  assert.equal(result.error.code,'provider_not_found');
});
