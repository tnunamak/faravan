import {test, expect} from '@playwright/test';
import {patchHome, startHarness, withRequestAdmission} from './lib.mjs';

let harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.stop(); });

const circle = {id:'shared', name:'Weekend projects', origin:'http://fixture', lendingMode:'ask'};
const digest = 'sha256:' + 'a'.repeat(64);
const approval = (jobs = 0) => withRequestAdmission({
  id:'approval-1', jobDigest:digest, requester:'sam', requesterName:'Sam', prompt:'Fix the login loop',
  harness:'codex', model:[], runtimeSeconds:1200,
  source:{kind:'archive', size_bytes:1}, network:'provider-only',
  protection:{satisfied:true, enforced:[], unenforced:[]},
  identity:{memberPresent:true, rosterFresh:true, rootMatches:true, circleMatches:true},
  expiresAt:Date.now()+600000, job:{circle:'shared', requirements:{egress:'provider-only', limits:{wall_seconds:1200}}},
}, {usage:{jobs,jobLimit:3,minutes:0,minuteLimit:60},accountedMilliseconds:0,dailyMinutes:60,now:Date.now()});
const readyEvidence = {effective:{intent:{on:true,state:'ready'},execution:{state:'idle'},version:'fixture-v2'},dailyLimitReached:false};

async function fixture(page, approvals = [approval()]) {
  await patchHome(page, readyEvidence, body => ({...body,state:'ready',lending_blockers:null,intent:{on:true,state:'ready'},execution:{state:'idle'},lending:{...body.lending,enabled:true,paused:false,circle:'shared',current:null,status:'idle',mode:'ask'},lendingPolicy:{...body.lendingPolicy,accounts:[],providerConsent:{...body.lendingPolicy?.providerConsent,codex:true}}}));
  await page.route('**/api/circles', route => route.fulfill({json:[circle]}));
  await page.route('**/api/agents', route => route.fulfill({json:[{id:'codex',installed:true,signedIn:true,useForLending:true}]}));
  await page.route('**/api/readiness', route => route.fulfill({json:{ready:true,checks:[]}}));
  await page.route('**/api/approvals', route => route.fulfill({json:approvals}));
  await page.route('**/api/devices', route => route.fulfill({json:{name:'Tessa’s computer',ownerName:'Tessa',circles:[]}}));
  await page.route('**/api/jobs', route => route.fulfill({json:[]}));
}

