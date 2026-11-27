import {test,expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const privateText='HTTP 409 job_deadbeef /home/private/project';

test('cold phone session loss uses catalog pairing recovery under the built CSP',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.route('**/app.mjs',route=>route.fulfill({status:401,body:privateText}));
  await page.goto(await harness.link('owner'));
  await expect(page.getByRole('heading',{name:'Reconnect to Faravan'})).toBeVisible();
  await expect(page.locator('.recovery')).toContainText('Settings → Pairing');
  await expect(page.locator('.recovery')).not.toContainText(/409|job_deadbeef|\/home\/|tray|terminal/);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('warm phone Jobs failure shows pairing once and never claims an empty list',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto((await harness.link('owner'))+'#/home');
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('.machine')).not.toContainText('Checking');
  await page.route('**/api/**',route=>route.request().method()==='GET'&&!route.request().url().includes('/api/events')?
    route.fulfill({status:401,json:{code:'unauthorized',message:privateText}}):route.fallback());
  await page.evaluate(()=>location.hash='#/jobs');
  await expect(page.locator('.offline')).toContainText('pair this device again',{timeout:20000});
  await expect(page.getByText(/This page is no longer connected to Faravan/)).toHaveCount(1);
  await expect(page.locator('#main')).not.toContainText(/No jobs yet|Run your first job|409|job_deadbeef|\/home\/private|tray|terminal/);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('a rate-limited profile save waits and never resubmits itself',async({page})=>{
  let sent=0;
  await page.route('**/api/devices',route=>route.request().method()==='POST'?
    (sent++,route.fulfill({status:429,headers:{'retry-after':'2'},json:{message:privateText}})):route.fallback());
  await page.goto((await harness.link('owner'))+'#/you/profile');
  await page.getByLabel('Your name',{exact:true}).fill('Test person');
  const save=page.getByRole('button',{name:'Save your name',exact:true});
  await save.click();
  await expect(save).toBeDisabled();
  await expect(page.locator('#main')).toContainText('Faravan is busy for a moment');
  await expect(save).toBeEnabled({timeout:6000});
  expect(sent).toBe(1);
  await expect(page.locator('#main')).not.toContainText(/409|job_deadbeef|\/home\/private/);
});
