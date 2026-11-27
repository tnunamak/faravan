import {test,expect} from '@playwright/test';
import {projectJobFixture, startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
test('Updates shows ownership, checks without a restart, and keeps a candidate visible',async({page})=>{
 let checks=0;
 await page.route('**/api/updates',route=>route.fulfill({json:{owner:'faravan',state:'idle',currentVersion:'1.0.0',automatic:true}}));
 await page.route('**/api/updates/check',route=>{checks++;return route.fulfill({json:{owner:'faravan',state:'available',currentVersion:'1.0.0',candidate:'1.1.0',checkedAt:'2026-10-20T12:00:00Z',notes:['Keep your browser signed in','Pair a device'],automatic:true}});});
 await page.goto((await harness.link('owner'))+'#/you/updates');
 await expect(page.getByText('Updates install by themselves between jobs.')).toBeVisible();
 await page.getByRole('button',{name:'Check now',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Faravan 1.1.0 is available',exact:true})).toBeVisible();
 expect(checks).toBe(1);await expect(page.getByRole('button',{name:/Restart/})).toHaveCount(0);
 await expect(page.getByText('Keep your browser signed in')).toBeVisible();
});
test('an apt install directs updates to the package manager',async({page})=>{
 await page.route('**/api/updates',route=>route.fulfill({json:{owner:'apt',state:'managed',currentVersion:'1.0.0',automatic:false}}));
 await page.goto((await harness.link('owner'))+'#/you/updates');
 await expect(page.getByText(/Managed by apt/)).toBeVisible();await expect(page.getByRole('button',{name:'Check now'})).toHaveCount(0);
});
test('a terminal job does not redraw its diff on a one-second clock',async({page})=>{
 let instrumented=false;
 await page.route('**/app.mjs',async route=>{const response=await route.fetch();const body=(await response.text()).replace(/(function [\w$]+\(\{ id: [\w$]+, requestedCircle:[^\n]+\n)/,match=>{instrumented=true;return match+'globalThis.__jobRenders=(globalThis.__jobRenders||0)+1;\n';});await route.fulfill({response,body});});
 // Keep the event stream healthy so this measures the component clock, independent of connection changes.
 await page.addInitScript(()=>{
  const original=window.fetch;
  window.fetch=(input,options)=>String(input).includes('/api/events')
   ?Promise.resolve(new Response(new ReadableStream(),{headers:{'content-type':'text/event-stream'}}))
   :original(input,options);
 });
 await page.route('**/api/jobs',route=>route.fulfill({json:[]}));
 await page.route('**/api/circles',route=>route.fulfill({json:[{id:'clock',name:'Clock test',origin:'http://fixture'}]}));
 await page.route('**/api/jobs/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({json:path.endsWith('/changes')?{format:'diff',files:[],diff:''}:path.endsWith('/transcript')?{text:'Done'}:path.endsWith('/retention')?{}:projectJobFixture({job_digest:'sha256:'+'a'.repeat(64),state:'result-accepted',status:'Finished',result_digest:'sha256:'+'b'.repeat(64),local:{title:'Clock measurement'}})});});
 await page.goto((await harness.link('owner'))+'#/job/'+encodeURIComponent('sha256:'+'a'.repeat(64))+'/clock');
 await expect(page.getByRole('heading',{level:1,name:'Clock measurement'})).toBeVisible();await page.waitForTimeout(1500);
 expect(instrumented).toBe(true);const before=await page.evaluate(()=>globalThis.__jobRenders);await page.waitForTimeout(3200);
 expect(await page.evaluate(()=>globalThis.__jobRenders)).toBe(before);
});

test('Settings search stays within the local interaction and layout budgets',async({page})=>{
 await page.goto((await harness.link('owner'))+'#/you/all');
 await expect(page.getByRole('searchbox',{name:'Search settings'})).toBeVisible();
 await page.evaluate(()=>document.fonts.ready);
 await page.evaluate(()=>{
  window.__shellTimings=[];window.__shellCLS=0;
  window.__shellObserver=new PerformanceObserver(list=>{for(const e of list.getEntries())if(!e.hadRecentInput)window.__shellCLS+=e.value;});
  window.__shellObserver.observe({type:'layout-shift',buffered:false});
  document.querySelector('[aria-label="Search settings"]').addEventListener('input',event=>{
   if(!event.isTrusted)return;
   const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__shellTimings.push(performance.now()-start)));
  });
 });
 const search=page.getByRole('searchbox',{name:'Search settings'});await search.focus();
 for(const text of ['quota','computer','minutes','theme','approval','agent','hours','name','updates']) {
  await page.keyboard.press('Control+a');await page.keyboard.type(text);await page.waitForTimeout(50);
 }
 const measurement=await page.evaluate(()=>{
  for(const e of window.__shellObserver.takeRecords())if(!e.hadRecentInput)window.__shellCLS+=e.value;
  window.__shellObserver.disconnect();const times=window.__shellTimings.sort((a,b)=>a-b);
  return {p95:times[Math.ceil(times.length*.95)-1],cls:window.__shellCLS,count:times.length};
 });
 expect(measurement.count).toBeGreaterThan(20);
 expect(measurement.p95).toBeLessThanOrEqual(100);expect(measurement.cls).toBeLessThanOrEqual(.1);
});

test('Device connection settings can configure HTTPS before access is enabled',async({page})=>{
 const view={enabled:false,address:null,hostname:null,certFile:null,keyFile:null,https:false,origin:null,
  reach:{state:'off',headline:'Device access is off',facts:[]},addresses:[{address:'10.23.1.20',interface:'wlan0',kind:'lan'},{address:'100.64.0.2',interface:'private0',kind:'tailnet'}],phones:[],pairing:null};
 let saved;
 await page.route('**/api/events**',()=>new Promise(()=>{}));
 await page.route('**/api/phone',route=>route.fulfill({json:view}));
 await page.route('**/api/phone/settings',async route=>{saved=route.request().postDataJSON();await route.fulfill({json:{...view,...saved}});});
 await page.goto((await harness.link('owner'))+'#/you/phone');
 await page.getByText('Connection settings',{exact:true}).click();
 await page.getByLabel('Private network address').selectOption('100.64.0.2');
 await page.getByLabel('Host name').fill('faravan.home.example');
 await page.getByLabel('Certificate file',{exact:true}).fill('/example/certificate.pem');
 await page.getByLabel('Private key file',{exact:true}).fill('/example/key.pem');
 await page.getByRole('button',{name:'Save connection'}).click();
 await expect.poll(()=>saved).toEqual({enabled:false,address:'100.64.0.2',hostname:'faravan.home.example',certFile:'/example/certificate.pem',keyFile:'/example/key.pem'});
 await page.getByRole('button',{name:'Turn on device access'}).click();
 await expect.poll(()=>saved?.enabled).toBe(true);
 expect(saved.certFile).toBe('/example/certificate.pem');
});
