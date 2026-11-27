import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdirSync,readFileSync,rmSync} from 'node:fs';
import {chmod,cp,mkdir,mkdtemp,readFile,readdir,rename,symlink,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {DockerSbxBackend,_internal} from '../lib/docker-backend.mjs';
import {getHarnessAdapter} from '../lib/harnesses/index.mjs';
import {buildValidatedJobSpec,resolveHarness} from '../lib/executor.mjs';
import {startGitHubAuthFlow} from '../lib/github-auth.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import {writeCreateReceipt} from './helpers/sandbox-receipt-fixture.mjs';
import {restrictCredentialScope} from '../lib/sandbox-credentials.mjs';
import {createSbxPolicy} from './helpers/sbx-policy-model.mjs';

// sbx assembles one template image per (agent, kit) and keeps it. The image is large (1.5-2.1 GB) and sbx
// cannot remove it by tag. So the kit a GitHub job requests must be the same for every credential change.
const files=directory=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
  const path=join(entry.parentPath??entry.path,entry.name);
  return entry.isDirectory()?files(path):[path];
});
const kitIdentity=directory=>{
  const hash=createHash('sha256').update(directory+'\0');
  for(const file of files(directory).sort())hash.update(relative(directory,file)+'\0').update(readFileSync(file)).update('\0');
  return hash.digest('hex');
};
const GLOBAL=['global','(global)'];
const LEGACY=/^faravan-github-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function lenderFixture(t) {
  const home=await mkdtemp(join(tmpdir(),'stable-kit-'));
  const tokenFile=join(home,'synthetic-gh-token');
  const bin=await mkdtemp(join(tmpdir(),'stable-kit-bin-'));
  const gh=join(bin,'gh'),sbx=join(bin,'sbx'),outbox=join(bin,'outbox');
  await mkdir(outbox);
  // gh as the sign-in flow and the refresh read it: login prints a device code, token prints the current account token.
  await writeFile(gh,`#!/bin/sh\nif [ "$2" = login ]; then echo 'one-time code: TEST-1234'; echo 'https://github.com/login/device'; exit 0; fi\ncat '${tokenFile}'\n`);
  await chmod(gh,0o700);
  // Any sbx process started outside the backend's command runner (a credential writer) lands in the outbox, and the
  // fake store below applies it, so a global write is visible to later listings as it is in sbx.
  await writeFile(sbx,`#!/bin/sh\nn="$$-$(date +%s%N)"\nprintf '%s\\n' "$@" > '${outbox}'/"$n.argv.tmp"\ncat > '${outbox}'/"$n.stdin"\nmv '${outbox}'/"$n.argv.tmp" '${outbox}'/"$n.argv"\n`);
  await chmod(sbx,0o700);
  const saved=Object.fromEntries(['FARAVAN_SBX_HOME','FARAVAN_SCRATCH_ROOT','FARAVAN_SBX_BIN'].map(name=>[name,process.env[name]]));
  process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;process.env.FARAVAN_SBX_BIN=sbx;
  t.after(()=>{for(const [name,value] of Object.entries(saved))if(value===undefined)delete process.env[name];else process.env[name]=value;});
  const tokens=[];
  const signIn=async token=>{tokens.push(token);await writeFile(tokenFile,token);};

  // Fake sbx: template assembly by kit identity, the secret store with global and sandbox scopes, and the proxy:
  // a sandbox gets the value scoped to it for the service its kit names, otherwise that service's global value.
  const policy=createSbxPolicy({kitManaged:true});
  const state={secrets:[],templates:new Map(),runs:[],sandboxes:new Set(),kitLeaks:[],outOfBand:[],
    faults:{rm:0,legacyRm:false,hideSet:false,globalForm:null}};
  const option=(args,name)=>args.includes(name)?args[args.indexOf(name)+1]:null;
  const setSecret=(name,scope,value,hidden=false)=>{
    state.secrets=state.secrets.filter(row=>!(row.name===name&&row.scope===scope));
    state.secrets.push({type:'service',name,scope,value,hidden});
  };
  const drainOutbox=()=>{
    for(const name of readdirSync(outbox).filter(name=>name.endsWith('.argv')).sort()) {
      const args=readFileSync(join(outbox,name),'utf8').split('\n').slice(0,-1);
      const value=readFileSync(join(outbox,name.replace(/\.argv$/,'.stdin')),'utf8');
      rmSync(join(outbox,name));rmSync(join(outbox,name.replace(/\.argv$/,'.stdin')));
      state.outOfBand.push(args.join(' '));
      if(args[0]==='secret'&&args[1]==='set')setSecret(args[2],option(args,'--sandbox')??'global',value);
    }
  };
  const listing=()=>({secrets:state.secrets.filter(row=>!row.hidden).map(({value,hidden,...row})=>
    ({...row,...(row.scope==='global'&&state.faults.globalForm?{scope:state.faults.globalForm}:{})})),
    custom_secrets:[],shadowed_services:[],env_only_count:0});
  const ok=(stdout='')=>({code:0,stdout,stderr:''});
  const runCommand=async(args,options={})=>{
    drainOutbox();
    if(args[0]==='secret'&&args[1]==='ls')return ok(JSON.stringify(listing()));
    if(args[0]==='secret'&&args[1]==='set') {
      if(typeof options.input!=='string'||args.some(arg=>tokens.includes(arg)))return {code:1,stdout:'',stderr:'value must arrive on stdin'};
      setSecret(args[2],option(args,'--sandbox')??'global',options.input,state.faults.hideSet);
      return ok();
    }
    if(args[0]==='secret'&&args[1]==='rm') {
      const scope=option(args,'--sandbox')??'global';
      if(scope==='global'&&state.faults.legacyRm)return {code:1,stdout:'',stderr:'synthetic store failure'};
      if(state.faults.rm>0){state.faults.rm--;return {code:1,stdout:'',stderr:'synthetic store failure'};}
      const before=state.secrets.length;
      state.secrets=state.secrets.filter(row=>!(row.name===args[2]&&row.scope===scope));
      return before===state.secrets.length?{code:1,stdout:'',stderr:'secret not found'}:ok();
    }
    if(args[0]==='settings')return ok(args[1]==='get'&&args[2]==='ssh.agentForwardingEnabled'?'false':'');
    if(['create','run'].includes(args[0])) {
      const name=option(args,'--name'),kit=option(args,'--kit');
      let injected=[],competing=[];
      if(kit) {
        const identity=kitIdentity(kit);
        for(const file of files(kit))for(const token of tokens)if(readFileSync(file,'utf8').includes(token))state.kitLeaks.push(file);
        if(!state.templates.has(state.agent))state.templates.set(state.agent,new Set());
        state.templates.get(state.agent).add(identity);
        const service=/faravan-github(?:-[0-9a-f-]{36})?/.exec(readFileSync(join(kit,'spec.yaml'),'utf8'))[0];
        const value=state.secrets.find(row=>row.name===service&&row.scope===name)??state.secrets.find(row=>row.name===service&&GLOBAL.includes(row.scope));
        injected=value?[value.value]:[];
        // Another global GitHub generation also binds github.com: which one sbx injects is not specified.
        competing=state.secrets.filter(row=>row.name!==service&&LEGACY.test(row.name)&&GLOBAL.includes(row.scope)).map(row=>row.name);
      }
      state.runs.push({sandbox:name,agent:state.agent,kit,injected,competing,
        scoped:state.secrets.filter(row=>row.scope===name).map(row=>({name:row.name,value:row.value}))});
      state.sandboxes.add(name);policy.createSandbox(name);
      return ok();
    }
    if(args[0]==='rm'){state.sandboxes.delete(args.at(-1));return ok();}
    if(args[0]==='ls')return ok(JSON.stringify([...state.sandboxes].map(name=>({name,status:'running'}))));
    if(args[0]==='policy')return policy.run(args)??ok();
    return ok();
  };
  const backend=new DockerSbxBackend({runCommand,home,hostDisk:{free:async()=>({free:20*1024**3})}});
  backend.probeCapabilities=async()=>({available:true});
  // The lender signs in to GitHub once before lending, through the product's own sign-in flow.
  await signIn('synthetic-gh-token-0');
  const flow=await startGitHubAuthFlow({ghBin:gh,faravanHome:home});
  assert.equal((await flow.waitForCompletion()).status,'complete');
  drainOutbox();
  return {home,state,backend,signIn,tokens,drainOutbox};
}

