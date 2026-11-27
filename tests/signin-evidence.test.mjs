import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeSignIn, probeLendingSignIn, probeFaravanIdentity, resolveHarness } from '../lib/executor.mjs';
import { CODEX_LENDING_HARNESS, CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS } from '../lib/harnesses.mjs';
import { validateHarnessSpec } from '../lib/harness-spec.mjs';

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DockerSbxBackend } from '../lib/docker-backend.mjs';
import { createSbxPolicy, sbxRunner } from './helpers/sbx-policy-model.mjs';

const secretListing = (secrets=[],extra={}) => JSON.stringify({secrets,custom_secrets:[],shadowed_services:[],env_only_count:0,...extra});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve=done; }); return {promise,resolve}; };

test('lending secret listing is only negative evidence, with bounded output and no shell', async () => {
  let calls = 0, invocation;
  const value = await probeLendingSignIn('codex', { run(binary, args, options, callback) {
    calls++;
    invocation={binary,args,options};
    callback(null, secretListing([{scope:'global',type:'service',name:'openai'}]));
    return { kill() {} };
  } });
  assert.equal(invocation.binary,process.env.FARAVAN_SBX_BIN||'sbx');
  assert.deepEqual(invocation.args, ['secret', 'ls', '--json']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.timeout, 30_000);
  assert.equal(invocation.options.maxBuffer, 16 * 1024 * 1024);
  assert.ok(invocation.options.env.HOME);
  assert.deepEqual(value, { signedIn: null, secretPresent: true, source: 'sandbox-store' });
  assert.equal(calls, 1);
});

test('failed, timed out, ambiguous and unsupported fast probes never report signed out', async () => {
  for (const [error, output, expected,secretPresent] of [
    [null, secretListing(), false, false],
    [new Error('failed'), secretListing(), null, null],
    [null, '', null, null], [null, 'warning: openai oauth', null, null],
    [null, secretListing([{scope:'global',type:'service',name:'openai',kind:'oauth'}]), null, true],
    [null, secretListing([{scope:'global',type:'service',name:'openai',kind:'apikey'}]), null, true],
    [null, secretListing([{scope:'global',type:'service',name:'other'}]), false, false],
    [null, secretListing([], {env_only_count:1}), null, null],
  ]) {
    const result = await probeLendingSignIn('codex', { run(_bin, _args, _opts, done) { done(error, output); } });
    assert.equal(result.signedIn, expected);
    assert.equal(result.secretPresent,secretPresent);
    const {reason,...evidence}=result;
    assert.deepEqual(Object.keys(evidence).sort(), ['secretPresent','signedIn', 'source']);
    assert.equal(reason, result.secretPresent===null ? 'credential_store_unreadable' : undefined);
  }
  let killed = 0;
  const timedOut=await probeLendingSignIn('codex', { timeoutMs: 5, run() { return { kill() { killed++; } }; } });
  assert.equal(timedOut.signedIn, null);
  assert.equal(timedOut.secretPresent,null);
  assert.equal(killed, 1);
  const apiKey=await probeLendingSignIn('codex',{run(_bin,_args,_opts,done){done(null,secretListing([{scope:'global',type:'service',name:'openai',kind:'apikey'}]));}});
  assert.equal(apiKey.signedIn,null);
  assert.equal(apiKey.secretPresent,true);
  for (const id of ['gemini', 'unknown']) {
    assert.deepEqual(await probeLendingSignIn(id, { run() { assert.fail('unsupported lending probe must not spawn'); } }),
      {signedIn:null,secretPresent:null,source:'sandbox-store'});
  }
});

