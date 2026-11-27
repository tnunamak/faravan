import {test,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {startHarness,withRequestAdmission} from './lib.mjs';
const shots=process.env.COMPOSE_R5_EVIDENCE;
const circle={id:'compose-r5',name:'Weekend projects',origin:'https://fixture.test',enrollment:{state:'approved'},rosterMembershipVerified:true};
const project={path:'/home/sam/code/booking-site',name:'booking-site',branch:'main',head:'a'.repeat(40),files:4,changed:[],changed_count:0};
const parent='sha256:'+'b'.repeat(64),result='sha256:'+'c'.repeat(64);
let harness;
test.beforeAll(async()=>{harness=await startHarness();if(shots)await mkdir(shots,{recursive:true});});
test.afterAll(async()=>{await harness?.stop();});
async function setup(page,{followup=false}={}){
 await page.addInitScript(({circle,project,parent,result,followup})=>{
  localStorage.setItem('faravan-compose-circle',circle.id);
  localStorage.setItem('faravan-compose-draft:'+circle.id,JSON.stringify({id:'compose-r5-draft',prompt:followup?'Also cover quoted fields.':'Reject a checkout before the arrival date.',sourceKind:'folder',path:project.path,agent:'codex',...(followup?{followup:{parentJob:parent,parentResult:result},base:{path:project.path,branch:'main',commit:project.head,title:'Fix checkout date validation'}}:{})}));
 },{circle,project,parent,result,followup});
 await page.route('**/api/folders?path=',r=>r.fulfill({json:{home:'/home/sam',path:'/home/sam',folders:[]}}));
 await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
 await page.route('**/api/circles/*/compose',r=>r.fulfill({json:{networked:true,host:{label:'Ana’s MacBook',reachable:true},lenders:[{label:'Ana’s MacBook',agents:[{adapter:'codex',readiness:'ready'}]}]}}));
 await page.route('**/api/repo/inspect',r=>r.fulfill({json:project}));
 await page.goto((await harness.link('owner'))+'#/new');
 await expect(page.locator('#cmp-prompt')).toBeVisible();
 if(!followup){if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();await expect(page.locator('#cmp-meta')).toContainText('booking-site');}
}
async function capture(page,name){
 await page.evaluate(()=>document.fonts.ready);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 if(shots)await page.screenshot({path:shots+'/'+name+'.png',fullPage:true,animations:'disabled'});
}
for(const [width,height,size] of [[1440,900,'desktop'],[390,844,'phone']])for(const theme of ['light','dark']){
 test('compose r5 '+size+' '+theme,async({browser})=>{
  const context=await browser.newContext({viewport:{width,height},colorScheme:theme});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await setup(page);
   const send=page.getByRole('button',{name:'Send',exact:true}),box=await send.boundingBox();
   expect(box.y+box.height).toBeLessThan(height);
   await expect(send).toBeEnabled();
   await capture(page,'new-folder.'+size+'-'+theme);
   await page.locator('#cmp-verify-heading').click();
   await page.locator('.cmp-run-details > summary').click();
   await page.locator('.cmp-lender-settings > summary').click();
   await page.getByRole('link',{name:'Review what you’re sending',exact:true}).click();
   await expect(page.getByText(/The lender can inspect the code and data their computer receives\. Their AI provider can also receive it/)).toBeVisible();
   await capture(page,'composer-details.'+size+'-'+theme);
   await page.locator('#cmp-verify-heading').click();
   await page.locator('.cmp-run-details > summary').click();
   await page.getByText('What you’re sending',{exact:true}).click();
   await page.getByRole('radio',{name:'No project',exact:true}).check();
   await expect(send).toBeEnabled();
   await capture(page,'new-no-project.'+size+'-'+theme);
   await page.getByRole('radio',{name:'Folder',exact:true}).check();
   await page.route('**/api/repo/inspect',r=>r.fulfill({json:{kind:'folder',path:'/home/sam/sandbox',name:'sandbox',files:2,suggestions:[project]}}));
   await page.locator('#cmp-folder').fill('~/sandbox');await page.locator('#cmp-folder').press('Enter');
   await expect(page.locator('#cmp-meta')).toContainText('Not a git repository');
   if(width>599){const field=await page.locator('#cmp-folder').boundingBox(),label=await page.locator('label[for=cmp-folder]').boundingBox();expect(Math.abs(field.x-label.x)).toBeLessThan(3);}
   await expect(page.locator('.project-suggestions')).not.toContainText('/home/sam');
   await capture(page,'plain-folder.'+size+'-'+theme);
   await page.route('**/api/repo/inspect',r=>r.fulfill({json:{refusal:{state:'compose.repo-missing'},suggestions:[project]}}));
   await page.locator('#cmp-folder').fill('~/missing');await page.locator('#cmp-folder').press('Enter');
   await expect(page.locator('#cmp-meta')).toHaveAttribute('role','alert');
   await capture(page,'missing-folder.'+size+'-'+theme);
   expect(errors).toEqual([]);
  }finally{await context.close();}
  const follow=await browser.newContext({viewport:{width,height},colorScheme:theme}),fp=await follow.newPage();
  try{
   await setup(fp,{followup:true});
   await expect(fp.locator('main')).toContainText('Continues: Fix checkout date validation');
   await expect(fp.locator('main')).not.toContainText(/\/home\/sam|branch main/);
   const send=await fp.getByRole('button',{name:'Send',exact:true}).boundingBox();expect(send.y+send.height).toBeLessThan(height);
   await capture(fp,'followup.'+size+'-'+theme);
  }finally{await follow.close();}
 });
 test('request r5 '+size+' '+theme,async({browser})=>{
  for(const kind of ['none','archive']){
   const ctx=await browser.newContext({viewport:{width,height},colorScheme:theme}),page=await ctx.newPage();
   try{
    const manifest={project_name:'booking-site',file_count:4,total_bytes:310,packed_bytes:385,not_sent:[],files:[{path:'src/parse.js',bytes:310}]};
    const card=withRequestAdmission({id:'r5-request',offer:true,jobDigest:parent,prompt:kind==='none'?'Write a short poem about a seagull.':'Fix the checkout date validation and add tests.',requesterName:'Sam',requester:'friend',identity:{memberPresent:true,rosterFresh:true,rootMatches:true,circleMatches:true},harness:'codex',runtimeSeconds:1200,network:'internet',source:{kind},sourceManifest:kind==='none'?null:manifest,expiresAt:Date.now()+86400000,job:{circle:circle.id,created_at:new Date().toISOString(),requirements:{limits:{wall_seconds:1200}}},protection:{satisfied:true,sandbox_ready:true,version_gate:{ok:true},egress:{requested:'internet',enforceable:true,source_enforceable:true},limits:{enforced:['cpu','memory_bytes','wall_seconds','output_bytes'],unenforced:[]}}},
     {usage:{jobs:0,jobLimit:3,minutes:0,minuteLimit:60},accountedMilliseconds:0,dailyMinutes:60,now:Date.now()});
    let approval=card;
    await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:'self',name:'Ana’s MacBook',circles:[]}}));await page.route('**/api/approvals',r=>r.fulfill({json:[approval]}));
    await page.goto((await harness.link('lender'))+'#/request/'+card.id);await expect(page.locator('.rq-quote')).toBeVisible();
    await expect(page.getByRole('button',{name:'Run it',exact:true})).toBeEnabled();
    await expect(page.locator('.rq-hint[role="status"]')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/packed|0 files not sent/);
    if(kind==='none')await expect(page.locator('main')).not.toContainText(/downloads.*code/);else await expect(page.locator('.rq-list')).toContainText('booking-site');
    await expect(page.locator('.rq-facts .fact')).toHaveCount(3);
    await capture(page,'request-'+kind+'.'+size+'-'+theme);
    await page.getByText('Protection details',{exact:true}).click();await expect(page.getByText(/Independent verification of these isolation controls is not available here/)).toBeVisible();
    await expect(page.locator('main')).not.toContainText(/Not ready|Update needed|Not checked/);
    await capture(page,'request-'+kind+'-details.'+size+'-'+theme);
    if(kind==='archive'){
     approval=withRequestAdmission(card,{usage:{jobs:0,jobLimit:3,minutes:40,minuteLimit:60},accountedMilliseconds:2400001,dailyMinutes:60,now:Date.now()});
     await page.reload();
     await expect(page.locator('.rq-hint[role="status"]')).toHaveText("This request doesn't fit today's minute limit. Other lenders can take this one.");
     await expect(page.getByRole('button',{name:'Run it',exact:true})).toBeDisabled();
    }
   }finally{await ctx.close();}
  }
 });
}
test('a slow home read then a good response never produces an unreachable banner',async({page})=>{
 let calls=0;const samples=[];
 await page.route('**/api/home',async route=>{
  calls++;
  if(calls===1){await new Promise(resolve=>setTimeout(resolve,7000));await route.fallback().catch(()=>{});return;}
  await route.fallback();
 });
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/home'&&r.ok(),{timeout:15000});
 await page.goto((await harness.link('owner'))+'#/home');
 await page.evaluate(()=>{window.unreachable=[];window.unreachableObserver=new MutationObserver(()=>{if(document.body.textContent.includes('Faravan is unreachable'))window.unreachable.push(document.body.textContent);});window.unreachableObserver.observe(document.body,{subtree:true,childList:true,characterData:true});});
 await response;expect(calls).toBe(1);
 await expect(page.getByRole('heading',{name:'What would you like to get done?',exact:true})).toBeVisible();
 samples.push(...await page.evaluate(()=>{window.unreachableObserver.disconnect();return window.unreachable;}));expect(samples).toEqual([]);
 if(shots)await writeFile(shots+'/slow-response.json',JSON.stringify({calls,unreachable:samples},null,2));
});
