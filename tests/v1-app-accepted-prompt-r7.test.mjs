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

test('the lender reads the accepted request from its own approval while the host copy is unavailable',{timeout:90000},async t=>{
  const {lender,circle,jobDigest,control}=await finishedJob(t);
  control.down=true;
  const prompt=await api(lender.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'/prompt?circle='+circle.id);
  assert.equal(prompt.text,'Synthetic offline task');
  const other=await realFetch(lender.app.origin+'/api/jobs/'+encodeURIComponent(jobDigest)+'/prompt?circle=00000000-0000-4000-8000-000000000000',{headers:{'x-faravan-session-token':lender.app.token}});
  assert.notEqual(other.status,200,'the local copy answers only for the circle the job ran in');
});

for(const own of [false,true])test('a lender that loses the offer claim cannot read a prompt cached by its '+(own?'own-job acceptance':'manual accept'),{timeout:90000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const {jobDigest}=await api((own?lender:owner).app,'/api/jobs',{method:'POST',body:{circle:circle.id,
    git:'https://github.com/example/synthetic.git',commit:'2'.repeat(40),prompt:'The winning lender owns this request',harness:'codex'}});
  const winner=await owner.app.device.client(circle.id),base=f.override;
  let won=false;
  f.override=async ctx=>{
    if(!won&&ctx.route==='/jobs/'+jobDigest.slice(7)+'/claim'){
      // Let another member claim at the exact losing-claim boundary, after
      // approval preflight. The normal fixture then rejects the named claim.
      won=true;
      const limits=f.jobs.get(jobDigest).job.payload.requirements.limits;
      await winner.claimNext({harnesses:['codex'],models:['example-model'],capabilities:['filtered_git_v1'],
        egress:['internet','provider-only'],enforced_limits:Object.keys(limits),max_limits:limits},{waitSeconds:0});
    }
    return base(ctx);
  };
  for(const [path,body] of [['lending/limits',{idleOnly:false}],['agents/codex',{useForLending:true}],
    ['lending/on',{circle:circle.id}]])await api(lender.app,'/api/'+path,{method:'POST',body});
  if(own)await waitFor(()=>f.networkTrace.some(row=>row.device==='lender'&&row.route.endsWith('/claim')&&row.status===409),'failed own-job claim',30000);
  else {
    const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'offer approval',30000);
    await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{},status:409});
  }
  assert.equal(won,true);
  assert.equal(f.jobs.get(jobDigest).current_attempt.holder,owner.app.device.keyId);
  assert.equal(lender.backend.calls.some(([kind])=>kind==='run'),false);
  const prompt=await api(lender.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'/prompt?circle='+circle.id,{status:403});
  assert.equal(prompt.code,'forbidden');
});
