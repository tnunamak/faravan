import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runProbe, decideVerdict, MARKER} from '../lib/v1/credential-probe-guest.mjs';
import {validateProbeReport} from '../lib/v1/credential-probe.mjs';
import {checkJobIsolation} from '../lib/v1/isolation-check.mjs';
import {isolationReport, isolationPolicy} from './helpers/isolation-check-fixture.mjs';

// Synthetic credentials only. No real process, HOME, network or sandbox is inspected.
const token='sk-ant-oat01-Ab9Cd8Ef7Gh6Ij5Kl4Mn3Op2Qr1St0Uv';
const jwt=exp=>['eyJhbGciOiJSUzI1NiJ9',Buffer.from(JSON.stringify({exp})).toString('base64url'),'c3ludGhldGljLXNpZ25hdHVyZQ'].join('.');
async function fixture(t, service) {
  const root=await mkdtemp(join(tmpdir(),'owner-isolation-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'home'),directory=join(root,'generation'),proc=join(root,'proc');
  await Promise.all([home,directory,proc].map(dir=>mkdir(dir)));
  const file=join(directory,service==='anthropic'?'.credentials.json':'auth.json');
  const value=service==='anthropic'
    ? {claudeAiOauth:{accessToken:token,refreshToken:token,expiresAt:4102444800000}}
    : {tokens:{access_token:jwt(4102444800),id_token:jwt(4102444800),refresh_token:token,account_id:'synthetic-account'}};
  await writeFile(file,JSON.stringify(value));
  const ownerGeneration={service,directory};
  const env={HOME:home,[service==='anthropic'?'CLAUDE_CONFIG_DIR':'CODEX_HOME']:directory,
    [`SBX_CRED_${service.toUpperCase()}_MODE`]:'none'};
  const run=extra=>runProbe({home,env,provider:service,roots:[[home,3]],proc,escalate:false,mountsText:'',
    networkChecks:['ssh-agent','mcp-gateway','link-local-metadata'].map(id=>({id,found:false,severity:'none',evidence_redacted:'synthetic clear'})),...extra});
  return {root,home,directory,file,value,ownerGeneration,run};
}

for(const service of ['anthropic','openai']) {
  test(`owner native ${service}: host-declared generation binds without a sentinel`,async t=>{
    const f=await fixture(t,service);
    const before=await f.run();
    assert.deepEqual(before.inconclusive_reasons,['provider_not_signed_in']);
    const report=await f.run({ownerGeneration:f.ownerGeneration});
    assert.equal(report.verdict,'pass');
    assert.equal(report.provider.owner_generation_bound,true);
    assert.equal(validateProbeReport(report,{ownerGeneration:f.ownerGeneration}).ok,true);
    assert.equal(JSON.stringify(report).includes(token),false);
  });

  test(`owner native ${service}: isolation admission uses host scope and copied generation`,async t=>{
    const f=await fixture(t,service),network=isolationReport();
    const handle={sandbox_id:'sb-1',scratch_dir:f.home,_entrypoint:'agent',_executionScope:'owner',_ownerProviderGeneration:f.ownerGeneration};
    let logs=0,calls=0;
    const backend={ensureGuestRuntime:async()=>({node:'/runtime/node'}),
      runSbx:async()=>({code:0,stdout:JSON.stringify(++logs===1?{allowed:[],blocked:[]}:isolationPolicy(network))}),
      async start(h){
        if(++calls===1){h._lastExecStdout=JSON.stringify(network);return;}
        const encoded=/--owner-generation '([^']+)'/.exec(h._entrypoint)?.[1];
        const ownerGeneration=encoded?JSON.parse(Buffer.from(encoded,'base64url').toString()):undefined;
        const probe=await f.run({ownerGeneration});
        if(!ownerGeneration)assert.deepEqual(probe.inconclusive_reasons,['provider_not_signed_in'],'binding is the only live-case reason');
        h._lastExecStdout=MARKER+JSON.stringify(probe);
      }};
    const result=await checkJobIsolation({backend,handle,adapter:{spec:{provider_domains:['api.anthropic.com'],provider_service_id:service}}});
    assert.equal(result.state,'pass');
    assert.equal(calls,2);
  });

  test(`owner native ${service}: foreign secrets, missing checks and bad expiry still refuse`,async t=>{
    const f=await fixture(t,service),options={ownerGeneration:f.ownerGeneration,roots:[[f.home,3],[f.directory,2]]};
    const good=await f.run(options);
    assert.equal(good.verdict,'pass','generation is scanned without treating expected auth fields as a leak');
    const missing={...good,checks:good.checks.filter(c=>c.id!=='owner-generation')};
    assert.equal(validateProbeReport(missing,options).ok,false);
    for(const id of ['env-secrets','credential-files','process-environ','filesystem-token-scan','mcp-gateway','link-local-metadata','host-mounts']) {
      const bad={...good,checks:good.checks.map(c=>c.id===id?{...c,found:true,severity:'critical'}:c)};
      assert.equal(decideVerdict({checks:bad.checks,provider:bad.provider,selfTest:bad.self_test,ownerGenerationBound:true}).verdict,'fail',id);
    }
    await writeFile(f.file,JSON.stringify({...f.value,github_token:'ghp_Ab9Cd8Ef7Gh6Ij5Kl4Mn3Op2Qr1St0Uv'}));
    assert.equal((await f.run(options)).verdict,'fail','other services in the same file are scanned');
    await writeFile(f.file,JSON.stringify(f.value));
    await writeFile(join(f.home,'other.json'),JSON.stringify({accessToken:token}));
    assert.equal((await f.run(options)).verdict,'fail','same provider token outside the expected file is still a leak');
    await rm(join(f.home,'other.json'));
    const expired=structuredClone(f.value);
    if(service==='anthropic')expired.claudeAiOauth.expiresAt=1;else expired.tokens.access_token=jwt(1);
    await writeFile(f.file,JSON.stringify(expired));
    assert.equal((await f.run(options)).verdict,'inconclusive','expired owner auth is expected but never binds');
    await rm(f.file);
    assert.equal((await f.run(options)).verdict,'inconclusive','missing generation never binds');
    const target=join(f.root,'symlink-target');
    await writeFile(target,JSON.stringify(f.value));await symlink(target,f.file);
    assert.notEqual((await f.run(options)).verdict,'pass','symlink does not establish a generation binding');
  });

  test(`owner native ${service}: privileged scan retains the explicit generation after sudo resets env`,async t=>{
    const f=await fixture(t,service),ownerGeneration=f.ownerGeneration;
    const root=await f.run({ownerGeneration,role:'root',env:{},roots:[[f.directory,2]]});
    assert.equal(root.verdict,'pass');
    const sudo=join(f.root,'sudo');
    // Controlled unprivileged stand-in for sudo: require propagation and return the synthetic root scan.
    const response=join(f.root,'response');
    await writeFile(response,MARKER+JSON.stringify(root));
    await writeFile(sudo,`#!/bin/sh\nif [ "$2" = true ]; then exit 0; fi\ncase "$*" in *--owner-generation*) cat '${response}';; *) exit 2;; esac\n`,{mode:0o700});
    const report=await f.run({ownerGeneration,escalate:true,sudoCandidates:[sudo]});
    assert.equal(report.verdict,'pass');
    assert.match(report.checks.find(c=>c.id==='owner-generation').evidence_redacted,/as root:|root:/);
  });
}

