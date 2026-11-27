import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
import {scheduleUpdates} from '../lib/v1/self-update.mjs';
const source=await readFile(process.env.LIFECYCLE_APP_SOURCE??new URL('../lib/v1/app.mjs',import.meta.url),'utf8');

test('the app rejects and cancels a ready packaged helper during pending Quit proof',async()=>{
  const begin=source.indexOf('onHandoff:async()=>'),end=source.indexOf(',\n      //',begin);
  assert.ok(begin>=0&&end>begin);
  const owner=new AppLifetime(),updaterHandle=owner.register('updater','producer',{blockedByHold:true});
  let cancelled=0,handoffs=0,closes=0;
  const callback=runInNewContext('('+source.slice(begin+'onHandoff:'.length,end)+')',{
    updaterHandle,updater:{kind:'packaged-mac'},managedUpdateContext:{markHandoff:()=>{handoffs++;return true;}},
    updateService:{status:()=>({candidate:'99.0.0'})},emit:()=>{},close:async()=>{closes++;}});
  const entered=Promise.withResolvers(),ready=Promise.withResolvers();
  const schedule=scheduleUpdates({updater:{tick:async()=> 'handoff',prepareHandoff:async()=>{entered.resolve();await ready.promise;return {ready:true,cancel:async()=>{cancelled++;}};}},
    isIdle:async()=>true,onHandoff:callback,setTimer:()=>({unref(){}}),clearTimer:()=>{}});
  const step=schedule.step();await entered.promise;
  const attempt=owner.register('Quit attempt','producer',{provisional:true});ready.resolve();await step;
  assert.deepEqual({cancelled,handoffs,closes},{cancelled:1,handoffs:0,closes:0});
  attempt.cancel();schedule.stop();
});
