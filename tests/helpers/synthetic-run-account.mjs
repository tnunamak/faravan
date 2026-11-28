import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {legacyProxyHarness} from './legacy-proxy-harness.mjs';
import {createAccountStore} from '../../lib/v1/accounts.mjs';
import {createAccountsApi} from '../../lib/v1/accounts-http.mjs';

// Real account broker and local proxy; only the provider and sandbox process are synthetic.
export const syntheticProvider={
  descriptor:{schemaVersion:1,id:'codex',label:'Synthetic account',signInKind:'api_key',refreshKind:'none',
    usageKind:'job_local',maxConcurrentJobs:1,nativeUnits:[{id:'tokens',scale:1}],
    models:['example-model','gpt-6-luna','gpt-6-sol'].map(id=>({id,label:id,enabled:true,rank:0,pareto:null,
      efforts:['low','medium','high'].map(id=>({id,label:id})),defaultEffort:'high'})),
    destinations:[{origin:'https://controlled.invalid',pathPrefixes:['/v1'],methods:['POST']}]},
  identityUrl:'https://controlled.invalid/me',identitySubjectField:'subject',command:'codex',args:['exec'],
  modelFlag:'-m',effortFlag:'--effort',keyEnv:'JOB_KEY',baseUrlEnv:'BASE_URL',
};
export function accountBackend(backend,configuration=syntheticProvider){
  const configurations=Array.isArray(configuration)?configuration:[configuration];
  backend.prepareAccountRun=async spec=>{
    const handle=await backend.prepare(spec);
    return Object.assign(handle,{job_id:spec.job_id,sandbox_id:handle.sandbox_id??'fixture-'+randomUUID(),_cleanupId:randomUUID()});
  };
  backend.inspect=async handle=>({job_id:handle.job_id,status:handle._fixtureRunning?'running':'exited'});
  const start=backend.start.bind(backend);
  backend.start=async(handle,options)=>{
    const agent=handle._entrypoint.startsWith('env ');
    if(agent)handle._fixtureRunning=true;
    try {
    if(agent){
      const command=handle._entrypoint;
      const token=/JOB_KEY=([^']+)/.exec(command)?.[1],base=/BASE_URL=([^']+)/.exec(command)?.[1];
      const model=/-m'?\s+'?([^' ]+)/.exec(command)?.[1]??'example-model';
      const effort=/--effort'?\s+'?([^' ]+)/.exec(command)?.[1]??null;
      const response=await fetch(base+'/responses',{method:'POST',
        headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({model,effort})});
      assert.equal(response.status,200,await response.text());
    }
    const result=await start(handle,options);
    if(agent&&configurations.some(row=>row.descriptor.id==='claude')&&/\bclaude\b/.test(handle._entrypoint)){
      const model=/-m'?\s+'?([^' ]+)/.exec(handle._entrypoint)?.[1]??'example-model';
      handle._lastExecStdout=JSON.stringify({type:'result',model,usage:{input_tokens:13,output_tokens:5}})+'\n';
      options.onLog?.({stream:'stdout',chunk:Buffer.from(handle._lastExecStdout)});
    }
    return result;
    }finally{if(agent)handle._fixtureRunning=false;}
  };
  return backend;
}
export const syntheticTransport=async(_url,options)=>options.method==='GET'
  ?Response.json({subject:'synthetic-fixture-account'})
  :Response.json({id:'fixture-response',object:'response',status:'completed',model:JSON.parse(options.body).model});
export async function enrollSyntheticAccount(app,api,home,configuration=syntheticProvider){
  const existing=(await api(app,'/api/accounts')).accounts?.find(row=>row.providerId===configuration.descriptor.id);
  if(existing)return existing;
  const flow=await api(app,'/api/accounts',{method:'POST',body:{providerId:configuration.descriptor.id,label:'Synthetic account',operationId:randomUUID()}});
  const account=(await api(app,'/api/accounts/flows/'+flow.value.flowId+'/complete',{method:'POST',body:{answer:'SYNTHETIC_FIXTURE_KEY'}})).value;
  for(const model of configuration.descriptor.models){
    const {revision}=await api(app,'/api/accounts');
    const result=await api(app,'/api/accounts/'+account.id+'/settings',{method:'POST',body:{expectedRevision:revision,
      modelPreference:{modelId:model.id,enabled:true,effortIds:null}}});
    assert.equal(result.ok,true,JSON.stringify(result));
  }
  // Lifecycle tests supply a healthy account reading; they do not test the cold-start allocator.
  const store=createAccountStore({directory:join(home,'v1','accounts')}),at=Date.now();
  await store.transaction(state=>{
    const usage=state.records[account.id].usage??={jobReadings:[],events:{},meters:{},pending:{},windowHistory:[],failures:0,readLease:null};
    Object.assign(usage,{state:'ready',lastAttemptAtMs:at,nextReadAtMs:null,limitResetAtMs:null,
      reading:{schemaVersion:1,accountId:account.id,observationId:'fixture-initial',sequence:at,observedAtMs:at,receivedAtMs:at,
        postingUncertaintyMs:null,coverage:{kind:'unknown'},windows:[{id:'seven_day',instance:'seven_day:'+at,
          capacityMicro:100000000,usedLoMicro:0,usedHiMicro:0,resetsAtMs:at+7*86400000,maxOwnerRateMicroPerMs:0}]}});
  });
  return account;
}

export const syntheticAdapters=configurations=>configurations.map(configuration=>({spec:legacyProxyHarness(configuration.harnessId??configuration.descriptor.id),installed:true,signedIn:true,harnessVersion:'synthetic-only',models:configuration.descriptor.models.map(row=>row.id),capabilities:[]}));

export function syntheticConfiguration(provider){
  const configuration=structuredClone(syntheticProvider);
  if(provider==='claude'){
    configuration.descriptor.id='claude';configuration.harnessId='claude-code-subscription';configuration.command='claude';
    configuration.descriptor.models=['claude-haiku-5-5','claude-sonnet-5-6','claude-haiku-4-5'].map(id=>({
      id,label:id,enabled:true,rank:0,pareto:null,efforts:['low','medium','high'].map(id=>({id,label:id})),defaultEffort:'high'}));
  }
  return configuration;
}

// The same model/preferences projection as the app, over this fixture's enrolled accounts.
export function syntheticAccountAdvertisement(home){
  const store=createAccountStore({directory:join(home,'v1','accounts')});
  return createAccountsApi({store,providers:{getProvider:id=>({ok:true,value:syntheticConfiguration(id)})}}).advertise();
}

// Change only the synthetic account's sign-in fact, through the real durable store.
export async function setSyntheticAccountSignedIn({app,api,home,providerId,signedIn}){
  const store=createAccountStore({directory:join(home,'v1','accounts')});
  const record=Object.values(store.read().records).find(row=>row.providerId===providerId);
  if(!record)throw Error('synthetic_account_missing');
  await store.transaction(state=>{state.records[record.id].authState=signedIn?'signed_in':'signed_out';});
  const {revision}=await api(app,'/api/accounts');
  const saved=await api(app,'/api/accounts/'+record.id+'/settings',{method:'POST',body:{expectedRevision:revision,enabled:record.enabled}});
  assert.equal(saved.ok,true,JSON.stringify(saved));
}
