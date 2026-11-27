import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('refused Quit leaves the real app usable and releases its updater hold',async t=>{
  const tick=gate(),download=gate(),proof=gate(),reconcile=gate();let relaunches=0;
  t.after(()=>{download.resolve('current');reconcile.resolve();});
  const updater={startDelayMs:10,intervalMs:500,status:async()=>({candidate:'99.0.0'}),
    tick:async()=>{tick.resolve();return download.promise;}};
  const f=await appFixture(t),{app,backend,home}=await f.start('lender',{updater,shutdownProofMs:1500,relaunch:()=>{relaunches++;}});
  await tick.promise;
  backend.reconcilePending=async record=>{proof.resolve();await reconcile.promise;return {removed:false,attemptId:record.attemptId};};
  const countersFile=join(home,'v1','app-counters.json');
  await writeFile(countersFile,JSON.stringify({pending:{attemptId:'synthetic-attempt',...backend.sandboxOwnership(),attempt:{attempt_id:'synthetic-attempt',job_digest:'sha256:'+'a'.repeat(64),generation:1}}}));
  const quit=api(app,'/api/shutdown',{method:'POST',body:{},status:409});
  await proof.promise;download.resolve('applied');
  assert.ok(await api(app,'/api/status'));assert.equal(relaunches,0);
  assert.equal((await quit).code,'cessation_unverified');
  reconcile.resolve();
  await api(app,'/api/lending/off',{method:'POST',body:{}});
  assert.equal(relaunches,0,'the unresolved recovery record still blocks update closure');
  // There is no physical job in this fixture; simulate recovery retiring its pending record.
  await writeFile(countersFile,JSON.stringify({}));
  await waitFor(()=>relaunches===1,'updater resumed after refusal',5000);
  assert.equal((await app.close()).state,'closed');
});
