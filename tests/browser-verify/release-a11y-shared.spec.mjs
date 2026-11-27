import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {test,chromium} from '@playwright/test';
import {api, appFixture} from '../helpers/v1-app-fixture.mjs';
import {withRequestAdmission} from './lib.mjs';

const assetDir = process.env.RELEASE_A11Y_ASSET_DIR ?? 'public/v1';
const evidenceDir = process.env.RELEASE_A11Y_EVIDENCE_DIR ?? 'test-artifacts/release-a11y-shared';
const viewports = [{width:390,height:844},{width:320,height:640}];
const themes = ['light','dark'];
const syntheticDevices=route=>route.fulfill({json:{name:'Synthetic computer',ownerName:'Synthetic person',fingerprint:'synthetic-device',circles:[]}});
let cleanups=[];
test.beforeEach(()=>{cleanups=[];});
test.afterEach(async()=>{for(const cleanup of cleanups.reverse())await cleanup();});
const startFixture=()=>appFixture({after:cleanup=>cleanups.push(cleanup)});

async function fixturePage(browser, assets, fixture, app, hash, viewport, theme, extraRoutes=[]) {
  const context = await browser.newContext({viewport, colorScheme:theme});
  const page = await context.newPage();
  await page.route('**/app.mjs', route => route.fulfill({status:200,contentType:'text/javascript',body:assets.module}));
  await page.route('**/app.css', route => route.fulfill({status:200,contentType:'text/css',body:assets.css}));
  for(const [pattern,handler] of extraRoutes)await page.route(pattern,handler);
  await page.goto(app.url + hash);
  await page.getByRole('main').waitFor({state:'visible'});
  return {context,page};
}

async function capture(page, name, detail) {
  await mkdir(evidenceDir,{recursive:true});
  await page.screenshot({path:`${evidenceDir}/${name}.png`,fullPage:false,animations:'disabled'});
  await writeFile(`${evidenceDir}/${name}.json`,JSON.stringify(detail,null,2)+'\n');
}

async function tabTrace(page, target) {
  const read=()=>page.evaluate(()=>{
    const el=document.activeElement,r=el.getBoundingClientRect(),bar=document.querySelector('.tabbar'),visible=getComputedStyle(bar).display!=='none',barRect=bar.getBoundingClientRect();
    return {label:el.getAttribute('aria-label')||el.textContent.trim(),rect:{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom},barTop:visible?barRect.top:innerHeight,navVisible:visible,
      points:[0,.5,1].flatMap(x=>[0,.5,1].map(y=>!visible||document.elementFromPoint(r.left+r.width*x,r.top+r.height*y)?.closest('.tabbar')===null))};
  });
  await target.focus();const focused=await read();
  await page.keyboard.press('Shift+Tab');const reverse=await read();
  await page.keyboard.press('Tab');const forward=await read();
  return {focused,reverse,forward};
}

test('bare composer Send clears the phone navigation at both target sizes and themes',async()=>{
  const assets={module:await readFile(`${assetDir}/app.mjs`),css:await readFile(`${assetDir}/app.css`)};
  const fixture=await startFixture(),{app}=await fixture.start('lender'),browser=await chromium.launch({headless:true}),cases=[];
  try{
    for(const viewport of viewports)for(const theme of themes){
      const {context,page}=await fixturePage(browser,assets,fixture,app,'#/new',viewport,theme,[['**/api/devices',syntheticDevices]]);
      try{
        const send=page.getByRole('button',{name:'Send',exact:true});await send.focus();
        const result=await page.evaluate(()=>{const el=document.activeElement,r=el.getBoundingClientRect(),bar=document.querySelector('.tabbar').getBoundingClientRect();return {viewport:{width:innerWidth,height:innerHeight},theme:document.documentElement.dataset.theme||getComputedStyle(document.documentElement).colorScheme,target:{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom},barTop:bar.top,points:[0,.5,1].flatMap(x=>[0,.5,1].map(y=>document.elementFromPoint(r.left+r.width*x,r.top+r.height*y)?.closest('.tabbar')===null))};});
        await page.keyboard.press('Shift+Tab');const reverse=await page.evaluate(()=>{const r=document.activeElement.getBoundingClientRect();return {label:document.activeElement.textContent.trim(),bottom:r.bottom,barTop:document.querySelector('.tabbar').getBoundingClientRect().top};});
        await page.keyboard.press('Tab');const forward=await page.evaluate(()=>{const r=document.activeElement.getBoundingClientRect();return {label:document.activeElement.textContent.trim(),bottom:r.bottom,barTop:document.querySelector('.tabbar').getBoundingClientRect().top};});
        const name=`m2-bare-send-${viewport.width}x${viewport.height}-${theme}`;await capture(page,name,{...result,reverse,forward});cases.push({name,...result,reverse,forward});
      }finally{await context.close();}
    }
  }finally{await browser.close();}
  assert.ok(cases.every(item=>item.target.bottom<=item.barTop&&item.points.every(Boolean)&&item.reverse.bottom<=item.reverse.barTop&&item.forward.bottom<=item.forward.barTop),`Send focus is hidden by the phone navigation: ${JSON.stringify(cases)}`);
});

