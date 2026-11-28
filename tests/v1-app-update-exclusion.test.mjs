import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, waitFor, boundedFetch } from './helpers/v1-lifecycle-fixture.mjs';

const gitInput = circle => ({circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40),
  prompt: 'Synthetic task: write a greeting.', harness: 'codex'});
const accept = async app => {
  const card = await waitFor(async () => (await api(app, '/api/approvals'))[0], 'review card', 20000);
  await api(app, '/api/approvals/' + card.id + '/accept', {method: 'POST', body: {}});
};
const lendingOn = async (app, circle, mode = 'ask') => {
  await api(app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode}});
  await api(app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
};

// A fake updater whose download takes as long as the test wants. Its tick asks the app for the exclusion exactly where the real one does.
function slowUpdater() {
  let finish, asked, answer;
  const downloaded = new Promise(resolve => { finish = resolve; });
  const asking = new Promise(resolve => { asked = resolve; });
  return {installDir: '/x', intervalMs: 3600000, startDelayMs: 50, finish, asking, get answer() { return answer; },
    async tick({idle, exclusive}) {
      assert.equal(idle, true, 'the app looked idle when the update began');
      await downloaded;
      answer = await exclusive();
      asked(answer);
      return 'staged'; // the test stands in for the swap and shutdown, so the app stays up
    }};
}

test('a job that starts while the update downloads stops the swap, and lending carries on', {timeout: 120000}, async t => {
  const f = await appFixture(t, {hold: true});
  const updater = slowUpdater();
  const {owner, lender, circle} = await f.connect({updater});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  await api(owner.app, '/api/jobs', {headers:{'faravan-confirm':'yes'},method: 'POST', body: gitInput(circle)});
  await accept(lender.app);
  await waitFor(async()=>(await api(lender.app,'/api/status')).currentJob!==null,'the app observes the running job');
  updater.finish();
  assert.equal(await updater.asking, null, 'the exclusion refuses: a job is running');
  const status = await api(lender.app, '/api/status');
  assert.notEqual(status.currentJob, null);
  assert.equal(status.intent.state, 'ready', 'lending is still on');
  lender.backend.release();
});

test('when nothing is running the exclusion stops new claims until its owner restores lending', {timeout: 120000}, async t => {
  const f = await appFixture(t, {hold: true});
  const updater = slowUpdater();
  const {owner, lender, circle} = await f.connect({updater});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  updater.finish();
  const release = await updater.asking;
  assert.equal(typeof release, 'function');
  // While held, a job that arrives is not taken.
  await api(owner.app, '/api/jobs', {headers:{'faravan-confirm':'yes'},method: 'POST', body: gitInput(circle)});
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.deepEqual(await api(lender.app, '/api/approvals'), [], 'no job is claimed while the update holds the lender');
  release();
  // Lending is back: the waiting job is claimed and offered for review. (Skip it; the test needs no run.)
  const card = await waitFor(async () => (await api(lender.app, '/api/approvals'))[0], 'the job is offered again once lending is restored', 20000);
  await api(lender.app, '/api/approvals/' + card.id + '/skip', {method: 'POST', body: {}});
});

test('a signed startup roster read before provisioning is denied without poisoning fixture teardown', {timeout:120000}, async t=>{
  const f=await appFixture(t),events=[];
  let knownRequest=null;
  const owner=await f.start('owner',{fetch:async(url,options={})=>{
    const match=/^\/v1\/circles\/([^/]+)(\/.*)$/.exec(new URL(url).pathname);
    if(match&&(options.method??'GET')==='GET'&&['/roster','/capabilities'].includes(match[2])){
      const provisioned=f.circles.has(match[1]);
      events.push({method:'GET',route:match[2],circle:match[1],phase:provisioned?'after provisioning':'before provisioning'});
      if(provisioned&&match[2]==='/capabilities')knownRequest={url,options};
    }
    return boundedFetch(url,options);
  }});
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Unpublished startup circle',publish:false}});
  assert.equal(f.circles.has(circle.id),false);
  let unknown;
  try {await owner.app.device.client(circle.id);}
  catch(error){unknown={status:error.status,code:error.code};}
  assert.equal(f.circles.has(circle.id),false,'unknown read never provisions the circle');
  // Test-owned out-of-band provisioning mirrors the production router; it is not network-authorized provisioning.
  const roster=(await owner.app.device.rosterCache(circle.id).get()).current;
  f.circles.set(circle.id,{roster,invites:new Map(),enrollments:[]});
  events.push({circle:circle.id,phase:'out-of-band provisioning'});
  const client=await owner.app.device.client(circle.id);
  assert.ok(Array.isArray((await client.capabilities({refresh:true})).capabilities),'valid signed known-circle read succeeds');
  assert.ok(knownRequest);
  const replay=await boundedFetch(knownRequest.url,knownRequest.options);
  assert.equal(replay.status,401,'known-circle nonce replay is still rejected');
  assert.equal((await replay.json()).code,'replay');
  const epoch=roster.payload.epoch,members=roster.payload.members;
  try {
    roster.payload.epoch=epoch+1;
    const stale=await boundedFetch(knownRequest.url,knownRequest.options);
    assert.equal(stale.status,409,'known-circle epoch is checked before nonce admission');
    assert.equal((await stale.json()).code,'roster_stale');
    roster.payload.epoch=epoch;roster.payload.members=[];
    const forbidden=await boundedFetch(knownRequest.url,knownRequest.options);
    assert.equal(forbidden.status,403,'known-circle membership is checked before nonce admission');
    assert.equal((await forbidden.json()).code,'forbidden');
  } finally {roster.payload.epoch=epoch;roster.payload.members=members;}
  t.diagnostic(JSON.stringify(events));
  assert.deepEqual(unknown,{status:404,code:'circle_not_provisioned'},'a legitimate signed pre-provisioning read follows the real router contract');
  assert.ok(events.some(e=>e.method==='GET'&&e.route==='/roster'&&e.phase==='before provisioning'));
  assert.deepEqual(f.failures,[],'an unprovisioned-circle response does not create a delayed after-hook assertion');
});
