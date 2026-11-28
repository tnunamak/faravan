import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, git } from './helpers/git-guest.mjs';
import { appFixture, api, browserApi } from './helpers/v1-app-fixture.mjs';
import { json } from './helpers/v1-journey.mjs';
import { inspectRepo, RepoError, REPO_STATES, repoStateOf } from '../lib/v1/repo-source.mjs';
import { createJobOperations } from '../lib/v1/cli.mjs';

// U7m: the web app's composer sends a git repository folder from this computer. The composer reads it, tells the
// person what would go, and one draft id means one job however often the answer is asked for.
const testOptions = {timeout: 120000};
const refusal = async run => { try { await run(); } catch (error) { assert.ok(error instanceof RepoError, String(error)); return [error.code, repoStateOf(error.code)]; } assert.fail('expected a refusal'); };

test('inspectRepo says what would be sent, and each refusal is one composer state', async t => {
  const repo = await makeRepo(); t.after(() => rm(repo.dir, {recursive: true, force: true}));
  const clean = await inspectRepo(repo.dir);
  assert.deepEqual([clean.path, clean.name, clean.branch, clean.head, clean.files, clean.changed_count], [repo.dir, repo.dir.split('/').pop(), 'main', repo.commit, 2, 0]);
  await writeFile(join(repo.dir, 'src/a.txt'), 'changed\n'); await writeFile(join(repo.dir, 'new.txt'), 'x\n');
  const dirty = await inspectRepo(join(repo.dir, 'src'));
  assert.equal(dirty.path, repo.dir, 'a folder inside the repository resolves to the repository');
  assert.deepEqual(dirty.changed.map(f => f.path).sort(), ['new.txt', 'src/a.txt']);
  const plain = await mkdtemp(join(tmpdir(), 'faravan-plain-')); t.after(() => rm(plain, {recursive: true, force: true}));
  const empty = await mkdtemp(join(tmpdir(), 'faravan-empty-')); t.after(() => rm(empty, {recursive: true, force: true}));
  git(empty, 'init', '-q');
  assert.deepEqual(await refusal(() => inspectRepo(plain)), ['not_git', 'compose.not-git']);
  assert.deepEqual(await refusal(() => inspectRepo(empty)), ['no_commits', 'compose.no-commits']);
  assert.deepEqual(await refusal(() => inspectRepo(join(plain, 'gone'))), ['repo_missing', 'compose.repo-missing']);
  assert.deepEqual(await refusal(() => inspectRepo('relative/dir')), ['repo_missing', 'compose.repo-missing']);
  assert.deepEqual(await refusal(() => inspectRepo(undefined)), ['repo_missing', 'compose.repo-missing']);
  assert.deepEqual(Object.keys(REPO_STATES).sort(), ['no_commits', 'not_git', 'repo_missing']);
});

test('repository inspection offers npm test only when package.json has a test script', async t => {
  const repo = await makeRepo(); t.after(() => rm(repo.dir, {recursive:true, force:true}));
  assert.equal((await inspectRepo(repo.dir)).testCommand, '');
  await writeFile(join(repo.dir, 'package.json'), JSON.stringify({scripts:{test:'node --test'}}));
  assert.equal((await inspectRepo(repo.dir)).testCommand, 'npm test');
  await writeFile(join(repo.dir, 'package.json'), JSON.stringify({scripts:{build:'vite build'}}));
  assert.equal((await inspectRepo(repo.dir)).testCommand, '');
});

