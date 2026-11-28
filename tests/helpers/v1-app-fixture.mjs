import {syntheticReadiness} from './synthetic-readiness.mjs';
import './no-browser.mjs';
import {initializeFixtureHome} from './home-isolation.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, createServer } from 'node:http';
import { once } from 'node:events';
import { openV1Store } from '../../lib/v1/store.mjs';
import { createV1Handler } from '../../lib/v1/server.mjs';
import { fixture, json, problem, resultArchive } from './v1-journey.mjs';
import { freshLink } from './fresh-link.mjs';
import { guestExec, collectGuest } from './git-guest.mjs';
import { legacyProxyHarness } from './legacy-proxy-harness.mjs';
import { startApp } from '../../lib/v1/app.mjs';
import { HOST_CAPABILITIES } from '../../lib/v1/versions.mjs';
import * as p from '../../lib/protocol/index.mjs';
import {jobWatchRevision} from '../../lib/v1/job-watch.mjs';
import {resolveSelection} from '../../lib/v1/run-request.mjs';
import {signLease} from '../../lib/v1/account-authority.mjs';
import {generateKeyPairSync} from 'node:crypto';
import {syntheticProvider,syntheticTransport,accountBackend,enrollSyntheticAccount,syntheticConfiguration,syntheticAdapters} from './synthetic-run-account.mjs';

