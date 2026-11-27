import {test,expect} from '@playwright/test';
import {patchHome,startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
test('Home uses shared job identity, real member activity, one lending fix and complete attention counts',async({page})=>{
 const at=new Date(Date.now()-60000).toISOString();
 const circle={id:'shared',name:'Weekend projects',origin:'http://fixture'};
 const jobs=[...Array.from({length:3},(_,i)=>({job_digest:'result-'+i,role:'sent',state:'result-accepted',status:'Finished',local:{title:'Result '+i,submittedAt:at},circle})),{job_digest:'ran',role:'ran',state:'result-accepted',status:'Finished',historyIdentity:{author:'borrower',deviceName:'faravan-borrower'},current_attempt:{execution_started_at:at},circle}];
 await patchHome(page,{effective:{intent:{on:false,state:'off'},execution:{state:'idle'},version:'fixture-v2'},dailyLimitReached:null},body=>({...body,lending_blockers:null,intent:{on:false,state:'off'},execution:{state:'idle'},lending:{...body.lending,enabled:false,circle:'shared',status:'idle'}}));
 await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
 await page.route('**/api/jobs',r=>r.fulfill({json:jobs}));
 await page.route('**/api/jobs/**',r=>r.fulfill({json:{format:'diff',files:[{path:'date.mjs',insertions:1,deletions:0}],diffstat:{files:1,insertions:1,deletions:0},diff:''}}));
 await page.route('**/api/approvals',r=>r.fulfill({json:[]}));
 await page.route('**/api/agents',r=>r.fulfill({json:[{id:'codex',installed:true,signedIn:true,useForLending:true}]}));
 await page.route('**/api/readiness',r=>r.fulfill({json:{ready:true,checks:[]}}));
 await page.route('**/api/devices',r=>r.fulfill({json:{name:'Ana’s computer',fingerprint:'self',circles:[{circle:'shared',members:[{key_id:'self',device_name:'Ana’s computer'},{key_id:'borrower',device_name:'faravan-borrower'}]}]}}));
 await page.goto((await harness.link('lender'))+'#/home');
 await expect(page.locator('section[aria-labelledby=home-recent]')).toContainText('Job for faravan-borrower');
 await expect(page.locator('.home-people')).toContainText('faravan-borrower');
 await expect(page.locator('.home-people')).toContainText('Last active 1 min ago');
 await expect(page.locator('.home-people')).not.toContainText('No recent activity');
 await expect(page.getByRole('heading',{level:1,name:'What would you like to get done?'})).toBeVisible();
 await expect(page.locator('.page-head .page-sub')).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Getting started'})).toHaveCount(0);
 await expect(page.locator('.home-count')).toHaveText('4');
 await expect(page.locator('.side-link[href="#/home"] .count')).toHaveText('4');
 await expect(page.locator('.home-lending-card')).toContainText('No new jobs start on this computer.');
 await expect(page.locator('.home-lending-card button')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Run the test',exact:true})).toHaveCount(1);
 await expect(page.locator('.home-lending-card').getByRole('switch')).toHaveCount(0);
 await page.evaluate(()=>{location.hash='#/jobs';});
 await expect(page.locator('.jobs-list')).toContainText('Job for faravan-borrower');
});

const pausedEvidence={effective:{intent:{on:true,state:'paused'},execution:{state:'idle'},version:'fixture-paused'},dailyLimitReached:false};
async function pausedLendingFixture(page,calls){
 await patchHome(page,pausedEvidence,body=>({...body,lending_blockers:null,intent:{on:true,state:'paused'},execution:{state:'idle'},lending:{...body.lending,enabled:true,paused:true,circle:'saved',status:'paused'}}));
 await page.route('**/api/circles',r=>r.fulfill({json:[{id:'other',name:'Other circle',origin:'http://fixture'},{id:'saved',name:'Saved circle',origin:'http://fixture'}]}));
 await page.route('**/api/jobs',r=>r.fulfill({json:[]}));
 await page.route('**/api/approvals',r=>r.fulfill({json:[]}));
 await page.route('**/api/agents',r=>r.fulfill({json:[{id:'codex',installed:true,signedIn:true,useForLending:true}]}));
 await page.route('**/api/readiness',r=>r.fulfill({json:{ready:true,checks:[]}}));
 // Reads such as history-learning are not owner actions; record only mutations.
 await page.route('**/api/lending/*',r=>{if(r.request().method()!=='GET')calls.push({path:new URL(r.request().url()).pathname,body:r.request().postDataJSON()});return r.fulfill({json:{ok:true}});});
}

test('switching a paused Home intent off turns lending off',async({page})=>{
 const calls=[];
 await pausedLendingFixture(page,calls);
 await page.goto((await harness.link('lender'))+'#/home');
 const toggle=page.locator('.home-lending-card').getByRole('switch',{name:'Lending',exact:true});
 await expect(toggle).toHaveAttribute('aria-checked','true');
 await toggle.click();
 await expect.poll(()=>calls).toEqual([{path:'/api/lending/off',body:{circle:'saved'}}]);
});

test('Resume now resumes the saved lending circle',async({page})=>{
 const calls=[];
 await pausedLendingFixture(page,calls);
 await page.goto((await harness.link('lender'))+'#/lend');
 await page.getByRole('button',{name:'Resume now',exact:true}).click();
 await expect.poll(()=>calls).toEqual([{path:'/api/lending/resume',body:{circle:'saved'}}]);
});
