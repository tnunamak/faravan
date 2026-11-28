import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';

test('startup status reads the enrolled account and names its own lending hold',async t=>{
 const f=await appFixture(t),{lender}=await f.connect();
 const accounts=(await api(lender.app,'/api/accounts')).accounts;
 const view=await api(lender.app,'/api/lending');
 assert.equal(accounts.length,1);
 assert.deepEqual(view.objective.accounts.map(row=>[row.id,row.provider,row.decision.reason]),[[accounts[0].id,'codex','lending_off']]);
});
test('an unconfigured provider has no invented account reading',async t=>{
 const f=await appFixture(t),{app}=await f.start('no-account');
 assert.deepEqual((await api(app,'/api/accounts')).accounts,[]);
 assert.deepEqual((await api(app,'/api/lending')).objective.accounts,[]);
});
