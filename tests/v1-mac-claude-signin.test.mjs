import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startProviderGenerationAuth} from '../lib/provider-generation-auth.mjs';
import {currentProviderGeneration} from '../lib/credential-generations.mjs';
import {CLAUDE_CODE_HARNESS} from '../lib/harnesses.mjs';
import {createSignin} from '../lib/v1/signin.mjs';
import {appFixture,api,syntheticBackend,waitFor} from './helpers/v1-app-fixture.mjs';
import {HARNESS_ADAPTERS} from '../lib/harnesses/index.mjs';

// A Mac lends like a Linux computer: Claude's sign-in is Faravan's own on darwin too. `process.platform` is stubbed;
// the provider CLI is a fake that asks for a pasted code, and a fake `security` command proves no Keychain call is made.
const ACCESS='sk-ant-oat01-'+'m'.repeat(64);
const testOptions={timeout:60000};

// The Mac refusal was a platform check inside the sign-in module. Only a direct read in that file (or the sign-in server) sees 'darwin', so the rest of the
// suite's Linux-only process machinery keeps working while the sign-in runs as it would on a Mac.
function stubDarwin(t){
  const platform=Object.getOwnPropertyDescriptor(process,'platform');
  Object.defineProperty(process,'platform',{configurable:true,get(){
    return /provider-generation-auth\.mjs|v1\/signin\.mjs/.test((new Error().stack??'').split('\n')[2]??'')?'darwin':platform.value;
  }});
  t.after(()=>Object.defineProperty(process,'platform',platform));
}

async function fakeClaude(t){
  const home=await mkdtemp(join(tmpdir(),'mac-claude-'));
  const old={home:process.env.FARAVAN_SBX_HOME,root:process.env.FARAVAN_SCRATCH_ROOT};
  process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;
  t.after(()=>{for(const [k,v] of [['FARAVAN_SBX_HOME',old.home],['FARAVAN_SCRATCH_ROOT',old.root]])if(v===undefined)delete process.env[k];else process.env[k]=v;});
  const bin=join(home,'bin');await mkdir(bin);
  const keychainLog=join(home,'keychain-calls');
  await writeFile(join(bin,'security'),'#!/bin/sh\necho "$@" >> '+JSON.stringify(keychainLog)+'\nexit 44\n',{mode:0o700});
  const provider=join(home,'claude');
  await writeFile(provider,'#!'+process.execPath+'\n'+`
    const fs=require('node:fs'),path=require('node:path');
    if(process.argv.slice(2).join(' ')!=='auth login --claudeai')process.exit(3);
    if(process.env.HOME!==process.env.CLAUDE_CONFIG_DIR)process.exit(2);
    console.log('Opening browser to sign in...');
    console.log('https://claude.com/cai/oauth/authorize?code=true&client_id=synthetic');
    console.log('Paste code here if prompted >');
    let input='';
    process.stdin.on('data',chunk=>{
      input+=chunk;
      if(!input.includes('\\n'))return;
      if(input.trim()!=='ABCD-1234-efgh-5678')process.exit(4);
      fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:${JSON.stringify(ACCESS)},refreshToken:'synthetic-refresh',expiresAt:9999999999999}}),{mode:0o600});
      process.exit(0);
    });
  `,{mode:0o700});
  return {home,provider,env:{...process.env,PATH:bin+':'+process.env.PATH},keychainLog};
}

test('on a Mac, Claude sign-in shows a claude.com link, takes the pasted code and publishes a generation without the Keychain',testOptions,async t=>{
  stubDarwin(t);
  const f=await fakeClaude(t);
  const handle=await startProviderGenerationAuth(CLAUDE_CODE_HARNESS,{home:f.home,providerBin:f.provider,env:f.env});
  assert.equal(new URL(handle.url).hostname,'claude.com','the Mac sign-in link host is accepted');
  assert.equal(handle.status,'awaiting-browser');
  await waitFor(()=>handle.acceptsCode===true,'the CLI is waiting for a pasted code');
  assert.throws(()=>handle.submitCode('not valid!'),/not valid/);
  handle.submitCode('ABCD-1234-efgh-5678');
  assert.equal((await handle.waitForCompletion()).status,'complete');
  const published=await currentProviderGeneration(f.home,'claude');
  const bytes=JSON.parse(await readFile(join(published.directory,'.credentials.json'),'utf8'));
  assert.equal(bytes.claudeAiOauth.accessToken,ACCESS);
  await assert.rejects(access(f.keychainLog),'no Keychain command ran');
});

