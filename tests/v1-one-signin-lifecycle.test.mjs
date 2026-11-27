import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createUsageAccountStore} from '../lib/v1/usage-account-store.mjs';
import {createUsageHostReader} from '../lib/v1/usage-host-reader.mjs';
import {createUsageTokenRefresher} from '../lib/v1/usage-token-refresh.mjs';
import {createLentClaudeCredential} from '../lib/v1/lent-claude-credential.mjs';
import {createProviderSource,publishProviderGeneration} from '../lib/credential-generations.mjs';
import {answerCurl,setScoped} from './helpers/scoped-answer.mjs';

// The production lease, store and refresher, driven by a fake clock and a fake token endpoint, in front of the production
// prepare with a fake sbx. Nothing here contacts a provider.
const START=Date.UTC(2026,10,12,9),HOUR=3600e3,WALL=60;
const testOptions={timeout:120000};

test('near expiry: a refresh covers the next job, a refresh that cannot cover it starts no sandbox, a later job uses the new generation',testOptions,async t=>{
  const {DockerSbxBackend}=await import('../lib/docker-backend.mjs');
  const {createSbxPolicy,sbxRunner}=await import('./helpers/sbx-policy-model.mjs');
  const {seedSandboxOwner}=await import('./helpers/sandbox-owner.mjs');
  await mkdir(join(homedir(),'.tmp'),{recursive:true});
  const storeHome=await mkdtemp(join(homedir(),'.tmp','onesignin-store-')),home=await mkdtemp(join(homedir(),'.tmp','onesignin-sbx-'));
  t.after(()=>Promise.all([rm(storeHome,{recursive:true,force:true}),rm(home,{recursive:true,force:true})]));
  const old={bin:process.env.FARAVAN_SBX_BIN,home:process.env.FARAVAN_SBX_HOME,root:process.env.FARAVAN_SCRATCH_ROOT};
  process.env.FARAVAN_SBX_BIN=process.execPath;process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;seedSandboxOwner();
  t.after(()=>{for(const [k,v] of [['FARAVAN_SBX_BIN',old.bin],['FARAVAN_SBX_HOME',old.home],['FARAVAN_SCRATCH_ROOT',old.root]])if(v===undefined)delete process.env[k];else process.env[k]=v;});

  let clock=START;const now=()=>clock;
  const source=await createProviderSource(storeHome,'claude');
  await writeFile(join(source.directory,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'synthetic-access-1',refreshToken:'synthetic-refresh-1',expiresAt:START+2*HOUR,scopes:['user:inference']}}),{mode:0o600});
  await publishProviderGeneration(storeHome,source);
  // The fake token endpoint: each grant issues the next access token; `expiresIn` decides how long it lives.
  let grants=0,expiresIn=8*3600;
  const usage={five_hour:{utilization:1,resets_at:new Date(START+HOUR).toISOString()},seven_day:{utilization:1,resets_at:new Date(START+24*HOUR).toISOString()},extra_usage:{is_enabled:false}};
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname;let status=200,body;
    if(options.method==='POST'){grants++;body={access_token:'synthetic-access-'+(grants+1),refresh_token:'synthetic-refresh-'+(grants+1),expires_in:expiresIn};}
    else if(path==='/api/oauth/usage')body=usage;
    else if(path==='/api/oauth/profile')body={account:{uuid:'uuid-a'},organization:{uuid:'org-a'}};
    else {status=404;body={};}
    return {status,headers:{get:()=>null},json:async()=>body};
  };
  const store=createUsageAccountStore({home:storeHome});
  const reader=createUsageHostReader({store,fetchImpl,now});
  const refresher=createUsageTokenRefresher({store,reader,fetchImpl,now,sleep:async()=>{},backoffMs:0});
  const reports=[];
  const lent=createLentClaudeCredential({store,refresher,now,onOutcome:code=>reports.push(code)});

  const calls=[],secrets=[],policy=createSbxPolicy({globalRules:[]});let real='synthetic-access-1';
  const listing=()=>JSON.stringify({secrets:secrets.map(({token,...row})=>row),custom_secrets:[],shadowed_services:[],env_only_count:0});
  const runner=sbxRunner(policy,async(args,options)=>{
    calls.push({args,input:options?.input});
    if(args[0]==='secret'&&args[1]==='ls')return {code:0,stdout:listing()};
    if(args[0]==='version')return {code:0,stdout:'test-version'};
    if(args[0]==='secret'&&args[1]==='set')setScoped(secrets,args,options.input);
    const answered=answerCurl(args,secrets,{real});if(answered)return answered;
    if(args[0]==='rm'){const name=args.at(-1);for(let n=secrets.length-1;n>=0;n--)if(secrets[n].scope===name)secrets.splice(n,1);}
    return {code:0,stdout:args[0]==='ls'?JSON.stringify(Object.keys(policy.state.sandboxes).map(name=>({name,status:'running'}))):'',stderr:''};
  },{kitAllow:[],secretResult:{code:0,get stdout(){return listing();}}});
  const backend=new DockerSbxBackend({home,runCommand:(args,options)=>{options?.beforeSpawn?.();return runner.run(args,options);}});
  backend.setLentClaudeCredential(lent);
  const job={job_id:'test-lifecycle',image:'claude',entrypoint:'true',execution_scope:'borrowed',auth_strategy:'docker-native-oauth',
    resources:{cpu:1,memory_mib:512,storage_mib:512,wall_seconds:WALL,output_bytes:16384,network_bytes:1048576,max_processes:32},inputs:[],output_manifest:[],
    egress:'provider-only',provider_hosts:['api.anthropic.com'],required_limits:['cpu','memory','wall','output']};
  const pushed=()=>calls.filter(c=>c.args[0]==='secret'&&c.args[1]==='set'&&c.input?.startsWith('synthetic-')).map(c=>c.input);
  const run=async expected=>{real=expected;const h=await backend.prepare(job);const out={...h._execution};await backend.destroy(h);return out;};

  // A: enough life left, no refresh.
  const a=await run('synthetic-access-1');
  assert.equal(grants,0);assert.equal(a.token_lifetime_seconds,2*3600,'lifetime at admission, in seconds');
  assert.deepEqual(pushed(),['synthetic-access-1','synthetic-access-1']);

  // B: the clock moves to 100 s before expiry. The job forces a refresh and the push carries the new access token.
  clock=START+2*HOUR-100e3;
  const b=await run('synthetic-access-2');
  assert.equal(grants,1);assert.notEqual(b.scoped_generation,a.scoped_generation,'a new generation was published');
  assert.equal(pushed().at(-1),'synthetic-access-2');assert.equal(b.token_lifetime_seconds,8*3600);
  assert.equal(JSON.stringify(calls.map(c=>c.args)).includes('synthetic-refresh'),false,'the refresh token never reaches argv');
  assert.equal(calls.some(c=>c.input?.includes('synthetic-refresh')),false,'the refresh token is never pushed');

  // A later job uses the refreshed generation without another refresh.
  clock+=60e3;
  const c=await run('synthetic-access-2');
  assert.equal(grants,1);assert.equal(c.scoped_generation,b.scoped_generation);assert.equal(c.token_lifetime_seconds,8*3600-60);

  // The refresh cannot cover wall_seconds + 120 s grace (it grants 100 s): refused, no sandbox is created.
  clock=START+2*HOUR-100e3+8*HOUR-100e3;expiresIn=100;
  const before=calls.length;reports.length=0;
  await assert.rejects(backend.prepare(job),error=>error.code==='claude_account_unavailable');
  assert.equal(grants,2);assert.equal(calls.slice(before).some(call=>call.args[0]==='create'),false,'no sandbox is created');
  assert.notEqual(reports.at(-1),null);

  // The provider recovers: the next job refreshes again, takes the newest generation and clears the fault.
  expiresIn=8*3600;
  const d=await run('synthetic-access-4');
  assert.equal(grants,3);assert.notEqual(d.scoped_generation,b.scoped_generation);assert.equal(d.token_lifetime_seconds,8*3600);
});
