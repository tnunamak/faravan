import {test,expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
// `internal` is not a catalog code, so the read error uses the catalog's unknown-problem copy.
const INTERNAL_READ_COPY='Faravan could not confirm what happened. Check the current state before taking another action.';
async function expectInternalReadBanner(page){
 const banner=page.locator('.offline');
 await expect(banner).toHaveCount(1);
 await expect(banner).toContainText(INTERNAL_READ_COPY);
 await expect(banner).not.toContainText(/error 500|internal/);
 await expect(page.getByRole('alert')).toHaveCount(0);
}
async function openStream(page){
 await page.addInitScript(()=>{
  const original=window.fetch;
  window.fetch=(input,options)=>String(input).includes('/api/events')?Promise.resolve(new Response(new ReadableStream({start(controller){window.fixtureStream=controller;}}),{headers:{'content-type':'text/event-stream'}})):original(input,options);
  window.fixtureEvent=id=>window.fixtureStream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id,type:'lending',data:{status:'idle'}})+'\n\n'));
 });
}
test('dirty approvals recover independently of identical events on a healthy open stream',async({page})=>{
 await openStream(page);let reads=0;
 await page.route('**/api/approvals',route=>{reads++;return reads>=2&&reads<=3?route.fulfill({status:500,json:{code:'internal'}}):route.fulfill({json:[]});});
 await page.goto((await harness.link('lender'))+'#/home');await expect.poll(()=>reads).toBe(1);
 await page.evaluate(()=>fixtureEvent(1));await expectInternalReadBanner(page);
 await expect(page.getByLabel('Loading requests and results')).toHaveCount(0);
 await page.evaluate(()=>fixtureEvent(2));
 // Two failed reads retry after five then ten seconds; identical events do not drive recovery.
 await expect.poll(()=>reads,{timeout:20000}).toBeGreaterThanOrEqual(4);
 await expect(page.locator('.offline')).toHaveCount(0);
 await expect(page.getByLabel('Loading requests and results')).toHaveCount(0);
 expect(await page.evaluate(()=>!!window.fixtureStream)).toBe(true);
});
test('cached device data is marked stale and recovers without reconnecting',async({page})=>{
 await openStream(page);let reads=0;
 await page.route('**/api/devices',route=>{reads++;return reads>=2&&reads<=3?route.fulfill({status:500,json:{code:'internal'}}):route.fulfill({json:{ownerName:reads>2?'Mo':'Sam',name:'Laptop',circles:[]}});});
 await page.goto((await harness.link('lender'))+'#/you/profile');await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Sam');
 await page.evaluate(()=>fixtureEvent(1));await expectInternalReadBanner(page);
 await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Sam');
 await expect(page.getByLabel('Loading profile')).toHaveCount(0);
 await expect.poll(()=>reads,{timeout:20000}).toBeGreaterThanOrEqual(4);
 await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Mo');await expect(page.locator('.offline')).toHaveCount(0);
 await expect(page.getByRole('alert')).toHaveCount(0);
});
