import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';
import {getHarnessAdapter} from '../lib/harnesses/index.mjs';
import {buildValidatedJobSpec} from '../lib/executor.mjs';
import * as credentials from '../lib/sandbox-credentials.mjs';

const {restrictCredentialScope}=credentials;
const GITHUB_BINDING_GUEST_PROBE='github-binding-guest-probe';
import {createSbxPolicy} from './helpers/sbx-policy-model.mjs';

// A tester's store on 2026-10-30: Claude and Codex both signed in for lending, plus a global GitHub sign-in.
const LIVE_STORE=['anthropic','openai','github'];
const listing=(names,scope='global')=>({secrets:names.map(name=>({type:'service',scope,name})),custom_secrets:[],shadowed_services:[],env_only_count:0});
const runner=value=>async args=>({code:0,stdout:args[0]==='secret'?JSON.stringify(value):args[1]==='get'&&args[2]==='ssh.agentForwardingEnabled'?'false':'',stderr:''});

function fixture({services=LIVE_STORE,reachable=null,guestPresents=null,agent='claude-code-subscription',network='disabled',githubProbe=null,githubAccessRequired=false}={}) {
  const calls=[],policy=createSbxPolicy({kitManaged:true});let active=null;
  const runCommand=async args=>{
    calls.push([...args]);
    const ok=stdout=>({code:0,stdout:stdout??'',stderr:''});
    if(args[0]==='secret')return ok(JSON.stringify(listing(services)));
    if(args[0]==='settings')return ok(args[1]==='get'&&args[2]==='ssh.agentForwardingEnabled'?'false':'');
    if(['create','run'].includes(args[0])){active=args[args.indexOf('--name')+1];policy.createSandbox(active);return ok();}
    if(args[0]==='policy')return args[1]==='check'&&args.at(-1)===reachable?ok(JSON.stringify({allowed:true})):policy.run(args);
    if(args[0]==='exec'&&args.at(-1).includes('api.github.com/rate_limit'))return githubProbe??ok('');
    if(args[0]==='exec'&&/SBX_CRED_[A-Z]+_MODE/.test(args.at(-1)))return {code:guestPresents&&args.at(-1).includes(guestPresents)?1:0,stdout:'',stderr:''};
    if(args[0]==='rm'){active=null;return ok();}
    if(args[0]==='ls')return ok(JSON.stringify(active?[{name:active,status:'running'}]:[]));
    return ok();
  };
  const backend=new DockerSbxBackend({runCommand,hostDisk:{free:async()=>({free:20*1024**3})}});
  backend.probeCapabilities=async()=>({available:true});
  const job=buildValidatedJobSpec({taskDigest:'a'.repeat(64),harness:getHarnessAdapter(agent).lendingSpec,
    entrypointWithPrompt:'synthetic-task',executionScope:'borrowed',network,...(githubAccessRequired?{githubAccessRequired:true}:{})});
  return {backend,calls,job};
}

test('a lent Claude job starts while Codex and GitHub are also signed in',async()=>{
  const {backend,job,calls}=fixture();
  const handle=await backend.prepare(job);
  try{
    const checked=calls.filter(a=>a[0]==='policy'&&a[1]==='check').map(a=>a.at(-1));
    for(const host of ['api.openai.com','chatgpt.com','github.com','api.github.com'])assert.ok(checked.includes(host),host+' proven denied');
  }finally{await backend.destroy(handle);}
});

for(const host of ['chatgpt.com','api.github.com'])test('a job that can reach '+host+' refuses the other sign-in',async()=>{
  const {backend,job,calls}=fixture({reachable:host});
  await assert.rejects(backend.prepare(job),error=>error.code==='credential_scope_unenforceable');
  assert.ok(!calls.some(a=>a[0]==='exec'&&a.at(-1)==='synthetic-task'),'the task never ran');
});

test('a guest that presents the OpenAI sign-in refuses',async()=>{
  const {backend,job,calls}=fixture({guestPresents:'SBX_CRED_OPENAI_MODE'});
  await assert.rejects(backend.prepare(job),error=>error.code==='credential_scope_unenforceable');
  assert.ok(!calls.some(a=>a[0]==='exec'&&a.at(-1)==='synthetic-task'),'the task never ran');
});

test('an internet job tolerates another agent sign-in but not GitHub',async()=>{
  const claude={image:'claude',egress:'provider-only'};
  assert.deepEqual((await restrictCredentialScope(runner(listing(LIVE_STORE)),claude,'sb-1')).sort(),['github','openai']);
  assert.deepEqual(await restrictCredentialScope(runner(listing(['anthropic','openai'])),{...claude,egress:'internet'},'sb-1'),['openai']);
  await assert.rejects(restrictCredentialScope(runner(listing(['github'])),{...claude,egress:'internet'},'sb-1'),
    error=>error.condition==='unrelated_service_credential');
  await assert.rejects(restrictCredentialScope(runner(listing(['github'])),{image:'claude'},'sb-1'),
    error=>error.condition==='unrelated_service_credential');
});

