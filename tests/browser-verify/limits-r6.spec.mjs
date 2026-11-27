import {test,expect} from '@playwright/test';
import {startHarness,OUT} from './lib.mjs';
import {mockFixture,NOW} from '../../ui/v1/src/lending-policy.fixture.mjs';
import {normalizeLendingPolicy} from '../../lib/v1/lending-policy.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
// r6 O12/N11: the page must be short enough to read, daily caps start empty, concurrency starts closed, and "Saved." stays until the next edit.
async function open(page) {
 let version=7,limits={timeZone:'America/Chicago',dailyJobs:null,dailyMinutes:null,maxWallSeconds:null,quotaReserve:30,idleOnly:true,lendingPolicy:normalizeLendingPolicy({})};
 await page.clock.setFixedTime(new Date(NOW));
 await page.route('**/api/home',r=>r.fulfill({json:{state:'off',lending:{enabled:false,circle:'shared',mode:'ask',standingRules:[],limits,configVersion:version},lendingPolicy:{...mockFixture(),machineCapacity:12}}}));
 await page.route('**/api/circles',r=>r.fulfill({json:[{id:'shared',name:'Friends',origin:'http://fixture'}]}));
 await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:'me',name:'Laptop',circles:[{circle:'shared',members:[{key_id:'me',device_name:'Laptop'}]}]}}));
 await page.route('**/api/agents',r=>r.fulfill({json:[]}));
 await page.route('**/api/lending/limits',async r=>{const body=r.request().postDataJSON();const {version:_,...rest}=body;limits={...limits,...rest};version++;await r.fulfill({json:{ok:true}});});
 await page.goto((await harness.link('lender'))+'#/lend/limits');
 await expect(page.getByRole('heading',{name:'What you lend',exact:true})).toBeVisible();
}
test('desktop Limits is short, daily caps start empty and concurrency starts closed',async({browser})=>{
 const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
 try {
  await open(page);
  const height=await page.evaluate(()=>document.documentElement.scrollHeight);
  await page.screenshot({path:`${OUT}/limits-r6-full-1440.png`,fullPage:true});
  expect(height).toBeLessThan(2800);
  await expect(page.getByLabel('Jobs a day',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('Minutes a day',{exact:true})).toHaveValue('');
  await page.getByLabel('Minutes a day',{exact:true}).fill('600');
  expect(await page.getByLabel('Minutes a day',{exact:true}).evaluate(el=>{
   const style=getComputedStyle(el),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
   ctx.font=style.font;
   return ctx.measureText(el.value).width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)<=el.clientWidth;
  })).toBe(true);
  for(const line of await page.locator('.limits-form .line:has(>.num)').all()){
   const field=await line.locator('>.num').boundingBox(),suffixLocator=line.locator('>span.t-2');
   if(await suffixLocator.count()) {
    const suffix=await suffixLocator.boundingBox();
    expect(field.x+field.width).toBeLessThanOrEqual(suffix.x);
   }
  }
  await expect(page.locator('details.concurrency')).not.toHaveAttribute('open','');
  await expect(page.getByLabel('Jobs per account',{exact:true})).toBeHidden();
  await expect(page.locator('details.concurrency summary')).toContainText('At the same time: 1 per account (up to 12 on your computer)');
  await page.locator('details.concurrency summary').click();
  await expect(page.getByLabel('Jobs per account',{exact:true})).toBeVisible();
 }finally{await context.close();}
});
test('Saved. stays on screen until the next edit',async({browser})=>{
 const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
 try {
  await open(page);
  await page.getByLabel('Jobs a day',{exact:true}).fill('5');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.locator('.limits-status')).toHaveText('Saved.');
  await page.waitForTimeout(3500);
  await expect(page.locator('.limits-status')).toHaveText('Saved.');
  await page.getByLabel('Jobs a day',{exact:true}).fill('6');
  await expect(page.locator('.limits-status')).toHaveText('You have unsaved changes');
 }finally{await context.close();}
});
