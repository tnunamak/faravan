import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {opById} from '../lib/v1/ops/registry.mjs';
import {APP_DEFAULTS} from '../lib/v1/app.mjs';
import {normalizeLendingPolicy,evaluateLending} from '../lib/v1/lending-policy.mjs';
import {policyDraft,migrationVM} from '../ui/v1/src/lending-policy-view.mjs';
import {appFixture,api,syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {calibration,GATES,job,MICRO as M,NOW,OWNER_NONE,windows} from './helpers/lending-objective-fixtures.mjs';

test('fresh policy, app and UI use a ten percent per-job cap',async t=>{
  for(const policy of [normalizeLendingPolicy(),APP_DEFAULTS.lendingPolicy,policyDraft()])
    assert.equal(policy.strategyParams.perJobPct,10);
  const f=await appFixture(t),{app}=await f.start('fresh-cap');
  const home=await api(app,'/api/home');
  assert.equal(home.lending.limits.lendingPolicy.strategyParams.perJobPct,10);
  assert.equal(home.lendingPolicy.migration,null);
});
test('the shared MCP and CLI limits schema advertises ten percent',()=>{
  assert.equal(opById('limits.set').input.properties.lendingPolicy.properties.strategyParams.properties.perJobPct.default,10);
});
for(const cap of [undefined,null,25,0])test(`saved per-job cap ${cap} migrates durably once`,{timeout:60000},async t=>{
  const f=await appFixture(t),home=await f.home('cap-default'),directory=join(home,'v1');
  await mkdir(directory,{recursive:true});
  const file=join(directory,'app-settings.json');
  await writeFile(file,JSON.stringify({version:1,presenceDefaultsVersion:1,intent:'off',agents:{},modes:{},
    limits:{...APP_DEFAULTS,lendingPolicy:{...normalizeLendingPolicy(),strategyParams:cap===undefined?{}:{perJobPct:cap}}}}));
  let atUse;
  let {app}=await f.start('cap-default',{backendFactory:async()=>{
    atUse=JSON.parse(await readFile(file,'utf8'));return syntheticBackend(f.root);
  }});
  assert.equal(atUse.limits.lendingPolicy.strategyParams.perJobPct,cap??10);
  const notice=(await api(app,'/api/home')).lendingPolicy.migration;
  if(cap==null){assert.equal(notice.acknowledged,false);assert.match(migrationVM({migration:notice}).text,/per.job cap.*10%/i);}
  else assert.notEqual(notice?.perJobCapChanged,true);
  await app.close();
  const before=JSON.parse(await readFile(file,'utf8'));
  ({app}=await f.start('cap-default'));
  const after=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(after.limits.lendingPolicy,before.limits.lendingPolicy);
  assert.deepEqual(after.lendingPolicyMigration,before.lendingPolicyMigration);
});

test('default cap limits an admitted native job weekly reservation to ten points',()=>{
  const resourceWindows=windows({weeklyUsedMicro:0,shortUsedMicro:0});
  for(const window of Object.values(resourceWindows))Object.assign(window,{conversion:'native_window',pointsPerUsdMicro:null,pointsPerUsdLowerMicro:null});
  const result=evaluateLending({objectiveInput:{now:NOW,observedAt:NOW,windows:resourceWindows,
    band:calibration(),owner:OWNER_NONE,gates:GATES,ownerMaxJobUsdMicro:20*M,weeklyResource:'seven_day',
    laterBurnCapacityMicro:0,job:job({nativeCostBounds:{unit:'usd',lower:3,upper:3}})}});
  assert.equal(result.admitted,true,JSON.stringify(result));
  assert.equal(result.reservePointsMicro.seven_day,10*M);
});

test('a cap migration notice also retains the ambiguous presence review notice',()=>{
  const vm=migrationVM({migration:{acknowledged:false,perJobCapChanged:true,presenceDefaultsUncertain:true,
    reset:[{field:'strategyParams.perJobPct'}]}});
  assert.match(vm.text,/Per-job cap: no cap, reset to 10%/);
  assert.match(vm.text,/saved activity settings were kept/);
});
