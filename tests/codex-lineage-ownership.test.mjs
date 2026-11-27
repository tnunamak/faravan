import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createProviderSource,publishProviderGeneration,currentProviderGeneration} from '../lib/credential-generations.mjs';
import {startProviderGenerationAuth} from '../lib/provider-generation-auth.mjs';
import {createUsageAccountStore} from '../lib/v1/usage-account-store.mjs';
import {createUsageHostReader} from '../lib/v1/usage-host-reader.mjs';
import {createUsageTokenRefresher} from '../lib/v1/usage-token-refresh.mjs';
import {createLentCodexCredential} from '../lib/v1/lent-claude-credential.mjs';
import {CODEX_HARNESS} from '../lib/harnesses.mjs';
import {buildValidatedJobSpec} from '../lib/executor.mjs';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';
import {createSbxPolicy,sbxRunner} from './helpers/sbx-policy-model.mjs';

// One holder per Codex sign-in. Codex renews a copied auth.json by itself when its access token nears expiry or is refused,
// and writes the rotated refresh token back (checked with codex-cli 0.171 against synthetic tokens and a local token
// endpoint). OpenAI rotates the refresh token, so whoever spends it second is refused. Faravan's usage refresher is the
// holder of Faravan's own Codex sign-in; an owner's job copy must not be a second one. Synthetic tokens only.

const codexUsage={plan_type:'plus',spend_control:{reached:false},credits:{has_credits:false},account_id:'acct-1',email:'owner@example.test',
  rate_limit:{allowed:true,limit_reached:false,primary_window:{used_percent:1,limit_window_seconds:18000,reset_at:Math.floor(Date.now()/1000)+4000}}};
const jwt=expMs=>'h.'+Buffer.from(JSON.stringify({exp:Math.floor(expMs/1000)})).toString('base64url')+'.s';
const codexValue=(access,refresh)=>({auth_mode:'chatgpt',tokens:{access_token:access,id_token:'synthetic-id',refresh_token:refresh,account_id:'acct-1'},last_refresh:'old'});

async function freshHome(t,prefix) {
  await mkdir(join(homedir(),'.tmp'),{recursive:true});
  const home=await mkdtemp(join(homedir(),'.tmp',prefix));
  t.after(()=>rm(home,{recursive:true,force:true}));
  return home;
}
async function filesUnder(directory) {
  const out=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name);
    if(entry.isDirectory())out.push(...await filesUnder(path));else if(entry.isFile())out.push(path);
  }
  return out;
}

/** A token endpoint that rotates: each refresh token is spent once. Spending a spent token revokes the live one (RFC 9700 4.14.2). */
function rotatingProvider(initial) {
  const state={live:initial,spent:new Set(),issued:0,posts:[]};
  const exchange=refreshToken=>{
    state.posts.push(refreshToken);
    if(refreshToken&&refreshToken===state.live) {
      state.spent.add(refreshToken);state.live='synthetic-refresh-'+(++state.issued);
      return {status:200,body:{access_token:jwt(Date.now()+10*86400e3),refresh_token:state.live}};
    }
    if(state.spent.has(refreshToken))state.live=null;
    return {status:400,body:{error:'invalid_grant'}};
  };
  const fetchImpl=async(url,options)=>{
    const u=new URL(url);
    const reply=options.method==='POST'?exchange(JSON.parse(options.body).refresh_token)
      :u.pathname==='/backend-api/wham/usage'?{status:200,body:codexUsage}:{status:404,body:{}};
    return {status:reply.status,headers:{get:()=>null},json:async()=>reply.body};
  };
  return {state,fetchImpl,spend:refreshToken=>exchange(refreshToken)};
}