// Friend jobs default to internet egress (2026-10-30: a Codex job was refused at run while Claude was signed in).
test('an internet Codex job denies the Anthropic hosts and proves them denied',async()=>{
  const {backend,job,calls}=fixture({agent:'codex',network:'enabled',services:['openai','anthropic']});
  assert.equal(job.egress,'internet');
  const handle=await backend.prepare(job);
  try{
    const denies=calls.filter(a=>a[0]==='policy'&&a[1]==='deny').flatMap(a=>a.at(-1).split(','));
    for(const rule of ['anthropic.com','**.anthropic.com','claude.ai','**.claude.ai'])assert.ok(denies.includes(rule),rule+' denied');
    assert.ok(!denies.some(rule=>/openai|chatgpt/.test(rule)),'own provider stays reachable');
    const checked=calls.filter(a=>a[0]==='policy'&&a[1]==='check').map(a=>a.at(-1));
    for(const host of ['api.anthropic.com','claude.ai','platform.claude.com'])assert.ok(checked.includes(host),host+' proven denied');
  }finally{await backend.destroy(handle);}
});

test('an internet job that still reaches Anthropic refuses',async()=>{
  const {backend,job,calls}=fixture({agent:'codex',network:'enabled',services:['openai','anthropic'],reachable:'api.anthropic.com'});
  await assert.rejects(backend.prepare(job),error=>error.code==='credential_scope_unenforceable');
  assert.ok(!calls.some(a=>a[0]==='exec'&&a.at(-1)==='synthetic-task'),'the task never ran');
});

test('a sandbox-scoped or unknown service still refuses',async()=>{
  const claude={image:'claude',egress:'provider-only'};
  await assert.rejects(restrictCredentialScope(runner(listing(['openai'],'sb-1')),claude,'sb-1'),
    error=>error.condition==='unrelated_service_credential');
  await assert.rejects(restrictCredentialScope(runner(listing(['google'])),claude,'sb-1'),
    error=>error.condition==='unrelated_service_credential');
});

// Docker withholds a sign-in from a pinned custom kit without a binding (401 live, 2026-10-30); the built-in agent gets it.
test('a lent Codex job runs on the built-in agent while Claude is also signed in',async()=>{
  const {backend,job,calls}=fixture({agent:'codex'});
  const handle=await backend.prepare(job);
  try{
    const create=calls.find(a=>['create','run'].includes(a[0]));
    assert.ok(create.some(arg=>/^docker\.io\/sbx\/codex@sha256:[0-9a-f]{64}$/.test(arg))&&!create.some(arg=>arg.includes('sbx-kit-codex')),'pinned built-in codex kit');
    const checked=calls.filter(a=>a[0]==='policy'&&a[1]==='check').map(a=>a.at(-1));
    for(const host of ['api.anthropic.com','claude.ai','github.com'])assert.ok(checked.includes(host),host+' proven denied');
  }finally{await backend.destroy(handle);}
});

for(const [name,options] of [['can reach Anthropic',{reachable:'api.anthropic.com'}],['presents the Anthropic sign-in',{guestPresents:'SBX_CRED_ANTHROPIC_MODE'}]])
  test('a Codex job that '+name+' refuses',async()=>{
    const {backend,job,calls}=fixture({agent:'codex',...options});
    await assert.rejects(backend.prepare(job),error=>error.code==='credential_scope_unenforceable');
    assert.ok(!calls.some(a=>a[0]==='exec'&&a.at(-1)==='synthetic-task'),'the task never ran');
  });

// A generated faravan-github-* secret has a global binding for github.com and api.github.com (credential-generations.mjs).
// Only a job granted GitHub may be able to use it.
const GEN_OLD='faravan-github-11111111-2222-4333-8444-555555555555';
const GEN_NEW='faravan-github-66666666-7777-4888-8999-aaaaaaaaaaaa';
test('a job without GitHub never tolerates a generated GitHub secret unless its GitHub hosts are proven denied',async()=>{
  const claude={image:'claude',github_access_required:false};
  const store=runner(listing(['anthropic',GEN_OLD]));
  assert.deepEqual(await restrictCredentialScope(store,{...claude,egress:'provider-only'},'sb-1'),['github']);
  // An open job cannot have GitHub denied; the backend probes from the guest instead.
  assert.deepEqual(await restrictCredentialScope(store,{...claude,egress:'internet'},'sb-1'),[GITHUB_BINDING_GUEST_PROBE]);
  assert.deepEqual(await restrictCredentialScope(runner(listing(['anthropic',GEN_OLD,GEN_NEW])),{...claude,egress:'internet'},'sb-1'),[GITHUB_BINDING_GUEST_PROBE]);
  assert.deepEqual(await restrictCredentialScope(runner(listing(['anthropic'])),{...claude,egress:'internet'},'sb-1'),[]);
});

