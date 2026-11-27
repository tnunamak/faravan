import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {APP_DEFAULTS} from '../lib/v1/app.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {appFixture, api} from './helpers/v1-app-fixture.mjs';

const full = (idleOnly, stopOnReturn, extra = {}) => ({version:1, configVersion:5, intent:'off', activeCircle:null, agents:{}, modes:{saved:'ask'}, timeZoneChosen:true,
  limits:{...structuredClone(APP_DEFAULTS),idleOnly,timeZone:'UTC',lendingPolicy:{...normalizeLendingPolicy(),stopOnReturn}},...extra});
async function start(t, name, saved) {
  const f=await appFixture(t),home=await f.home(name),directory=join(home,'v1');
  await mkdir(directory,{recursive:true});
  const file=join(directory,'app-settings.json');
  if(saved)await writeFile(file,JSON.stringify(saved));
  const {app}=await f.start(name,{resumeLending:false});
  return {f,app,file,name,read:async()=>JSON.parse(await readFile(file,'utf8')),
    view:async()=>(await api(app,'/api/home')).lending};
}

test('brand-new profile uses normal defaults without transition notice state',async t=>{
  const x=await start(t,'pn-fresh',null),view=await x.view();
  assert.equal(view.presenceNotice,undefined);
  assert.equal(view.limits.idleOnly,false);
  assert.equal(view.limits.lendingPolicy.stopOnReturn,false);
  assert.deepEqual(view.standingRules,[]);
  const saved=await x.read();
  assert.equal(saved.presence,undefined);
  assert.equal(saved.presenceDefaultsVersion,2);
});

for(const marker of [undefined,1,2,3])for(const pair of [[true,true],[true,false],[false,true],[false,false]])
  test('stored presence choices survive restart without notice, marker '+marker+' pair '+pair,async t=>{
    const x=await start(t,'pn-kept-'+marker+'-'+pair.join('-'),full(...pair,{presenceDefaultsVersion:marker}));
    const view=await x.view(),saved=await x.read();
    assert.deepEqual([view.limits.idleOnly,view.limits.lendingPolicy.stopOnReturn],pair);
    assert.equal(view.presenceNotice,undefined);
    assert.equal(saved.presence,undefined);
    assert.equal(saved.intent,'off');
    assert.equal(saved.modes.saved,'ask');
    assert.deepEqual(saved.standingRules,[]);
    assert.equal(saved.presenceDefaultsVersion,marker===3?3:2);
    await x.app.close();
    const again=await x.f.start(x.name,{resumeLending:false});
    const next=(await api(again.app,'/api/home')).lending;
    assert.deepEqual([next.limits.idleOnly,next.limits.lendingPolicy.stopOnReturn],pair);
    assert.equal(next.presenceNotice,undefined);
  });

test('omitted defaults are explicit on disk for downgrade readers, without a notice',async t=>{
  const x=await start(t,'pn-omitted',{version:1,intent:'off',agents:{},modes:{},limits:{lendingPolicy:{stopOnReturn:true}}});
  const saved=await x.read();
  assert.equal(saved.limits.idleOnly,false);
  assert.equal(saved.limits.lendingPolicy.stopOnReturn,true);
  assert.equal(saved.presenceDefaultsVersion,2);
  assert.equal(saved.presence,undefined);
});

test('old notice payloads cannot change settings or create audit permission',async t=>{
  const prior={answer:null,notice:{kind:'pair'}};
  const x=await start(t,'pn-old-ui',full(true,true,{presenceDefaultsVersion:2,presence:prior}));
  const before=await x.read(),decisions=await api(x.app,'/api/decisions');
  for(const action of ['restore','dismiss','use_default','keep']){
    await api(x.app,'/api/lending/limits',{method:'POST',body:{presence:action,version:before.configVersion},status:400});
    const after=await x.read();
    for(const key of ['limits','modes','intent','standingRules','presence','configVersion'])assert.deepEqual(after[key],before[key],key);
  }
  assert.deepEqual(await api(x.app,'/api/decisions'),decisions);
  assert.equal((await x.view()).presenceNotice,undefined);
});

test('normal explicit settings remain versioned and survive restart without notice bookkeeping',async t=>{
  const x=await start(t,'pn-explicit',full(true,true,{presenceDefaultsVersion:2}));
  const before=await x.view();
  await api(x.app,'/api/lending/limits',{method:'POST',body:{idleOnly:false,version:before.configVersion+1},status:409});
  assert.equal((await x.view()).limits.idleOnly,true);
  const after=await api(x.app,'/api/lending/limits',{method:'POST',body:{idleOnly:false,lendingPolicy:{stopOnReturn:false},version:before.configVersion}});
  assert.equal(after.configVersion,before.configVersion+1);
  assert.deepEqual([after.limits.idleOnly,after.limits.lendingPolicy.stopOnReturn],[false,false]);
  assert.equal((await x.read()).presence,undefined);
  assert.equal((await x.read()).modes.saved,'ask');
  await x.app.close();
  const again=await x.f.start(x.name,{resumeLending:false}),view=(await api(again.app,'/api/home')).lending;
  assert.deepEqual([view.limits.idleOnly,view.limits.lendingPolicy.stopOnReturn],[false,false]);
  assert.equal(view.presenceNotice,undefined);
});
