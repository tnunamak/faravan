import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const digest='sha256:'+'a'.repeat(64);
async function offerFixture(page,{legacy=false}={}){
 const card={id:'offer-1',offer:!legacy,legacyHold:legacy,jobDigest:digest,requester:'sam',requesterName:'Sam',prompt:'Fix the login loop and add a regression test.',harness:'codex',model:[],runtimeSeconds:1200,source:{kind:'archive',size_bytes:1024},network:'provider-only',protection:{satisfied:true,enforced:[],unenforced:[]},identity:{memberPresent:true,rosterFresh:true,rootMatches:true,circleMatches:true},expiresAt:Date.now()+(legacy?60000:86400000),job:{circle:'shared',created_at:new Date().toISOString(),requirements:{egress:'provider-only',limits:{wall_seconds:1200}}}};
 for(const [path,json] of Object.entries({circles:[{id:'shared',name:'Weekend projects'}],agents:[{id:'codex',installed:true,signedIn:true,useForLending:true}],readiness:{ready:true,checks:[]},approvals:[card],devices:{name:'Tessa’s computer',fingerprint:'tessa',circles:[]},jobs:[],home:{intent:{on:true,state:'ready'},execution:{state:'idle'},lending:{enabled:true,circle:'shared',current:null,status:'offer',mode:'ask'},needs_you:[{kind:'approval',approvalId:'offer-1'}]}}))await page.route('**/api/'+path,r=>r.fulfill({json}));
}
async function expectReviewDisclosures(page){
 const protections=page.locator('.rq-more summary').filter({hasText:'Protection details'});
 const details=page.locator('.rq-more summary').filter({hasText:/^Details$/});
 await protections.focus();await page.keyboard.press('Enter');
 await expect(page.getByText('Checked again right before the job starts.')).toBeVisible();
 await page.keyboard.press('Enter');
 await expect(page.getByText('Checked again right before the job starts.')).toBeHidden();
 await details.focus();await page.keyboard.press('Enter');
 await expect(page.locator('.rq-more').getByText('Weekend projects',{exact:true})).toBeVisible();
}

for(const [size,viewport] of Object.entries({desktop:{width:1440,height:900},phone:{width:390,height:844}}))for(const theme of ['light','dark'])test(`offer review ${size} ${theme}`,async({page})=>{
 await page.setViewportSize(viewport);await page.emulateMedia({colorScheme:theme});await offerFixture(page);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto((await harness.link('lender'))+'#/request/offer-1');
 await expect(page.getByRole('heading',{level:1})).toHaveText('Sam wants to run a job on your computer (Tessa’s computer)');
 await expect(page.getByRole('button',{name:'Run it',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'Not now',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Decline',exact:true})).toBeVisible();await expect(page.locator('.rq-clock')).toContainText('Open until');await expect(page.locator('.rq-clock')).toHaveAttribute('title','The borrower’s deadline');await expect(page.locator('.rq-main')).toContainText('Files sent with the job');
 await expect(page.locator('.rq-main')).not.toContainText('Project files download only if you run it.');
 await expect(page.locator('.rq')).not.toContainText('Answer within');await expect(page.locator('.rq')).not.toContainText('goes back');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await expectReviewDisclosures(page);
 await page.screenshot({path:join(process.env.FARAVAN_OFFER_SHOTS??'test-artifacts/browser-verify/offers',`offers-${size}-${theme}.png`),fullPage:false});
 await page.route('**/api/approvals/offer-1/decline',r=>r.fulfill({json:{id:'offer-1',accepted:false}}));await page.getByRole('button',{name:'Decline',exact:true}).click();await expect(page.locator('.rq-state')).toContainText('You declined this request');expect(errors).toEqual([]);
});

for(const [size,viewport] of Object.entries({desktop:{width:1440,height:900},phone:{width:390,height:844}}))for(const theme of ['light','dark'])test(`legacy hold review ${size} ${theme}`,async({page})=>{
 await page.setViewportSize(viewport);await page.emulateMedia({colorScheme:theme});await offerFixture(page,{legacy:true});
 await page.goto((await harness.link('lender'))+'#/request/offer-1');
 await expect(page.getByRole('heading',{level:1})).toHaveText('Sam wants to run a job on your computer (Tessa’s computer)');
 await expect(page.locator('.rq-main')).toContainText('host needs an update for offers');await expect(page.locator('.rq-main')).toContainText('60-second hold while you decide');
 await expect(page.getByRole('button',{name:'Run it',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'Not now',exact:true})).toBeVisible();
 await expect(page.locator('.rq-clock')).toContainText(/Review window closes in \d+ (?:s|min)/);await expect(page.locator('.rq-clock')).toHaveAttribute('title','This computer’s review window');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await expectReviewDisclosures(page);
 await page.screenshot({path:join(process.env.FARAVAN_OFFER_SHOTS??'test-artifacts/browser-verify/offers',`legacy-${size}-${theme}.png`),fullPage:false});
});
