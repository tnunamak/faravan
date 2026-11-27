import './helpers/no-browser.mjs';
import {sessionRecovery} from '../ui/v1/src/session-recovery.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createLocalHandoff } from '../lib/v1/loopback-security.mjs';
import { openSessionStore } from '../lib/v1/browser-sessions.mjs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { adapters, appFixture, api, bounded, boundedFetch, hostRequest, syntheticBackend, waitFor as fixtureWaitFor } from './helpers/v1-app-fixture.mjs';
import { appFixture as admissionFixture } from './helpers/triage-small-app-fixture.mjs';
import * as p from '../lib/protocol/index.mjs';
import { resultArchive } from './helpers/v1-journey.mjs';
import { prepareResultDownload } from '../lib/v1/result-download.mjs';
import { validateArchive } from '../lib/archive.mjs';
import { HARNESS_ADAPTERS, identityProbeCommand, parseIdentityEvidence } from '../lib/harnesses/index.mjs';
import { waitingInviteTasks, invitationMessage, createTaskInvitation } from '../ui/v1/src/api.mjs';
import { createContributionLog, summarizeContributions, CONTRIBUTION_LIMITS, APP_DEFAULTS } from '../lib/v1/app.mjs';
import { createBorrowerOutcomeStore } from '../lib/v1/job-meta.mjs';
import { ClientError } from '../lib/v1/client.mjs';
import { contributorNextStep, approvalTitle, newApprovalIds, approvalNotificationTitle, approvalDeadline } from '../ui/v1/src/helpers.mjs';
import { resolveHarness, probeFaravanIdentity, buildTaskReceipt, executionMetadata } from '../lib/executor.mjs';
import { SBX_VERSION, passingRecord } from './helpers/credential-probe-fixture.mjs';
import { createLendingLedger } from '../lib/v1/lending-ledger.mjs';
import { makeRepo } from './helpers/git-guest.mjs';

// These are failure bounds, not elapsed-time assertions. Scheduling latency on a
// busy host must not decide whether the observable state transition happened.
const WAIT_MS = 30000;
const testOptions = {timeout:120000};
// Existing lending/identity tests use the old proxy contract. Native sign-in is
// exercised separately below and must never enable lending.
const legacyProxyAdapters=HARNESS_ADAPTERS.map(a=>a.spec.auth_strategy==='provider-file-generation'
  ? {...a,lendingSpec:undefined,spec:{...a.spec,auth_strategy:'docker-native-oauth',credential_in_guest:false}} : a);
const waitFor = (predicate,label,timeout=WAIT_MS) => fixtureWaitFor(predicate,label,timeout);
// Agent views never wait on the proxy check; read them once its background check has answered.
async function checkedAgents(app) {
  return waitFor(async()=>{const rows=await api(app,'/api/agents');
    return rows.every(row=>!('proxySignedIn' in row)||typeof row.proxySignedIn==='boolean')&&rows;},'proxy check settled');
}

test('boundary verification needs a dated passing record for the OS and sbx major.minor',async()=>{
  const {boundaryVerified}=await import('../lib/v1/app.mjs');
  const now=Date.parse('2026-10-19T12:00:00Z');
  const record={os:'linux',sbx_version:'0.47.0',tested_at:'2026-10-18T12:00:00Z',result:'passed'};
  const context={os:'linux',sbxVersion:'sbx version: v0.47.9 abc123',now};
  assert.equal(boundaryVerified([record],context),true);
  for(const os of ['linux','darwin','win32'])
    assert.equal(boundaryVerified([{...record,os}],{...context,os}),true);
  for(const rows of [[],null,{},[null],[{...record,result:'failed'}],[{...record,result:true}],
    [{...record,os:'darwin'}],[{...record,sbx_version:'0.48.0'}],
    [{...record,tested_at:null}],[{...record,tested_at:'invalid'}],
    [{...record,tested_at:'2026-10-20T00:00:00Z'}]]) {
    assert.equal(boundaryVerified(rows,context),false,JSON.stringify(rows));
  }
  for(const sbxVersion of [undefined,'','unknown','0.47.1-rc1','0.47.1 extra','0.47.1\n']) {
    assert.equal(boundaryVerified([record],{...context,sbxVersion}),null);
  }
  assert.equal(boundaryVerified([record],{...context,os:'unknown'}),null);
  assert.equal(boundaryVerified([record],{...context,sbxVersion:'1.47.0'}),false);
});

test('readiness boundary verification comes from matching records, never readiness alone',testOptions,async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root);
  const original=backend.protectionSummary.bind(backend);
  let version='sbx version 0.47.5',source='read-only-preflight',backendId='docker-sbx';
  backend.protectionSummary=async(...args)=>{
    const report=await original(...args);
    return {...report,source,backend_id:backendId,boundary_verified:true,
      preflight:{...report.preflight,version}};
  };
  const record={os:process.platform,sbx_version:'0.47.0',tested_at:'2026-10-18T12:00:00Z',result:'passed'};
  const now=Date.parse('2026-10-19T12:00:00Z');
  const {app}=await f.start('boundary',{backend,boundaryRecords:[record],clock:{now:()=>now}});
  const verification=async()=> (await api(app,'/api/readiness?refresh=true')).protection.boundary_verified;
  assert.equal(await verification(),true);
  version='sbx version 0.48.0';assert.equal(await verification(),false);
  version='unknown';assert.equal(await verification(),null);
  version='sbx version 0.47.5';backendId='synthetic-only';assert.equal(await verification(),null);
  backendId='docker-sbx';source='unknown';assert.equal(await verification(),null);
  source='read-only-preflight';
  const {app:unreviewed}=await f.start('boundary-default',{backend,clock:{now:()=>now}});
  assert.equal((await api(unreviewed,'/api/readiness?refresh=true')).protection.boundary_verified,false);
  const status=JSON.parse(await readFile(new URL('../docs/internal/status.json',import.meta.url),'utf8'));
  assert.deepEqual(status.find(row=>row.label==='Independent reviews').boundary,[]);
});


import { jobSafetyFacts } from '../lib/v1/app.mjs';

// Observation timestamps may change between reads of the same semantic job state.
const sameView=value=>JSON.parse(JSON.stringify(value,(key,v)=>{
  if(key==='statusContract'&&v)return {...v,observedAt:null};
  if(key==='jobProjection'&&v?.times)return {...v,times:{...v.times,observedAt:null}};
  return v;
}));

test('sameView ignores only job projection observation time',()=>{
  const projection={phase:'running',reasonCode:null,evidence:{executionStartedAt:'2026-10-21T12:00:00Z'},
    version:{jobDigest:'job-1',attemptId:'attempt-1',generation:3},
    times:{observedAt:'2026-10-21T12:00:00Z',validUntil:'2026-10-21T12:10:00Z',nextTransitionAt:'2026-10-21T12:05:00Z'}};
  const view={jobProjection:projection};
  assert.deepEqual(sameView(view),sameView({jobProjection:{...projection,times:{...projection.times,observedAt:'2026-10-21T12:00:01Z'}}}));

  const changes=[
    {phase:'stopping'},
    {reasonCode:'cancelled'},
    {evidence:{executionStartedAt:'2026-10-21T12:00:01Z'}},
    {version:{jobDigest:'job-1',attemptId:'attempt-2',generation:3}},
    {times:{validUntil:'2026-10-21T12:11:00Z'}},
    {times:{nextTransitionAt:'2026-10-21T12:06:00Z'}},
  ];
  for(const change of changes) {
    const changed={...projection,...change,times:{...projection.times,...change.times}};
    assert.notDeepEqual(sameView(view),sameView({jobProjection:changed}),JSON.stringify(change));
  }
  assert.notDeepEqual(sameView({jobProjection:projection,other:{observedAt:'a'}}),
    sameView({jobProjection:projection,other:{observedAt:'b'}}));
});

for(const adapter of HARNESS_ADAPTERS)test('safety facts use the '+adapter.spec.harness_id+' adapter contract',()=>{
  const job={requirements:{egress:'internet',limits:{wall_seconds:1201}}};
  assert.ok(!('credential_proxy_verified' in adapter),'adapters no longer declare the flag; it comes from the S5.2 evidence');
  assert.deepEqual(jobSafetyFacts(job,adapter),{
    network:{mode:'internet',registries:[],git:null,kit_hosts:adapter.spec.egress_kit_hosts??null},provider:adapter.spec.provider_service_id,
    provider_hosts:adapter.spec.egress_provider_hosts??null,
    credential_in_guest:adapter.spec.credential_in_guest,credential_proxy_verified:false,
    boundary_verified:null,budget_minutes:1201/60,quota:{remaining:null},
  });
  assert.equal(jobSafetyFacts({requirements:{egress:'provider-only'}},adapter).network.mode,'provider-only');
});

test('safety facts carry registries, the boundary record and the remaining allowance only when known',()=>{
  const job={requirements:{egress:'provider-only',network:'provider+registries',registries:['npm'],limits:{wall_seconds:600}}};
  const facts=jobSafetyFacts(job,null,{boundaryVerified:true,quotaRemaining:71});
  assert.deepEqual(facts.network,{mode:'provider+registries',registries:['npm'],git:null,kit_hosts:null});
  assert.equal(facts.boundary_verified,true);assert.deepEqual(facts.quota,{remaining:71});
  assert.equal(jobSafetyFacts(job,null,{boundaryVerified:false}).boundary_verified,false);
  for(const quotaRemaining of [undefined,null,-1,101,NaN,'71'])assert.deepEqual(jobSafetyFacts(job,null,{quotaRemaining}).quota,{remaining:null});
  assert.equal(jobSafetyFacts({requirements:{network:'provider+registries'}}).network.registries,null);
  assert.deepEqual(jobSafetyFacts({requirements:{network:'provider-only'}}).network,{mode:'provider-only',registries:[],git:null,kit_hosts:null});
  // A Git source reaches GitHub for the clone; an archive does not (S5.4, review 3): the fact says so, so nothing claims "provider only" outright.
  const requirements={egress:'provider-only'};
  assert.equal(jobSafetyFacts({requirements,source:{kind:'git'}}).network.git,true);
  assert.equal(jobSafetyFacts({requirements,source:{kind:'archive'}}).network.git,false);
  assert.equal(jobSafetyFacts({requirements,source:{kind:'mystery'}}).network.git,null);
  assert.equal(jobSafetyFacts(job,null,{boundaryVerified:'yes'}).boundary_verified,null);
});

test('the credential proxy fact is true only for a known adapter with passing evidence, false without it, null for no adapter',()=>{
  const job={requirements:{egress:'provider-only'}};
  for(const adapter of adapters()) {
    assert.equal(jobSafetyFacts(job,adapter).credential_proxy_verified,false);
    assert.equal(jobSafetyFacts(job,adapter,{credentialProxyVerified:false}).credential_proxy_verified,false);
    assert.equal(jobSafetyFacts(job,adapter,{credentialProxyVerified:true}).credential_proxy_verified,true);
    for(const bad of ['true',1,null,undefined,{}])
      assert.equal(jobSafetyFacts(job,adapter,{credentialProxyVerified:bad}).credential_proxy_verified,false);
  }
  assert.equal(jobSafetyFacts(job,null,{credentialProxyVerified:true}).credential_proxy_verified,null);
});

test('missing or invalid safety inputs stay unknown rather than becoming promises',()=>{
  const unknown={network:{mode:null,registries:null,git:null,kit_hosts:null},provider:null,provider_hosts:null,credential_in_guest:null,
    credential_proxy_verified:null,boundary_verified:null,budget_minutes:null,quota:{remaining:null}};
  assert.deepEqual(jobSafetyFacts(null),unknown);
  assert.deepEqual(jobSafetyFacts({requirements:{egress:'unknown',limits:{wall_seconds:'1200'}}},
    {spec:{credential_in_guest:'false',egress_provider_hosts:[1]},credential_proxy_verified:1}),unknown);
  assert.equal(jobSafetyFacts({requirements:{limits:{wall_seconds:0}}}).budget_minutes,null);
  assert.equal(jobSafetyFacts({requirements:{limits:{wall_seconds:Infinity}}}).budget_minutes,null);
});

const matchingProxyRecord=passingRecord(adapters()[0],{faravanVersion:'1.2.3'});
for(const [scenario,faravanVersion,sbx,expected] of [
  ['matching evidence','1.2.3',SBX_VERSION,true],
  ['a new Faravan version','1.2.4',SBX_VERSION,false],
  ['a source checkout',null,SBX_VERSION,false],
  ['a new sbx version','1.2.3','sbx version v0.48.1 5caf923e0587d376848f6f388eca3e0f5ca00e2d',false],
]) test('approval card credential proxy evidence: '+scenario,testOptions,async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root),original=backend.protectionSummary.bind(backend);
  backend.protectionSummary=async(...args)=>{const report=await original(...args);return {...report,preflight:{...report.preflight,version:sbx}};};
  const {owner,lender,circle}=await f.connect({backend,credentialProxyRecords:[matchingProxyRecord],faravanVersion});
  await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  await api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
  const ownRows=await api(owner.app,'/api/jobs');
  assert.ok(ownRows.every(row=>row.safety.credential_proxy_verified===false),'the borrower never reads the lender computer as verified');
  assert.equal(card.safety.credential_proxy_verified,expected);
});

test('REST unknown submit outcome returns the stable host key and leaves the durable intent retryable',testOptions,async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const original=owner.app.device.client.bind(owner.app.device),keys=[];
  owner.app.device.client=async(...args)=>{
    const client=await original(...args),submit=client.submitJob.bind(client);
    client.submitJob=async(payload,options)=>{
      keys.push(options.idempotencyKey);
      throw new ClientError('network_error',{status:0,retryable:true,outcome:'unknown',operationKey:options.idempotencyKey});
    };
    return client;
  };
  const body={circle:circle.id,prompt:'Write one note.',noSource:true,result:{kind:'message'},draft_id:'rest-send-1023'};
  const first=await api(owner.app,'/api/jobs',{method:'POST',body,status:503});
  assert.equal(first.outcome,'unknown');
  assert.equal(first.operationKey,keys[0]);
  const retry=await api(owner.app,'/api/jobs',{method:'POST',body,status:503});
  assert.equal(retry.outcome,'unknown');
  assert.equal(retry.operationKey,first.operationKey);
  assert.equal(keys.length,2);
  assert.equal(new Set(keys).size,1,'a retry of the original draft uses the same durable host key');
});

test('compose reports a total host outage for owned and external circles and keeps the last confirmed time',testOptions,async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const unavailable=new Map();
  for(const app of [owner.app,lender.app]){
    let online=true;
    const deviceClient=app.device.client.bind(app.device);
    app.device.client=async(...args)=>{
      const client=await deviceClient(...args);
      return new Proxy(client,{get(target,key){
        if(key==='fetchPresence')return async()=>{
          if(!online)throw new TypeError('simulated total network failure');
          return {now:new Date().toISOString(),online_seconds:90,devices:[],persons:[]};
        };
        const value=target[key];return typeof value==='function'?value.bind(target):value;
      }});
    };
    unavailable.set(app,()=>{online=false;});
  }

  const ownerCompose=await api(owner.app,'/api/circles/'+circle.id+'/compose');
  const memberCompose=await api(lender.app,'/api/circles/'+circle.id+'/compose');
  assert.deepEqual([ownerCompose.hosted,memberCompose.hosted],[true,false],
    'the outage covers the owner composer and an external host');
  assert.deepEqual([ownerCompose.host.reachable,memberCompose.host.reachable],[true,true],
    'both circles first record a successful service observation');
  assert.deepEqual([ownerCompose.presence,memberCompose.presence],['ok','ok']);
  for(const app of unavailable.values())app();

  const ownerOutage=await api(owner.app,'/api/circles/'+circle.id+'/compose');
  const memberOutage=await api(lender.app,'/api/circles/'+circle.id+'/compose');
  assert.deepEqual([ownerOutage.presence,memberOutage.presence],['unavailable','unavailable']);
  assert.deepEqual([ownerOutage.host.reachable,memberOutage.host.reachable],[false,false],
    'ownership and an external host do not turn a failed network observation into reachability');
  assert.deepEqual([ownerOutage.host.lastReachedAt,memberOutage.host.lastReachedAt],
    [ownerCompose.host.lastReachedAt,memberCompose.host.lastReachedAt],
    'the outage keeps the last confirmed host response time');
});

test('request, job list, detail and job events expose safety facts from the signed job',testOptions,async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  const signed=f.jobs.get(submitted.jobDigest).job.payload;
  const expected=jobSafetyFacts(signed,adapters()[0]);
  for(const rows of [await api(owner.app,'/api/jobs'),await api(owner.app,'/api/jobs?circle='+circle.id)]) {
    assert.deepEqual(rows.find(row=>row.job_digest===submitted.jobDigest).safety,expected);
  }
  assert.deepEqual((await api(owner.app,jobPath(submitted.jobDigest)+'?circle='+circle.id)).safety,expected);
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  assert.deepEqual(card.safety,expected);
  const keys=Object.keys(expected).sort();
  await waitFor(async()=>{
    const events=(await api(owner.app,'/api/activity')).filter(row=>row.type==='job');
    assert.ok(events.every(row=>JSON.stringify(Object.keys(row.data.safety).sort())===JSON.stringify(keys)));
    return events.some(row=>JSON.stringify(row.data.safety)===JSON.stringify(expected));
  },'signed safety facts on the job event');
  await api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
});

test('local handoff expires at 60 seconds and is consumed exactly once',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'faravan-handoff-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let now=1000;const h=createLocalHandoff({now:()=>now,sessions:await openSessionStore(join(dir,'sessions.json'),{now:()=>now})});
  const first=h.issue();now+=59999;assert.ok(await h.redeem(first));assert.equal(await h.redeem(first),null);
  const expired=h.issue();now+=60000;assert.equal(await h.redeem(expired),null);
  assert.equal(await h.redeem('not-a-code'),null);
  const evicted=h.issue();for(let i=0;i<32;i++)h.issue();assert.equal(await h.redeem(evicted),null);
});

test('handoff redirects once to a clean route with a cookie that authenticates the web app',testOptions,async t=>{
  let now=Date.now();const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args.join(' ')));
  const f=await appFixture(t),{app}=await f.start('handoff',{clock:{now:()=>now}});
  const link=app.handoffUrl(),code=new URL(link).searchParams.get('code');
  const request=(url,headers={})=>boundedFetch(url,{headers,redirect:'manual'});
  const rejected=await request(link,{origin:'https://attacker.example'});assert.equal(rejected.status,403);await rejected.text();
  assert.equal(await hostRequest(app,'attacker.example'),403);
  const wrongMethod=await boundedFetch(link,{method:'POST',redirect:'manual'});assert.equal(wrongMethod.status,401);await wrongMethod.text();
  const response=await request(link);assert.equal(response.status,302);
  assert.equal(response.headers.get('location'),'/');
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  const setCookie=response.headers.get('set-cookie'),cookie=setCookie.split(';')[0];
  assert.match(setCookie,/^faravan_local_session_[0-9a-f]+=/);
  assert.match(setCookie,/; HttpOnly; SameSite=Strict$/);
  assert.equal(setCookie.includes(app.token),false);await response.text();
  const replay=await request(link);assert.equal(replay.status,401);assert.equal(replay.headers.get('set-cookie'),null);await replay.text();
  for(const path of ['/api/status','/app.mjs','/app.css']) {
    const r=await request(app.origin+path,{cookie});assert.equal(r.status,200,path);await r.arrayBuffer();
  }
  await api(app,'/api/status',{token:null,headers:{cookie}});
  await api(app,'/api/status',{token:null,headers:{cookie:cookie+'; '+cookie},status:401});
  await api(app,'/api/status',{token:null,headers:{cookie,origin:'https://attacker.example'},status:403});
  await api(app,'/api/agents/codex',{method:'POST',token:null,headers:{cookie,origin:app.origin},body:{useForLending:true}});
  await api(app,'/api/agents/codex',{method:'POST',token:null,headers:{cookie,origin:'https://attacker.example'},body:{useForLending:false},status:403});
  const clean=await request(app.origin+'/');assert.equal(clean.headers.get('set-cookie'),null);await clean.text();
  const expired=app.handoffUrl();now+=60000;
  const old=await request(expired);assert.equal(old.status,401);await old.text();
  await api(app,'/api/status'); // API header remains supported.
  // A session token in the query string is not a credential: the API refuses it, and nothing logs a deprecation for it.
  await api(app,'/api/status?token='+encodeURIComponent(app.token),{token:null,status:401});
  const shell=await request(app.origin+'/');assert.equal(shell.status,200);await shell.text(); // the unauthenticated shell still loads
  assert.equal(logs.length,0);
  const recorded=JSON.stringify(logs)+JSON.stringify(await api(app,'/api/activity'));
  for(const secret of [app.token,code,cookie.split('=')[1]])assert.equal(recorded.includes(secret),false);
});

test('source and built bootstraps try cookie authentication without a tab token',async()=>{
  const source=await readFile(new URL('../ui/v1/src/bootstrap.mjs',import.meta.url),'utf8');
  const html=await readFile(new URL('../public/v1/index.html',import.meta.url),'utf8');
  const scripts=[source.replace('export async function','async function')+'\nbootstrap(()=>\'\', \'\', sessionRecovery);',html.match(/<script>([\s\S]*?)<\/script>/)[1]];
  for(const script of scripts) {
    const calls=[],target={textContent:'',innerHTML:'',removeAttribute(name){this.removed=name;}},head={append(link){this.link=link;}};
    await runInNewContext(script,{
      sessionRecovery,matchMedia:()=>({matches:false}),
      location:{href:'http://127.0.0.1:4100/'},history:{replaceState(){}},
      sessionStorage:{getItem(){return null;},removeItem(){}},
      document:{getElementById:()=>target,createElement:()=>({}),head},URL,Blob,
      fetch:async(path,options)=>{calls.push({path,options});return {ok:false,status:401};},
    });
    assert.equal(calls.length,1);assert.equal(calls[0].path,'/app.mjs');
    assert.equal(calls[0].options.credentials,'same-origin');
    assert.equal(calls[0].options.headers,undefined,'no session header is sent without a tab token');
    assert.match(target.innerHTML,/Reconnect to Faravan/);
    assert.match(target.innerHTML,/Open it again from Faravan on this computer/i);
    assert.doesNotMatch(target.innerHTML,/pair this device again/i);
    assert.match(head.link.href,/^blob:/);
  }
});

function manualTimers() {
  const pending = new Set();
  return {
    setTimeout(callback, milliseconds) {
      const timer = {callback, milliseconds, unref() {}};
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer) { pending.delete(timer); },
    fireAll(){for(const timer of [...pending]){pending.delete(timer);timer.callback();}},
    fire(milliseconds) {
      // The card timer is the time left on the lender's deadline, so it can be a little under the full timeout.
      const timers = [...pending].filter(timer => timer.milliseconds <= milliseconds && timer.milliseconds > milliseconds - 1000);
      assert.equal(timers.length,1,'exactly one deadline must be armed');
      for (const timer of timers) {
        pending.delete(timer);
        timer.callback();
      }
    },
  };
}

