import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {startDataHarness} from '../helpers/data-process-harness.mjs';

// Round 7 O1/O2: a real owner app and a real lender app (separate OS processes, synthetic homes) behind a real
// coordinator, with TWO agent accounts lending. The daemon re-broadcasts one `lending` event per account about
// twice a second; the page must stay "Live" and no /api/events stream may be aborted. Set EVENTS_SHOTS to a folder
// to also save the job page states at desktop and phone size, light and dark.
const worker=new URL('../helpers/events-app-worker.mjs',import.meta.url);
const IDLE_MS=60_000;
test.setTimeout(240_000);
let harness;
test.beforeEach(async()=>{harness=await startDataHarness({worker});});
test.afterEach(async()=>{await harness?.stop();});

const post=(origin,path,body)=>fetch(origin+'/api/'+path,{method:'POST',headers:{'content-type':'application/json','x-faravan-session-token':origin===harness.owner?'synthetic-session-owner':'synthetic-session-lender'},body:JSON.stringify(body)});
async function startLending(){
  const settingsResponse=await fetch(harness.lender+'/api/lending/owner-settings',{headers:{'x-faravan-session-token':'synthetic-session-lender'}});
  const settings=await settingsResponse.json(),engineMinimum=Math.max(settings.defaultMaxJobUsd,...settings.minimums.map(row=>row.minimumMaxJobUsd));
  const cap=await post(harness.lender,'lending/owner-settings',{maxJobUsd:engineMinimum,reason:'Synthetic event journey needs room for one worst-case call.'});
  expect(cap.ok,'owner job cap: '+await cap.clone().text()).toBeTruthy();
  for(const [path,body] of [['lending/limits',{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}],['agents/codex',{useForLending:true}],['agents/claude-code-subscription',{useForLending:true}],['lending/mode',{circle:harness.circle.id,mode:'ask'}],['lending/on',{circle:harness.circle.id}]]){const r=await post(harness.lender,path,body);expect(r.ok,path+': '+await r.clone().text()).toBeTruthy();}
}
async function submit(prompt,agent='codex'){const r=await post(harness.owner,'jobs',{circle:harness.circle.id,git:'https://github.com/example/synthetic.git',commit:'3'.repeat(40),prompt,harness:agent});expect(r.ok,await r.clone().text()).toBeTruthy();return r.json();}
const jobUrl=async(link,job)=>(await link())+'#/job/'+encodeURIComponent(job.jobDigest)+'/'+encodeURIComponent(harness.circle.id);

// Raw server-side event rate: settle the replay first (cursor = newest id), then count only the NEW frames of a quiet stretch.
async function readStream(origin,token,after,ms){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),ms);let text='';
  try{const response=await fetch(origin+'/api/events?after='+after,{signal:controller.signal,headers:{'x-faravan-session-token':token,Accept:'text/event-stream'}});
    for await(const chunk of response.body)text+=Buffer.from(chunk).toString('utf8');}catch{}
  clearTimeout(timer);
  return text.split('\n\n').map(f=>f.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('')).filter(Boolean).map(d=>{try{return JSON.parse(d);}catch{return null;}}).filter(Boolean);
}
async function eventRate(origin,token,ms){
  const settled=await readStream(origin,token,0,3_000),cursor=Math.max(0,...settled.map(e=>Number(e.id)||0));
  const events=await readStream(origin,token,cursor,ms),lending=events.filter(e=>e.type==='lending');
  return {seconds:ms/1000,cursor,events:events.length,lending:lending.length,lendingAccounts:[...new Set(lending.map(e=>e.data?.account))],lendingPerSecond:+(lending.length/(ms/1000)).toFixed(2)};
}

async function rawReplay(origin,token,ms){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),ms);let bytes=0,frames=0;
  try{const response=await fetch(origin+'/api/events?after=0',{signal:controller.signal,headers:{'x-faravan-session-token':token,Accept:'text/event-stream'}});
    for await(const chunk of response.body){bytes+=chunk.length;frames+=String(Buffer.from(chunk)).split('\n\n').length-1;}}catch{}
  clearTimeout(timer);return {bytes,frames};
}