test('explicit saved Ask keeps a pending approval reviewable while status and jobs are slow', async ({page}) => {
  await fixture(page);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/home', async route => { await pending; await route.fallback(); });
  await page.route('**/api/jobs', async route => { await pending; await route.fulfill({json:[]}).catch(() => {}); });
  await page.route('**/api/approvals/approval-1/accept', route => route.fulfill({json:{id:'approval-1',accepted:true,jobDigest:digest}}));
  await page.route(new RegExp('/api/jobs/sha256%3A' + 'a'.repeat(64) + '\\?circle=shared$'), route => route.fulfill({json:{
    job_digest:digest,role:'sent',state:'claimed',status:'Starting',circle:{id:'shared',name:'Weekend projects'},
    local:{title:'Fix the login loop',prompt:'Fix the login loop'},
    current_attempt:{holder:'tessa-device',approved_at:new Date().toISOString(),execution_started_at:new Date().toISOString()},
  }}));
  // The job is running, so its feed is read; without one the page correctly shows last-known status.
  await page.route(new RegExp('/api/jobs/sha256%3A' + 'a'.repeat(64) + '/transcript'), route => route.fulfill({json:{text:'',live:true}}));
  try {
    const started = Date.now();
    await page.goto((await harness.link('lender'))+'#/home');
    const queue = page.locator('section[aria-labelledby=home-needs]');
    await expect(queue.getByText('Sam asked to use your computer')).toBeVisible();
    await expect(queue.getByRole('link',{name:'Review request'})).toBeVisible();
    const reviewVisible = Date.now();
    await expect(page.getByRole('heading',{level:1,name:'What would you like to get done?'})).toBeVisible();
    await expect(page.locator('.page-head .page-sub')).toHaveCount(0);
    await expect(page.locator('.side-link[href="#/home"] .count')).toBeHidden();
    await expect(page.locator('.tabbar a[href="#/home"] .badge')).toBeHidden();
    await expect(page.locator('.machine')).toContainText('Checking this computer');
    await expect(page.getByLabel('Loading this computer')).toBeVisible();
    await expect(page.getByLabel('Request notifications')).toHaveCount(0);
    await expect(queue.getByRole('link',{name:'Review request'})).toHaveAttribute('href','#/request/approval-1');
    await queue.getByRole('link',{name:'Review request'}).click();
    await expect(page).toHaveURL(/#\/request\/approval-1$/);
    await expect(page.getByRole('button',{name:'Run it'})).toBeEnabled();
    const requestReady = Date.now();
    release();
    await expect(page.locator('.machine')).not.toContainText('Checking');
    await page.getByRole('button',{name:'Run it'}).click();
    await page.getByRole('link',{name:'Open the job'}).click();
    await expect.poll(() => page.evaluate(() => new URL(location.href).hash)).toBe('#/job/' + encodeURIComponent(digest) + '/shared');
    await expect(page.getByRole('heading',{level:1,name:'Fix the login loop'})).toBeVisible();
    await expect(page.locator('.job-page')).toContainText('Working');
    await expect(page.locator('.job-page')).toContainText(/Started \d{1,2}:\d{2} [AP]M · running \d+ (?:s|min)/);
    console.log(`approval journey: Review ${reviewVisible-started}ms, request ${requestReady-started}ms, outcome ${Date.now()-started}ms`);
  } finally { release(); }
});

test('a failed jobs read leaves Review visible and the idle lender does not invent a running job', async ({page}) => {
  await fixture(page);
  await page.route('**/api/jobs', route => route.fulfill({status:500,json:{code:'network'}}));
  await page.goto((await harness.link('lender'))+'#/home');
  await expect(page.locator('section[aria-labelledby=home-needs]').getByRole('link',{name:'Review request'})).toBeVisible();
  await expect(page.locator('section[aria-labelledby=home-motion]')).toContainText('Jobs could not be loaded.');
  await expect(page.locator('section[aria-labelledby=home-computer]')).not.toContainText('job is running');
  await page.evaluate(() => { location.hash='#/lend'; });
  await expect(page.locator('.hero')).toContainText('Ready for requests');
  await expect(page.locator('.hero')).toContainText('A new request is checked against the quota available when it arrives.');
  await expect(page.locator('.hero').getByRole('link',{name:'Review'})).toBeVisible();
  await expect(page.locator('.hero')).not.toContainText('running job');
});

test('a signed zero-file result is recent No changes, not a review item', async ({page}) => {
  await fixture(page, []);
  await page.route('**/api/approvals', route => route.fulfill({json:[]}));
  const zeroJob = {
    job_digest:'zero',role:'sent',status:'Finished',circle,local:{title:'Add a sum function',prompt:'Add a sum function'},
    waitingTiming:{submittedAt:new Date().toISOString()},
  };
  await page.route('**/api/jobs', route => route.fulfill({json:[zeroJob]}));
  await page.route('**/api/jobs/zero?circle=shared', route => route.fulfill({json:zeroJob}));
  await page.route('**/api/jobs/zero/receipt?circle=shared', route => route.fulfill({json:{
    receipt:{candidate_format:'diff',diffstat:{files:0,insertions:0,deletions:0}},
  }}));
  await page.route('**/api/jobs/zero/changes?circle=shared', route => route.fulfill({json:{
    format:'diff',files:[],diffstat:{files:0,insertions:0,deletions:0},diff:'',
  }}));
  await page.route('**/api/jobs/zero/transcript?circle=shared', route => route.fulfill({json:{text:JSON.stringify({type:'result',result:'The sum function is already present.'})}}));
  await page.goto((await harness.link('lender'))+'#/home');
  await expect(page.locator('section[aria-labelledby=home-recent]')).toContainText('Add a sum function');
  await expect(page.locator('section[aria-labelledby=home-recent]')).toContainText('No changes');
  await expect(page.locator('section[aria-labelledby=home-needs]')).not.toContainText('Ready to review');
  await expect(page.getByRole('heading',{level:1,name:'What would you like to get done?'})).toBeVisible();
  await expect(page.locator('.page-head .page-sub')).toHaveCount(0);
  await expect(page.locator('.side-link[href="#/home"] .count')).toHaveCount(0);
  await page.evaluate(() => { location.hash='#/jobs'; });
  await expect(page.locator('.jlist')).toContainText('No changes');
  await expect(page.locator('.jlist')).not.toContainText('Ready to review');
  await expect(page.getByRole('button',{name:/Needs you/})).toHaveText('Needs you 0');
  await page.locator('.jlist a.row').click();
  await expect(page.getByRole('heading',{name:'Add a sum function'})).toBeVisible();
  await expect(page.locator('.jh')).toContainText('Finished');
  await expect(page.getByRole('heading',{name:'Agent response',exact:true})).toBeVisible();
  await expect(page.getByText('The sum function is already present.',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'What changed for you',exact:true})).toHaveCount(0);
  await expect(page.getByText('Ready to review',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Download the patch',exact:true})).toHaveCount(0);
});

test('a pending approval at the daily job cap cannot be run on this computer', async ({page}) => {
  await fixture(page, [approval(3)]);
  await page.goto((await harness.link('lender'))+'#/request/approval-1');
  await expect(page.locator('.rq-hint[role="status"]')).toHaveText("You've run 3 of 3 jobs today. Other lenders can take this one.");
  await expect(page.getByRole('button',{name:'Run it'})).toBeDisabled();
});