async function lendingTurns(app, matches, count=2) {
  // Identical polls deliberately have no event. Verify the state across later poll windows instead.
  for(let turn=0;turn<count;turn++) {
    await new Promise(resolve=>setTimeout(resolve,100));
    await waitFor(async()=>matches(await api(app,'/api/lending')),'stable lending state');
  }
}

const jobPath = digest => '/api/jobs/' + encodeURIComponent(digest);
test('agent run settings validate, round-trip and survive restart',testOptions,async t=>{
  const f=await appFixture(t);let peer=await f.start('run-settings');
  const route='/api/agents/codex/run', defaults={model:null,effort:null};
  assert.deepEqual((await api(peer.app,'/api/agents'))[0].run,defaults);
  for(const body of [
    {model:'',effort:null},{model:'-flag',effort:null},{model:'a b',effort:null},
    {model:"x';echo bad",effort:null},{model:'x'.repeat(81),effort:null},
    {model:'a\n',effort:null},{model:'a\r',effort:null},{model:1,effort:null},{model:null,effort:'max'},{model:null,effort:1},
    {model:null,effort:null,extra:true},{model:null},{effort:null},
    {model:null,effort:null,model_efforts:[]},{model:null,effort:null,model_efforts:[{model:'m',effort:'max'}]},
    {model:null,effort:null,model_efforts:[{model:'m',effort:'low'},{model:'m',effort:'low'}]},
    {model:null,effort:null,model_efforts:[{model:'m',effort:'low',extra:true}]},
  ]) {
    const result=await api(peer.app,route,{method:'POST',body,status:400});
    assert.equal(result.code,'invalid_request');
  }
  assert.equal((await api(peer.app,'/api/agents/unknown/run',{method:'POST',body:defaults,status:400})).code,'invalid_request');
  for(const effort of ['low','medium','high',null]) {
    const run={model:'openai/gpt-5.4_mini:latest',effort};
    const rows=await api(peer.app,route,{method:'POST',body:run});
    assert.deepEqual(rows.find(a=>a.id==='codex').run,run);
  }
  const saved={model:'a'.repeat(80),effort:'low',model_efforts:[{model:'model-one',effort:'low'},{model:'model-two',effort:'high'}]};
  await api(peer.app,route,{method:'POST',body:saved});
  assert.deepEqual(JSON.parse(await readFile(join(peer.home,'v1','app-settings.json'),'utf8')).agentRun.codex,saved);
  await bounded(peer.app.close(),'run setting restart');
  peer=await f.start('run-settings');
  assert.deepEqual((await api(peer.app,'/api/agents'))[0].run,saved);
  await api(peer.app,route,{method:'POST',body:defaults});
  assert.deepEqual((await api(peer.app,'/api/agents'))[0].run,defaults);
});
const gitInput = circle => ({circle:circle.id,git:'https://github.com/example/synthetic.git',
  commit:'1'.repeat(40),prompt:'Synthetic task: write a greeting.',harness:'codex'});
async function lendingOn(app, circle, limits = {}) {
  await api(app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,
    maxWallSeconds:1200,idleOnly:false,...limits}});
  await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
}
async function review(app) {
  return waitFor(async () => (await api(app,'/api/approvals'))[0], 'review card');
}

test('jobs without a circle merge your jobs newest first with circle labels',testOptions,async t=>{
  let time=Date.now();const clock={now:()=>time};
  const f=await appFixture(t),{owner,lender,circle}=await f.connect({clock},{clock});
  const second=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Other friends'}});
  const firstJob=await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),prompt:'First circle job.'}});
  // Sign distinct submission times before the request-scoped display snapshot reads them.
  time+=1000;
  const secondJob=await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(second),prompt:'Second circle job.'}});
  const foreign=await api(lender.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),prompt:'Someone else’s job.'}});
  // Use distinct signed-intent submission times, without sleeping or depending on clock resolution.
  const originalStore=owner.app.device.intentStore.bind(owner.app.device);
  owner.app.device.intentStore=id=>{
    const store=originalStore(id),list=store.list.bind(store);
    store.list=async()=> (await list()).map(intent=>intent.kind==='submit'?{...intent,payload:{...intent.payload,
      created_at:intent.jobDigest===firstJob.jobDigest?'2026-01-01T00:00:00Z':'2026-01-02T00:00:00Z'}}:intent);
    return store;
  };
  const displaySnapshot=owner.app.device.displaySnapshot.bind(owner.app.device);
  owner.app.device.displaySnapshot=()=>({...displaySnapshot(),intentStore:owner.app.device.intentStore});
  const scoped=await api(owner.app,'/api/jobs?circle='+circle.id);
  assert.ok(scoped.some(job=>job.job_digest===foreign.jobDigest),'explicit circle still includes other members');
  const jobs=await api(owner.app,'/api/jobs');
  assert.equal(jobs.find(job=>job.job_digest===firstJob.jobDigest).waitingTiming.submittedAt,'2026-01-01T00:00:00Z','display snapshots must use the fixture submission times');
  assert.deepEqual(jobs.map(job=>job.job_digest),[secondJob.jobDigest,firstJob.jobDigest]);
  assert.deepEqual(jobs.map(job=>job.circle),[{id:second.id,name:second.name},{id:circle.id,name:circle.name}]);
  assert.ok(jobs.every(job=>job.role==='sent'&&!job.ran));
  assert.deepEqual(sameView(jobs.map(({circle:label,role,...job})=>job)),sameView([
    ...(await api(owner.app,'/api/jobs?circle='+second.id)),
    scoped.find(job=>job.job_digest===firstJob.jobDigest),
  ]),'aggregate preserves existing job projections');
  assert.deepEqual(sameView(await api(owner.app,'/api/jobs?circle='+circle.id)),sameView(scoped),'explicit circle is unchanged');
});

test('jobs without a circle are empty before submitting any jobs',testOptions,async t=>{
  const f=await appFixture(t),{app}=await f.start();
  assert.deepEqual(await api(app,'/api/jobs'),[]);
});


test('aggregate jobs include running and completed lender work without widening per-job views',testOptions,async t=>{
  const f=await admissionFixture(t,{hold:true}),{owner,lender,circle}=await f.connect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  assert.deepEqual(await api(lender.app,'/api/jobs'),[],'reviewing is not running');
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'held execution');
  const assertRows=async app=>{
    const rows=await api(app,'/api/jobs');
    assert.equal(rows.length,1);
    const {role,ran,circle:label,...view}=rows[0];
    assert.equal(role,'ran');assert.equal(ran,true);
    assert.deepEqual(label,{id:circle.id,name:circle.name});
    assert.deepEqual(sameView(view),sameView(await api(app,jobPath(submitted.jobDigest)+'?circle='+circle.id)));
    assert.ok(view.historyIdentity.author,'signed requester identity reaches the list');
    assert.equal(view.local,undefined,'no borrowed prompt metadata');
    assert.equal(view.job,undefined);assert.equal(view.result,undefined);
    return rows[0];
  };
  assert.equal((await assertRows(lender.app)).state,'claimed');
  assert.equal((await api(owner.app,'/api/jobs'))[0].role,'sent');
  lender.backend.release();
  await waitFor(()=>f.jobs.get(submitted.jobDigest).state==='result-accepted','lender completion');
  assert.equal((await assertRows(lender.app)).state,'result-accepted');
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  await bounded(lender.app.close(),'restart lender history');
  const restarted=await f.start('lender',{resumeLending:false});
  await assertRows(restarted.app);
  // A later attempt by another device must not erase this device's durable run history.
  const attempt=f.jobs.get(submitted.jobDigest).current_attempt;
  Object.assign(attempt,{holder:owner.app.device.keyId,generation:attempt.generation+1,attempt_id:randomUUID()});
  await assertRows(restarted.app);
});

test('aggregate jobs deduplicate self-run work with sent winning',testOptions,async t=>{
  const f=await admissionFixture(t),{owner,circle}=await f.connect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(owner.app,circle);
  await waitFor(()=>f.jobs.get(submitted.jobDigest).state==='result-accepted','self-run completion');
  assert.deepEqual(await api(owner.app,'/api/approvals'),[]);
  assert.ok((await api(owner.app,'/api/activity?after=0')).some(e=>e.type==='approval'&&e.data.auto==='own job'));
  const rows=await api(owner.app,'/api/jobs');
  assert.equal(rows.length,1);assert.equal(rows[0].job_digest,submitted.jobDigest);
  assert.equal(rows[0].role,'sent');assert.equal(rows[0].ran,true);
  const {role,ran,circle:label,...view}=rows[0];
  assert.deepEqual(sameView(await api(owner.app,'/api/jobs?circle='+circle.id)),sameView([view]));
});

test('default allowance and status readers use the fresh local ledger without probing',testOptions,async t=>{
  const time=Date.now(),reset=time+86400000,observedAt=time-1000;
  const f=await appFixture(t),ledger=createLendingLedger({file:join(f.root,'allowance-meter-ledger.json'),now:()=>time});
  // Populate the same production ledger a completed probe writes, not the observing reader seam.
  ledger.recordReadings('claude',[{window_id:'seven_day',window_minutes:10080,state:'open',used_pct:29,
    resets_at:reset,observed_at:observedAt,source:'probe'}]);
  let externalReads=0;
  const unexpectedRead=()=>{externalReads++;assert.fail('fresh local status must not launch an external quota reader');};
  const {app}=await f.start('owner',{quotaReader:undefined,quotaSpawn:unexpectedRead,
    lendingReadings:undefined,lendingLedger:ledger,lendingProbeRunner:unexpectedRead});
  await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  const home=await api(app,'/api/home');
  assert.deepEqual(home.allowance,{provider:'claude',remaining:71,observedAt,resetsAt:reset});
  assert.equal(home.lendingPolicy.accounts[0].readings[0].used_pct,29);
  assert.equal(externalReads,0,'fresh allowance and status must both use the normal local ledger');
});

test('explicit null quota reader remains unavailable without spawning clawmeter',testOptions,async t=>{
  const f=await appFixture(t),{app}=await f.start('owner',{quotaReader:null,quotaSpawn:()=>assert.fail('explicit null must not spawn')});
  await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  assert.equal((await api(app,'/api/home')).allowance,null);
});

test('the review card of an uploaded-files job carries no file count: the code is fetched only after the yes', testOptions, async t => {
  const f = await appFixture(t), {owner,lender,circle} = await f.connect();
  const file = (path,text) => ({path,base64:Buffer.from(text).toString('base64')});
  await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Count the files.',harness:'codex',
    files:[file('README.md','one\n'),file('src/a.js','two\n'),file('src/b.js','three\n')]}});
  await lendingOn(lender.app,circle);
  const card = await review(lender.app);
  assert.equal(card.source.kind,'archive');
  assert.equal(card.sourceFiles,null);
  // Offer, then accept: until the yes, the lender has read the prompt and nothing else from the artifact store.
  assert.equal(lender.phases.filter(p=>p==='fetchArtifact:begin').length,1,'only the prompt was fetched before the yes');
  await api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
});

test('local app binds loopback, authenticates requests, rejects rebinding and sends no CORS headers', testOptions, async t => {
  const f = await appFixture(t), {app} = await f.start();
  assert.equal(app.server.address().address,'127.0.0.1');
  await api(app,'/api/status',{token:null,status:401});
  await api(app,'/api/status',{token:'wrong-session-token',status:401});
  assert.equal(await hostRequest(app,'attacker.example'),403);
  assert.equal(await hostRequest(app,'127.0.0.1.attacker.example'),403);
  const response = await boundedFetch(app.origin + '/api/status', {headers: {'x-faravan-session-token': app.token}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  await response.arrayBuffer();
  const circles = await api(app,'/api/circles');
  assert.ok(circles.some(c => c.name === 'My devices'));
  const device = await api(app,'/api/devices');
  assert.ok(JSON.stringify(device).includes('sha256:'));
  const agents = await api(app,'/api/agents');
  assert.equal(agents.length,1);
  assert.ok(JSON.stringify(agents).includes('codex'));
});

test('two synthetic apps create, invite, join and approve without logging invite seeds', testOptions, async t => {
  const logs = [];
  for (const name of ['log','info','warn','error','debug']) t.mock.method(console,name,(...args) => logs.push(args));
  const f = await appFixture(t), {owner,lender,circle,invite,pending} = await f.connect();
  assert.equal(pending[0].state,'pending');
  const roster = f.circles.get(circle.id).roster.payload;
  assert.equal(roster.members.length,2);
  assert.equal((await api(owner.app,'/api/circles/' + circle.id + '/approvals')).length,0);
  assert.ok((await api(lender.app,'/api/circles')).some(c => c.id === circle.id));
  // The app hands out the short link; the seed is its fragment.
  const decoded = p.decodeShortLink(invite);
  assert.equal(decoded.ok,true);
  const seed = Buffer.from(decoded.seed,'base64url');
  const recorded = JSON.stringify(logs) + JSON.stringify(await api(owner.app,'/api/activity?after=0'));
  for (const secret of [invite,seed.toString('hex'),seed.toString('base64url')]) {
    assert.ok(!recorded.includes(secret),'invite material must not appear in logs or activity');
  }
  assert.ok(!JSON.stringify(f.rawRequests).includes(decoded.seed),'the coordinator never sees the seed');
});

test('joining an approved circle starts an already requested lender without failing enrollment',testOptions,async t=>{
  const f=await appFixture(t),owner=await f.start('owner'),lender=await f.start('lender');
  await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Approved circle'}});
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{}});
  assert.equal((await api(lender.app,'/api/status')).intent.on,true);
  await api(lender.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
  await api(lender.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  const state=await waitFor(async()=>{const status=await api(lender.app,'/api/status');
    return status.activeCircle===circle.id&&status.lending.enabled&&status;},'lending starts after enrollment approval');
  assert.equal(state.intent.on,true);
  assert.equal(Object.hasOwn(state,'lendingStartFailed'),false);
});

test('failed automatic lender start keeps membership and exposes only a retryable safe cause',testOptions,async t=>{
  const f=await appFixture(t),owner=await f.start('owner'),lender=await f.start('lender');
  await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Safe circle name'}});
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{}});
  await api(lender.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  const client=lender.app.device.lendingClient.bind(lender.app.device);
  lender.app.device.lendingClient=async id=>{
    if(id===circle.id)throw Object.assign(new Error('private transport detail'),{code:'circle_unreachable'});
    return client(id);
  };
  await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
  const checked=await api(lender.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  assert.equal(checked.state,'approved');
  assert.equal(checked.membershipProjection.phase,'approved');
  const status=await api(lender.app,'/api/status');
  assert.ok((await api(lender.app,'/api/circles')).some(item=>item.id===circle.id),'successful membership is retained');
  assert.deepEqual(status.lendingStartFailed,{code:'circle_unreachable',circleName:'Safe circle name',action:'retry'});
  assert.deepEqual(status.attention.find(item=>item.action==='retry'),
    {label:'Lending could not start in Safe circle name.',remedy:'Retry lending start.',action:'retry'});
  assert.doesNotMatch(JSON.stringify(status.lendingStartFailed),/private transport detail/);
});

test('folder submit uploads bounded source, returns closed status vocabulary, and cancel is signed', testOptions, async t => {
  const f = await appFixture(t), {owner,circle} = await f.connect();
  const folder = join(f.root,'synthetic-source');
  await mkdir(folder);
  await writeFile(join(folder,'README.md'),'Synthetic source only.\n');
  const submitted = await api(owner.app,'/api/jobs',{method:'POST',body:{
    circle:circle.id,files:[{path:'README.md',base64:Buffer.from('Synthetic source only.\n').toString('base64')}],prompt:'Review this synthetic source.',harness:'codex'}});
  assert.match(submitted.jobDigest,/^sha256:[0-9a-f]{64}$/);
  const view = f.jobs.get(submitted.jobDigest);
  assert.equal(view.job.payload.source.kind,'archive');
  const packed = f.artifacts.get(view.job.payload.source.artifact.digest);
  assert.ok(gunzipSync(packed).includes(Buffer.from('Synthetic source only.')));
  const detail = await api(owner.app,jobPath(submitted.jobDigest));
  assert.equal(detail.status,'Waiting');
  const jobs = await api(owner.app,'/api/jobs?circle=' + circle.id);
  assert.ok(jobs.some(job => job.job_digest === submitted.jobDigest));
  const cancelled = await api(owner.app,jobPath(submitted.jobDigest) + '/cancel',{method:'POST',body:{}});
  assert.equal(cancelled.authority_revoked,true);
  assert.equal((await api(owner.app,jobPath(submitted.jobDigest))).status,'Cancelled');
  assert.equal(f.requests.filter(r => r.route.endsWith('/cancel')).length,1);
});

test('ask-each-time review accepts one real signed journey through the injected fake backend', testOptions, async t => {
  const f = await admissionFixture(t), {owner,lender,circle} = await f.connect();
  const submitted = await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card = await review(lender.app);
  assert.equal(card.jobDigest,submitted.jobDigest);
  assert.ok(Number.isFinite(card.expiresAt));
  assert.ok(card.expiresAt > Date.now());
  assert.equal(card.prompt,'Synthetic task: write a greeting.');
  assert.equal(card.harness,'codex');
  assert.ok(card.requester);
  assert.ok(card.source);
  assert.equal(card.runtimeSeconds,1200);
  assert.equal(card.network,'internet');
  assert.equal(lender.backend.calls.filter(([kind]) => kind === 'run').length,0);
  await api(lender.app,'/api/approvals/' + card.id + '/accept',{method:'POST',body:{}});
  await waitFor(() => f.jobs.get(submitted.jobDigest).state === 'result-accepted', 'signed result acceptance');
  const detail = await api(owner.app,jobPath(submitted.jobDigest));
  assert.equal(detail.status,'Finished');
  // After acceptance the lender still reports that its compute stopped; the next step shows once that is done.
  await waitFor(async () => (await api(lender.app,'/api/home')).lending?.status !== 'sending-result', 'lender done sending');
  const home=await api(lender.app,'/api/home'),lentJobs=await api(lender.app,'/api/jobs?circle='+circle.id);
  const next=contributorNextStep({home,circles:await api(lender.app,'/api/circles'),
    lending:home.lending,agents:await api(lender.app,'/api/agents'),
    readiness:await api(lender.app,'/api/readiness?refresh=true'),jobs:lentJobs,deviceKey:lender.app.device.keyId});
  assert.equal(next?.id,'result_delivered',JSON.stringify({home,lentJobs}));
  assert.equal(next.action.id,submitted.jobDigest);
  assert.equal(lender.backend.calls.filter(([kind]) => kind === 'run').length,1);
  assert.equal(lender.backend.calls.filter(([kind]) => kind === 'destroy').length,1);
  assert.equal((await api(lender.app,'/api/approvals')).length,0);
  const resultResponse = await boundedFetch(owner.app.origin + jobPath(submitted.jobDigest) + '/result?circle=' + circle.id,
    {headers:{'x-faravan-session-token':owner.app.token}});
  assert.equal(resultResponse.status,200);
  assert.equal(resultResponse.headers.get('content-type'),'application/zip');
  assert.match(resultResponse.headers.get('content-disposition'),/\.zip"/);
  assertStoredZip(Buffer.from(await resultResponse.arrayBuffer()),'summary.txt','Synthetic verified result\n');
  const transcript = await api(owner.app,jobPath(submitted.jobDigest) + '/transcript?circle=' + circle.id);
  assert.ok(transcript.text.includes('turn.completed'));
  const opened = await api(owner.app,jobPath(submitted.jobDigest) + '/open-folder',{method:'POST',
    body:{circle:circle.id,out:'verified-result'}});
  assert.equal(await readFile(join(opened.path,'summary.txt'),'utf8'),'Synthetic verified result\n');
});

test('hiding an offer leaves its job queued without any attempt or source execution',testOptions,async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});await lendingOn(lender.app,circle);
  const card=await review(lender.app);assert.equal(card.offer,true);assert.equal(f.jobs.get(submitted.jobDigest).current_attempt,null);
  await api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
  await waitFor(async()=>!(await api(lender.app,'/api/approvals')).length,'offer hidden');
  assert.equal(f.jobs.get(submitted.jobDigest).state,'queued');assert.equal(f.jobs.get(submitted.jobDigest).current_attempt,null);
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);
  assert.equal(f.requests.some(r=>r.route.endsWith('/release')||r.route.endsWith('/claim')),false);
});

test('daily job limits reject later work before approval and execution', testOptions, async t => {
  const f = await admissionFixture(t), {owner,lender,circle} = await f.connect();
  const first = await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle,{dailyJobs:1});
  const card = await review(lender.app);
  await api(lender.app,'/api/approvals/' + card.id + '/accept',{method:'POST',body:{}});
  await waitFor(() => f.jobs.get(first.jobDigest).state === 'result-accepted', 'first completion');
  const second = await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),prompt:'Second synthetic task.'}});
  await waitFor(async () => (await api(lender.app,'/api/lending')).status === 'limit-reached', 'preclaim daily limit');
  const home=await api(lender.app,'/api/home');
  assert.equal(home.intent.state,'resting');
  assert.equal(home.intent.reason,'daily_limit');
  await lendingTurns(lender.app,state=>state.status==='limit-reached');
  const waiting = f.jobs.get(second.jobDigest);
  assert.equal(waiting.state,'queued');
  assert.equal(waiting.current_attempt,null);
  assert.equal(waiting.attempts_started,0);
  assert.equal(lender.backend.calls.filter(([kind]) => kind === 'run').length,1);
  assert.equal((await api(lender.app,'/api/approvals')).length,0);
  const events = await api(lender.app,'/api/activity?after=0');
  assert.ok(JSON.stringify(events).includes('limit-reached'));
});

test('SSE replays ordered event ids consistently with bounded polling', testOptions, async t => {
  const f = await appFixture(t), {owner} = await f.connect();
  await api(owner.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(owner.app,'/api/agents/codex',{method:'POST',body:{useForLending:false}});
  const events = await api(owner.app,'/api/activity?after=0');
  assert.ok(events.length >= 2);
  const ids = events.map(event => event.id);
  assert.ok(ids.every((id,index) => Number.isSafeInteger(id) && (!index || id > ids[index-1])));
  const after = ids[0];
  const newer = await api(owner.app,'/api/activity?after=' + after);
  assert.deepEqual(newer.map(event => event.id), ids.filter(id => id > after));
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(),WAIT_MS);
  let reader;
  try {
    const response = await fetch(owner.app.origin + '/api/events?after=0', {
      headers:{'x-faravan-session-token':owner.app.token},signal:controller.signal});
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/^text\/event-stream/);
    reader = response.body.getReader();
    let text = '';
    const received = [];
    while (received.length < events.length) {
      const chunk = await reader.read();
      assert.equal(chunk.done,false,'stream closed before replay completed');
      text += Buffer.from(chunk.value).toString('utf8');
      let boundary;
      while ((boundary = text.indexOf('\n\n')) >= 0) {
        const frame = text.slice(0,boundary);
        text = text.slice(boundary+2);
        const id = /^id: ?(\d+)$/m.exec(frame);
        if (id) received.push(Number(id[1]));
      }
    }
    assert.deepEqual(received.slice(0,ids.length),ids);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
});