// Fake sbx runner: each case is what the store read printed. Unknown must carry the reason, never a sign-out.
const UNREADABLE = {signedIn:null,secretPresent:null,source:'sandbox-store',reason:'credential_store_unreadable'};
const readRunner = (error, stdout, stderr) => (_bin, _args, _opts, done) => done(error, stdout, stderr);
test('a store read that errors is unknown with a reason, not signed out',async()=>{
  assert.deepEqual(await probeLendingSignIn('codex',{run:readRunner(new Error('exit 1'),secretListing(),'')}),UNREADABLE);
  assert.deepEqual(await probeLendingSignIn('codex',{run:readRunner(new Error('timed out'),'','')}),UNREADABLE);
});
test('a zero exit with a keychain-denied message on stderr is unknown, even when the listing is empty',async()=>{
  const denied='error: keychain is locked; user interaction is not allowed\n';
  assert.deepEqual(await probeLendingSignIn('codex',{run:readRunner(null,secretListing(),denied)}),UNREADABLE);
  assert.deepEqual(await probeLendingSignIn('codex',{run:readRunner(null,'',denied),knownPresent:true}),UNREADABLE);
});
test('an empty listing is unknown when the store showed the row before',async()=>{
  assert.deepEqual(await probeLendingSignIn('codex',{run:readRunner(null,secretListing(),'') ,knownPresent:true}),UNREADABLE);
});
test('a readable, complete listing without the row is still signed out',async()=>{
  assert.deepEqual(await probeLendingSignIn('codex',{run:readRunner(null,secretListing(),'')}),{signedIn:false,secretPresent:false,source:'sandbox-store'});
  assert.deepEqual(await probeLendingSignIn('codex',{run:readRunner(null,secretListing([{scope:'global',type:'service',name:'other'}]),''),knownPresent:true}),
    {signedIn:false,secretPresent:false,source:'sandbox-store'});
});
test('lending secret probe kills and drains its owned child on cancellation',async()=>{
  const controller=new AbortController();
  let invocation,killed=0,callback;
  const probing=probeLendingSignIn('codex',{signal:controller.signal,run(_bin,_args,options,done){
    invocation=options;callback=done;return {kill(signal){assert.equal(signal,'SIGKILL');killed++;queueMicrotask(()=>callback(Object.assign(new Error('aborted'),{code:'ABORT_ERR'})));}};
  }});
  controller.abort();
  assert.equal(invocation.signal,controller.signal);
  assert.equal(killed,1);
  const result=await Promise.race([probing,new Promise((_,reject)=>setTimeout(()=>reject(Error('child probe did not drain')),50))]);
  assert.deepEqual(result,{signedIn:null,secretPresent:null,source:'sandbox-store'});
});

test('lending identity checks use the proxy spec and status probe inside a provider-only sandbox',async()=>{
  for(const [harness,stdout] of [[CODEX_LENDING_HARNESS,'FARAVAN_INSTALLED=1\nSBX_CRED_OPENAI_MODE=oauth\n'],
    [CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS,'FARAVAN_INSTALLED=1\n{"loggedIn":true,"authMethod":"claude.ai"}\n']]) {
    let prepared,destroyed=0;
    const backend={lenderCapabilities:async()=>({available:true}),prepare:async spec=>{prepared=spec;return {_lastExecStdout:'',job_id:spec.job_id};},
      start:async handle=>{handle._lastExecStdout=stdout;},destroy:async()=>{destroyed++;return {removed:true};}};
    const id=harness.harness_id;
    const result=await probeFaravanIdentity({harnessNames:[id],harnessSpecs:{[id]:harness},network:'provider-only',
      backendFactory:()=>backend,readDockerAccount:async()=>null});
    assert.equal(result.providers[0].signedIn,true,id);
    assert.equal(prepared.auth_strategy,'docker-native-oauth');
    assert.equal(prepared.egress,'provider-only');
    assert.equal(prepared.execution_scope,'owner');
    assert.match(prepared.entrypoint,id==='codex'?/codex login status/:/claude auth status --json/);
    assert.equal(destroyed,1,'positive identity checks still destroy their owned sandbox');
  }
});

