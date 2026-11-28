import {LENDING_REASONS} from '../lib/v1/lending-reasons.mjs';
import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';

test('turning lending on with no ready account returns the no_accounts decision instead of an adapter veto',{timeout:60000},async t=>{
 const f=await appFixture(t);
 const {lender,circle}=await f.connect({syntheticAccounts:false,adapters:[{spec:legacyProxyHarness('codex'),installed:true,signedIn:false,enabled:true}]});
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 let last;
 const view=await waitFor(async()=>{const v=last=await api(lender.app,'/api/lending');return v.reason==='no_accounts'&&v;},'the account decision',10000).catch(e=>{throw new Error(e.message+' '+JSON.stringify({reason:last?.reason,status:last?.status,accountStates:last?.accountStates,enabled:last?.enabled}));});
 assert.equal(view.reason,'no_accounts');
 assert.equal(view.nextAction.label,'Add an agent account');
 assert.equal(view.lending_on,true);
 for(const row of [view,...view.accountStates])if(row.reason)assert.ok(Object.hasOwn(LENDING_REASONS,row.reason),row.reason);
 const status=await api(lender.app,'/api/status');
 assert.equal(status.lendingProjection.admissionReason,'no_accounts');
 assert.equal(status.state,'blocked');
 assert.equal(status.reason,'no_accounts');
 assert.equal(status.intent.reason,'no_accounts');
});
