import {test,expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const circle={id:'people-circle',name:'Weekend projects',origin:'https://fixture.test',owned:true};
const computer={key_id:'test-computer',device_name:'Travel laptop'};
test('failed supplemental history keeps identity and access controls available',async({page})=>{
 await page.route('**/api/circles',route=>route.fulfill({json:[circle]}));
 await page.route('**/api/devices',route=>route.fulfill({json:{fingerprint:'self',circles:[{circle:circle.id,members:[computer]}]}}));
 await page.route('**/api/circles/'+circle.id+'/people',route=>route.fulfill({json:[{personId:computer.key_id,name:'Morgan',role:'member',blocked:false,computers:[computer]}]}));
 await page.route('**/api/jobs?circle='+circle.id,route=>route.fulfill({status:503,json:{code:'unavailable'}}));
 await page.goto((await harness.link('owner'))+'#/person/'+computer.key_id+'/'+circle.id);
 await expect(page.getByRole('heading',{name:'Morgan',exact:true})).toBeVisible();
 await expect(page.locator('h1')).toHaveCount(1);
 await expect(page.getByRole('button',{name:'Block person',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Edit device limits',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Asked for',exact:true})).toBeVisible();
 await expect(page.getByText('Job history is unavailable. Access controls are still available.',{exact:true}).first()).toBeVisible();
 const {mkdir}=await import('node:fs/promises');
 const out=process.env.CIRCLES_PEOPLE_SCREENSHOTS??'test-artifacts/people-screenshots';await mkdir(out,{recursive:true});
 for(const [width,height,size] of [[1440,900,'desktop'],[390,844,'phone']])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
  await page.screenshot({path:out+'/person-'+size+'-'+theme+'.png',fullPage:true,animations:'disabled'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 }

});
test('a person URL for a forgotten circle offers a way back instead of loading forever',async({page})=>{
 await page.route('**/api/circles',route=>route.fulfill({json:[]}));
 await page.goto((await harness.link('owner'))+'#/person/missing/forgotten');
 await expect(page.getByRole('heading',{name:'Circle unavailable',exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'Your circles',exact:true})).toBeVisible();
 await expect(page.getByText('Loading member…',{exact:true})).toHaveCount(0);
});

test('person-first member list shows verified computers at desktop and phone sizes',async({page})=>{
 const {mkdir}=await import('node:fs/promises');
 const out=process.env.CIRCLES_PEOPLE_SCREENSHOTS??'test-artifacts/people-screenshots';await mkdir(out,{recursive:true});
 const computers=[{key_id:'self',device_name:'Circle host'},{key_id:'laptop',device_name:'Travel laptop',localName:'Morgan'},{key_id:'desktop',device_name:'Office desktop',person_id:'laptop'}];
 await page.route('**/api/circles',route=>route.fulfill({json:[circle]}));
 await page.route('**/api/devices',route=>route.fulfill({json:{fingerprint:'self',circles:[{circle:circle.id,members:computers}]}}));
 await page.route('**/api/circles/'+circle.id+'/people',route=>route.fulfill({json:[{personId:'self',role:'owner',computers:[computers[0]]},{personId:'laptop',role:'member',computers:computers.slice(1)}]}));
 await page.route('**/api/circles/'+circle.id+'/approvals',route=>route.fulfill({json:[]}));
 await page.goto((await harness.link('owner'))+'#/circle/'+circle.id);
 await expect(page.getByRole('list',{name:'People in this circle'})).toBeVisible();
 await expect(page.getByRole('list',{name:'Computers for Morgan'}).locator('li')).toHaveCount(2);
 for(const [width,height,size] of [[1440,900,'desktop'],[390,844,'phone']])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
  await page.screenshot({path:out+'/members-'+size+'-'+theme+'.png',fullPage:true,animations:'disabled'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 }
});
