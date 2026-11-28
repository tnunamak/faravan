import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {appFixture,api,syntheticBackend,waitFor} from './helpers/v1-app-fixture.mjs';

// The signed broker-account route through the real app: lender, account wrapper and executor, with a synthetic sandbox.
// The sandbox's own clock arithmetic is proven against the real backend in docker-backend.test.mjs; this file proves the
// account route hands the lender's lease clock to its prepare and that the lender's wall clock starts at the handoff.
const providerConfiguration={
  descriptor:{schemaVersion:1,id:'codex',label:'Configured key service',signInKind:'api_key',refreshKind:'none',
    usageKind:'job_local',maxConcurrentJobs:1,nativeUnits:[{id:'tokens',scale:1}],
    models:[{id:'example-model',label:'Example',enabled:true,rank:0,pareto:null,
      efforts:[{id:'high',label:'High'}],defaultEffort:'high'}],
    destinations:[{origin:'https://controlled.invalid',pathPrefixes:['/v1'],methods:['POST']}]},
  identityUrl:'https://controlled.invalid/me',identitySubjectField:'subject',command:'codex',args:['exec'],modelFlag:'-m',effortFlag:'--effort',keyEnv:'JOB_KEY',baseUrlEnv:'BASE_URL',
};
async function enroll(app,key,operationId){
  const flow=await api(app,'/api/accounts',{method:'POST',body:{providerId:'codex',label:operationId,operationId}});
  const account=(await api(app,'/api/accounts/flows/'+flow.value.flowId+'/complete',{method:'POST',body:{answer:key}})).value;
  const {revision}=await api(app,'/api/accounts');
  const settings=await api(app,'/api/accounts/'+account.id+'/settings',{method:'POST',
    body:{expectedRevision:revision,modelPreference:{modelId:'example-model',enabled:true,effortIds:null}}});
  assert.equal(settings.ok,true,JSON.stringify(settings));
  return account;
}

test('a signed account job prepares under the lender lease clock and its wall clock starts at the handoff',{timeout:90000},async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root);
  const prepareOptions=[],clockAtStart=[];
  backend.prepareAccountRun=async(spec,options)=>{
    prepareOptions.push(options);
    prepareOptions.remainingAtPrepare=options.wallRemainingMs?.();
    const h=await backend.prepare(spec);
    h.job_id=spec.job_id;h.sandbox_id='prep-clock-'+randomUUID();h._cleanupId=randomUUID();return h;
  };
  backend.inspect=async h=>({job_id:h.job_id,status:'exited'});
  const originalStart=backend.start.bind(backend);
  backend.start=async(h,opts)=>{
    if(h._entrypoint.startsWith('env ')){
      clockAtStart.push(prepareOptions[0].wallRemainingMs());
      const key=/JOB_KEY=([^']+)/.exec(h._entrypoint)[1],base=/BASE_URL=([^']+)/.exec(h._entrypoint)[1];
      const response=await fetch(base+'/responses',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},
        body:JSON.stringify({model:'example-model',effort:'high'})});
      assert.equal(response.status,200);
      h._entrypoint='completed-controlled-provider';
    }
    return originalStart(h,opts);
  };
  const {owner,lender,circle,realHeartbeats}=await f.realConnect({lenderOptions:{backend,accountProviderConfigurations:[providerConfiguration],
    accountTransportFetch:async(_url,options)=>{
      if(options.method==='GET')return Response.json({subject:'prep-clock-subject'});
      return Response.json({id:'prep-clock-response',object:'response',status:'completed',model:'example-model'});}}});
  const account=await enroll(lender.app,'PREP_CLOCK_SECRET','prep-clock-enroll');
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await waitFor(()=>realHeartbeats.filter(row=>row.device===lender.app.device.keyId).at(-1)?.body.accounts?.some(row=>row.accountId===account.id),'published account',30000);
  // Explicitly approve this synthetic submission before checking the lease clocks.
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',headers:{'faravan-confirm':'yes'},body:{circle:circle.id,prompt:'Prep clock account job',
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),harness:'codex',
    runRequest:{schemaVersion:1,models:[{providerId:'codex',modelId:'example-model'}],effortId:'high'}}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'account approval',30000);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  const client=await owner.app.device.client(circle.id);
  await waitFor(async()=>(await client.getJob(submitted.jobDigest)).state==='result-accepted','signed result',30000);
  assert.equal(prepareOptions.length,1);
  const [options]=prepareOptions;
  assert.equal(options.separatePreparationClock,true,'the account prepare asks for the separate preparation clock');
  assert.equal(typeof options.wallRemainingMs,'function','the account prepare carries the lender lease clock');
  assert.ok(prepareOptions.remainingAtPrepare>60_000,'before the handoff the lender clock is the lease, not the 60 second run wall');
  assert.equal(clockAtStart.length,1);
  assert.ok(clockAtStart[0]>0&&clockAtStart[0]<=1_200_000,'after the handoff the lender clock is the run wall');
  assert.ok(prepareOptions.remainingAtPrepare!==clockAtStart[0]);
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
});