test('readiness reports actionable preflight remedies without raw exception stacks', testOptions, async t => {
  const f = await appFixture(t), backend = syntheticBackend(f.root);
  backend.probeCapabilities = async () => ({available:false,preflight:{ok:false,checks:[
    {name:'sandbox',ok:false,detail:'Docker Sandboxes is unavailable.',fix:'Install Docker Sandboxes.'}]}});
  const {app} = await f.start('owner',{backend});
  const report = await api(app,'/api/readiness?refresh=true');
  const text = JSON.stringify(report);
  assert.ok(text.includes('Install Docker Sandboxes.'));
  assert.ok(!text.includes('at ' + import.meta.url));
  backend.probeCapabilities = async () => {throw new Error('PRIVATE_EXCEPTION_SENTINEL');};
  const failure = JSON.stringify(await api(app,'/api/readiness?refresh=true'));
  assert.ok(!failure.includes('PRIVATE_EXCEPTION_SENTINEL'));
  assert.ok(!failure.includes('Error:'));
});

test('readiness never sends a person to a terminal for what the app repairs or signs in itself', testOptions, async t => {
  const f = await appFixture(t), backend = syntheticBackend(f.root);
  backend.probeCapabilities = async () => ({available:false,preflight:{ok:false,checks:[
    {name:'sbx_daemon',ok:false,detail:'The sandbox service is not running yet.',fix:'sbx daemon stop && sbx daemon start --detach && sbx diagnose',automatic:true},
    {name:'network_policy',ok:false,detail:'Waits for the Docker sign-in.',fix:'Sign in to Docker. Faravan then sets the sandbox network policy by itself.',automatic:true,waitsFor:'docker_login'},
    {name:'docker_login',ok:false,detail:"The sandbox service isn't signed in to Docker yet.",fix:'sbx login'},
    {name:'kvm_access',ok:false,detail:'sbx reported KVM error.',fix:'sudo usermod -aG kvm $USER && newgrp kvm'}]}});
  const {app} = await f.start('owner',{backend});
  const readiness = await api(app,'/api/readiness?refresh=true');
  const checks = Object.fromEntries(readiness.checks.map(c => [c.name, c.remedy]));
  assert.equal(readiness.ready,false,'Docker sign-in failure blocks readiness');
  assert.equal(readiness.checks.find(c=>c.name==='docker_login').ok,false);
  assert.equal(checks.sbx_daemon,'', 'a repair that is running leaves the person nothing to do');
  assert.equal(checks.network_policy,'Waits for the Docker sign-in.');
  assert.equal(checks.docker_login,'Choose Sign in to Docker.');
  assert.doesNotMatch(JSON.stringify(readiness),/sbx login/);
  assert.match(checks.kvm_access,/usermod/,'a step only the person can do keeps its command');
});









test('archive jobs materialize verified folder contents before the fake execution', testOptions, async t => {
  const f = await admissionFixture(t), {owner,lender,circle} = await f.connect();
  const files = [{path:'README.md',base64:Buffer.from('Synthetic materialization proof.\n').toString('base64')}];
  const job = await api(owner.app,'/api/jobs',{method:'POST',body:{
    circle:circle.id,files,prompt:'Read the synthetic README.',harness:'codex'}});
  await lendingOn(lender.app,circle);
  const card = await review(lender.app);
  assert.equal(card.source.kind,'archive');
  await api(lender.app,'/api/approvals/' + card.id + '/accept',{method:'POST',body:{}});
  await waitForResult(f,{owner,lender,circle},job.jobDigest,'archive completion');
  assert.ok(lender.backend.calls.some(([kind,text]) => kind === 'source' && text === 'Synthetic materialization proof.\n'));
  assert.equal(lender.backend.calls.filter(([kind]) => kind === 'clone').length,0);
});

test('borrower deadline closes an offer without claiming or releasing it', testOptions, async t => {
  const approvalTimers=manualTimers();
  const f = await appFixture(t), {owner,lender,circle} = await f.connect({approvalTimers});
  const job = await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle,{approvalTimeoutMs:60000});
  const card=await review(lender.app);
  assert.equal(card.jobDigest,job.jobDigest);
  assert.equal(lender.backend.calls.filter(([kind]) => kind === 'run').length,0);
  assert.ok(Number.isFinite(card.expiresAt));
  assert.equal(card.expiresAt,Date.parse(f.jobs.get(job.jobDigest).job.payload.expires_at));
  approvalTimers.fireAll();
  await waitFor(async()=>!(await api(lender.app,'/api/approvals')).length,'expired offer closed');
  assert.equal(f.jobs.get(job.jobDigest).current_attempt,null);
  assert.ok((await api(lender.app,'/api/activity?after=0')).some(e=>e.type==='approval'&&e.data.id===card.id&&e.data.state==='expired'));
  assert.equal((await api(lender.app,'/api/approvals')).length,0);
  assert.equal(lender.backend.calls.filter(([kind]) => kind === 'run').length,0);
});

test('base64 upload accepts safe file paths and rejects traversal and excessive file counts', testOptions, async t => {
  const f = await appFixture(t), {owner,circle} = await f.connect();
  const base = {circle:circle.id,prompt:'Synthetic uploaded task.',harness:'codex'};
  await api(owner.app,'/api/jobs',{method:'POST',body:{...base,files:[{path:'../escape.txt',base64:'eA=='}]},status:400});
  await api(owner.app,'/api/jobs',{method:'POST',body:{...base,files:Array.from({length:1001},(_,i)=>({path:'file-'+i,base64:''}))},status:400});
  const job = await api(owner.app,'/api/jobs',{method:'POST',body:{...base,
    files:[{path:'nested/README.md',base64:Buffer.from('Synthetic upload.\n').toString('base64')}]}});
  const artifact = f.jobs.get(job.jobDigest).job.payload.source.artifact;
  assert.ok(gunzipSync(f.artifacts.get(artifact.digest)).includes(Buffer.from('Synthetic upload.')));
});

test('targeted approvals isolate devices and rejected enrollments remain rejected after restart', testOptions, async t => {
  const f = await appFixture(t);
  let owner = await f.start('owner');
  const first = await f.start('first'), second = await f.start('second');
  await f.provisionFromHome('owner');
  const circle = await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Selective synthetic circle'}});
  const enrollments = [];
  for (const device of [first,second]) {
    const {invite} = await api(owner.app,'/api/circles/' + circle.id + '/invite',{method:'POST',body:{}});
    const joined = await api(device.app,'/api/circles/join',{method:'POST',body:{link:invite}});
    enrollments.push(joined.enrollment.enrollment_id);
  }
  assert.equal((await api(owner.app,'/api/circles/' + circle.id + '/approvals')).length,2);
  await api(owner.app,'/api/circles/' + circle.id + '/approve',{method:'POST',body:{enrollmentId:enrollments[0]}});
  const remaining = await api(owner.app,'/api/circles/' + circle.id + '/approvals');
  assert.deepEqual(remaining.map(value => value.enrollment_id),[enrollments[1]]);
  assert.equal(f.circles.get(circle.id).roster.payload.members.length,2);
  const rejected = await api(owner.app,'/api/circles/' + circle.id + '/reject',{method:'POST',body:{enrollmentId:enrollments[1]}});
  assert.equal(rejected.local_only,true);
  await bounded(owner.app.close(),'restart app close');
  owner = await f.start('owner');
  assert.deepEqual(await api(owner.app,'/api/circles/' + circle.id + '/approvals'),[]);
  const bulk = await api(owner.app,'/api/circles/' + circle.id + '/approve',{method:'POST',body:{}});
  assert.deepEqual(bulk.approved,[]);
  const refused = await api(owner.app,'/api/circles/' + circle.id + '/approve',{
    method:'POST',body:{enrollmentId:enrollments[1]},status:409});
  assert.equal(refused.code,'enrollment_rejected');
  assert.equal(f.circles.get(circle.id).roster.payload.members.length,2);
});

test('leaving stops active lending before forgetting the circle and does not cancel another borrower', testOptions, async t => {
  const f = await admissionFixture(t,{hold:true}), {owner,lender,circle} = await f.connect();
  const job = await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  const cancel = lender.backend.cancel.bind(lender.backend);
  let circlePresentAtStop = false;
  lender.backend.cancel = async handle => {
    circlePresentAtStop = lender.app.device.selectCircle(circle.id).id === circle.id;
    return cancel(handle);
  };
  await lendingOn(lender.app,circle);
  const card = await review(lender.app);
  await api(lender.app,'/api/approvals/' + card.id + '/accept',{method:'POST',body:{}});
  await waitFor(() => lender.backend.calls.some(([kind]) => kind === 'run'), 'held fake execution');
  const left = await api(lender.app,'/api/circles/' + circle.id + '/leave',{method:'POST',body:{}});
  assert.equal(left.left,true);
  assert.equal(left.rosterMembershipUnchanged,true);
  assert.equal(circlePresentAtStop,true);
  assert.equal(f.jobs.get(job.jobDigest).current_attempt.compute_stopped,true);
  assert.equal(lender.backend.calls.filter(([kind]) => kind === 'destroy').length,1);
  assert.ok(!(await api(lender.app,'/api/circles')).some(value => value.id === circle.id));
  assert.equal(f.requests.filter(request => request.route.endsWith('/cancel')).length,0);
  assert.equal(f.circles.get(circle.id).roster.payload.members.length,2);
});

test('owner removal publishes a signed roster update without removing its own identity', testOptions, async t => {
  const f = await appFixture(t), {owner,lender,circle} = await f.connect();
  const before = f.circles.get(circle.id).roster.payload.epoch;
  await api(owner.app,'/api/circles/' + circle.id + '/remove-member',{method:'POST',body:{keyId:lender.app.device.keyId}});
  const roster = f.circles.get(circle.id).roster.payload;
  assert.equal(roster.epoch,before+1);
  assert.deepEqual(roster.members.map(member => member.key_id),[owner.app.device.keyId]);
  const refused = await api(owner.app,'/api/circles/' + circle.id + '/remove-member',{
    method:'POST',body:{keyId:owner.app.device.keyId},status:409});
  assert.equal(refused.code,'cannot_remove_self');
});

function assertStoredZip(zip, name, content) {
  assert.equal(zip.readUInt32LE(0),0x04034b50);
  assert.equal(zip.readUInt16LE(8),0,'ZIP entry uses the store method');
  const nameLength = zip.readUInt16LE(26), extraLength = zip.readUInt16LE(28);
  assert.equal(zip.subarray(30,30+nameLength).toString(),name);
  const length = zip.readUInt32LE(22), start = 30+nameLength+extraLength;
  const data = zip.subarray(start,start+length);
  assert.equal(data.toString(),content);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit=0;bit<8;bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  assert.equal(zip.readUInt32LE(14),(crc ^ 0xffffffff) >>> 0);
  assert.equal(zip.readUInt32LE(start+length),0x02014b50,'central directory follows the data');
  assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length-12),1);
}

function unsafeCandidate({name='summary.txt',type='0',link=''} = {}) {
  const tar = gunzipSync(resultArchive());
  tar.fill(0,0,100);tar.write(name,0,100);
  tar.write(type,156);tar.fill(0,157,257);tar.write(link,157,100);
  tar.fill(32,148,156);
  const sum = tar.subarray(0,512).reduce((value,byte) => value+byte,0);
  tar.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
  return gzipSync(tar);
}

test('verified downloads create deterministic ZIPs and preserve patches with fixed safe filenames', testOptions, async () => {
  const options = {mediaType:'application/gzip',jobId:'sha256:'+'a'.repeat(64)};
  const first = await prepareResultDownload(resultArchive(),options);
  const second = await prepareResultDownload(resultArchive(),options);
  assert.equal(first.contentType,'application/zip');
  assert.equal(first.filename,'faravan-'+'a'.repeat(64)+'.zip');
  assert.deepEqual(first.bytes,second.bytes);
  assertStoredZip(first.bytes,'summary.txt','Synthetic verified result\n');
  const patch = Buffer.from('--- a/example\n+++ b/example\n@@ -1 +1 @@\n-old\n+new\n');
  const result = await prepareResultDownload(patch,{mediaType:'text/x-diff',jobId:'bad\r\nheader'});
  assert.deepEqual(result.bytes,patch);
  assert.equal(result.contentType,'text/x-diff');
  assert.match(result.filename,/^[A-Za-z0-9_-]+\.patch$/);
});

test('result conversion rejects traversal, links and input, expansion and entry-limit violations', testOptions, async () => {
  const options = {mediaType:'application/gzip'};
  await assert.rejects(prepareResultDownload(unsafeCandidate({name:'../escape.txt'}),options));
  await assert.rejects(prepareResultDownload(unsafeCandidate({type:'2',link:'target'}),options));
  await assert.rejects(prepareResultDownload(resultArchive(),{...options,maxInputBytes:1}),{code:'result_too_large'});
  await assert.rejects(prepareResultDownload(resultArchive(),{...options,maxBytes:1}));
  await assert.rejects(prepareResultDownload(resultArchive(),{...options,maxFiles:0}));
  await assert.rejects(prepareResultDownload(resultArchive(),{...options,maxBytes:65*1024*1024}),{code:'invalid_result_limit'});
});

test('a stale offer decline does not create a local decline receipt', testOptions, async t => {
  const f=await admissionFixture(t),{owner,lender,circle}=await f.connect();
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  const original=lender.app.device.client.bind(lender.app.device);
  lender.app.device.client=async (...args)=>{
    const client=await original(...args);
    return new Proxy(client,{get(target,key){return key==='declineJob'?async()=>({job_digest:sent.jobDigest,declined:false}):target[key];}});
  };
  const result=await api(lender.app,'/api/approvals/'+card.id+'/decline',{method:'POST',body:{},status:409});
  assert.equal(result.code,'job_taken');
  assert.equal((await api(lender.app,'/api/decisions')).events.some(row=>row.jobDigest===sent.jobDigest&&row.decision==='decline'),false);
  await api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
});

test('a lost decline reply and refused retry keep competing decisions closed', testOptions, async t => {
  const f=await admissionFixture(t),{owner,declining:lender,circle}=await f.realConnect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),send_anyway:true}});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  assert.equal(card.offer,true);
  const original=lender.app.device.client.bind(lender.app.device), keys=[];
  lender.app.device.client=async (...args)=>{
    const client=await original(...args);
    return new Proxy(client,{get(target,property){
      if(property!=='declineJob')return target[property];
      return async (digest,options)=>{
        assert.equal(digest,submitted.jobDigest);
        assert.equal(typeof options.idempotencyKey,'string');
        keys.push(options.idempotencyKey);
        if(keys.length===2)return {job_digest:'0'.repeat(64),declined:true};
        if(keys.length===3)return {job_digest:digest,declined:false};
        if(keys.length===4)throw Object.assign(Error('fixture retry refused'),{code:'job_taken',status:409,outcome:'not_applied'});
        const acknowledged=await target.declineJob(digest,options);
        assert.equal(acknowledged.declined,true);
        if(keys.length===1)throw Object.assign(Error('fixture lost the acknowledgement'),{status:500});
        return acknowledged;
      };
    }});
  };
  const answer=(verb,status=200)=>api(lender.app,'/api/approvals/'+card.id+'/'+verb,{method:'POST',body:{},status});
  await answer('decline',500);
  assert.equal((await api(owner.app,jobPath(submitted.jobDigest))).declined_count,1);
  await answer('decline',502);
  assert.equal((await api(lender.app,'/api/decisions')).events.some(row=>row.jobDigest===submitted.jobDigest&&row.decision==='decline'),false);
  for(let retry=0;retry<2;retry++){
    const refused=await answer('decline',409);
    assert.equal(refused.code,'job_taken');
    assert.equal(refused.outcome,'unknown');
    assert.equal(refused.operationKey,keys[0]);
  }
  assert.equal((await answer('skip',409)).code,'approval_decided');
  assert.equal((await answer('accept',409)).code,'approval_decided');
  await answer('decline');
  assert.equal(keys.length,5);
  assert.equal(new Set(keys).size,1,'all attempts resolve the same decline operation');
  assert.equal((await api(owner.app,jobPath(submitted.jobDigest))).declined_count,1);
  const log=await api(lender.app,'/api/decisions');
  assert.equal(log.events.filter(row=>row.jobDigest===submitted.jobDigest&&row.decision==='decline').length,1);
});

test('legacy review Decline reaches the coordinator and prevents re-offer', testOptions, async t => {
  const f=await admissionFixture(t),{owner,declining,circle,realRequests}=await f.realConnect();
  const original=declining.app.device.lendingClient.bind(declining.app.device);
  declining.app.device.lendingClient=async (...args)=>{
    const client=await original(...args);
    return new Proxy(client,{get(target,key){return key==='listJobs'?undefined:target[key];}});
  };
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),send_anyway:true}});
  await lendingOn(declining.app,circle);
  const card=await review(declining.app);
  assert.equal(card.legacyHold,true);
  await api(declining.app,'/api/approvals/'+card.id+'/decline',{method:'POST',body:{}});
  await waitFor(()=>realRequests.some(row=>row.device===declining.app.device.keyId&&row.route.endsWith('/release')),'decline reaches coordinator');
  const job=await waitFor(async()=>{const value=await api(owner.app,jobPath(submitted.jobDigest));return value.state==='queued'&&value;},'released job');
  assert.equal(job.declined_count,1);
  const client=await original(circle.id),offers=[];
  for await(const offer of client.listOffers({waitSeconds:0}))offers.push(offer);
  assert.equal(offers.some(offer=>offer.job_digest===submitted.jobDigest),false);
});

test('real store preserves a declined job for a second eligible lender without consuming execution attempts', testOptions, async t => {
  const f = await admissionFixture(t), peers = await f.realConnect();
  const {owner,lender,circle,realRequests}=peers;
  let time=Date.now();
  await bounded(peers.declining.app.close(),'install decline clock');
  const declining=await f.start('declining',{clock:{now:()=>time}});
  const submitted = await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),send_anyway:true}});
  await lendingOn(declining.app,circle);
  const card = await review(declining.app);
  await api(declining.app,'/api/approvals/' + card.id + '/skip',{method:'POST',body:{}});
  await waitFor(async () => (await api(owner.app,jobPath(submitted.jobDigest))).state === 'queued', 'real-store decline release');
  time+=3300;
  assert.equal(realRequests.some(request=>request.device===declining.app.device.keyId&&request.route.endsWith('/jobs/claim-next')),false,'local hide sends no claim');
  const queued = await api(owner.app,jobPath(submitted.jobDigest));
  assert.equal(queued.state,'queued');
  assert.equal(queued.attempts_started,0);
  assert.equal((await api(declining.app,'/api/approvals')).length,0);
  assert.equal(declining.backend.calls.filter(([kind]) => kind === 'run').length,0);
  const attempts = realRequests.filter(request => request.device === declining.app.device.keyId && request.route.endsWith('/jobs/claim-next'));
  assert.ok(attempts.length <= 2,'decline must back off rather than spin on the queue');
  await lendingOn(lender.app,circle);
  const eligible = await review(lender.app);
  assert.equal(eligible.jobDigest,submitted.jobDigest);
  await api(lender.app,'/api/approvals/' + eligible.id + '/accept',{method:'POST',body:{}});
  const finished = await waitForResult(f,{owner,lender,circle},submitted.jobDigest,'real-store second lender result');
  assert.equal(finished.attempts_started,1);
  assert.equal(queued.current_attempt,null);assert.equal(finished.current_attempt.generation,1,'preview and hide consumed no attempt generation');
  assert.equal(finished.current_attempt.holder,lender.app.device.keyId);
  assert.ok(finished.current_attempt.execution_started_at);
  assert.equal(lender.backend.calls.filter(([kind]) => kind === 'run').length,1);
});

test('real-store exhausted daily budget does not claim or drain unrelated queued jobs', testOptions, async t => {
  const f = await admissionFixture(t), {owner,lender,circle,realRequests} = await f.realConnect();
  const first = await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),send_anyway:true}});
  await lendingOn(lender.app,circle,{dailyJobs:1});
  const card = await review(lender.app);
  await api(lender.app,'/api/approvals/' + card.id + '/accept',{method:'POST',body:{}});
  await waitForResult(f,{owner,lender,circle},first.jobDigest,'budget-consuming completion');
  await waitFor(async () => (await api(lender.app,'/api/lending')).status === 'limit-reached', 'exhausted preclaim gate');
  const countClaims = () => realRequests.filter(request => request.device === lender.app.device.keyId && request.route.endsWith('/jobs/claim-next')).length;
  const before = countClaims(), waiting = [];
  for (let index=0;index<3;index++) waiting.push(await api(owner.app,'/api/jobs',{method:'POST',
    body:{...gitInput(circle),prompt:'Unrelated synthetic queued task ' + index}}));
  await lendingTurns(lender.app,state=>state.status==='limit-reached');
  assert.equal(countClaims(),before);
  for (const item of waiting) {
    const job = await api(owner.app,jobPath(item.jobDigest));
    assert.equal(job.state,'queued');
    assert.equal(job.attempts_started,0);
    assert.equal(job.current_attempt,null);
  }
  assert.equal(lender.backend.calls.filter(([kind]) => kind === 'run').length,1);
});

