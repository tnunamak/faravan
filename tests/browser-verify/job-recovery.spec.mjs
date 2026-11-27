import {test, expect} from '@playwright/test';
import {projectJobFixture, startHarness} from './lib.mjs';

let harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.stop(); });

const circle = {id: 'recovery-circle', name: 'Weekend projects', origin: 'http://fixture', rosterMembershipVerified:true};
const digest = 'sha256:' + 'c'.repeat(64);
const attemptId = 'attempt-current-17';
async function jobPage(page, actor, job, {retention = {deletable: false}, onRequest = () => {}, changesResponse} = {}) {
  await page.route('**/api/circles', route => route.fulfill({json: [circle]}));
  await page.route('**/api/circles/*/compose', route => route.fulfill({json: {}}));
  await page.route('**/api/devices', route => route.fulfill({json: {fingerprint: 'holder-current', circles: []}}));
  await page.route('**/api/jobs', route => route.request().method() === 'GET' ? route.fulfill({json: []}) : route.continue());
  await page.route('**/api/lending/stop', async route => {
    onRequest(route.request());
    await route.fulfill({json: {ok: true}});
  });
  await page.route('**/api/jobs/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/delete')) {
      onRequest(request);
      return route.fulfill({json: {ok: true}});
    }
    if (pathname.endsWith('/apply')) {
      onRequest(request);
      return route.fulfill({status: 409, json: {code: 'branch_exists', apply_code: 'branch_exists', state: 'job.apply-branch-exists'}});
    }
    if (pathname.endsWith('/changes') && changesResponse) return changesResponse(route);
    if (pathname.endsWith('/changes')) return route.fulfill({json: {format: 'diff', files: [{path: 'sum.mjs', insertions: 1, deletions: 0}], diffstat: {files: 1, insertions: 1, deletions: 0}, diff: 'diff --git a/sum.mjs b/sum.mjs\n+return sum\n', ...(job.receipt ? {receipt: job.receipt} : {})}});
    if (pathname.endsWith('/transcript')) return route.fulfill({json: {text: 'Fixed the sum.'}});
    if (pathname.endsWith('/retention')) return route.fulfill({json: retention});
    return route.fulfill({json: projectJobFixture(job)});
  });
  await page.goto((await harness.link(actor)) + '#/job/' + encodeURIComponent(digest) + '/' + circle.id);
}

