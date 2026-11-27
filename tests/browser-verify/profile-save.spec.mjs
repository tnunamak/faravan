import {test, expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
test('a saved profile name stays visible while the identity refresh is delayed',async({page})=>{
  let ownerName='Sam', saved=false;
  await page.route('**/api/devices',async route=>{
    if(route.request().method()==='POST'){ownerName=route.request().postDataJSON().ownerName;saved=true;}
    else if(saved)await new Promise(resolve=>setTimeout(resolve,2500));
    await route.fulfill({json:{ownerName,name:'Sam’s laptop',circles:[]}}).catch(()=>{});
  });
  await page.goto((await harness.link('lender'))+'#/you/profile');
  const name=page.getByLabel('Your name',{exact:true});await expect(name).toHaveValue('Sam');
  await name.fill('Mo');await page.getByRole('button',{name:'Save your name',exact:true}).click();
  await expect(page.locator('.notice')).toHaveText('Your name was saved.');
  expect(await name.inputValue()).toBe('Mo');
  await expect(page.getByRole('button',{name:'Save your name',exact:true})).toHaveCount(0);
});


test('You is the only profile editor and Manage devices opens the computer list',async({page})=>{
  await page.route('**/api/devices',route=>route.fulfill({json:{ownerName:'Sam',name:'Sam’s laptop',circles:[]}}));
  await page.goto((await harness.link('lender'))+'#/you');
  await expect(page.getByLabel('Your name',{exact:true})).toHaveCount(1);
  await expect(page.getByLabel('Computer name',{exact:true})).toHaveCount(1);
  await page.getByRole('link',{name:'Manage devices',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Devices',level:1,exact:true})).toBeVisible();
  await expect(page.locator('main input')).toHaveCount(0);
  await expect(page.locator('main')).toContainText('Sam’s laptop');
});
