import {test, expect} from '@playwright/test';
import {projectJobFixture, startHarness} from './lib.mjs';

let harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.stop(); });

const circle = {id:'seed-circle',name:'Seed test'};
const digest = 'sha256:' + 'c'.repeat(64);
const createdJob = {jobDigest:digest,job_digest:digest,circle,title:'Fix the dates',prompt:'Fix the dates',submittedByMe:true,status:'Waiting',state:'queued'};
const loadedJob = {job_digest:digest,state:'failed',status:'Failed',role:'sent',local:{title:'Fix the dates',prompt:'Fix the dates'},circle,
  current_attempt:{attempt_id:'seed-attempt',state:'failed',execution_started_at:'2026-10-20T11:19:00Z'}};

async function openApp(page, {delayMs = 0, failDetail = false, holdDetail = false} = {}) {
  let detailDelay = delayMs;
  let detailRequests = 0;
  const releaseWaiters = [];
  await page.route('**/api/circles', route => route.fulfill({json:[circle]}));
  await page.route('**/api/devices', route => route.fulfill({json:{fingerprint:'me',circles:[]}}));
  await page.route('**/api/jobs', route => route.fulfill({json:[]}));
  await page.route('**/api/jobs/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (path[3] === 'progress') return route.fulfill({json:{entries:[],nextAfter:0}});
    if (path[3] === 'transcript') return route.fulfill({json:{text:'',live:false,truncated:false}});
    if (path[3] === 'retention') return route.fulfill({json:{deletable:false}});
    if (path[3] === 'changes') return route.fulfill({json:{format:'diff',files:[],diffstat:{files:0,insertions:0,deletions:0},diff:''}});
    if (path[2] === digest && path.length === 3) {
      detailRequests++;
      if (holdDetail) await new Promise(resolve => releaseWaiters.push(resolve));
      if (detailDelay) await new Promise(resolve => setTimeout(resolve, detailDelay));
      if (failDetail) return route.fulfill({status:409,json:{code:'network_error'}});
      return route.fulfill({json:projectJobFixture(loadedJob)});
    }
    return route.fulfill({status:404,json:{code:'not_found',message:'Not found'}});
  });
  await page.goto(await harness.link('owner'));
  return {setDelay(ms) { detailDelay = ms; }, detailRequests:() => detailRequests, release() { releaseWaiters.splice(0).forEach(resolve => resolve()); }};
}

async function pushSeededJob(page) {
  await page.evaluate(({digest, circle, createdJob}) => {
    history.pushState({createdJob}, '', '#/job/' + encodeURIComponent(digest) + '/' + encodeURIComponent(circle.id));
    dispatchEvent(new HashChangeEvent('hashchange'));
  }, {digest,circle,createdJob});
}

test('reload ignores a persisted createdJob while the authoritative job read is pending', async ({page}) => {
  const routes = await openApp(page);
  await pushSeededJob(page);
  await expect(page.getByText('The job didn’t finish')).toBeVisible();
  expect(await page.evaluate(() => Boolean(history.state?.createdJob))).toBe(false);
  await page.evaluate(seed => history.replaceState({...history.state,createdJob:seed}, ''), createdJob);
  routes.setDelay(1000);
  await page.reload();
  await expect(page.getByRole('status', {name:'Loading job'})).toBeVisible();
  await expect(page.getByText('Waiting for a computer')).toHaveCount(0);
  await expect(page.getByRole('button', {name:'Cancel job'})).toHaveCount(0);
  await expect(page.getByText('The job didn’t finish')).toBeVisible();
});

test('back navigation clears a createdJob seed before the next detail read', async ({page}) => {
  const routes = await openApp(page, {holdDetail:true});
  await pushSeededJob(page);
  await expect(page.getByText('Waiting for a computer')).toBeVisible();
  await expect.poll(routes.detailRequests).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => Boolean(history.state?.createdJob))).toBe(false);
  const requestsBeforeBack = routes.detailRequests();
  await page.evaluate(() => {
    history.pushState({}, '', '#/jobs');
    dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await expect(page.getByRole('heading', {level:1,name:'Fix the dates'})).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('status', {name:'Loading job'})).toBeVisible();
  await expect(page.getByText('Waiting for a computer')).toHaveCount(0);
  await expect(page.getByRole('button', {name:'Cancel job'})).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(history.state?.createdJob))).toBe(false);
  await expect.poll(routes.detailRequests).toBeGreaterThan(requestsBeforeBack);
  routes.release();
  await expect(page.getByText('The job didn’t finish')).toBeVisible();
});

test('a failed detail read does not leave a createdJob seed as Waiting or Cancel', async ({page}) => {
  await openApp(page, {failDetail:true});
  await pushSeededJob(page);
  await expect(page.getByRole('heading', {name:'Circle cannot be reached',exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('The computer hosting this circle cannot be reached. Check that it is awake and connected before sending.');
  await expect(page.getByText('Waiting for a computer')).toHaveCount(0);
  await expect(page.getByRole('button', {name:'Cancel job'})).toHaveCount(0);
});