test('a restricted job proves the GitHub hosts denied when a generated GitHub secret exists',async()=>{
  const {backend,job,calls}=fixture({services:['anthropic',GEN_OLD]});
  const handle=await backend.prepare(job);
  try{
    const checked=calls.filter(a=>a[0]==='policy'&&a[1]==='check').map(a=>a.at(-1));
    for(const host of ['github.com','api.github.com'])assert.ok(checked.includes(host),host+' proven denied');
  }finally{await backend.destroy(handle);}
});

test('a restricted job that can reach api.github.com refuses a generated GitHub secret',async()=>{
  const {backend,job,calls}=fixture({services:['anthropic',GEN_OLD],reachable:'api.github.com'});
  await assert.rejects(backend.prepare(job),error=>error.code==='credential_scope_unenforceable');
  assert.ok(!calls.some(a=>a[0]==='exec'&&a.at(-1)==='synthetic-task'),'the task never ran');
});

const probeCalls=calls=>calls.filter(a=>a[0]==='exec'&&a.at(-1).includes('api.github.com/rate_limit'));
const ran=calls=>calls.some(a=>a[0]==='exec'&&a.at(-1)==='synthetic-task');
const rateLimit=limit=>({code:0,stdout:JSON.stringify({resources:{core:{limit}},rate:{limit}}),stderr:''});
for(const [name,githubProbe] of [['an authenticated rate limit',rateLimit(5000)],
  ['a rejected credential',{code:0,stdout:JSON.stringify({message:'Bad credentials'}),stderr:''}],
  ['a core limit other than 60 beside an unauthenticated rate limit',{code:0,stdout:JSON.stringify({resources:{core:{limit:5000}},rate:{limit:60}}),stderr:''}]])
  test('an internet job without GitHub refuses when the guest request shows '+name,async()=>{
    const {backend,job,calls}=fixture({services:['anthropic',GEN_OLD],network:'enabled',githubProbe});
    assert.equal(job.egress,'internet');
    await assert.rejects(backend.prepare(job),error=>error.code==='credential_scope_unenforceable'&&error.condition==='github_binding_reached_guest');
    assert.equal(probeCalls(calls).length,1);
    assert.ok(calls.some(a=>a[0]==='rm'),'the sandbox is torn down');
    assert.ok(!ran(calls),'the task never ran');
  });
for(const [name,githubProbe,reason] of [['an unauthenticated response',rateLimit(60),'unauthenticated'],
  ['a guest that cannot reach GitHub',{code:6,stdout:'',stderr:'curl: (6) Could not resolve host'},'github_unreachable'],
  ['a guest without curl or wget',{code:127,stdout:'',stderr:''},'github_unreachable'],
  ['a page that is not the API',{code:0,stdout:'<html>blocked</html>',stderr:''},'github_response_unreadable']])
  test('an internet job without GitHub runs with '+name,async()=>{
    const {backend,job,calls}=fixture({services:['anthropic',GEN_OLD],network:'enabled',githubProbe});
    const handle=await backend.prepare(job);
    try{
      assert.equal(probeCalls(calls).length,1);
      assert.equal(handle._execution.github_binding_probe.reason,reason);
      assert.equal(handle._execution.github_binding_probe.outcome,'passed');
    }finally{await backend.destroy(handle);}
  });
test('no guest request is made without a generated GitHub secret, for a restricted job, or for a granted job',async()=>{
  const authenticated=rateLimit(5000);
  for(const options of [{services:['anthropic'],network:'enabled'},{services:['anthropic',GEN_OLD]},
    {services:['anthropic',GEN_OLD],network:'enabled',githubAccessRequired:true}]) {
    const {backend,job,calls}=fixture({...options,githubProbe:authenticated});
    let handle;
    try{handle=await backend.prepare(job);}finally{if(handle)await backend.destroy(handle);}
    assert.equal(probeCalls(calls).length,0,JSON.stringify(options));
  }
});

test('a GitHub-granted job keeps working with its generation and with older ones',async()=>{
  const generation={service:GEN_NEW};
  const store=runner(listing([GEN_NEW,GEN_OLD]));
  for(const egress of ['internet','provider-only']) {
    assert.deepEqual(await restrictCredentialScope(store,{image:'wf-gh-cli',egress},'sb-1',generation),[]);
    assert.deepEqual(await restrictCredentialScope(store,{image:'claude',github_access_required:true,egress},'sb-1',generation),[]);
  }
});