const AGENTS={claude:'claude-code-subscription',codex:'codex'};
const jobFor=(agent,n)=>agent==='wf-gh-cli'
  ? buildValidatedJobSpec({taskDigest:createHash('sha256').update(agent+n).digest('hex'),harness:resolveHarness('gh-cli'),entrypointWithPrompt:'true',network:'disabled'})
  : buildValidatedJobSpec({taskDigest:createHash('sha256').update(agent+n).digest('hex'),harness:getHarnessAdapter(AGENTS[agent]).lendingSpec,
    entrypointWithPrompt:'synthetic-task',executionScope:'borrowed',network:'disabled',githubAccessRequired:true});

test('GitHub jobs across credential changes reuse one assembled image per agent and no kit holds a secret',async t=>{
  const {state,backend,signIn,tokens,drainOutbox}=await lenderFixture(t);
  const changes=3,jobsPerAgent=2;
  let n=0;
  const carried=[];
  for(let change=1;change<=changes;change++) {
    for(const agent of ['claude','codex','wf-gh-cli'])for(let j=0;j<jobsPerAgent;j++) {
      state.agent=agent;
      const handle=await backend.prepare(jobFor(agent,n++));
      carried.push({expected:tokens.at(-1),run:state.runs.at(-1)});
      await backend.destroy(handle);
    }
    await signIn('synthetic-gh-token-'+change);
  }
  assert.equal(state.runs.length,changes*3*jobsPerAgent);
  for(const agent of ['claude','codex','wf-gh-cli'])
    assert.equal(state.templates.get(agent)?.size,1,agent+': one kit identity across '+changes+' credential changes');
  for(const {expected,run} of carried) {
    assert.deepEqual(run.injected,[expected],'each sandbox gets the GitHub generation current at its start');
    assert.deepEqual(run.scoped,[{name:'faravan-github',value:expected}],'that value is scoped to the sandbox, not global');
  }
  assert.deepEqual(state.kitLeaks,[],'no kit file holds a credential');
  drainOutbox();
  assert.deepEqual(state.outOfBand,[],'no sbx secret is written outside a job');
  assert.deepEqual(state.secrets,[],'every sandbox-scoped value is removed with its sandbox');
});