test('an owner Codex job gets a copy that cannot renew, so Faravan stays the one holder of its sign-in',{skip:process.platform==='win32'},async t=>{
  const home=await freshHome(t,'codex-lineage-');
  const oldHome=process.env.FARAVAN_SBX_HOME,oldRoot=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;
  t.after(()=>{if(oldHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=oldHome;if(oldRoot===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=oldRoot;});
  // Faravan's own sign-in, with an access token that would expire before the job ends.
  const source=await createProviderSource(home,'codex');
  await writeFile(join(source.directory,'auth.json'),JSON.stringify(codexValue(jwt(Date.now()+120e3),'synthetic-refresh-0')),{mode:0o600});
  await publishProviderGeneration(home,source);
  const provider=rotatingProvider('synthetic-refresh-0');
  const store=createUsageAccountStore({home});
  const reader=createUsageHostReader({store,fetchImpl:provider.fetchImpl});
  const refresher=createUsageTokenRefresher({store,reader,fetchImpl:provider.fetchImpl,sleep:async()=>{},backoffMs:0});
  const faults=[];

  const policy=createSbxPolicy({globalRules:[]});
  const runner=sbxRunner(policy,args=>({code:0,stdout:args[0]==='ls'?JSON.stringify(Object.keys(policy.state.sandboxes).map(name=>({name,status:'running'}))):'',stderr:''}),{kitAllow:[]});
  const copied=new Map();
  const backend=new DockerSbxBackend({home,runCommand:async(args,options)=>{
    if(args[0]==='cp')copied.set(args[2],await readFile(args[1],'utf8').catch(()=>null));
    return runner.run(args,options);
  },storage:{supported:async()=>true,available:async()=>true,reserve:async()=>{},release:async()=>{},verify:async()=>true,recordQualification:async()=>{}}});
  backend.setLentCodexCredential(createLentCodexCredential({store,refresher,onOutcome:code=>faults.push(code)}));

  const job=buildValidatedJobSpec({taskDigest:'1'.repeat(64),harness:CODEX_HARNESS,entrypointWithPrompt:'true',network:'disabled'});
  assert.equal(job.execution_scope,'owner');
  const consumer=await backend.prepare(job);
  try {

    // Faravan renewed the sign-in on the host before the copy, spending the one live refresh token itself.
    assert.deepEqual(provider.state.posts,['synthetic-refresh-0']);
    const published=await currentProviderGeneration(home,'codex');
    const hostValue=JSON.parse(await readFile(join(published.directory,'auth.json'),'utf8'));
    assert.equal(hostValue.tokens.refresh_token,provider.state.live,'the host holds the live refresh token');
    const guest=JSON.parse(copied.get(consumer.sandbox_id+':/var/tmp/faravan-auth-'+published.id+'/auth.json'));
    assert.equal(guest.tokens.access_token,hostValue.tokens.access_token,'the guest runs on the renewed access token');
    assert.equal(guest.tokens.refresh_token,'','the guest copy holds no refresh token');
    assert.equal(JSON.stringify(guest).includes(provider.state.live),false);
    assert.deepEqual(faults,[],'an owner job never reports a lending fault');
    assert.deepEqual(await readdir(join(home,'credential-consumers')),[],'no consumer file is left on the host');

    // What the guest's Codex does when its token nears expiry: it spends what it holds. Nothing, so the sign-in is untouched.
    assert.equal(provider.spend(guest.tokens.refresh_token).status,400);
    const renewed=await refresher.refresh('codex',{force:true});
    assert.deepEqual([renewed.ok,renewed.refreshed],[true,true],'Faravan still renews its own sign-in');

    // The defect a full copy had: a guest that spends the host's refresh token first leaves Faravan refused, and the provider
    // revokes the sign-in. This is what any second holder does to the one Faravan keeps.
    const full=JSON.parse(await readFile(join((await currentProviderGeneration(home,'codex')).directory,'auth.json'),'utf8'));
    assert.equal(provider.spend(full.tokens.refresh_token).status,200,'a second holder spends the token first');
    const refused=await refresher.refresh('codex',{force:true});
    assert.deepEqual([refused.ok,refused.reason],[false,'invalid_grant']);
    assert.equal(provider.state.live,null,'reuse revokes the sign-in');
  } finally { await backend.destroy(consumer); }
});

test('an owner-job lease renews the shared sign-in without reporting a lending fault',async()=>{
  const outcomes=[];
  const store={async credential(){return {accountKey:'codex',provider:'codex',kind:'oauth',generation:'g',digest:'d',bearer:'synthetic',refresh:'synthetic-r',expiresAt:Date.now()+60e3};}};
  const refresher={async refresh(){return {ok:false,reason:'refresh_unavailable'};}};
  const credential=createLentCodexCredential({store,refresher,onOutcome:code=>outcomes.push(code)});
  await assert.rejects(credential.lease({wallSeconds:600,report:false}),{code:'claude_account_unavailable'});
  assert.deepEqual(outcomes,[],'an owner job outcome is not a lending fault');
  await assert.rejects(credential.lease({wallSeconds:600}),{code:'claude_account_unavailable'});
  assert.deepEqual(outcomes,['claude_account_unavailable'],'a lent job still reports');
});

test('Faravan signs Codex in independently and never copies the host CLI login into its refreshable sign-in',{skip:process.platform==='win32'},async t=>{
  const home=await freshHome(t,'codex-lineage-signin-'),host=await freshHome(t,'codex-lineage-host-');
  const hostLogin=JSON.stringify(codexValue('host-cli-access','host-cli-refresh-token'));
  await mkdir(join(host,'.codex'),{recursive:true,mode:0o700});
  await writeFile(join(host,'.codex','auth.json'),hostLogin,{mode:0o600});
  const binary=join(home,'codex'),seen=join(home,'seen.json');
  // The sign-in CLI records the folders it was given, and writes its own new login there.
  await writeFile(binary,'#!'+process.execPath+'\n'+`
    const fs=require('node:fs'),path=require('node:path');
    fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({home:process.env.HOME,codexHome:process.env.CODEX_HOME}));
    fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),JSON.stringify(${JSON.stringify(codexValue('own-access','own-refresh-token'))}),{mode:0o600});
    console.log('https://auth.openai.com/oauth/authorize');
  `,{mode:0o700});
  const flow=await startProviderGenerationAuth(CODEX_HARNESS,{home,providerBin:binary,method:'browser',
    env:{...process.env,HOME:host,CODEX_HOME:join(host,'.codex')}});
  assert.equal((await flow.waitForCompletion()).status,'complete');
  const given=JSON.parse(await readFile(seen,'utf8'));
  assert.equal(given.codexHome,given.home,'the CLI signs in to one new folder');
  assert.ok(given.codexHome.startsWith(join(home,'provider-sources')+'/'),'a Faravan source folder, never the host CLI folder');
  const credential=await createUsageAccountStore({home}).credential('codex');
  assert.equal(credential.refresh,'own-refresh-token','the refreshable sign-in is the new login');
  for(const file of await filesUnder(home))
    assert.equal((await readFile(file,'utf8')).includes('host-cli-refresh-token'),false,file+' holds no host CLI token');
  assert.equal(await readFile(join(host,'.codex','auth.json'),'utf8'),hostLogin,'the host CLI login is untouched');
});
