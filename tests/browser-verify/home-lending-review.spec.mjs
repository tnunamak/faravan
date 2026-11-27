import {test,expect} from '@playwright/test';
import {patchHome,startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
async function fixture(page,{result=false,usedJobs=0,approvals=[]}={}) {
 const circle={id:'shared',name:'Weekend projects',origin:'http://fixture'};
 await patchHome(page,{effective:{intent:{on:false,state:'off'},execution:{state:'idle'},version:'fixture-v2'},dailyLimitReached:usedJobs>=6},body=>({...body,lending_blockers:null,intent:{on:false,state:'off'},execution:{state:'idle'},lending:{...body.lending,enabled:false,circle:'shared',status:'idle',limits:{...body.lending?.limits,dailyJobs:6}},today:{...body.today,jobs:usedJobs,jobLimit:6}}));
 await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
 await page.route('**/api/agents',r=>r.fulfill({json:[{id:'claude-code-subscription',installed:true,signedIn:null,useForLending:true},{id:'codex',installed:true,signedIn:null,useForLending:true}]}));
 await page.route('**/api/readiness',r=>r.fulfill({json:{ready:true,checks:[]}}));
 await page.route('**/api/approvals',r=>r.fulfill({json:approvals}));
 await page.route('**/api/jobs/result/receipt?circle=shared',r=>r.fulfill({json:{receipt:{candidate_format:'diff',diffstat:{files:1,insertions:1,deletions:1}},checks:[]}}));
 await page.route('**/api/jobs',r=>r.fulfill({json:result?[{job_digest:'result',role:'sent',state:'result-accepted',status:'Finished',local:{title:'Fix the tests'},circle}]:[]}));
}
test('Home keeps agent checks without duplicate shell header actions',async({page})=>{
 await fixture(page);await page.goto((await harness.link('lender'))+'#/home');
 await expect(page.getByRole('heading',{level:1,name:'What would you like to get done?'})).toBeVisible();
 await expect(page.locator('.page-head .page-sub')).toHaveCount(0);
 await expect(page.locator('.page-head .btn')).toHaveCount(0);
 await expect(page.locator('.phone-action')).toHaveCount(0);
 for(const name of ['Check Claude Code','Check Codex']) {
  await expect(page.getByRole('button',{name,exact:true})).toHaveCount(1);
  await expect(page.locator('section[aria-labelledby=home-needs]').getByRole('button',{name,exact:true})).toBeVisible();
 }
 await expect(page.locator('.home-lending-card')).toContainText('No new jobs start on this computer.');
 await expect(page.locator('.home-lending-card button')).toHaveCount(0);
 await expect(page.locator('.home-lending-card a[href="#/lend"]')).toHaveCount(1);
});
test('Home removes the duplicate shell summary and keeps the composer before the feed',async({page})=>{
 await fixture(page);await page.goto((await harness.link('lender'))+'#/home');
 await expect(page.getByRole('heading',{level:1,name:'What would you like to get done?'})).toBeVisible();
 await expect(page.locator('.page-head .page-sub')).toHaveCount(0);
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:900});
  const layout=await page.evaluate(()=>{const box=selector=>{const {top,bottom}=document.querySelector(selector).getBoundingClientRect();return {top,bottom};};return {heading:box('.page-head'),composer:box('.home-compose-entry'),status:box('.home-lending-line'),needs:box('section[aria-labelledby=home-needs]')};});
  expect(layout.composer.top).toBeGreaterThanOrEqual(layout.heading.bottom);
  expect(layout.status.top).toBeGreaterThan(layout.composer.bottom);
  expect(layout.needs.top).toBeGreaterThan(layout.status.bottom);
 }
});
test('Home request card leads with signed identity, deadline, metadata and preserved actions',async({page})=>{
 const expiresAt=Date.now()+3600000;
 const prompt='Fix the login loop and add a regression test.';
 const approval={id:'home-decision',requester:'remote-sam',requesterName:'Sam',prompt,harness:'codex',model:[],
  source:{kind:'archive',file_count:2,size_bytes:128},runtimeSeconds:1200,expiresAt,network:'provider-only',
  protection:{satisfied:true},identity:{memberPresent:true,rosterFresh:true,rootMatches:true,circleMatches:true,
   requesterName:'Sam',personName:'Sam'},job:{circle:'shared',requirements:{network:'provider-only',limits:{wall_seconds:1200}}}};
 await fixture(page,{approvals:[approval]});await page.goto((await harness.link('lender'))+'#/home');
 const card=page.locator('article.home-request');
 await expect(card).toBeVisible();
 await expect(page.getByRole('heading',{level:1,name:'What would you like to get done?'})).toBeVisible();
 await expect(page.getByRole('heading',{level:1,name:'Home',exact:true})).toHaveCount(0);
 await expect(page.locator('.page-head .page-sub')).toHaveCount(0);
 await expect(page.locator('.page-head .btn')).toHaveCount(0);
 await expect(page.getByLabel('Request notifications')).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Getting started'})).toHaveCount(0);
 await expect(card.locator('.swing-item-byline')).toContainText('Sam asked to use your computer');
 await expect(card.locator('.av')).toHaveText('S');
 await expect(card.getByRole('heading',{level:2,name:prompt})).toBeVisible();
 const expectedDeadline=await page.evaluate(at=>'Answer by '+new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit'}).format(at),expiresAt);
 await expect(card.locator('.swing-chip')).toHaveText(expectedDeadline);
 const meta=card.locator('.swing-item-meta');
 await expect(meta).toContainText('Codex');await expect(meta).toContainText('Up to 20 min');
 await expect(meta).toContainText('2 project files · 128 B');await expect(meta).toContainText('AI provider only');
 const details=card.locator('details');await expect(details.locator('summary')).toHaveText('Safety details');
 await details.locator('summary').click();await expect(details.locator('li').first()).toBeVisible();

 for(const width of [1440,390]){
  await page.setViewportSize({width,height:900});
  const contentWidth=await page.locator('.home-page').evaluate(el=>el.getBoundingClientRect().width);
  expect(contentWidth).toBe(width===1440?610:358);
  await expect(card).toBeVisible();
  if(width===390){
   const order=await page.evaluate(()=>({request:document.querySelector('.home-request').getBoundingClientRect().bottom,
    motion:document.querySelector('#home-motion').getBoundingClientRect().top}));
   expect(order.request).toBeLessThan(order.motion);
  }
 }
 const notNow=card.getByRole('button',{name:'Not now',exact:true});
 await notNow.click();await expect(card.locator('p[role="status"]')).toContainText('Still pending');
 await expect(card.getByRole('link',{name:/Review request/})).toHaveAttribute('href','#/request/home-decision');
});
test('Home preview settles to a real file summary and is cached across navigation',async({page})=>{
 await fixture(page,{result:true});let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});
 await page.route('**/api/jobs/result/changes?circle=shared',async r=>{calls++;await gate;return r.fulfill({json:{format:'diff',files:[{path:'test.js'}],diffstat:{files:1,insertions:1,deletions:1},diff:''}});});
 await page.goto((await harness.link('lender'))+'#/home');
 await expect(page.locator('.result-card')).toContainText('1 file changed, +1 −1');
 await expect(page.locator('.result-card')).not.toContainText('Loading changes preview');
 release();await expect(page.locator('.result-card')).toContainText('1 file changed, +1 −1');
 await page.evaluate(()=>location.hash='#/lend');await expect(page.locator('.lending-page')).toBeVisible();
 await page.evaluate(()=>location.hash='#/home');await expect(page.locator('.result-card')).toContainText('1 file changed, +1 −1');expect(calls).toBe(1);
});
test('a failed Home preview uses its signed receipt summary without a loading line',async({page})=>{
 await fixture(page,{result:true});await page.route('**/api/jobs/result/changes?circle=shared',r=>r.abort('failed'));
 await page.goto((await harness.link('lender'))+'#/home');await expect(page.locator('.result-card')).toContainText('1 file changed, +1 −1');
 await expect(page.locator('.result-card')).not.toContainText('Loading changes preview');await expect(page.locator('.result-card').getByRole('link',{name:'Review',exact:true})).toBeVisible();
});
test('Lending groups unchecked agents in one hero action and a single evidenced meter fills the row',async({page})=>{
 await fixture(page,{usedJobs:1});const calls=[];
 await page.route('**/api/agents/refresh',r=>{calls.push(r.request().postDataJSON());return r.fulfill({json:[{id:'claude-code-subscription',installed:true,signedIn:true,useForLending:true},{id:'codex',installed:true,signedIn:false,useForLending:true}]});});
 await page.goto((await harness.link('lender'))+'#/lend');
 const action=page.locator('.hero button.btn-primary');await expect(action).toHaveText('Check agents');
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:900});
  const layout=await page.evaluate(()=>{const hero=document.querySelector('.hero').getBoundingClientRect(),button=document.querySelector('.hero button.btn-primary').getBoundingClientRect(),meters=document.querySelector('.hero .meters').getBoundingClientRect(),meter=document.querySelector('.hero .meters>div').getBoundingClientRect();return {below:hero.bottom-button.bottom,meter:meter.width,all:meters.width};});
  expect(layout.below).toBeLessThanOrEqual(17);expect(layout.meter).toBeGreaterThanOrEqual(layout.all-1);
 }
 await action.click();
 await expect.poll(()=>calls).toEqual([{agents:['claude-code-subscription','codex']}]);
});

