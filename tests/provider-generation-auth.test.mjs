import './helpers/no-browser.mjs';
import {testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startProviderGenerationAuth} from '../lib/provider-generation-auth.mjs';
import {currentProviderGeneration,refreshProviderGeneration} from '../lib/credential-generations.mjs';
import {withCredentialPreparation} from '../lib/sandbox-credentials.mjs';
import {CODEX_HARNESS,CODEX_LENDING_HARNESS,CLAUDE_CODE_HARNESS,CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS} from '../lib/harnesses.mjs';
import {probeSignIn,buildValidatedJobSpec} from '../lib/executor.mjs';
import {DockerSbxBackend,admitDockerJob} from '../lib/docker-backend.mjs';
import {createSbxPolicy,sbxRunner} from './helpers/sbx-policy-model.mjs';

for(const [provider,spec,file,value] of [
  ['codex',CODEX_HARNESS,'auth.json',{tokens:{access_token:'synthetic-a',id_token:'synthetic-id',refresh_token:'synthetic-refresh'}}],
  ['claude',CLAUDE_CODE_HARNESS,'.credentials.json',{claudeAiOauth:{accessToken:'synthetic-a',refreshToken:'synthetic-refresh',expiresAt:9999999999999}}],
]) {
  test(provider+' native sign-in publishes copies and permits refresh and another sign-in',{skip:process.platform==='win32'},async t=>{
    const home=await mkdtemp(join(tmpdir(),'native-generation-'));
    const oldHome=process.env.FARAVAN_SBX_HOME,oldRoot=process.env.FARAVAN_SCRATCH_ROOT;
    process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;
    t.after(()=>{if(oldHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=oldHome;if(oldRoot===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=oldRoot;});
    const policy=createSbxPolicy({globalRules:[]});
    const runner=sbxRunner(policy,args=>({code:0,stdout:args[0]==='ls'?JSON.stringify(Object.keys(policy.state.sandboxes).map(name=>({name,status:'running'}))):'',stderr:''}),{kitAllow:[]});
    // Each copy's bytes are read as it runs: a Codex consumer file is removed once it is copied.
    const copied=new Map();
    const runCommand=async(args,options)=>{
      if(args[0]==='cp')copied.set(args[2],await readFile(args[1],'utf8').catch(()=>null));
      return runner.run(args,options);
    };
    const backend=new DockerSbxBackend({home,runCommand,storage:{supported:async()=>true,available:async()=>true,
      reserve:async()=>{},release:async()=>{},verify:async()=>true,recordQualification:async()=>{}}});
    const binary=join(home,provider);
    const url=provider==='codex'?'https://auth.openai.com/oauth/authorize':'https://claude.ai/oauth/authorize';
    await writeFile(binary,'#!'+process.execPath+'\n'+`
      const fs=require('node:fs'),path=require('node:path');
      if(process.env.HOME!==process.env.CODEX_HOME || process.env.HOME!==process.env.CLAUDE_CONFIG_DIR)process.exit(2);
      fs.writeFileSync(path.join(process.env.HOME,${JSON.stringify(file)}),JSON.stringify(${JSON.stringify(value)}),{mode:0o600});
      console.log(${JSON.stringify(url)});
    `,{mode:0o700});
    const first=await startProviderGenerationAuth(spec,{home,providerBin:binary,method:'browser'});
    assert.equal((await first.waitForCompletion()).status,'complete');
    const published=await currentProviderGeneration(home,provider);
    const bytes=await readFile(join(published.directory,file));
    const job=()=>buildValidatedJobSpec({taskDigest:'1'.repeat(64),harness:spec,entrypointWithPrompt:'true',network:'disabled'});
    const borrowed=buildValidatedJobSpec({taskDigest:'2'.repeat(64),harness:spec,executionScope:'borrowed',entrypointWithPrompt:'true',network:'disabled',requiredLimits:['cpu','memory','wall','output','guest_block_device_capacity']});
    borrowed.resources.storage_mib=8192;
    assert.equal(admitDockerJob({...borrowed,auth_strategy:'docker-native-oauth'},{storage:true}).ok,true,
      'the same job with a proxy strategy passes storage admission for both images');
    assert.equal(admitDockerJob(borrowed,{storage:true}).code,'native_credentials_owner_only');
    assert.equal(admitDockerJob({...borrowed,execution_scope:undefined},{storage:true}).code,'native_credentials_owner_only','missing ownership cannot authorize native credentials');
    assert.equal(admitDockerJob({...borrowed,required_limits:['storage']}).code,'native_credentials_owner_only','native refusal is independent of storage');
    const before=runner.calls.length;
    await assert.rejects(backend.prepare(borrowed),{code:'native_credentials_owner_only'});
    const borrowedHandle={...testSbxRuntimeFields(),job_id:borrowed.job_id,_image:borrowed.image,_resources:borrowed.resources,
      _executionScope:'borrowed',_authStrategy:spec.auth_strategy,_egress:borrowed.egress,_providerHosts:borrowed.provider_hosts,_mountless:true};
    await assert.rejects(backend.prepareCheck(borrowedHandle),{code:'native_credentials_owner_only'});
    assert.equal(runner.calls.length,before,'native refusal does not start a sandbox or copy credentials');
    const consumer=await backend.prepare(job());
    assert.deepEqual(consumer._ownerProviderGeneration,{service:provider==='codex'?'openai':'anthropic',directory:'/var/tmp/faravan-auth-'+published.id});
    t.after(()=>backend.destroy(consumer));
    const target=consumer.sandbox_id+':/var/tmp/faravan-auth-'+published.id+'/'+file;
    const copy=runner.calls.find(args=>args[0]==='cp' && args[2]===target);
    if(provider==='codex') {
      // One holder per sign-in: the guest gets the access token, never the refresh token Faravan's refresher holds.
      assert.ok(copy[1].startsWith(join(home,'credential-consumers')+'/'),'a consumer file, not the publication');
      const guest=JSON.parse(copied.get(target));
      assert.deepEqual({...guest.tokens},{...value.tokens,refresh_token:''});
      assert.equal(typeof guest.last_refresh,'string');
      assert.equal(JSON.parse(await readFile(join(published.directory,file),'utf8')).tokens.refresh_token,'synthetic-refresh','the publication keeps it');
      assert.equal(await readFile(copy[1]).then(()=>true,()=>false),false,'the consumer file is removed after the copy');
    } else {
      assert.equal(copy?.[1],join(published.directory,file));
      assert.deepEqual(JSON.parse(copied.get(target)),value);
    }
    assert.ok(!runner.calls.some(args=>args.some(arg=>arg.includes('/provider-sources/'))),'source directory is never exposed to the sandbox');
    assert.deepEqual(await probeSignIn(spec.harness_id,{home,run(){assert.fail('a generation must not probe the old sbx store');}}),
      {signedIn:true,source:'provider-generation'});

    const proxySpec=provider==='codex'?CODEX_LENDING_HARNESS:CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS;
    const lentJob=buildValidatedJobSpec({taskDigest:'3'.repeat(64),harness:proxySpec,executionScope:'borrowed',entrypointWithPrompt:'true',network:'disabled',
      requiredLimits:['cpu','memory','wall','output','guest_block_device_capacity']});
    lentJob.resources.storage_mib=8192;
    assert.equal(admitDockerJob(lentJob,{storage:true}).ok,true);
    const callsBeforeLending=runner.calls.length;
    const lent=await backend.prepare(lentJob);
    t.after(()=>backend.destroy(lent));
    assert.equal(lent._authStrategy,'docker-native-oauth');
    assert.equal(lent._executionScope,'borrowed');
    assert.equal(lent._ownerProviderGeneration,undefined);
    assert.deepEqual(lent._inputs,[],'no provider token is staged as a guest input');
    assert.equal(lent._credentialEnv,undefined,'the guest receives no provider token environment');
    assert.equal(runner.calls.slice(callsBeforeLending).some(args=>args[0]==='cp'&&args[1].includes('/credential-generations/')),false,
      'the borrowed sandbox receives no native generation file');
    const lentCheck=await backend.prepareCheck(lent);
    t.after(()=>backend.destroy(lentCheck));
    assert.equal(lentCheck._credentialEnv,undefined,'the verification sandbox receives no provider token environment');
    assert.equal(runner.calls.slice(callsBeforeLending).some(args=>args[0]==='cp'&&args[1].includes('/credential-generations/')),false,
      'neither borrowed sandbox copies a native generation');

    const signInJob=buildValidatedJobSpec({taskDigest:'4'.repeat(64),harness:proxySpec,entrypointWithPrompt:'true',network:'disabled'});
    assert.equal(signInJob.execution_scope,'owner','the local proxy sign-in sandbox has owner scope');
    const callsBeforeSignIn=runner.calls.length;
    const signInSandbox=await backend.prepare(signInJob);
    t.after(()=>backend.destroy(signInSandbox));
    assert.equal(signInSandbox._authStrategy,'docker-native-oauth');
    assert.equal(signInSandbox._ownerProviderGeneration,undefined);
    assert.deepEqual(signInSandbox._inputs,[],'the proxy sign-in sandbox receives no native provider input');
    assert.equal(signInSandbox._credentialEnv,undefined,'the proxy sign-in sandbox receives no provider token environment');
    assert.equal(runner.calls.slice(callsBeforeSignIn).some(args=>args[0]==='cp'&&args[1].includes('/credential-generations/')),false,
      'an owner-scoped proxy sign-in sandbox does not copy the native generation');
    await withCredentialPreparation(home,async()=>{}, {isolatedSources:true});
    const late=structuredClone(value);
    if(provider==='codex')late.tokens.access_token='synthetic-late';else late.claudeAiOauth.accessToken='synthetic-late';
    await writeFile(join(home,'provider-sources',published.source.id,file),JSON.stringify(late),{mode:0o600});
    assert.equal((await probeSignIn(spec.harness_id,{home})).signedIn,null,'late writes make status stale until refresh');
    const refreshed=await withCredentialPreparation(home,()=>refreshProviderGeneration(home,provider),{isolatedSources:true});
    assert.notEqual(refreshed.id,published.id);
    assert.deepEqual(await readFile(join(published.directory,file)),bytes);
    const nextConsumer=await backend.prepare(job());
    t.after(()=>backend.destroy(nextConsumer));
    assert.ok(nextConsumer._credentialEnv.some(value=>value.endsWith('/faravan-auth-'+refreshed.id)));
    await backend._runJobCommand(consumer,['exec',consumer.sandbox_id,'--','true']);
    const pinned=runner.calls.at(-1);
    assert.ok(pinned.includes((provider==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR')+'=/var/tmp/faravan-auth-'+published.id),'an existing consumer keeps its pinned generation');
    await writeFile(join(home,'provider-sources',published.source.id,file),'{partial',{mode:0o600});
    await assert.rejects(refreshProviderGeneration(home,provider),{code:'credential_writer_unresolved'});
    assert.equal((await currentProviderGeneration(home,provider)).id,refreshed.id);
    const second=await startProviderGenerationAuth(spec,{home,providerBin:binary,method:'browser'});
    assert.equal((await second.waitForCompletion()).status,'complete');
    assert.equal(spec.credential_in_guest,true);
  });
}

test('cancelling native sign-in retains source evidence, publishes nothing and allows retry',async()=>{
  const home=await mkdtemp(join(tmpdir(),'native-cancel-'));
  const binary=join(home,'codex');
  await writeFile(binary,'#!'+process.execPath+'\n'+`
    require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{access_token:'synthetic',id_token:'synthetic',refresh_token:'synthetic'}}),{mode:0o600});
    console.log('https://auth.openai.com/oauth/authorize');
  `,{mode:0o700});
  const cancelled=await startProviderGenerationAuth(CODEX_HARNESS,{home,providerBin:binary,method:'browser'});
  cancelled.cancel();
  assert.equal((await cancelled.waitForCompletion()).status,'failed');
  assert.equal(await currentProviderGeneration(home,'codex'),null);
  const next=await startProviderGenerationAuth(CODEX_HARNESS,{home,providerBin:binary,method:'browser'});
  assert.equal((await next.waitForCompletion()).status,'complete');
});

// The sign-in CLI is a child this process started. Once it has exited and been reaped, its number can name an unrelated
// process, so nothing may signal that number: not a late cancel and not the completion timer.
test('a sign-in that has already ended is never signalled afterwards, by a late cancel or by the completion timer',async t=>{
  const home=await mkdtemp(join(tmpdir(),'native-late-'));
  const binary=join(home,'codex');
  await writeFile(binary,'#!'+process.execPath+'\n'+`
    require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{access_token:'synthetic',id_token:'synthetic',refresh_token:'synthetic'}}),{mode:0o600});
    console.log('https://auth.openai.com/oauth/authorize');
  `,{mode:0o700});
  const signals=[];
  const real=process.kill;
  t.mock.method(process,'kill',(pid,signal)=>{if(signal!==0&&signal!==undefined)signals.push([pid,signal]);return real.call(process,pid,signal);});
  // The completion timer fires after the CLI is gone.
  const handle=await startProviderGenerationAuth(CODEX_HARNESS,{home,providerBin:binary,method:'browser',completionTimeoutMs:400});
  assert.equal((await handle.waitForCompletion()).status,'complete');
  const atEnd=signals.length;
  await new Promise(resolve=>setTimeout(resolve,700));
  handle.cancel();
  assert.deepEqual(signals.slice(atEnd),[],'no signal reaches the number of a process that has ended');
});

test('sign-in finds the provider command through the login shell PATH when the app PATH lacks it, and the child gets that PATH',{skip:process.platform==='win32'},async t=>{
  const home=await mkdtemp(join(tmpdir(),'native-cli-path-'));
  const oldHome=process.env.FARAVAN_SBX_HOME,oldRoot=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;
  t.after(()=>{if(oldHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=oldHome;if(oldRoot===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=oldRoot;});
  const {mkdir}=await import('node:fs/promises');
  const userBin=join(home,'user-bin');await mkdir(userBin);
  const loginPath=userBin+':/usr/bin:/bin';
  const marker='__FARAVAN_PATH_8f3a__';
  const shell=join(home,'login-shell');
  await writeFile(shell,'#!/bin/sh\necho rc noise\nprintf "%s" "'+marker+loginPath+marker+'"\n',{mode:0o700});
  await writeFile(join(userBin,'codex'),'#!'+process.execPath+'\n'+`
    // The no-browser shim folder is always put in front of the PATH; the rest must be the login shell PATH.
    if(!process.env.PATH.endsWith(':'+${JSON.stringify(loginPath)}))process.exit(2);
    console.log('https://auth.openai.com/oauth/authorize');
    setTimeout(()=>{},60000);
  `,{mode:0o700});
  const handle=await startProviderGenerationAuth(CODEX_HARNESS,{home,method:'browser',env:{PATH:'/usr/bin:/bin',SHELL:shell,HOME:home}});
  t.after(()=>handle.cancel());
  assert.equal(handle.url,'https://auth.openai.com/oauth/authorize');
  assert.equal(handle.status,'awaiting-browser');
});
