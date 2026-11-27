import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {startHarness} from './lib.mjs';
import {CONFIG_URL,PROJECT_TOKEN} from '../../ui/v1/src/posthog.mjs';
test.use({userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'});
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const id='f7c9f198-f634-419e-8617-59f82466d719';
const canary='PRIVATE_JOB_TITLE_91db';
async function fixture(page,{off=false,pending=false,replay=true,noticeGate=null,paired=false}={}) {
  const requests=[],events=[],scripts=[],errors=[];
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  let state={installId:off?null:id,consent:off?'off':'on',generation:1,remoteEnabled:!off,noticePending:pending};
  const view=()=>({level:off?'off':null,effective:state.noticePending?'off':state.consent,version:'0.1.0',reason:{kind:state.noticePending?'notice_pending':'default'},notice:{pending:state.noticePending},uploadable:true});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.resourceType()==='script')scripts.push(request.url());});
  await page.route('**/phone/api/inbox',route=>route.fulfill({json:{phone:{scopes:paired?['app:full']:[]}}}));
  await page.route('**/api/telemetry/bootstrap',route=>route.fulfill({json:state}));
  await page.route('**/api/telemetry',route=>route.fulfill({json:view()}));
  await page.route('**/api/telemetry/notice',async route=>{if(noticeGate)await noticeGate;state={...state,noticePending:false};return route.fulfill({json:view()});});
  await page.route('**/api/telemetry/choose',route=>{off=route.request().postDataJSON().level==='off';state={...state,consent:off?'off':'on',remoteEnabled:!off,installId:off?null:id,generation:state.generation+1};return route.fulfill({json:view()});});
  await page.route(/^https:\/\//,async route=>{
    const request=route.request();requests.push(request.url());
    if(request.url()===CONFIG_URL)return route.fulfill({json:{hasFeatureFlags:false,autocapture_opt_out:false,sessionRecording:replay?{enabled:true,endpoint:'/s/',sampleRate:1,minimumDurationMilliseconds:0}:false}});
    if(request.url().startsWith('https://us.i.posthog.com/')){if(request.postData())events.push(request.postDataJSON());return route.fulfill({json:{status:1}});}
    await route.abort();
  });
  // Exercise the human browser path; keep the SDK's production bot filter enabled.
  await page.addInitScript(()=>{Object.defineProperty(navigator,'webdriver',{get:()=>false});Object.defineProperty(navigator,'userAgentData',{get:()=>({brands:[{brand:'Chromium',version:'130'}]})});});
  await page.goto((await harness.link('lender'))+'#/you/data');
  await expect(page.getByRole('heading',{name:'Help improve Faravan'}).last()).toBeVisible();
  return {requests,events,scripts,errors,set:value=>{state={...state,...value};}};
}
test('built bundle uses hashed CSP, local scripts and closed page/control/replay payloads',async({page})=>{
  const f=await fixture(page);
  await expect.poll(()=>f.requests.length).toBeGreaterThan(0);
  const csp=await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toMatch(/script-src 'sha256-[^']+' blob:;/);
  expect(csp).toContain("connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com;");
  await page.evaluate(value=>{
    document.title=value;
    const privateRoot=document.createElement('div');privateRoot.className='ph-no-capture';privateRoot.dataset.telemetryPrivate='synthetic';
    privateRoot.innerHTML='<p>'+value+'</p><input value="'+value+'"><a href="https://private.invalid/'+value+'" title="'+value+'">'+value+'</a><svg><text>'+value+'</text></svg><div hidden>'+value+'</div>';document.body.append(privateRoot);
    const el=document.createElement('button');el.dataset.telemetryControl='open-search';el.textContent=value;document.body.append(el);el.click();
  },canary);
  await page.evaluate(()=>location.hash='#/jobs/private-id?secret=1');
  await expect.poll(()=>JSON.stringify({events:f.events,requests:f.requests,errors:f.errors})).toContain('$autocapture');
  await expect.poll(()=>JSON.stringify(f.events),{timeout:15000}).toContain('$snapshot');
  const payload=JSON.stringify(f.events);
  expect(payload).not.toContain(canary);expect(payload).not.toContain('private-id');expect(payload).not.toContain('secret=1');
  expect(f.events.some(e=>e.event==='$pageview' && e.properties.distinct_id===id)).toBe(true);
  for(const event of f.events){expect(event.properties.$geoip_disable).toBe(true);expect(event.properties.token).toBe(PROJECT_TOKEN);expect(event.properties.$title).toBeUndefined();}
  expect(f.scripts.every(url=>url.startsWith('blob:')||url.startsWith(new URL(page.url()).origin))).toBe(true);
  expect(f.requests.every(url=>url===CONFIG_URL||url.startsWith('https://us.i.posthog.com/'))).toBe(true);
  expect(f.errors).toEqual([]);
  await page.evaluate(()=>location.hash='#/you/data');
  await page.locator('input[value=off]').check();
  const count=f.requests.length;
  await page.evaluate(()=>{location.hash='#/lend';document.querySelector('[data-telemetry-control]')?.click();});
  await page.waitForTimeout(6000);expect(f.requests).toHaveLength(count);
});
test('OFF never initializes or contacts PostHog',async({page})=>{
  const f=await fixture(page,{off:true});await page.waitForTimeout(6000);expect(f.requests).toEqual([]);
});
test('pending notice prevents config request until the disclosure has rendered',async({page})=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(page,{pending:true,noticeGate:gate});
  await expect(page.getByRole('status',{name:'Usage reports'})).toBeVisible();
  await page.waitForTimeout(1000);expect(f.requests).toEqual([]);
  release();await expect.poll(()=>f.requests.length).toBeGreaterThan(0);
  expect(f.errors).toEqual([]);
});
test('pairing page has no SDK or Cloud requests',async({page})=>{
  const cloud=[];await page.route(/^https:\/\//,route=>{cloud.push(route.request().url());return route.abort();});
  const html=await readFile(new URL('../../public/phone/index.html',import.meta.url),'utf8');
  await page.route('http://pairing.invalid/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/'||path==='/index.html')return route.fulfill({body:html,contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'"}});
    if(path==='/phone/api/inbox')return route.fulfill({status:401,json:{code:'not_paired'}});
    try{return await route.fulfill({contentType:path.endsWith('.mjs')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream',body:await readFile(new URL('../../public/phone'+path,import.meta.url))});}catch{return route.fulfill({status:404});}
  });
  await page.goto('http://pairing.invalid/');await expect(page.locator('#app')).toHaveAttribute('data-screen','pair');expect(cloud).toEqual([]);
  expect(html).not.toContain('posthog');
});

test('paired full app is tagged from authenticated scope and remote replay OFF stays off',async({page})=>{
  const f=await fixture(page,{paired:true,replay:false});
  await expect.poll(()=>f.events.length).toBeGreaterThan(0);
  expect(f.events.every(event=>event.properties.device_class==='paired')).toBe(true);
  await page.waitForTimeout(6000);expect(f.events.some(event=>event.event==='$snapshot')).toBe(false);
  const violation=page.evaluate(()=>new Promise(resolve=>{
    document.addEventListener('securitypolicyviolation',event=>resolve(event.effectiveDirective),{once:true});
    const script=document.createElement('script');script.src='https://us-assets.i.posthog.com/forbidden.js';document.head.append(script);
  }));
  expect(await violation).toBe('script-src-elem');expect(f.requests.some(url=>url.endsWith('.js'))).toBe(false);
});
test('a remote stop discovered by the five-second check closes capture',async({page})=>{
  const f=await fixture(page);await expect.poll(()=>f.events.length).toBeGreaterThan(0);
  f.set({remoteEnabled:false});await page.waitForTimeout(5500);const count=f.requests.length;
  await page.evaluate(()=>{location.hash='#/lend';document.querySelector('[data-telemetry-control]')?.click();});
  await page.waitForTimeout(2500);expect(f.requests).toHaveLength(count);
});
test('turning ON after an OFF start creates a working SDK and masked recorder',async({page})=>{
  const f=await fixture(page,{off:true});expect(f.requests).toEqual([]);
  await page.locator('.telemetry-choices input[type=radio]').first().check();
  await expect.poll(()=>f.events.length).toBeGreaterThan(0);
  await page.locator('[data-telemetry-control="open-profile"]').first().click();
  await expect.poll(()=>JSON.stringify(f.events),{timeout:15000}).toContain('$snapshot');
  expect(f.events.every(event=>event.properties.distinct_id===id)).toBe(true);
});
