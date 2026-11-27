import {test, expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const original={timeZone:'UTC',dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,quotaReserve:30,idleOnly:true};
async function limitsFixture(page) {
  let limits={...original}, version=0; const saves=[];
  await page.route('**/api/home',route=>route.fulfill({json:{state:'off',lending:{enabled:false,circle:'shared',mode:'ask',limits,configVersion:version}}}));
  await page.route('**/api/circles',route=>route.fulfill({json:[{id:'shared',name:'Friends',origin:'http://fixture'}]}));
  await page.route('**/api/lending/limits',async route=>{const body=route.request().postDataJSON();saves.push(body);limits={...limits,...body};version++;await route.fulfill({json:{ok:true}});});
  await page.goto((await harness.link('lender'))+'#/lend/limits');
  await page.getByLabel('Jobs a day',{exact:true}).waitFor();
  return saves;
}
test('Limits shows Save only for edits, saves hours in computer time, and keeps scroll on success',async({page})=>{
  await page.emulateMedia({colorScheme:'light'});
  const saves=await limitsFixture(page);
  await expect(page.locator('.limits-footer .limits-savebar')).toHaveCount(0);
  await page.getByRole('switch',{name:'Only lend in set hours'}).click();
  await expect(page.locator('.limits-footer .limits-savebar')).toContainText('You have unsaved changes');
  await page.getByRole('button',{name:'Save',exact:true}).scrollIntoViewIfNeeded();
  const anchor=page.getByRole('switch',{name:'Only lend in set hours'});
  const before=(await anchor.boundingBox()).y;
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.locator('.limits-status')).toHaveText('Saved.');
  await expect(page.locator('.limits-status')).toBeFocused();
  await expect(page.locator('.limits-footer .limits-savebar')).toHaveCount(0);
  // Keep the same setting in the same viewport position when the persistent
  // confirmation is inserted above it; absolute scrollY can change with layout.
  expect(Math.abs((await anchor.boundingBox()).y-before)).toBeLessThanOrEqual(2);
  expect(saves[0].timeZone).toBe(await page.evaluate(()=>Intl.DateTimeFormat().resolvedOptions().timeZone));
});
test('Limits failed save keeps edits and focuses the honest error',async({page})=>{
  await limitsFixture(page);
  await page.route('**/api/lending/limits',route=>route.fulfill({status:500,json:{code:'internal'}}));
  await page.getByLabel('Jobs a day',{exact:true}).fill('7');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  const error=page.getByRole('alert');
  await expect(error).toHaveCount(1);
  await expect(error).toContainText('Faravan could not confirm the save. Your changes are still here. Reload the saved settings before saving again.');
  await expect(error).not.toContainText('error 500');
  await expect(error).toBeFocused();await expect(page.getByLabel('Jobs a day',{exact:true})).toHaveValue('7');
});
test('Profile contains the person and computer without lending state',async({page})=>{
  let ownerName='Sam';
  await page.route('**/api/devices',route=>{
    if(route.request().method()==='POST')ownerName=route.request().postDataJSON().ownerName;
    return route.fulfill({json:{ownerName,name:'Sam’s laptop',circles:[]}});
  });
  await page.goto((await harness.link('lender'))+'#/you/profile');
  await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Sam');
  await expect(page.getByLabel('Computer name',{exact:true})).toHaveValue('Sam’s laptop');
  await expect(page.locator('.you-content')).not.toContainText('After a restart');
  await page.getByLabel('Your name',{exact:true}).fill('Mo');
  await page.getByRole('button',{name:'Save your name',exact:true}).click();
  await expect(page.locator('.notice')).toContainText('Your name was saved.');
  await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Mo');
  await expect(page.locator('.notice')).toBeFocused();
});
test('palette loads once through revision churn and hides unmatched loaded Jobs',async({page})=>{
  await page.route('**/api/circles',route=>route.fulfill({json:[{id:'shared',name:'Friends',origin:'http://fixture'}]}));
  await page.route('**/api/events**',route=>route.fulfill({contentType:'text/event-stream',body:'id: 1\ndata: {"type":"lending","data":{"ok":true}}\n\n'}));
  let jobReads=0;
  await page.route('**/api/jobs',async route=>{jobReads++;await new Promise(r=>setTimeout(r,1500));await route.fulfill({json:[{job_digest:'sha256:'+'a'.repeat(64),status:'Waiting',circle:{id:'shared',name:'Friends'},local:{title:'Fix parser'}}]}).catch(()=>{});});
  await page.goto((await harness.link('lender'))+'#/home');
  await page.getByRole('heading',{name:'What would you like to get done?',level:1,exact:true}).waitFor();
  await page.getByRole('link',{name:'Friends',exact:true}).first().waitFor();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog',{name:'Search',exact:true}).getByLabel('Loading recent jobs')).toBeVisible();
  const input=page.getByRole('combobox');await input.fill('lend');
  await expect(page.getByRole('dialog',{name:'Search',exact:true}).getByLabel('Loading recent jobs')).toHaveCount(0,{timeout:6000});
  await expect(page.getByRole('dialog',{name:'Search',exact:true}).getByRole('group',{name:'Jobs',exact:true})).toHaveCount(0);
  expect(jobReads).toBeGreaterThan(0);
});


test('a Home 500 has one catalog banner, a state check and copy details without duplicate cards',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  let reads=0, recovered=false;
  await page.route('**/api/home',route=>{reads++;return recovered?route.fallback():route.fulfill({status:500,json:{code:'internal'}});});
  await page.goto((await harness.link('lender'))+'#/home');
  const banner=page.locator('.offline');
  await expect(banner).toHaveCount(1);
  await expect(banner).toContainText('Faravan could not confirm what happened. Check the current state before taking another action.');
  await expect(banner).not.toContainText(/error 500|internal/);
  await expect(page.locator('.note')).toHaveCount(0);
  await expect(page.locator('.empty')).toHaveCount(0);
  await expect(page.locator('.you-page')).toHaveCount(0);
  await banner.getByRole('button',{name:'Copy details',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe('[{"resource":"home","code":"unknown"}]');
  const before=reads;recovered=true;
  const check=banner.getByRole('button',{name:'Check current state',exact:true});
  await expect(check).toBeEnabled();await check.click();
  await expect(banner).toHaveCount(0);
  expect(reads).toBeGreaterThan(before);
  // Action restores focus after the removal has committed, on the next animation frame (da6d41a0).
  await expect(page.getByRole('heading',{name:'What would you like to get done?',level:1,exact:true})).toBeFocused();
});

test('a failed identity read offers a state check instead of an endless profile skeleton',async({page})=>{
  let failed=true,reads=0;
  await page.route('**/api/devices',route=>{reads++;return failed?route.fulfill({status:500,json:{code:'internal'}}):route.fulfill({json:{ownerName:'Sam',name:'Sam’s laptop',circles:[]}});});
  await page.goto((await harness.link('lender'))+'#/you/profile');
  const error=page.locator('.offline');
  await expect(error).toHaveCount(1);
  await expect(error).toContainText('Faravan could not confirm what happened. Check the current state before taking another action.');
  await expect(error).not.toContainText(/error 500|internal/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Loading profile')).toHaveCount(0);
  const before=reads;failed=false;await error.getByRole('button',{name:'Check current state',exact:true}).click();
  await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Sam');
  expect(reads).toBeGreaterThan(before);
  await expect(error).toHaveCount(0);
});

