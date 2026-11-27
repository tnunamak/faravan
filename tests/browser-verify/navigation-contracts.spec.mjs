import {test,expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const circles=[{id:'local',name:'My devices',owned:true},{id:'shared',name:'Friends',owned:true,origin:'http://fixture'}];
test('retired information pages and old tray entry routes lead to canonical screens',async({page})=>{
 await page.goto((await harness.link('lender'))+'#/you');
 for(const [hash,title] of [['#/activity','Jobs'],['#/trust',null],['#/review','What would you like to get done?'],['#/watch','Jobs'],['#/settings','You']]){
  await page.evaluate(hash=>{location.hash=hash;},hash);
  if(title)await expect(page.getByRole('heading',{level:1,name:title,exact:true})).toBeVisible();else await expect(page.getByRole('heading',{level:1}).first()).toBeVisible();
 }
 await expect(page.getByRole('link',{name:'How lending works',exact:true})).toHaveCount(0);
 await expect(page.locator('a[href="#/activity"]')).toHaveCount(0);
});
test('local-only circles are absent from sidebar and palette destinations',async({page})=>{
 await page.route('**/api/circles',route=>route.fulfill({json:circles}));await page.route('**/api/jobs',route=>route.fulfill({json:[]}));
 await page.goto((await harness.link('lender'))+'#/home');await page.locator('aside a[href="#/circle/shared"]').waitFor();
 await expect(page.locator('aside a[href="#/circle/local"]')).toHaveCount(0);
 await page.keyboard.press('Control+k');await page.getByRole('combobox').fill('My devices');
 await expect(page.getByRole('dialog',{name:'Search',exact:true}).getByRole('option')).toHaveCount(0);
});
test('palette and Shift+P open the same pause choices before any write',async({page})=>{
 let posts=[];
 await page.route('**/api/circles',route=>route.fulfill({json:circles}));
 await page.route('**/api/home',route=>route.fulfill({json:{state:'on',intent:{state:'ready'},execution:{state:'idle'},lending_blockers:null,lending:{enabled:true,status:'idle',circle:'shared',limits:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,quotaReserve:30}}}}));
 await page.route('**/api/lending/pause',route=>{posts.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});});
 await page.goto((await harness.link('lender'))+'#/home');await page.locator('aside a[href="#/circle/shared"]').waitFor();
 await page.keyboard.press('Control+k');await page.getByRole('combobox').fill('pause');await page.getByRole('option',{name:'Pause lending',exact:true}).waitFor();await page.keyboard.press('Enter');
 const sheet=page.getByRole('dialog',{name:'Pause new jobs',exact:true});await expect(sheet).toBeVisible();expect(posts).toHaveLength(0);
 await sheet.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.keyboard.press('Shift+P');await expect(sheet).toBeVisible();expect(posts).toHaveLength(0);
 await sheet.getByRole('button',{name:'For 1 hour',exact:true}).click();await expect.poll(()=>posts.length).toBe(1);expect(posts[0].circle).toBe('shared');expect(posts[0].until).toBeTruthy();
});