test('the app sends a repository folder once per draft, with or without uncommitted changes', testOptions, async t => {
  const f = await appFixture(t), {owner, circle} = await f.connect();
  const ui=await browserApi(owner.app);
  const repo = await makeRepo(); t.after(() => rm(repo.dir, {recursive: true, force: true}));
  const post = (body, status) => ui('/api/jobs', {method: 'POST', body: {circle: circle.id, prompt: 'Make it better.', harness: 'codex', ...body}, status});
  // the folder is read first, and a refusal is a 409 with its own state and no git text
  const refused = await api(owner.app, '/api/repo/inspect', {method: 'POST', body: {path: join(repo.dir, 'gone')}});
  assert.deepEqual([refused.refusal.code, refused.refusal.state], ['repo_missing', 'compose.repo-missing'], 'a folder that cannot be sent is an answer (200), not a failure');
  await api(owner.app, '/api/repo/inspect', {method: 'POST', body: {path: repo.dir, extra: 1}, status: 400});
  const seen = await api(owner.app, '/api/repo/inspect', {method: 'POST', body: {path: repo.dir}});
  assert.equal(seen.head, repo.commit);
  // bad shapes never reach the repository
  await post({repo: {path: repo.dir, includeUncommitted: 'yes'}}, 400);
  await post({repo: {path: repo.dir, shell: 'x'}}, 400);
  await post({repo: {path: repo.dir}, git: 'https://github.com/example/x.git', commit: '1'.repeat(40)}, 400);
  await post({repo: {path: repo.dir}, draft_id: 'short'}, 400);
  const missing = await post({repo: {path: join(repo.dir,'missing-folder')}}, 409);
  assert.equal(missing.code, 'repo_refused');
  // committed HEAD, one draft: asking again answers about the same job
  const first = await post({repo: {path: repo.dir}, draft_id: 'draft-0001-aaaa'});
  const again = await post({repo: {path: repo.dir}, draft_id: 'draft-0001-aaaa'});
  assert.equal(again.jobDigest, first.jobDigest);
  assert.equal(again.replayed, true);
  // a second draft of the same project is a second job; uncommitted changes name their files
  await writeFile(join(repo.dir, 'new.txt'), 'x\n');
  const second = await post({repo: {path: repo.dir, includeUncommitted: true}, verify:{cmd:'npm test'}, draft_id: 'draft-0002-bbbb'});
  assert.notEqual(second.jobDigest, first.jobDigest);
  assert.deepEqual(second.uncommittedFiles, ['new.txt']);
  assert.deepEqual(f.jobs.get(second.jobDigest).job.payload.verify, {cmd:'npm test'});
  assert.ok(f.jobs.get(second.jobDigest).job.payload.requirements.capabilities.includes('verify_v1'));
  const jobs = await api(owner.app, '/api/jobs?circle=' + encodeURIComponent(circle.id));
  assert.equal(jobs.filter(j => [first.jobDigest, second.jobDigest].includes(j.job_digest)).length, 2, 'two drafts, two jobs');
  assert.equal(execFileSync('git', ['status', '--porcelain'], {cwd: repo.dir, encoding: 'utf8'}).trim(), '?? new.txt', 'the repository was only read');
});

const presenceAnswer = (f, answer) => {
  const previous = f.override;
  f.override = async context => {
    if (context.route === '/presence') return answer(context.res);
    return previous?.(context) ?? false;
  };
};
test('the composer state names the host, whether it answers, when the roster runs out, and who lends', testOptions, async t => {
  const f = await appFixture(t), {owner, circle} = await f.connect();
  presenceAnswer(f, res => {json(res, {now: new Date().toISOString(), online_seconds: 90, devices: [], persons: []}); return true;});
  const state = await api(owner.app, '/api/circles/' + encodeURIComponent(circle.id) + '/compose');
  assert.equal(state.circle, circle.id);
  assert.equal(typeof state.host.reachable, 'boolean');
  assert.equal(state.presence, 'ok');
  assert.deepEqual(state.lenders, [], 'a host that answered with no lenders has none');
  assert.ok(state.host.rosterValidUntil === null || Number.isFinite(Date.parse(state.host.rosterValidUntil)));
});

// Dot server review P2: for a circle this computer hosts, a failed presence read must not look like a healthy circle
// with no lenders, and must not move the time the host last answered.
test('a failed presence read leaves lenders unknown and does not refresh when the host last answered', testOptions, async t => {
  const f = await appFixture(t), {owner, circle} = await f.connect();
  presenceAnswer(f, res => {res.writeHead(503, {'content-type': 'application/problem+json', 'retry-after': '1'}); res.end('{"code":"unavailable"}'); return true;});
  const before = Date.now();
  const state = await api(owner.app, '/api/circles/' + encodeURIComponent(circle.id) + '/compose');
  assert.equal(state.presence, 'unavailable');
  assert.equal(state.lenders, null, 'unknown, not an empty list');
  assert.ok(state.host.lastReachedAt === null || Date.parse(state.host.lastReachedAt) < before, 'the failed read is not a fresh answer');
});