test('a timed-out Home preview can retry on a later visit',async({page})=>{
 await fixture(page,{result:true});let calls=0;
 await page.route('**/api/jobs/result/changes?circle=shared',async r=>{
  if(++calls===1){await new Promise(resolve=>setTimeout(resolve,11000));return r.abort().catch(()=>{});}
  return r.fulfill({json:{format:'diff',files:[{path:'test.js'}],diffstat:{files:1,insertions:1,deletions:1},diff:''}});
 });
 await page.goto((await harness.link('lender'))+'#/home');await expect.poll(()=>calls).toBe(1);
 await page.waitForTimeout(10500);await expect(page.locator('.result-card')).toContainText('1 file changed, +1 −1');
 await page.evaluate(()=>location.hash='#/lend');await expect(page.locator('.lending-page')).toBeVisible();
 await page.evaluate(()=>location.hash='#/home');await expect(page.locator('.result-card')).toContainText('1 file changed, +1 −1');await expect.poll(()=>calls).toBe(2);
});
test('the Home composer saves the task before opening the new-job form on phone and desktop',async({page})=>{
 await fixture(page);
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:900});await page.goto((await harness.link('lender'))+'#/home');
  await expect(page.getByRole('heading',{level:1,name:'What would you like to get done?'})).toBeVisible();
  const prompt=page.getByRole('textbox',{name:'What would you like to get done?'});
  await expect(prompt).toBeVisible();
  await prompt.fill('Write a parser regression test');
  await page.locator('.home-compose-entry').getByRole('button',{name:'Continue to job'}).click();
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.getByRole('textbox',{name:'What the agent should do'})).toHaveValue('Write a parser regression test');
  await expect(page.getByText('Ask for help',{exact:false})).toHaveCount(0);
 }
});