test('two concurrent jobs on different GitHub generations each get only their own value',async t=>{
  const {state,backend,signIn}=await lenderFixture(t);
  state.agent='claude';
  const first=await backend.prepare(jobFor('claude','concurrent-a'));
  await signIn('synthetic-gh-token-next');
  state.agent='codex';
  const second=await backend.prepare(jobFor('codex','concurrent-b'));
  const value=sandbox=>state.secrets.filter(row=>row.scope===sandbox).map(row=>row.value);
  assert.deepEqual(value(first.sandbox_id),['synthetic-gh-token-0']);
  assert.deepEqual(value(second.sandbox_id),['synthetic-gh-token-next']);
  assert.ok(!state.secrets.some(row=>GLOBAL.includes(row.scope)),'no value is global');
  await backend.destroy(first);
  assert.deepEqual(value(second.sandbox_id),['synthetic-gh-token-next'],'removing one job leaves the other');
  await backend.destroy(second);
  assert.deepEqual(state.secrets,[]);
});

const nonGitHubJob=n=>buildValidatedJobSpec({taskDigest:createHash('sha256').update('plain'+n).digest('hex'),
  harness:getHarnessAdapter('claude-code-subscription').lendingSpec,entrypointWithPrompt:'synthetic-task',executionScope:'borrowed',network:'disabled'});

for(const form of ['global','(global)'])test(`a global value under the kit service, listed as ${form}, refuses every job`,async t=>{
  const {state,backend}=await lenderFixture(t);
  state.faults.globalForm=form;
  state.secrets.push({type:'service',name:'faravan-github',scope:'global',value:'synthetic-global'});
  for(const job of [jobFor('claude','global-a'),nonGitHubJob('global-b')]) {
    state.agent='claude';
    await assert.rejects(backend.prepare(job),error=>error.code==='credential_scope_unenforceable'&&error.condition==='github_service_global');
  }
  assert.equal(state.runs.length,0,'no sandbox started');
});

