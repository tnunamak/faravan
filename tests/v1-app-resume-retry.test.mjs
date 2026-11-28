import {setSyntheticAccountSignedIn} from './helpers/synthetic-run-account.mjs';
import {lendingReasonText} from '../lib/v1/lending-reasons.mjs';
import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, waitFor } from './helpers/v1-lifecycle-fixture.mjs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';

const lendingOn = async (app, circle) => {
  await api(app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
};
const signedIn = {providers: [{harness_id: 'codex', installed: true, signedIn: true}]};
const cold = () => [{spec: legacyProxyHarness('codex')}]; // lendable: native sign-in is never lent

// A computer often starts before its network is up. Lending that was on must come back by itself once the circle's
// host answers again, without the person turning lending off and on.
test('lending that was on resumes by itself when the host becomes reachable after a restart', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  await lender.app.close();
  let offline = true;
  const reachable = f.override;
  f.override = async args => {
    if (offline) { args.req.socket.destroy(); return true; }
    return reachable(args);
  };
  const restarted = await f.start('lender', {syntheticAccounts:'codex',adapters: cold(), identityProbe: async () => signedIn, blockerRecheckMs: 300, hostProfileMs: 300});
  // Wait for the startup resume itself to fail, not only for the host hold that a later host read clears.
  const failed = await waitFor(async () => { const s = await api(restarted.app, '/api/status');
    return s.state === 'blocked' && s.blockers?.some(b => b.kind === 'network_error') && s; },
  'the startup resume fails while the host is unreachable', 30000);
  assert.equal(failed.intent.on, true);
  offline = false;
  let last;
  // The top-level state can read ready while the intent is blocked; the intent is what says lending runs.
  await waitFor(async () => (last = await api(restarted.app, '/api/status')).intent?.state === 'ready' && last.lending.enabled===true, 'lending resumed once the host answered', 30000)
    .catch(error => { error.message += ' (last intent ' + JSON.stringify(last?.intent) + ')'; throw error; });
  assert.equal((await api(restarted.app, '/api/lending')).enabled, true);
});

// The retry is only for failures that time can fix. An agent that is signed out stays blocked until the person acts.
test('a resume blocked by a signed-out agent is not retried on its own', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  await setSyntheticAccountSignedIn({...lender,api,providerId:'codex',signedIn:false});
  await lender.app.close();
  let probes = 0;
  const restarted = await f.start('lender', {syntheticAccounts:'codex',adapters: cold(), blockerRecheckMs: 300,
    identityProbe: async () => { probes++; return {providers: [{harness_id: 'codex', installed: true, signedIn: false}]}; }});
  await waitFor(async () => { const s = await api(restarted.app, '/api/status'); return s.lendingProjection.admission === 'blocked' && s.lendingProjection.admissionReason === 'account_signed_out'; },
    'the startup resume reports the signed-out agent', 20000);
  const after = probes;
  await new Promise(resolve => setTimeout(resolve, 3000));
  const status = await api(restarted.app, '/api/status');
  assert.equal(status.lendingProjection.admission, 'blocked');
  assert.equal(status.lendingProjection.admissionReason, 'account_signed_out');
  assert.ok(probes - after <= 1, 'no repeated automatic start attempts for a signed-out agent');
});

for(const ownerAction of [null,'pause','off'])test(`active host outage preserves owner intent and respects ${ownerAction??'automatic recovery'}`,{timeout:120000},async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect({blockerRecheckMs:100,hostProfileMs:100});
  let offline=false,failedProbes=0,goodProbes=0,polls=0;
  const reachable=f.override;
  f.override=async args=>{
    const isLender=args.req.headers['x-test-device']==='lender';
    if(isLender&&args.route==='/offers')polls++;
    if(isLender&&offline){
      if(args.route==='/capabilities')failedProbes++;
      args.res.writeHead(503,{'content-type':'application/problem+json'});
      args.res.end(JSON.stringify({code:'unavailable',status:503,retryable:true}));return true;
    }
    if(isLender&&args.route==='/capabilities')goodProbes++;
    return reachable(args);
  };
  await lendingOn(lender.app,circle);
  await waitFor(()=>polls>0,'active discovery');
  offline=true;
  const held=await waitFor(async()=>{const view=await api(lender.app,'/api/lending');return view.reason==='circle_unreachable'&&view;},'host hold',30000);
  assert.ok(failedProbes>0,'a real host probe observed the outage');
  assert.equal(held.label,lendingReasonText('circle_unreachable',{until:held.until}));
  assert.equal(held.intent,'on');assert.equal(held.paused,false);
  const saved=()=>readFile(join(lender.home,'v1','app-settings.json'),'utf8').then(JSON.parse);
  assert.equal((await saved()).intent,'on');
  if(ownerAction)await api(lender.app,'/api/lending/'+ownerAction,{method:'POST',body:{}});
  const before=polls,probes=goodProbes;
  offline=false;
  await waitFor(()=>goodProbes>probes,'successful recovery probe',30000);
  if(!ownerAction){
    await waitFor(()=>polls>before,'discovery resumes without Resume',30000);
    assert.equal((await api(lender.app,'/api/lending')).intent,'on');
    assert.equal((await saved()).intent,'on');
  }else{
    await new Promise(resolve=>setTimeout(resolve,1800));
    assert.equal(polls,before,'owner choice prevents discovery after recovery');
    assert.equal((await saved()).intent,ownerAction==='pause'?'paused':'off');
  }
});


