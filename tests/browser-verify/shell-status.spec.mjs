import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
for(const [size,width,height] of [['desktop',1440,900],['phone',390,844]])for(const scheme of ['light','dark'])test('waiting job displays the shared explanation: '+size+' '+scheme,async({page})=>{
 await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme});
 const digest='sha256:'+'d'.repeat(64),circle={id:'waiting',name:'Weekend projects',origin:'http://fixture'};
 await page.route('**/api/circles',route=>route.fulfill({json:[circle]}));
 await page.route('**/api/jobs',route=>route.fulfill({json:[]}));
 await page.route('**/api/jobs/**',route=>route.fulfill({json:{job_digest:digest,state:'queued',status:'Waiting',offerWaiting:{readyCount:0,deciding:null},local:{title:'Explain the parser'},statusContract:{lifecycle:'waiting',explanation:'Waiting for someone to run it · 1 computer is ready · 1 computer is answering another job.'}}}));
 await page.goto((await harness.link('owner'))+'#/job/'+encodeURIComponent(digest)+'/waiting');
 await expect(page.getByText(/1 computer is ready · 1 computer is answering another job/)).toBeVisible();
 await expect(page.locator('.job-page')).not.toContainText(/quota|reserve|% remaining/);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
 if(process.env.SHELL_STATUS_SHOTS){await mkdir(process.env.SHELL_STATUS_SHOTS,{recursive:true});await page.screenshot({path:join(process.env.SHELL_STATUS_SHOTS,'waiting.'+size+'.'+scheme+'.png'),fullPage:true});}
});
