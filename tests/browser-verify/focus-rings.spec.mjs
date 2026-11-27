import {test, expect} from '@playwright/test';
import {mkdir, writeFile} from 'node:fs/promises';
import {startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const digest='sha256:'+'a'.repeat(64);
const job={job_digest:digest,state:'queued',local:{title:'Focus fixture',prompt:'Review focus'},circle:{id:'shared',name:'Friends'}};
for(const [device,viewport] of [['desktop',{width:1440,height:900}],['phone',{width:390,height:844}]])
for(const colorScheme of ['light','dark'])
test(`programmatic focus has no ring; keyboard controls keep rings (${device}, ${colorScheme})`,async({browser})=>{
  const context=await browser.newContext({viewport,colorScheme});
  const page=await context.newPage(), metrics=[];
  await page.route('**/api/circles',r=>r.fulfill({json:[{id:'shared',name:'Friends',origin:'http://fixture'}]}));
  await page.route('**/api/jobs',r=>r.fulfill({json:[job]}));
  await page.route(/\/api\/jobs\/[^/]+(?:\?.*)?$/,r=>r.fulfill({json:job}));
  await page.route('**/api/jobs/*/transcript*',r=>r.fulfill({json:{text:''}}));
  await page.goto((await harness.link('lender'))+'#/you');
  await page.getByRole('heading',{name:'You',level:1,exact:true}).waitFor();
  await mkdir('.uat/e2/focus-rings',{recursive:true});
  for(const [name,hash,title] of [['home','#/home','What would you like to get done?'],['jobs','#/jobs','Jobs'],['job-fixture','#/job/'+encodeURIComponent(digest)+'/shared','Focus fixture'],['lending','#/lend','Lending']]){
    await page.evaluate(hash=>{location.hash=hash;},hash);
    const heading=page.getByRole('heading',{name:title,level:1,exact:true});
    await expect(heading).toBeFocused();
    // The shell heading arrives before lending data. There are no page controls
    // in its loading skeleton, so Tab correctly leaves the document then.
    if(name==='lending')await expect(page.getByLabel('Loading',{exact:true})).toHaveCount(0);
    const headingRing=await heading.evaluate(el=>{const s=getComputedStyle(el);return {outline:s.outlineStyle,shadow:s.boxShadow};});
    expect(headingRing).toEqual({outline:'none',shadow:'none'});
    await page.screenshot({path:`.uat/e2/focus-rings/${name}.${device}.${colorScheme}.png`});
    await page.keyboard.press('Tab');
    const control=await page.evaluate(()=>{const el=document.activeElement,s=getComputedStyle(el);return {tag:el.tagName,role:el.getAttribute('role'),name:(el.getAttribute('aria-label')||el.textContent).trim().slice(0,60),visible:el.matches(':focus-visible'),outline:s.outlineStyle,width:s.outlineWidth};});
    expect(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY']).toContain(control.tag);
    expect(control.visible).toBe(true);expect(control.outline).not.toBe('none');expect(parseFloat(control.width)).toBeGreaterThanOrEqual(2);
    const notice=await page.evaluate(()=>{const el=document.querySelector('.notice');el.textContent='Focus fixture outcome';el.tabIndex=-1;el.focus();const s=getComputedStyle(el);return {outline:s.outlineStyle,shadow:s.boxShadow};});
    expect(notice).toEqual({outline:'none',shadow:'none'});
    metrics.push({page:name,headingRing,control,notice});
  }
  await writeFile(`.uat/e2/focus-rings/results.${device}.${colorScheme}.json`,JSON.stringify(metrics,null,2));
  await context.close();
});

test('Limits receives focus when its heading arrives after route navigation',async({page})=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});
 await page.route('**/api/home',async route=>{await pending;await route.fulfill({json:{lending:{enabled:false,limits:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,quotaReserve:30}}}}).catch(()=>{});});
 await page.goto((await harness.link('lender'))+'#/you');await page.getByRole('heading',{name:'You',level:1,exact:true}).waitFor();
 await page.evaluate(()=>{document.querySelector('.notice').textContent='Previous outcome';document.querySelector('.notice').tabIndex=-1;document.querySelector('.notice').focus();location.hash='#/lend/limits';});
 await page.getByLabel('Loading what you lend').waitFor();await expect(page.locator('main')).toBeFocused();release();
 await expect(page.getByRole('heading',{name:'What you lend',level:1,exact:true})).toBeFocused();
});
