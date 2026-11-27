import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, syntheticBackend, waitFor } from './helpers/v1-app-fixture.mjs';
import { HARNESS_ADAPTERS } from '../lib/harnesses/index.mjs';

const opts = { timeout: 60000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ok = (id, extra = {}) => ({ providers: [{ harness_id: id, installed: true, signedIn: true, ...extra }] });
// Check scheduling tests retain the legacy proxy contract for selected agents.
const entries = ids => HARNESS_ADAPTERS.filter(a => ids.includes(a.spec.harness_id)).map(a => ({ ...a,lendingSpec:undefined,
  spec:a.spec.auth_strategy==='provider-file-generation'?{...a.spec,auth_strategy:'docker-native-oauth',credential_in_guest:false}:a.spec }));
const ALL = HARNESS_ADAPTERS.map(a => a.spec.harness_id);

// A tester, live: "Check agents" probed all six adapters one after another, each in a new sandbox, including ones that are not
// installed, and took more than 237 s before the request failed with agent_check_timeout.
test('a plain check looks only at lent and known-installed agents, never at the rest', opts, async t => {
  const f = await appFixture(t), probed = [];
  const { app } = await f.start('owner', { adapters: entries(ALL), identityProbe: async ({ harnessNames }) => { probed.push(...harnessNames); return ok(harnessNames[0]); } });
  await api(app, '/api/agents/codex', { method: 'POST', body: { useForLending: true } });
  const rows = await api(app, '/api/agents/refresh', { method: 'POST', body: {} });
  assert.deepEqual(probed, ['codex']);
  assert.equal(rows.length, ALL.length, 'every agent still has a row');
  assert.equal(rows.find(r => r.id === 'codex').signedIn, true);
  assert.equal(rows.find(r => r.id === 'codex').installed, true);
  for (const id of ['opencode', 'gemini', 'claude-code-api-key']) assert.equal(rows.find(r => r.id === id).signInState, 'Not checked', id);
  // An agent can still be named explicitly, and an unknown name is refused.
  await api(app, '/api/agents/refresh', { method: 'POST', body: { agents: ['gemini'] } });
  assert.deepEqual(probed, ['codex', 'gemini']);
  await api(app, '/api/agents/refresh', { method: 'POST', body: { agents: ['nope'] }, status: 400 });
  await api(app, '/api/agents/refresh', { method: 'POST', body: { agents: [] }, status: 400 });
  await api(app, '/api/agents/refresh', { method: 'POST', body: { other: 1 }, status: 400 });
});

test('agents are checked in parallel, three at a time, each with its own time limit and result', opts, async t => {
  const f = await appFixture(t);
  let running = 0, peak = 0;
  const { app } = await f.start('owner', { adapters: entries(ALL), agentProbeTimeoutMs: 400,
    identityProbe: async ({ harnessNames: [id] }) => {
      running++; peak = Math.max(peak, running);
      try {
        if (id === 'gemini') await sleep(5000); // hangs past its own limit
        else await sleep(150);
        return ok(id);
      } finally { running--; }
    } });
  const started = Date.now();
  const rows = await api(app, '/api/agents/refresh', { method: 'POST', body: { agents: ALL } });
  assert.ok(peak <= 3 && peak >= 2, 'concurrency is capped at 3 and actually used: ' + peak);
  assert.ok(Date.now() - started < 3000, 'a hung agent costs its own limit, not the whole check: ' + (Date.now() - started));
  const gemini = rows.find(r => r.id === 'gemini');
  assert.equal(gemini.signInState, 'Check failed');
  assert.match(gemini.remedy, /took too long/);
  for (const id of ALL.filter(id => id !== 'gemini')) assert.equal(rows.find(r => r.id === id).installed, true, id + ' has its own result');
  assert.ok(rows.every(r => r.checking === false));
});

test('each agent is reported as it finishes, with the others still marked checking', opts, async t => {
  const f = await appFixture(t);
  const delays = { codex: 400, 'claude-code-subscription': 50 };
  const { app } = await f.start('owner', { adapters: entries(['codex', 'claude-code-subscription']),
    identityProbe: async ({ harnessNames: [id] }) => { await sleep(delays[id]); return ok(id); } });
  await api(app, '/api/agents/refresh', { method: 'POST', body: { agents: ['codex', 'claude-code-subscription'] } });
  const events = (await api(app, '/api/activity?after=0')).filter(e => e.type === 'agents');
  const progress = events.filter(e => e.data.refreshed === false);
  assert.deepEqual(progress.map(e => e.data.id), [undefined, 'claude-code-subscription', 'codex'], 'start, then the quick one, then the slow one');
  assert.deepEqual(progress[0].data.agents.filter(a => a.checking).map(a => a.id).sort(), ['claude-code-subscription', 'codex']);
  assert.deepEqual(progress[1].data.agents.filter(a => a.checking).map(a => a.id), ['codex'], 'codex is still checking while the other has finished');
  assert.equal(progress[1].data.agents.find(a => a.id === 'claude-code-subscription').installed, true);
  assert.equal(events.at(-1).data.refreshed, true);
});

// A tester, live: after the credential-store cutover Codex's openai secret was gone. It showed "Check failed", empty evidence and
// a generic "Run faravan doctor" instead of "sign in again".
test('a stored sign-in that is gone says "needs you to sign in again", with the sign-in action, and starts no sandbox', opts, async t => {
  const f = await appFixture(t);
  let probes = 0, stored = false;
  const { app } = await f.start('owner', { adapters: entries(['codex']),
    signInProbe: async () => ({ signedIn: stored ? true : false, source: 'sandbox-store' }),
    identityProbe: async () => { probes++; return { providers: [{ harness_id: 'codex', installed: null, signedIn: null }] }; } });
  await api(app, '/api/agents/codex', { method: 'POST', body: { useForLending: true } });
  const [row] = await api(app, '/api/agents/refresh', { method: 'POST', body: {} });
  assert.equal(probes, 0, 'the missing credential is read from the store; no sandbox is needed to know');
  assert.equal(row.signInState, 'Sign-in needed');
  assert.equal(row.signInReason, 'credential_missing');
  assert.equal(row.remedy, 'ChatGPT (Codex) needs you to sign in again.');
  assert.equal(row.signInSupported, true, 'the Sign in action is offered');
  assert.notEqual(row.checkFailed, true);
  assert.ok(!/doctor/i.test(row.remedy));
  assert.equal(row.signedIn === true, false, 'never runnable');
  // Signing in again (the store has the secret) and checking: the sandbox answers and the row recovers.
  stored = true;
  const verdict = ok('codex');
  const again = await f.start('owner2', { adapters: entries(['codex']), signInProbe: async () => ({ signedIn: true, source: 'sandbox-store' }), identityProbe: async () => verdict });
  const [healed] = await api(again.app, '/api/agents/refresh', { method: 'POST', body: { agents: ['codex'] } });
  assert.equal(healed.signInState, 'Signed in');
  assert.equal(healed.signInReason, undefined);
});

test('a failed check with a stored sign-in present is still "Check failed", not a sign-in problem', opts, async t => {
  const f = await appFixture(t);
  const { app } = await f.start('owner', { adapters: entries(['codex']), signInProbe: async () => ({ signedIn: true, source: 'sandbox-store' }),
    identityProbe: async () => ({ providers: [{ harness_id: 'codex', installed: null, signedIn: null, workspace_cause: 'kvm' }] }) });
  const [row] = await api(app, '/api/agents/refresh', { method: 'POST', body: { agents: ['codex'] } });
  assert.equal(row.signInState, 'Check failed');
  assert.match(row.remedy, /virtual machines/);
});

test('agent checks receive the app sandbox backend instead of creating a second backend',opts,async t=>{
  const f=await appFixture(t);let factory;
  const {app,backend}=await f.start('bound-backend',{adapters:entries(['codex']),identityProbe:async options=>{factory=options.backendFactory;return ok('codex');}});
  await api(app,'/api/agents/refresh',{method:'POST',body:{agents:['codex']}});
  assert.equal(typeof factory,'function');
  assert.equal(factory().calls,backend.calls);
});

test('command path operations answer while a background agent check is still running',opts,async t=>{
  const f=await appFixture(t),lenderHome=await f.home('lender');
  let probeCount=0,backgroundEntered=false;
  const {lender,circle}=await f.connect({
    adapters:entries(['codex']).map(adapter=>({...adapter,installed:true,signedIn:true})),
    identityCacheMs:0,agentProbeTimeoutMs:60000,agentCheckTimeoutMs:60000,mutationTimeoutMs:60000,
    commandLauncher:process.execPath,env:{HOME:lenderHome,PATH:'/usr/bin:/bin',SHELL:'/bin/bash'},
    signInProbe:async()=>({signedIn:true,source:'host'}),
    identityProbe:async({harnessNames,signal})=>{
      probeCount++;
      if(probeCount===1)return ok(harnessNames[0]);
      backgroundEntered=true;
      return new Promise((resolve,reject)=>{
        const abort=()=>reject(Object.assign(new Error('aborted'),{code:'aborted'}));
        signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted)abort();
      });
    },
  });
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/agents/refresh',{method:'POST',body:{agents:['codex']}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await waitFor(()=>backgroundEntered,'background identity check to start');

  for(const operation of ['status','install','uninstall']) {
    const started=Date.now();
    const request=api(lender.app,`/api/ops/command_path.${operation}`,{method:'POST',body:{}})
      .then(value=>({value}),error=>({error}));
    const outcome=await Promise.race([request,sleep(1000).then(()=>({timedOut:true}))]);
    assert.notEqual(outcome.timedOut,true,'command_path.'+operation+' waited behind the agent check');
    assert.equal(outcome.error,undefined);
    assert.equal(typeof outcome.value?.installed,'boolean');
    assert.ok(Date.now()-started<1000,'command_path.'+operation+' exceeded its short deadline');
  }
});