test('identity probe survives a 55-second prepare and a bounded status command',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const preparing=deferred(),started=deferred();
  let wallTimer,statusSignal,destroyed=0,prepared,statusRan=false;
  const wall=deferred(),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const backend={
    lenderCapabilities:async()=>({available:true}),
    prepare:async spec=>{
      prepared=spec;
      wallTimer=setTimeout(()=>wall.resolve(),spec.resources.wall_seconds*1000);
      preparing.resolve();
      await Promise.race([delay(55_000),wall.promise.then(()=>{throw new Error('wall timeout');})]);
      return {_lastExecStdout:'',job_id:spec.job_id};
    },
    start:async(handle,{signal})=>{
      statusSignal=signal;statusRan=true;started.resolve();
      await Promise.race([delay(10_000),wall.promise.then(()=>{throw new Error('wall timeout');})]);
      handle._lastExecStdout='FARAVAN_INSTALLED=1\nSBX_CRED_OPENAI_MODE=oauth\n';
    },
    destroy:async()=>{destroyed++;clearTimeout(wallTimer);return {removed:true};},
  };
  const probing=probeFaravanIdentity({harnessNames:['codex'],harnessSpecs:{codex:CODEX_LENDING_HARNESS},
    backendFactory:()=>backend,readDockerAccount:async()=>null});
  await preparing.promise;
  t.mock.timers.tick(55_000);
  await started.promise;
  t.mock.timers.tick(5_000);
  for(let i=0;i<20;i++)await Promise.resolve();
  t.mock.timers.tick(5_000);
  const result=await probing;
  assert.equal(statusRan,true);
  assert.equal(result.providers[0].installed,true);
  assert.equal(result.providers[0].signedIn,true);
  assert.equal(prepared.resources.wall_seconds,180);
  assert.equal(destroyed,1);
  t.mock.timers.tick(180_000);
  assert.equal(statusSignal.aborted,false,'a completed probe clears its command watchdog');
});

test('identity status deadline destroys a hung sandbox and ignores partial stdout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const started=deferred();
  let destroyed=0,statusSignal,result;
  const backend={
    lenderCapabilities:async()=>({available:true}),
    prepare:async spec=>({_lastExecStdout:'',job_id:spec.job_id}),
    start:(handle,{signal})=>{
      statusSignal=signal;
      handle._lastExecStdout='FARAVAN_INSTALLED=1\nSBX_CRED_OPENAI_MODE=oauth\n';
      started.resolve();
      return new Promise(()=>{});
    },
    destroy:async()=>{destroyed++;return {removed:true};},
  };
  const probing=probeFaravanIdentity({harnessNames:['codex'],harnessSpecs:{codex:CODEX_LENDING_HARNESS},
    backendFactory:()=>backend,readDockerAccount:async()=>null}).then(value=>{result=value;return value;});
  await started.promise;
  t.mock.timers.tick(29_999);
  for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(destroyed,0);
  assert.equal(result,undefined);
  t.mock.timers.tick(1);
  for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(destroyed,1,'the 30-second status deadline starts sandbox removal');
  assert.ok(result,'a non-completing status cannot keep the identity probe pending');
  assert.equal(statusSignal.aborted,true);
  assert.equal(result.providers[0].installed,null);
  assert.equal(result.providers[0].signedIn,null);
  assert.equal(result.providers[0].authed,null);
  await probing;
});

test('identity status abort ignores late output and waits for destruction',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const timeout of [false,true]) {
    const controller=new AbortController(),started=deferred(),cleanup=deferred();
    let destroyed=0,result;
    const backend={
      lenderCapabilities:async()=>({available:true}),
      prepare:async spec=>({_lastExecStdout:'',job_id:spec.job_id}),
      start:(handle,{signal})=>new Promise(resolve=>{
        signal.addEventListener('abort',()=>{
          handle._lastExecStdout='FARAVAN_INSTALLED=1\nSBX_CRED_OPENAI_MODE=oauth\n';
          resolve();
        },{once:true});
        started.resolve();
      }),
      destroy:async()=>{destroyed++;await cleanup.promise;return {removed:true};},
    };
    const probing=probeFaravanIdentity({harnessNames:['codex'],harnessSpecs:{codex:CODEX_LENDING_HARNESS},
      backendFactory:()=>backend,readDockerAccount:async()=>null,signal:controller.signal}).then(value=>{result=value;return value;});
    await started.promise;
    if(timeout)t.mock.timers.tick(30_000);else controller.abort();
    for(let i=0;i<20;i++)await Promise.resolve();
    assert.equal(destroyed,1);
    assert.equal(result,undefined,'the probe still owns the pending destruction');
    cleanup.resolve();
    await probing;
    assert.equal(result.providers[0].installed,null);
    assert.equal(result.providers[0].signedIn,null);
  }
});