test('legacy decline exclusions never block offer discovery, and local hides survive restart',testOptions,async t=>{
  const time=Date.now(),clock={now:()=>time},f=await appFixture(t),{owner,lender,circle}=await f.connect({clock});
  const job=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  const declined=Array.from({length:64},(_,i)=>({jobDigest:'sha256:'+(i+1).toString(16).padStart(64,'0'),expiresAt:time+3600000}));
  const counterFile=join(lender.home,'v1','app-counters.json');
  await writeFile(counterFile,JSON.stringify({day:new Date(time).toISOString().slice(0,10),jobs:0,milliseconds:0,pending:null,circle:circle.id,declined}));
  await lendingOn(lender.app,circle);const card=await review(lender.app);assert.equal(card.jobDigest,job.jobDigest);
  await api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
  await waitFor(async()=>JSON.parse(await readFile(counterFile,'utf8')).hiddenOffers?.some(e=>e.jobDigest===job.jobDigest),'durable local hide');
  await bounded(lender.app.close(),'restart hidden offers');
  const restarted=await f.start('lender',{clock});await api(restarted.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await lendingTurns(restarted.app,state=>state.current===null);
  assert.equal((await api(restarted.app,'/api/approvals')).length,0);
  assert.equal(f.jobs.get(job.jobDigest).current_attempt,null);assert.equal(f.requests.some(r=>r.route==='/jobs/claim-next'),false);
});

async function waitForResult(f, {owner,lender,circle}, digest, label) {
  let view;
  try {
    return await waitFor(async () => {
      // Always ask the app: a cached SSE view can be stale under load.
      view = await api(owner.app,jobPath(digest));
      assert.notEqual(view.state,'failed','Job failed: ' + JSON.stringify(view.current_attempt));
      return view.state === 'result-accepted' && view;
    },label,WAIT_MS);
  } catch (cause) {
    const read = promise => promise.catch(error => ({diagnosticError:error.code??error.name}));
    const [lending,counters] = await Promise.all([
      read(api(lender.app,'/api/lending')),
      read(readFile(join(lender.home,'v1','app-counters.json'),'utf8').then(JSON.parse)),
    ]);
    let archive;
    const ref = f.jobs.get(digest)?.job.payload.source.artifact;
    if (ref) {
      try {validateArchive(f.artifacts.get(ref.digest),{gzip:true});archive='valid';}
      catch(error) {archive=error.code;}
    }
    const diagnostics = {
      state:view?.state,reason:view?.current_attempt?.reason,started:view?.attempts_started,archive,
      backend:lender.backend.calls.map(([kind])=>kind).join('>'),
      phase:lending.status,phases:lender.phases.slice(-6),
      flags:{run:!!counters.pending,claim:!!counters.claimPending,decline:!!counters.declinePending,result:!!counters.resultPending},
      requests:f.networkTrace.filter(item=>item.device==='lender').slice(-3).map(item=>[
        item.method,item.route.replace(/sha256:|[a-f0-9-]{32,}/g,':id').split('/').slice(4).join('/'),item.status??item.error,item.code]),
    };
    // A fresh assertion preserves diagnostic text in Node's test reporter.
    assert.fail(label + ': ' + cause.message + '\nDiagnostics: ' + JSON.stringify(diagnostics));
  }
}

test('a malformed source releases before execution, backs off and lets later eligible work run', testOptions, async t => {
  const time=Math.floor(Date.now()/1000)*1000,clock={now:()=>time};
  const f = await admissionFixture(t), {owner,lender,circle} = await f.connect(
    {clock,monotonic:()=>performance.now()},{clock});
  const template = await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  const payload = structuredClone(f.jobs.get(template.jobDigest).job.payload);
  await api(owner.app,jobPath(template.jobDigest) + '/cancel',{method:'POST',body:{}});
  const client = await owner.app.device.client(circle.id);
  const artifact = await client.uploadArtifact(Buffer.from('Synthetic invalid gzip bytes'),'application/gzip');
  payload.source = {kind:'archive',artifact};
  payload.requirements.capabilities=payload.requirements.capabilities.filter(cap=>cap!=='filtered_git_v1');
  payload.intent_id = randomUUID();
  const malformed = await client.submitJob(payload);
  await lendingOn(lender.app,circle);
  const card = await review(lender.app);
  assert.equal(card.jobDigest,malformed.jobDigest);
  await api(lender.app,'/api/approvals/' + card.id + '/accept',{method:'POST',body:{}});
  await waitFor(() => f.jobs.get(malformed.jobDigest).current_attempt?.state === 'released', 'proven pre-start failure release');
  const failedSource = f.jobs.get(malformed.jobDigest);
  assert.equal(failedSource.state,'queued');
  assert.equal(failedSource.attempts_started,0);
  assert.equal(failedSource.current_attempt.execution_started_at,null);
  const releasedAttemptId = failedSource.current_attempt.attempt_id;
  const releasedGeneration = failedSource.current_attempt.generation;
  assert.ok(releasedAttemptId, 'the synthetic coordinator records an attempt identity');
  assert.ok(Number.isSafeInteger(releasedGeneration), 'the released attempt has a recorded generation');
  const assertStillReleased = () => {
    const savedJob = f.jobs.get(malformed.jobDigest);
    assert.equal(savedJob.state,'queued');
    assert.equal(savedJob.attempts_started,0);
    assert.equal(savedJob.current_attempt.attempt_id,releasedAttemptId,'the malformed job was not re-claimed');
    assert.equal(savedJob.current_attempt.generation,releasedGeneration);
    assert.equal(savedJob.current_attempt.state,'released');
    assert.equal(savedJob.current_attempt.execution_started_at,null);
  };
  assert.equal(f.requests.filter(request=>request.route.endsWith('/start')).length,0);
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);
  // Release can arrive before the local settlement save. Keep the test clock fixed
  // so the malformed job's three-second backoff stays observable.
  const countersFile=join(lender.home,'v1','app-counters.json');
  const backoff=await waitFor(async()=>{
    const counters=JSON.parse(await readFile(countersFile,'utf8'));
    const rows=[counters,...Object.values(counters.accounts??{})];
    if(rows.some(row=>row.pending||row.claimPending||row.declinePending||row.resultPending))return;
    return rows.flatMap(row=>row.declined??[]).find(e=>e.jobDigest===malformed.jobDigest);
  },'failed source backoff and settlement journals cleared');
  assert.equal(backoff.reason,'malformed');
  assert.equal(backoff.expiresAt,time+3000);
  assertStillReleased();
  assert.equal(f.requests.some(r=>r.route==='/jobs/claim-next'),false);
  assert.equal((await api(lender.app,'/api/approvals')).length,0);
  assert.equal(f.jobs.get(malformed.jobDigest).state,'queued');
  const good = await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),prompt:'Later valid synthetic task.'}});
  const next = await review(lender.app);
  assert.equal(next.jobDigest,good.jobDigest);
  await api(lender.app,'/api/approvals/' + next.id + '/accept',{method:'POST',body:{}});
  await waitForResult(f,{owner,lender,circle},good.jobDigest,'valid result after malformed source');
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,1);
  assertStillReleased();
});


test('real-store decline survives lender restart and leaves the queued job for a second lender',testOptions,async t=>{
  const f=await admissionFixture(t),{owner,declining,lender,circle,realRequests}=await f.realConnect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),send_anyway:true}});
  await lendingOn(declining.app,circle);
  const card=await review(declining.app);
  await api(declining.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
  const queued=await waitFor(async()=>{
    const view=await api(owner.app,jobPath(submitted.jobDigest));
    return view.state==='queued'&&view;
  },'real-store release before restart');
  assert.equal(queued.attempts_started,0);
  assert.equal(queued.current_attempt,null);
  await bounded(declining.app.close(),'declining lender restart close');
  const saved=JSON.parse(await readFile(join(declining.home,'v1','app-counters.json'),'utf8'));
  assert.ok(saved.hiddenOffers.some(entry=>entry.jobDigest===submitted.jobDigest&&entry.expiresAt>Date.now()));
  assert.equal(saved.jobs,0);assert.equal(saved.milliseconds,0);
  const requestsBeforeRestart=realRequests.length;
  const restarted=await f.start('declining');
  await api(restarted.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await lendingTurns(restarted.app,state=>state.current===null);
  assert.equal(realRequests.slice(requestsBeforeRestart).some(r=>r.route.endsWith('/jobs/claim-next')),false);
  const waiting=await api(owner.app,jobPath(submitted.jobDigest));
  assert.equal(waiting.state,'queued');assert.equal(waiting.attempts_started,0);
  assert.equal(waiting.current_attempt,null);
  assert.equal((await api(restarted.app,'/api/approvals')).length,0);
  const declinedRequests=realRequests.filter(request=>request.device===declining.app.device.keyId);
  assert.equal(declinedRequests.filter(request=>request.route.endsWith('/release')).length,0);
  assert.equal(declinedRequests.filter(request=>request.route.endsWith('/start')).length,0);
  assert.equal(declining.backend.calls.filter(([kind])=>kind==='run').length,0);
  assert.equal(restarted.backend.calls.filter(([kind])=>kind==='run').length,0);
  await lendingOn(lender.app,circle);
  const eligible=await review(lender.app);assert.equal(eligible.jobDigest,submitted.jobDigest);
  await api(lender.app,'/api/approvals/'+eligible.id+'/accept',{method:'POST',body:{}});
  const finished=await waitForResult(f,{owner,lender,circle},submitted.jobDigest,'second lender completes persisted decline');
  assert.equal(finished.attempts_started,1);
  assert.equal(queued.current_attempt,null);assert.equal(finished.current_attempt.generation,1);
  assert.equal(finished.current_attempt.holder,lender.app.device.keyId);
  assert.ok(finished.current_attempt.execution_started_at);
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,1);
  assert.equal(realRequests.filter(request=>request.device===lender.app.device.keyId&&request.route.endsWith('/start')).length,1);
});


test('agent refresh is explicit, per adapter, cached and expires without hidden probes', testOptions, async t => {
  const f=await appFixture(t);let calls=0,time=Date.now(),failProbe=false;
  const entries=legacyProxyAdapters.filter(a=>a.spec.provider_service_id==='anthropic');
  const {app}=await f.start('owner',{adapters:entries,clock:{now:()=>time},identityCacheMs:1000,
    identityProbe:async({harnessNames})=>{
      // One probe, and one sandbox, per agent: a slow or failing agent cannot hold up or hide another.
      calls++;assert.equal(harnessNames.length,1);
      if(failProbe)throw new Error('PRIVATE_IDENTITY_FAILURE');
      return {docker_account:{email:'DO_NOT_SURFACE'},providers:[
        {harness_id:'claude-code-subscription',installed:true,signedIn:false},
        {harness_id:'claude-code-api-key',installed:true,signedIn:true,account_email:'synthetic@example.test'},
      ]};
    }});
  const before=await api(app,'/api/agents');
  assert.ok(before.every(a=>a.installed===null&&a.signedIn===null));assert.equal(calls,0);
  await api(app,'/api/home');assert.equal(calls,0);
  const ids=entries.map(a=>a.spec.harness_id);
  const refreshed=await api(app,'/api/agents/refresh',{method:'POST',body:{agents:ids}});
  assert.equal(calls,2);
  assert.equal(refreshed.find(a=>a.id==='claude-code-subscription').signedIn,null);
  assert.equal(refreshed.find(a=>a.id==='claude-code-api-key').signedIn,true);
  assert.ok(!JSON.stringify(refreshed).includes('DO_NOT_SURFACE'));
  await api(app,'/api/agents');assert.equal(calls,2);
  time+=1001;
  const stale=await api(app,'/api/agents');
  assert.ok(stale.every(a=>a.stale&&a.installed===true));
  assert.equal(stale.find(a=>a.id==='claude-code-api-key').signedIn,true);
  assert.equal(calls,2);
  failProbe=true;
  const failed=await api(app,'/api/agents/refresh',{method:'POST',body:{agents:ids}});
  assert.ok(failed.every(a=>a.installed===true));
  assert.equal(failed.find(a=>a.id==='claude-code-api-key').signedIn,true);
  assert.ok(!JSON.stringify(failed).includes('PRIVATE_IDENTITY_FAILURE'));
  assert.equal(calls,4);
});

const failedAgentRemedy='Faravan could not check this agent in a test sandbox. Run faravan doctor to see what is wrong.';

test('native sign-in stays available for the owner but cannot be selected for lending',testOptions,async t=>{
  const f=await appFixture(t);
  const {app}=await f.start('owner',{adapters:[{...adapters()[0],spec:resolveHarness('codex')}]});
  const rows=await api(app,'/api/agents');
  assert.equal(rows[0].auth_strategy,'provider-file-generation');
  assert.equal(rows[0].useForLending,false);
  assert.equal(rows[0].signInSupported,true);
  const refused=await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true},status:400});
  assert.equal(refused.code,'native_credentials_owner_only');
  assert.match(refused.message,/sign in to its Docker credential proxy on the Lend page/);
  await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:false}});
});

test('subscription lending view uses proxy sign-in while preserving native owner sign-in',testOptions,async t=>{
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  let proxyReady=false;
  const f=await appFixture(t);
  const {app}=await f.start('owner',{lendingStoreBackedAgents:[],adapters:[{...native,installed:true,signedIn:true,models:['example-model']}],
    lendingSignInProbe:async()=>({signedIn:true}),
    lendingIdentityProbe:async()=>({providers:[{harness_id:'codex',installed:true,signedIn:proxyReady}]})});
  const [row]=await checkedAgents(app);
  assert.equal(row.id,'codex');
  assert.equal(row.auth_strategy,'provider-file-generation');
  assert.equal(row.signedIn,true);
  assert.equal(row.ownerSignedIn,true);
  assert.equal(row.proxySignedIn,false);
  assert.equal(row.lendingSignInTarget,'codex-lending');
  assert.equal(row.lendingSignInSupported,true);
  assert.equal(row.canChoose,false);
  assert.equal(row.useForLending,false);
  assert.equal(row.signedIn,true,'the native sign-in remains honest owner evidence');
  const notReady=await api(app,'/api/agents/codex-lending',{method:'POST',body:{useForLending:true},status:400});
  assert.equal(notReady.code,'agent_not_ready');
  assert.equal(notReady.message,"Waiting · The lender's computer needs a moment");

  proxyReady=true;
  const ready=await api(app,'/api/agents/codex-lending',{method:'POST',body:{useForLending:true}});
  assert.equal(ready[0].id,'codex');
  assert.equal(ready[0].proxySignedIn,true);
  assert.equal(ready[0].signedIn,true,'a proxy sign-in also makes the one agent card signed in');
  assert.equal(ready[0].canChoose,true);
  assert.equal(ready[0].useForLending,true);
});

test('native-only owner can start lending discovery without selecting the proxy',testOptions,async t=>{
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  const f=await appFixture(t);
  const {lender,circle}=await f.connect({adapters:[{...native,installed:true,signedIn:true,models:['example-model']}],
    lendingSignInProbe:async()=>({signedIn:false})});
  const [row]=await checkedAgents(lender.app);
  assert.equal(row.ownerSignedIn,true);
  assert.equal(row.proxySignedIn,false);
  const started=await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  assert.equal(started.enabled,true);
  assert.equal(started.circle,circle.id);
});

test('a listed proxy secret without a signed-in status probe never enables lending',testOptions,async t=>{
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  const f=await appFixture(t);
  const {app}=await f.start('owner',{adapters:[{...native,installed:true,signedIn:false}],
    lendingSignInProbe:async()=>({signedIn:true}),
    lendingIdentityProbe:async()=>({providers:[{harness_id:'codex',installed:true,signedIn:false}]})});
  const [row]=await checkedAgents(app);
  assert.equal(row.signedIn,false);
  assert.equal(row.proxySignedIn,false);
  assert.equal(row.canChoose,false);
  assert.equal(row.useForLending,false);
  assert.equal((await api(app,'/api/agents/codex-lending',{method:'POST',body:{useForLending:true},status:400})).code,'agent_not_ready');
});

test('a ready proxy status probe supplies the owner identity check',testOptions,async t=>{
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  let proxySpecs=[],nativeChecks=0;
  const f=await appFixture(t);
  const {app}=await f.start('owner',{lendingStoreBackedAgents:[],adapters:[{...native,installed:true,signedIn:false}],
    lendingSignInProbe:async()=>({signedIn:true}),
    lendingIdentityProbe:async options=>{
      proxySpecs.push({spec:options.harnessSpecs.codex,network:options.network});
      return {providers:[{harness_id:'codex',installed:true,signedIn:true}]};
    },
    identityProbe:async()=>{nativeChecks++;return {providers:[{harness_id:'codex',installed:true,signedIn:false}]};}});
  await api(app,'/api/agents');
  const [row]=await api(app,'/api/agents/refresh',{method:'POST',body:{agents:['codex']}});
  assert.equal(row.signedIn,true);
  assert.equal(row.ownerSignedIn,true);
  assert.equal(row.auth_strategy,'docker-native-oauth');
  assert.equal(row.credential_in_guest,false);
  assert.equal(proxySpecs.at(-1).spec.auth_strategy,'docker-native-oauth');
  assert.equal(proxySpecs.at(-1).network,'provider-only');
  assert.equal(nativeChecks,0);
});

test('proxy identity evidence is cached and rechecked in the background',testOptions,async t=>{
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  let time=Date.now(),proxyChecks=0,nativeChecks=0;
  const f=await appFixture(t);
  const {app}=await f.start('owner',{lendingStoreBackedAgents:[],clock:{now:()=>time},lendingIdentityCacheMs:1000,
    adapters:[{...native,installed:true,signedIn:true}],
    lendingSignInProbe:async()=>({signedIn:true}),
    lendingIdentityProbe:async()=>({providers:[{harness_id:'codex',installed:true,signedIn:proxyChecks++===0}]}),
    identityProbe:async()=>{nativeChecks++;return {providers:[{harness_id:'codex',installed:true,signedIn:true}]};}});
  let [row]=await checkedAgents(app);
  assert.equal(proxyChecks,1);
  assert.equal(row.proxySignedIn,true);
  time+=1001;
  [row]=await api(app,'/api/agents');
  assert.equal(row.proxySignedIn,true,'stale evidence remains usable while the background check runs');
  await waitFor(()=>proxyChecks===2,'background proxy status recheck');
  [row]=await api(app,'/api/agents');
  assert.equal(row.proxySignedIn,false);
  assert.equal(row.signedIn,true,'a fresh native owner check remains separate from proxy readiness');
  assert.equal(nativeChecks,1);
});

test('a confirmed lending sign-in is rechecked every 10 minutes, not every 30 seconds',testOptions,async t=>{
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  let time=Date.now(),proxyChecks=0;
  const f=await appFixture(t);
  const {app}=await f.start('owner',{clock:{now:()=>time},
    adapters:[{...native,installed:true,signedIn:true}],
    lendingSignInProbe:async()=>({signedIn:true}),
    lendingIdentityProbe:async()=>{proxyChecks++;return {providers:[{harness_id:'codex',installed:true,signedIn:true}]};},
    identityProbe:async()=>({providers:[{harness_id:'codex',installed:true,signedIn:true}]})});
  let [row]=await checkedAgents(app);
  assert.equal(row.proxySignedIn,true);
  const first=proxyChecks;
  time+=31000;
  await api(app,'/api/agents');await new Promise(r=>setTimeout(r,300));
  assert.equal(proxyChecks,first,'no new sandbox check 31 s after a confirmed sign-in');
  time+=600000;
  await api(app,'/api/agents');
  await waitFor(()=>proxyChecks===first+1,'recheck after 10 minutes');
});

test('legacy native account selection does not enable proxy lending after upgrade',testOptions,async t=>{
  const f=await appFixture(t),home=await f.home('owner');
  await mkdir(join(home,'v1'),{recursive:true});
  await writeFile(join(home,'v1','app-settings.json'),JSON.stringify({version:1,intent:'off',agents:{codex:true}}));
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  const {app}=await f.start('owner',{adapters:[{...native,installed:true,signedIn:true}],
    lendingSignInProbe:async()=>({signedIn:true}),
    lendingIdentityProbe:async()=>({providers:[{harness_id:'codex',installed:true,signedIn:true}]})});
  const rows=await checkedAgents(app);
  assert.equal(rows.length,1);
  assert.equal(rows[0].id,'codex');
  assert.equal(rows[0].proxySignedIn,true);
  assert.equal(rows[0].useForLending,false);
});

test('subscription lending view preserves unknown native owner sign-in state',testOptions,async t=>{
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex');
  const {app}=await (await appFixture(t)).start('owner',{lendingStoreBackedAgents:[],adapters:[{...native,installed:true,signedIn:null}],
    lendingSignInProbe:async()=>({signedIn:false})});
  const [row]=await checkedAgents(app);
  assert.equal(row.signedIn,null);
  assert.equal(row.ownerSignedIn,null);
  assert.equal(row.proxySignedIn,false);
});

test('failed agent checks are visible, private, expire and recover', testOptions, async t => {
  const f=await appFixture(t);let time=Date.now(),calls=0;
  const privateText='PRIVATE_SANDBOX_DIAGNOSTIC';
  let probe=()=>{throw new Error(privateText);};
  const {app}=await f.start('owner',{adapters:legacyProxyAdapters.filter(a=>a.spec.harness_id==='codex'),
    clock:{now:()=>time},identityCacheMs:1000,identityProbe:async()=>{calls++;return probe();}});
  const before=await api(app,'/api/agents');
  assert.equal(before[0].signInState,'Not checked');
  assert.equal(before[0].checkedAt,null);
  assert.equal(calls,0);
  await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  const failed=await api(app,'/api/agents/refresh',{method:'POST',body:{}});
  assert.equal(failed[0].signInState,'Check failed');
  assert.equal(failed[0].remedy,failedAgentRemedy);
  assert.equal(failed[0].checkedAt,new Date(time).toISOString());
  assert.equal(failed[0].stale,false);
  const cached=await api(app,'/api/agents');
  assert.deepEqual(cached,failed.map(({capacity,...agent})=>agent));
  assert.equal(calls,1);
  const circle=(await api(app,'/api/circles'))[0];
  const denied=await api(app,'/api/lending/on',{method:'POST',body:{circle:circle.id},status:409});
  assert.equal(denied.code,'agent_not_ready');
  assert.equal(denied.message,failedAgentRemedy);
  const home=await api(app,'/api/home'),activity=await api(app,'/api/activity?after=0');
  assert.ok(!JSON.stringify({failed,cached,denied,home,activity}).includes(privateText));
  time+=1000;
  const stale=await api(app,'/api/agents');
  assert.equal(stale[0].signInState,'Check failed');
  assert.equal(stale[0].stale,true);
  assert.equal(stale[0].remedy,failedAgentRemedy);
  assert.equal(calls,1);
  probe=()=>({providers:[{harness_id:'codex',installed:true,signedIn:true}]});
  const recovered=await api(app,'/api/agents/refresh',{method:'POST',body:{}});
  assert.equal(recovered[0].signInState,'Signed in');
  assert.equal(recovered[0].remedy,null);
  assert.equal(recovered[0].checkedAt,new Date(time).toISOString());
  assert.equal(recovered[0].stale,false);
});

test('a job that proves the agent is signed out in the sandbox stops lending with it and hides the cause from the borrower', testOptions, async t => {
  const stdout='{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: Could not parse your authentication token. Please try signing in again., url: https://chatgpt.com/backend-api/codex/responses)"}\n{"type":"turn.failed"}\n';
  const f=await admissionFixture(t,{runError:Object.assign(new Error('sbx exec failed: PRIVATE_PROVIDER_TEXT'),{stdout,stderr:'',exitCode:1})});
  const {owner,lender,circle}=await f.connect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>f.jobs.get(submitted.jobDigest).state==='failed','job failed');
  const codex=async()=>(await api(lender.app,'/api/agents')).find(a=>a.id==='codex');
  await waitFor(async()=>(await codex()).signInState==='Sign-in needed','agent marked signed out');
  const agent=await codex();
  assert.equal(agent.signedIn,false);
  assert.equal(agent.signedOutInSandbox,true);
  assert.equal(agent.remedy,'Sign in again on the Lend page, then lending resumes.');
  const home=await api(lender.app,'/api/home');
  assert.ok(home.attention.some(item=>item.agent==='codex'&&item.remedy===agent.remedy));
  const activity=await api(lender.app,'/api/activity?after=0');
  const lendingEvent=activity.find(e=>e.type==='lending'&&e.data.reason==='agent_signed_out');
  assert.equal(lendingEvent.data.agent,'codex');
  assert.ok(!JSON.stringify({agent,home,activity}).includes('PRIVATE_PROVIDER_TEXT'));
  const borrowerView=JSON.stringify([await api(owner.app,jobPath(submitted.jobDigest)),f.jobs.get(submitted.jobDigest)]);
  assert.ok(!/signed.out|sign.?in|log.?in|authenticat|unauthorized|PRIVATE_PROVIDER_TEXT/i.test(borrowerView),borrowerView);
  // The sign-out outlives the identity cache: it is not "unknown" until a check or sign-in replaces it.
  assert.equal((await codex()).signInState,'Sign-in needed');
  // Lending no longer picks this agent: a second job is left in the queue and never offered for review.
  const second=await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),prompt:'Synthetic task: write a second greeting.'}});
  await new Promise(resolve=>setTimeout(resolve,750));
  assert.equal(f.jobs.get(second.jobDigest).state,'queued');
  assert.equal((await api(lender.app,'/api/approvals')).length,0);
});

