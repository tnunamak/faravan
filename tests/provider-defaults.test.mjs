import './helpers/no-browser.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {anthropicProvider} from '@earendil-works/pi-ai/providers/anthropic';
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex';
import {currentModelIds} from '../lib/v1/provider-defaults.mjs';
import {createHostProviderRegistry} from '../lib/v1/providers/host-registry.mjs';
import {createAccountStore} from '../lib/v1/accounts.mjs';
import {createAccountBroker} from '../lib/v1/account-broker.mjs';
import {effectiveAccountModels} from '../lib/v1/account-catalog.mjs';
import {resolveSelection} from '../lib/v1/run-request.mjs';

const real={claude:anthropicProvider(),codex:openaiCodexProvider()};
const ids=id=>real[id].getModels().map(m=>m.id);

test('the table picks each family\'s current model from the real provider lists',()=>{
  const claude=currentModelIds('claude',real.claude.getModels());
  const codex=currentModelIds('codex',real.codex.getModels());
  assert.equal(claude.length,4);assert.equal(codex.length,4);
  for(const id of claude)assert.ok(ids('claude').includes(id));
  for(const id of codex)assert.ok(ids('codex').includes(id));
  // Family order follows the table; each pick is the highest version and never a dated alias.
  assert.deepEqual(claude.map(id=>id.split('-')[1]),['sonnet','opus','haiku','fable']);
  assert.deepEqual(codex.map(id=>id.split('-').at(-1)),['sol','terra','astra','luna']);
  assert.ok(claude.every(id=>!/-\d{8}$/.test(id)));
  // Pinned to the installed list; change these when the pinned SDK ships newer models.
  assert.deepEqual(claude,['claude-sonnet-5-5','claude-opus-5-5','claude-haiku-5-5','claude-fable-5-2']);
  assert.deepEqual(codex,['gpt-6.1-sol','gpt-6.1-terra','gpt-6-astra','gpt-6-luna']);
});
test('a dated alias never wins, and an unknown family or provider is skipped',()=>{
  const pick=(provider,...names)=>currentModelIds(provider,names.map(id=>({id})));
  assert.deepEqual(pick('claude','claude-haiku-4-5-20251001','claude-haiku-4-5'),['claude-haiku-4-5']);
  assert.deepEqual(pick('claude','claude-haiku-4-5-20251001'),['claude-haiku-4-5-20251001']);
  assert.deepEqual(pick('claude','claude-sonnet-5','claude-sonnet-4-6','claude-mystery-9'),['claude-sonnet-5']);
  assert.deepEqual(pick('codex','gpt-6-sol','gpt-6.1-sol','gpt-5.6-sol','gpt-7-nova'),['gpt-6.1-sol']);
  assert.deepEqual(pick('other','x'),[]);
});

function drivers(){
  return Object.fromEntries(Object.entries(real).map(([id,driver])=>[id,{getModels:()=>driver.getModels(),auth:{oauth:{
    async login(interaction){interaction.notify({type:'auth_url',url:'https://controlled.invalid/'+id});
      const answer=await interaction.prompt({type:'manual_code',message:'Owned login'});
      return {type:'oauth',access:'A_'+answer,refresh:'R_'+answer,expires:2000000,accountId:'subject-'+answer};},
    async refresh(c){return c;}}}}]));
}
async function setup(t){
  const directory=await mkdtemp(join(tmpdir(),'faravan-defaults-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const send=async url=>url.endsWith('/profile')?Response.json({account:{uuid:'subject-one'}}):assert.fail('unexpected '+url);
  const providers=createHostProviderRegistry({proxyOrigin:()=>'https://broker.invalid',nativeDrivers:drivers(),fetch:send,clock:()=>1000000});
  const store=createAccountStore({directory}),broker=createAccountBroker({store,providers,clock:()=>1000000});t.after(()=>broker.close());
  return {providers,store,broker};
}
const enroll=async(broker,providerId,answer)=>{
  const flow=await broker.enroll({providerId,label:answer});return broker.complete({flowId:flow.value.flowId,answer});};

for(const providerId of ['claude','codex'])test(`a new ${providerId} account lends exactly the current models, and "any" picks the first at medium`,async t=>{
  const {providers,store,broker}=await setup(t);
  const account=(await enroll(broker,providerId,'one')).value;
  const descriptor=providers.getProvider(providerId).value.descriptor;
  const lent=effectiveAccountModels(store.get(account.id),descriptor);
  assert.deepEqual(lent.map(m=>m.id),currentModelIds(providerId,descriptor.models));
  for(const model of lent){
    const listed=descriptor.models.find(m=>m.id===model.id);
    assert.deepEqual(model.efforts.map(e=>e.id),listed.efforts.map(e=>e.id),'all efforts');
  }
  assert.ok(descriptor.models.length>lent.length,'older generations are listed but off');
  const picked=resolveSelection({runRequest:{schemaVersion:1,models:'any',effortId:null},accounts:[{accountId:account.id,providerId,models:lent}]});
  assert.equal(picked.ok,true);
  assert.equal(picked.value.modelId,providerId==='claude'?'claude-sonnet-5-5':'gpt-6.1-sol');
  assert.equal(picked.value.effortId,'medium');
});
test('an account with saved preferences is not changed',async t=>{
  const {providers,store,broker}=await setup(t);
  const account=(await enroll(broker,'claude','one')).value;
  const saved={'claude-opus-4-8':{enabled:true,effortIds:['low']}};
  await store.transaction(state=>{const r=state.records[account.id];r.modelPreferences=saved;r.modelOrder=['claude-opus-4-8'];});
  assert.deepEqual(store.get(account.id).modelPreferences,saved);
  const lent=effectiveAccountModels(store.get(account.id),providers.getProvider('claude').value.descriptor);
  assert.deepEqual(lent.map(m=>m.id),['claude-opus-4-8']);
});

test('an account with no saved preferences gets the defaults once; one with an empty saved object is left alone',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'faravan-defaults-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const send=async url=>url.endsWith('/profile')?Response.json({account:{uuid:'subject-one'}}):assert.fail('unexpected '+url);
  const providers=createHostProviderRegistry({proxyOrigin:()=>'https://broker.invalid',nativeDrivers:drivers(),fetch:send,clock:()=>1000000});
  const store=createAccountStore({directory});
  let first=createAccountBroker({store,providers,clock:()=>1000000});
  const bare=(await enroll(first,'claude','one')).value,empty=(await enroll(first,'codex','two')).value;
  await store.transaction(state=>{delete state.records[bare.id].modelPreferences;delete state.records[bare.id].modelOrder;
    state.records[bare.id].modelOrder=[];state.records[empty.id].modelPreferences={};state.records[empty.id].modelOrder=[];});
  await first.close();
  const second=createAccountBroker({store,providers,clock:()=>1000000});t.after(()=>second.close());
  await second.close();// close waits for the load-time write
  const claude=providers.getProvider('claude').value.descriptor;
  assert.deepEqual(effectiveAccountModels(store.get(bare.id),claude).map(m=>m.id),currentModelIds('claude',claude.models));
  assert.deepEqual(store.get(empty.id).modelPreferences,{});
  assert.deepEqual(store.get(empty.id).modelOrder,[]);
  // A second load changes nothing.
  const before=JSON.stringify(store.read().records);
  const third=createAccountBroker({store,providers,clock:()=>1000000});await third.close();
  assert.equal(JSON.stringify(store.read().records),before);
});