for (const includeUncommitted of [false, true]) test('a lost send answer freezes the draft before source changes: uncommitted=' + includeUncommitted, testOptions, async t => {
  const f = await appFixture(t), {owner, circle} = await f.connect();
  const ui=await browserApi(owner.app);
  const repo = await makeRepo(); t.after(() => rm(repo.dir, {recursive: true, force: true}));
  await writeFile(join(repo.dir, 'new.txt'), 'original draft\n');
  const body = {circle:circle.id, prompt:'Original prompt', repo:{path:repo.dir, includeUncommitted}, draft_id:'frozen-draft-0001'};
  // The host accepts this send, but the caller treats its answer as lost.
  const first = await ui('/api/jobs', {method:'POST', body});
  const original = f.jobs.get(first.jobDigest).job;
  const artifacts = new Map(f.artifacts);
  await writeFile(join(repo.dir, 'new.txt'), 'different working tree\n');
  git(repo.dir, 'add', '-A'); git(repo.dir, 'commit', '-qm', 'new HEAD');
  await writeFile(join(repo.dir, 'new.txt'), 'another uncommitted edit\n');
  const changed = await ui('/api/jobs', {method:'POST', body:{...body, prompt:'Changed prompt'}, status:409});
  assert.equal(changed.code,'draft_changed','a changed request needs a new draft id');
  const replay = await ui('/api/jobs', {method:'POST', body});
  assert.equal(replay.jobDigest, first.jobDigest, 'same draft must resolve the original accepted job');
  assert.equal(f.jobs.size, 1);
  assert.deepEqual(f.jobs.get(replay.jobDigest).job, original);
  assert.deepEqual(f.artifacts, artifacts, 'no replacement artifacts are uploaded');
  await rm(repo.dir, {recursive:true, force:true});
  const gone = await ui('/api/jobs', {method:'POST', body});
  assert.equal(gone.jobDigest, first.jobDigest, 'retry resolves before inspecting a vanished folder');
});

test('an ambiguous draft replays its persisted artifacts after restart without reading its old source', testOptions, async t => {
  const f = await appFixture(t), {circle} = await f.connect();
  const repo = await makeRepo(); t.after(() => rm(repo.dir, {recursive:true, force:true}));
  const home = await f.home(), request = {circle:circle.id,source:repo.dir,prompt:'Original frozen prompt',draftId:'pending-draft-0001'};
  f.dropPublishAck = true;
  await assert.rejects(createJobOperations({home}).submit(request));
  assert.equal(f.jobs.size, 1, 'host accepted the send whose answer was lost');
  const digest = [...f.jobs.keys()][0], artifacts = new Map(f.artifacts);
  const original = f.requests.find(r => r.route === '/jobs' && r.method === 'POST');
  await rm(repo.dir, {recursive:true,force:true});
  f.dropPublishAck = false;
  f.artifacts.clear();
  await assert.rejects(createJobOperations({home}).submit({...request,prompt:'Changed after the ambiguous send'}),{code:'draft_changed'});
  const sent = await createJobOperations({home}).submit(request);
  assert.equal(sent.jobDigest, digest);
  assert.equal(sent.sourceManifest.schema,'faravan.source-manifest.v1');
  assert.deepEqual(sent.sourceManifest,original.body.payload.source_manifest);
  assert.equal(sent.sourceManifest.archive_digest,original.body.payload.source.artifact.digest);
  assert.equal(f.jobs.size, 1);
  const device = await (await import('../lib/v1/device.mjs')).openDevice({home});
  assert.equal((await device.intentStore(circle.id).get('submit:draft:'+request.draftId)).artifacts, undefined, 'confirmed sends discard frozen artifact bytes');
  assert.deepEqual(f.artifacts, artifacts, 'reuploaded exact original source and prompt');
  const publishes = f.requests.filter(r => r.route === '/jobs' && r.method === 'POST');
  for (const replay of publishes) {
    assert.deepEqual(replay.body, original.body);
    assert.equal(replay.proof.payload.idempotency_key, original.proof.payload.idempotency_key);
  }
});

test('an uncertain draft from an older version resolves its original job before inspecting source', testOptions, async t => {
  const f = await appFixture(t), {owner,circle} = await f.connect();
  const ui=await browserApi(owner.app);
  const body = {circle:circle.id,prompt:'Old draft',git:{url:'https://example.test/old.git',commit:'a'.repeat(40)},draft_id:'legacy-draft-0001'};
  const first = await ui('/api/jobs',{method:'POST',body});
  const store = owner.app.device.intentStore(circle.id), slot = 'submit:draft:'+body.draft_id;
  const {artifacts,warnings,draftRequest,...saved} = await store.get(slot), legacySlot = slot+':old-fingerprint';
  await store.set(legacySlot,{...saved,state:'pending'});
  await store.set('job:'+first.jobDigest,{jobDigest:first.jobDigest,circle:circle.id,slot:legacySlot});
  await store.delete(slot);
  const replay = await ui('/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Changed',repo:{path:'/missing/old-project'},draft_id:body.draft_id}});
  assert.equal(replay.jobDigest,first.jobDigest);
  assert.equal(f.jobs.size,1);
  assert.equal((await store.get(slot)).state,'complete');
  assert.equal(await store.get(legacySlot),null);
});