for(const [cause,remedy] of Object.entries({
  option_rejected:'This version of Docker Sandboxes changed a command Faravan uses. Update Faravan.',
  not_signed_in:"Sign in to Docker to lend.",
  kvm:"This computer isn't allowing virtual machines. Run faravan doctor for the fix.",
  image_unavailable:"The agent's sandbox image couldn't be downloaded. Check your internet connection, then Check agents again.",
  timeout:'Starting a test workspace took too long. Check agents again.',
  unknown:failedAgentRemedy,
  surprising_new_cause:failedAgentRemedy,
}))test('a failed test workspace explains '+cause+' in plain words',testOptions,async t=>{
  const f=await appFixture(t);
  const {app}=await f.start('owner',{adapters:legacyProxyAdapters.filter(a=>a.spec.harness_id==='codex'),
    identityProbe:async()=>({providers:[{harness_id:'codex',installed:null,signedIn:null,authed:null,workspace_cause:cause,
      detail:'PRIVATE_PROVIDER_OUTPUT'}]})});
  const agents=await api(app,'/api/agents/refresh',{method:'POST',body:{}});
  // A test workspace that finds Docker signed out is the same docker_signed_out problem, not a failed agent check.
  assert.equal(agents[0].signInState,cause==='not_signed_in'?'Docker sign-in needed':'Check failed');
  if(cause==='not_signed_in')assert.equal(agents[0].code,'docker_signed_out');
  assert.equal(agents[0].remedy,remedy);
  assert.ok(!JSON.stringify(agents).includes('PRIVATE_PROVIDER_OUTPUT'));
  assert.equal((await api(app,'/api/agents'))[0].remedy,remedy);
});

test('agent checks reject missing, duplicate and unusable harness evidence', testOptions, async t => {
  const f=await appFixture(t);let result;
  const {app}=await f.start('owner',{adapters:legacyProxyAdapters.filter(a=>a.spec.harness_id==='codex'),
    identityProbe:async()=>result});
  const good={harness_id:'codex',installed:true,signedIn:true};
  for(const providers of [
    [{harness_id:'gemini',installed:true,signedIn:true}],
    [{harness_id:'codex',installed:null,signedIn:null}],
    [{harness_id:'codex',installed:true,signedIn:null}],
    [good,good], [null], null,
  ]) {
    result={providers,diagnostic:'PRIVATE_PROVIDER_OUTPUT'};
    const agents=await api(app,'/api/agents/refresh',{method:'POST',body:{}});
    assert.equal(agents[0].signInState,'Check failed');
    assert.equal(agents[0].remedy,failedAgentRemedy);
    assert.ok(!JSON.stringify(agents).includes('PRIVATE_PROVIDER_OUTPUT'));
  }
  result={providers:[{harness_id:'codex',installed:false,signedIn:null}]};
  assert.equal((await api(app,'/api/agents/refresh',{method:'POST',body:{}}))[0].signInState,'Not installed');
  result={providers:[{harness_id:'codex',installed:true,signedIn:false}]};
  assert.equal((await api(app,'/api/agents/refresh',{method:'POST',body:{}}))[0].signedIn,null);
  assert.equal((await api(app,'/api/agents/refresh',{method:'POST',body:{}}))[0].signInState,'Sign-in needed');
});

test('identity adapters distinguish installed, missing, signed-out and unknown evidence', () => {
  assert.deepEqual(parseIdentityEvidence('codex','FARAVAN_INSTALLED=0\n'),{installed:false,signedIn:null,account:null});
  assert.equal(parseIdentityEvidence('codex','FARAVAN_INSTALLED=1\nSBX_CRED_OPENAI_MODE=oauth\n').signedIn,true);
  assert.equal(parseIdentityEvidence('codex','FARAVAN_INSTALLED=1\nSBX_CRED_OPENAI_MODE=none\n').signedIn,false);
  assert.equal(parseIdentityEvidence('codex','FARAVAN_INSTALLED=1\nUnrecognized output\n').signedIn,null);
  assert.equal(parseIdentityEvidence('codex','Logged in using an API key\n').installed,null);
  assert.equal(parseIdentityEvidence('opencode','FARAVAN_INSTALLED=1\nConfigured credentials: OpenRouter\n').signedIn,null);
  assert.equal(parseIdentityEvidence('claude-code-api-key','FARAVAN_INSTALLED=1\nSBX_CRED_ANTHROPIC_MODE=apikey\n').signedIn,true);
  assert.equal(parseIdentityEvidence('claude-code-subscription','FARAVAN_INSTALLED=1\n{"loggedIn":false}\n').signedIn,false);
  assert.equal(parseIdentityEvidence('gemini','FARAVAN_INSTALLED=1\nSBX_CRED_GOOGLE_MODE=none\n').signedIn,false);
  assert.equal(parseIdentityEvidence('codex','FARAVAN_INSTALLED=1\nLogged in using an API key\n').signedIn,null);
  assert.equal(parseIdentityEvidence('codex','FARAVAN_INSTALLED=1\nSBX_CRED_OPENAI_MODE=apikey\n').signedIn,true);
  assert.equal(parseIdentityEvidence('codex','FARAVAN_INSTALLED=1\nSBX_CRED_OPENAI_MODE=unknown\n').signedIn,null);
  assert.match(identityProbeCommand('codex'),/if \[ -n "\$FARAVAN_CREDENTIAL_GENERATION" \]; then codex login status; else printf "SBX_CRED_OPENAI_MODE=/);
  assert.equal(parseIdentityEvidence('codex','FARAVAN_INSTALLED=1\nLogged in using ChatGPT\n').signedIn,true);
  assert.equal(identityProbeCommand('not-an-adapter'),null);
  for(const adapter of HARNESS_ADAPTERS) {
    const command=identityProbeCommand(adapter.spec.harness_id);
    if(adapter.spec.harness_id==='pi')continue;
    assert.match(command,/command -v /);assert.ok(!command.includes('--dangerously'));
    assert.ok(!command.includes('auth login'));assert.ok(!command.includes('secret set'));
  }
  assert.ok(!identityProbeCommand('gemini').includes('(env)'),'never dump credential-bearing environment');
});

test('Pi identity stays on the broker path without even opening a native backend', async () => {
  const adapter = HARNESS_ADAPTERS.find(row => row.spec.harness_id === 'pi');
  assert.equal(adapter?.spec.provider_service_id, 'broker');
  assert.equal(identityProbeCommand('pi'), null);
  let backendCalls = 0, dockerReads = 0;
  const result = await probeFaravanIdentity({harnessNames:['pi'],
    backendFactory:() => { backendCalls++; return {}; },
    readDockerAccount:async () => { dockerReads++; return null; }});
  assert.equal(backendCalls, 0);
  assert.equal(dockerReads, 0);
  const [{harness_id, service, installed, signedIn}] = result.providers;
  assert.deepEqual({harness_id, service, installed, signedIn}, {harness_id:'pi', service:'broker', installed:null, signedIn:null});
});

test('explicit identity probe uses only fake status commands and never repairs or signs in', async () => {
  const calls=[],outputs=['FARAVAN_INSTALLED=1\nSBX_CRED_OPENAI_MODE=oauth\n','FARAVAN_INSTALLED=0\n'];
  const backend={
    probeCapabilities(){assert.fail('repairing capability probe must not run');},
    async testWorkspace(){calls.push('workspace');return {ok:true};},
    async lenderCapabilities(){calls.push('preflight');return {available:true};},
    async prepare(spec){calls.push('prepare');assert.equal(spec.resources.wall_seconds,180);
      assert.equal(spec.resources.output_bytes,16384);assert.match(spec.entrypoint,/command -v /);
      return {_entrypoint:spec.entrypoint};},
    async start(handle){calls.push('status');handle._lastExecStdout=outputs.shift();},
    async destroy(){calls.push('destroy');return {removed:true};},
  };
  const result=await probeFaravanIdentity({harnessNames:['codex','gemini'],backendFactory:()=>backend,readDockerAccount:async()=>null});
  assert.deepEqual(result.providers.map(r=>[r.harness_id,r.installed,r.signedIn]),[['codex',true,true],['gemini',false,null]]);
  assert.deepEqual(calls,['preflight','workspace','preflight','prepare','status','destroy','preflight','prepare','status','destroy']);
  backend.lenderCapabilities=async()=>({available:false});
  const unknown=await probeFaravanIdentity({harnessNames:['codex'],backendFactory:()=>backend,readDockerAccount:async()=>null});
  assert.equal(unknown.providers[0].installed,null);assert.equal(unknown.providers[0].signedIn,null);
  assert.equal(calls.length,10,'second probe: the capability gate skips the workspace and every sandbox when the backend is unavailable');
});

test('readiness requires explicit protection evidence and preferred disk does not block', testOptions, async t => {
  const f=await appFixture(t),backend=syntheticBackend(f.root),capabilities=backend.lenderCapabilities;
  backend.lenderCapabilities=()=>({...capabilities(),enforced_limits:['cpu','memory_bytes','wall_seconds','output_bytes']});
  const {app}=await f.start('owner',{backend});
  const report=await api(app,'/api/readiness?refresh=true');
  assert.equal(report.ready,true);assert.equal(report.protection.satisfied,true);
  assert.deepEqual(report.protection.limits.preferred,['disk_bytes']);
  assert.deepEqual(report.protection.limits.unenforced,['disk_bytes']);
  const summary=backend.protectionSummary;
  backend.protectionSummary=undefined;
  assert.equal((await api(app,'/api/readiness?refresh=true')).ready,false);
  backend.protectionSummary=async (req,context)=>({...await summary(req,context),version_gate:{ok:false,status:'unknown'}});
  assert.equal((await api(app,'/api/readiness?refresh=true')).ready,false);
});

test('review protection is requirement-bound and Accept rechecks changed preflight', testOptions, async t => {
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  assert.equal(card.protection.source,'read-only-preflight');assert.equal(card.protection.satisfied,true);
  assert.equal(card.protection.egress.requested,card.job.requirements.egress);
  assert.deepEqual(card.protection.limits.required,Object.keys(card.job.requirements.limits).filter(k=>card.job.requirements.limit_modes?.[k]!=='preferred'));
  const summary=lender.backend.protectionSummary;
  lender.backend.protectionSummary=async (req,context)=>({...await summary(req,context),sandbox_ready:false,satisfied:false,
    diagnostics:'PRIVATE_PREFLIGHT_DIAGNOSTIC'});
  const denied=await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{},status:409});
  assert.equal(denied.code,'protection_not_ready');
  const retained=(await api(lender.app,'/api/approvals'))[0];
  assert.equal(retained.protection.satisfied,false);
  assert.ok(!JSON.stringify(retained).includes('PRIVATE_PREFLIGHT_DIAGNOSTIC'));
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);
  await api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
});

test('private task receipt preserves the backend verified commit', () => {
  const commit='1'.repeat(40);
  const receipt=buildTaskReceipt({taskDigest:'2'.repeat(64),harnessId:'codex',
    execution:{stdout:'',provider_status_stdout:'',verified_commit:commit}});
  assert.equal(receipt.verified_commit,commit);
  assert.equal(executionMetadata(receipt).verified_commit,commit);
});


test('review does not claim provider-only Git protection when the trusted adapter cannot permit cloning', testOptions, async t => {
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),egress:'provider-only'}});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  assert.equal(card.protection.egress.source_enforceable,false);
  assert.equal(card.protection.satisfied,false);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{},status:409});
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);
  await api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
});

test('app publishes private atomic discovery after listening and removes it on close', testOptions, async t => {
  const f=await appFixture(t), {app,home,backend}=await f.start('discovery');
  const file=join(home,'v1','app.json');
  const info=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(Object.keys(info).sort(),['pid','port','started_at','token']);
  assert.equal(info.port,app.server.address().port);
  assert.equal(info.token,app.token);
  assert.equal(info.pid,process.pid);
  assert.ok(Number.isFinite(Date.parse(info.started_at)));
  if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o777,0o600);
  assert.equal((await readdir(join(home,'v1'))).some(name=>name.startsWith('app.json.')&&name.endsWith('.tmp')),false);
  await api(app,'/api/status');
  assert.equal(backend.calls.some(([kind])=>kind==='run'),false);
  await app.close();
  await assert.rejects(readFile(file),{code:'ENOENT'});
  await app.close();
});

test('app shutdown preserves a replacement discovery record', testOptions, async t => {
  const f=await appFixture(t), {app,home}=await f.start('replacement');
  const file=join(home,'v1','app.json');
  const original=JSON.parse(await readFile(file,'utf8'));
  const replacement={...original,token:'synthetic-replacement-session',started_at:'2026-10-09T12:00:00.000Z'};
  await writeFile(file,JSON.stringify(replacement),{mode:0o600});
  await app.close();
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),replacement);
});

test('discovery publication failure closes the listener and releases the home lock', testOptions, async t => {
  const f=await appFixture(t), home=await f.home('publication-failure');
  const file=join(home,'v1','app.json');
  await mkdir(file,{recursive:true});
  await assert.rejects(f.start('publication-failure',{home}));
  await rm(file,{recursive:true});
  const {app}=await f.start('publication-failure',{home});
  assert.equal(JSON.parse(await readFile(file,'utf8')).port,app.server.address().port);
});

test('Pause during Stop recovery leaves lending off after cessation proof',testOptions,async t=>{
  const f=await admissionFixture(t,{hold:true}),{owner,lender,circle}=await f.connect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'running fake sandbox');
  const before=await api(lender.app,'/api/lending'),attemptId=before.current;
  assert.ok(attemptId);
  const runningHome=await api(lender.app,'/api/home');
  const runningStep=contributorNextStep({home:runningHome,circles:await api(lender.app,'/api/circles'),
    jobs:await api(lender.app,'/api/jobs?circle='+circle.id),deviceKey:lender.app.device.keyId});
  assert.equal(runningStep?.id,'job_running');assert.equal(runningStep.action.id,submitted.jobDigest);
  await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId},status:400});
  await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:false},status:400});
  await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId:'stale-attempt',confirmed:true},status:409});
  await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:true},token:null,status:401});
  assert.equal(lender.backend.calls.some(([kind])=>kind==='cancel'),false);
  assert.equal((await api(lender.app,'/api/lending')).enabled,true);
  let allowRemoval,removalRequested=false;
  const removal=new Promise(resolve=>{allowRemoval=resolve;});
  const destroy=lender.backend.destroy.bind(lender.backend);
  lender.backend.destroy=async handle=>{removalRequested=true;await removal;return destroy(handle);};
  try {
    const stopping=await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:true}});
    assert.equal(stopping.enabled,false);assert.equal(stopping.intent,'off');assert.equal(stopping.paused,true);
    assert.equal(JSON.parse(await readFile(join(lender.home,'v1','app-settings.json'),'utf8')).enabled,false);
    await waitFor(()=>removalRequested,'sandbox removal requested');
    assert.equal(lender.backend.calls.filter(([kind])=>kind==='cancel').length,1);
    assert.equal(f.requests.some(r=>r.route.endsWith('/stopped')),false);
    assert.equal(f.requests.some(r=>r.route.endsWith('/release')),false);
    assert.equal(f.jobs.get(submitted.jobDigest).current_attempt.compute_stopped,false);
    await api(lender.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id},status:409});
    await api(lender.app,'/api/lending/pause',{method:'POST',body:{}});
    assert.equal((await api(lender.app,'/api/status')).intent.state,'off','Pause cannot turn a stopped lender on');
    allowRemoval();
    await waitFor(()=>f.jobs.get(submitted.jobDigest).current_attempt.compute_stopped,'verified cessation report');
    const attempt=f.jobs.get(submitted.jobDigest).current_attempt;
    assert.equal(JSON.parse(attempt.reason).code,'stopped_by_lender');
    assert.equal(attempt.state,'released');
    await waitFor(async()=>{const state=await api(lender.app,'/api/lending');return state.counters?.pending===null&&!state.current;},'Stop recovery cleared');
    const state=await api(lender.app,'/api/lending');
    assert.equal(state.enabled,false);assert.equal(state.paused,true);
    assert.equal(f.requests.some(r=>r.route.endsWith('/complete')),false);
    assert.equal(lender.backend.calls.filter(([kind])=>kind==='cancel').length,1,'a duplicate stop does not repeat sandbox cancellation');
  } finally {allowRemoval();}
});

test('Stop turns lending off, and Stop recovery does not turn it back on',testOptions,async t=>{
  const f=await admissionFixture(t,{hold:true}),{owner,lender,circle}=await f.connect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'running fake sandbox');
  const attemptId=(await api(lender.app,'/api/lending')).current;
  const person=(await api(lender.app,'/api/status')).runningJob?.requester;
  assert.ok(person,'the running job names who it is for');
  const stopped=await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:true}});
  assert.equal(stopped.enabled,false);assert.equal(stopped.intent,'off','lending.stop_job turns lending off');
  await waitFor(()=>f.jobs.get(submitted.jobDigest).current_attempt.compute_stopped,'verified cessation report');
  await waitFor(async()=>{const view=await api(lender.app,'/api/lending');return view.counters?.pending===null&&!view.current?view:null;},'Stop recovery cleared');
  // Recovery has finished. Give a late automatic resume time to land, then check lending is still off.
  await new Promise(resolve=>setTimeout(resolve,1500));
  const view=await api(lender.app,'/api/lending'),status=await api(lender.app,'/api/status');
  assert.equal(view.enabled,false,'Stop recovery must not turn lending back on');
  assert.equal(view.intent,'off');assert.equal(status.intent.on,false);assert.equal(status.intent.state,'off');
  assert.equal(JSON.parse(await readFile(join(lender.home,'v1','app-settings.json'),'utf8')).intent,'off');
  assert.deepEqual(status.stoppedJob,{requester:person});
  const retry=await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:true}});
  assert.equal(retry.enabled,false,'a recorded Stop retry leaves lending off');assert.equal(retry.intent,'off');
  await api(lender.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id}});
  assert.equal((await api(lender.app,'/api/status')).stoppedJob,undefined,'turning lending on clears the reason');
  assert.equal((await api(lender.app,'/api/lending')).intent,'on');
});

test('Pause during Stop requester lookup keeps the newer intent',testOptions,async t=>{
  const f=await admissionFixture(t,{hold:true}),{owner,lender,circle}=await f.connect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'running fake sandbox');
  const attemptId=(await api(lender.app,'/api/lending')).current;
  assert.ok(attemptId);
  let entered,release,allowRemoval;
  const removalGate=new Promise(resolve=>{allowRemoval=resolve;});
  const destroy=lender.backend.destroy.bind(lender.backend);
  lender.backend.destroy=async handle=>{await removalGate;return destroy(handle);};
  const lookupStarted=new Promise(resolve=>{entered=resolve;}),lookupGate=new Promise(resolve=>{release=resolve;});
  const memberNames=lender.app.device.memberNames.bind(lender.app.device);
  t.mock.method(lender.app.device,'memberNames',async(...args)=>{
    entered();await lookupGate;return memberNames(...args);
  });
  t.after(()=>{release();allowRemoval();});
  const stopping=api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:true}});
  // Observe rejection immediately, while still asserting the response below.
  stopping.catch(()=>{});
  try {
    await bounded(lookupStarted,'Stop requester lookup');
    const paused=await api(lender.app,'/api/lending/pause',{method:'POST',body:{}});
    assert.equal(paused.intent,'paused');assert.equal(paused.enabled,false);
    assert.equal((await api(lender.app,'/api/lending')).current,attemptId,'cleanup keeps this Stop in flight');
    release();
    const stopped=await stopping;
    assert.equal(stopped.intent,'paused','Stop cannot overwrite a Pause made during its requester lookup');
    assert.equal(stopped.enabled,false);
    const saved=()=>readFile(join(lender.home,'v1','app-settings.json'),'utf8').then(JSON.parse);
    assert.equal((await saved()).intent,'paused');
    allowRemoval();
    await waitFor(()=>f.jobs.get(submitted.jobDigest).current_attempt.compute_stopped,'verified cessation report');
    await waitFor(async()=>{const view=await api(lender.app,'/api/lending');return view.counters?.pending===null&&!view.current;},'Stop recovery cleared');
    const view=await api(lender.app,'/api/lending');
    assert.equal(view.intent,'paused');assert.equal(view.enabled,false);
    assert.equal((await saved()).intent,'paused');
  } finally {release();allowRemoval();await stopping.catch(()=>{});}
});

test('Stop releases only Job A, leaves lending off until Resume, and a stale Stop cannot stop Job B',testOptions,async t=>{
  const f=await admissionFixture(t,{hold:true}),{owner,lender,circle}=await f.connect();
  const first=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  const second=await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),prompt:'Queued job B'}});
  await lendingOn(lender.app,circle);
  const cards=await waitFor(async()=>{const rows=await api(lender.app,'/api/approvals');return rows.length===2?rows:null;},'two waiting jobs');
  const a=cards.find(card=>card.jobDigest===first.jobDigest),b=cards.find(card=>card.jobDigest===second.jobDigest);
  await api(lender.app,'/api/approvals/'+a.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.filter(([kind])=>kind==='run').length===1,'Job A running');
  await waitFor(async()=>(await api(lender.app,'/api/lending')).current,'Job A attempt');
  const attemptA=(await api(lender.app,'/api/lending')).current;
  await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId:attemptA,confirmed:true}});
  await waitFor(()=>f.jobs.get(first.jobDigest).current_attempt.compute_stopped,'Job A cessation proof');
  await waitFor(async()=>(await api(lender.app,'/api/lending')).counters?.pending===null,'Stop recovery cleared');
  assert.equal((await api(lender.app,'/api/lending')).enabled,false,'Stop leaves lending off');
  assert.equal((await api(lender.app,'/api/status')).intent.state,'off');
  await api(lender.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id}});
  await waitFor(async()=>{const state=await api(lender.app,'/api/lending');const status=await api(lender.app,'/api/status');return state.enabled===true&&status.intent.state==='ready';},'ready after the owner Resumes');
  const waitingB=await waitFor(async()=>{const rows=await api(lender.app,'/api/approvals');return rows.find(card=>card.jobDigest===second.jobDigest);},'Job B review after Stop');
  await api(lender.app,'/api/approvals/'+waitingB.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.filter(([kind])=>kind==='run').length===2,'Job B running');
  await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId:attemptA,confirmed:true},status:409});
  assert.equal((await api(lender.app,'/api/lending')).current===attemptA,false);
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='cancel').length,1,'the stale Stop did not cancel Job B');
});

