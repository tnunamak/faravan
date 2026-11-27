import {test, expect} from '@playwright/test';
import {startHarness} from './lib.mjs';

let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});

test('the shared Shell frame gives pages a 610px reading width and keeps phone gutters',async({page})=>{
 await page.setViewportSize({width:1440,height:900});
 await page.goto((await harness.link('lender'))+'#/home');
 await expect(page.locator('.page-head')).toBeVisible();
 const desktop=await page.evaluate(()=>{
  const measure=selector=>{
   const element=document.querySelector(selector), style=getComputedStyle(element), rect=element.getBoundingClientRect();
   return {frame:rect.width,content:rect.width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)};
  };
  return {page:measure('.main>.page'),head:measure('.main>.page-head')};
 });
 expect(desktop.page).toEqual({frame:722,content:610});
 expect(desktop.head).toEqual({frame:722,content:610});

 await page.setViewportSize({width:390,height:844});
 const phone=await page.locator('.main>.page').evaluate(element=>{
  const style=getComputedStyle(element),rect=element.getBoundingClientRect();
  return {frame:rect.width,padding:parseFloat(style.paddingLeft),content:rect.width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)};
 });
 expect(phone).toEqual({frame:390,padding:16,content:358});
});
