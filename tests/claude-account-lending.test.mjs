import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';

import {runAccountsCommand} from '../lib/v1/accounts-cli.mjs';
import {claudeAccountAdmission} from '../lib/claude-accounts.mjs';
import {accountBackend} from './helpers/claude-account-backend.mjs';

const token=()=>'sk-ant-oat01-'+randomBytes(32).toString('hex');
const quiet={write(){}};
// The app's own composition: the pool tells the hold which account a worker serves.
const gateFor=f=>claudeAccountAdmission({accounts:()=>f.registry.list(),sbxHome:()=>f.home,runtime:()=>f.backend.claudeAccountRuntime()});

// The lender's candidate keeps each reservation under the account the worker asked for; every settlement is recorded.

// The production backend prepares and removes each sandbox (account route, scoped value, journal); the agent run is synthetic.

test('an added account stays unchecked until its scoped check passes, and admission follows that readiness',async t=>{
 const f=await accountBackend(t);
 let output='';const stdout={write:text=>output+=text};
 await runAccountsCommand(['add','claude','--label','Work'],{home:f.home,stdin:Readable.from([token()+'\n']),stdout,backend:f.backend});
 const added=JSON.parse(output),id=added.id,key=added.key;
 assert.equal(f.registry.get(id).enabled,false,'an added account is stored unchecked');
 const gate=gateFor(f);
 assert.equal(gate.reason(key),'claude_account_unavailable','nothing is admitted before the first readiness answer');
 assert.equal(gate.reason('claude'),null,'the default account is not judged by the added-account gate');
 await gate.refresh();
 assert.equal(gate.reason(key),'claude_account_unavailable','unchecked');
 f.flags.curl='401';
 assert.equal(await runAccountsCommand(['check',key],{home:f.home,stdout:quiet,backend:f.backend}),1);
 assert.equal(f.registry.get(id).enabled,false,'a failed check never enables the account');
 await gate.refresh();assert.equal(gate.reason(key),'claude_account_unavailable','401');
 f.flags.curl='200';
 assert.equal(await runAccountsCommand(['check',key],{home:f.home,stdout:quiet,backend:f.backend}),0);
 assert.equal(f.registry.get(id).enabled,true);
 await gate.refresh();assert.equal(gate.reason(key),null,'checked on this sbx and mixin');
 f.flags.version='newer-version';
 await gate.refresh();assert.equal(gate.reason(key),'claude_account_unavailable','sbx drift');
 assert.equal(gate.reason('claude'),null);
 f.flags.version='test-version';await gate.refresh();assert.equal(gate.reason(key),null);
 f.registry.setEnabled(id,false);await gate.refresh();assert.equal(gate.reason(key),'claude_account_unavailable','disabled by the owner');
});

import {appFixture,api,syntheticBackend,waitFor} from './helpers/v1-app-fixture.mjs';
import {syntheticProvider,accountBackend as brokerBackend} from './helpers/synthetic-run-account.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';

// Current account jobs go through the broker; the old worker's account reservation is gone.
for(const disabled of [0,1])test('a Claude job uses only the enabled broker account (disabled '+disabled+')',{timeout:180000},async t=>{
  const f=await appFixture(t),backend=brokerBackend(syntheticBackend(f.root)),upstream=[],printedGuestTokens=[];
  const start=backend.start.bind(backend);
  backend.start=async(handle,options)=>{
    const result=await start(handle,options);
    if(handle._entrypoint.startsWith('env ')){
      const token=/JOB_KEY=([^']+)/.exec(handle._entrypoint)[1];printedGuestTokens.push(token);
      handle._lastExecStdout=[keys[1-disabled],token].map(text=>JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}})).join('\n')+'\n'+JSON.stringify({type:'result',model:'claude-haiku-5-5',result:'Finished safely.',usage:{input_tokens:13,output_tokens:5}})+'\n';
      options.onLog?.({stream:'stdout',chunk:Buffer.from(handle._lastExecStdout)});
    }
    return result;
  };
  const configuration=structuredClone(syntheticProvider);
  configuration.descriptor.id='claude';configuration.harnessId='claude-code-subscription';configuration.command='claude';
  configuration.descriptor.models=[{id:'claude-haiku-5-5',label:'Synthetic Claude',enabled:true,rank:0,pareto:null,
    efforts:[{id:'high',label:'High'}],defaultEffort:'high'}];
  let subject='synthetic-first';
  const {owner,lender,circle,realHeartbeats}=await f.realConnect({lenderOptions:{backend,
    adapters:[{spec:legacyProxyHarness('claude-code-subscription'),installed:true,signedIn:true,
      harnessVersion:'synthetic',models:['claude-haiku-5-5'],capabilities:[]}],
    accountProviderConfigurations:[configuration],accountTransportFetch:async(_url,options)=>{
      if(options.method==='GET')return Response.json({subject});
      upstream.push(new Headers(options.headers).get('authorization'));
      return Response.json({id:'synthetic-message',type:'message',model:'claude-haiku-5-5',content:[]});
    }}});
  const accounts=[],keys=['SYNTHETIC_FIRST_KEY','SYNTHETIC_SECOND_KEY'];
  for(let i=0;i<2;i++){
    subject='synthetic-'+i;
    const flow=await api(lender.app,'/api/accounts',{method:'POST',body:{providerId:'claude',label:'Account '+i,operationId:'enroll-'+i}});
    const account=(await api(lender.app,'/api/accounts/flows/'+flow.value.flowId+'/complete',{method:'POST',body:{answer:keys[i]}})).value;
    accounts.push(account);
    const {revision}=await api(lender.app,'/api/accounts');
    const saved=await api(lender.app,'/api/accounts/'+account.id+'/settings',{method:'POST',body:{expectedRevision:revision,
      enabled:i!==disabled,modelPreference:{modelId:'claude-haiku-5-5',enabled:true,effortIds:null}}});
    assert.equal(saved.ok,true,JSON.stringify(saved));
  }
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/claude-code-subscription',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const chosen=accounts[1-disabled];
  await waitFor(()=>realHeartbeats.filter(row=>row.device===lender.app.device.keyId).at(-1)?.body.accounts?.some(a=>a.accountId===chosen.id),'enabled Claude account',30000);
  const sent=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{circle:circle.id,prompt:'Use the enabled account',
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),harness:'claude-code-subscription'}});
  const client=await owner.app.device.client(circle.id);
  const view=await waitFor(async()=>{const v=await client.getJob(sent.jobDigest);return v.state==='result-accepted'?v:null;},'Claude result',60000);
  const result=await client.fetchResult(sent.jobDigest,{includeMetadata:true,attempt:view.current_attempt});
  assert.equal(result.receipt.selection.accountId,chosen.id);
  assert.equal(result.receipt.selection.providerId,'claude');
  assert.deepEqual(upstream,['Bearer '+keys[1-disabled]],'only the selected account authorizes upstream traffic');
  const transcript=Buffer.from(await client.fetchTranscript(sent.jobDigest,{attempt:view.current_attempt})).toString();
  const publicData=JSON.stringify([result,transcript,await api(lender.app,'/api/accounts'),backend.calls]);
  assert.match(transcript,/private details withheld/,'a lent job printing its account and broker tokens is withheld');
  for(const key of [...keys,...printedGuestTokens])assert.ok(!publicData.includes(key),'account credentials stay out of public data and sandbox specifications');
});
