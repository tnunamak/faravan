import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {startHarness,patchJson} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});

test('Mac login choice saves, reverses and keeps lending independent',async({page})=>{
  let enabled=false;const writes=[];
  await patchJson(page,'**/api/home',body=>({...body,desktop:{...body.desktop,platform:'mac',autostart:{supported:true,available:true,enabled,needsRepair:false}}}));
  await page.route('**/api/desktop/autostart',async route=>{
    enabled=route.request().postDataJSON().enabled;writes.push(enabled);
    await route.fulfill({json:{supported:true,available:true,enabled,needsRepair:false}});
  });
  await page.goto((await harness.link('lender'))+'#/you/profile');
  await expect(page.getByRole('button',{name:'Turn on launch at login',exact:true})).toBeVisible();
  await expect(page.getByText('Lending follows your existing choice.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Turn on launch at login',exact:true}).click();
  await expect(page.getByRole('button',{name:'Turn off launch at login',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Turn off launch at login',exact:true}).click();
  await expect(page.getByRole('button',{name:'Turn on launch at login',exact:true})).toBeVisible();
  expect(writes).toEqual([true,false]);
  await mkdir('test-artifacts/browser-verify/macos',{recursive:true});
  for(const colorScheme of ['light','dark'])for(const [width,height]of [[1440,900],[390,844]]){
    await page.emulateMedia({colorScheme});await page.setViewportSize({width,height});
    await page.screenshot({path:`test-artifacts/browser-verify/macos/profile-${width}-${colorScheme}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  }
});