test('shared phone navigation leaves focused page controls visible in both directions', async () => {
  const assets = {module:await readFile(`${assetDir}/app.mjs`),css:await readFile(`${assetDir}/app.css`)};
  const fixture=await startFixture(),{app}=await fixture.start('lender');
  const browser=await chromium.launch({headless:true});
  const cases=[];
  try {
    const circle={id:'shared',name:'Synthetic review circle',origin:'http://fixture'},digest='sha256:'+'a'.repeat(64);
    const approval=withRequestAdmission({id:'synthetic-approval',jobDigest:digest,requester:'synthetic-requester',requesterName:'Synthetic friend',prompt:'Review the synthetic project.',harness:'codex',model:[],runtimeSeconds:1200,
      source:{kind:'archive',size_bytes:1},network:'provider-only',protection:{satisfied:true,enforced:[],unenforced:[]},identity:{memberPresent:true,rosterFresh:true,rootMatches:true,circleMatches:true},
      expiresAt:Date.now()+600000,job:{circle:circle.id,requirements:{egress:'provider-only',limits:{wall_seconds:1200}}}},
      {usage:{jobs:0,jobLimit:3,minutes:0,minuteLimit:60},accountedMilliseconds:0,dailyMinutes:60,now:Date.now()});
    const fixtureRoutes=[
      ['**/api/circles',route=>route.fulfill({json:[circle]})],
      ['**/api/agents',route=>route.fulfill({json:[{id:'codex',installed:true,signedIn:true,useForLending:true}]})],
      ['**/api/readiness',route=>route.fulfill({json:{ready:true,checks:[]}})],
      ['**/api/approvals',route=>route.fulfill({json:[approval]})],
      ['**/api/devices',route=>route.fulfill({json:{name:'Synthetic computer',ownerName:'Synthetic person',fingerprint:'synthetic-device',circles:[]}})],
      ['**/api/jobs',route=>route.fulfill({json:[]})],
      ['**/api/home',async route=>{
        const response=await route.fetch(),body=await response.json();
        const json={...body,state:'ready',lending_blockers:null,intent:{on:true,state:'ready'},execution:{state:'idle'},lending:{...body.lending,enabled:true,paused:false,circle:circle.id,current:null,status:'idle',mode:'ask'},lendingPolicy:{...body.lendingPolicy,accounts:[],providerConsent:{...body.lendingPolicy?.providerConsent,codex:true}}};
        await route.fulfill({response,json});
      }],
    ];
    for (const viewport of viewports) for (const theme of themes) {
      const {context,page}=await fixturePage(browser,assets,fixture,app,'#/new',viewport,theme,fixtureRoutes);
      try {
        await page.getByRole('button',{name:/Send/}).last().focus();
        const first=await page.evaluate(()=>({
          active:document.activeElement?.textContent?.trim(),
          target:(()=>{const r=document.activeElement.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}})(),
          bar:(()=>{const r=document.querySelector('.tabbar').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,bottom:r.bottom}})(),
          hit:(()=>{const r=document.activeElement.getBoundingClientRect();return [0,.5,1].flatMap(x=>[0,.5,1].map(y=>document.elementFromPoint(r.left+r.width*x,r.top+r.height*y)?.closest('.tabbar')===null))})()
        }));
        await page.keyboard.press('Shift+Tab');
        const reverse=await page.evaluate(()=>({label:document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent?.trim(),target:(()=>{const r=document.activeElement.getBoundingClientRect();return {y:r.y,bottom:r.bottom}})(),barTop:document.querySelector('.tabbar').getBoundingClientRect().top}));
        await page.keyboard.press('Tab');
        const forward=await page.evaluate(()=>({label:document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent?.trim(),target:(()=>{const r=document.activeElement.getBoundingClientRect();return {y:r.y,bottom:r.bottom}})(),barTop:document.querySelector('.tabbar').getBoundingClientRect().top}));
        const name=`m2-${viewport.width}x${viewport.height}-${theme}`;
        await capture(page,name+'-send',{viewport,theme,send:first,reverse,forward});
        if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
        await page.getByRole('radio',{name:'No project',exact:true}).check();
        const projectSettings=await tabTrace(page,page.getByRole('button',{name:'Project settings: No project',exact:true}));
        await capture(page,name+'-project-settings',{viewport,theme,projectSettings});
        await page.goto(app.url+'#/lend/limits');
        const stopOnReturn=await tabTrace(page,page.getByRole('switch',{name:'Stop a running job when I return'}));
        await capture(page,name+'-stop-on-return',{viewport,theme,stopOnReturn});
        await page.goto(app.url+'#/home');
        const home=page.getByRole('region',{name:'Needs your attention'});
        const homeActions={review:await tabTrace(page,home.getByRole('link',{name:'Review',exact:true}))};
        const homeNotNow=home.getByRole('button',{name:'Not now',exact:true});
        if(await homeNotNow.isVisible().catch(()=>false))homeActions.notNow=await tabTrace(page,homeNotNow);
        await capture(page,name+'-home-decisions',{viewport,theme,homeActions});
        await page.goto(app.url+'#/request/synthetic-approval');
        const requestActions={run:await tabTrace(page,page.getByRole('button',{name:'Run it',exact:true})),notNow:await tabTrace(page,page.getByRole('button',{name:'Not now',exact:true}))};
        await capture(page,name+'-job-review',{viewport,theme,requestActions});
        cases.push({name,first,reverse,forward,projectSettings,stopOnReturn,homeActions,requestActions});
      } finally {await context.close();}
    }
    const landscape={width:640,height:400};
    const {context:landscapeContext,page:landscapePage}=await fixturePage(browser,assets,fixture,app,'#/home',landscape,'light',fixtureRoutes);
    try{
      const navigation=await landscapePage.evaluate(()=>({display:getComputedStyle(document.querySelector('.tabbar')).display,scrollPadding:getComputedStyle(document.documentElement).scrollPaddingBlockEnd,pagePadding:getComputedStyle(document.querySelector('.page')).paddingBottom}));
      await capture(landscapePage,'m2-landscape-640x400',{viewport:landscape,theme:'light',navigation});
      assert.equal(navigation.display,'none','short landscape keeps its existing hidden navigation');
      assert.ok(['auto','0px'].includes(navigation.scrollPadding),'short landscape must not reserve hidden navigation space');
      assert.equal(navigation.pagePadding,'32px','short landscape keeps its existing page inset');
    }finally{await landscapeContext.close();}
  } finally {await browser.close();}
  const visible=state=>state.rect.bottom<=state.barTop&&state.points.every(Boolean);
  const tabStops=trace=>[trace.reverse,trace.forward];
  assert.ok(cases.every(({first,reverse,forward,projectSettings,stopOnReturn,homeActions,requestActions})=>first.target.bottom<=first.bar.top&&first.hit.every(Boolean)&&reverse.target.bottom<=reverse.barTop&&forward.target.bottom<=forward.barTop&&[projectSettings,stopOnReturn,...Object.values(homeActions).filter(Boolean),...Object.values(requestActions)].flatMap(tabStops).every(visible)),`phone navigation hides keyboard focus: ${JSON.stringify(cases)}`);
});