// Extends only the signed, loopback TEST coordinator; never starts a real backend.
export async function waitFor(check, label = 'expected condition', timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for ' + label);
}
// Hang guards, not latency budgets: a loaded host can take many seconds for one loopback call.
// The test's own timeout and waitFor deadlines bound the test; these only stop a call that never ends.
export async function bounded(promise, label, timeout = 20000) {
  let timer;
  try {
    return await Promise.race([promise,new Promise((_,reject) => {
      timer = setTimeout(() => reject(new Error('Timed out: ' + label)),timeout);
    })]);
  } finally {clearTimeout(timer);}
}
export async function boundedFetch(url, options = {}) {
  assert.equal(new URL(url).hostname, '127.0.0.1', 'test traffic must remain on loopback');
  const timeout = AbortSignal.timeout(Number(process.env.FARAVAN_TEST_FETCH_MS) || 30000); // a hang detector, not a speed test: this host is shared and often overloaded
  return fetch(url, {...options, signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout});
}
// A bare-token POST /api/jobs is an agent send, and the app refuses it with 428 until the person confirms
// (confirmationPolicy in lib/v1/app.mjs). The fixture's caller is a confirmed HTTP client: it sends the
// `Faravan-Confirm: yes` header that docs/agents.md documents for HTTP (scripts/bar-hosted-borrow.mjs does the same).
// The local web app is admitted differently, as the browser owner (cookie and same Origin, no token): a test that
// models the web app or its composer sends with browserApi(), never with this header. A test that proves the
// refusal passes `confirm:false`; an explicit `faravan-confirm` header always wins.
export async function api(app, path, {method = 'GET', body, token = app.token, headers = {}, status = 200, confirm = true} = {}) {
  const confirmsSend = confirm && method === 'POST' && path === '/api/jobs' && token !== null;
  const response = await boundedFetch(app.origin + path, {method,
    headers: {...(token === null ? {} : {'x-faravan-session-token': token}),
      ...(confirmsSend ? {'faravan-confirm':'yes'} : {}),
      ...(body === undefined ? {} : {'content-type':'application/json'}), ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  // Read the option without duplicating the authentication-bearing parameter declaration.
  // raw callers own body consumption; status:null permits inspection of an expected error.
  if (arguments[2]?.raw === true) {
    if (status !== null) assert.equal(response.status, status, method + ' ' + path);
    return response;
  }
  const text = await response.text();
  assert.equal(response.status, status, method + ' ' + path + ': ' + text);
  return text ? JSON.parse(text) : null;
}
// The caller the local web app is: no token, the same Origin, the cookie its handoff link sets, and the
// surface label ui/v1/src/api.mjs adds. It sends no `faravan-confirm` header. Returns api() bound to that principal.
export async function browserApi(app) {
  const handoff = await boundedFetch(app.handoffUrl(), {redirect: 'manual'});
  await handoff.text();
  const headers = {cookie: handoff.headers.get('set-cookie').split(';')[0], origin: app.origin, 'faravan-surface': 'ui'};
  return (path, options = {}) => api(app, path, {...options, token: null, headers: {...headers, ...options.headers}});
}
export function hostRequest(app, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(app.origin + '/api/status',
      {headers:{host, 'x-faravan-session-token':app.token}}, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      });
    request.setTimeout(30000, () => request.destroy(new Error('HTTP test deadline')));
    request.once('error', reject);
    request.end();
  });
}
export function syntheticBackend(root, options = {}) {
  const calls = [];
  // Each held job waits on its own promise; cancel or destroy frees only that job, so an earlier job's cleanup cannot release a later one.
  const waiting = new Set();
  const release = () => {for (const resolve of [...waiting]) resolve();};
  const limits = {wall_seconds:1200,cpu:2,memory_bytes:4294967296,disk_bytes:4294967296,output_bytes:16777216};
  const enforced = ['cpu','memory','wall','output','storage'];
  const backend = {
    sandboxOwnership:()=>({owner_scope:'f'.repeat(64),sbx_home:root}),
    ensureGuestRuntime:async()=>({node:process.execPath}),
    calls,
    release,
    lenderCapabilities: () => ({available:true,backend_id:'synthetic-only',pinned_git:true,
      enforced_limits:Object.keys(limits),max_limits:limits,egress:['internet','provider-only'],capabilities:[]}),
    admitJob(spec) {calls.push(['admit',spec]);return {ok:true,enforced_limits:enforced,unenforced:[]};},
    // State the synthetic computer’s Docker facts explicitly; unknown facts are never ready.
    async probeCapabilities() {calls.push(['probe']);return {available:true,preflight:{ok:true,checks:[{name:'synthetic',ok:true,detail:'Ready'},
      ...['sbx_install','sbx_daemon','docker_login'].map(name=>({name,ok:true,detail:'Ready'}))]}};},
    async protectionSummary(requirements,context={}) {return syntheticReadiness(backend,requirements,context);},
    async prepare(spec) {
      calls.push(['prepare',spec]);
      const handle = {sandbox_id:'synthetic-only-'+randomUUID(),scratch_dir:await mkdtemp(join(root,'run-')),_entrypoint:spec.entrypoint,
        _execution:{egress_evidence:{'api.example.test':'allowed'},enforced_limits:enforced,unenforced:[]}};
      return handle;
    },
    async cloneGitSource(handle, source) {calls.push(['clone',source]);handle._execution.verified_commit=source.commit;},
    async start(handle, opts = {}) {
      // Source preparation has its own real-shell coverage; this backend has no cloned tree.
      if(handle._sourcePreparation&&handle._entrypoint.includes('FARAVAN_GIT_SOURCE_OK')){handle._lastExecStdout='FARAVAN_GIT_SOURCE_OK\n';return;}
      if(handle._sourcePreparation&&handle._entrypoint.includes('FARAVAN_WORKDIR_OK')){handle._lastExecStdout='FARAVAN_WORKDIR_OK\n';return;}
      if (await guestExec(handle, handle._entrypoint)) return;
      if (handle._entrypoint.startsWith('mkdir -p .wf-result')) {calls.push(['pack']);return;}
      if (handle._entrypoint === 'codex login status') {calls.push(['status']);return;}
      await opts.onLaunchDurable?.();opts.onExecutionStarted?.();
      calls.push(['run']);
      // The guard reports a reading for every run it meters. A synthetic run consumes nothing, so its reading is zero.
      const lendingReading = opts.lendingBudget ? {readings: [], limit_reached: false, using_overage: false,
        tokens: options.guardTokens ?? {input: 0, cached_input: 0, cache_write: 0, output: 0, reasoning_output: 0}, model: null,
        cost_usd: options.guardTokens ? null : 0, final: true} : null;
      if (lendingReading) opts.onMeter?.(lendingReading);
      let agentStdout='';
      options.emitRecord = record => {const line=JSON.stringify(record)+'\n';agentStdout+=line;opts.onLog?.({stream:'stdout',chunk:Buffer.from(line)});};
      options.emitLog = text => options.emitRecord({type:'item.completed',item:{type:'agent_message',text}});
      options.workspace = handle.scratch_dir;
      options.startedAt = Date.now();
      if (options.liveMessage) options.emitLog(options.liveMessage);
      try {calls.push(['source',await readFile(join(handle.scratch_dir,'README.md'),'utf8')]);}
      catch (error) {if (error.code !== 'ENOENT') throw error;}
      // A cancellation that arrived before the hold was registered must not leave the run waiting for a release that already came.
      if (options.hold && !handle.cancelled) await new Promise(resolve => {const done = () => {waiting.delete(done);resolve();};waiting.add(done);handle._release = done;});
      if (handle.cancelled) throw Object.assign(new Error('Synthetic cancellation'), {name:'AbortError'});
      if (options.runError) throw options.runError;
      if (options.change) await writeFile(join(handle.scratch_dir, options.change.path), options.change.bytes);
      if(options.finalMessage)options.emitLog(options.finalMessage);
      handle._lastExecStdout = '{"type":"turn.completed","usage":{"input_tokens":13,"output_tokens":5}}\n';
      opts.onLog?.({stream:'stdout',chunk:Buffer.from(handle._lastExecStdout)});
      if(options.captureStream)handle._execution.stdout=agentStdout+handle._lastExecStdout;
      return lendingReading ? {stop: null, meter: lendingReading} : undefined;
    },
    async collectDeclaredOutputs(handle, manifest) {calls.push(['collect']);return await collectGuest(handle, manifest) ?? [{path:'.wf-result/result.tar.gz',bytes_content:resultArchive()}];},
    async cancel(handle) {calls.push(['cancel']);handle.cancelled=true;handle._release?.();return {compute_stopped:true};},
    async requestStop() {calls.push(['requestStop']);return {delivered:false};},
    async destroy(handle) {calls.push(['destroy']);handle._release?.();await rm(handle.scratch_dir,{recursive:true,force:true});
      return {job_id:handle.job_id,sandbox_id:handle.sandbox_id,removed:true,scratch_removed:true,
        policy_removed:true,storage_removed:true,at:new Date().toISOString()};},
  };
  return backend;
}
// Synthetic lending fixtures use the legacy proxy, never native token files.
export const adapters = (run = null) => [{spec:legacyProxyHarness('codex'),installed:true,signedIn:true,
  harnessVersion:'synthetic-only',models:['example-model'],capabilities:[],...(run?{run}:{})}];