test('a value left scoped to a sandbox refuses a job without a GitHub grant',async t=>{
  // Sandbox names are fresh for every create, so the listing is checked directly against a planted name.
  const name='wf-'+'0'.repeat(16);
  const run=async args=>({code:0,stderr:'',stdout:JSON.stringify({secrets:[{type:'service',name:'faravan-github',scope:name}],custom_secrets:[],shadowed_services:[],env_only_count:0})});
  await assert.rejects(restrictCredentialScope(run,nonGitHubJob('leftover'),name),error=>error.code==='credential_scope_unenforceable'&&error.condition!=='listing_shape_unsupported');
});

test('a scoped write that sbx accepts but does not list refuses and leaves no value',async t=>{
  const {state,backend}=await lenderFixture(t);
  state.faults.hideSet=true;state.agent='claude';
  await assert.rejects(backend.prepare(jobFor('claude','hidden')),error=>error.condition==='sandbox_secret_unverified');
  assert.equal(state.runs.length,0,'no sandbox started');
  // The raw store, including the row the listing never showed: removal must not depend on seeing the row first.
  assert.deepEqual(state.secrets,[],'the unlisted value is removed');
});

test('a scoped value whose removal fails stays a durable obligation until recovery removes it',async t=>{
  const {state,backend}=await lenderFixture(t);
  state.agent='codex';
  const handle=await backend.prepare(jobFor('codex','retry'));
  state.faults.rm=1;
  const receipt=await backend.destroy(handle);
  assert.equal(receipt.removed,true);
  assert.equal(receipt.policy_removed,false,'the value is still there, so cleanup is not complete');
  assert.equal(state.secrets.length,1);
  assert.equal((await backend.cleanupStatus()).policy_cleanup_pending,1);
  // A later pass, as after a restart, finds the durable record and removes the value.
  await backend.reapCleanup();
  assert.deepEqual(state.secrets,[]);
  assert.equal((await backend.cleanupStatus()).policy_cleanup_pending,0);
});

test('the sbx runner delivers a secret on stdin, never in argv',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'stable-kit-runner-'));
  const sbx=join(dir,'sbx'),record=join(dir,'record');
  await writeFile(sbx,`#!/bin/sh\nprintf '%s\\n' "$*" > '${record}.argv'\ncat > '${record}.stdin'\n`);await chmod(sbx,0o700);
  const previous=process.env.FARAVAN_SBX_BIN;process.env.FARAVAN_SBX_BIN=sbx;
  t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_SBX_BIN;else process.env.FARAVAN_SBX_BIN=previous;});
  const result=await new DockerSbxBackend().runSbx(['secret','set','faravan-github','--sandbox','wf-0123456789abcdef','--force'],{input:'synthetic-stdin-token'});
  assert.equal(result.code,0);
  assert.equal(await readFile(record+'.stdin','utf8'),'synthetic-stdin-token');
  assert.ok(!(await readFile(record+'.argv','utf8')).includes('synthetic-stdin-token'));
});

const TAMPER={
  'holds an extra file':async kit=>writeFile(join(kit,'extra'),'synthetic'),
  'has a modified spec':async kit=>writeFile(join(kit,'spec.yaml'),'synthetic: changed\n',{mode:0o600}),
  'is a symlink to a valid copy':async kit=>{await cp(kit,kit+'-copy',{recursive:true});await rename(kit,kit+'-moved');await symlink(kit+'-copy',kit);},
  'is readable by others':async kit=>chmod(kit,0o755),
};
for(const [name,tamper] of Object.entries(TAMPER))test(`a GitHub kit directory that ${name} refuses GitHub jobs`,async t=>{
  const {home,state,backend}=await lenderFixture(t);
  const [kit]=readdirSync(home).filter(name=>/^github-kit-[0-9a-f]{16}$/.test(name));
  assert.ok(kit,'publication wrote one content-addressed kit');
  await tamper(join(home,kit));
  state.agent='claude';
  await assert.rejects(backend.prepare(jobFor('claude','tampered')),error=>error.code==='credential_writer_unresolved');
  assert.equal(state.runs.length,0);
});