test('on a Mac, the server sign-in flow for Claude starts, accepts the code and completes',testOptions,async t=>{
  stubDarwin(t);
  const f=await fakeClaude(t);
  let completed=0;
  const signin=createSignin({adapters:async()=>[HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='claude-code-subscription')],backend:()=>({}),
    onComplete:async()=>{completed++;},newId:()=>'flow-mac',
    startProvider:spec=>startProviderGenerationAuth(spec,{home:f.home,providerBin:f.provider,env:f.env})});
  t.after(()=>signin.close());
  await signin.start('claude-code-subscription');
  await waitFor(()=>signin.get('flow-mac').status==='awaiting_browser','the link is shown');
  await waitFor(()=>signin.get('flow-mac').codeEntry===true,'the screen offers the code box');
  assert.equal(new URL(signin.get('flow-mac').url).hostname,'claude.com');
  await signin.post(['signin','flow-mac','code'],{code:'ABCD-1234-efgh-5678'});
  await waitFor(()=>signin.get('flow-mac').status==='complete','the flow completes after the code');
  assert.equal(completed,1);
  await assert.rejects(access(f.keychainLog));
});

test('a Claude agent whose sign-in is Faravan\'s own can be chosen for lending, with no platform refusal',testOptions,async t=>{
  const id='claude-code-subscription';
  const state={signedIn:true};
  const store={async credential(key){
    assert.equal(key,'claude');
    if(!state.signedIn)throw Object.assign(new Error('x'),{code:'usage_credential_unavailable',reason:'not_signed_in'});
    return {accountKey:key,provider:'claude',kind:'oauth',generation:'g',digest:'d',bearer:ACCESS,refresh:'r',expiresAt:Date.now()+8*3600e3};
  }};
  const f=await appFixture(t),backend=syntheticBackend(f.root);
  const {app}=await f.start('owner',{backend,lendingUsageStore:store,
    adapters:[{...HARNESS_ADAPTERS.find(a=>a.spec.harness_id===id),installed:true,signedIn:true,models:['example-model']}],
    lendingSignInProbe:async()=>({signedIn:true}),
    lendingIdentityProbe:async({harnessNames})=>({providers:harnessNames.map(h=>({harness_id:h,installed:true,signedIn:true}))}),
    identityProbe:async({harnessNames})=>({providers:harnessNames.map(h=>({harness_id:h,installed:true,signedIn:true}))})});
  await api(app,'/api/agents/refresh',{method:'POST',body:{agents:[id]}});
  const chosen=await api(app,'/api/agents/'+id+'-lending',{method:'POST',body:{useForLending:true}});
  assert.equal(chosen.find(a=>a.id===id).useForLending,true);
  const row=(await api(app,'/api/agents')).find(a=>a.id===id);
  assert.equal(row.signedIn,true);assert.equal(row.signInState,'Signed in');
  assert.equal(row.lendingSignInTarget,id,"the sign-in button targets Faravan's own sign-in");
});

// The real start path as the desktop launches it: no providerBin, and a minimal environment that holds neither the
// person's own command folder nor anything else. The command is reachable only through the login shell's PATH.
for(const platform of ['linux','darwin'])
test('sign-in from an autostart-like environment finds the claude command through the login shell ('+platform+')',{...testOptions,skip:process.platform==='win32'},async t=>{
  if(platform==='darwin')stubDarwin(t);
  const f=await fakeClaude(t);
  const userBin=join(f.home,'user-bin');await mkdir(userBin);
  const {rename}=await import('node:fs/promises');
  await rename(f.provider,join(userBin,'claude'));
  const marker='__FARAVAN_PATH_8f3a__';
  const shell=join(f.home,'login-shell');
  await writeFile(shell,'#!/bin/sh\necho "startup noise from rc files"\nprintf "%s" "'+marker+userBin+':/usr/bin:/bin'+marker+'"\n',{mode:0o700});
  const handle=await startProviderGenerationAuth(CLAUDE_CODE_HARNESS,{home:f.home,platform,securityBin:join(f.home,'bin','security'),
    env:{PATH:'/usr/bin:/bin',HOME:f.home,SHELL:shell}});
  t.after(()=>handle.cancel());
  assert.equal(new URL(handle.url).hostname,'claude.com');
  assert.equal(handle.status,'awaiting-browser');
});