function watch(page,label,log){
  const aborted=[],requests=[];
  page.on('request',r=>{const u=new URL(r.url());if(u.pathname==='/api/events')requests.push(Date.now());});
  page.on('requestfailed',r=>{const u=new URL(r.url());if(r.method()==='GET'&&u.pathname.startsWith('/api/'))aborted.push({url:u.pathname,error:r.failure()?.errorText});});
  return {aborted,requests,summary:()=>({page:label,eventsRequests:requests.length,abortedEvents:aborted.filter(a=>a.url==='/api/events').length,abortedOther:aborted.filter(a=>a.url!=='/api/events').length}),log};
}
const PAUSED=/Live updates paused|Status needs an update|Last known|Job status is updating|is unreachable|couldn.t load/i;

test('two lending accounts idle for 60 seconds: job pages stay live and no /api/events stream is aborted',async({browser})=>{
  await startLending();
  // Both accounts idle and polling: the state the judge measured at about two events a second, alternating accounts.
  await new Promise(resolve=>setTimeout(resolve,5_000));
  const rate=await eventRate(harness.lender,'synthetic-session-lender',10_000);
  const job=await submit('Synthetic idle events regression');
  const lenderPage=await browser.newPage(),ownerPage=await browser.newPage();
  const seen=[watch(ownerPage,'owner job page'),watch(lenderPage,'lender job page')];
  await ownerPage.goto((await jobUrl(harness.ownerLink,job)));await lenderPage.goto((await jobUrl(harness.lenderLink,job)));
  for(const p of [ownerPage,lenderPage])await expect(p.locator('#app h1').first()).toBeVisible({timeout:45_000});
  await shoot(ownerPage,'job-waiting-owner');await shoot(lenderPage,'job-waiting-lender');
  const remaining=IDLE_MS;
  // Sample the page every 5 s so a transient "paused" is caught, not only the end state.
  const samples=[];
  // The borrower's page names the job; the lender has not answered the request yet, so its page is checked for stale notices only.
  for(let waited=0;waited<remaining;waited+=5_000){await ownerPage.waitForTimeout(5_000);for(const [name,p] of [['owner',ownerPage],['lender',lenderPage]]){const t=await p.locator('body').innerText();const problem=PAUSED.exec(t)?.[0]??(name==='lender'||(/Synthetic idle events regression/.test(t)&&/Waiting/.test(t))?null:'page is not showing the waiting job');samples.push(problem&&problem+' ('+name+' at '+(waited+5)+'s)');}}
  const summaries=seen.map(s=>s.summary());
  console.log('EVENTS_EVIDENCE',JSON.stringify({rate,summaries,samples:samples.filter(Boolean)}));
  await shoot(ownerPage,'job-waiting-owner-60s');await shoot(lenderPage,'job-waiting-lender-60s');
  expect(summaries.map(s=>s.abortedEvents),'aborted /api/events streams '+JSON.stringify(seen.map(s=>s.aborted))).toEqual([0,0]);
  expect(summaries.map(s=>s.abortedOther)).toEqual([0,0]);
  expect(summaries.every(s=>s.eventsRequests<=2),'stream reconnects '+JSON.stringify(summaries)).toBeTruthy();
  expect(samples.filter(Boolean),'a stale-state notice appeared while the app answered').toEqual([]);
  expect(rate.lending,'unchanged lending state must not be re-broadcast: '+JSON.stringify(rate)).toBeLessThanOrEqual(1);
  await expect(ownerPage.locator('.offline')).toHaveCount(0);
});

