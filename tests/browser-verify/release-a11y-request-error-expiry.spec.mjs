import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture} from '../helpers/v1-app-fixture.mjs';

const assetDir = process.env.RELEASE_A11Y_ASSET_DIR;

for (const control of ['Run it', 'Not now']) test(`an expired request takes focus from ${control} after an answer error`, async ({browser}) => {
  const run = await startRequest(browser);
  try {
    await run.page.route('**/api/approvals/release-error-expiry/accept', route =>
      route.fulfill({status:503, json:{code:'operation_failed'}}));
    await run.page.getByRole('button', {name:'Run it', exact:true}).focus();
    await run.page.keyboard.press('Enter');
    await expect(run.page.locator('.rq-answer-error')).toBeVisible();

    const focusedControl = run.page.getByRole('button', {name:control, exact:true});
    await focusedControl.focus();
    await expect(focusedControl).toBeFocused();
    await run.page.clock.pauseAt(new Date(run.card.expiresAt - 1_000));
    await run.page.clock.runFor(2_500);

    const notice = run.page.locator('.rq-decide .rq-state');
    await expect(notice).toContainText('This request expired');
    await expect(notice).toBeFocused();
    await expect(notice).toBeVisible();
    await expect(notice).toBeInViewport({ratio:1});
  } finally {
    await run.context.close();
    await Promise.all(run.cleanup.reverse().map(fn => fn()));
  }
});

test('expiry preserves focus outside the decision area after an answer error', async ({browser}) => {
  const run = await startRequest(browser);
  try {
    await run.page.route('**/api/approvals/release-error-expiry/accept', route =>
      route.fulfill({status:503, json:{code:'operation_failed'}}));
    await run.page.getByRole('button', {name:'Run it', exact:true}).focus();
    await run.page.keyboard.press('Enter');
    await expect(run.page.locator('.rq-answer-error')).toBeVisible();

    const outsideFocus = run.page.locator('.tabbar a[href="#/home"]');
    await outsideFocus.focus();
    await expect(outsideFocus).toBeFocused();
    await run.page.clock.pauseAt(new Date(run.card.expiresAt - 1_000));
    await run.page.clock.runFor(2_500);

    await expect(run.page.locator('.rq-decide .rq-state')).toContainText('This request expired');
    await expect(outsideFocus).toBeFocused();
  } finally {
    await run.context.close();
    await Promise.all(run.cleanup.reverse().map(fn => fn()));
  }
});

async function startRequest(browser) {
  const cleanup = [];
  const fixture = await appFixture({after:fn => cleanup.push(fn)});
  const lender = await fixture.start('lender');
  const context = await browser.newContext({viewport:{width:390,height:844}, colorScheme:'light'});
  const page = await context.newPage();
  const expiresAt = Date.now() + 120_000;
  const card = {
    id:'release-error-expiry', jobDigest:'sha256:'+'a'.repeat(64), requester:'fixture-sender', requesterName:'Example Member',
    prompt:'Review the synthetic release fixture.', harness:'codex', model:[], source:{kind:'none'}, runtimeSeconds:1200,
    expiresAt, network:'provider-only', protection:{satisfied:true,enforced:[],unenforced:[]},
    identity:{memberPresent:true,rosterFresh:true,rootMatches:true,circleMatches:true},
    job:{circle:'fixture-circle',requirements:{limits:{wall_seconds:1200}}},
    requestAdmission:{schemaVersion:2,kind:'request-admission',admission:'allowed',reasonCode:null,
      evidence:{jobCap:null,minuteCap:null}},
  };
  if (assetDir) {
    const [module, css] = await Promise.all(['app.mjs','app.css'].map(name => readFile(join(assetDir,name))));
    await page.route('**/app.mjs', route => route.fulfill({status:200,contentType:'text/javascript',body:module}));
    await page.route('**/app.css', route => route.fulfill({status:200,contentType:'text/css',body:css}));
  }
  await page.route('**/api/approvals', route => route.fulfill({json:[card]}));
  await page.route('**/api/devices', async route => {
    const response = await route.fetch(), data = await response.json();
    await route.fulfill({response,json:{...data,name:'Fixture Computer',ownerName:'Fixture Owner'}});
  });
  await page.clock.install({time:new Date()});
  await page.goto(lender.app.url+'#/request/release-error-expiry');
  await expect(page.getByRole('button',{name:'Run it'})).toBeVisible();
  return {page,context,cleanup,card};
}