test('a resume refused while the lender is still stopping keeps the Stop explanation',testOptions,async t=>{
  // The lender's stopped report is held once the coordinator has recorded it, so the lender stays "Stopping…" until released.
  const hold={armed:true};
  hold.arrived=new Promise(resolve=>{hold.markArrived=resolve;});
  hold.open=new Promise(resolve=>{hold.release=resolve;});
  t.after(()=>hold.release());
  const lenderFetch=async(url,options)=>{
    const response=await boundedFetch(url,{...options,headers:{...options?.headers,'x-test-device':'lender'}});
    if(hold.armed&&/\/attempts\/[^/]+\/stopped$/.test(new URL(url).pathname)){hold.armed=false;hold.markArrived();await hold.open;}
    return response;
  };
  const f=await admissionFixture(t,{hold:true}),{owner,lender,circle}=await f.connect({fetch:lenderFetch});
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'running fake sandbox');
  const attemptId=(await api(lender.app,'/api/lending')).current;
  const person=(await api(lender.app,'/api/status')).runningJob?.requester;
  await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:true}});
  await bounded(hold.arrived,'the lender sends its stopped report');
  await waitFor(()=>f.jobs.get(submitted.jobDigest).current_attempt.compute_stopped,'verified cessation report');
  const refused=await api(lender.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id},status:409});
  assert.equal(refused.code,'lending_recovery_required');
  assert.deepEqual((await api(lender.app,'/api/status')).stoppedJob,{requester:person},'the refused resume keeps the reason');
  hold.release();
  // "stopped" is only a brief status (see the test above), so wait for the pending stop record to clear.
  await waitFor(async()=>{const state=await api(lender.app,'/api/lending');return Boolean(state.counters)&&state.counters.pending==null;},'lender cleared its pending stop');
  await api(lender.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id}});
  assert.equal((await api(lender.app,'/api/status')).stoppedJob,undefined,'turning lending on clears the reason');
});
test('stop action without a current local attempt does not enable lending',testOptions,async t=>{
  const f=await appFixture(t),{app}=await f.start();
  const problem=await api(app,'/api/lending/stop',{method:'POST',body:{attemptId:'stale-attempt',confirmed:true},status:409});
  assert.equal(problem.code,'no_current_job');
  assert.equal((await api(app,'/api/lending')).enabled,false);
});

test('restart of a pending Stop holds queued claims until cessation proof, and lending stays off until Resume',testOptions,async t=>{
  const f=await admissionFixture(t,{hold:true}),{owner,lender,circle}=await f.connect();
  await lendingOn(lender.app,circle);
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  const card=await review(lender.app);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'running sandbox before restart');
  const queued=await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),prompt:'Queued until stop proof'}});
  const destroy=lender.backend.destroy.bind(lender.backend);
  lender.backend.destroy=async handle=>{await destroy(handle);return {removed:false};};
  const {current:attemptId}=await api(lender.app,'/api/lending');
  await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:true}});
  await waitFor(async()=>(await api(lender.app,'/api/lending')).reason==='cessation_unverified','unverified stop before restart');
  await bounded(lender.app.close(),'stop-recovery restart close');
  let releaseRecovery,enteredRecovery;
  const recoveryGate=new Promise(resolve=>{releaseRecovery=resolve;});
  const recoveryStarted=new Promise(resolve=>{enteredRecovery=resolve;});
  t.after(()=>releaseRecovery());
  const backend=syntheticBackend(f.root);
  backend.reconcilePending=async pending=>{enteredRecovery();await recoveryGate;return {removed:true,attemptId:pending.attemptId};};
  const restarted=await f.start('lender',{backend});
  await bounded(recoveryStarted,'restarted pending cessation reconciliation');
  assert.equal((await api(restarted.app,'/api/lending')).intent,'off');
  assert.equal((await api(restarted.app,'/api/lending')).enabled,false);
  assert.equal(f.jobs.get(queued.jobDigest).state,'queued');
  assert.equal(f.jobs.get(queued.jobDigest).current_attempt,null,'the pending reservation blocks queued work after restart');
  assert.equal(backend.calls.filter(([kind])=>kind==='run').length,0);
  releaseRecovery();
  await waitFor(()=>f.jobs.get(submitted.jobDigest).current_attempt.compute_stopped,'restarted cessation');
  await waitFor(async()=>(await api(restarted.app,'/api/lending')).counters?.pending===null,'restart recovery cleared');
  const state=await api(restarted.app,'/api/lending');
  assert.equal(state.enabled,false,'recovery leaves lending off');
  assert.equal(JSON.parse(await readFile(join(restarted.home,'v1','app-settings.json'),'utf8')).intent,'off');
  assert.equal(backend.calls.some(([kind])=>kind==='run'),false);
  await waitFor(async()=>!(JSON.parse(await readFile(join(restarted.home,'v1','app-counters.json'),'utf8')).pending),'recovery counters cleared');
  await api(restarted.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id}});
  assert.equal((await api(restarted.app,'/api/lending')).intent,'on');
  const queuedCard=await review(restarted.app);
  await api(restarted.app,'/api/approvals/'+queuedCard.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>f.jobs.get(queued.jobDigest).current_attempt?.attempt_id,'queued work can claim after cessation proof');
  await waitFor(()=>backend.calls.filter(([kind])=>kind==='run').length===1,'queued work starts after cessation proof');
  assert.equal(backend.calls.filter(([kind])=>kind==='run').length,1,'new work starts only after cessation proof');
});

test('Home snapshots expose observation time while the conservative defaults stay unchanged',testOptions,async t=>{
  let time=Date.now();
  const f=await appFixture(t),{app}=await f.start('default-guide',{clock:{now:()=>time}});
  const first=await api(app,'/api/home');
  assert.ok(first.observedAt>=time);assert.equal(first.lending.enabled,false);
  assert.equal(first.lending.mode,'auto');assert.deepEqual(first.lending.limits,APP_DEFAULTS);
  assert.deepEqual([APP_DEFAULTS.dailyJobs,APP_DEFAULTS.dailyMinutes,APP_DEFAULTS.maxWallSeconds],[null,null,null]);
  assert.ok((await api(app,'/api/agents')).every(a=>a.useForLending===false));
  const sameClock=await api(app,'/api/home');
  assert.ok(sameClock.observedAt>first.observedAt,'same-clock responses still have strict ordering');
  time+=1000;
  const next=await api(app,'/api/home');
  assert.equal(next.observedAt,time);assert.ok(next.observedAt>first.observedAt);
  assert.equal(next.lending.enabled,false);
});
test('expired approval cannot start even when its timer or readiness response is delayed',testOptions,async t=>{
  for(const duringReadiness of [false,true])await t.test(duringReadiness?'deadline passes during preflight':'timer has not fired',async t=>{
    let time=Date.now();
    const approvalTimers=manualTimers();
    const f=await appFixture(t),{owner,lender,circle}=await f.connect({approvalTimers,clock:{now:()=>time}});
    const job=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
    await lendingOn(lender.app,circle,{approvalTimeoutMs:60000});
    const card=await review(lender.app);
    assert.equal(card.expiresAt,Date.parse(f.jobs.get(job.jobDigest).job.payload.expires_at));
    if(duringReadiness) {
      const protection=lender.backend.protectionSummary.bind(lender.backend);
      lender.backend.protectionSummary=async(...args)=>{
        const result=await protection(...args);time=card.expiresAt;return result;
      };
    } else time=card.expiresAt;
    const response=await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{},status:409});
    assert.equal(response.code,'approval_expired');
    assert.equal(f.jobs.get(job.jobDigest).current_attempt,null,'an expired offer never held an attempt');
    assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);
    assert.equal((await api(lender.app,'/api/approvals')).length,0);
    const event=(await api(lender.app,'/api/activity?after=0')).find(e=>e.type==='approval'&&e.data.id===card.id&&e.data.state);
    assert.equal(event.data.state,'expired');
  });
});

test('Home reports each saved approval mode without enabling lending or choosing an agent',testOptions,async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  let home=await api(lender.app,'/api/home');
  assert.equal(home.circles.find(c=>c.id===circle.id).lendingMode,'auto');
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  home=await api(lender.app,'/api/home');
  assert.equal(home.circles.find(c=>c.id===circle.id).lendingMode,'auto');
  assert.equal(home.lending.enabled,false);assert.equal(home.lending.circle,null);
  assert.ok((await api(lender.app,'/api/agents')).every(a=>a.useForLending===false));
});

const requesterLimitPath='/api/lending/requester-limits';
const deviceLimit = (view,circle,keyId) => view.circles.find(c=>c.circle===circle).members.find(m=>m.key_id===keyId);

test('requester-limit route validates fields and roster membership, persists and clears exact-key caps',testOptions,async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const keyId=owner.app.device.keyId,base={circle:circle.id,keyId};
  const post=(body,status=200)=>api(lender.app,requesterLimitPath,{method:'POST',body,status});
  assert.deepEqual((await api(lender.app,'/api/lending')).requesterLimits,[]);
  for(const limits of [[],false,{dailyJobs:-1},{dailyMinutes:1.5},{dailyJobs:'2'},{dailyMinutes:2147484},{other:1}])
    assert.equal((await post({...base,limits},400)).code,'invalid_request');
  for(const body of [{...base},{...base,limits:null,extra:true},{...base,keyId:'short',limits:null}])
    assert.equal((await post(body,400)).code,'invalid_request');
  assert.equal((await post({...base,keyId:'sha256:'+'f'.repeat(64),limits:{dailyJobs:1}},404)).code,'not_found');
  await api(lender.app,requesterLimitPath,{method:'POST',body:{...base,limits:{dailyJobs:1}},token:null,status:401});
  const saved=await post({...base,limits:{dailyJobs:2,dailyMinutes:25}});
  assert.deepEqual(saved.requesterLimits,[{...base,dailyJobs:2,dailyMinutes:25}]);
  const same=await post({...base,limits:{dailyJobs:2,dailyMinutes:25}});
  assert.deepEqual(same.requesterLimits,saved.requesterLimits,'repeat save replaces one exact cap');

  await api(lender.app,'/api/circles/'+circle.id+'/petnames',{method:'POST',body:{keyId,label:'Alex'}});
  await api(lender.app,'/api/circles/'+circle.id+'/petnames',{method:'POST',body:{keyId:lender.app.device.keyId,label:'Alex'},status:409});
  const devices=await api(lender.app,'/api/devices'),member=deviceLimit(devices,circle.id,keyId);
  assert.equal(member.localName,'Alex');
  assert.deepEqual(member.requesterLimits.limits,{dailyJobs:2,dailyMinutes:25});
  assert.deepEqual(member.requesterLimits.usage,{jobs:0,milliseconds:0});
  assert.deepEqual(deviceLimit(devices,circle.id,lender.app.device.keyId).requesterLimits.limits,{dailyJobs:null,dailyMinutes:null},
    'an attempted duplicate local name never merges key caps');
  await api(lender.app,'/api/circles/'+circle.id+'/petnames',{method:'POST',body:{keyId,label:'Renamed'}});
  assert.deepEqual((await api(lender.app,'/api/lending')).requesterLimits,saved.requesterLimits);

  const disk=JSON.parse(await readFile(join(lender.home,'v1','app-settings.json'),'utf8'));
  assert.deepEqual(disk.requesterLimits,saved.requesterLimits);
  await bounded(lender.app.close(),'requester limit restart');
  const restarted=await f.start('lender');
  assert.deepEqual((await api(restarted.app,'/api/lending')).requesterLimits,saved.requesterLimits);
  assert.equal(deviceLimit(await api(restarted.app,'/api/devices'),circle.id,keyId).localName,'Renamed');
  await api(restarted.app,requesterLimitPath,{method:'POST',body:{...base,limits:null}});
  assert.deepEqual((await api(restarted.app,'/api/lending')).requesterLimits,[]);
  assert.deepEqual(JSON.parse(await readFile(join(restarted.home,'v1','app-settings.json'),'utf8')).requesterLimits,[]);
});

test('a requester-limited job has no review card and Home explains the release',testOptions,async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  await api(lender.app,requesterLimitPath,{method:'POST',body:{circle:circle.id,keyId:owner.app.device.keyId,limits:{dailyJobs:0}}});
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  await waitFor(async()=>(await api(lender.app,'/api/home')).attention.some(x=>x.label==='A job was skipped because this device reached its daily lending limit.'),'requester cap explained');
  assert.equal(f.jobs.get(submitted.jobDigest).current_attempt,null);
  assert.equal((await api(lender.app,'/api/approvals')).length,0);
  assert.equal(lender.backend.calls.some(([kind])=>kind==='run'),false);
  const home=await api(lender.app,'/api/home');
  assert.ok(home.attention.some(x=>x.label==='A job was skipped because this device reached its daily lending limit.'));
  assert.equal((await api(lender.app,'/api/activity?after=0')).some(e=>e.type==='approval'),false);
});

test('review projects exact requester limits and usage; edits can close review but not alter running budgets',testOptions,async t=>{
  const f=await admissionFixture(t,{hold:true}),{owner,lender,circle}=await f.connect();
  const keyId=owner.app.device.keyId,base={circle:circle.id,keyId};
  await api(lender.app,'/api/circles/'+circle.id+'/petnames',{method:'POST',body:{keyId,label:'Local friend'}});
  await api(lender.app,requesterLimitPath,{method:'POST',body:{...base,limits:{dailyJobs:2,dailyMinutes:40}}});
  const first=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  assert.equal(card.localName,'Local friend');
  assert.deepEqual(card.requesterLimits.limits,{dailyJobs:2,dailyMinutes:40});
  assert.deepEqual(card.requesterLimits.usage,{jobs:0,milliseconds:0});
  await api(lender.app,requesterLimitPath,{method:'POST',body:{...base,limits:{dailyJobs:0}}});
  await waitFor(async()=>!(await api(lender.app,'/api/approvals')).length,'new review limit');
  assert.equal(f.jobs.get(first.jobDigest).current_attempt,null);
  assert.equal((await api(lender.app,'/api/approvals')).length,0);
  assert.equal(lender.backend.calls.some(([kind])=>kind==='run'),false);
  await waitFor(async()=>!(await api(lender.app,'/api/lending')).current,'released review cleanup');
  await api(lender.app,requesterLimitPath,{method:'POST',body:{...base,limits:{dailyJobs:2,dailyMinutes:40}}});
  const second=await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),prompt:'A second bounded task.'}});
  const next=await waitFor(async()=>(await api(lender.app,'/api/approvals')).find(row=>row.jobDigest===second.jobDigest),'second offer review');
  assert.equal(next.jobDigest,second.jobDigest);
  await api(lender.app,'/api/approvals/'+next.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'reserved running task');
  await api(lender.app,requesterLimitPath,{method:'POST',body:{...base,limits:null},status:409});
  const member=deviceLimit(await api(lender.app,'/api/devices'),circle.id,keyId);
  assert.deepEqual(member.requesterLimits.usage,{jobs:1,milliseconds:1200000});
  const state=await api(lender.app,'/api/lending');
  assert.deepEqual(state.requesterLimits,[{...base,dailyJobs:2,dailyMinutes:40}]);
  await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId:state.current,confirmed:true}});
  await waitFor(()=>f.jobs.get(second.jobDigest).current_attempt.compute_stopped,'test task stopped');
});

test('requester usage is projected from durable counters when lending is off and respects local rollover',testOptions,async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const keyId=owner.app.device.keyId,key=JSON.stringify([circle.id,keyId]);
  const timeZone=(await api(lender.app,'/api/lending')).limits.timeZone;
  const now=Date.now(),parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'})
    .formatToParts(new Date(now)).reduce((out,p)=>(out[p.type]=p.value,out),{});
  const day=parts.year+'-'+parts.month+'-'+parts.day;
  const counterFile=join(lender.home,'v1','app-counters.json');
  await writeFile(counterFile,JSON.stringify({day,jobs:2,milliseconds:60000,pending:null,requesters:{[key]:{jobs:2,milliseconds:60000}}}));
  let member=deviceLimit(await api(lender.app,'/api/devices'),circle.id,keyId);
  assert.deepEqual(member.requesterLimits.usage,{jobs:2,milliseconds:60000});
  await writeFile(counterFile,JSON.stringify({day:'2000-01-01',jobs:2,milliseconds:60000,pending:null,requesters:{[key]:{jobs:2,milliseconds:60000}}}));
  member=deviceLimit(await api(lender.app,'/api/devices'),circle.id,keyId);
  assert.deepEqual(member.requesterLimits.usage,{jobs:0,milliseconds:0});assert.equal(member.requesterLimits.carried,false);
  await writeFile(counterFile,JSON.stringify({day:'2000-01-01',jobs:2,milliseconds:60000,pending:{attemptId:'unknown'},
    requesters:{[key]:{jobs:2,milliseconds:60000}}}));
  member=deviceLimit(await api(lender.app,'/api/devices'),circle.id,keyId);
  assert.equal(member.requesterLimits.carried,true);assert.equal(member.requesterLimits.day,'2000-01-01');
  assert.deepEqual(member.requesterLimits.usage,{jobs:2,milliseconds:60000});
  await api(lender.app,requesterLimitPath,{method:'POST',body:{circle:circle.id,keyId,limits:{dailyJobs:1}},status:409});
});

test('borrower verdicts are explicit, private, author-only and durable across restart',testOptions,async t=>{
  const f=await admissionFixture(t),peers=await f.connect();
  const {lender,circle}=peers;
  let owner=peers.owner;
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  const digest=submitted.jobDigest,path=jobPath(digest),query='?circle='+encodeURIComponent(circle.id);
  const outcome={verdict:'used',note:'PRIVATE_BORROWER_NOTE_81c7',checks:'PRIVATE_CHECKS_923b: ran local tests; all passed.'};
  const post=(app,value,extra={})=>api(app,path+'/outcome',{method:'POST',body:{circle:circle.id,outcome:value},...extra});
  const initial=await api(owner.app,path+query);
  assert.equal(initial.borrowerCircle,circle.id);
  const named=await api(owner.app,path+'?circle='+encodeURIComponent(circle.name));
  assert.equal(named.borrowerCircle,circle.id,'circle names resolve to the same local submission intent');
  assert.deepEqual(named.waitingTiming,initial.waitingTiming);
  assert.equal(initial.borrowerOutcome,null);
  assert.equal((await api(owner.app,path+query)).canSetBorrowerOutcome,false);
  assert.equal((await post(owner.app,outcome,{status:409})).code,'result_not_delivered');
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitForResult(f,{owner,lender,circle},digest,'delivered result before verdict');
  const delivered=await api(owner.app,path+query);
  assert.equal(delivered.canSetBorrowerOutcome,true);
  assert.equal(delivered.borrowerOutcome,null,'delivery is not a usefulness verdict');
  const signedBefore=JSON.stringify(f.jobs.get(digest));
  const response=await boundedFetch(owner.app.origin+path+'/result'+query,
    {headers:{'x-faravan-session-token':owner.app.token}});
  assert.equal(response.status,200);await response.arrayBuffer();
  await api(owner.app,path+'/transcript'+query);
  assert.equal((await api(owner.app,path+query)).borrowerOutcome,null,'downloads and transcript claims are not borrower checks');
  assert.equal((await post(lender.app,outcome,{status:403})).code,'not_author');
  const wrongCircle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Other verdict circle'}});
  await api(owner.app,path+'/outcome',{method:'POST',body:{circle:wrongCircle.id,outcome},status:403});
  await api(owner.app,jobPath('sha256:'+'f'.repeat(64))+'/outcome',{method:'POST',body:{circle:circle.id,outcome},status:403});
  await api(owner.app,jobPath('bad-digest')+'/outcome',{method:'POST',body:{circle:circle.id,outcome},status:400});
  await api(owner.app,path+'/outcome',{method:'POST',body:{outcome},status:400});
  for(const invalid of [{verdict:'accepted'},[],{verdict:'used',note:7},{verdict:'used',note:'n'.repeat(1001)},
    {verdict:'used',checks:'c'.repeat(4001)},{verdict:'used',receipt:{status:'passed'}}]) {
    await post(owner.app,invalid,{status:400});
  }
  assert.deepEqual(await post(owner.app,outcome),{borrowerOutcome:outcome});
  assert.deepEqual(await post(owner.app,outcome),{borrowerOutcome:outcome},'repeat save is idempotent');
  assert.deepEqual((await api(owner.app,path+query)).borrowerOutcome,outcome);
  const listed=(await api(owner.app,'/api/jobs?circle='+circle.id)).find(job=>job.job_digest===digest);
  assert.deepEqual(listed.borrowerOutcome,outcome);
  const lenderView=await api(lender.app,path+query);
  assert.equal(lenderView.borrowerOutcome,null);assert.equal(lenderView.canSetBorrowerOutcome,false);
  const changed={verdict:'needs-more-work',note:'PRIVATE_REWORK_NOTE_739a',checks:'PRIVATE_FAILED_CHECK_d1e8'};
  await post(owner.app,changed);
  await bounded(owner.app.close(),'borrower verdict restart');
  owner=await f.start('owner');
  assert.deepEqual((await api(owner.app,path+query)).borrowerOutcome,changed);
  const unused={verdict:'unused',note:'PRIVATE_UNUSED_REASON_f4e2',checks:''};
  await post(owner.app,unused);
  assert.deepEqual((await api(owner.app,path+query)).borrowerOutcome,unused);
  assert.deepEqual(await post(owner.app,null),{borrowerOutcome:null});
  assert.deepEqual(await post(owner.app,null),{borrowerOutcome:null},'clear is idempotent');
  assert.equal((await api(owner.app,path+query)).borrowerOutcome,null);
  assert.equal((await api(owner.app,'/api/jobs?circle='+circle.id)).find(job=>job.job_digest===digest).borrowerOutcome,null);
  await bounded(owner.app.close(),'cleared verdict restart');
  owner=await f.start('owner');
  assert.equal((await api(owner.app,path+query)).borrowerOutcome,null);
  assert.equal(JSON.stringify(f.jobs.get(digest)),signedBefore,'signed jobs, receipts and result records are unchanged');
  const outbound=JSON.stringify(f.rawRequests);
  for(const marker of [outcome.note,outcome.checks,changed.note,changed.checks,unused.note,'borrowerOutcome','borrowerCircle','canSetBorrowerOutcome','"verdict"']) {
    assert.ok(!outbound.includes(marker),'no private verdict data may reach the coordinator: '+marker);
  }
  const files=await readdir(join(owner.home,'v1'));
  assert.ok(!files.some(name=>name.startsWith('borrower-outcomes.json.')&&name.endsWith('.tmp')));
  assert.equal((await stat(join(owner.home,'v1','borrower-outcomes.json'))).mode&0o777,0o600);
});

test('undelivered cancelled and failed jobs cannot receive a borrower verdict',testOptions,async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  for(const state of ['queued','failed','cancelled','expired']) {
    const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),prompt:'Undelivered '+state}});
    f.jobs.get(submitted.jobDigest).state=state;
    const rejected=await api(owner.app,jobPath(submitted.jobDigest)+'/outcome',{method:'POST',
      body:{circle:circle.id,outcome:{verdict:'unused'}},status:409});
    assert.equal(rejected.code,'result_not_delivered');
    assert.equal((await api(owner.app,jobPath(submitted.jobDigest)+'?circle='+circle.id)).borrowerOutcome,null);
    assert.equal((await api(owner.app,'/api/jobs?circle='+circle.id)).some(job=>job.job_digest===submitted.jobDigest),true,
      'unsuccessful jobs remain in the list');
  }
});

