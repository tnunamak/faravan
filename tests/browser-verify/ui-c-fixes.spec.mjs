import {test,expect} from '@playwright/test';
import {patchHome,startHarness,projectJobFixture} from './lib.mjs';
import {mkdir,readFile} from 'node:fs/promises';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const circle={id:'ui-c',name:'Friends',origin:'http://fixture',enrollment:{state:'approved'},rosterMembershipVerified:true};
const title='Review every changed file in the application and explain the behavior of each command, including failures and recovery steps';
const receipt={harness:'codex',model:'gpt-5',backend:'docker-sandboxes',duration_ms:12000,device_name:'kestrel',egress_evidence:{'http-intake.logs.us5.datadoghq.com':'allowed','mcp-gateway.docker.internal':'allowed','cli.github.com':'denied'}};
const job={job_digest:'sha256:'+'c'.repeat(64),circle,state:'result-accepted',result_digest:'sha256:'+'d'.repeat(64),current_attempt:{holder:'host'},local:{title:[...title].slice(0,79).join('')+'…',prompt:title,agent:'codex',submittedAt:new Date().toISOString()},receipt};
const agents=[{id:'codex',installed:true,signedIn:true,useForLending:true},{id:'claude-code-subscription',installed:true,signedIn:false,proxySignedIn:true,lendingSignInTarget:'claude-code-subscription-lending',lendingSignInSupported:true,useForLending:true}];
const checks=['sbx_install','sbx_daemon','docker_login'].map(name=>({name,ok:true}));

test('desktop fixes keep titles readable and identify computers across Home, Jobs, Setup and results',async({page})=>{
 await page.setViewportSize({width:1280,height:900});
 if(process.env.UI_C_BEFORE){
  for(const asset of ['app.mjs','app.css'])await page.route('**/'+asset,async route=>route.fulfill({body:await readFile(process.env.UI_C_BEFORE+'/'+asset),contentType:asset.endsWith('css')?'text/css':'text/javascript'}));
 }
 await page.route('**/api/events**',route=>route.fulfill({contentType:'text/event-stream',body:''}));
 await page.route('**/api/circles',route=>route.fulfill({json:[circle]}));
 await page.route('**/api/agents',route=>route.fulfill({json:agents}));
 await page.route('**/api/devices',route=>route.fulfill({json:{fingerprint:'viewer',name:'sandpiper',circles:[{circle:circle.id,members:[{key_id:'host',personName:'Tessa',device_name:'kestrel'},{key_id:'second',personName:'Tessa',device_name:'falcon'}]}]}}));
 await page.route(/\/api\/readiness(?:\?.*)?$/,route=>route.fulfill({json:{ready:true,checks}}));
 await page.route('**/api/lending/readiness**',route=>route.fulfill({json:{agents:agents.map(a=>({id:a.id,checks:[{id:'signed_in',state:'pass'}]}))}}));
 await patchHome(page,{effective:{intent:{on:false,state:'off'},execution:{state:'idle'},version:'fixture-v2'},dailyLimitReached:false},body=>({...body,lending_blockers:null,lendingPolicy:{accounts:[{provider:'claude'},{provider:'codex'}]},intent:{on:false,state:'off'},lending:{...body.lending,enabled:false,circle:circle.id},allowance:{provider:'claude',remaining:85,checkedAt:new Date().toISOString()}}));
 await page.route('**/api/contributions',route=>route.fulfill({json:{windows:{7:{devices:2,jobs:2,rows:[{keyId:'host',personName:'Tessa',run:1},{keyId:'second',personName:'Tessa',run:1}]}}}}));
 await page.route('**/api/jobs',route=>route.fulfill({json:[projectJobFixture(job),projectJobFixture({...job,job_digest:'sha256:'+'e'.repeat(64),state:'cancelled',receipt:null,current_attempt:null})]}));
 await page.route('**/api/jobs/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/changes'))return route.fulfill({json:{format:'message',message:{markdown:'The review is complete.'},files:[],receipt}});
  if(path.endsWith('/transcript'))return route.fulfill({json:{text:'',live:false}});
  if(path.endsWith('/thread'))return route.fulfill({json:{thread:[]}});
  if(path.endsWith('/retention'))return route.fulfill({json:{}});
  if(path.endsWith('/continuation'))return route.fulfill({json:{}});
  return route.fulfill({json:projectJobFixture(job)});
 });
 const output=process.env.UI_C_SHOTS;
 if(output)await mkdir(output,{recursive:true});
 for(const [name,hash] of [['home','home'],['jobs','jobs'],['setup','setup'],['job','job/'+encodeURIComponent(job.job_digest)+'/'+circle.id]]){
  await page.goto((await harness.link('owner'))+'#/'+hash);
  await expect(page.locator(name==='jobs'?'.jlist':name==='home'?'#home-task':'main h1').first()).toBeVisible();
  if(name==='home')await expect(page.locator('.home-contributions')).toContainText('You helped');
  if(name==='job')await expect(page.getByText('The review is complete.',{exact:true})).toBeVisible();
  if(!process.env.UI_C_BEFORE){
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   if(name==='home'){
    await expect(page.getByRole('button',{name:'New job',exact:true})).toBeEnabled();
    await expect(page.locator('.home-contributions')).toContainText('You helped Tessa with 2 jobs');
    await expect(page.locator('main')).toContainText('kestrel');
   }
   if(name==='jobs')expect(await page.locator('.job-title-text').first().evaluate(el=>el.getBoundingClientRect().width)).toBeGreaterThan(280);
   if(name==='setup')await expect(page.locator('main')).toContainText(/ready to lend with Codex and Claude Code|ready to lend with Claude Code and Codex/);
   if(name==='job'){
    await expect(page.locator('.jh h1')).toHaveText(title);
    expect(await page.locator('.jh h1').evaluate(el=>getComputedStyle(el).whiteSpace)).toBe('normal');
    await expect(page.locator('.result-properties')).toContainText('kestrel');
    expect(await page.locator('.result-rail code').first().evaluate(el=>getComputedStyle(el).overflowWrap)).toBe('anywhere');
   }
  }
  if(output)await page.screenshot({path:output+'/'+name+'.png',fullPage:true});
  if(!process.env.UI_C_BEFORE){
   await page.setViewportSize({width:390,height:844});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.setViewportSize({width:1280,height:900});
  }
 }
 if(!process.env.UI_C_BEFORE){
  await page.goto((await harness.link('owner'))+'#/lend');
  await expect(page.getByRole('heading',{name:'Allowance available to lend'})).toBeVisible();
  await expect(page.locator('p').filter({hasText:'No new jobs start; running jobs continue within their saved limits.'})).toHaveCount(1);
  await expect(page.locator('main')).toContainText('Lending off: No new jobs start; running jobs continue within their saved limits.');
  expect(await page.locator('.hstack').filter({hasText:'Learn from my local agent logs'}).evaluate(el=>getComputedStyle(el).display)).toBe('flex');
 }

});
