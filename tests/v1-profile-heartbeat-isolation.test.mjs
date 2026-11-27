import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';

test('a stalled inactive circle cannot stop the selected circle heartbeat or overlap refreshes',async t=>{
 const f=await appFixture(t),{owner,lender,circle}=await f.connect({heartbeatMs:20,pollMs:60000,memberCapabilityTimeoutMs:5000});
 const second=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Inactive circle'}});
 const {invite}=await api(owner.app,'/api/circles/'+second.id+'/invite',{method:'POST',body:{}});
 await api(lender.app,'/api/circles/join',{method:'POST',body:{link:invite}});
 await api(owner.app,'/api/circles/'+second.id+'/approve',{method:'POST',body:{}});
 await api(lender.app,'/api/circles/'+second.id+'/check',{method:'POST',body:{}});
 await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:circle.id}});
 const original=lender.app.device.client.bind(lender.app.device);
 let release,entered=0;const blocked=new Promise(resolve=>{release=resolve;});
 lender.app.device.client=async(id,options)=>{if(id===second.id){entered++;await blocked;}return original(id,options);};
 try{
  await waitFor(()=>entered>0,'inactive refresh started');
  const beats=()=>f.heartbeats?.filter(body=>Number.isSafeInteger(body.seq)).length??0,before=beats();
  await waitFor(()=>beats()>=before+3,'active heartbeats continue',2000);
  assert.equal(entered,1,'a stalled inactive refresh must not overlap itself');
 }finally{release();lender.app.device.client=original;}
});

test('inactive refresh deadlines free the next attempt without delaying active heartbeats',async t=>{
 const f=await appFixture(t),{owner,lender,circle}=await f.connect({heartbeatMs:20,pollMs:60000,memberCapabilityTimeoutMs:200});
 const second=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Timeout circle'}});
 const {invite}=await api(owner.app,'/api/circles/'+second.id+'/invite',{method:'POST',body:{}});
 await api(lender.app,'/api/circles/join',{method:'POST',body:{link:invite}});
 await api(owner.app,'/api/circles/'+second.id+'/approve',{method:'POST',body:{}});
 await api(lender.app,'/api/circles/'+second.id+'/check',{method:'POST',body:{}});
 await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:circle.id}});
 const original=lender.app.device.client.bind(lender.app.device);
 let attempts=0,active=0,peak=0,expired=0;
 lender.app.device.client=async(id,options)=>{
  if(id!==second.id)return original(id,options);
  attempts++;peak=Math.max(peak,++active);
  return new Promise((resolve,reject)=>{
   const abort=()=>{active--;expired++;reject(options.signal.reason);};
   if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});
  });
 };
 try{
  const beats=()=>f.heartbeats?.filter(body=>Number.isSafeInteger(body.seq)).length??0,before=beats();
  await waitFor(()=>attempts>=2&&expired>=1&&beats()>=before+3,'refresh timeout and healthy heartbeats',3000);
  assert.equal(peak,1);
 }finally{lender.app.device.client=original;}
});

test('closing while circle discovery is pending prevents later refresh dispatch',async t=>{
 const f=await appFixture(t),{app}=await f.start('closing',{heartbeatMs:20,pollMs:60000});
 const originalList=app.device.listCircles.bind(app.device),originalClient=app.device.client.bind(app.device);
 let release,entered=0,dispatches=0;
 const blocked=new Promise(resolve=>{release=resolve;});
 app.device.listCircles=async()=>{if(++entered===1)return [];await blocked;return [{id:'11111111-1111-4111-8111-111111111111',origin:f.origin}];};
 app.device.client=async()=>{dispatches++;return {heartbeat:async()=>{}};};
 try{
  await waitFor(()=>entered>1,'circle discovery started after the heartbeat snapshot');
  const closing=app.close();
  release();await closing;
  await new Promise(setImmediate);
  assert.equal(dispatches,0,'no member refresh may start after close');
 }finally{release();app.device.listCircles=originalList;app.device.client=originalClient;}
});

test('active heartbeat has its own deadline instead of the short inactive refresh budget',async t=>{
 const f=await appFixture(t),{lender,circle}=await f.connect({heartbeatMs:20,pollMs:60000,memberCapabilityTimeoutMs:50,heartbeatTimeoutMs:1000});
 await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:circle.id}});
 const original=lender.app.device.client.bind(lender.app.device);
 lender.app.device.client=async(id,options)=>{
  if(id===circle.id)await new Promise((resolve,reject)=>{
   const timer=setTimeout(done,150);
   function done(){options.signal.removeEventListener('abort',abort);resolve();}
   function abort(){clearTimeout(timer);reject(options.signal.reason);}
   if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});
  });
  return original(id,options);
 };
 try{
  const beats=()=>f.heartbeats?.filter(body=>Number.isSafeInteger(body.seq)).length??0,before=beats();
  await waitFor(()=>beats()>before,'active heartbeat outlives inactive budget',2500);
 }finally{lender.app.device.client=original;}
});
