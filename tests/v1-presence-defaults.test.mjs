import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {APP_DEFAULTS} from '../lib/v1/app.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {appFixture, api, syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {lenderFixture, until} from './helpers/v1-lender-fixture.mjs';

test('fresh lending defaults allow concurrent owner use', () => {
  assert.equal(APP_DEFAULTS.idleOnly, false);
  assert.equal(normalizeLendingPolicy().stopOnReturn, false);
});

test('saved presence choices are kept, durable before use, and owners can still change them', {timeout:60000}, async t => {
  const f = await appFixture(t), home = await f.home('presence-upgrade'), directory = join(home, 'v1');
  await mkdir(directory, {recursive:true});
  const file = join(directory, 'app-settings.json');
  await writeFile(file, JSON.stringify({version:1, configVersion:0, intent:'off', activeCircle:null,agents:{},modes:{}, limits:{...APP_DEFAULTS,
    idleOnly:true, lendingPolicy:{...normalizeLendingPolicy(), strategyParams:{}, stopOnReturn:true}}}));
  let durableAtUse;
  let {app} = await f.start('presence-upgrade', {backendFactory:async () => {
    durableAtUse = JSON.parse(await readFile(file, 'utf8'));
    return syntheticBackend(f.root);
  }});
  // Kept: a saved "on" cannot be told apart from a chosen "on", so an upgrade never lowers it.
  assert.equal(durableAtUse.limits.idleOnly, true);
  assert.equal(durableAtUse.limits.lendingPolicy.stopOnReturn, true);
  let view = await api(app, '/api/home');
  assert.equal(view.lendingPolicy.migration.acknowledged, false);
  assert.deepEqual(view.lendingPolicy.migration.reset.map(row => row.field), ['strategyParams.perJobPct']);
  await api(app, '/api/lending/limits', {method:'POST', body:{idleOnly:false, lendingPolicy:{stopOnReturn:false}}});
  await app.close();
  ({app} = await f.start('presence-upgrade'));
  view = await api(app, '/api/home');
  assert.equal(view.lending.limits.idleOnly, false);
  assert.equal(view.lending.limits.lendingPolicy.stopOnReturn, false);
  assert.equal(view.lendingPolicy.migration, null);
});

test('Any time never samples presence even with an older saved stop-on-return value', {timeout:60000}, async t => {
  let reads = 0;
  const f = await lenderFixture(t, {policy:{mode:'auto', idleOnly:false,
    quota:() => ({provider:'codex',remaining:100,observedAt:f.clock.now()}),
    lendingPolicy:normalizeLendingPolicy({stopOnReturn:true}), userActive:() => {reads++; return true;}}});
  const controller = new AbortController();
  const lender = createLender({client:f.client, backend:f.backend, adapters:f.adapters, policy:f.policy,
    clock:f.clock, onEvent:event => f.events.push(event)});
  const running = lender.start(controller.signal);
  f.stop = async () => {controller.abort(); await running;};
  await until(() => f.calls.some(([kind]) => kind === 'run'), 'automatic job starts');
  f.execution.resolve();
  await until(() => f.events.some(event => event.label?.startsWith('Finished.')), 'job completes');
  await f.stop();
  assert.equal(reads, 0);
});

test('quota refresh and status never sample presence when both controls are off', async t => {
  const f = await appFixture(t), directory = await f.home('runtime-presence');
  let reads = 0;
  const runtime = createLendingRuntime({directory, settings:() => ({limits:APP_DEFAULTS}),
    presence:() => {reads++; return true;}, readOverride:async () => ({windows:[]})});
  t.after(() => runtime.close());
  await runtime.readings('claude');
  await runtime.refreshCapacity('claude');
  await runtime.samplePresence();
  await runtime.view();
  assert.equal(reads, 0);
});

test('stop-on-return remains an opt-in with the existing two-minute delay', {timeout:60000}, async t => {
  let active=false;
  const f = await lenderFixture(t, {hold:true, mutateJob:payload => {payload.requirements.limits.wall_seconds=300;}, policy:{mode:'auto',idleOnly:true,
    lendingPolicy:normalizeLendingPolicy({stopOnReturn:true}),userActive:() => active,
    quota:() => ({provider:'codex',remaining:100,observedAt:f.clock.now()})}});
  const stops=[];
  f.backend.requestStop=async (handle,reason) => {stops.push(reason);return {delivered:true};};
  const controller=new AbortController();
  const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock});
  const running=lender.start(controller.signal);
  f.stop=async () => {controller.abort();await running;};
  await f.entered.promise;
  active=true;
  const tick=async () => {f.clock.advance(5000);for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));};
  for(let i=0;i<24;i++)await tick();
  assert.deepEqual(stops,[],'activity must last two minutes after the first sample');
  await tick();
  assert.deepEqual(stops,['owner']);
  f.execution.resolve();
  await f.stop();
});

