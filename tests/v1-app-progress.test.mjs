import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../lib/protocol/index.mjs';
import {DEFAULT_RUN_MODEL} from '../lib/v1/lender-pace50.mjs';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';

const jobPath = digest => '/api/jobs/' + encodeURIComponent(digest);
const submit = (owner, circle) => api(owner.app, '/api/jobs', { method: 'POST', body: { circle: circle.id,
  git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt: 'Synthetic task', harness: 'codex' } });

test('job progress route: a coordinator without the channel reads as no steps; a bad cursor is a 400', { timeout: 20000 }, async t => {
  const f = await appFixture(t), { owner, circle } = await f.connect();
  const { jobDigest } = await submit(owner, circle);
  const base = f.override;
  f.override = async ctx => {
    if (!ctx.route.includes('/progress')) return base(ctx);
    const bytes = Buffer.from(p.canonicalize({ type: 'urn:faravan:problem:not_found', title: 'not found', status: 404, code: 'not_found', retryable: false, outcome: 'not_applied' }));
    ctx.res.writeHead(404, { 'content-type': 'application/problem+json', 'content-length': bytes.length }); ctx.res.end(bytes);
    return true;
  };
  assert.deepEqual(await api(owner.app, jobPath(jobDigest) + '/progress?circle=' + circle.id), { entries: [], nextAfter: 0 });
  assert.deepEqual(await api(owner.app, jobPath(jobDigest) + '/progress?circle=' + circle.id + '&after=3'), { entries: [], nextAfter: 3 });
  await api(owner.app, jobPath(jobDigest) + '/progress?circle=' + circle.id + '&after=-1', { status: 400 });
});

test('job progress route passes through the coordinator steps and nothing else', { timeout: 20000 }, async t => {
  const f = await appFixture(t), { owner, circle } = await f.connect();
  const { jobDigest } = await submit(owner, circle);
  const base = f.override, seen = [];
  f.override = async ctx => {
    if (ctx.route.startsWith('/jobs/' + jobDigest.slice(7) + '/progress')) {
      seen.push(ctx.req.url.slice(ctx.req.url.indexOf('/jobs/')));
      const entry = { job: jobDigest, attempt: '33333333-3333-4333-8333-333333333333', seq: 4, at: '2026-10-19T12:00:00Z', step: 'Editing a.js', kind: 'step' };
      const bytes = Buffer.from(p.canonicalize({ job_digest: jobDigest, entries: [entry], next_after: 4 }));
      ctx.res.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length }); ctx.res.end(bytes);
      return true;
    }
    return base(ctx);
  };
  const page = await api(owner.app, jobPath(jobDigest) + '/progress?circle=' + circle.id + '&after=3');
  assert.deepEqual(page, { entries: [{ seq: 4, at: '2026-10-19T12:00:00Z', step: 'Editing a.js', kind: 'step' }], nextAfter: 4 });
  assert.deepEqual(seen, ['/jobs/' + jobDigest.slice(7) + '/progress?after=3']);
});

test('job progress route passes stage entries through as stage and elapsed seconds (P8b)', { timeout: 20000 }, async t => {
  const f = await appFixture(t), { owner, circle } = await f.connect();
  const { jobDigest } = await submit(owner, circle);
  const base = f.override, attempt = '33333333-3333-4333-8333-333333333333';
  f.override = async ctx => {
    if (!ctx.route.startsWith('/jobs/' + jobDigest.slice(7) + '/progress')) return base(ctx);
    const entries = [
      { job: jobDigest, attempt, seq: 1, at: '2026-10-19T12:00:00Z', stage: 'preparing', elapsed_s: 0 },
      { job: jobDigest, attempt, seq: 2, at: '2026-10-19T12:00:20Z', stage: 'agent', elapsed_s: 21 },
      { job: jobDigest, attempt, seq: 3, at: '2026-10-19T12:00:40Z', step: 'Editing a.js', kind: 'step' },
    ];
    const bytes = Buffer.from(p.canonicalize({ job_digest: jobDigest, entries, next_after: 3 }));
    ctx.res.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length }); ctx.res.end(bytes);
    return true;
  };
  const page = await api(owner.app, jobPath(jobDigest) + '/progress?circle=' + circle.id);
  assert.deepEqual(page, { entries: [
    { seq: 1, at: '2026-10-19T12:00:00Z', stage: 'preparing', elapsed_s: 0 },
    { seq: 2, at: '2026-10-19T12:00:20Z', stage: 'agent', elapsed_s: 21 },
    { seq: 3, at: '2026-10-19T12:00:40Z', step: 'Editing a.js', kind: 'step' }], nextAfter: 3 });
});

