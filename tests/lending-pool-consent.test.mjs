import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLendingPool} from '../lib/v1/lending-pool.mjs';

test('a device grant is shared and a stale sibling cannot restore a revoked grant',async t=>{
 let disk=null;const stores=[],controller=new AbortController();
 const pool=createLendingPool({storage:{get:async()=>disk,set:async v=>{disk=structuredClone(v);},acquire:async()=>()=>{}},
  policy:{enabled:true},adapters:[{spec:{harness_id:'codex'}},{spec:{harness_id:'claude-code-subscription'}}],
  createLender:({policy})=>{stores.push(policy.storage);return {getState:()=>({status:'idle'}),start:signal=>new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))};}});
 const run=pool.start(controller.signal);t.after(async()=>{controller.abort();await run;});
 while(stores.length<2)await new Promise(resolve=>setImmediate(resolve));
 const base={day:'2026-11-26',jobs:0,milliseconds:0,pending:null,hiddenOffers:[],ruleUsage:[]};
 const grant={jobDigest:'sha256:'+'a'.repeat(64),expiresAt:Date.now()+60000};
 await stores[0].set({...base,jobConsents:[grant]});
 const sibling=await stores[1].get();
 assert.deepEqual(sibling.jobConsents,[grant]);
 const owner=await stores[0].get();await stores[0].set({...owner,jobConsents:[{...grant,revoked:true}]});
 await stores[1].set({...sibling,jobs:1});
 assert.deepEqual((await stores[1].get()).jobConsents,[{...grant,revoked:true}]);
 assert.deepEqual(disk.jobConsents,[{...grant,revoked:true}]);
 assert.ok(Object.values(disk.accounts).every(row=>!Object.hasOwn(row,'jobConsents')));
});