test('identity probe cancellation reaches prepare and waits for owned cleanup',async()=>{
  const controller=new AbortController(),entered=deferred(),cleanup=deferred();
  let prepareSignal,capabilitySignal,cleaned=false,started=false,probeSettled=false;
  const backend={lenderCapabilities:async options=>{capabilitySignal=options?.signal;return {available:true};},prepare:async(_spec,options)=>{
    prepareSignal=options?.signal;entered.resolve();
    await new Promise((resolve,reject)=>{
      const abort=async()=>{await cleanup.promise;cleaned=true;reject(Object.assign(new Error('aborted'),{name:'AbortError'}));};
      if(prepareSignal?.aborted)void abort();else prepareSignal?.addEventListener('abort',abort,{once:true});
    });
  },start:async()=>{started=true;},destroy:async()=>({removed:true})};
  const probing=probeFaravanIdentity({harnessNames:['codex'],backendFactory:()=>backend,readDockerAccount:async()=>null,signal:controller.signal});
  probing.finally(()=>{probeSettled=true;});
  await Promise.race([entered.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('prepare did not start')),200))]);
  controller.abort();await Promise.resolve();
  assert.equal(probeSettled,false,'the probe remains owned until prepare cleanup settles');
  cleanup.resolve();
  await Promise.race([probing,new Promise((_,reject)=>setTimeout(()=>reject(Error('identity probe did not drain owned cleanup')),200))]);
  assert.equal(prepareSignal,controller.signal);
  assert.equal(capabilitySignal,controller.signal);
  assert.equal(cleaned,true);
  assert.equal(started,false,'cancellation never advances to the status command');
});

test('native sign-in probe never treats the Docker proxy account as an owner generation',async()=>{
  assert.deepEqual(await probeSignIn('codex',{home:'/missing-faravan-test-home',run(){assert.fail('native absence must not inspect proxy metadata');}}),
    {signedIn:false,source:'provider-generation'});
});

test('signin_probe spec validates a typed argv declaration and rejects malformed fields', () => {
  const { image, ...base } = resolveHarness('codex');
  assert.equal(validateHarnessSpec(base), base);
  for (const signin_probe of [null, 'host', {}, { path: 'guest', command: ['x'] },
    { path: 'host', command: 'x' }, { path: 'host', command: [] },
    { path: 'host', command: [''] }, { path: 'host', command: ['x\n'] },
    { path: 'host', command: ['x'], extra: true }]) {
    assert.throws(() => validateHarnessSpec({ ...base, signin_probe }), /signin_probe/);
  }
});

test('a proxy API key is not a subscription sign-in for lending', async () => {
  for (const [spec, line, expected] of [
    [CODEX_LENDING_HARNESS, 'SBX_CRED_OPENAI_MODE=apikey', false],
    [CODEX_LENDING_HARNESS, 'SBX_CRED_OPENAI_MODE=oauth', true],
    [CODEX_LENDING_HARNESS, 'SBX_CRED_OPENAI_MODE=none', false],
    [CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS, '{"loggedIn":true,"authMethod":"api_key"}', false],
    [CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS, '{"loggedIn":true,"authMethod":"claude.ai"}', true],
  ]) {
    const backend = {lenderCapabilities: async () => ({available: true}), prepare: async job => ({_lastExecStdout: '', job_id: job.job_id}),
      start: async handle => { handle._lastExecStdout = 'FARAVAN_INSTALLED=1\n' + line + '\n'; }, destroy: async () => ({removed: true})};
    const id = spec.harness_id;
    const report = await probeFaravanIdentity({harnessNames: [id], harnessSpecs: {[id]: spec}, network: 'provider-only',
      backendFactory: () => backend, readDockerAccount: async () => null});
    assert.equal(report.providers[0].signedIn, expected, id + ' ' + line);
  }
  // The owner's own Codex API-key sign-in keeps its meaning outside lending.
  assert.equal((await import('../lib/harnesses/index.mjs')).parseIdentityEvidence('codex', 'FARAVAN_INSTALLED=1\nSBX_CRED_OPENAI_MODE=apikey\n').signedIn, true);
});