test('a new tab after a long idle replays a bounded history and connects first try',async({browser})=>{
  await startLending();
  const job=await submit('Synthetic replay regression');
  // Fill the lender's event history with distinct changes (a limits edit is one event each), then read a raw replay.
  for(let i=1;i<=400;i++)await post(harness.owner,'lending/limits',{dailyJobs:3,dailyMinutes:30+i,maxWallSeconds:1200,idleOnly:false});
  await new Promise(resolve=>setTimeout(resolve,20_000));
  const replay=await rawReplay(harness.owner,'synthetic-session-owner',4_000);
  console.log('EVENTS_EVIDENCE',JSON.stringify({replay}));
  expect(replay.bytes,'a replay from cursor 0 must stay under the client buffer: '+JSON.stringify(replay)).toBeLessThan(1_000_000);
  const first=await browser.newPage();await first.goto((await jobUrl(harness.ownerLink,job)));await expect(first.locator('#app h1').first()).toBeVisible({timeout:45_000});
  const tab=await browser.newPage(),seen=watch(tab,'fresh tab after idle');
  let replayBytes=0;tab.on('response',async r=>{if(new URL(r.url()).pathname==='/api/events')replayBytes=-1;});
  await tab.goto((await jobUrl(harness.ownerLink,job)));await expect(tab.locator('#app h1').first()).toBeVisible({timeout:45_000});
  await tab.waitForTimeout(15_000);
  console.log('EVENTS_EVIDENCE',JSON.stringify({replay:seen.summary()}));
  expect(seen.summary().abortedEvents).toBe(0);expect(seen.summary().eventsRequests).toBeLessThanOrEqual(2);
  await expect(tab.locator('body')).not.toContainText(PAUSED);
  await expect(tab.getByText('Synthetic replay regression').first()).toBeVisible();
});

async function runningJob(prompt){
  const job=await submit(prompt),auth={'x-faravan-session-token':'synthetic-session-lender'};
  let approvals=[];await expect.poll(async()=>{approvals=await (await fetch(harness.lender+'/api/approvals',{headers:auth})).json();return approvals.length;},{timeout:30_000}).toBeGreaterThan(0);
  await post(harness.lender,'approvals/'+approvals[0].id+'/accept',{});
  await harness.waitForAgentEmit();
  return job;
}

test('a running job stays Live for 60 seconds on borrower and lender, then finishes, with no aborted /api/events',async({browser})=>{
  await startLending();
  const job=await runningJob('Synthetic states regression');
  const pages=[['borrower',await browser.newPage(),harness.ownerLink],['lender',await browser.newPage(),harness.lenderLink]],seen=pages.map(([name,page])=>watch(page,name+' running job'));
  for(const [,page,ui] of pages){await page.goto(await jobUrl(ui,job));await expect(page.getByText('DATA synthetic agent message',{exact:false})).toBeVisible({timeout:30_000});}
  const samples=[];
  for(let waited=0;waited<IDLE_MS;waited+=5_000){
    for(const [name,page] of pages){
      const t=await page.locator('body').innerText(),live=await page.locator('.activity-live').isVisible();
      if(PAUSED.test(t))console.log('EVENTS_STALE',JSON.stringify({page:name,waited,text:t}));
      samples.push(PAUSED.exec(t)?.[0]??(live?null:'no Live marker'));if(samples.at(-1))samples[samples.length-1]+=' ('+name+' at '+waited/1000+'s)';
    }
    if(waited===30_000)for(const [name,page] of pages)await shoot(page,'job-live-'+name);
    await pages[0][1].waitForTimeout(5_000);
  }
  const summaries=seen.map(s=>s.summary());
  console.log('EVENTS_EVIDENCE',JSON.stringify({running:summaries,problems:samples.filter(Boolean)}));
  expect(samples.filter(Boolean),'running page lost Live or showed a stale notice').toEqual([]);
  expect(summaries.map(s=>s.abortedEvents),JSON.stringify(seen.map(s=>s.aborted))).toEqual([0,0]);
  expect(summaries.map(s=>s.abortedOther)).toEqual([0,0]);
  // finish the real synthetic job; both sides settle on a finished page
  await harness.releaseJob();
  for(const [name,page] of pages){await expect(page.locator('.activity-live'),name+' still Live after the job finished').toHaveCount(0,{timeout:30_000});await shoot(page,'job-finished-'+name);}
});

