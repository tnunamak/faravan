import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';

test('Mac install API returns progress, then selects the absolute runtime and refreshes checks',async t=>{
  const previous=process.env.FARAVAN_SBX_BIN;
  t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_SBX_BIN;else process.env.FARAVAN_SBX_BIN=previous;});
  let state={phase:'idle'},finish,cancelled=false;
  const installer={status:()=>state,cancel:()=>{cancelled=true;},install:()=>{
    state={phase:'downloading',received:12,total:24};
    return new Promise(resolve=>{finish=()=>{state={phase:'installed',executable:'/synthetic/data/Sbx.app/Contents/MacOS/sbx'};resolve(state);};});
  }};
  const f=await appFixture(t);
  const {app}=await f.start('install',{platform:'darwin',arch:'arm64',sandboxInstaller:installer});
  assert.equal((await api(app,'/api/status')).desktop.arch,'arm64');
  assert.deepEqual(await api(app,'/api/setup/install-sandbox'),{phase:'idle'});
  assert.equal((await api(app,'/api/setup/install-sandbox',{method:'POST',body:{}})).phase,'downloading');
  assert.equal((await api(app,'/api/setup/install-sandbox')).received,12);
  finish();
  await waitFor(()=>process.env.FARAVAN_SBX_BIN===state.executable,'selected managed runtime');
  await app.close();
  assert.equal(cancelled,true);
});
test('Linux install API keeps the package path and never starts a Mac download',async t=>{
  let installs=0;
  const f=await appFixture(t);
  const {app}=await f.start('linux',{platform:'linux',sandboxInstaller:{status:()=>({phase:'idle'}),cancel(){},install(){installs++;}}});
  await api(app,'/api/setup/install-sandbox',{method:'POST',body:{},status:409});
  assert.equal(installs,0);
});

test('install uses the same local authentication and origin checks as sibling setup routes',async t=>{
 const previous=process.env.FARAVAN_SBX_BIN;
 t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_SBX_BIN;else process.env.FARAVAN_SBX_BIN=previous;});
 const f=await appFixture(t);let installs=0;
 const {app}=await f.start('callers',{platform:'darwin',sandboxInstaller:{status:()=>({phase:'idle'}),cancel(){},install(){installs++;return Promise.resolve({phase:'installed',executable:'/synthetic/sbx'});}}});
 for(const route of ['install-sandbox','cancel-sandbox','restart-sandbox','repair-policy']) {
  await api(app,'/api/setup/'+route,{method:'POST',body:{confirmed:true},token:null,status:401});
  await api(app,'/api/setup/'+route,{method:'POST',body:{confirmed:true},headers:{origin:'https://another-page.test'},status:403});
 }
 assert.equal(installs,0);
 await api(app,'/api/setup/install-sandbox',{method:'POST',body:{}});
 assert.equal(installs,1);
});

test('Mac Cancel API waits for installer cleanup and returns the stopped state',async t=>{
 const f=await appFixture(t);let cancelled=false;
 const {app}=await f.start('cancel',{platform:'darwin',arch:'arm64',sandboxInstaller:{
  status:()=>({phase:cancelled?'idle':'downloading'}),cancel:async()=>{cancelled=true;}
 }});
 assert.equal((await api(app,'/api/setup/cancel-sandbox',{method:'POST',body:{}})).phase,'idle');
 assert.equal(cancelled,true);
});
test('Mac app under Rosetta reports the hardware architecture',async t=>{
 const f=await appFixture(t);const calls=[];
 const {app}=await f.start('rosetta',{platform:'darwin',run:async(command,args)=>{
  calls.push([command,args]);if(command==='/usr/sbin/sysctl')return '1';return '';
 },sandboxInstaller:{status:()=>({phase:'idle'}),cancel(){},findInstalled:async()=>null}});
 assert.equal((await api(app,'/api/status')).desktop.arch,'arm64');
 assert.ok(calls.some(([command,args])=>command==='/usr/sbin/sysctl'&&JSON.stringify(args)==='["-n","hw.optional.arm64"]'));
});

test('sandbox installation operations reach the existing authenticated routes',async t=>{
 const f=await appFixture(t);let cancelled=false;
 const {app}=await f.start('install-ops',{platform:'linux',sandboxInstaller:{
  status:()=>({phase:cancelled?'idle':'downloading'}),cancel:async()=>{cancelled=true;},
  install(){throw Error('Linux must not download a Mac sandbox');}
 }});
 const request={method:'POST',body:{}};
 assert.equal((await api(app,'/api/ops/setup.sandbox_status',request)).phase,'downloading');
 assert.equal((await api(app,'/api/ops/setup.install_sandbox',{...request,status:409})).code,'platform_unsupported');
 assert.equal((await api(app,'/api/ops/setup.cancel_sandbox',request)).phase,'idle');
 for(const operation of ['sandbox_status','install_sandbox','cancel_sandbox']) {
  await api(app,'/api/ops/setup.'+operation,{...request,token:null,status:401});
  await api(app,'/api/ops/setup.'+operation,{...request,headers:{origin:'https://another-page.test'},status:403});
 }
});
