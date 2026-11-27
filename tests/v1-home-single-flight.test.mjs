import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';

test('home and tray status share one pending observation and the next read is fresh',{timeout:60000},async t=>{
  const f=await appFixture(t);
  let gate=null,calls=0,release;
  const {app}=await f.start('single-flight',{autostart:{status:async()=>{calls++;await gate;return {supported:false};}}});
  gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  let arrived=0;
  const requestSeen=req=>{if(['/api/home','/api/status'].includes(req.url))arrived++;};
  app.server.on('request',requestSeen);t.after(()=>app.server.off('request',requestSeen));
  const before=calls;
  const reads=Array.from({length:7},(_,i)=>api(app,i===6?'/api/status':'/api/home'));
  await waitFor(()=>arrived===7&&calls>before);
  assert.equal(calls-before,1);
  release();const views=await Promise.all(reads);gate=null;
  assert.equal(new Set(views.map(view=>view.observedAt)).size,1);
  const next=await api(app,'/api/home');
  assert.ok(next.observedAt>views[0].observedAt,'there is no reuse window after completion');
  assert.equal(calls-before,2);
});

test('a rejected home observation releases the single-flight promise',{timeout:60000},async t=>{
  let completedReads=0;
  const f=await appFixture(t);
  const {app}=await f.start('single-flight-error',{autostart:{status:async()=>{completedReads++;return {supported:false};}}});
  const original=app.device.listCircles.bind(app.device);
  const failure = Promise.withResolvers();
  let broken=true, calls=0, arrived=0;
  const requestSeen=req=>{if(['/api/home','/api/status'].includes(req.url))arrived++;};
  app.server.on('request',requestSeen);
  t.after(()=>app.server.off('request',requestSeen));
  app.device.listCircles=async()=>{
    calls++;
    if(broken){await failure.promise;throw new Error('fixture read failure');}
    return original();
  };
  const failedReads=Promise.all(Array.from({length:7},(_,i)=>api(app,i===6?'/api/status':'/api/home',{status:409})));
  try { await Promise.race([waitFor(()=>arrived===7&&calls>0),failedReads]); }
  finally { failure.resolve(); }
  await failedReads;
  assert.equal(calls,1,'all failed requests shared the rejected observation');
  broken=false;
  const beforeRecovery=completedReads;
  assert.ok((await api(app,'/api/home')).observedAt>0);
  assert.equal(completedReads-beforeRecovery,1,'recovery reads a fresh observation');
});
