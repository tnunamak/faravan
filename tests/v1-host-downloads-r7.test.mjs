import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, waitFor } from './helpers/v1-lifecycle-fixture.mjs';
import { createSlots } from '../lib/v1/client.mjs';
import { createSavedReads, markSaved } from '../lib/v1/saved-reads.mjs';

// Judge r7 O4, O5 and O7 at the app boundary: a finished job read in parallel, then read again with its host down.
const realFetch=globalThis.fetch;
function hostControl(origin) {
  const control={down:false,inFlight:new Map(),peak:new Map()};
  globalThis.fetch=async(url,options={})=>{
    if(!String(url).startsWith(origin))return realFetch(url,options);
    if(control.down)throw new TypeError('fetch failed');
    const proof=options.headers?.['Faravan-Proof'],device=proof?JSON.parse(Buffer.from(proof,'base64url')).payload.key_id:null;
    const download=(options.method??'GET')==='GET'&&/\/artifacts\//.test(String(url));
    if(!download)return realFetch(url,options);
    control.inFlight.set(device,(control.inFlight.get(device)??0)+1);
    control.peak.set(device,Math.max(control.peak.get(device)??0,control.inFlight.get(device)));
    try {
      // Hold each transfer briefly, as a slow host does, so parallel reads overlap.
      await new Promise(resolve=>setTimeout(resolve,150));
      const response=await realFetch(url,options),body=await response.arrayBuffer();
      return new Response(body,{status:response.status,headers:response.headers});
    } finally {control.inFlight.set(device,control.inFlight.get(device)-1);}
  };
  return control;
}

async function finishedJob(t) {
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  t.after(()=>{globalThis.fetch=realFetch;});
  const control=hostControl(f.origin);
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic offline task',harness:'codex'}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'approval card',30000);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>f.jobs.get(jobDigest).state==='result-accepted','signed result',30000);
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  return {f,owner,lender,circle,jobDigest,control,ownerKey:owner.app.device.keyId};
}

test('a member never has more than two result downloads in flight to one host',{timeout:90000},async t=>{
  const {owner,circle,jobDigest,control,ownerKey}=await finishedJob(t);
  const base='/api/jobs/'+encodeURIComponent(jobDigest);
  const reads=['/changes','/changes','/changes','/changes','/changes','/changes'].map(part=>api(owner.app,base+part+'?circle='+circle.id));
  await Promise.all(reads);
  t.diagnostic(JSON.stringify({peakDownloads:control.peak.get(ownerKey)}));
  assert.ok(control.peak.get(ownerKey)>=1,'the reads downloaded from the host');
  assert.ok(control.peak.get(ownerKey)<=2,'peak '+control.peak.get(ownerKey)+' downloads at once exceeds the host limit of 2');
});

test('download slots queue in order, honour cancellation and release once',async()=>{
  const acquire=createSlots(2),first=await acquire(),second=await acquire();
  const order=[];const third=acquire().then(release=>{order.push('third');return release;});
  const controller=new AbortController(),cancelled=acquire(controller.signal);controller.abort();
  await assert.rejects(cancelled,{name:'AbortError'});
  first();first();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(order,['third']);
  const fourth=acquire();let granted=false;fourth.then(()=>{granted=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(granted,false,'a double release must not free a second slot');
  second();(await third)();assert.equal(typeof await fourth,'function');
});
