import test from 'node:test';
import assert from 'node:assert/strict';
import {browserDevice,browserOnboarding} from './posthog-facts.mjs';
test('device attribution needs authenticated full-app scope, never viewport or labels',async()=>{
  for(const [scopes,expected] of [[['app:full'],'paired'],[['inbox:read'],'local'],[[],'local']]){
    assert.equal(await browserDevice(async()=>({ok:true,json:async()=>({phone:{scopes,label:'PRIVATE'}})})),expected);
  }
  assert.equal(await browserDevice(async()=>{throw new Error('offline');}),'local');
});
test('onboarding derives only fixed step IDs from the real view model',()=>{
  assert.equal(browserOnboarding('home',{}),null);
  const step=browserOnboarding('home',{home:{},circles:[],jobs:[],agents:[]});
  assert.deepEqual(step,{flow:'borrowing',step:'joined'});
  assert.equal(browserOnboarding('settings',{home:{}}),null);
});
