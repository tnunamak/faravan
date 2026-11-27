import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import * as p from '../lib/protocol/index.mjs';
import {createJobOperations} from '../lib/v1/cli.mjs';
import {appFixture,api,boundedFetch,syntheticBackend,waitFor} from './helpers/v1-app-fixture.mjs';
import {provider,approved,publicOrigin} from './helpers/fake-gozar-provider.mjs';
import {git,makeRepo} from './helpers/git-guest.mjs';

const providerConfiguration = {
  descriptor: {schemaVersion: 1, id: 'codex', label: 'Configured key service', signInKind: 'api_key', refreshKind: 'none',
    usageKind: 'job_local', maxConcurrentJobs: 1, nativeUnits: [{id: 'tokens', scale: 1}],
    models: [{id: 'example-model', label: 'Example', enabled: true, rank: 0, pareto: null,
      efforts: [{id: 'high', label: 'High'}], defaultEffort: 'high'}],
    destinations: [{origin: 'https://controlled.invalid', pathPrefixes: ['/v1'], methods: ['POST']}]},
  identityUrl: 'https://controlled.invalid/me', identitySubjectField: 'subject', command: 'codex', args: ['exec'],
  modelFlag: '-m', effortFlag: '--effort', keyEnv: 'JOB_KEY', baseUrlEnv: 'BASE_URL',
};
async function enroll(app, key, operationId) {
  const flow = await api(app, '/api/accounts', {method: 'POST', body: {providerId: 'codex', label: operationId, operationId}});
  const account = (await api(app, '/api/accounts/flows/' + flow.value.flowId + '/complete', {method: 'POST', body: {answer: key}})).value;
  const {revision} = await api(app, '/api/accounts');
  const settings = await api(app, '/api/accounts/' + account.id + '/settings', {method: 'POST',
    body: {expectedRevision: revision, modelPreference: {modelId: 'example-model', enabled: true, effortIds: null}}});
  assert.equal(settings.ok, true, JSON.stringify(settings));
  return account;
}


