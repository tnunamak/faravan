import {test, expect} from '@playwright/test';
import {startHarness, withRequestAdmission} from './lib.mjs';

const admissionEvidence = now => ({
  usage:{jobs:0,jobLimit:3,minutes:0,minuteLimit:60},accountedMilliseconds:0,dailyMinutes:60,now,
});

test('Run it reports progress in place, then Open the job focuses the job heading', async ({browser}) => {
  test.info().annotations.push({type:'slice', description:'D-request'}, {type:'check', description:'run-outcome'});
  const harness = await startHarness(), context = await browser.newContext();
  try {
    const page = await context.newPage();
    const digest = 'sha256:' + 'b'.repeat(64), circle = {id:'outcome-circle', name:'Weekend projects', origin:'https://circle.example', enrollment:{state:'approved'}, rosterMembershipVerified:true};
    const card = withRequestAdmission({id:'run-fixture', jobDigest:digest, job:{circle:circle.id,requirements:{limits:{wall_seconds:1200}}}, requester:'sender-key', requesterName:'Sam', prompt:'Fix checkout dates.',
      harness:'codex', model:[], source:{kind:'archive', size_bytes:1}, runtimeSeconds:1200,
      expiresAt:Date.now()+600000, network:'provider-only', protection:{satisfied:true, enforced:[], unenforced:[]},
      identity:{memberPresent:true, rosterFresh:true, rootMatches:true, circleMatches:true}},admissionEvidence(Date.now()));
    let accepts = 0;
    await page.route('**/api/circles', route => route.fulfill({json:[circle]}));
    await page.route('**/api/approvals', route => route.fulfill({json:[card]}));
    await page.route('**/api/approvals/run-fixture/accept', route => { accepts++; return route.fulfill({json:{id:card.id, accepted:true}}); });
    await page.route(/\/api\/jobs\/sha256%3A[b]{64}(?:\?.*)?$/i, route => route.fulfill({json:{job_digest:digest, circle, state:'claimed', status:'Starting',
      local:{title:card.prompt, prompt:card.prompt}, current_attempt:{holder:'lender', state:'claimed'}}}));
    await page.goto((await harness.link('lender')) + '#/request/run-fixture');
    await page.getByRole('button', {name:'Run it'}).click();
    // The accepted job is claimed but not started yet, so the card says it is preparing here.
    await expect(page.locator('.rq-decide')).toContainText('Preparing on your computer…');
    await expect(page.getByRole('button', {name:'Run it'})).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.className)).toBe('rq-state');
    await page.getByRole('link', {name:'Open the job'}).click();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/job/' + encodeURIComponent(digest) + '/' + circle.id);
    await expect(page.locator('.job-page h1')).toBeVisible();
    await expect(page.locator('main')).not.toContainText('You said yes');
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
    expect(accepts).toBe(1);
  } finally { await context.close(); await harness.stop(); }
});

test('an accepted request revisited on your computer names the decision and opens its job', async ({browser}) => {
  test.info().annotations.push({type:'slice',description:'D-request'},{type:'check',description:'accepted-request'});
  const harness=await startHarness(),context=await browser.newContext();
  try {
    const page=await context.newPage();
    const digest='sha256:'+'c'.repeat(64),circle='accepted-circle';
    await page.route('**/api/approvals',route=>route.fulfill({json:[]}));
    await page.route('**/api/activity',route=>route.fulfill({json:[
      {id:1,type:'approval',data:{id:'accepted-fixture',jobDigest:digest,job:{circle}}},
      {id:2,type:'approval',at:'2026-10-20T07:46:00Z',data:{id:'accepted-fixture',state:'accepted'}},
    ]}));
    await page.route('**/api/jobs/*',route=>route.fulfill({json:{job_digest:digest,state:'running',status:'Running',circle}}));
    await page.goto((await harness.link('lender'))+'#/request/accepted-fixture');
    await expect(page.getByRole('heading',{level:1,name:'You accepted this request.'})).toBeVisible();
    await expect(page.locator('main')).toContainText(/You accepted this at \d{1,2}:46 AM/);
    await expect(page.locator('main')).not.toContainText(/another computer|isn’t waiting for you/);
    await expect(page.getByRole('link',{name:'Open the job'})).toHaveAttribute('href','#/job/'+encodeURIComponent(digest)+'/'+circle);
  } finally {await context.close();await harness.stop();}
});

test('the request expires on the clock, without waiting for a server event', async ({browser}) => {
  test.info().annotations.push({type:'slice',description:'D-request'},{type:'check',description:'expiry-flip'});
  const harness=await startHarness(),context=await browser.newContext();
  try {
    const page=await context.newPage();
    const card=withRequestAdmission({id:'expiring-fixture',jobDigest:'sha256:'+'e'.repeat(64),job:{circle:'c1',requirements:{limits:{wall_seconds:1200}}},requester:'sender-key',requesterName:'Sam',prompt:'Fix checkout dates.',
      harness:'codex',model:[],source:{kind:'archive',size_bytes:1},runtimeSeconds:1200,expiresAt:Date.now()+2500,network:'provider-only',
      protection:{satisfied:true,enforced:[],unenforced:[]},identity:{memberPresent:true,rosterFresh:true,rootMatches:true,circleMatches:true}},admissionEvidence(Date.now()));
    // The app keeps listing the card: only the page's own clock can flip it.
    await page.route('**/api/approvals',route=>route.fulfill({json:[card]}));
    await page.goto((await harness.link('lender'))+'#/request/expiring-fixture');
    await expect(page.getByRole('button',{name:'Run it'})).toBeEnabled();
    await expect(page.locator('.rq-decide')).toContainText(/Answer within \d+ s/);
    await expect(page.locator('.rq-decide')).toContainText(/This request expired at \d{1,2}:\d{2} [AP]M\. It went back to the circle\./,{timeout:6000});
    await expect(page.getByRole('button',{name:'Run it'})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Not now'})).toHaveCount(0);
  } finally {await context.close();await harness.stop();}
});