// Exercise the real prepare/start/destroy path with the existing in-memory sbx model.
async function identityPolicyFixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'wf-identity-policy-'));
  const names = ['FARAVAN_SBX_HOME', 'FARAVAN_SCRATCH_ROOT'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = home;
  t.after(async () => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
    await rm(home, { recursive: true, force: true });
  });
  const runner = sbxRunner(createSbxPolicy(), undefined, { secretResult: {
    code: 0, stderr: '', stdout: secretListing([
      { name: 'openai', type: 'service', scope: '(global)' },
      { name: 'anthropic', type: 'service', scope: '(global)' },
    ]),
  } });
  const calls = [], state = { mode: 'oauth', extraDeny: false, extraRules: [], statusEmpty: false, fail: false, spec: null,
    harness: { ...CODEX_LENDING_HARNESS, egress_provider_hosts: ['**.openai.com', '**.chatgpt.com'] } };
  const backend = new DockerSbxBackend({ home, hostDisk: { free: async () => ({ free: 2 ** 40 }) },
    runCommand: async (args, options) => {
      calls.push([...args]);
      if (args[0] === 'policy' && args[1] === 'check' && state.fail)
        return { code: 0, stdout: '{}', stderr: '' };
      // destroy() proves removal from a fresh listing; the sandbox is gone once rm has run.
      if (args.join(' ') === 'ls --json') return { code: 0, stdout: '[]', stderr: '' };
      if (args[0] === 'exec' && args.at(-1).includes('codex login status'))
        return { code: 0, stdout: state.statusEmpty ? '' : 'FARAVAN_INSTALLED=1\nSBX_CRED_OPENAI_MODE=' + state.mode + '\n', stderr: '' };
      const result = await runner.run(args, options);
      if (args[0] === 'policy' && args[1] === 'ls' && (state.extraDeny || state.extraRules.length)) {
        const listing = JSON.parse(result.stdout);
        if (state.extraDeny) listing.rules.push({ id: 'changed-global-deny', status: 'active', resource_type: 'network',
          applies_to: 'all', decision: 'deny', resources: ['cache-change.invalid'] });
        listing.rules.push(...state.extraRules);
        return { ...result, stdout: JSON.stringify(listing) };
      }
      return result;
    },
  });
  backend.lenderCapabilities = async () => ({ available: true });
  backend._diagnosticEvidence = { version: '0.50.0' };
  const prepare = backend.prepare.bind(backend);
  backend.prepare = (spec, ...options) => { state.spec = structuredClone(spec); return prepare(spec, ...options); };
  const probe = async () => {
    calls.length = 0;
    const result = await probeFaravanIdentity({ harnessNames: ['codex'], harnessSpecs: { codex: state.harness },
      network: 'provider-only', backendFactory: () => backend, readDockerAccount: async () => null });
    return result.providers[0].signedIn;
  };
  const targets = () => calls.filter(args => args[0] === 'policy' && args[1] === 'check').map(args => args.at(-1)).sort();
  return { backend, state, calls, probe, targets };
}

test('identity policy: unchanged probes make zero decision checks and keep definite sign-in answers', async t => {
  const { state, calls, probe, targets } = await identityPolicyFixture(t);
  assert.equal(await probe(), true);
  assert.ok(targets().length > 0, 'the first probe verifies its policy');
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), [], 'an unchanged second probe reuses its verified policy');
  assert.ok(calls.some(args => args[0] === 'policy' && args[1] === 'deny'), 'denies still install per sandbox');
  assert.ok(calls.some(args => args[0] === 'exec' && args.at(-1).includes('ANTHROPIC_API_KEY')),
    'credential environment isolation is still checked');
  state.mode = 'none';
  assert.equal(await probe(), false);
  assert.deepEqual(targets(), [], 'signed out is also definite with cached policy checks');
});

test('identity policy: probes that alternate between agent policies each reuse their own checks', async t => {
  const { state, probe, targets } = await identityPolicyFixture(t);
  const first = state.harness;
  const second = { ...first, egress_provider_hosts: ['**.chatgpt.com', '**.openai.com', 'auth.openai.com'] };
  const counts = [];
  for (const harness of [first, second, first, second]) {
    state.harness = harness;
    assert.equal(await probe(), true);
    counts.push(targets().length);
  }
  assert.ok(counts[0] > 0 && counts[1] > 0, 'each policy is verified once');
  assert.deepEqual(counts.slice(2), [0, 0], 'a probe for the other policy does not discard this one');
});

test('identity policy: the stored checks are capped and the oldest policy is checked again', async t => {
  const { state, probe, targets } = await identityPolicyFixture(t);
  const base = state.harness;
  const harness = n => ({ ...base, egress_provider_hosts: [...base.egress_provider_hosts, `h${n}.openai.com`] });
  for (let n = 0; n <= 8; n++) { state.harness = harness(n); assert.equal(await probe(), true); }
  state.harness = harness(8);
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), [], 'the newest policy is still stored');
  state.harness = harness(1);
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), [], 'the oldest of the last eight policies is still stored');
  state.harness = harness(0);
  assert.equal(await probe(), true);
  assert.ok(targets().length > 0, 'the ninth policy pushed out the first');
});