test('local borrower store keys the exact circle and digest and preserves concurrent changes',testOptions,async t=>{
  const f=await appFixture(t),directory=join(f.root,'private-outcome-store');
  const first=createBorrowerOutcomeStore(directory),second=createBorrowerOutcomeStore(directory);
  const digest='sha256:'+'a'.repeat(64),other='sha256:'+'b'.repeat(64);
  const used={verdict:'used',note:'Only circle A',checks:''},unused={verdict:'unused',note:'Only circle B',checks:''};
  await Promise.all([first.set('circle-A',digest,used),second.set('circle-B',digest,unused),
    first.set('circle-A',other,{verdict:'needs-more-work'})]);
  assert.deepEqual(await second.get('circle-A',digest),used);
  assert.deepEqual(await first.get('circle-B',digest),unused);
  assert.equal((await second.get('circle-A',other)).verdict,'needs-more-work');
  assert.equal(await first.get('circle-a',digest),null);
  assert.equal(await first.get('circle-A','bad-digest'),null);
  await first.set('circle-A',digest,null);
  assert.equal(await second.get('circle-A',digest),null);
  assert.deepEqual(await first.get('circle-B',digest),unused);
  assert.equal((await first.get('circle-A',other)).verdict,'needs-more-work');
});

test('task invitations offer only this device\'s own waiting jobs in the exact circle',testOptions,async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const submit=(who,prompt)=>api(who.app,'/api/jobs',{method:'POST',body:{...gitInput(circle),prompt}});
  const own=await submit(owner,'PRIVATE_PROMPT_NOT_FOR_INVITATION\nSecond private line.');
  await api(owner.app,jobPath(own.jobDigest)+'/title',{method:'POST',body:{title:'Fix the greeting'}});
  const other=await submit(lender,'Another member task');
  const cancelled=await submit(owner,'Cancelled task');
  await api(owner.app,jobPath(cancelled.jobDigest)+'/cancel',{method:'POST',body:{}});
  const list=await api(owner.app,'/api/jobs?circle='+circle.id);
  const choices=waitingInviteTasks(list,circle.id);
  assert.deepEqual(choices.map(task=>task.jobDigest),[own.jobDigest]);
  assert.equal(choices[0].title,'Fix the greeting');
  assert.deepEqual(waitingInviteTasks(list,'wrong-circle'),[]);
  assert.deepEqual(waitingInviteTasks(list,circle.id,choices[0].expiresAt),[]);
  const lenderList=await api(lender.app,'/api/jobs?circle='+circle.id);
  assert.equal(lenderList.find(job=>job.job_digest===own.jobDigest).state,'queued',
    'an approved invited member can see the waiting job through the authenticated listing');
  assert.deepEqual(waitingInviteTasks(lenderList,circle.id).map(task=>task.jobDigest),[other.jobDigest]);
  assert.equal(lenderList.find(job=>job.job_digest===own.jobDigest).inviteTask,null,
    'another member never receives this device local title as an invitation choice');
  const another=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Another circle'}});
  assert.deepEqual(waitingInviteTasks(await api(owner.app,'/api/jobs?circle='+another.id),another.id),[]);
  assert.deepEqual(waitingInviteTasks([{...list.find(job=>job.job_digest===own.jobDigest),state:'running'}],circle.id),[]);
});

test('favor message preserves invitation bytes and all outbound request bodies',testOptions,async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await api(owner.app,jobPath(submitted.jobDigest)+'/title',{method:'POST',body:{title:'A small useful task'}});
  const [task]=waitingInviteTasks(await api(owner.app,'/api/jobs?circle='+circle.id),circle.id);
  assert.ok(task);
  const result=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  const signedBefore=JSON.stringify([...f.circles]),requestsBefore=JSON.stringify(f.rawRequests);
  const calls=[];
  const mutate=async(path,body)=>{calls.push({path,body:JSON.stringify(body)});return structuredClone(result);};
  const plain=await createTaskInvitation(mutate,circle.id,null);
  const chosen=await createTaskInvitation(mutate,circle.id,task);
  assert.deepEqual(calls[0],calls[1],'the local invite request is identical with and without a task');
  assert.equal(calls[0].body,'{}');
  assert.equal(plain.message,result.invite);
  assert.equal(chosen.message,'Can you help with one task? A small useful task. Join my Faravan circle: '+result.invite);
  assert.equal(chosen.invite,result.invite);
  assert.deepEqual(p.decodeShortLink(chosen.invite),p.decodeShortLink(plain.invite));
  assert.equal(JSON.stringify([...f.circles]),signedBefore,'signed invitation records are unchanged');
  assert.equal(JSON.stringify(f.rawRequests),requestsBefore,'choosing and copying a task adds or changes no coordinator request');
  assert.equal(invitationMessage(result.invite,null),result.invite);
  assert.ok(!chosen.message.includes(gitInput(circle).prompt));
  assert.ok(!chosen.message.includes(gitInput(circle).git));
});

test('borrower waiting timestamps come from the existing exact-circle signed intent',testOptions,async t=>{
  const time=Date.now();
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  const record=f.jobs.get(submitted.jobDigest),signedBefore=JSON.stringify(record.job);
  const expected={submittedAt:record.job.payload.created_at,expiresAt:record.job.payload.expires_at};
  assert.ok(Number.isFinite(Date.parse(expected.submittedAt)));
  assert.ok(Date.parse(expected.expiresAt)>time);
  const query='?circle='+circle.id;
  assert.deepEqual((await api(owner.app,jobPath(submitted.jobDigest)+query)).waitingTiming,expected);
  const list=await api(owner.app,'/api/jobs'+query);
  assert.deepEqual(list.find(job=>job.job_digest===submitted.jobDigest).waitingTiming,expected);
  assert.equal((await api(lender.app,jobPath(submitted.jobDigest)+query)).waitingTiming,null);
  assert.equal(JSON.stringify(record.job),signedBefore,'no signed timestamps are rewritten');
  assert.ok(!JSON.stringify(f.rawRequests).includes('waitingTiming'));
});

for(const change of ['save','change','delete','delete-recreate','member-removed','device-renamed','roster-epoch','root','roster-expired']) {
  test('approval identity changes block execution: '+change,testOptions,async t=>{
    const f=await appFixture(t),{owner,lender,circle}=await f.connect();
    const keyId=owner.app.device.keyId,namePath='/api/circles/'+circle.id+'/petnames';
    const save=label=>api(lender.app,namePath,{method:'POST',body:{keyId,label}});
    if(['change','delete','delete-recreate'].includes(change))await save('Before');
    await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
    await lendingOn(lender.app,circle);
    const card=await review(lender.app);
    assert.equal(card.identity.circle,circle.id);
    assert.equal(card.identity.requester,keyId);
    assert.equal(card.identity.memberPresent,true);
    assert.equal(card.identity.rosterFresh,true);
    assert.equal(card.identity.rootMatches,true);
    assert.equal(card.identity.circleMatches,true);
    if(change==='save'||change==='change')await save('After');
    else if(change==='delete'||change==='delete-recreate'){
      await api(lender.app,namePath+'/delete',{method:'POST',body:{keyId}});
      if(change==='delete-recreate')await save('Before');
    }else if(change==='root'){
      const select=lender.app.device.selectCircle.bind(lender.app.device);
      t.mock.method(lender.app.device,'selectCircle',async id=>({...await select(id),pinnedRootFingerprint:'sha256:'+'f'.repeat(64)}));
    }else{
      const rosterCache=lender.app.device.rosterCache.bind(lender.app.device);
      // Inject a newly observed cache as an offline stand-in for a verified roster refresh.
      t.mock.method(lender.app.device,'rosterCache',id=>{
        const cache=rosterCache(id);
        return {...cache,async get(){
          const state=structuredClone(await cache.get()),p=state.current.payload;
          if(change==='member-removed')p.members=p.members.filter(m=>m.key_id!==keyId);
          if(change==='device-renamed')p.members.find(m=>m.key_id===keyId).device_name='Renamed remote laptop';
          if(change==='roster-epoch')p.epoch++;
          if(change==='roster-expired')p.valid_until=new Date(0).toISOString();
          return state;
        }};
      });
    }
    if(['save','change','delete','delete-recreate'].includes(change)) {
      // The viewer's own naming action re-shows the card at once: new ID, no warning, old accept cannot run.
      const shown=(await api(lender.app,'/api/approvals'))[0];
      assert.notEqual(shown.id,card.id);
      assert.equal(shown.localName,change==='save'||change==='change'?'After':change==='delete'?null:'Before');
      assert.equal(shown.identityNotice,null);
      assert.equal(shown.expiresAt,card.expiresAt,'refresh cannot extend the deadline');
      await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{},status:404});
      assert.equal(lender.backend.calls.some(([kind])=>kind==='run'),false);
      await api(lender.app,'/api/approvals/'+shown.id+'/skip',{method:'POST',body:{}});
      return;
    }
    const retained=(await api(lender.app,'/api/approvals'))[0];
    assert.deepEqual(retained.identity,card.identity,'GET cannot relabel an open review');
    assert.equal(retained.localName,card.localName);
    const denied=await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{},status:409});
    assert.equal(denied.code,'identity_changed');
    assert.equal(denied.message,"The requester's details changed. Review the job again.");
    const refreshed=await review(lender.app);
    assert.notEqual(refreshed.id,card.id);
    assert.equal(refreshed.expiresAt,card.expiresAt,'refresh cannot extend the deadline');
    assert.notDeepEqual(refreshed.identity,card.identity);
    await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{},status:404});
    assert.equal(lender.backend.calls.some(([kind])=>kind==='run'),false);
    await api(lender.app,'/api/approvals/'+refreshed.id+'/skip',{method:'POST',body:{}});
  });
}
test('fresh identity review accepts, and an edit during preflight cannot run the stale card',testOptions,async t=>{
  const f=await admissionFixture(t),{owner,lender,circle}=await f.connect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app),summary=lender.backend.protectionSummary;
  let unblock,entered;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{unblock=resolve;});
  lender.backend.protectionSummary=async(...args)=>{entered();await gate;return summary(...args);};
  // A rename during preflight re-shows the card under a new ID, so the in-flight accept finds nothing to run.
  const accepting=api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{},status:404});
  await bounded(started);
  await api(lender.app,'/api/circles/'+circle.id+'/petnames',{method:'POST',
    body:{keyId:owner.app.device.keyId,label:'Updated during preflight'}});
  unblock();
  assert.equal((await accepting).code,'not_found');
  assert.equal(lender.backend.calls.some(([kind])=>kind==='run'),false);
  lender.backend.protectionSummary=summary;
  const fresh=await review(lender.app);
  assert.equal(fresh.localName,'Updated during preflight');
  await api(lender.app,'/api/approvals/'+fresh.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>f.jobs.get(submitted.jobDigest).state==='result-accepted','freshly reviewed result');
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,1);
});

const contributionEvent=(extra={})=>({circle:'circle-a',keyId:'sha256:'+'a'.repeat(64),
  jobDigest:'sha256:'+'b'.repeat(64),attemptId:'attempt-a',kind:'delivered',at:40*86400000,...extra});

test('local contributions use exact circle/key, unique jobs, rolling windows and raw runtime',()=>{
  const at=40*86400000,day=86400000;
  const events=[
    contributionEvent(),
    contributionEvent({attemptId:'retry'}),
    contributionEvent({circle:'circle-b'}),
    contributionEvent({keyId:'sha256:'+'c'.repeat(64)}),
    contributionEvent({kind:'skipped',at:at-8*day}),
    contributionEvent({kind:'timedOut',at:at-30*day}),
    contributionEvent({kind:'failed',at:at-30*day-1}),
    contributionEvent({kind:'accepted',at:at+1}),
    contributionEvent({kind:'run',at:at-7*day}),
    contributionEvent({kind:'runtime',startedAt:at-7*day-30000,milliseconds:60000}),
    contributionEvent({kind:'runtime',startedAt:at-7*day-30000,milliseconds:60000}),
  ];
  const summary=summarizeContributions({events},at);
  assert.equal(summary.windows[7].rows.length,3);
  assert.equal(summary.windows[7].jobs,3,'retries are one delivered job per exact pair');
  assert.equal(summary.windows[7].devices,3,'no cross-circle or same-name merging');
  const row=summary.windows[7].rows[0];
  assert.equal(row.minutes,.5,'only runtime overlapping the window counts');
  assert.equal(row.unmeasuredRuns,0);assert.equal(row.accepted,0);assert.equal(row.skipped,0);
  assert.equal(summary.windows[30].rows[0].skipped,1);
  assert.equal(summary.windows[30].rows[0].timedOut,1);
  assert.equal(summary.windows[30].rows[0].failed,0);
  assert.equal(summary.independentPeople,null);assert.equal(summary.independentCircles,null);
});

test('an unreadable contribution history is reported as unreadable and never replaced by one event',testOptions,async t=>{
  const f=await appFixture(t),home=await f.home('contribution-unreadable'),file=join(home,'contributions.json');
  const bytes=JSON.stringify({version:1,truncated:false,corrupt:false,events:[contributionEvent()]}).slice(0,-5);
  await writeFile(file,bytes);
  const log=createContributionLog(file);
  await assert.rejects(log.append(contributionEvent({attemptId:'later'})),{code:'state_unknown'});
  assert.equal(await readFile(file,'utf8'),bytes);
  const view=await log.snapshot();
  assert.equal(view.unreadable,true);assert.equal(view.corrupt,true);assert.deepEqual(view.events,[]);
  assert.equal(summarizeContributions(view).unreadable,true);
  await rm(file);
  assert.equal((await createContributionLog(file).snapshot()).unreadable,undefined,'a missing file is an empty history');
});

test('contribution log persists, deduplicates retries and caps atomic private snapshots',testOptions,async t=>{
  const f=await appFixture(t),home=await f.home('contribution-log'),file=join(home,'contributions.json');
  const log=createContributionLog(file),event=contributionEvent();
  await Promise.all([log.append(event),log.append({...event,at:event.at+1})]);
  let saved=await createContributionLog(file).snapshot();
  assert.equal(saved.events.length,1);assert.deepEqual(saved.events[0],event);
  assert.equal((await stat(file)).mode&0o777,0o600);
  const entries=Array.from({length:CONTRIBUTION_LIMITS.events},(_,i)=>contributionEvent({attemptId:'attempt-'+i}));
  await writeFile(file,JSON.stringify({version:1,truncated:false,corrupt:false,events:entries}));
  const capped=createContributionLog(file);
  await capped.append(contributionEvent({attemptId:'newest'}));
  saved=await createContributionLog(file).snapshot();
  assert.equal(saved.events.length,CONTRIBUTION_LIMITS.events);
  assert.equal(saved.events[0].attemptId,'attempt-1');
  assert.equal(saved.events.at(-1).attemptId,'newest');assert.equal(saved.truncated,true);
  assert.ok((await stat(file)).size<=CONTRIBUTION_LIMITS.bytes);
  assert.equal((await readdir(home)).some(name=>name.endsWith('.tmp')),false);
});

test('corrupt and oversized local contribution logs read as unreadable and are never replaced',testOptions,async t=>{
  const f=await appFixture(t),home=await f.home('corrupt-contributions'),file=join(home,'contributions.json');
  for(const invalid of ['{broken',JSON.stringify({version:1,events:[{kind:'delivered'}]}),
    ' '.repeat(CONTRIBUTION_LIMITS.bytes+1)]) {
    await writeFile(file,invalid);
    const log=createContributionLog(file);
    const view=await log.snapshot();
    assert.equal(view.corrupt,true);assert.equal(view.unreadable,true);assert.deepEqual(view.events,[]);
    await assert.rejects(log.append(contributionEvent()),{code:'state_unknown'});
    assert.equal(await readFile(file,'utf8'),invalid);
  }
});

test('lender contributions and local names survive restart without coordinator egress',testOptions,async t=>{
  const f=await admissionFixture(t),{owner,lender,circle,realRequests}=await f.realConnect();
  const label='LOCAL_CONTRIBUTION_NAME_8195';
  await api(lender.app,'/api/circles/'+circle.id+'/petnames',{method:'POST',
    body:{keyId:owner.app.device.keyId,label}});
  await lendingOn(lender.app,circle);
  await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  const card=await review(lender.app);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  const summary=await waitFor(async()=>{
    const value=await api(lender.app,'/api/contributions');
    return value.windows[7].jobs===1&&value.windows[7].rows[0].unmeasuredRuns===0?value:null;
  },'local contribution delivery and measured runtime');
  const row=summary.windows[7].rows[0];
  assert.equal(row.localName,label);assert.equal(row.keyId,owner.app.device.keyId);
  assert.equal(row.reviewed,1);assert.equal(row.accepted,1);assert.equal(row.run,1);assert.equal(row.delivered,1);
  assert.equal(row.independentPerson,null);
  const bytes=await readFile(join(lender.home,'v1','contributions.json'),'utf8');
  assert.equal(bytes.includes(label),false,'names are looked up locally, not stored with events');
  await bounded(lender.app.close(),'contribution restart close');
  const restarted=await f.start('lender');
  const restored=await api(restarted.app,'/api/contributions');
  assert.equal(restored.windows[7].jobs,1);assert.equal(restored.windows[7].rows[0].localName,label);
  const outbound=JSON.stringify(realRequests);
  for(const privateField of [label,'"contribution"','"localName"','"independentPerson"','"unmeasuredRuns"'])
    assert.equal(outbound.includes(privateField),false,privateField+' never leaves for the coordinator');
});

test('an unanswered offer expires without counting as a lender timeout or skip',testOptions,async t=>{
 const timers=manualTimers(),f=await appFixture(t),{owner,lender,circle}=await f.connect({approvalTimers:timers});
 await lendingOn(lender.app,circle);const job=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
 await review(lender.app);timers.fireAll();await waitFor(async()=>!(await api(lender.app,'/api/approvals')).length,'offer closed');
 const summary=await api(lender.app,'/api/contributions');assert.equal(summary.windows[7].jobs,0);assert.deepEqual(summary.windows[7].rows,[]);
 assert.equal(f.jobs.get(job.jobDigest).current_attempt,null);
});

test('contribution byte cap preserves newest complete events and marks incomplete history',testOptions,async t=>{
  const f=await appFixture(t),home=await f.home('contribution-byte-cap'),file=join(home,'contributions.json');
  const event=contributionEvent({circle:'c'.repeat(256),attemptId:'a'.repeat(256)});
  const log={version:1,truncated:false,corrupt:false,events:[]};
  const eventBytes=Buffer.byteLength(JSON.stringify(event))+1;
  const count=Math.floor((CONTRIBUTION_LIMITS.bytes-200)/eventBytes);
  for(let i=0;i<count;i++)log.events.push({...event,attemptId:String(i).padStart(256,'a')});
  assert.ok(log.events.length<CONTRIBUTION_LIMITS.events);
  await writeFile(file,JSON.stringify(log));
  const store=createContributionLog(file);
  await store.append({...event,attemptId:'z'.repeat(256)});
  const saved=await store.snapshot();
  assert.equal(saved.truncated,true);assert.equal(saved.events.at(-1).attemptId,'z'.repeat(256));
  assert.ok((await stat(file)).size<=CONTRIBUTION_LIMITS.bytes);
});
test('interrupted runs keep unknown minutes rather than copying reserved budgets',()=>{
  const at=40*86400000,events=[contributionEvent({kind:'run'}),
    contributionEvent({kind:'stopped'})];
  const row=summarizeContributions({events},at).windows[7].rows[0];
  assert.equal(row.run,1);assert.equal(row.stopped,1);assert.equal(row.minutes,0);
  assert.equal(row.unmeasuredRuns,1);assert.equal(row.delivered,0);
});


test('approval helpers project titles and detect each new ID without mutating seen history',()=>{
  assert.equal(approvalTitle(0),'Faravan');
  assert.equal(approvalTitle(1),'(1) Review job · Faravan');
  assert.equal(approvalTitle(3),'(3) Review job · Faravan');
  const seen=new Set(['old']);
  assert.deepEqual(newApprovalIds([{id:'old'},{id:'new'},{id:'new'},{},null],seen),['new']);
  assert.deepEqual([...seen],['old']);
  seen.add('new');
  assert.deepEqual(newApprovalIds([{id:'new'},{id:'old'}],seen),[]);
  assert.deepEqual(newApprovalIds([],seen),[]);
  assert.deepEqual(newApprovalIds([{id:'new'}],seen),[],'a disappeared ID never becomes new again');
  assert.equal(approvalNotificationTitle({localName:'Sam',requesterName:'Laptop'}),'Sam asked for your help');
  assert.equal(approvalNotificationTitle({requesterName:'Laptop'}),'Laptop asked for your help');
  assert.equal(approvalNotificationTitle({}),'A circle member asked for your help');
  assert.equal(approvalDeadline({expiresAt:600000},0).label,'Answer within 10 minutes (10:00 left).');
  assert.equal(approvalDeadline({expiresAt:600000},1000).label,'Answer within 10 minutes (9:59 left).');
  assert.equal(approvalDeadline({expiresAt:600000},599000).seconds,1);
  assert.equal(approvalDeadline({expiresAt:600000},600000).expired,true);
});

test('legacy approval windows are ignored and removed from saved settings on restart',testOptions,async t=>{
 const f=await appFixture(t);let peer=await f.start('approval-settings');
 assert.equal(Object.hasOwn(APP_DEFAULTS,'approvalTimeoutMs'),false);
 await api(peer.app,'/api/lending/limits',{method:'POST',body:{approvalTimeoutMs:900000}});
 assert.equal(Object.hasOwn((await api(peer.app,'/api/lending')).limits,'approvalTimeoutMs'),false);
 const file=join(peer.home,'v1','app-settings.json');await bounded(peer.app.close(),'legacy setting restart');
 const saved=JSON.parse(await readFile(file,'utf8'));saved.limits.approvalTimeoutMs=30000;await writeFile(file,JSON.stringify(saved));
 peer=await f.start('approval-settings');assert.equal(Object.hasOwn((await api(peer.app,'/api/lending')).limits,'approvalTimeoutMs'),false);
});

test('agent-check timeout has its own safe actionable copy',testOptions,async t=>{
  const f=await appFixture(t);
  const {app}=await f.start('owner',{mutationTimeoutMs:5000,agentCheckTimeoutMs:20,
    identityProbe:({signal})=>new Promise(resolve=>{
      // Hang until cancellation, then acknowledge cleanup so shutdown can join this probe.
      if(signal.aborted)resolve({providers:[]});
      else signal.addEventListener('abort',()=>resolve({providers:[]}),{once:true});
    })});
  const result=await api(app,'/api/agents/refresh',{method:'POST',body:{},status:504});
  assert.deepEqual(result,{code:'agent_check_timeout',message:'Checking your agents is taking longer than expected. Try again in a minute.'});
  const {errorMessage}=await import('../ui/v1/src/helpers.mjs');
  assert.equal(errorMessage({...result,message:'PRIVATE_DIAGNOSTIC'}),'Check the agent’s sign-in on your computer before checking its state here.');
  await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
});