test('lender confirms Stop job for the exact current attempt', async ({page}) => {
  const requests = [];
  const job = {job_digest: digest, state: 'running', current_attempt: {attempt_id: attemptId, generation: 1, holder: 'holder-current', execution_started_at: new Date().toISOString()}};
  await jobPage(page, 'lender', job, {onRequest: request => requests.push(request)});

  await page.getByRole('heading', {level: 1}).waitFor();
  await page.getByRole('button', {name: 'Stop this job', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Stop this job?'});
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', {name: 'Stop job', exact: true}).click();

  await expect.poll(() => requests.length).toBe(1);
  expect(new URL(requests[0].url()).pathname).toBe('/api/lending/stop');
  expect(requests[0].postDataJSON()).toEqual({attemptId, confirmed: true});
});

test('terminal own job delete asks first, posts its circle, then returns to Jobs', async ({page}) => {
  const requests = [];
  const job = {job_digest: digest, state: 'failed', status: 'failed', local: {title: 'Fix the sum', prompt: 'Fix the sum', sourcePath: '/repo/project'}, runTiming: {endedAt: new Date().toISOString()}};
  await jobPage(page, 'owner', job, {retention: {deletable: true}, onRequest: request => requests.push(request)});

  await page.getByRole('heading', {level: 1, name: 'Fix the sum'}).waitFor();
  await page.getByRole('button', {name: 'Delete this job…'}).click();
  const dialog = page.getByRole('dialog', {name: 'Delete this job?'});
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', {name: 'Delete job', exact: true}).click();

  await expect.poll(() => requests.length).toBe(1);
  expect(new URL(requests[0].url()).pathname).toBe('/api/jobs/' + encodeURIComponent(digest) + '/delete');
  expect(requests[0].postDataJSON()).toEqual({circle: circle.id});
  await expect(page).toHaveURL(/#\/jobs$/);
  await expect(page.getByRole('heading', {level: 1, name: 'Jobs'})).toBeVisible();
});

test('branch-exists refusal offers rename, command, and copy details', async ({page}) => {
  const requests = [];
  const job = {job_digest: digest, state: 'result-accepted', status: 'result-accepted', result_digest:'sha256:'+'d'.repeat(64), local: {title: 'Fix the sum', prompt: 'Fix the sum', sourcePath: '/repo/project'}};
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: new URL(harness.urls.owner).origin});
  await jobPage(page, 'owner', job, {onRequest: request => requests.push(request)});

  await page.getByRole('heading', {level: 1, name: 'Fix the sum'}).waitFor();
  await page.getByRole('button', {name: 'Add as a branch…'}).click();
  const sheet = page.getByRole('dialog', {name: 'Add as a branch'});
  const branch = sheet.getByRole('textbox', {name: 'Branch name'});
  await expect(branch).toBeVisible();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].postDataJSON()).toMatchObject({repo: '/repo/project', dry_run: true});
  await expect(sheet.getByRole('alert')).toContainText('That branch name is already here. Review the existing branch or choose another name.');

  await sheet.getByText('Show the branch', {exact: true}).click();
  await expect(sheet.locator('code').filter({hasText: 'git -C'})).toContainText('faravan/'+'c'.repeat(12));
  await sheet.getByRole('button', {name: 'Copy details'}).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(copied)).toMatchObject({state: 'job.apply-branch-exists', code: 'branch_exists', job: digest, circle: circle.id, repo: '/repo/project'});
  await sheet.getByRole('button', {name: 'Use another name'}).click();
  await expect(branch).toBeFocused();
  expect(requests).toHaveLength(1);
});