test('composer lists other online lenders by agent adapter and readiness only', testOptions, async t => {
  const f = await appFixture(t), {owner, circle} = await f.connect();
  const agents = [{adapter:'codex', readiness:'ready', models:['example-model'], per_job_max_minutes:20}];
  const original = f.override;
  f.override = async args => {
    if (args.route === '/presence') {
      const at=Date.now(), fresh=new Date(at).toISOString(), stale=new Date(at-300000).toISOString();
      json(args.res, {now:fresh, online_seconds:90, persons:[], devices:[
        {device:'another-computer',online:true,source:'heartbeat',last_heartbeat_at:fresh,intent:{state:'ready'},agents},
        {device:'offline-computer',online:false,source:'heartbeat',last_heartbeat_at:stale,intent:{state:'ready'},agents},
        {device:'off-computer',online:true,source:'heartbeat',last_heartbeat_at:fresh,intent:{state:'off'},agents},
      ]});
      return true;
    }
    return original(args);
  };
  const state = await api(owner.app, '/api/circles/' + encodeURIComponent(circle.id) + '/compose');
  // Models stay out of lenders[]: a reader must not match an anonymous offer to a lender.
  assert.deepEqual(state.lenders, [{keyId:'another-computer',self:false,state:'ready',label:null,agents:[{adapter:'codex',readiness:'ready'}]}]);
});

test('a submitted repository names its project in the signed manifest without sharing its local path', testOptions, async t => {
 const f=await appFixture(t),{owner,circle}=await f.connect();
 const ui=await browserApi(owner.app);
 const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
 const sent=await ui('/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Name this project',repo:{path:repo.dir}}});
 const manifest=f.jobs.get(sent.jobDigest).job.payload.source_manifest;
 assert.equal(manifest.project_name,repo.dir.split('/').pop());
 assert.doesNotMatch(manifest.project_name,/[/\\]/);
 assert.ok(f.jobs.get(sent.jobDigest).job.payload.requirements.capabilities.includes('source_project_name_v1'));
});

test('older hosts still receive the existing manifest without the optional project name', testOptions, async t => {
 const f=await appFixture(t),{owner,circle}=await f.connect();
 const ui=await browserApi(owner.app);
 f.hostCapabilities={capabilities:['source_manifest_v1','working_directory_v1','results_v1','run_request_v1']};
 const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
 const sent=await ui('/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Compatible project',repo:{path:repo.dir}}});
 const job=f.jobs.get(sent.jobDigest).job.payload;
 assert.equal(job.source_manifest.project_name,undefined);
 assert.ok(!job.requirements.capabilities.includes('source_project_name_v1'));
});

test('signed account offers reach Compose anonymously through the real coordinator', testOptions, async t => {
  const f = await appFixture(t);
  const {owner,lender,declining,circle,realHeartbeats} = await f.realConnect();
  const account = (accountId,providerId,models) => ({accountId,providerId,models});
  const model = (id,effortIds,enabled=true) => ({
    id,enabled,efforts:effortIds.map(id=>({id})),defaultEffort:effortIds[0]??null
  });
  const signedBeat = async (device,boot,seq,accounts,state='ready') => {
    const client = await device.app.device.client(circle.id);
    await client.heartbeat({boot,seq,intent:{state},execution:{state:'idle'},blockers:[],agents:[],
      capabilities:['run_request_v1'],accounts});
  };
  await signedBeat(lender,'test-acct-a',1,[
    account('lender-account-one','test-provider-a',[model('shared',['low']),model('disabled',['high'],false)]),
    account('lender-account-two','test-provider-b',[model('shared',['different'])])
  ]);
  await signedBeat(declining,'test-acct-b',1,[
    account('peer-private-account','test-provider-a',[model('shared',['high','low']),model('default-only',[])])
  ]);
  assert.ok(realHeartbeats.some(beat=>beat.device===lender.app.device.keyId &&
    beat.body.accounts?.some(row=>row.accountId==='lender-account-one')),'real coordinator accepted the signed heartbeat');
  const compose = () => api(owner.app,'/api/circles/'+encodeURIComponent(circle.id)+'/compose');
  const pair = (providerId,modelId,effortIds) => ({providerId,modelId,effortIds});
  const offers = state => state.accountOffers?.map(offer=>({...offer,effortIds:[...offer.effortIds].sort()}))
    .sort((a,b)=>(a.providerId+'/'+a.modelId).localeCompare(b.providerId+'/'+b.modelId));
  const state = await compose();
  assert.deepEqual(offers(state),[
    pair('test-provider-a','default-only',[]),pair('test-provider-a','shared',['high','low']),
    pair('test-provider-b','shared',['different'])
  ]);
  assert.equal(state.runRequestSupported,true);
  assert.doesNotMatch(JSON.stringify(state),/lender-account-one|lender-account-two|peer-private-account/);
  await signedBeat(declining,'test-acct-b',2,[
    account('peer-private-account','test-provider-a',[model('shared',['high']),model('default-only',[])])
  ],'off');
  assert.deepEqual(offers(await compose()),[
    pair('test-provider-a','shared',['low']),pair('test-provider-b','shared',['different'])
  ]);
});