test('a kit write interrupted before its rename leaves nothing that a later publication keeps',async t=>{
  const {home,state,backend}=await lenderFixture(t);
  const [kit]=readdirSync(home).filter(name=>/^github-kit-[0-9a-f]{16}$/.test(name));
  assert.ok(kit,'publication wrote one content-addressed kit');
  rmSync(join(home,kit),{recursive:true});
  await mkdir(join(home,'.github-kit-interrupted'),{mode:0o700});
  await writeFile(join(home,'.github-kit-interrupted','spec.yaml'),'partial');
  state.agent='claude';
  await backend.destroy(await backend.prepare(jobFor('claude','after-crash')));
  assert.deepEqual((await readdir(home)).filter(name=>name.includes('github-kit')),[kit],'only the complete kit remains');
});

test('the kit is not written into a home that others can read',async t=>{
  const {home,state,backend}=await lenderFixture(t);
  const [kit]=readdirSync(home).filter(name=>/^github-kit-[0-9a-f]{16}$/.test(name));
  assert.ok(kit,'publication wrote one content-addressed kit');
  rmSync(join(home,kit),{recursive:true});
  await chmod(home,0o755);
  t.after(()=>chmod(home,0o700));
  state.agent='claude';
  await assert.rejects(backend.prepare(jobFor('claude','loose-home')),error=>error.code==='credential_writer_unresolved');
  assert.deepEqual((await readdir(home)).filter(name=>name.includes('github-kit')),[],'nothing was written');
});

test('a GitHub secret from an earlier release is removed before a GitHub job runs',async t=>{
  const {state,backend}=await lenderFixture(t);
  const legacy='faravan-github-00000000-0000-4000-8000-000000000000';
  // Earlier releases kept each generation as a global secret bound to github.com. One plus a scoped value would give
  // sbx two values for the same hosts.
  state.secrets.push({type:'service',name:legacy,scope:'global',value:'synthetic-legacy'});
  state.agent='codex';
  await backend.destroy(await backend.prepare(jobFor('codex','legacy')));
  assert.deepEqual(state.runs.at(-1).competing,[],'no other GitHub value was bound when the sandbox started');
  assert.deepEqual(state.runs.at(-1).injected,['synthetic-gh-token-0']);
  assert.deepEqual(state.secrets,[]);
});

test('a GitHub job refuses while an earlier release secret cannot be removed',async t=>{
  const {state,backend}=await lenderFixture(t);
  state.secrets.push({type:'service',name:'faravan-github-00000000-0000-4000-8000-000000000000',scope:'global',value:'synthetic-legacy'});
  state.faults.legacyRm=true;state.agent='codex';
  await assert.rejects(backend.prepare(jobFor('codex','legacy-stuck')),error=>error.code==='credential_scope_unenforceable'&&error.condition==='legacy_github_secret_global');
  assert.equal(state.runs.length,0,'no sandbox started');
  assert.deepEqual(state.secrets.map(row=>row.scope),['global'],'no scoped value is left behind');
});

test('restart recovery removes a GitHub value scoped to a crashed attempt',async t=>{
  const {home,state,backend}=await lenderFixture(t);
  const jobId='crashed-job',name='wf-'+'3c'.repeat(8);
  // A crash after the cleanup record and the scoped value reached disk: no live handle remains, only the record.
  const directory=join(home,'v1','sandbox-cleanup');
  const id=await writeCreateReceipt(directory,{jobId,name,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot()});
  const file=join(directory,id+'.json');
  await writeFile(file,JSON.stringify({...JSON.parse(await readFile(file,'utf8')),scoped_github_secret:true}));
  state.secrets.push({type:'service',name:'faravan-github',scope:name,value:'synthetic-gh-token-0'});
  state.sandboxes.add(name);
  const receipt=await backend.reconcilePending({owner_scope:sandboxOwnerScope(),sbx_home:_internal.sbxHome(),attemptId:'attempt-1',jobId,attempt:{attempt_id:'attempt-1'}});
  assert.equal(receipt.removed,true);
  assert.deepEqual(state.secrets.filter(row=>row.scope===name),[]);
});