test('enabled light off switch has a 3:1 visible boundary and dark state remains distinct', async () => {
  const assets = {module:await readFile(`${assetDir}/app.mjs`),css:await readFile(`${assetDir}/app.css`)};
  const fixture=await startFixture();
  const {app}=await fixture.start('lender');
  const browser=await chromium.launch({headless:true});
  const cases=[];
  try {
    for (const viewport of viewports) for (const theme of themes) {
      const {context,page}=await fixturePage(browser,assets,fixture,app,'#/lend',viewport,theme,[['**/api/devices',syntheticDevices]]);
      try {
        const control=page.locator('.switch[aria-checked="false"]').first();
        await control.waitFor({state:'visible'});
        await control.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        const metrics=await control.evaluate(el=>{
          const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
          const lum=color=>{const c=rgb(color).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];};
          const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
          const track=getComputedStyle(el).backgroundColor, knob=getComputedStyle(el,'::after').backgroundColor;
          const surface=getComputedStyle(el.closest('.card')||document.body).backgroundColor;
          const r=el.getBoundingClientRect();
          return {track,knob,surface,checked:el.getAttribute('aria-checked'),focusVisible:el.matches(':focus-visible'),outline:{style:getComputedStyle(el).outlineStyle,color:getComputedStyle(el).outlineColor},trackSurface:ratio(track,surface),knobTrack:ratio(knob,track),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
        });
        await capture(page,`m4-${viewport.width}x${viewport.height}-${theme}`,{viewport,theme,...metrics});
        cases.push({viewport,theme,...metrics});
      } finally {await context.close();}
    }
  } finally {await browser.close();}
  assert.ok(cases.filter(item=>item.theme==='light').every(item=>item.trackSurface>=3||item.knobTrack>=3),`light off switch boundary below 3:1: ${JSON.stringify(cases.filter(item=>item.theme==='light'))}`);
  assert.ok(cases.filter(item=>item.theme==='dark').every(item=>item.knobTrack>=3),`dark off switch knob lacks contrast: ${JSON.stringify(cases.filter(item=>item.theme==='dark'))}`);
  assert.ok(cases.every(item=>item.checked==='false'&&item.focusVisible&&item.outline.style!=='none'),`off-switch keyboard focus or state was lost: ${JSON.stringify(cases)}`);
});