test('oversized event history: a fresh lender tab connects without aborted /api/events streams',async({browser})=>{
  await startLending();
  const job=await runningJob('Synthetic oversized history');
  const filler='x'.repeat(30_000);
  for(let i=0;i<60;i++)await harness.emitMessage('DATA filler '+i+' '+filler);
  const replay=await rawReplay(harness.lender,'synthetic-session-lender',6_000);
  const tab=await browser.newPage(),seen=watch(tab,'fresh lender tab, large history');
  await tab.goto((await jobUrl(harness.lenderLink,job)));await expect(tab.locator('#app h1').first()).toBeVisible({timeout:45_000});
  await tab.waitForTimeout(20_000);
  console.log('EVENTS_EVIDENCE',JSON.stringify({oversized:{replay,...seen.summary(),aborted:seen.aborted}}));
  expect(seen.summary().abortedEvents,'aborted '+JSON.stringify(replay)).toBe(0);
  expect(seen.summary().eventsRequests).toBeLessThanOrEqual(2);
  await expect(tab.locator('body')).not.toContainText(PAUSED);
});

test('host stopped while both apps run: finished result and Jobs stay visible from cache, offline once, no 409',async({browser})=>{
  await startLending();
  const job=await runningJob('Synthetic host outage');
  const page=await browser.newPage(),conflicts=[];let hostDown=false;
  page.on('response',async r=>{if(r.status()>=400&&new URL(r.url()).pathname.startsWith('/api/')){let code='';try{code=(await r.json()).code;}catch{}conflicts.push({path:new URL(r.url()).pathname.replace(/sha256%3A[0-9a-f]+/,'JOB'),status:r.status(),code,hostDown});}});
  await page.goto((await jobUrl(harness.ownerLink,job)));await expect(page.getByText('DATA synthetic agent message',{exact:false})).toBeVisible({timeout:30_000});
  await harness.releaseJob();
  await expect(page.locator('.activity-live')).toHaveCount(0,{timeout:30_000});
  await page.goto((await harness.ownerLink())+'#/jobs');await expect(page.locator('.jobs-list .row-title').first()).toHaveText('Synthetic host outage',{timeout:20_000});
  // The borrower opens the delivered result once while the host answers; that is the copy the app keeps.
  const loaded=['changes','retention','timeline'].map(part=>page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/'+part)&&r.ok(),{timeout:30_000}));
  await page.goto((await jobUrl(harness.ownerLink,job)));await expect(page.locator('#app h1').first()).toBeVisible();
  await Promise.all(loaded);
  await harness.stopHost();hostDown=true;
  await page.waitForTimeout(20_000);
  await page.goto((await harness.ownerLink())+'#/jobs');await expect(page.locator('.jobs-list .row-title').first()).toHaveText('Synthetic host outage');
  await shoot(page,'jobs-host-stopped');
  await page.goto((await jobUrl(harness.ownerLink,job)));await expect(page.locator('#app h1').first()).toBeVisible();
  await page.waitForTimeout(8_000);
  await expect(page.getByText('Synthetic host outage').first()).toBeVisible();
  const offline=await page.locator('.offline, [role=status]').allInnerTexts();
  console.log('EVENTS_EVIDENCE',JSON.stringify({hostStopped:{offline,conflicts}}));
  await shoot(page,'job-host-stopped');
  expect(conflicts.filter(row=>row.hostDown),'reads the app saved must not fail while the host is down').toEqual([]);
  expect(await page.locator('body').innerText()).toMatch(/offline|unreachable|can.t reach|Last known|Last update/i);
});

async function shoot(page,name){
  const dir=process.env.EVENTS_SHOTS;if(!dir)return;await mkdir(dir,{recursive:true});
  const before=page.viewportSize();
  for(const [label,width,height] of [['desktop',1440,900],['phone',390,844]])for(const scheme of ['light','dark']){await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme});await page.waitForTimeout(250);await page.screenshot({path:join(dir,`${name}.${label}.${scheme}.png`),fullPage:true});}
  if(before)await page.setViewportSize(before);
}
