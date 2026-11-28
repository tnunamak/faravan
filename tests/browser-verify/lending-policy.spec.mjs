import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {startHarness,OUT} from './lib.mjs';
import {mockFixture,NOW} from '../../ui/v1/src/lending-policy.fixture.mjs';
import {normalizeLendingPolicy} from '../../lib/v1/lending-policy.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});

async function fixture(page) {
 let version=7,rules=[],limits={timeZone:'America/Chicago',dailyJobs:null,dailyMinutes:null,maxWallSeconds:null,quotaReserve:30,idleOnly:true,lendingPolicy:normalizeLendingPolicy({})};
 const posts={limits:[],rules:[]};
 await page.clock.setFixedTime(new Date(NOW));
 await page.route('**/api/home',r=>r.fulfill({json:{state:'ready',intent:{on:true,state:'ready'},execution:{state:'idle'},
  lending:{enabled:true,circle:'shared',mode:rules.length?'auto':'ask',standingRules:rules,limits,configVersion:version},lendingPolicy:mockFixture()}}));
 await page.route('**/api/circles',r=>r.fulfill({json:[{id:'shared',name:'Friends',origin:'http://fixture'}]}));
 await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:'me',name:'Laptop',circles:[{circle:'shared',members:[{key_id:'me',device_name:'Laptop'},{key_id:'sam',localName:'Sam'}]}]}}));
 await page.route('**/api/agents',r=>r.fulfill({json:[{id:'codex',installed:true,signedIn:true,useForLending:true}]}));
 await page.route('**/api/lending/limits',async r=>{const body=r.request().postDataJSON();normalizeLendingPolicy(body.lendingPolicy);posts.limits.push(body);const {version:_,...rest}=body;limits={...limits,...rest};version++;await r.fulfill({json:{ok:true}});});
 await page.route('**/api/lending/rules',async r=>{const body=r.request().postDataJSON();posts.rules.push(body);rules=body.rules;version++;await r.fulfill({json:{ok:true}});});
 await page.goto((await harness.link('lender'))+'#/lend/limits');
 await expect(page.getByRole('heading',{name:'What you lend',exact:true})).toBeVisible();
 return posts;
}
for(const width of [1440,390])for(const colorScheme of ['light','dark'])test(`policy save and scoped rule journey at ${width} ${colorScheme}`,async({browser})=>{
 const context=await browser.newContext({viewport:{width,height:width===1440?900:844},colorScheme}),page=await context.newPage();
 try {
  const posts=await fixture(page);
  await expect(page.locator('.preview')).toContainText('Ready to lend to a friend when a job arrives.');
  await expect(page.locator('.preview')).toContainText('You approve each job before it starts.');
  await page.screenshot({path:`${OUT}/lending-top-${width}-${colorScheme}.png`});
  await expect(page.getByRole('switch',{name:'Run friends’ jobs from Claude without asking'})).toHaveCount(0);
  await page.getByRole('radio',{name:/^Share more/}).check();
  const accountDetails=page.locator('details.allowance-readings');
  await accountDetails.locator('summary').first().click();
  await expect(accountDetails).toHaveAttribute('open','');
  const planDetails=page.locator('details.allow-plan');
  await planDetails.nth(0).locator('summary').click();
  await planDetails.nth(1).locator('summary').click();
  await page.getByLabel('Claude plan',{exact:true}).selectOption({label:'Max 20×'});
  await page.getByLabel('Codex plan',{exact:true}).selectOption({label:'Business'});
  await page.getByRole('switch',{name:'Run friends’ jobs from Codex without asking'}).check();
  await expect(page.getByLabel('Jobs a day')).toHaveValue('');
  await expect(page.getByLabel('Minutes a day')).toHaveValue('');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.locator('.limits-status')).toHaveText('Saved.');
  expect(posts.limits).toHaveLength(1);expect(posts.limits[0].version).toBe(7);
  expect(posts.limits[0].lendingPolicy).toMatchObject({strategy:'automatic',protectionPosition:'share_more',accountPlans:{claude:'max20',codex:'business'},providerConsent:{codex:true},stopOnReturn:false});
  expect(posts.limits[0].lendingPolicy).not.toHaveProperty('preset');
  expect(posts.limits[0]).toMatchObject({dailyJobs:null,dailyMinutes:null,maxWallSeconds:null});
  expect(posts.limits[0]).not.toHaveProperty('mode');expect(posts.limits[0]).not.toHaveProperty('approvalTimeoutMs');
  await page.getByRole('button',{name:'Add a rule',exact:true}).click();
  const editor=page.getByRole('group',{name:'New rule',exact:true});
  await editor.getByLabel('Sam',{exact:true}).check();
  await expect(editor.getByLabel('Codex',{exact:true})).toBeChecked();
  await editor.getByRole('button',{name:'Add rule',exact:true}).click();
  await expect(editor).toHaveCount(0);expect(posts.rules).toHaveLength(1);expect(posts.rules[0].version).toBe(8);
  expect(posts.rules[0].rules[0]).toMatchObject({circle:'shared',people:['sam'],agents:['codex']});
  await page.getByRole('button',{name:'Remove',exact:true}).click();
  await expect.poll(()=>posts.rules.length).toBe(2);expect(posts.rules[1].rules).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
 }finally{await context.close();}
});