test('activity ignores unchanged lending observations without advancing cursors',testOptions,async t=>{
  const f=await appFixture(t),{app}=await f.start();
  // Phone setup publishes its own initial event (c4b8ef74); observe only this test's transitions.
  const cursor=(await api(app,'/api/activity?after=0')).at(-1)?.id??0;
  const pause=()=>api(app,'/api/lending/pause',{method:'POST',body:{}});
  await pause();
  const first=(await api(app,'/api/activity?after='+cursor)).at(-1);
  for(let n=0;n<5;n++)await pause();
  const activity=await api(app,'/api/activity?after='+cursor);
  assert.equal(activity.length,1);
  assert.equal(activity[0].count,1);
  assert.equal(activity[0].at,first.at);
  assert.ok(Date.parse(activity[0].lastSeen)>=Date.parse(first.at));
  assert.equal(activity[0].id,first.id);
  assert.deepEqual(await api(app,'/api/activity?after='+first.id),[]);
  await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await pause();
  const separated=await api(app,'/api/activity?after='+cursor);
  assert.equal(separated.length,2);
  assert.equal(separated[0].count,1);
  assert.equal(separated[1].type,'agents');
});

test('waiting-for-sandbox helper keeps lending on and does not expose diagnostics',async()=>{
  const {lendingView,statusView}=await import('../ui/v1/src/helpers.mjs');
  const genericExpected={label:'Waiting for setup',message:"Lending is on, but this computer can't run jobs right now. Check protected workspace setup.",remedy:'Open setup'};
  assert.deepEqual(statusView('waiting_for_sandbox'),genericExpected);
  const lending=lendingView({enabled:true,paused:false,status:'waiting_for_sandbox',reason:'sandbox_not_ready',label:'PRIVATE_DIAGNOSTIC'});
  assert.deepEqual(lending,{label:'Needs attention',message:'Set up the protected workspace to lend on this computer. You can still send jobs to another lender.',remedy:'Check lending'});
  assert.doesNotMatch(JSON.stringify(lending),/PRIVATE_DIAGNOSTIC/);
});

test('identity probe never boots a test workspace when the read-only capability gate says unavailable, and an image failure does not hide other agents', async () => {
  const calls=[];
  const backend={
    probeCapabilities(){assert.fail('repairing capability probe must not run');},
    async testWorkspace(){calls.push('workspace');return {ok:true};},
    async lenderCapabilities(){calls.push('preflight');return {available:false,reason:'sbx below the minimum version'};},
    async prepare(){calls.push('prepare');return {};},async start(){},async destroy(){return {removed:true};},
  };
  const gated=await probeFaravanIdentity({harnessNames:['codex'],backendFactory:()=>backend,readDockerAccount:async()=>null});
  assert.equal(calls.includes('workspace'),false,'no sandbox is booted before the version/capability gate');
  assert.equal(calls.includes('prepare'),false);
  assert.equal(gated.providers[0].installed,null);
  const outputs=['FARAVAN_INSTALLED=1\nSBX_CRED_OPENAI_MODE=oauth\n'];
  const imageBroken={...backend,
    async lenderCapabilities(){return {available:true};},
    async testWorkspace(){return {ok:false,cause:'image_unavailable'};},
    async prepare(spec){return {_entrypoint:spec.entrypoint};},
    async start(handle){handle._lastExecStdout=outputs.shift();}};
  const probed=await probeFaravanIdentity({harnessNames:['codex'],backendFactory:()=>imageBroken,readDockerAccount:async()=>null});
  assert.equal(probed.providers[0].installed,true,'the agent is still checked on its own image');
  assert.equal(probed.providers[0].workspace_cause,undefined);
});

test('lending keeps its agent after the sign-in check ages, and checks again in the background', testOptions, async t => {
  const f=await admissionFixture(t);let calls=0;
  const entries=legacyProxyAdapters.filter(a=>a.spec.harness_id==='codex');
  const {owner,lender,circle}=await f.connect({adapters:entries,identityCacheMs:1500,signInProbe:async()=>({signedIn:true,source:'sandbox-store'}),
    identityProbe:async()=>{calls++;return {providers:[{harness_id:'codex',installed:true,signedIn:true}]};}});
  await api(lender.app,'/api/agents/refresh',{method:'POST',body:{}});
  assert.equal(calls,1);
  await new Promise(resolve=>setTimeout(resolve,1600)); // the check is now older than the cache window
  await lendingOn(lender.app,circle);
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  const card=await review(lender.app);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>f.jobs.get(submitted.jobDigest).state==='result-accepted','job finished after approval');
  await waitFor(()=>calls>=2,'background check of the aged evidence');
});

test('a failed lending job records its code and real cause privately on the lender, never for the borrower', testOptions, async t => {
  const f=await admissionFixture(t,{runError:Object.assign(new Error('sbx exec failed: PRIVATE_LENDER_CAUSE'),{code:'sandbox_start_failed',stdout:'',stderr:'',exitCode:2})});
  const {owner,lender,circle}=await f.connect();
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>f.jobs.get(submitted.jobDigest).state==='failed','job failed');
  const file=join(lender.home,'v1','lending-errors.jsonl');
  await waitFor(async()=>{try{return (await readFile(file,'utf8')).includes(submitted.jobDigest);}catch{return false;}},'diagnostic written');
  const entry=JSON.parse((await readFile(file,'utf8')).trim().split('\n').at(-1));
  assert.equal(entry.job,submitted.jobDigest);
  assert.equal(entry.code,'sandbox_start_failed');
  assert.match(entry.message,/PRIVATE_LENDER_CAUSE/);
  assert.equal((await stat(file)).mode&0o777,0o600);
  const borrowerView=JSON.stringify([await api(owner.app,jobPath(submitted.jobDigest)),f.jobs.get(submitted.jobDigest)]);
  assert.ok(!borrowerView.includes('PRIVATE_LENDER_CAUSE'));
  // The lender reads the same record through the app, without the raw cause, with the step it failed in.
  const log=await api(lender.app,'/api/lending/log');
  assert.equal(log[0].job,submitted.jobDigest);assert.equal(log[0].phase,'run');
  assert.ok(!JSON.stringify(log).includes('PRIVATE_LENDER_CAUSE'));
  assert.deepEqual(await api(owner.app,'/api/lending/log'),[]);
});

test('lending that was on resumes after the app restarts', testOptions, async t => {
  const f=await appFixture(t);
  const {lender,circle}=await f.connect();
  await lendingOn(lender.app,circle);
  assert.equal((await api(lender.app,'/api/home')).lending.enabled,true);
  await bounded(lender.app.close(),'lender close before restart');
  const restarted=await f.start('lender');
  await waitFor(async()=>(await api(restarted.app,'/api/home')).lending.enabled===true,'lending resumed after restart');
  assert.equal((await api(restarted.app,'/api/home')).lending.circle,circle.id);
  assert.equal((await api(restarted.app,'/api/status')).state,'ready');
  await lendingTurns(restarted.app,state=>state.status==='idle');
});

test('a restart with an agent signed out keeps lending on and says what waits (a blocker never turns it off)', testOptions, async t => {
  const f=await appFixture(t);let probes=0;
  const entries=legacyProxyAdapters.filter(a=>a.spec.harness_id==='codex');
  const probe=async()=>{probes++;return {providers:[{harness_id:'codex',installed:true,signedIn:probes===1}]};};
  const {lender,circle}=await f.connect({adapters:entries,identityProbe:probe});
  await api(lender.app,'/api/agents/refresh',{method:'POST',body:{}});
  await lendingOn(lender.app,circle);
  await bounded(lender.app.close(),'lender close before restart');
  const restarted=await f.start('lender',{adapters:entries,identityProbe:probe});
  await waitFor(async()=>probes===2&&(await api(restarted.app,'/api/status')).reason==='agent_not_ready','the agent check finished and nothing can run');
  const status=await api(restarted.app,'/api/status');
  assert.equal(status.intent.on,true);assert.equal(status.lending.enabled,true,'the switch stayed on');
  assert.deepEqual([status.state,status.reason],['blocked','agent_not_ready']);
  assert.equal(probes,2);
});

test('effective status shows a partial sign-out without stopping the working agent',testOptions,async t=>{
  const entries=[...adapters(),{...adapters()[0],spec:{...resolveHarness('claude-code-subscription'),auth_strategy:'docker-native-oauth',credential_in_guest:false},signedIn:false}];
  const f=await appFixture(t),{lender,circle}=await f.connect({adapters:entries});
  await api(lender.app,'/api/agents/claude-code-subscription',{method:'POST',body:{useForLending:true}});
  await lendingOn(lender.app,circle);
  const status=await api(lender.app,'/api/status');
  assert.equal(status.state,'ready');
  assert.deepEqual(status.needs_you,[{kind:'agent_signed_out',agent:'claude-code-subscription'}]);
  assert.equal(status.lending.enabled,true);
});

test('a failed check holds lending without turning it off; repair clears it with no click, and a restart keeps the intent',testOptions,async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  await lendingOn(lender.app,circle);
  const original=lender.backend.probeCapabilities;
  lender.backend.probeCapabilities=async()=>({available:false,preflight:{ok:false,checks:[{name:'sbx_daemon',ok:false},{name:'docker_login',ok:true}]}});
  assert.equal((await api(lender.app,'/api/readiness?refresh=true')).ready,false);
  let status=await api(lender.app,'/api/status');
  assert.equal(status.state,'blocked');assert.equal(status.reason,'docker_not_running');
  assert.equal(status.lending.enabled,true,'a blocker never turns lending off');
  const saved=JSON.parse(await readFile(join(lender.home,'v1','app-settings.json'),'utf8'));
  assert.equal(saved.intent,'on');assert.equal(saved.safetyBlocked,undefined);
  await bounded(lender.app.close(),'blocked restart');
  const restarted=await f.start('lender',{backend:lender.backend});
  assert.equal((await api(restarted.app,'/api/status')).intent.on,true,'the intent survives the restart');
  lender.backend.probeCapabilities=original;
  assert.equal((await api(restarted.app,'/api/readiness?refresh=true')).ready,true);
  // Nothing to press: the next check lets lending run again by itself.
  status=await waitFor(async()=>{const s=await api(restarted.app,'/api/status');return s.state==='ready'&&s.lending.enabled&&s;},'lending is ready again with no click');
  assert.deepEqual(status.needs_you,[]);
});

test('explicit off wins over saved on intent after restart',testOptions,async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  await lendingOn(lender.app,circle);
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  await bounded(lender.app.close(),'off restart');
  const restarted=await f.start('lender');
  assert.equal((await api(restarted.app,'/api/status')).state,'off');
  assert.equal(JSON.parse(await readFile(join(lender.home,'v1','app-settings.json'),'utf8')).intent,'off');
});

test('timed pause keeps GET lending paused until resumed',testOptions,async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  await lendingOn(lender.app,circle);
  const until=Date.now()+3600000;
  await api(lender.app,'/api/lending/pause',{method:'POST',body:{until}});
  const paused=await api(lender.app,'/api/lending');
  assert.equal(paused.paused,true);
  assert.equal(paused.pause_until,until);
  assert.equal(paused.enabled,false);
  await api(lender.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id}});
  const resumed=await api(lender.app,'/api/lending');
  assert.equal(resumed.paused,false);
  assert.equal(resumed.pause_until,null);
});

test('status shows intent and execution separately; pausing never stops the running job, Stop is its own action',testOptions,async t=>{
  const f=await admissionFixture(t,{hold:true}),{owner,lender,circle}=await f.connect();
  await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendingOn(lender.app,circle);
  const card=await review(lender.app);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'running fake sandbox');
  const running=await api(lender.app,'/api/status');
  assert.equal(running.intent.state,'ready');assert.equal(running.execution.state,'running');
  assert.match(running.headline,/^Lending is on · .* job is running/);assert.equal(running.state,'running');
  // Pause new jobs: the job keeps running.
  const attemptId=(await api(lender.app,'/api/lending')).current;
  await api(lender.app,'/api/lending/pause',{method:'POST',body:{until:Date.now()+3600000}});
  const paused=await api(lender.app,'/api/status');
  assert.equal(paused.intent.state,'paused');assert.equal(paused.execution.state,'finishing');assert.equal(paused.state,'paused');
  assert.match(paused.headline,/^Paused · Running jobs continue within their saved limits\./);
  assert.equal(lender.backend.calls.some(([kind])=>kind==='cancel'),false,'pausing does not cancel the job');
  // Stop is a different action and needs the job id and a confirmation.
  await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId},status:400});
  let allowRemoval;const removal=new Promise(resolve=>{allowRemoval=resolve;});
  const destroy=lender.backend.destroy.bind(lender.backend);
  lender.backend.destroy=async handle=>{await removal;return destroy(handle);};
  try {
    await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:true}});
    const stopping=await api(lender.app,'/api/status');
    assert.equal(stopping.execution.state,'stopping');assert.match(stopping.headline,/Stop requested for/);
  } finally {allowRemoval();}
});

test('one atomic, versioned Save: mode, limits, schedule and zone apply together or not at all',testOptions,async t=>{
  const time=Math.floor(Date.now()/1000)*1000,clock={now:()=>time},f=await appFixture(t);
  const owner=await f.start('owner',{clock,pollMs:250}),lender=await f.start('lender',{clock});
  await f.provisionFromHome('owner');
  assert.equal((await api(owner.app,'/api/lending')).configVersion,0);
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Atomic Save circle'}});
  const savedSettings=()=>readFile(join(owner.home,'v1','app-settings.json'),'utf8').then(JSON.parse);
  const initial=await savedSettings();
  assert.equal(initial.configVersion,1);
  assert.deepEqual(initial.standingRules.find(r=>r.circle===circle.id).people,[owner.app.device.keyId]);
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  await api(lender.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
  // Approval refreshes before publication; this public check consumes the newly verified signed roster.
  const check=()=>api(owner.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  assert.equal((await check()).state,'approved');
  const roster=(await owner.app.device.rosterCache(circle.id).get()).current.payload;
  assert.deepEqual(new Set(roster.members.map(m=>m.key_id)),new Set([owner.app.device.keyId,lender.app.device.keyId]));
  const applied=await savedSettings();
  assert.equal(applied.rosterAppliedEpoch[circle.id],roster.epoch);
  assert.equal(applied.configVersion,2);
  assert.deepEqual(new Set(applied.standingRules.find(r=>r.circle===circle.id).people),new Set(roster.members.map(m=>m.key_id)));
  await check();
  assert.equal((await savedSettings()).configVersion,2,'unchanged verified roster is not a new permission change');
  const view=async()=>({...(await api(owner.app,'/api/lending')),mode:(await api(owner.app,'/api/home')).circles?.find(c=>c.id===circle.id)?.lendingMode}),schedule={days:[1,2,3,4,5],from:'22:00',to:'07:00',weekends_all_day:true};
  const before=await view();
  assert.equal(before.configVersion,2);
  // A bad value anywhere changes nothing: the mode is valid, the limits are not.
  await api(owner.app,'/api/lending/limits',{method:'POST',body:{circle:circle.id,mode:'auto',version:before.configVersion,dailyJobs:0},status:400});
  await api(owner.app,'/api/lending/limits',{method:'POST',body:{circle:circle.id,mode:'sometimes',version:before.configVersion,dailyJobs:2},status:400});
  const same=await view();
  assert.deepEqual([same.mode,same.limits.dailyJobs,same.configVersion],[before.mode,before.limits.dailyJobs,before.configVersion]);
  // One request saves all of it, and the version moves once.
  const saved=await api(owner.app,'/api/lending/limits',{method:'POST',body:{circle:circle.id,mode:'auto',version:before.configVersion,dailyJobs:2,timeZone:'America/New_York',schedule}});
  assert.deepEqual([(await view()).mode,saved.limits.dailyJobs,saved.limits.timeZone,saved.limits.schedule,saved.configVersion],['auto',2,'America/New_York',schedule,before.configVersion+1]);
  // A page that was showing the old version is told nothing was saved, and nothing is.
  await api(owner.app,'/api/lending/limits',{method:'POST',body:{circle:circle.id,mode:'ask',version:before.configVersion,dailyJobs:5},status:409});
  const kept=await view();
  assert.deepEqual([kept.mode,kept.limits.dailyJobs,kept.configVersion],['auto',2,before.configVersion+1]);
  // The older shapes still work (no version): the tray and CLI send limits alone.
  assert.equal((await api(owner.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:4}})).limits.dailyJobs,4);
  await api(owner.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(owner.app,'/api/lending/off',{method:'POST',body:{}});
  const explicit=await savedSettings();
  await check();
  const preserved=await savedSettings();
  assert.equal((await view()).mode,'ask');
  assert.equal(preserved.intent,'off');
  assert.equal(preserved.configVersion,explicit.configVersion);
  assert.deepEqual(preserved.standingRules,explicit.standingRules,'roster refresh cannot undo saved Ask or Off');
});


async function pendingDefaultFixture(t) {
  let ready=false,time=Date.now();
  const f=await appFixture(t),owner=await f.start('default-owner');
  const entries=HARNESS_ADAPTERS.filter(a=>['codex','claude-code-subscription'].includes(a.spec.harness_id))
    .map(a=>({...a,installed:true,signedIn:false,models:['example-model']}));
  const options={freshLending:'automatic',adapters:entries,clock:{now:()=>time},
    identityProbe:async()=>({providers:entries.map(a=>({harness_id:a.spec.harness_id,installed:true,signedIn:ready}))}),
    lendingSignInProbe:async()=>({signedIn:ready}),
    lendingIdentityProbe:async()=>({providers:entries.map(a=>({harness_id:a.spec.harness_id,installed:true,signedIn:ready}))})};
  const lender=await f.start('default-lender',options);
  await f.provisionFromHome('default-owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Default rule circle'}});
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,
    maxWallSeconds:1200,timeZone:'UTC',
    schedule:{days:[0,1,2,3,4,5,6],from:'00:00',to:'23:59',weekends_all_day:true}}});
  await api(lender.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
  await api(lender.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  const saved=()=>readFile(join(lender.home,'v1','app-settings.json'),'utf8').then(JSON.parse);
  const before=await waitFor(async()=>{const state=await saved();return state.standingRules?.find(r=>r.circle===circle.id)&&state;},
    'fresh first-circle default installed before provider selection');
  return {f,owner,lender,circle,before,saved,select:async(id='codex')=>{
    ready=true;return api(lender.app,'/api/agents/'+id,{method:'POST',body:{useForLending:true}});
  },advance:value=>{time=value;}};
}

test('team default rules complete fresh first-circle consent once after signed-in selection',testOptions,async t=>{
  const {matchingRule}=await import('../lib/v1/offers.mjs');
  const {f,owner,lender,circle,before,saved,select}=await pendingDefaultFixture(t);
  const original=before.standingRules.find(r=>r.circle===circle.id);
  assert.deepEqual(original.agents,[]);
  assert.notEqual(owner.app.device.keyId,lender.app.device.keyId,'two real fixture identities, not the own-author shortcut');
  assert.deepEqual(new Set(original.people),new Set([owner.app.device.keyId,lender.app.device.keyId]));
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true},status:400});
  assert.deepEqual((await saved()).standingRules,before.standingRules,'failed sign-in selection grants nothing');
  await select();
  const completed=(await saved()).standingRules.find(r=>r.id===original.id);
  // Causal assertion: before the fix this remains [], even though the selected proxy is ready.
  assert.deepEqual(completed,{...original,agents:['codex']});
  assert.equal((await saved()).pendingDefaultRules?.[circle.id],undefined);
  const teammate={circle:circle.id,author:owner.app.device.keyId,requirements:{limits:{wall_seconds:1}}};
  const within={now:Math.floor(original.expiresAt/86400000)*86400000-12*3600000};
  assert.equal(matchingRule([completed],teammate,'codex',within)?.id,original.id);
  assert.equal(matchingRule([completed],{...teammate,circle:'other-circle'},'codex',within),null);
  assert.equal(matchingRule([completed],teammate,'codex',{now:original.expiresAt}),null);

  const later=await f.start('default-later');
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  await api(later.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
  await api(lender.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  await select('claude-code-subscription');
  const expanded=await waitFor(async()=>{const rule=(await saved()).standingRules.find(r=>r.id===original.id);return rule?.people.includes(later.app.device.keyId)&&rule;},'Automatic covers the later approved member');
  assert.deepEqual({...expanded,people:completed.people},completed,
    'Automatic follows approved membership without widening agents, limits or expiry');
  assert.equal(matchingRule([expanded],{...teammate,author:later.app.device.keyId},'codex',within)?.id,original.id);
  assert.equal(matchingRule([completed],teammate,'claude-code-subscription',within),null);
  assert.deepEqual(await api(lender.app,'/api/approvals'),[]);
  assert.equal(lender.backend.calls.some(([kind])=>kind==='run'),false,'initializing a rule does not launch work');
});

for(const choice of ['ask','remove','explicit-empty'])test('team default rules preserve '+choice+' instead of inferring pending consent',testOptions,async t=>{
  const {lender,circle,before,saved,select}=await pendingDefaultFixture(t);
  if(choice==='ask')await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  else await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:choice==='remove'?[]:before.standingRules}});
  const explicit=await saved();
  await select();
  const after=await saved();
  assert.deepEqual(after.standingRules,explicit.standingRules);
  assert.deepEqual(after.modes,explicit.modes);
  assert.equal(after.pendingDefaultRules?.[circle.id],undefined);
  assert.deepEqual(await api(lender.app,'/api/approvals'),[]);
  assert.equal(lender.backend.calls.some(([kind])=>kind==='run'),false);
});

test('team default rules never renew an expired pending initialization',testOptions,async t=>{
  const {before,saved,select,advance}=await pendingDefaultFixture(t);
  advance(before.standingRules[0].expiresAt);
  await select();
  assert.deepEqual((await saved()).standingRules,before.standingRules);
});
test('Add as a branch: the route checks its input and the job, and a refusal is a 409 with its job state and no raw code',testOptions,async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  const path=jobPath(sent.jobDigest)+'/apply',post=(body,status)=>api(owner.app,path,{method:'POST',body,status});
  await post({circle:circle.id},400);                                                  // dry_run is required
  await post({circle:circle.id,dry_run:true,repo:'/x',surprise:1},400);                // no unknown fields
  await post({circle:circle.id,dry_run:true,branch:'b'.repeat(201),repo:'/x'},400);
  await api(owner.app,jobPath('sha256:'+'f'.repeat(64))+'/apply',{method:'POST',body:{circle:circle.id,dry_run:true,repo:'/x'},status:403}); // not this device's job
  const refused=await post({circle:circle.id,dry_run:true,repo:'relative/dir'},409);
  assert.deepEqual([refused.code,refused.apply_code,refused.state],['apply_refused','repo_missing','job.apply-repo-missing']);
  assert.match(refused.message,/full path of the folder/);
  await post({circle:circle.id,dry_run:true,recover_locks:true,repo:'/x'},400);
  const repo=await makeRepo();
  t.after(()=>rm(repo.dir,{recursive:true,force:true}));
  const lock=join(repo.dir,'.git','HEAD.lock');
  await writeFile(lock,'foreign lock');
  const blocked=await post({circle:circle.id,dry_run:false,recover_locks:true,repo:repo.dir},409);
  assert.equal(blocked.apply_code,'preview_lock_blocked');
  assert.match(blocked.message,/HEAD\.lock/);
  assert.equal(await readFile(lock,'utf8'),'foreign lock');
  assert.equal((await api(owner.app,jobPath(sent.jobDigest)+'?circle='+circle.id)).applied,null,'nothing was recorded');
});