// Test-owned detached hosts need a cessation barrier, including a frozen process.
// The start-time token fences PID reuse before either TERM or KILL is sent.
export async function stopFixtureCoordinator(directory, installedRoot) {
  const {readFileSync} = await import('node:fs');
  const {stopOwnedCoordinatorProcess} = await import(installedRoot
    ? pathToFileURL(join(installedRoot,'lib/v1/host.mjs')).href : '../../lib/v1/host.mjs');
  let status;
  try{status=JSON.parse(await readFile(join(directory,'status.json'),'utf8'));}
  catch(error){if(error.code==='ENOENT')return;throw error;}
  if(!status?.pid)return;
  const statPath='/proc/'+status.pid+'/stat';
  const state=()=>{
    try{const stat=readFileSync(statPath,'utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).split(/\s+/);return {kind:fields[0],start:fields[19]};}
    catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;}
  };
  const original=state();if(!original||original.kind==='Z')return;
  const gone=()=>{const current=state();return !current||current.kind==='Z'||current.start!==original.start;};
  const signal=kind=>stopOwnedCoordinatorProcess(status.pid,join(directory,'host.json'),{
    readFile:(file,encoding)=>{
      const value=readFileSync(file,encoding);
      if(file===statPath&&value.slice(value.lastIndexOf(')')+2).split(/\s+/)[19]!==original.start)throw new Error('Fixture coordinator PID was reused');
      return value;
    },signal:pid=>process.kill(pid,kind),
  });
  try{signal('SIGTERM');}catch(error){if(!gone())throw error;}
  try{await waitFor(gone,'fixture coordinator exit',3000);}
  catch{if(!gone()){try{signal('SIGKILL');}catch(error){if(!gone())throw error;}await waitFor(gone,'forced fixture coordinator exit',5000);}}
}

export async function appFixture(t, options = {}) {
  const cleanup = [], apps = [], backends = [], started = new Set(), networkTrace = [];
  const leaseKeys=generateKeyPairSync('ed25519');
  const f = await fixture({after: fn => cleanup.push(fn)}, {managedShutdown: options.managedShutdown === true});
  f.networkTrace = networkTrace;
  const requestTimeMs = req => {
    try {
      const created = JSON.parse(Buffer.from(req.headers['faravan-proof'], 'base64url')).payload.created;
      if (Number.isSafeInteger(created)) return created * 1000;
    } catch {}
    return Date.now();
  };
  const requestInstant = req => new Date(Math.floor(requestTimeMs(req) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const attempts = new Map(),stopRequests=new Map(),jobWatches=new Map();
  f.attempts=attempts;
  f.jobWatches=jobWatches;
  const currentJobRevision=digest=>{
    const view=f.jobs.get(digest),attempt=view?.current_attempt;
    return view?jobWatchRevision(view,attempt?stopRequests.get(attempt.attempt_id)??null:null):null;
  };
  const wakeJobWatches=digest=>{
    for(const wake of [...(jobWatches.get(digest)??[])])wake();
  };
  // The shared fixture validates signatures, canonical bodies and replay nonces first.
  f.override = async ({req, res, body, route, circleId}) => {
    // P22: a host profile a test can change (f.hostCapabilities); by default a current host.
    // This fake serves no /enrollments/reject route, so it does not advertise it.
    if (route === '/capabilities') {json(res,{artifact_head:false,faravan:null,min_member:null,capabilities:HOST_CAPABILITIES.filter(c=>c!=='enrollment_reject_v1'),...f.hostCapabilities});return true;}
    if (route === '/heartbeat') {(f.heartbeats ??= []).push(body);json(res,{received_at:requestInstant(req),online_seconds:90});return true;}
    if(route==='/offers'){json(res,{items:[...f.jobs.values()].filter(v=>v.job.payload.circle===circleId&&v.state==='queued').map(v=>({...v,published_at:v.job.payload.created_at})),next_cursor:null,revision:f.jobs.size});return true;}
    if(req.method==='GET'&&/^\/jobs\/[0-9a-f]{64}\/watch$/.test(route)){
      const digest='sha256:'+route.split('/')[2],after=new URL(req.url,'http://127.0.0.1').searchParams.get('after');
      const wait=Number(new URL(req.url,'http://127.0.0.1').searchParams.get('wait'));
      const missing=()=>{res.writeHead(404,{'content-type':'application/problem+json'});res.end(JSON.stringify({code:'job_not_found',status:404}));};
      const revision=currentJobRevision(digest);if(revision===null){missing();return true;}assert.ok(Number.isSafeInteger(wait)&&wait>0&&wait<=30);
      if(after!==revision){json(res,{revision});return true;}
      let done=false,timer;const watchers=jobWatches.get(digest)??new Set();jobWatches.set(digest,watchers);
      const finish=()=>{if(done)return;done=true;clearTimeout(timer);watchers.delete(wake);if(!watchers.size)jobWatches.delete(digest);res.removeListener('close',cancel);
        const current=currentJobRevision(digest);if(current===null){missing();return;}json(res,{revision:current});};
      const cancel=()=>{if(done)return;done=true;clearTimeout(timer);watchers.delete(wake);if(!watchers.size)jobWatches.delete(digest);};
      const wake=()=>{if(currentJobRevision(digest)!==after)finish();};
      watchers.add(wake);res.once('close',cancel);timer=setTimeout(finish,wait*1000);return true;
    }
    const namedClaim=/^\/jobs\/(?:[0-9a-f]{64})\/claim$/.test(route);
    if (route === '/jobs/claim-next'||namedClaim) {
      const signer = JSON.parse(Buffer.from(req.headers['faravan-proof'],'base64url')).payload.key_id;
      const view = [...f.jobs.values()].find(view => view.job.payload.circle === circleId &&
        view.state === 'queued' && (!namedClaim||view.job_digest==='sha256:'+route.split('/')[2]) && !(body.exclude ?? []).includes(view.job_digest) &&
        p.canSatisfy(view.job.payload.requirements, body.advertisement,{job:view.job.payload}).ok);
      if (!view) {if(namedClaim){res.writeHead(409,{'content-type':'application/problem+json'});res.end(JSON.stringify({type:'urn:faravan:problem:conflict',title:'conflict',code:'conflict',status:409,retryable:false,outcome:'not_applied'}));}else json(res,null);return true;}
      const claimedAt = requestTimeMs(req);
      const attempt = {attempt_id:randomUUID(),job_digest:view.job_digest,generation:(view.current_attempt?.generation ?? 0)+1,holder:signer,
        state:'active',claimed_at:requestInstant(req),lease_expires_at:new Date(Math.floor(claimedAt/1000)*1000+120000).toISOString().replace('.000Z','Z'),
        reason:null,compute_stopped:false,stopped_at:null,execution_started_at:null,execution_observed_at:null,
        selection:resolveSelection({runRequest:view.job.payload.runRequest,accounts:body.advertisement.accounts}).value};
      attempts.set(attempt.attempt_id, attempt);
      Object.assign(view,{state:'claimed',current_attempt:attempt});
      wakeJobWatches(view.job_digest);
      json(res,{job_digest:view.job_digest,job:view.job,attempt});
      return true;
    }
    if (route.endsWith('/cancel')) {
      const view = f.jobs.get('sha256:' + route.split('/')[2]);
      assert.ok(view);
      assert.equal(body.payload.author,view.job.payload.author,'only the borrower may cancel its job');
    }
    if (route.startsWith('/attempts/')) {
      const [, , id, action] = route.split('/');
      const attempt = attempts.get(id);
      // A completed fixture job was never claimed here, so it has no stop request to read.
      if(!attempt&&action==='stop-request'&&req.method==='GET'){json(res,null);return true;}
      assert.ok(attempt, 'attempt must have been claimed');
      const view = f.jobs.get(attempt.job_digest);
      if (!action) {json(res,attempt);return true;}
      if(action==='account-lease'){
        assert.equal(body.generation,attempt.generation);
        assert.deepEqual(body.selection,attempt.selection);
        const {privateKey,publicKey}=leaseKeys;
        const binding={circle:circleId,holder:attempt.holder,jobId:attempt.job_digest,attemptId:id,
          selection:attempt.selection,fence:attempt.generation,membershipEpoch:f.circles.get(circleId).roster.payload.epoch,
          expiresAtMs:Date.parse(attempt.lease_expires_at)};
        json(res,{binding,proof:signLease({...binding,challenge:body.challenge},privateKey),publicKey:publicKey.export({format:'pem',type:'spki'})});return true;
      }
      if(action==='stop-request') {
        if(req.method==='GET'){json(res,stopRequests.get(id)??null);return true;}
        assert.equal(body.generation,attempt.generation);
        assert.equal(attempt.state,'active');
        assert.equal(typeof attempt.execution_started_at,'string');
        let request=stopRequests.get(id);
        if(!request){request={attempt_id:id,job_digest:attempt.job_digest,generation:attempt.generation,requested_at:requestInstant(req)};stopRequests.set(id,request);wakeJobWatches(attempt.job_digest);}
        json(res,request);return true;
      }
      assert.equal(body.generation ?? body.payload?.generation, attempt.generation);
      if (action === 'start') {
        if (!started.has(id)) {started.add(id);view.attempts_started++;attempt.execution_started_at=requestInstant(req);wakeJobWatches(view.job_digest);}
      } else if(action==='observed-start') {
        if(typeof attempt.execution_started_at!=='string'){problem(res,409,'conflict');return true;}
        attempt.execution_observed_at??=requestInstant(req);wakeJobWatches(view.job_digest);
      } else if (action === 'renew') {
        attempt.lease_expires_at = new Date(Math.floor(requestTimeMs(req)/1000)*1000+body.lease_seconds*1000).toISOString().replace('.000Z','Z');
      } else if (action === 'release' || action === 'fail') {
        Object.assign(attempt,{state:action === 'release' ? 'released' : 'failed',reason:body.reason});
        view.state = action === 'release' ? 'queued' : 'failed';
        wakeJobWatches(view.job_digest);
      } else if (action === 'stopped') {
        Object.assign(attempt,{compute_stopped:true,stopped_at:body.stopped_at});
        wakeJobWatches(view.job_digest);
      } else if (action === 'complete') {
        const member = f.circles.get(circleId).roster.payload.members.find(m => m.key_id === attempt.holder);
        assert.equal(p.verifyEnvelope('result',body,member.public_key).ok,true);
        Object.assign(attempt,{state:'completed',compute_stopped:true,stopped_at:requestInstant(req)});
        Object.assign(view,{state:'result-accepted',result:body,result_digest:p.digest(body.payload)});
        wakeJobWatches(view.job_digest);
        json(res,{job_digest:view.job_digest,result_digest:view.result_digest,attempt_id:id,
          generation:attempt.generation,accepted_at:requestInstant(req),status:'result-accepted'});
        return true;
      } else assert.fail('Unexpected synthetic attempt action: ' + action);
      json(res,attempt);return true;
    }
    return false;
  };
  const configuredAccounts=new Map();
  f.start = async (name = 'owner', extra = {}) => {
    const home = await f.home(name), backend = extra.backend ?? syntheticBackend(f.root, options);
    const accountMode=extra.syntheticAccounts??configuredAccounts.get(name);
    const withAccount=!extra.accountProviderConfigurations&&(Array.isArray(accountMode)||typeof accountMode==='string'||accountMode===true&&!extra.adapters);
    if(withAccount)configuredAccounts.set(name,accountMode===true?'codex':accountMode);
    const configurations=(Array.isArray(accountMode)?accountMode:[accountMode]).map(syntheticConfiguration);
    const configuration=configurations[0];
    if(withAccount)accountBackend(backend,configurations);
    const fixtureAdapters=extra.adapters??(withAccount&&(configurations.length>1||configuration.descriptor.id==='claude')?syntheticAdapters(configurations):adapters(extra.codexRun??null));
    const backendFactory = extra.backendFactory ?? (async () => backend);
    const appStart = extra.startApp ?? options.startApp ?? startApp;
    backends.push(backend);
    if (extra.clock) f.clocks.set(name,extra.clock);
    const app = await appStart({home,origin:null,port:0,token:'synthetic-session-' + name,
      backendFactory,adapters:fixtureAdapters,lendingPace50:extra.lendingPace50??null,lendingRule:extra.lendingRule,lendingRuleAttestation:extra.lendingRuleAttestation,lendingNow:extra.lendingNow,
      // Fixtures begin from Off so each test turns lending on itself; a fresh install lends automatically (startApp's default).
      freshLending:extra.freshLending??options.freshLending??'off',shutdownProofMs:extra.shutdownProofMs,fetch:async (url,options) => {
        try {
          // The synthetic coordinator reads the sender's clock from this header (see v1-journey.mjs).
          // Keep a plain object: test hooks read Faravan-Proof from it, and a Headers instance hides that name.
          const headers = {...options?.headers,'x-test-device':name};
          const response = await boundedFetch(url,{...options,headers});
          let code;
          if (!response.ok) {try {code=(await response.clone().json()).code;} catch {}}
          networkTrace.push({device:name,method:options?.method??'GET',route:new URL(url).pathname,status:response.status,code});
          if (networkTrace.length>100) networkTrace.shift();
          return response;
        } catch(error) {
          networkTrace.push({device:name,route:new URL(url).pathname,error:error.code??error.name});
          if (networkTrace.length>100) networkTrace.shift();
          throw error;
        }
      },pollMs:25,
      // Tests approve by hand unless they opt into the background owner approval and the joiner's wait.
      autoApprove:false,joinWaitMs:0,approvalPollMs:25,
      // `userActive` is true at the app boundary; false models an absent owner.
      quotaReader:async () => ({remaining:100,observedAt:Date.now()}),idleReader:('idleReader' in extra ? extra.idleReader : async () => false),
      // Never read the real sbx secret store from a test: unknown unless a test says otherwise.
      signInProbe:async () => ({signedIn:null,source:'unavailable'}),
      lendingSignInProbe:async () => ({signedIn:null,source:'unavailable'}),
      // The lending identity check is a separate synthetic sandbox result; owner sign-in is not proxy evidence.
      lendingIdentityProbe:async ({harnessNames})=>({providers:await Promise.all(harnessNames.map(async id=>{
        const entries=typeof extra.adapters==='function'?await extra.adapters():fixtureAdapters;
        const entry=entries.find(a=>a.spec.harness_id===id);
        return {harness_id:id,installed:entry?.installed??null,signedIn:entry?.proxySignedIn??null};
      }))}),
      // Claude's Faravan sign-in is read from the usage store. A hermetic fixture models it with the sign-in evidence the test
      // already supplies (the secret probe, then the identity probe), unless the test supplies its own store.
      ...(extra.lendingUsageStore?{}:{faravanSignInProbe:async id=>{
        const secret=await (extra.lendingSignInProbe??(async()=>null))(id,{});
        if(secret?.signedIn===false)return false;
        const entries=typeof extra.adapters==='function'?await extra.adapters():fixtureAdapters;
        const entry=entries.find(a=>a.spec.harness_id===id);
        const identity=extra.lendingIdentityProbe?(await extra.lendingIdentityProbe({harnessNames:[id]})).providers?.find(row=>row.harness_id===id)?.signedIn:entry?.proxySignedIn;
        if(typeof identity==='boolean')return identity;
        return !extra.lendingSignInProbe&&!extra.lendingIdentityProbe&&typeof entry?.signedIn==='boolean'?entry.signedIn:null;
      }}),
      // A hermetic fixture must never fall through to a native sbx identity check.
      identityProbe:async ({harnessNames})=>({providers:await Promise.all(harnessNames.map(async id=>{
        const entries=typeof extra.adapters==='function'?await extra.adapters():fixtureAdapters;
        const entry=entries.find(a=>a.spec.harness_id===id);
        return {harness_id:id,installed:entry?.installed??null,signedIn:entry?.signedIn??null};
      }))}),
      checkJobIsolation:async()=>({state:'pass'}),
      ...(withAccount?{accountProviderConfigurations:configurations,accountTransportFetch:syntheticTransport}:{}),
      ...extra});
    if(withAccount)for(const entry of configurations)await enrollSyntheticAccount(app,api,home,entry);
    const phases = [];
    for (const factory of ['client', 'lendingClient']) {
      if(typeof app.device[factory]!=='function')continue; // Frozen rollback apps predate lendingClient.
      const getClient = app.device[factory].bind(app.device);
      app.device[factory] = async (...args) => {
        const client = await getClient(...args);
        for (const name of ['fetchArtifact','uploadResultArtifacts','resultContext','startAttempt','completeAttempt']) {
          if(typeof client[name]!=='function')continue;
          const original = client[name].bind(client);
          client[name] = async (...values) => {
            const trace = step => {phases.push(name+':'+step);if(phases.length>30)phases.shift();};
            trace('begin');
            try {const result=await original(...values);trace('ok');return result;}
            catch(error) {trace(error.code??error.name);throw error;}
          };
        }
        return client;
      };
    }
    apps.push(app);
    return {app,backend,home,phases};
  };
  f.connect = async (lenderOptions = {}, ownerOptions = {}) => {
    // Borrowing owners only track jobs; avoid making their status reads monopolize the device lock.
    const owner = await f.start('owner',{pollMs:250,...ownerOptions}), lender = await f.start('lender',{syntheticAccounts:true,...lenderOptions});
    await f.provisionFromHome('owner');
    const circle = await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Synthetic friends'}});
    const {invite} = await api(owner.app,'/api/circles/' + circle.id + '/invite',{method:'POST',body:{}});
    await api(lender.app,'/api/circles/join',{method:'POST',body:{link:invite}});
    const pending = await api(owner.app,'/api/circles/' + circle.id + '/approvals');
    assert.equal(pending.length,1);
    await api(owner.app,'/api/circles/' + circle.id + '/approve',{method:'POST',body:{}});
    await lender.app.device.refreshRoster(circle.id);
    return {owner,lender,circle,invite,pending};
  };

  f.realConnect = async ({quotas, lenderOptions = {}, ownerOptions = {}} = {}) => {
    const owner = await f.start('owner',{pollMs:250,...ownerOptions}), declining = await f.start('declining',{syntheticAccounts:true}), lender = await f.start('lender',{syntheticAccounts:true,...lenderOptions});
    let handler, store;
    const realRequests = [], realHeartbeats = [];
    // The incumbent can be taken away and returned: while it is down every connection to it is cut, as an unreachable host.
    let incumbentDown = false;
    const incumbent = {down() { incumbentDown = true; }, up() { incumbentDown = false; }};
    const server = createServer((req,res) => {
      const proof = req.headers['faravan-proof'];
      const record={route:req.url,method:req.method,device:proof?JSON.parse(Buffer.from(proof,'base64url')).payload.key_id:null};
      realRequests.push(record);
      if (incumbentDown) return void req.socket.destroy();
      // Completed responses distinguish contact from successful claim/completion.
      // Capture only these synthetic coordinator receipts, not general response bodies.
      const receipt=/\/(?:claim|claim-next|complete)$/.test(new URL(req.url,'http://fixture').pathname);
      const chunks=[];
      const write=res.write.bind(res),end=res.end.bind(res);
      if(receipt){
        res.write=(chunk,...args)=>{if(chunk)chunks.push(Buffer.from(chunk));return write(chunk,...args);};
        res.end=(chunk,...args)=>{if(chunk)chunks.push(Buffer.from(chunk));return end(chunk,...args);};
      }
      res.once('finish',()=>{
        record.status=res.statusCode;
        if(receipt&&chunks.length){
          try{record.response=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
        }
      });
      if (req.url.endsWith('/heartbeat')) {
        const chunks=[];
        req.on('data',chunk=>chunks.push(chunk));
        res.once('finish',()=>{if(res.statusCode===200)realHeartbeats.push({device:record.device,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});});
      }
      if (req.url.endsWith('/jobs/claim-next')) {
        const chunks=[];
        req.on('data',chunk=>chunks.push(chunk));
        req.once('end',()=>{record.body=JSON.parse(Buffer.concat(chunks).toString('utf8'));});
      }
      if (handler) return handler(req,res);
      res.writeHead(503);res.end();
    });
    server.listen(0,'127.0.0.1');
    await bounded(once(server,'listening'),'real synthetic server startup');
    cleanup.push(async () => {
      handler?.close();
      server.closeAllConnections();
      await bounded(new Promise(resolve=>server.close(resolve)),'real synthetic server close');
      store?.close();
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const circle = await api(owner.app,'/api/circles',{method:'POST',body:{origin,name:'Real-store synthetic circle',publish:false}});
    const initialRoster = (await owner.app.device.rosterCache(circle.id).get()).current;
    store = openV1Store({path:join(f.root,'real-store.sqlite'),circle:circle.id,
      rootFingerprint:circle.pinnedRootFingerprint,origin,initialRoster,...(quotas?{quotas}:{})});
    handler = createV1Handler({store,blobDir:join(f.root,'real-blobs')});
    for (const device of [declining,lender]) {
      const {invite} = await api(owner.app,'/api/circles/' + circle.id + '/invite',{method:'POST',body:{}});
      await api(device.app,'/api/circles/join',{method:'POST',body:{link:invite}});
      await api(owner.app,'/api/circles/' + circle.id + '/approve',{method:'POST',body:{}});
    }
    await declining.app.device.refreshRoster(circle.id);
    await lender.app.device.refreshRoster(circle.id);
    return {owner,declining,lender,circle,realRequests,realHeartbeats,incumbent};
  };
  t.after(async () => {
    for (const backend of backends) backend.release?.();
    // Every app is closed even when an earlier close fails: a loop left open by one app keeps the
    // whole test file alive. The first failure is still reported.
    const failures = [];
    for (const app of apps.reverse()) {
      try {await bounded(app.close(),'local app teardown');}
      catch (error) {failures.push(error);}
      finally {app.server.closeAllConnections?.();}
    }
    for (const fn of cleanup.reverse()) {
      try {await bounded(fn(),'synthetic coordinator teardown');}
      catch (error) {failures.push(error);}
    }
    if (failures.length) throw failures[0];
  });
  return f;
}

/** Two actual process environments; no circle, membership, agent choice or lending is provisioned. */
export async function twoFreshInstalls({root, hostHome = process.env.HOME, automaticEvidence = false, installedRoots}) {
  assert.equal(process.platform,'linux','twoFreshInstalls requires Linux process-ownership evidence');
  const {execFile, fork} = await import('node:child_process');
  const {promisify} = await import('node:util');
  if (installedRoots) {
    const {host, friend} = installedRoots;
    assert.ok(host && friend && isAbsolute(host) && isAbsolute(friend),'Two absolute installed roots are required');
    assert.notEqual(await realpath(host),await realpath(friend),'Each fixture must use its own install');
  }
  const actors = [];
  async function create(name) {
    const directory = join(root,name);
    const installedRoot = installedRoots && await realpath(installedRoots[name]);
    const execPath = installedRoot ? join(installedRoot,'runtime/bin/node') : process.execPath;
    const paths = {FARAVAN_HOME:join(directory,'faravan'), HOME:join(directory,'home'),
      CODEX_HOME:join(directory,'codex'), CLAUDE_CONFIG_DIR:join(directory,'claude')};
    for (const path of [...Object.values(paths),join(directory,'tmp')]) await mkdir(path,{recursive:true});
    initializeFixtureHome(paths.HOME);
    // Both installations run on this machine, so their circle address is the one local address the harness can name.
    // Under `test-sandbox --net none` that is loopback; the preload lets each app's host processes see it (lan-interfaces.mjs).
    const lanPreload = new URL('./lan-interfaces.mjs', import.meta.url).href;
    const env = {...process.env,...paths,FARAVAN_TEST_HOME:paths.HOME,TMPDIR:join(directory,'tmp'),
      FARAVAN_COORDINATOR_HOME:join(directory,'coordinator'),
      FARAVAN_NO_BROWSER:'1',FARAVAN_NO_UPDATE:'1',DISPLAY:'',WAYLAND_DISPLAY:'',FARAVAN_TEST_LAN_ADDRESS:'127.0.0.1',
      FARAVAN_TEST_AUTOMATIC_EVIDENCE:automaticEvidence?'1':'0',
      NODE_OPTIONS:[process.env.NODE_OPTIONS,'--import='+lanPreload].filter(Boolean).join(' ')};
    let child, nextId=0;
    const pending = new Map();
    const actor = {name,paths,env, async link() {return freshLink(actor.origin, actor.token);}, async start() {
      const args = installedRoot ? ['--fresh-app',installedRoot] : ['--fresh-app'];
      child = fork(new URL('../e2e-browser/v1-harness.mjs',import.meta.url),args,{execPath,env,stdio:['ignore','ignore','inherit','ipc']});
      const ready = new Promise((resolve,reject)=>{
        child.on('message',message=>{
          if(message.ready){Object.assign(actor,message.ready);resolve(actor);}
          else {const waiter=pending.get(message.id);pending.delete(message.id);message.error?waiter?.reject(new Error(message.error)):waiter?.resolve(message.value);}
        });
        child.once('exit',(code)=>{const error=new Error(name+' process exited: '+code);reject(error);for(const waiter of pending.values())waiter.reject(error);pending.clear();});
      });
      return bounded(ready,name+' startup',30000);
    }, async control(command,payload) {
      const id=++nextId;
      return bounded(new Promise((resolve,reject)=>{
        if(!child?.connected){reject(new Error(name+' IPC channel is closed'));return;}
        pending.set(id,{resolve,reject});
        child.send({id,command,payload},error=>{if(error){pending.delete(id);reject(error);}});
      }),name+' '+command,30000);
    }, async stop() {
      let gracefulError;
      try {
        if(!child||child.exitCode!==null||child.signalCode!==null)return;
        await actor.control('shutdown');
        if(child.exitCode===null&&child.signalCode===null)await bounded(once(child,'exit'),name+' exit',30000);
      } catch(error){gracefulError=error;
      } finally {
        // Even partial startup or a failed graceful close cannot leave our app
        // or its separately detached coordinator running. Verify ownership first.
        if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await bounded(once(child,'exit'),name+' forced exit',5000);}
        if (installedRoot) {
          // The identity check binds both the coordinator entry and the Node executable.
          // Run it inside the same bundled Node as the original coordinator.
          const source = 'import {stopFixtureCoordinator} from ' + JSON.stringify(import.meta.url) +
            ';await stopFixtureCoordinator(...process.argv.slice(1));';
          await promisify(execFile)(execPath,['--input-type=module','-e',source,env.FARAVAN_COORDINATOR_HOME,installedRoot],{env,timeout:12000});
        } else await stopFixtureCoordinator(env.FARAVAN_COORDINATOR_HOME);
      }
      actor.forcedCleanup=Boolean(gracefulError);
    }};
    actors.push(actor);
    await actor.start();
    assert.notEqual(actor.reportedPaths.HOME,hostHome);
    assert.deepEqual(actor.reportedPaths,paths);
    if (installedRoot) {
      assert.equal(actor.runtime.app,join(installedRoot,'lib/v1/app.mjs'));
      assert.equal(await realpath(actor.runtime.node),await realpath(execPath));
    }
    return actor;
  }
  try {
    const host=await create('host'),friend=await create('friend');
    for(const key of Object.keys(host.paths))assert.notEqual(host.reportedPaths[key],friend.reportedPaths[key]);
    assert.notEqual(host.pid,friend.pid);
    return {host,friend,async stop(){const outcomes=await Promise.allSettled(actors.map(actor=>actor.stop()));const failed=outcomes.find(v=>v.status==='rejected');if(failed)throw failed.reason;}};
  } catch(error){const stopped=await Promise.allSettled(actors.map(actor=>actor.stop()));if(stopped.some(value=>value.status==='rejected'))error.preserveFixtureRoot=true;throw error;}
}
