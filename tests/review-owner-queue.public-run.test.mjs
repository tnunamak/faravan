import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runV1Command} from '../lib/v1/cli.mjs';
import {startApp} from '../lib/v1/app.mjs';
import {resolveHarness} from '../lib/executor.mjs';
import {HARNESS_ADAPTERS} from '../lib/harnesses/index.mjs';
import {appFixture,api,waitFor} from './helpers/offers-jobs-fixture.mjs';

// Production CLI, signed HTTP client and app/pool/lender; coordinator, execution and provider evidence are synthetic.
test('public run reaches native owner execution through verified offers',{timeout:90000},async t=>{
  const f=await appFixture(t,{startApp});
  const native=HARNESS_ADAPTERS.find(adapter=>adapter.spec.harness_id==='codex');
  const {lender:owner,circle}=await f.connect({freshLending:'automatic',adapters:[{
    ...native,installed:true,signedIn:true,models:['gpt-6-luna'],capabilities:[],
  }],lendingSignInProbe:async()=>({signedIn:false})});
  await api(owner.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(owner.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const repo=join(f.root,'owner-project');await mkdir(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
  git('init','-q','-b','main');git('config','user.email','test@example.invalid');git('config','user.name','Synthetic test');
  await writeFile(join(repo,'README.md'),'Synthetic project\n');git('add','README.md');git('commit','-q','-m','Synthetic source');
  let stdout='',stderr='';
  const code=await runV1Command(['run','--yes','--detach','--json','--circle',circle.id,'--harness','codex','--model','gpt-6-luna','Synthetic owner task'],{
    home:owner.home,device:owner.app.device,cwd:repo,stdout:{write:s=>stdout+=s},stderr:{write:s=>stderr+=s},
  });
  assert.equal(code,0,stderr);
  const digest=JSON.parse(stdout).job_digest;
  assert.equal(f.jobs.get(digest).job.payload.author,owner.app.device.keyId);
  try {await waitFor(()=>f.jobs.get(digest).state==='result-accepted','public native owner result',45000);}
  catch(error) {t.diagnostic(JSON.stringify({lending:(await api(owner.app,'/api/lending')).status,calls:owner.backend.calls.map(([kind])=>kind),events:(await api(owner.app,'/api/activity?after=0')).filter(e=>e.type==='lending'||e.type==='approval').slice(-6),requests:f.requests.slice(-8).map(r=>r.route)}));throw error;}
  const jobPrepare=owner.backend.calls.find(([kind,spec])=>kind==='prepare'&&spec.execution_scope==='owner');
  assert.ok(jobPrepare,'production lender derives owner scope');
  assert.equal(jobPrepare[1].auth_strategy,'provider-file-generation');
  assert.equal(owner.backend.calls.filter(([kind])=>kind==='run').length,1);
  assert.equal((await api(owner.app,'/api/agents'))[0].useForLending,false);
  assert.ok(f.heartbeats?.length>0,'the production app sent heartbeat advertisements');
  assert.ok(f.heartbeats.every(row=>!row.agents?.some(a=>a.adapter==='codex')),'native capacity is not advertised in heartbeats');
  assert.equal(f.requests.some(r=>r.route.includes('claim-next')),false,'no native broadcast claim');
  assert.ok(f.requests.some(r=>r.route.endsWith('/claim')),'a named verified offer was claimed');
  assert.ok((await api(owner.app,'/api/activity?after=0')).some(e=>e.type==='approval'&&e.data.auto==='own job'));
});

test('a saved native lending choice cannot advertise native capacity',{timeout:60000},async t=>{
  const f=await appFixture(t,{startApp}),home=await f.home('lender');
  await mkdir(join(home,'v1'),{recursive:true});
  await writeFile(join(home,'v1','app-settings.json'),JSON.stringify({version:1,name:'Synthetic',enabled:false,intent:'off',activeCircle:null,agents:{codex:true},modes:{},limits:{}}));
  const {lender:owner,circle}=await f.connect({adapters:[{
    spec:resolveHarness('codex'),installed:true,signedIn:true,models:['gpt-6-luna'],capabilities:[],
  }]});
  await api(owner.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  assert.ok(f.heartbeats?.length>0);
  assert.ok(f.heartbeats.every(row=>!row.agents?.some(a=>a.adapter==='codex')),'persisted native choices are never advertised');
});
