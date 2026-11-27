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
test('clean Limits does not intercept clicks on controls underneath its reserved footer',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
  await limitsFixture(page);
  const target=page.getByLabel('Minutes a day',{exact:true});
  await target.evaluate(el=>{const box=el.getBoundingClientRect();scrollBy(0,box.y+box.height/2-(innerHeight-150));});
  const box=await target.boundingBox();
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await expect(target).toBeFocused();
  await context.close();
});

test('What you lend controls stay within narrow screens with enlarged text',async({browser})=>{
  for(const [width,enlarged] of [[320,false],[390,true]]){
    const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage();
    await limitsFixture(page);
    if(enlarged)await page.evaluate(()=>{document.documentElement.style.fontSize='130%';});
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    const control=page.getByLabel('Jobs a day',{exact:true}),box=await control.boundingBox();
    expect(box.x+box.width).toBeLessThanOrEqual(width);
    await context.close();
  }
});

test('phone Save controls and confirmation stay above the tab bar',async({page})=>{
 await page.setViewportSize({width:390,height:844});await limitsFixture(page);
 await page.getByLabel('Minutes a day',{exact:true}).fill('65');
 const bar=page.locator('.limits-savebar');await expect(bar).toContainText('Save');
 const aboveNav=async()=>{
  const footer=await bar.boundingBox(),nav=await page.locator('.tabbar').boundingBox();
  expect(footer.y+footer.height).toBeLessThanOrEqual(nav.y-8);
 };
 await aboveNav();await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(bar).toContainText('Saved.');await aboveNav();
 await page.waitForTimeout(3000);await expect(bar).toContainText('Saved.');
});
