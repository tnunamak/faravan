import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {openDevice} from '../lib/v1/device.mjs';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';

const adapters=()=>[{spec:legacyProxyHarness('claude-code-subscription'),installed:true,signedIn:true,
 harnessVersion:'synthetic-only',models:['claude-haiku-5-5'],capabilities:[]}];
for(const strategy of ['automatic','fixed_share'])test(`app.mjs ${strategy} objective exposes retained liability at the observed 3x rate`,{timeout:120000},async t=>{
 const f=await appFixture(t), home=await f.home('lender'), start=Date.now();
 const device=await openDevice({home});
 const kappa={weekly:100000,short:100000};
 const source=createSyntheticPace50Source({start,used:{weekly:0,short:0},kappa});
 const opened=createPace50Candidate({directory:join(home,'v1'),now:()=>start,source,account:device.keyId,account_week_id:'synthetic-week-1',
  contextFor:()=>({consent:true,ownerAbsent:true,strategy:'fixed_share',strategyParams:{fixedSharePct:50,keepPct:30}})});
 const reserved=await opened.candidate.reserve({attemptId:'retained',jobId:'retained',provider:'claude',model:'claude-haiku-5-5',ownerAbsent:true,
  job:{budget_v1:{max_list_usd:10},requirements:{limits:{wall_seconds:60}},expires_at:new Date(start+3600000).toISOString()}});
 assert.equal(reserved.ok,true,JSON.stringify(reserved));await opened.candidate.started('retained',{ok:true});await opened.adapter.close();
 kappa.weekly=300000;kappa.short=300000;
 const {lender,circle}=await f.connect({device,adapters,lendingPace50:{source,account_week_id:'synthetic-week-1'},
  idleReader:undefined});
 await api(lender.app,'/api/lending/limits',{method:'POST',body:{idleOnly:false,lendingPolicy:{providerConsent:{claude:true},
  strategy,strategyParams:{fixedSharePct:50,keepPct:30}}}});
 await api(lender.app,'/api/agents/claude-code-subscription',{method:'POST',body:{useForLending:true}});
 await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 await api(lender.app,'/api/desktop/presence',{method:'POST',body:{idleSeconds:3600}});
 await api(lender.app,'/api/agents/refresh',{method:'POST',body:{agents:['claude-code-subscription']}});
 const view=await api(lender.app,'/api/lending');
 const decision=view.objective.accounts.find(a=>a.provider==='claude').decision.availability;
 assert.equal(decision.objective?.committedPoints?.seven_day,3,JSON.stringify(decision));
 assert.equal(decision.objective?.strategyId,strategy,JSON.stringify(decision));
});