for(const timedOut of [false,true])test('close joins identity probe acquisition and removal even after UI timeout='+timedOut,opts,async t=>{
  const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
  const entered=gate(),prepare=gate(),destroy=gate(),removing=gate();let destroys=0;
  t.after(()=>{prepare.resolve();destroy.resolve();});
  const f=await appFixture(t),backend=syntheticBackend(f.root);
  const acquire=backend.prepare.bind(backend),remove=backend.destroy.bind(backend);
  backend.prepare=async spec=>{entered.resolve();await prepare.promise;return {...await acquire(spec),job_id:spec.job_id};};
  backend.destroy=async handle=>{destroys++;removing.resolve();await destroy.promise;return remove(handle);};
  const {app}=await f.start('close-check-'+timedOut,{backend,adapters:entries(['codex']),agentProbeTimeoutMs:timedOut?20:10000,
    identityProbe:async ({backendFactory})=>{
      const checks=backendFactory();
      const handle=await checks.prepare({job_id:'wf-pull-0000000000000000-12345678',entrypoint:'true'});
      try{return ok('codex');}finally{await checks.destroy(handle);}
    }});
  const request=api(app,'/api/agents/refresh',{method:'POST',body:{agents:['codex']}}).catch(()=>{});
  await entered.promise;
  if(timedOut)await request;
  let settled=false;const closing=app.close().then(()=>{settled=true;});
  await sleep(50);assert.equal(settled,false,'close waits for sandbox acquisition');
  prepare.resolve();await removing.promise;
  await sleep(50);assert.equal(settled,false,'close waits for proven removal');
  destroy.resolve();await closing;await request;
  assert.equal(destroys,1);
});