for(const refusal of [401,403,404])test('host refusal clears a prior outage: '+refusal,{timeout:60000},async t=>{
 const f=await appFixture(t),{lender,circle}=await f.connect({blockerRecheckMs:100,hostProfileMs:100});
 let status=0,polls=0;
 const reachable=f.override;
 f.override=async args=>{
  if(args.req.headers['x-test-device']==='lender'&&args.route==='/offers')polls++;
  if(args.req.headers['x-test-device']==='lender'&&status){
   args.res.writeHead(status,{'content-type':'application/problem+json'});
   args.res.end(JSON.stringify({code:'http_error',status,retryable:status===503}));return true;
  }
  return reachable(args);
 };
 await lendingOn(lender.app,circle);
 await waitFor(()=>polls>0,'active discovery');
 status=503;
 await waitFor(async()=>(await api(lender.app,'/api/lending')).reason==='circle_unreachable','outage hold',30000);
 status=refusal;
 const failed=await waitFor(async()=>{const view=await api(lender.app,'/api/lending');return view.reason==='circle_access_refused'&&view;},'actionable refusal',30000);
 assert.equal(failed.reason,'circle_access_refused');
 assert.ok(!failed.label.includes('waiting for'));
 assert.match(failed.label,/membership.*host address/);
 assert.equal(failed.intent,'on');
});

// A busy or failing host answers instead of dropping the connection. It is reported as unreachable and retried.
// A refusal that time cannot fix (a 4xx) is not retried.
const answer = (status, code) => ctx => {
  if (!code) { ctx.res.writeHead(status); ctx.res.end(); return true; }
  ctx.res.writeHead(status, {'content-type': 'application/problem+json'});
  // The client reads only canonical JSON (sorted keys), as a real host sends it.
  ctx.res.end(JSON.stringify({code, outcome: 'not_applied', retryable: status >= 500, status, title: code, type: 'urn:faravan:problem:' + code}));
  return true;
};
for (const [label, status, code, blocker, retried] of [
  ['a 502 with no body', 502, null, 'network_error', true],
  ['a 503 with a problem code', 503, 'unavailable', 'network_error', true],
  ['a 4xx with a transient problem code', 403, 'circle_unreachable', 'circle_unreachable', false],
  ['a 4xx refusal', 403, 'forbidden', 'forbidden', false],
]) test('a startup resume that fails on ' + label + (retried ? ' is retried' : ' is not retried'), {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  await lender.app.close();
  let failing = true;
  const reachable = f.override, refuse = answer(status, code);
  f.override = async args => failing ? refuse(args) : reachable(args);
  const restarted = await f.start('lender', {syntheticAccounts:'codex',adapters: cold(), identityProbe: async () => signedIn, blockerRecheckMs: 300, hostProfileMs: 300});
  const failed = await waitFor(async () => { const s = await api(restarted.app, '/api/status');
    return s.state === 'blocked' && s.blockers?.some(b => b.kind === blocker) && s; },
  'the startup resume reports ' + blocker, 30000);
  assert.equal(failed.intent.on, true);
  failing = false;
  if (retried) {
    await waitFor(async () => {const s=await api(restarted.app,'/api/status');return s.intent?.state==='ready'&&s.lending.enabled===true;}, 'lending resumed once the host answered', 30000);
    assert.equal((await api(restarted.app, '/api/lending')).enabled, true);
  } else {
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.equal((await api(restarted.app, '/api/lending')).enabled, false, 'a 4xx refusal waits for the person');
  }
});