for (const [name,patch,expected] of [
  ['owner settings write',{configVersion:12},true],
  ['owner per-job cap equal to the new default',{configVersion:0,limits:{lendingPolicy:{stopOnReturn:true,strategyParams:{perJobPct:10}}}},true],
  ['non-default value in the saved write',{limits:{dailyJobs:9}},true],
  ['custom legacy policy',{limits:{lendingPolicy:{preset:'fixed_share',stopOnReturn:true}}},true],
  ['deliberate opt-out',{configVersion:7,limits:{idleOnly:false,lendingPolicy:{stopOnReturn:false}}},false],
  ['unversioned opt-out',{limits:{idleOnly:false,lendingPolicy:{stopOnReturn:false}}},false],
  ['stored default',{configVersion:0},true],
  ['unversioned old defaults',{},true],
]) test(`presence migration keeps ${name}`, {timeout:60000}, async t => {
  const f=await appFixture(t),home=await f.home('presence-choice'),directory=join(home,'v1');
  await mkdir(directory,{recursive:true});
  const file=join(directory,'app-settings.json');
  await writeFile(file,JSON.stringify({version:1,intent:'on',activeCircle:null,agents:{},modes:{},...patch,
    limits:{...APP_DEFAULTS,idleOnly:true,lendingPolicy:{...normalizeLendingPolicy(),strategyParams:{},stopOnReturn:true},...patch.limits}}));
  const {app}=await f.start('presence-choice');
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.limits.idleOnly,expected);
  assert.equal(saved.limits.lendingPolicy.stopOnReturn,expected);
  assert.equal(saved.intent,'on');
  assert.equal(saved.presenceDefaultsVersion,2);
  const notice=(await api(app,'/api/home')).lendingPolicy.migration;
  assert.notEqual(notice?.presenceDefaultsChanged,true,'nothing changed, so no notice says it did');
  assert.notEqual(notice?.presenceDefaultsUncertain,true);
});

test('unrelated owner edits keep both presence choices and add only the cap notice', {timeout:60000}, async t => {
  const f=await appFixture(t),home=await f.home('presence-edited'),directory=join(home,'v1');
  await mkdir(directory,{recursive:true});
  const file=join(directory,'app-settings.json');
  await writeFile(file,JSON.stringify({version:1,configVersion:13,intent:'on',activeCircle:'chosen-circle',
    agents:{},modes:{'chosen-circle':'ask'},timeZoneChosen:true,limits:{...APP_DEFAULTS,idleOnly:true,
      dailyJobs:9,dailyMinutes:90,maxWallSeconds:1800,quotaReserve:37,
      timeZone:'UTC',
      lendingPolicy:{...normalizeLendingPolicy(),strategyParams:{},stopOnReturn:true,warningPct:15}}}));
  let atUse;
  let {app}=await f.start('presence-edited',{resumeLending:false,backendFactory:async()=>{
    atUse=JSON.parse(await readFile(file,'utf8'));return syntheticBackend(f.root);
  }});
  assert.equal(atUse.limits.idleOnly,true);
  assert.equal(atUse.limits.lendingPolicy.stopOnReturn,true);
  assert.equal(atUse.presenceDefaultsVersion,2);
  const view=await api(app,'/api/home'),notice=view.lendingPolicy.migration;
  assert.notEqual(notice.presenceDefaultsChanged,true);
  assert.equal(notice.perJobCapChanged,true);
  assert.equal(notice.acknowledged,false);
  assert.deepEqual(notice.reset,[{field:'strategyParams.perJobPct'}]);
  assert.equal(atUse.configVersion,13);
  assert.equal(atUse.activeCircle,'chosen-circle');
  assert.equal(atUse.modes['chosen-circle'],'ask');
  assert.equal(atUse.timeZoneChosen,true);
  assert.equal(atUse.limits.dailyJobs,9);
  assert.equal(atUse.limits.dailyMinutes,90);
  assert.equal(atUse.limits.maxWallSeconds,1800);
  assert.equal(atUse.limits.quotaReserve,37);
  assert.equal(atUse.limits.lendingPolicy.warningPct,15);
  await app.close();
  const once=JSON.parse(await readFile(file,'utf8'));
  ({app}=await f.start('presence-edited',{resumeLending:false}));
  const twice=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(twice.limits,once.limits);
  assert.deepEqual(twice.lendingPolicyMigration,once.lendingPolicyMigration,'restart adds no reset rows or notice');
  assert.equal(twice.presenceDefaultsVersion,2);
});

for(const [idleOnly,stopOnReturn] of [[false,true],[true,false]])
test(`an explicit off beside an old default stays unchanged and raises no notice: idleOnly=${idleOnly}, stopOnReturn=${stopOnReturn}`,{timeout:60000},async t=>{
  const f=await appFixture(t),home=await f.home('presence-mixed'),directory=join(home,'v1');
  await mkdir(directory,{recursive:true});
  const file=join(directory,'app-settings.json');
  await writeFile(file,JSON.stringify({version:1,configVersion:13,intent:'off',activeCircle:null,agents:{},modes:{},
    limits:{...APP_DEFAULTS,idleOnly,lendingPolicy:{...normalizeLendingPolicy(),stopOnReturn}}}));
  let {app}=await f.start('presence-mixed');
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.limits.idleOnly,idleOnly);
  assert.equal(saved.limits.lendingPolicy.stopOnReturn,stopOnReturn);
  assert.equal((await api(app,'/api/home')).lendingPolicy.migration,null);
  assert.equal(saved.presenceDefaultsVersion,2);
  await app.close();
  ({app}=await f.start('presence-mixed'));
  const twice=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(twice.limits,saved.limits);
  assert.deepEqual(twice.lendingPolicyMigration,saved.lendingPolicyMigration);
});
