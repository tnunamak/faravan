import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {startDataHarness} from '../helpers/data-process-harness.mjs';
import {projectJobFixture} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startDataHarness();});
test.afterAll(async()=>{await harness?.stop();});
test.beforeEach(async({page})=>{
 if(process.env.DATA_BASELINE_ASSETS)for(const file of ['app.mjs','app.css'])await page.route('**/'+file,route=>route.fulfill({path:join(process.env.DATA_BASELINE_ASSETS,file)}));
});
const digest='sha256:'+'e'.repeat(64);
async function jobPage(page,{cancelled=false,waiting=false,timed=false,failRead=()=>false,failTranscriptRead=()=>false}={}){
 const circle=harness.circle;
 let holdNextRead=false,releaseHeldRead=null;
 await page.route('**/api/jobs',route=>route.fulfill({json:[]}));
 await page.route('**/api/jobs/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/transcript'))return failTranscriptRead()?route.abort('internetdisconnected'):route.fulfill({json:{text:JSON.stringify({type:'item.completed',...(timed?{timestamp:new Date().toISOString()}:{}),item:{type:'agent_message',text:'The parser now handles missing dates.'}}),live:!cancelled}});
  if(path.endsWith('/progress'))return route.fulfill({json:{entries:[]}});
  if(failRead())return route.fulfill({status:409,json:{code:'network_error'}});
  const response={json:projectJobFixture({job_digest:digest,state:cancelled?'cancelled':'claimed',compute_stopped:cancelled,
   ...(waiting?{approval:'pending'}:{}),local:{title:'Explain missing dates'},job:{payload:{author:'owner'}},
   current_attempt:cancelled?null:{attempt_id:'a1',holder:'other',execution_started_at:waiting?null:new Date().toISOString()}})};
  if(holdNextRead){
   holdNextRead=false;
   await new Promise(resolve=>{releaseHeldRead=async()=>{await route.fulfill(response);releaseHeldRead=null;resolve();};});
   return;
  }
  return route.fulfill(response);
 });
 await page.goto((await harness.ownerLink())+'#/job/'+encodeURIComponent(digest)+'/'+circle.id);
 await expect(page.getByRole('heading',{level:1})).toHaveText('Explain missing dates');
 return {holdNextRead(){holdNextRead=true;},readIsHeld:()=>Boolean(releaseHeldRead),async releaseRead(){await releaseHeldRead?.();}};
}
for(const [size,width,height] of [['desktop',1440,900],['phone',390,844]])for(const theme of ['light','dark']){
 test(`a paused stream and offline connection cannot retain a Live badge: ${size} ${theme}`,async({page})=>{
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
  let failTranscript=false;
  await page.addInitScript(()=>{
   const original=window.fetch;let controller,down=false;
   window.pauseFixtureStream=()=>{down=true;controller.close();};
   window.fetch=(input,options)=>String(input).includes('/api/events')?(down?Promise.reject(new TypeError('fixture disconnect')):Promise.resolve(new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'content-type':'text/event-stream'}}))):original(input,options);
  });
  await jobPage(page,{failTranscriptRead:()=>failTranscript});await expect(page.getByText('The parser now handles missing dates.')).toBeVisible();await expect(page.locator('.activity-live')).toBeVisible();
  // Paused means the app does not answer, so its shell reads go unanswered too; one answered poll would rightly clear the banner.
  await page.route(url=>url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/api/jobs')&&url.pathname!=='/api/events',()=>{});
  // A read already in flight when the stream pauses can still answer after the clock jump and restart the grace period,
  // so the clock moves on in 5-second polling steps until the banner shows.
  await page.clock.install();await page.evaluate(()=>pauseFixtureStream());await page.clock.fastForward(16000);
  await expect.poll(async()=>{const text=await page.locator('.offline').textContent({timeout:200}).catch(()=>'');if(!text.includes('Live updates paused'))await page.clock.fastForward(5000);return text;},{timeout:8000}).toContain('Live updates paused');
  // The shell event stream can pause while the transcript poll still confirms a live relay.
  await expect(page.locator('.activity-live')).toBeVisible();await capture(page,'stream-paused',size,theme);
  failTranscript=true;
  await page.context().setOffline(true);await expect(page.locator('.offline')).toContainText(size==='phone'?'Can’t reach your computer.':'Check your connection before sending or saving.');
  await page.clock.fastForward(6000);await expect(page.locator('.activity-live')).toBeHidden();
  await expect(page.locator('.activity-intro')).toContainText('Last known:');
  await expect(page.getByRole('button',{name:'Rename job',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Stop this job',exact:true})).toBeDisabled();
  if(size==='phone'){
   await expect(page.locator('.offline')).toContainText('Check that it’s awake and on the same network.');
   const text=await page.locator('.offline>.grow').boundingBox(),actions=await page.locator('.offline-actions').boundingBox();
   expect(text.width).toBeGreaterThan(250);expect(actions.y).toBeGreaterThanOrEqual(text.y+text.height);
  }
  await capture(page,'offline-job',size,theme);
 });
}
test('arriving on a cancelled job with a healthy stream never reports paused updates',async({page})=>{
 await jobPage(page,{cancelled:true});await expect(page.locator('.jh .pill')).toContainText('Cancelled');
 await page.waitForTimeout(2000);await expect(page.locator('.offline')).toHaveCount(0);await expect(page.locator('.activity-live')).toHaveCount(0);
});
test('a failed job read hides Live even while the shell connection remains healthy',async({page})=>{
 let failed=false;
 await page.addInitScript(()=>{
  const original=window.fetch;let controller;
  window.invalidateFixture=()=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:1,type:'job',data:{refresh:true}})+'\n\n'));
  window.fetch=(input,options)=>String(input).includes('/api/events')?Promise.resolve(new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'content-type':'text/event-stream'}})):original(input,options);
 });
 await jobPage(page,{failRead:()=>failed});await expect(page.locator('.activity-live')).toBeVisible();
 failed=true;await page.evaluate(()=>invalidateFixture());
 await expect(page.locator('.jh .pill')).toContainText('Last known:',{timeout:12000});
 await expect(page.locator('.activity-live')).toBeHidden();
 await expect(page.locator('.activity-intro')).toContainText('Last known:');
 await expect(page.getByText('The computer hosting this circle cannot be reached. Check that it is awake and connected before sending.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Check connection',exact:true})).toBeVisible();
 for(const [size,width,height] of [['desktop',1440,900],['phone',390,844]])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});await capture(page,'job-read-failed',size,theme);
 }
 failed=false;await page.getByRole('button',{name:'Check connection',exact:true}).click();
 await expect(page.locator('.activity-live')).toBeVisible();
});
test('an invalidated waiting snapshot stays actionable while its read is queued or fails',async({page})=>{
 let failed=false;
 await page.addInitScript(()=>{
  const original=window.fetch;let controller,eventId=0;
  window.invalidateFixture=()=>{const refresh=++eventId;controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:refresh,type:'job',data:{refresh}})+'\n\n'));};
  window.fetch=(input,options)=>String(input).includes('/api/events')?Promise.resolve(new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'content-type':'text/event-stream'}})):original(input,options);
 });
 const reads=await jobPage(page,{waiting:true,failRead:()=>failed});await expect(page.locator('.jh .pill')).toHaveText('Waiting for an answer');
 reads.holdNextRead();await page.evaluate(()=>invalidateFixture());
 try{
  await expect.poll(reads.readIsHeld).toBe(true);
  await expect(page.locator('.jh .pill')).toHaveText('Waiting for an answer');
  await expect(page.getByRole('button',{name:'Cancel job',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Stop this job',exact:true})).toHaveCount(0);
  await expect(page.getByText('Job status is updating.',{exact:true})).toHaveCount(0);
  await expect(page.locator('.activity-live')).toBeHidden();
  await expect(page.locator('.offline')).toHaveCount(0);
 }finally{await reads.releaseRead();}
 await expect(page.locator('.jh .pill')).toHaveText('Waiting for an answer',{timeout:8000});
 failed=true;await page.evaluate(()=>invalidateFixture());
 await expect(page.locator('.jh .pill')).toContainText('Last known:');
 await expect(page.getByRole('button',{name:'Cancel job',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Stop this job',exact:true})).toHaveCount(0);
 await expect(page.getByText('Job status is updating.',{exact:true})).toBeVisible();
 await expect(page.locator('.offline')).toHaveCount(0);
});
test('a healthy live feed stays live during background revalidation',async({page})=>{
 // The agent update is timestamped and fresh, so Live and the headline are an honest claim before the revalidation.
 let release,started=false;
 await page.addInitScript(()=>{
  const original=window.fetch;let controller;
  window.invalidateFixture=()=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:1,type:'job',data:{refresh:true}})+'\n\n'));
  window.fetch=(input,options)=>String(input).includes('/api/events')?Promise.resolve(new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'content-type':'text/event-stream'}})):original(input,options);
 });
 await jobPage(page,{timed:true});await expect(page.locator('.activity-live')).toBeVisible();await expect(page.locator('.activity-intro')).toBeVisible();
 await page.route('**/api/jobs/'+encodeURIComponent(digest)+'?*',route=>new Promise(resolve=>{started=true;release=async()=>{await route.fulfill({json:projectJobFixture({job_digest:digest,state:'claimed',local:{title:'Explain missing dates'},current_attempt:{attempt_id:'a1',holder:'other',execution_started_at:new Date().toISOString()}})});resolve();};}));
 try{
  await page.evaluate(()=>invalidateFixture());await expect.poll(()=>started,{timeout:8000}).toBe(true);
  await expect(page.locator('.activity-live')).toBeVisible();await expect(page.locator('.activity-intro')).not.toContainText('Last known:');
  await expect(page.locator('.jh .pill')).toHaveText('Working');
 }finally{await release?.();}
});
test('a waiting job does not keep polling its transcript before approval',async({page})=>{
 let reads=0;page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/transcript'))reads++;});
 await page.addInitScript(()=>{
  const original=window.fetch;
  window.fetch=(input,options)=>String(input).includes('/api/events')?Promise.resolve(new Response(new ReadableStream(),{headers:{'content-type':'text/event-stream'}})):original(input,options);
 });
 await jobPage(page,{waiting:true});await page.waitForTimeout(11000);expect(reads).toBeLessThanOrEqual(2);
});
test('the first shell snapshot does not invalidate an already loaded job',async({page})=>{
 let release,finished=false;
 await page.addInitScript(()=>{
  const original=window.fetch;
  window.fetch=(input,options)=>String(input).includes('/api/events')?Promise.resolve(new Response(new ReadableStream(),{headers:{'content-type':'text/event-stream'}})):original(input,options);
 });
 await page.route('**/api/readiness',route=>new Promise(resolve=>{release=async()=>{await route.fulfill({json:{ready:true,checks:[]}});finished=true;resolve();};}));
 try{
  await jobPage(page);await expect(page.locator('.activity-live')).toBeVisible();
  await release();await expect.poll(()=>finished).toBe(true);
  await page.waitForTimeout(250);
  await expect(page.locator('.jh .pill')).toHaveText('Working',{timeout:1000});
  await expect(page.locator('.activity-live')).toBeVisible();
 }finally{if(!finished)await release?.();}
});
test('one slow shell resource cannot hold fresh requests behind it',async({page})=>{
 let approvals=0,release;
 await page.addInitScript(()=>{
  const original=window.fetch;let controller;
  window.invalidateFixture=()=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:1,type:'approval',data:{refresh:true}})+'\n\n'));
  window.fetch=(input,options)=>String(input).includes('/api/events')?Promise.resolve(new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'content-type':'text/event-stream'}})):original(input,options);
 });
 await page.route('**/api/jobs',route=>new Promise(resolve=>{release=async()=>{await route.fulfill({json:[]});resolve();};}));
 await page.route('**/api/approvals',route=>{approvals++;return route.fulfill({json:[]});});
 try{
  await page.goto((await harness.ownerLink())+'#/lend');await expect.poll(()=>approvals).toBe(1);
  // The Lend page has loaded; its lending state depends on the install default and is not under test here.
  await expect(page.getByRole('heading',{name:'Agents you lend'})).toBeVisible();
  await page.clock.install();await page.evaluate(()=>invalidateFixture());await page.clock.fastForward(5001);
  await expect.poll(()=>approvals).toBeGreaterThanOrEqual(2);
 }finally{await release?.();}
});
test('New job still opens a local draft while offline without sending it',async({page})=>{
 let sends=0;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/jobs')sends++;});
 // Home composes inline now: its task field and Send a job button hand the draft to the composer without a job send.
 await page.goto((await harness.ownerLink())+'#/home');const task=page.getByRole('textbox',{name:'What would you like to get done?'});await expect(task).toBeVisible();
 // Circles must load before the connection drops, or the draft has no circle to open in.
 await expect(page.getByRole('heading',{name:'Getting started',exact:true})).toBeVisible();
 await page.context().setOffline(true);await task.fill('Draft this when my computer reconnects');
 await page.getByRole('button',{name:'Send a job',exact:true}).click();
 const prompt=page.locator('textarea').first();await expect(prompt).toBeVisible();
 await expect(prompt).toHaveValue('Draft this when my computer reconnects');expect(sends).toBe(0);
});
async function capture(page,name,size,theme){if(!process.env.DATA_FRESHNESS_SHOTS)return;await mkdir(process.env.DATA_FRESHNESS_SHOTS,{recursive:true});await page.screenshot({path:join(process.env.DATA_FRESHNESS_SHOTS,`${name}.${size}.${theme}.png`),fullPage:true});await page.screenshot({path:join(process.env.DATA_FRESHNESS_SHOTS,`${name}.${size}.${theme}.viewport.png`)});}
