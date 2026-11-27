import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createConnection} from 'node:net';
import {mkdtemp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';
import {createGitHubSource,createProviderSource,createDockerProxySource,currentGitHubGeneration,publishGitHubGeneration} from '../lib/credential-generations.mjs';
import {refreshGitHubGeneration} from '../lib/github-auth.mjs';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';
import {buildValidatedJobSpec,resolveHarness} from '../lib/executor.mjs';
import {createSbxPolicy,sbxRunner} from './helpers/sbx-policy-model.mjs';
import {withCredentialPreparation,restrictCredentialScope,spawnCredentialWriter,acquireCredentialMutation} from '../lib/sandbox-credentials.mjs';

test('provider-owned late writes leave publication immutable and a fresh reader publishes changed bytes', {timeout:15000,skip:process.platform!=='linux'}, async t=>{
  const home=await mkdtemp(join(tmpdir(),'provider-generation-'));
  const source={id:randomUUID(),ghBin:'/usr/bin/gh',pathEnv:process.env.PATH};
  const config=join(home,'.gh-task-access-'+source.id);
  await createGitHubSource(home,source);
  const hosts=token=>`github.com:\n    user: synthetic-user\n    oauth_token: ${token}\n    git_protocol: https\n`;
  const marker=join(config,'hosts.yml'),socket=join(home,'writer.sock');
  await writeFile(marker,hosts('synthetic-first'),{mode:0o600});
  const sink=join(home,'sink');
  await writeFile(sink,'#!'+process.execPath+'\nprocess.stdin.resume();process.stdin.on("end",()=>process.exit(0));',{mode:0o700});
  const fixture=fileURLToPath(new URL('./fixtures/credential-writer.mjs',import.meta.url));
  const daemon=spawn(process.execPath,[fixture,'daemon',socket,marker,hosts('synthetic-late')],{stdio:['ignore','ignore','inherit','ipc']});
  t.after(async()=>{if(daemon.exitCode===null){const done=once(daemon,'exit');daemon.kill('SIGKILL');await done;}});
  await once(daemon,'message');
  const release=await acquireCredentialMutation(home,{isolatedSources:true});
  t.after(release);
  const writer=await spawnCredentialWriter(home,process.execPath,[fixture,'writer',socket],{credentialIsolation:{kind:'github-source',id:source.id}});
  const done=once(writer,'exit');
  t.after(async()=>{if(writer.exitCode===null){writer.kill('SIGKILL');await done;}});
  await once(writer.stdout,'data');
  writer.stdin.end();
  assert.equal((await done)[0],0);
  const {stdout}=await promisify(execFile)('/usr/bin/gh',['auth','token','--hostname','github.com'],{env:{PATH:process.env.PATH,HOME:home,GH_CONFIG_DIR:config}});
  const first=await publishGitHubGeneration(home,source,stdout.trim());
  await release();
  const bytes=await readFile(join(first.directory,'value'));
  const client=createConnection(socket);
  client.setTimeout(5000,()=>client.destroy(new Error('commit timeout')));
  client.resume();
  const committed=once(client,'end');client.end('commit\n');await committed;
  assert.deepEqual(await readFile(join(first.directory,'value')),bytes);
  const module=new URL('../lib/github-auth.mjs',import.meta.url).href;
  const refreshed=await promisify(execFile)(process.execPath,['--input-type=module','-e',`
    import {refreshGitHubGeneration} from ${JSON.stringify(module)};
    const result=await refreshGitHubGeneration(${JSON.stringify(home)},{sbxBin:${JSON.stringify(sink)}});
    console.log(result.id);
  `],{timeout:5000});
  const next=await currentGitHubGeneration(home);
  assert.equal(refreshed.stdout.trim(),next.id);
  assert.notEqual(next.id,first.id);
  assert.equal(await readFile(join(next.directory,'value'),'utf8'),'synthetic-late');
  assert.deepEqual(await readFile(join(first.directory,'value')),bytes);
  const kit=await readFile(join(first.kitDirectory,'spec.yaml'),'utf8');
  assert.deepEqual(await readdir(first.kitDirectory),['spec.yaml'],'kit build context never contains the credential value');
  assert.ok(kit.includes('api.github.com: '+next.service));
  assert.ok(!/^    github:/m.test(kit));
  assert.ok(!kit.includes(first.id)&&!kit.includes(next.id),'the kit names no generation');
  const oldHome=process.env.FARAVAN_SBX_HOME,oldRoot=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;
  t.after(()=>{if(oldHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=oldHome;if(oldRoot===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=oldRoot;});
  const policy=createSbxPolicy({globalRules:[]});
  const secrets=[];
  const runner=sbxRunner(policy,(args,options)=>{
    if(args[0]==='secret'&&args[1]==='set')secrets.push({scope:args[args.indexOf('--sandbox')+1],type:'service',name:args[2],value:options?.input});
    return {code:0,stdout:args[0]==='ls'?JSON.stringify(Object.keys(policy.state.sandboxes).map(name=>({name,status:'running'}))):'',stderr:''};
  },{kitAllow:[],secretResult:{code:0,get stdout(){return JSON.stringify({secrets:secrets.map(({value,...row})=>row),custom_secrets:[],shadowed_services:[],env_only_count:0});}}});
  const backend=new DockerSbxBackend({runCommand:runner.run});
  const handle=await backend.prepare(buildValidatedJobSpec({taskDigest:'2'.repeat(64),harness:resolveHarness('gh-cli'),entrypointWithPrompt:'true',network:'disabled'}));
  t.after(()=>backend.destroy(handle));
  const create=runner.calls.find(args=>args[0]==='create');
  assert.equal(create[create.indexOf('--kit')+1],first.kitDirectory,'every generation requests the same kit');
  assert.deepEqual(secrets.map(row=>[row.name,row.scope,row.value]),[[next.service,handle.sandbox_id,'synthetic-late']],'the pinned generation is scoped to this sandbox');
});

test('generated GitHub services are never ignored for a provider job without a GitHub grant',async()=>{
  const generation={service:'faravan-github-'+randomUUID()};
  const run=async args=>({code:0,stdout:args[0]==='secret'?JSON.stringify({secrets:[{scope:'global',type:'service',name:generation.service}],custom_secrets:[],shadowed_services:[],env_only_count:0}):args.at(-1)==='ssh.agentForwardingEnabled'?'false':''});
  // The generation carries a global binding for the GitHub hosts: a restricted job must prove them denied, an open job is probed.
  assert.deepEqual(await restrictCredentialScope(run,{image:'codex',egress:'provider-only'},'synthetic-job',generation),['github']);
  assert.deepEqual(await restrictCredentialScope(run,{image:'codex'},'synthetic-job',generation),['github-binding-guest-probe']);
});

test('an owner native generation refuses a proxy secret, while the proxy spec accepts it',async()=>{
  const run=async args=>({code:0,stdout:args[0]==='secret'?JSON.stringify({secrets:[{scope:'global',type:'service',name:'openai'}],custom_secrets:[],shadowed_services:[],env_only_count:0}):
    args[0]==='settings'&&args[1]==='get'?(args[2]==='ssh.agentForwardingEnabled'?'false':'""'):'',stderr:''});
  await assert.rejects(restrictCredentialScope(run,{image:'codex',execution_scope:'owner',
    auth_strategy:'provider-file-generation'},'synthetic-native-owner',null,{id:'native-generation'}),
  {code:'credential_scope_unenforceable'});
  await restrictCredentialScope(run,{image:'codex',execution_scope:'owner',
    auth_strategy:'docker-native-oauth'},'synthetic-proxy-owner',null,null);
  const empty=async args=>({code:0,stdout:args[0]==='secret'?JSON.stringify({secrets:[],custom_secrets:[],shadowed_services:[],env_only_count:0}):
    args[0]==='settings'&&args[1]==='get'?(args[2]==='ssh.agentForwardingEnabled'?'false':'""'):'',stderr:''});
  await restrictCredentialScope(empty,{image:'codex',execution_scope:'owner',
    auth_strategy:'provider-file-generation'},'synthetic-native-owner-without-proxy-secret',null,{id:'native-generation'});
});

test('arbitrary target-generation writers are still fenced on the generation-aware preparation path',async()=>{
  const home=await mkdtemp(join(tmpdir(),'generation-target-fence-'));
  await mkdir(join(home,'credential-writers'),{mode:0o700});
  await writeFile(join(home,'credential-writers',randomUUID()+'.json'),'{}',{mode:0o600});
  await assert.rejects(withCredentialPreparation(home,async()=>{}, {isolatedSources:true}),{code:'credential_writer_unresolved'});
});

test('Docker proxy and native provider writer receipts do not block each other',async()=>{
  const home=await mkdtemp(join(tmpdir(),'credential-writer-interplay-'));
  await mkdir(join(home,'credential-writers'),{mode:0o700});
  const proxy=await createDockerProxySource(home,'codex','openai');
  await writeFile(join(home,'credential-writers',randomUUID()+'.json'),JSON.stringify({isolation:{kind:'docker-proxy-source',id:proxy.id}}),{mode:0o600});
  const afterProxy=await acquireCredentialMutation(home,{isolatedSources:true,concurrentSources:true});
  await afterProxy();

  const native=await createProviderSource(home,'codex');
  await writeFile(join(home,'credential-writers',randomUUID()+'.json'),JSON.stringify({isolation:{kind:'provider-source',id:native.id}}),{mode:0o600});
  const afterNative=await acquireCredentialMutation(home,{sandboxId:'proxy-login',isolatedSources:true});
  await afterNative();
  await withCredentialPreparation(home,async()=>{}, {isolatedSources:true});
});

test('publication approves only its generated service and preserves existing YAML bindings',async()=>{
  const home=await mkdtemp(join(tmpdir(),'binding-generation-'));
  const source={id:randomUUID(),ghBin:'gh',pathEnv:process.env.PATH};
  await createGitHubSource(home,source);
  await mkdir(join(home,'.config','sbx'),{recursive:true,mode:0o700});
  const file=join(home,'.config','sbx','credentials.yaml');
  await writeFile(file,'# Existing approval\nbindings:\n  unrelated:\n    apiKey:\n      domains: [example.com]\n',{mode:0o600});
  const generation=await publishGitHubGeneration(home,source,'synthetic-token');
  const text=await readFile(file,'utf8'),bindings=parse(text).bindings;
  assert.ok(text.includes('# Existing approval'));
  assert.deepEqual(bindings.unrelated,{apiKey:{domains:['example.com']}});
  assert.deepEqual(bindings[generation.service],{apiKey:{domains:['api.github.com','github.com']}});
  assert.ok(!text.includes('synthetic-token'));
  await writeFile(file,'bindings: [invalid]\n',{mode:0o600});
  await assert.rejects(publishGitHubGeneration(home,source,'synthetic-next'),{code:'credential_writer_unresolved'});
  assert.equal((await currentGitHubGeneration(home)).id,generation.id,'an unreadable binding cannot replace the published generation');
});

test('interrupted import leaves the prior manifest selected and never reuses a destination',async()=>{
  const home=await mkdtemp(join(tmpdir(),'interrupted-generation-'));
  const source={id:randomUUID(),ghBin:'gh',pathEnv:process.env.PATH};
  await createGitHubSource(home,source);
  const first=await publishGitHubGeneration(home,source,'synthetic-first');
  const controller=new AbortController();
  controller.abort();
  await assert.rejects(publishGitHubGeneration(home,source,'synthetic-next',{signal:controller.signal}),{name:'AbortError'});
  assert.equal((await currentGitHubGeneration(home)).id,first.id);
  const next=await publishGitHubGeneration(home,source,'synthetic-next');
  assert.notEqual(next.id,first.id);
  assert.notEqual(next.directory,first.directory);
  assert.equal(next.kitDirectory,first.kitDirectory,'a new generation reuses the kit');
  assert.equal(await readFile(join(first.directory,'value'),'utf8'),'synthetic-first');
});

test('an isolation claim with missing source evidence cannot bypass a writer receipt',async()=>{
  const home=await mkdtemp(join(tmpdir(),'unknown-source-'));
  await mkdir(join(home,'credential-writers'),{mode:0o700});
  await writeFile(join(home,'credential-writers',randomUUID()+'.json'),JSON.stringify({isolation:{kind:'provider-source',id:randomUUID()}}),{mode:0o600});
  await assert.rejects(withCredentialPreparation(home,async()=>{}, {isolatedSources:true}),{code:'credential_writer_unresolved'});
});
