import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture} from '../helpers/v1-app-fixture.mjs';

async function routePrivateAssets(page) {
  if (!process.env.RELEASE_A11Y_ASSET_DIR) return;
  const [module, css] = await Promise.all(['app.mjs','app.css'].map(name => readFile(join(process.env.RELEASE_A11Y_ASSET_DIR,name))));
  await page.route('**/app.mjs', route => route.fulfill({status:200,contentType:'text/javascript',body:module}));
  await page.route('**/app.css', route => route.fulfill({status:200,contentType:'text/css',body:css}));
}

test('mounted request keeps its countdown hidden from the accessibility tree', async ({browser}) => {
  const cleanup = [];
  const fixture = await appFixture({after:fn => cleanup.push(fn)});
  const lender = await fixture.start('lender');
  const context = await browser.newContext({viewport:{width:1280,height:800}});
  const page = await context.newPage();
  const card = {
    id:'release-a11y-request',jobDigest:'sha256:'+'a'.repeat(64),requester:'fixture-sender',requesterName:'Example Member',
    prompt:'Review the synthetic release fixture.',harness:'codex',model:[],source:{kind:'none'},runtimeSeconds:1200,
    expiresAt:Date.now()+120_000,network:'provider-only',protection:{satisfied:true,enforced:[],unenforced:[]},
    identity:{memberPresent:true,rosterFresh:true,rootMatches:true,circleMatches:true},
    job:{circle:'fixture-circle',requirements:{limits:{wall_seconds:1200}}},
    requestAdmission:{schemaVersion:2,kind:'request-admission',admission:'allowed',reasonCode:null,evidence:{jobCap:null,minuteCap:null}},
  };
  await routePrivateAssets(page);
  await page.route('**/api/approvals', route => route.fulfill({json:[card]}));
  try {
    await page.goto(lender.app.url+'#/request/release-a11y-request');
    const countdown = page.locator('.rq-clock span[aria-hidden="true"]');
    await expect(countdown).toBeAttached();
    await expect(countdown).toHaveAttribute('aria-hidden','true');
    await expect(countdown).toBeVisible();
  } finally {
    await context.close();
    await Promise.all(cleanup.reverse().map(fn => fn()));
  }
});

test('project picker Home and End focus the first and last rows, with arrows and Enter intact', async ({page}) => {
  const cleanup = [];
  const fixture = await appFixture({after:fn => cleanup.push(fn)});
  const owner = await fixture.start('owner');
  try {
    await routePrivateAssets(page);
    await page.route('**/api/folders/suggest', route => route.fulfill({json:{recent:[
      {path:'/home/fixture/first',name:'first',branch:'main'},
      {path:'/home/fixture/last',name:'last',branch:'main'},
    ],repos:[],truncated:false}}));
    await page.goto(owner.app.url+'#/new');
    if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
    await page.getByRole('button',{name:'Choose…',exact:true}).click();
    const picker = page.getByRole('dialog',{name:'Choose a project'});
    const rows = picker.locator('[data-picker-row]');
    await expect(rows).toHaveCount(2);
    const first = rows.nth(0), last = rows.nth(1);
    await first.focus();
    await page.keyboard.press('End');
    await expect(last).toBeFocused();
    await page.keyboard.press('Home');
    await expect(first).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(last).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
  } finally {
    await Promise.all(cleanup.reverse().map(fn => fn()));
  }
});