test('a terminal job cannot be deleted until the host allows it', async ({page}) => {
  const requests = [];
  await jobPage(page, 'owner', {job_digest:digest,state:'failed',local:{title:'Fix the sum'}}, {retention:{deletable:false},onRequest:r=>requests.push(r)});
  await expect(page.locator('.result-properties dt').filter({hasText:'Kept until'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Delete this job…'})).toHaveCount(0);
  expect(requests).toHaveLength(0);
});


test('zero-file result stays neutral until changes arrive, then shows the finished response', async ({page}) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const job = {job_digest:digest, state:'result-accepted', local:{title:'Check the date',prompt:'Check the date'}};
  try {
    await jobPage(page, 'owner', job, {changesResponse:async route => {
      await held;
      return route.fulfill({json:{format:'diff', files:[], diffstat:{files:0,insertions:0,deletions:0}}});
    }});
    await expect(page.getByRole('heading', {level:1,name:'Check the date'})).toBeVisible();
    await expect(page.getByRole('status', {name:'Loading result',exact:true})).toBeVisible();
    await expect(page.getByText('Ready to review',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Download the patch',exact:true})).toHaveCount(0);
    release();
    await expect(page.locator('.jh')).toContainText('Finished');
    await expect(page.getByRole('heading',{name:'Agent response',exact:true})).toBeVisible();
    await expect(page.locator('.result-workspace')).toHaveCount(0);
    await expect(page.getByText('Ready to review',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Download the patch',exact:true})).toHaveCount(0);
  } finally { release(); }
});

test('Jobs learns No changes from receipt metadata and detail waits for the complete result', async ({page}) => {
  const job = {job_digest:digest,circle,state:'result-accepted',result_digest:'sha256:'+'d'.repeat(64),local:{title:'Check the date',prompt:'Check the date'}};
  await jobPage(page,'owner',job);
  await page.route('**/api/jobs', route => route.fulfill({json:[projectJobFixture(job)]}));
  await page.route('**/api/jobs/**/receipt?*', route => route.fulfill({json:{receipt:{candidate_format:'diff',diffstat:{files:0},harness:'codex'}}}));
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/jobs/**/changes?*', async route => { await held; return route.fulfill({json:{format:'diff',files:[]}}); });
  try {
    await page.evaluate(() => { location.hash = '#/jobs'; });
    await expect(page.getByText('No changes',{exact:true}).filter({visible:true}).first()).toBeVisible();
    await page.locator('.jlist a.row').first().click();
    await expect(page.getByRole('heading',{level:1,name:'Check the date'})).toBeVisible();
    await expect(page.locator('.jh')).toContainText('Loading result');
    await expect(page.getByText('Ready to review',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Download the patch',exact:true})).toHaveCount(0);
    release();
    await expect(page.locator('.jh')).toContainText('Finished');
    await expect(page.getByRole('heading',{name:'Agent response',exact:true})).toBeVisible();
    await expect(page.locator('.result-workspace')).toHaveCount(0);
  } finally { release(); }
});

test('a reserved job waits for an answer until approval or execution is recorded', async ({page}) => {
  const job={job_digest:digest,state:'claimed',approval:'pending',status:'Starting',local:{title:'Check the date',prompt:'Check the date'},current_attempt:{attempt_id:attemptId,holder:'holder-current',claimed_at:new Date().toISOString(),execution_started_at:null}};
  await jobPage(page,'owner',job);
  await expect(page.locator('.jh .pill')).toHaveText('Waiting for an answer');
  await expect(page.getByText('Waiting for a lender to say yes',{exact:true})).toBeVisible();
  await expect(page.locator('.steps li').nth(1)).not.toHaveClass(/done|now/);
  expect(await page.locator('main').innerText()).not.toMatch(/claimed/i);
  job.current_attempt.approved_at=new Date().toISOString();
  job.approval='approved';
  await page.reload();
  await expect(page.locator('.jh .pill')).toHaveText('Approved');
  await expect(page.getByText('A lender said yes',{exact:true})).toBeVisible();
  await expect(page.locator('.steps li').nth(1)).toHaveClass('now');
  job.current_attempt.execution_started_at=new Date().toISOString();
  await page.reload();
  await expect(page.locator('.jh .pill')).toHaveText('Working');
  await expect(page.locator('.steps')).toHaveCount(0);
  await expect(page.getByRole('list',{name:'What the agent is doing'})).toBeVisible();
});

test('Decline returns to neutral waiting with the lender’s decision and expiry visible', async ({page}) => {
  const job={job_digest:digest,circle,state:'queued',local:{title:'Check the date',prompt:'Check the date'},current_attempt:{holder:'reviewer',reason:JSON.stringify({code:'approval_denied'})},waitingTiming:{expiresAt:new Date(Date.now()+86400000).toISOString()}};
  await jobPage(page,'owner',job);
  await page.route('**/api/devices',route=>route.fulfill({json:{fingerprint:'borrower',circles:[{circle:circle.id,members:[{key_id:'reviewer',localName:'Sam'}]}]}}));
  await page.reload();
  const sentence='Sam declined this request. It went back to the circle; another computer can pick it up.';
  await expect(page.getByText(sentence,{exact:true})).toBeVisible();
  await expect(page.getByText('Waiting for someone to run it.',{exact:true})).toBeVisible();
  await expect(page.locator('main')).toContainText('Expires');
  await expect(page.getByRole('button',{name:'Cancel job',exact:true})).toBeVisible();
  await expect(page.locator('.jh .pill')).toHaveText('Waiting');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.route('**/api/jobs',route=>route.fulfill({json:[projectJobFixture(job)]}));
  await page.evaluate(()=>{location.hash='#/jobs';});
  await expect(page.locator('.jlist [title*="Sam declined this request"]').first()).toBeAttached();
});
