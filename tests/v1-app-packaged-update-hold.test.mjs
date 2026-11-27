import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';

function preparation(t,{twice=false}={}) {
  let trigger,entered,finish,completed;
  const gate=new Promise(r=>trigger=r),held=new Promise(r=>entered=r),done=new Promise(r=>finish=r),cancelled=new Promise(r=>completed=r);
  t.after(()=>{trigger();finish();});
  const releases=[];
  return {trigger,held,finish,cancelled,releases,updater:{kind:'packaged-mac',startDelayMs:1,intervalMs:3600000,
    tick:async()=>{await gate;return 'handoff';},prepareHandoff:async({exclusive})=>{
      releases.push(await exclusive());if(twice)releases.push(await exclusive());
      assert.ok(releases.every(release=>typeof release==='function'));entered();await done;
      for(const release of releases)await release();completed();throw Error('test cancellation before helper readiness');
    }}};
}
async function configured(t,control) {
  const f=await appFixture(t,{hold:true}),connected=await f.connect({updater:control.updater});
  const {lender,circle}=connected;
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  return {f,...connected};
}

test('packaged update preparation fences On and Resume until its own cancellation',{timeout:30000},async t=>{
  const c=preparation(t,{twice:true}),{lender,circle}=await configured(t,c);
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await waitFor(()=>lender.app.lendingAdmission()===null,'initial admission');
  c.trigger();await c.held;assert.notEqual(lender.app.lendingAdmission(),null);
  for(const action of ['on','resume'])assert.equal((await api(lender.app,'/api/lending/'+action,{method:'POST',body:{circle:circle.id},status:409})).code,'update_in_progress');
  assert.equal((await api(lender.app,'/api/lending')).intent,'on');
  await c.releases[0]();await c.releases[0](); // One cancellation cannot release another owner, even twice.
  assert.notEqual(lender.app.lendingAdmission(),null);
  assert.equal((await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id},status:409})).code,'update_in_progress');
  c.finish();await c.cancelled;
  await waitFor(()=>lender.app.lendingAdmission()===null,'cancelled update restores saved On');
});

test('Off chosen while preparing stays Off after update cancellation',{timeout:30000},async t=>{
  const c=preparation(t),{lender,circle}=await configured(t,c);
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await waitFor(()=>lender.app.lendingAdmission()===null,'initial admission');
  c.trigger();await c.held;
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  c.finish();await c.cancelled;
  assert.equal((await api(lender.app,'/api/lending')).intent,'off');assert.notEqual(lender.app.lendingAdmission(),null);
});

test('On already awaiting circle selection cannot start a lender across preparation',{timeout:30000},async t=>{
  const c=preparation(t),{lender,circle}=await configured(t,c);
  let entered,finish;const selecting=new Promise(r=>entered=r),gate=new Promise(r=>finish=r);t.after(finish);
  const original=lender.app.device.selectCircle.bind(lender.app.device);let once=true;
  lender.app.device.selectCircle=async id=>{if(once&&id===circle.id){once=false;entered();await gate;}return original(id);};
  const turningOn=api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id},status:409});
  await selecting;c.trigger();await c.held;finish();
  assert.equal((await turningOn).code,'update_in_progress');assert.notEqual(lender.app.lendingAdmission(),null);
  c.finish();await c.cancelled;
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await waitFor(()=>lender.app.lendingAdmission()===null,'fresh On works after cancellation');
});


test('late durable resume completes a live pool while preparation still fences admission',{timeout:45000},async root=>{
  for(let offset=-1;offset<8;offset++)await root.test('microtask offset '+offset,{timeout:8000},async t=>{
    const c=preparation(t),{lender,circle}=await configured(t,c);
    const original=lender.app.device.client.bind(lender.app.device);let once=true;
    lender.app.device.client=async(...args)=>{
      const client=await original(...args);
      if(offset>=0&&once){once=false;let remaining=offset;const fire=()=>{if(remaining-->0)queueMicrotask(fire);else c.trigger();};fire();}
      return client;
    };
    const response=await fetch(lender.app.origin+'/api/lending/on',{method:'POST',headers:{'x-faravan-session-token':lender.app.token,'content-type':'application/json'},body:JSON.stringify({circle:circle.id})});
    const first=await response.json();assert.ok([200,409].includes(response.status));
    if(response.status===409)assert.equal(first.code,'update_in_progress');
    if(offset>=0){await c.held;assert.notEqual(lender.app.lendingAdmission(),null);c.finish();await c.cancelled;}
    await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
    await waitFor(()=>lender.app.lendingAdmission()===null,'fresh On must start a live pool, not only set enabled',2500);
    const view=await api(lender.app,'/api/lending');assert.ok(view.accountStates.length>0);assert.notEqual(view.counters,null);
  });
});
