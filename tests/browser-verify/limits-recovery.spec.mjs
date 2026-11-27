import {test,expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
for(const committed of [true,false])test(`lost Limits response reconciles ${committed?'committed':'uncommitted'} settings`,async({page})=>{
 let limits={timeZone:'UTC',dailyJobs:null,dailyMinutes:null,maxWallSeconds:null,quotaReserve:30,idleOnly:true},version=0,posts=0,readsAfterPost=0;
 await page.route('**/api/home',route=>{if(posts)readsAfterPost++;return route.fulfill({json:{lending:{enabled:false,circle:'shared',mode:'ask',limits,configVersion:version}}});});
 await page.route('**/api/circles',route=>route.fulfill({json:[{id:'shared',name:'Friends',origin:'http://fixture'}]}));
 await page.route('**/api/lending/limits',async route=>{posts++;if(committed){limits={...limits,...route.request().postDataJSON()};version++;}await route.abort('connectionfailed');});
 await page.goto((await harness.link('lender'))+'#/lend/limits');await page.getByLabel('Jobs a day',{exact:true}).fill('7');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 if(committed){await expect(page.locator('.limits-status')).toHaveText('Saved settings checked. Your changes are saved.');await expect(page.locator('.limits-confirmation')).toBeVisible();}
 else {await expect(page.getByRole('alert')).toContainText('Current settings checked');await expect(page.getByRole('alert')).toContainText('Saved now: Balanced.');}
 expect(readsAfterPost).toBeGreaterThan(0);expect(posts).toBe(1);
 await expect(page.getByLabel('Jobs a day',{exact:true})).toHaveValue('7');
 await expect(page.locator('body')).not.toContainText('Nothing was saved');
});

test('checking an unconfirmed save holds edits until the authoritative read finishes',async({page})=>{
 let posted=false, reads=0, release;const pending=new Promise(resolve=>{release=resolve;});
 const limits={timeZone:'UTC',dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,quotaReserve:30,idleOnly:true};
 await page.route('**/api/home',async route=>{
  if(posted){reads++;if(reads===1)return route.fulfill({status:500,json:{code:'internal'}});await pending;}
  await route.fulfill({json:{lending:{enabled:false,mode:'ask',limits:{...limits,dailyJobs:posted?7:3},configVersion:posted?1:0}}}).catch(()=>{});
 });
 await page.route('**/api/lending/limits',route=>{posted=true;return route.abort('connectionfailed');});
 await page.goto((await harness.link('lender'))+'#/lend/limits');const input=page.getByLabel('Jobs a day',{exact:true});await input.fill('7');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 const check=page.getByRole('button',{name:'Check saved settings',exact:true});await expect(check).toBeVisible();await check.click();
 await expect(input).toBeDisabled();release();
 await expect(page.locator('.limits-status')).toHaveText('Saved settings checked. Your changes are saved.');
 await expect(input).toHaveValue('7');
});

test('an unreachable confirmation read times out and leaves the draft recoverable',async({page})=>{
 await page.clock.install();
 await page.addInitScript(()=>{
  const original=window.fetch;
  window.fetch=(input,options)=>window.fixtureHangReads&&String(input).includes('/api/home')?new Promise((resolve,reject)=>options.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})):original(input,options);
 });
 await page.route('**/api/home',route=>route.fulfill({json:{lending:{enabled:false,mode:'ask',limits:{timeZone:'UTC',dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,quotaReserve:30,idleOnly:true}}}}));
 await page.route('**/api/lending/limits',async route=>{await page.evaluate(()=>{window.fixtureHangReads=true;});await route.abort('connectionfailed');});
 await page.goto((await harness.link('lender'))+'#/lend/limits');const input=page.getByLabel('Jobs a day',{exact:true});await input.fill('7');await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Save not confirmed');
 await expect(input).toBeDisabled();
 await page.clock.fastForward(15001);
 await expect(input).toBeEnabled();await expect(input).toHaveValue('7');
 await expect(page.getByRole('button',{name:'Check saved settings',exact:true})).toBeVisible();
});