test('borrowed native mode none remains inconclusive and guest owner claims cannot authorize it',async t=>{
  const f=await fixture(t,'anthropic'),report=await f.run();
  assert.equal(report.verdict,'inconclusive');
  const forged={...report,verdict:'pass',provider:{...report.provider,owner_generation_bound:true}};
  assert.equal(validateProbeReport(forged).ok,false);
});

test('borrowed isolation admission ignores host-shaped metadata and refuses a forged guest binding',async t=>{
  const f=await fixture(t,'anthropic'),network=isolationReport();
  for(const forge of [false,true]) {
    let logs=0,calls=0;
    const backend={ensureGuestRuntime:async()=>({node:'/runtime/node'}),
      runSbx:async()=>({code:0,stdout:JSON.stringify(++logs===1?{allowed:[],blocked:[]}:isolationPolicy(network))}),
      async start(h){
        if(++calls===1){h._lastExecStdout=JSON.stringify(network);return;}
        assert.doesNotMatch(h._entrypoint,/--owner-generation/);
        const report=await f.run();
        if(forge){report.verdict='pass';report.provider.owner_generation_bound=true;}
        h._lastExecStdout=MARKER+JSON.stringify(report);
      }};
    const out=await checkJobIsolation({backend,handle:{sandbox_id:'sb-1',scratch_dir:f.home,_entrypoint:'agent',_executionScope:'borrowed',_ownerProviderGeneration:f.ownerGeneration},
      adapter:{spec:{provider_service_id:'anthropic',provider_domains:['api.anthropic.com']}}});
    assert.equal(out.state,'inconclusive');
  }
});
