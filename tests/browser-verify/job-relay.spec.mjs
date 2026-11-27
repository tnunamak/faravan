import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {startHarness} from './lib.mjs';
import {createRelayTranscript} from '../../lib/v1/live-transcript.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const circle={id:'relay-circle',name:'Weekend projects',origin:'http://fixture'};
const digest='sha256:'+'e'.repeat(64),now=Date.parse('2026-10-20T17:25:28Z');
const text=JSON.stringify({type:'assistant',timestamp:'2026-10-20T17:25:00Z',message:{content:[{type:'text',text:'I found the parser issue. I’m checking quoted fields before changing the code.'}]}})+'\n'+
 JSON.stringify({type:'assistant',timestamp:'2026-10-20T17:25:10Z',message:{content:[{type:'tool_use',id:'activity-1',name:'Bash',input:{command:'npm test'}}]}})+'\n';
async function open(page,actor,transcript) {
 await page.clock.setFixedTime(now);
 const own=actor==='borrower';
 const job={job_digest:digest,state:'claimed',historyIdentity:{deviceName:'Alex'},title:'Handle quoted fields in CSV imports',prompt:'Handle quoted fields in CSV imports',local:own?{historyIdentity:{deviceName:'Alex'},title:'Handle quoted fields in CSV imports',prompt:'Handle quoted fields in CSV imports',submittedAt:'2026-10-20T17:20:00Z'}:undefined,
  job:{payload:{author:'sender',requirements:{harness:['codex']},source:{kind:'none'}}},current_attempt:{attempt_id:'a1',holder:'lender',execution_started_at:'2026-10-20T17:24:00Z'},runTiming:{hardStopAt:'2026-10-20T17:44:00Z'}};
 await page.route('**/api/circles',route=>route.fulfill({json:[circle]}));
 await page.route('**/api/circles/*/compose',route=>route.fulfill({json:{}}));
 await page.route('**/api/devices',route=>route.fulfill({json:{fingerprint:own?'sender':'lender',circles:[{id:circle.id,members:[{key_id:'sender',device_name:'Alex'},{key_id:'lender',device_name:'Mia'}]}]}}));
 await page.route('**/api/jobs',route=>route.fulfill({json:[]}));
 await page.route('**/api/jobs/**',route=>{
  const pathname=new URL(route.request().url()).pathname;
  if(pathname.endsWith('/prompt'))return route.fulfill({json:{text:'Handle quoted fields in CSV imports'}});
  if(pathname.endsWith('/transcript'))return route.fulfill({json:transcript});
  if(pathname.endsWith('/progress'))return route.fulfill({json:{entries:[{seq:1,at:'2026-10-20T17:24:00Z',stage:'preparing',elapsed_s:0},{seq:2,at:'2026-10-20T17:25:00Z',stage:'agent',elapsed_s:60}]}});
  return route.fulfill({json:job});
 });
 await page.goto((await harness.link(own?'owner':'lender'))+'#/job/'+encodeURIComponent(digest)+'/'+circle.id);
 await expect(page.getByRole('heading',{level:1})).toContainText('quoted fields');
}
async function shot(page,name){if(process.env.RELAY_SHOTS){await mkdir(process.env.RELAY_SHOTS,{recursive:true});await page.screenshot({path:process.env.RELAY_SHOTS+'/'+name+'.png',fullPage:true});}}
for(const actor of ['borrower','lender'])for(const [width,height,size] of [[1440,900,'desktop'],[390,844,'phone']])for(const scheme of ['light','dark']) {
 test(`${actor} live relay ${size} ${scheme}`,async({page})=>{
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme});
  await open(page,actor,{text,live:true,truncated:false,available:true});
  await expect(page.getByRole('list',{name:'What the agent is doing'})).toBeVisible();
  await expect(page.locator('.feed')).toContainText('I found the parser issue');
  await expect(page.locator('.feed-tool.is-running')).toContainText('npm test');
  await expect(page.locator('.prog')).toHaveCount(0);
  await expect(page.locator('.job-timeline')).toHaveCount(0);
  await expect(page.getByText('The agent hasn’t reported anything yet.')).toHaveCount(0);
  if(actor==='lender'){await expect(page.getByText('Your agent is running Alex’s job',{exact:true})).toBeVisible();await expect(page.getByText('The prompt is not available in this view.')).toHaveCount(0);}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await shot(page,`${actor}-live-${size}-${scheme}`);
  if(process.env.RELAY_SHOTS){await page.locator('.activity').scrollIntoViewIfNeeded();await page.screenshot({path:process.env.RELAY_SHOTS+`/${actor}-live-${size}-${scheme}-viewport.png`});}
 });
 test(`${actor} older lender ${size} ${scheme}`,async({page})=>{
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme});
  await open(page,actor,{text:'',live:false,truncated:false,available:false,unavailable:'lender_version'});
  await expect(page.getByText(actor==='lender'?'Live activity isn’t shown for this job.':'Live activity isn’t available from this lender’s version.',{exact:false})).toBeVisible();
  if(actor==='lender')await expect(page.getByText('Progress reported by Mia’s computer.',{exact:true})).toHaveCount(0);
  await expect(page.locator('.activity-live')).toHaveCount(0);
  await shot(page,`${actor}-unavailable-${size}-${scheme}`);
 });
}

test('the borrower refreshes a running friend’s activity without reloading the page',async({page})=>{
 let reads=0;
 await open(page,'borrower',{text:'',live:true,truncated:false,available:true});
 await page.route('**/api/jobs/**/transcript?*',route=>route.fulfill({json:{text:++reads>1?text:'',live:true,truncated:false,available:true}}));
 await expect(page.locator('.feed')).toContainText('I found the parser issue',{timeout:15000});
 await expect(page.locator('.prog')).toHaveCount(0);
 expect(reads).toBeGreaterThan(1);
});

test('borrowers see project-relative paths from the relay projection',async({page})=>{
 const relay=createRelayTranscript();
 relay.append(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'I am reading the parser.'},{type:'tool_use',id:'read-parser',name:'Read',input:{file_path:'/workspace/src/parser.js'}}]}})+'\n');
 const snapshot=relay.snapshot();
 await open(page,'borrower',{...snapshot,live:true,available:true});
 await expect(page.locator('.feed')).toContainText('src/parser.js');
 await expect(page.locator('.feed')).not.toContainText('/workspace/');
 await expect(page.getByText('The agent hasn’t reported anything yet.')).toHaveCount(0);
 for(const [size,width,height] of [['desktop',1440,900],['phone',390,844]])for(const scheme of ['light','dark']){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme});
  await shot(page,`relay-paths-${size}-${scheme}`);
 }
});