test('owned circle tabs reflow at 320px and preserve arrow-key selection', async () => {
  const assets = {module:await readFile(`${assetDir}/app.mjs`),css:await readFile(`${assetDir}/app.css`)};
  const fixture=await startFixture();
  const {app}=await fixture.start('lender');
  await fixture.provisionFromHome('lender');
  const circle=await api(app,'/api/circles',{method:'POST',body:{origin:fixture.origin,name:'Synthetic accessibility circle'}});
  const browser=await chromium.launch({headless:true});
  const cases=[];
  try {
    for (const theme of themes) {
      const viewport={width:320,height:640};
      const {context,page}=await fixturePage(browser,assets,fixture,app,'#/circle/'+encodeURIComponent(circle.id),viewport,theme);
      try {
        const tabs=page.getByRole('tablist',{name:'Circle sections'});
        await tabs.waitFor({state:'visible'});
        const before=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,tabs:[...document.querySelectorAll('[role=tab]')].map(el=>{const r=el.getBoundingClientRect();return {label:el.textContent.trim(),x:r.x,right:r.right,width:r.width}})}));
        await tabs.getByRole('tab',{name:'Members'}).focus();
        await page.keyboard.press('ArrowRight');
        const selected=await tabs.getByRole('tab',{name:'Activity'}).evaluate(el=>({selected:el.getAttribute('aria-selected'),focused:el===document.activeElement}));
        await capture(page,`m5-320x640-${theme}`,{viewport,theme,...before,selected});
        cases.push({theme,...before,selected});
      } finally {await context.close();}
    }
  } finally {await browser.close();}
  assert.ok(cases.every(item=>item.scroll<=item.viewport&&item.tabs.every(tab=>tab.x>=0&&tab.right<=320)),`owned circle tabs overflow at 320px: ${JSON.stringify(cases)}`);
  assert.ok(cases.every(item=>item.selected.selected==='true'&&item.selected.focused),`circle arrow-key selection or focus changed: ${JSON.stringify(cases)}`);
});