test('the app heartbeats while lending is off, then ready, with no job, person or path in it', { timeout: 30000 }, async t => {
  const f = await appFixture(t), beats = [], base = f.override;
  f.override = async ctx => {
    if (ctx.route === '/heartbeat') {
      beats.push({ ...ctx.body, signer: JSON.parse(Buffer.from(ctx.req.headers['faravan-proof'], 'base64url')).payload.key_id });
      const bytes = Buffer.from(p.canonicalize({ received_at: '2026-10-19T12:00:00Z', online_seconds: 90 }));
      ctx.res.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length }); ctx.res.end(bytes);
      return true;
    }
    return base(ctx);
  };
  const { lender, circle } = await f.connect({ heartbeatMs: 100 });
  // Status heartbeats only: a member also sends a one-field capability declaration ({capabilities}) to the same route.
  const mine = () => beats.filter(b => b.signer === lender.app.device.keyId && b.intent);
  await api(lender.app, '/api/lending/limits', { method: 'POST', body: { dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false } });
  await api(lender.app, '/api/agents/codex', { method: 'POST', body: { useForLending: true } });
  await api(lender.app, '/api/lending/mode', { method: 'POST', body: { circle: circle.id, mode: 'ask' } });
  await api(lender.app, '/api/lending/on', { method: 'POST', body: { circle: circle.id } });
  for (let i = 0; i < 100 && !(mine().length >= 3 && mine().some(b => b.intent.state === 'ready')); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(mine().length >= 2 && mine().every((b, i, all) => i === 0 || b.seq > all[i - 1].seq), 'seq increases');
  assert.ok(mine().some(b => b.intent.state === 'ready'), 'ready after lending is on');
  assert.ok(mine().every(b => ['off', 'blocked', 'starting', 'ready'].includes(b.intent.state)));
  for (const { signer, ...b } of mine()) {
    assert.deepEqual([...b.capabilities].sort(), ['progress_v1','transcript_relay_v1','offers_v1','budget_v1','auto_run_v1','circle_profile_v1','circle_people_v1','circle_authority_v1','working_directory_v1','source_manifest_v1','source_project_name_v1','filtered_git_v1',...(b.agents.some(a=>a.model_efforts?.length)?['model_effort_pairs_v1']:[])].sort());
    assert.deepEqual(Object.keys(b.execution).sort(), ['state', 'stops_by']);
    assert.doesNotMatch(JSON.stringify(b), /sha256:|\/home\/|prompt|requester/);
  }
});

test('configured exact pairs appear in the actual heartbeat',{timeout:30000},async t=>{
 const f=await appFixture(t),{lender,circle}=await f.connect({heartbeatMs:100});
 await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 const initial=await waitFor(()=>f.heartbeats?.findLast(b=>b.agents?.some(a=>a.adapter==='codex'&&a.model_efforts?.some(pair=>pair.model===DEFAULT_RUN_MODEL.codex&&pair.effort==='medium'))),'default heartbeat',15000);
 assert.ok(initial.agents.find(a=>a.adapter==='codex').models.includes(DEFAULT_RUN_MODEL.codex));
 const pairs=[{model:'pair-one',effort:'low'},{model:'pair-two',effort:'high'}];
 await api(lender.app,'/api/agents/codex/run',{method:'POST',body:{model:null,effort:null,model_efforts:pairs}});
 const beat=await waitFor(()=>f.heartbeats?.findLast(b=>b.agents?.some(a=>a.adapter==='codex'&&p.canonicalize(a.model_efforts??[])===p.canonicalize(pairs))),'configured heartbeat',15000);
 const agent=beat.agents.find(a=>a.adapter==='codex');
 assert.deepEqual(agent.model_efforts,pairs);assert.ok(pairs.every(p=>agent.models.includes(p.model)));
 assert.ok(beat.capabilities.includes('model_effort_pairs_v1'));
});

test('the heartbeat says which automatic choices each agent can satisfy, from its own pairs',{timeout:60000},async t=>{
 const f=await appFixture(t),{lender,circle}=await f.connect({heartbeatMs:100});
 await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 const beatWith=async pairs=>{
  await api(lender.app,'/api/agents/codex/run',{method:'POST',body:{model:null,effort:null,model_efforts:pairs}});
  const beat=await waitFor(()=>f.heartbeats?.findLast(b=>b.agents?.some(a=>a.adapter==='codex'&&p.canonicalize(a.model_efforts??[])===p.canonicalize(pairs))),'heartbeat for '+JSON.stringify(pairs),15000);
  return {beat,agent:beat.agents.find(a=>a.adapter==='codex')};
 };
 const ranked=await beatWith([{model:'gpt-6-luna',effort:'low'}]);
 assert.deepEqual(ranked.agent.auto_run_intents,['cheapest','strongest']);assert.ok(ranked.beat.capabilities.includes('auto_run_v1'));
 const priced=await beatWith([{model:'gpt-5.4-mini',effort:'low'}]);
 assert.deepEqual(priced.agent.auto_run_intents,['cheapest'],'a priced model with no rank cannot be the strongest');
 const neither=await beatWith([{model:'pair-one',effort:'low'}]);
 assert.equal(Object.hasOwn(neither.agent,'auto_run_intents'),false);assert.equal(neither.beat.capabilities.includes('auto_run_v1'),false,'no choice to make, so no capability');
});
