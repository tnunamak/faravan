import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {opById} from '../lib/v1/ops/registry.mjs';
import {APP_DEFAULTS} from '../lib/v1/app.mjs';
import {normalizeLendingPolicy,evaluateLending} from '../lib/v1/lending-policy.mjs';
import {policyDraft} from "../ui/v1/src/lending-policy-view.mjs";
import {appFixture, api} from "./helpers/v1-app-fixture.mjs";
import {calibration,GATES,job,MICRO as M,NOW,OWNER_NONE,windows} from './helpers/lending-objective-fixtures.mjs';

test('fresh policy, app and UI use a ten percent per-job cap',async t=>{
  for(const policy of [normalizeLendingPolicy(),APP_DEFAULTS.lendingPolicy,policyDraft()])
    assert.equal(policy.strategyParams.perJobPct,10);
  const f=await appFixture(t),{app}=await f.start('fresh-cap');
  const home=await api(app,'/api/home');
  assert.equal(home.lending.limits.lendingPolicy.strategyParams.perJobPct,10);
  assert.equal(home.lendingPolicy.migration,undefined);
});
test('the shared MCP and CLI limits schema advertises ten percent',()=>{
  assert.equal(opById('limits.set').input.properties.lendingPolicy.properties.strategyParams.properties.perJobPct.default,10);
});

test('default cap limits an admitted native job weekly reservation to ten points',()=>{
  const resourceWindows=windows({weeklyUsedMicro:0,shortUsedMicro:0});
  for(const window of Object.values(resourceWindows))Object.assign(window,{conversion:'native_window',pointsPerUsdMicro:null,pointsPerUsdLowerMicro:null});
  const result=evaluateLending({objectiveInput:{now:NOW,observedAt:NOW,windows:resourceWindows,
    band:calibration(),owner:OWNER_NONE,gates:GATES,weeklyResource:'seven_day',
    laterBurnCapacityMicro:0,job:job({nativeCostBounds:{unit:'usd',lower:3,upper:3}})}});
  assert.equal(result.admitted,true,JSON.stringify(result));
  assert.equal(result.reservePointsMicro.seven_day,10*M);
});


test('a saved null per-job points cap normalizes to ten percent',()=>assert.equal(normalizeLendingPolicy({strategyParams:{perJobPct:null}}).strategyParams.perJobPct,10));