test('identity policy: a real prepare keeps every decision check after probe reuse', async t => {
  const { backend, state, calls, probe, targets } = await identityPolicyFixture(t);
  assert.equal(await probe(), true);
  const full = targets();
  assert.ok(full.length > 0);
  assert.equal(await probe(), true);
  calls.length = 0;
  // Even the same status entrypoint is an ordinary job without the explicit prepare option.
  const handle = await backend.prepare({ ...state.spec, job_id: state.spec.job_id + '-real' });
  try { assert.deepEqual(targets(), full); }
  finally { await backend.destroy(handle); }
});

test('identity policy: changed rules, targets and sbx version each require fresh verification', async t => {
  const { backend, state, probe, targets } = await identityPolicyFixture(t);
  assert.equal(await probe(), true);
  const originalTargets = targets();
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), [], 'establish successful reuse before changing policy');
  state.extraDeny = true;
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), originalTargets, 'a rule-only change invalidates reuse even with identical targets');
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), []);
  state.harness.egress_provider_hosts.reverse();
  assert.equal(await probe(), true);
  assert.ok(targets().length > 0, 'a target change invalidates unchanged rule resources');
  assert.notDeepEqual(targets(), originalTargets);
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), []);
  backend._diagnosticEvidence.version = '0.51.0';
  assert.equal(await probe(), true);
  assert.ok(targets().length > 0, 'known sbx version is part of the hash');
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), []);
});

test('identity policy: failed verification is not cached and a later probe verifies again', async t => {
  const { state, probe, targets } = await identityPolicyFixture(t);
  assert.equal(await probe(), true);
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), [], 'establish reuse before invalidation');
  state.extraDeny = true;
  state.fail = true;
  assert.equal(await probe(), null, 'an unknown policy decision prevents the status command');
  assert.ok(targets().length > 0);
  state.fail = false;
  assert.equal(await probe(), true);
  assert.ok(targets().length > 0, 'a failed policy hash must be fully checked next time');
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), [], 'only the successful recovery may be reused');
});

test('identity policy: a rule the hash cannot describe, or an unknown sbx version, is checked every time', async t => {
  const { backend, state, probe, targets } = await identityPolicyFixture(t);
  assert.equal(await probe(), true);
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), [], 'establish reuse');
  const rule = { id: 'pattern-allow', status: 'active', resource_type: 'network', decision: 'allow', resources: ['example.invalid'] };
  for (const extra of [{ applies_to: 'sandbox:wf-*', scope: 'sandbox:wf-*' }, { applies_to: 'all', scope: 'sandbox:other' },
    { applies_to: 'sandbox:wf-0123456789abcdef', scope: 'global' }]) {
    state.extraRules = [{ ...rule, ...extra }];
    for (const round of [1, 2]) {
      assert.equal(await probe(), true);
      assert.ok(targets().length > 0, `rule ${JSON.stringify(extra)} round ${round} is checked`);
    }
  }
  state.extraRules = [{ ...rule, applies_to: 'sandbox:wf-0123456789abcdef', scope: 'sandbox:wf-0123456789abcdef' }];
  assert.equal(await probe(), true);
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), [], 'an exact rule for another sandbox still allows reuse');
  backend._diagnosticEvidence.version = undefined;
  for (const round of [1, 2]) {
    assert.equal(await probe(), true);
    assert.ok(targets().length > 0, `unknown version round ${round} is checked`);
  }
});

test('identity policy: a probe without an answer or a new lending session drops reuse', async t => {
  const { backend, state, probe, targets } = await identityPolicyFixture(t);
  assert.equal(await probe(), true);
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), [], 'establish reuse');
  state.statusEmpty = true;
  assert.equal(await probe(), null, 'unknown status output is not an answer');
  state.statusEmpty = false;
  assert.equal(await probe(), true);
  assert.ok(targets().length > 0, 'the probe after an unanswered one checks again');
  assert.equal(await probe(), true);
  assert.deepEqual(targets(), []);
  const release = backend.beginLendingSession();
  assert.equal(await probe(), true);
  assert.ok(targets().length > 0, 'a new lending session checks again');
  release();
});