test('the named lender automatically claims and returns one result while the owner coordinator is offline', {timeout: 90000}, async t => {
  const f = await appFixture(t), fake = provider();
  const repo = await makeRepo({'README.md':'Before.\n','keep.txt':'Keep this file.\n'});
  t.after(()=>rm(repo.dir,{recursive:true,force:true}));
  const workingTree = join(f.root,'apply-working-tree');
  git(repo.dir,'clone','--quiet','--no-hardlinks',repo.dir,workingTree);
  const changed = 'From the designated lender.\n';
  const backend = syntheticBackend(f.root,{change:{path:'README.md',bytes:changed}});
  backend.prepareAccountRun = async spec => {
    const h = await backend.prepare(spec);
    h.job_id = spec.job_id;
    h.sandbox_id = 'designated-' + randomUUID();
    h._cleanupId = randomUUID();
    return h;
  };
  backend.inspect = async h => ({job_id:h.job_id,status:'exited'});
  let dispatches = 0;
  let brokerStatus;
  const start = backend.start.bind(backend);
  backend.start = async (h,opts) => {
    if (h._entrypoint.startsWith('env ')) {
      const key = /JOB_KEY=([^']+)/.exec(h._entrypoint)?.[1];
      const base = /BASE_URL=([^']+)/.exec(h._entrypoint)?.[1];
      const reply = await fetch(base + '/responses', {method:'POST',
        headers:{authorization:'Bearer ' + key,'content-type':'application/json'},
        body:JSON.stringify({model:'example-model',effort:'high'})});
      brokerStatus = reply.status;
      assert.equal(brokerStatus,200,'designated lender broker authorized the actual dispatch');
      h._entrypoint = 'completed-designated-provider';
    }
    return start(h,opts);
  };
  const rejectedRequests = [];
  let incumbent, memberRoute, incumbentOffline = false;
  const fixtureFetch = (url,options) => {
    const target = new URL(url);
    if (target.origin===publicOrigin && memberRoute) {
      // Forward to the installed listener. The proof still names the approved public URL.
      const local = new URL('http://'+memberRoute.target);
      local.pathname = target.pathname;
      local.search = target.search;
      return boundedFetch(local,options);
    }
    if (!incumbentOffline || target.origin!==incumbent) return boundedFetch(url,options);
    rejectedRequests.push({method:options?.method??'GET',path:target.pathname.split('/').at(-1)});
    return Promise.resolve(new Response('Service Unavailable',{status:503}));
  };
  const {owner,lender,circle,realRequests} = await f.realConnect({
    ownerOptions:{fetch:fixtureFetch},lenderOptions:{
      fetch:fixtureFetch,backend,memberGozar:fake.api,accountProviderConfigurations:[providerConfiguration],
      accountTransportFetch:async (_url,options) => {
        if(options.method==='GET')return Response.json({subject:'designated-fixture'});
        dispatches++;
        return Response.json({id:'designated-response',object:'response',status:'completed',model:'example-model'});
      }
    }});
  const lenderId = lender.app.device.keyId;
  await approved(lender.app,fake);
  const exposure = await lender.app.memberExposure.start();
  assert.equal(exposure.origin,publicOrigin);
  const proposal = await lender.app.proposeMemberOrigin(circle.id);
  assert.equal(proposal.state,'proposed');
  const [review] = (await owner.app.device.reviewMemberOrigins(circle.id)).items;
  assert.equal(review.proposal_digest,proposal.proposal_digest);
  await owner.app.device.acceptMemberOrigin(circle.id,{
    key_id:lenderId,proposal_digest:review.proposal_digest,roster_epoch:review.roster_epoch});
  const roster = await lender.app.device.refreshRoster(circle.id);
  assert.equal(p.findMember(roster.payload,lenderId).origin,publicOrigin);

  incumbent = new URL(circle.origin).origin;
  memberRoute = fake.routes.get(exposure.route.handle.id);
  assert.equal(memberRoute.target,(await lender.app.memberListener.start()).target);

  const account = await enroll(lender.app,'DESIGNATED_FIXTURE_KEY','designated-enroll');
  const post = (path,body) => api(lender.app,path,{method:'POST',body});
  await post('/api/lending/limits',{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false});
  await post('/api/agents/codex',{useForLending:true});
  await post('/api/lending/mode',{circle:circle.id,mode:'auto'});
  const operations = createJobOperations({device:owner.app.device,clock:()=>Math.floor(Date.now()/1000)});
  const runRequest = {schemaVersion:1,models:[{providerId:'codex',modelId:'example-model'}],effortId:'high'};
  const submitted = await operations.submit({circle:circle.id,prompt:'Designated lender with owner offline',
    source:repo.dir,harness:'codex',runRequest,send_anyway:true,
    designated_member:lenderId});
  const memberClient = await owner.app.device.memberClient(circle.id,lenderId);
  const queued = await memberClient.getJob(submitted.jobDigest);
  assert.equal(queued.state,'queued');
  assert.equal(queued.attempts_started,0);
  assert.equal(realRequests.filter(r=>r.method==='POST'&&r.route.endsWith('/jobs')).length,0);

  incumbentOffline = true;
  try {
    await post('/api/lending/on',{circle:circle.id});
    const view = await waitFor(async()=>{
      const current = await memberClient.getJob(submitted.jobDigest);
      assert.notEqual(current.state,'failed','designated job did not fail before result');
      return current.state==='result-accepted'?current:null;
    },'automatic claim and result at the designated member',20000);
    assert.equal(view.attempts_started,1);
    assert.equal(view.current_attempt.holder,lenderId);
    assert.equal(dispatches,1);
    // The durable launch row names the designated member, so a restart resolves the same authority.
    const launches=Object.values(JSON.parse(await readFile(join(lender.home,'v1','account-launch','lending.json'),'utf8')).launches);
    assert.equal(launches.length,1);
    assert.equal(launches[0].attempt.designatedMember,lenderId);
    const result = await memberClient.fetchResult(submitted.jobDigest,{includeMetadata:true,attempt:view.current_attempt});
    assert.deepEqual(result.receipt.selection,{providerId:'codex',accountId:account.id,modelId:'example-model',effortId:'high'});
    const jobRoute = '/api/jobs/'+submitted.jobDigest;
    const circleQuery = '?circle='+circle.id;
    const borrowerView = await api(owner.app,jobRoute+circleQuery);
    assert.equal(borrowerView.state,'result-accepted');
    assert.equal(borrowerView.current_attempt.attempt_id,view.current_attempt.attempt_id);
    const borrowerReceipt = await api(owner.app,jobRoute+'/receipt'+circleQuery);
    assert.deepEqual(borrowerReceipt.receipt.selection,result.receipt.selection);
    const branch = 'designated-result';
    const apply = body => api(owner.app,jobRoute+'/apply',{method:'POST',headers:{'faravan-confirm':'yes'},
      body:{circle:circle.id,repo:repo.dir,branch,...body}});
    const preview = await apply({dry_run:true});
    assert.equal(preview.status,'dry_run');
    assert.equal(git(repo.dir,'for-each-ref','refs/heads/'+branch),'');
    const applied = await apply({dry_run:false,expect:{preview_token:preview.preview_token}});
    assert.equal(applied.status,'applied');
    assert.equal(git(repo.dir,'rev-parse',branch+'^'),repo.commit);
    assert.equal(git(repo.dir,'show',branch+':README.md'),changed.trimEnd());
    assert.equal(git(repo.dir,'rev-parse','HEAD'),repo.commit);
    assert.equal(await readFile(join(repo.dir,'README.md'),'utf8'),'Before.\n');
    assert.equal(git(repo.dir,'status','--porcelain'),'');
    const applyWorkingTree = body => api(owner.app,jobRoute+'/working-tree',{method:'POST',headers:{'faravan-confirm':'yes'},
      body:{circle:circle.id,repo:workingTree,...body}});
    const treeHead = await readFile(join(workingTree,'.git','HEAD'));
    const treeIndex = await readFile(join(workingTree,'.git','index'));
    const treeRefs = git(workingTree,'for-each-ref','--format=%(refname) %(objectname)');
    const treePreview = await applyWorkingTree({dry_run:true});
    assert.equal(treePreview.status,'dry_run');
    assert.equal(treePreview.head,repo.commit);
    assert.deepEqual(treePreview.files.map(file=>file.path),['README.md']);
    assert.equal(await readFile(join(workingTree,'README.md'),'utf8'),'Before.\n');
    assert.deepEqual(await readFile(join(workingTree,'.git','index')),treeIndex);
    assert.equal(git(workingTree,'--no-optional-locks','status','--porcelain'),'');
    const treeApplied = await applyWorkingTree({dry_run:false,files:['README.md'],
      expect:{head:treePreview.head,current_branch:treePreview.current_branch}});
    assert.equal(treeApplied.status,'applied');
    assert.deepEqual(treeApplied.applied,['README.md']);
    assert.equal(await readFile(join(workingTree,'README.md'),'utf8'),changed);
    assert.equal(await readFile(join(workingTree,'keep.txt'),'utf8'),'Keep this file.\n');
    assert.deepEqual(await readFile(join(workingTree,'.git','HEAD')),treeHead);
    assert.deepEqual(await readFile(join(workingTree,'.git','index')),treeIndex);
    assert.equal(git(workingTree,'for-each-ref','--format=%(refname) %(objectname)'),treeRefs);
    assert.equal(git(workingTree,'--no-optional-locks','status','--porcelain'),'M README.md');
    assert.equal(git(workingTree,'rev-parse','HEAD'),repo.commit);
    assert.equal(git(workingTree,'symbolic-ref','--short','HEAD'),treePreview.current_branch);
    assert.equal(git(workingTree,'diff','--cached'),'');
    assert.equal(git(workingTree,'diff','--name-only'),'README.md');
    assert.equal(dispatches,1,'applying either way does not execute another attempt');
    assert.equal(realRequests.filter(r=>r.method==='POST'&&/\/(claim|claim-next|complete)$/.test(r.route)).length,0);
  } finally {
    const observed = await memberClient.getJob(submitted.jobDigest);
    t.diagnostic(JSON.stringify({state:observed.state,attempts:observed.attempts_started,dispatches,brokerStatus,
      blockedHostRequests:rejectedRequests.slice(0,12)}));
  }
});
