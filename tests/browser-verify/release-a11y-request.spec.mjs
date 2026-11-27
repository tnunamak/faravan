import {test, expect} from '@playwright/test';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture} from '../helpers/v1-app-fixture.mjs';

const evidenceDir = process.env.RELEASE_A11Y_EVIDENCE_DIR;
const assetDir = process.env.RELEASE_A11Y_ASSET_DIR;
const cases = [
  {width:320,height:640,name:'320x640'},
  {width:390,height:844,name:'390x844'},
];
const themes = ['light','dark'];

for (const width of [1440,390]) for (const transition of ['error->run','run->taken','run->error'])
test(`decision focus follows ${transition} at ${width}px`,async({browser})=>{
  const run=await startRequest(browser,{width,height:844,name:String(width)},'light','decision-focus');
  let release,attempts=0;
  await run.page.route('**/api/approvals/release-a11y-request/accept',async route=>{
    attempts++;
    if(transition==='error->run'&&attempts===1)return route.fulfill({status:503,json:{code:'operation_failed'}});
    const response=await new Promise(resolve=>{release=resolve;});
    await route.fulfill(response).catch(()=>{});
  });
  try {
    const activate=async()=>{await run.page.getByRole('button',{name:'Run it',exact:true}).focus();await run.page.keyboard.press('Enter');};
    await activate();
    if(transition==='error->run') {
      await expect(run.page.locator('.rq-answer-error')).toBeVisible();
      await activate();
      await expect(run.page.locator('.rq-state')).toBeFocused();
    } else {
      await expect(run.page.locator('.rq-state')).toBeFocused();
      await expect.poll(()=>Boolean(release)).toBe(true);
      release(transition==='run->taken'?{status:409,json:{code:'job_taken',taker:'Synthetic friend'}}:{status:503,json:{code:'operation_failed'}});
      const target=run.page.locator(transition==='run->taken'?'.rq-state':'.rq-answer-error');
      if(transition==='run->taken')await expect(run.page.getByRole('link',{name:'Back to Home',exact:true})).toBeVisible();
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport({ratio:1});
    }
  } finally {
    release?.({status:503,json:{code:'operation_failed'}});
    await run.context.close();await Promise.all(run.cleanup.reverse().map(fn=>fn()));
  }
});

for (const viewport of [{width:1440,height:900,name:'desktop'},{width:390,height:844,name:'phone'}]) for (const theme of themes)
test(`expiry scrolls a removed-control focus handoff into view ${viewport.name} ${theme}`,async({browser})=>{
  const run=await startRequest(browser,viewport,theme,'expiry-scroll',true);
  try {
    await focusWithTab(run.page,'.rq-run-action button');
    await run.page.evaluate(()=>{
      document.body.style.paddingBottom='2000px';
      scrollTo(0,document.documentElement.scrollHeight);
    });
    await run.page.clock.runFor(2500);
    const state=run.page.locator('.rq-state');
    await expect(state).toBeFocused();
    await expect(state).toBeInViewport({ratio:1});
    await saveEvidence(run.page,`expiry-scroll-${viewport.name}-${theme}`,await state.evaluate(el=>{
      const box=el.getBoundingClientRect();return {top:box.top,bottom:box.bottom,viewportHeight:innerHeight,focused:el===document.activeElement};
    }));
  } finally {await run.context.close();await Promise.all(run.cleanup.reverse().map(fn=>fn()));}
});

async function startRequest(browser, viewport, theme, suffix, expireSoon=false) {
  const cleanup = [];
  const fixture = await appFixture({after:fn=>cleanup.push(fn)});
  const lender = await fixture.start('lender');
  const context = await browser.newContext({viewport:{width:viewport.width,height:viewport.height},colorScheme:theme});
  const page = await context.newPage();
  const expiresAt = Date.now() + 120_000;
  const card = {
    id:'release-a11y-request',jobDigest:'sha256:'+'a'.repeat(64),requester:'fixture-sender',requesterName:'Example Member',
    prompt:'Review the synthetic release fixture.',harness:'codex',model:[],source:{kind:'none'},runtimeSeconds:1200,
    expiresAt,network:'provider-only',protection:{satisfied:true,enforced:[],unenforced:[]},
    identity:{memberPresent:true,rosterFresh:true,rootMatches:true,circleMatches:true},
    job:{circle:'fixture-circle',requirements:{limits:{wall_seconds:1200}}},
    requestAdmission:{schemaVersion:2,kind:'request-admission',admission:'allowed',reasonCode:null,
      evidence:{jobCap:null,minuteCap:null}},
  };
  if (assetDir) {
    const [module,css] = await Promise.all(['app.mjs','app.css'].map(name=>readFile(join(assetDir,name))));
    await page.route('**/app.mjs',route=>route.fulfill({status:200,contentType:'text/javascript',body:module}));
    await page.route('**/app.css',route=>route.fulfill({status:200,contentType:'text/css',body:css}));
  }
  await page.route('**/api/approvals',route=>route.fulfill({json:[card]}));
  await page.route('**/api/devices',async route=>{
    const response=await route.fetch(),data=await response.json();
    await route.fulfill({response,json:{...data,name:'Fixture Computer',ownerName:'Fixture Owner'}});
  });
  await page.addInitScript(()=>{
    window.__releasePointerCount=0;
    for(const type of ['pointerdown','mousedown','touchstart'])addEventListener(type,()=>window.__releasePointerCount++,true);
  });
  await page.clock.install({time:new Date()});
  await page.goto(lender.app.url+'#/request/release-a11y-request');
  await expect(page.getByRole('button',{name:'Run it'})).toBeVisible();
  if(expireSoon)await page.clock.pauseAt(new Date(expiresAt-1_000));
  return {page,context,fixture,cleanup,card,suffix};
}

async function focusWithTab(page, selector) {
  for(let i=0;i<100;i++) {
    if(await page.evaluate(sel=>document.activeElement?.matches(sel),selector))return i;
    await page.keyboard.press('Tab');
  }
  throw new Error('Keyboard could not reach '+selector);
}

async function saveEvidence(page, name, record) {
  if(!evidenceDir)return;
  await mkdir(evidenceDir,{recursive:true});
  await page.screenshot({path:join(evidenceDir,name+'.png'),fullPage:false,animations:'disabled'});
  await writeFile(join(evidenceDir,name+'.json'),JSON.stringify(record,null,2)+'\n');
}

async function discloseGeometry(page, summary) {
  return page.evaluate(label=>{
    const target=[...document.querySelectorAll('.rq-more summary')].find(node=>node.textContent.trim()===label);
    const rect=target.getBoundingClientRect(), points=[];
    for(const fx of [.15,.5,.85])for(const fy of [.15,.5,.85]) {
      const x=rect.left+rect.width*fx,y=rect.top+rect.height*fy,hit=document.elementFromPoint(x,y);
      points.push({x,y,hit:hit?.tagName??null,inside:target.contains(hit)});
    }
    const focus=getComputedStyle(target);
    return {label,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,top:rect.top,bottom:rect.bottom},
      focused:document.activeElement===target,withinViewport:rect.top>=0&&rect.bottom<=innerHeight,points,
      focusVisible:target.matches(':focus-visible'),focusRing:{width:focus.outlineWidth,style:focus.outlineStyle,color:focus.outlineColor},
      interceptedPoints:points.filter(point=>!point.inside).length};
  },summary);
}

for (const viewport of cases) for (const theme of themes) {
  test(`M1 disclosure focus stays visible and hit-testable at ${viewport.name} ${theme}`,async({browser})=>{
    const run=await startRequest(browser,viewport,theme,'m1');
    try {
      const summaries=run.page.locator('.rq-more summary');
      const geometries=[];
      for(const label of ['Protection details','Details']) {
        const selector=label==='Details'?'.rq-more details:nth-child(2) summary':'.rq-more details:nth-child(1) summary';
        const steps=await focusWithTab(run.page,selector);
        await run.page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
        const geometry=await discloseGeometry(run.page,label);
        await saveEvidence(run.page,`m1-${viewport.name}-${theme}-${label.toLowerCase().replaceAll(' ','-')}`,{viewport,theme,steps,geometry});
        geometries.push(geometry);
      }
      for(const geometry of geometries) {
        expect(geometry.focused,`${geometry.label} keeps keyboard focus`).toBe(true);
        expect(geometry.focusVisible,`${geometry.label} shows keyboard focus`).toBe(true);
        expect(geometry.focusRing.width).toBe('2px');
        expect(geometry.focusRing.style).toBe('solid');
        expect(geometry.withinViewport,`${geometry.label} is fully in view at maximum scroll`).toBe(true);
        expect(geometry.interceptedPoints,`${geometry.label} hit points are not covered`).toBe(0);
      }
      const shell=await run.page.evaluate(()=>({dock:document.body.dataset.dock??null,
        tabbarVisible:getComputedStyle(document.querySelector('.tabbar')).display!=='none'}));
      await saveEvidence(run.page,`m1-shell-${viewport.name}-${theme}`,{viewport,theme,shell});
      expect(shell.dock).toBe(null);
      expect(shell.tabbarVisible).toBe(true);
      expect(await run.page.evaluate(()=>window.__releasePointerCount)).toBe(0);
    } finally {await run.context.close();await Promise.all(run.cleanup.reverse().map(fn=>fn()));}
  });

  for (const target of ['Protection details','Details']) test(`M3 expiry preserves focus on ${target} at ${viewport.name} ${theme}`,async({browser})=>{
    const run=await startRequest(browser,viewport,theme,'m3',true);
    try {
      const selector=target==='Details'?'.rq-more details:nth-child(2) summary':'.rq-more details:nth-child(1) summary';
      await focusWithTab(run.page,selector);
      const before=await run.page.evaluate(()=>({text:document.activeElement.textContent.trim(),tag:document.activeElement.tagName}));
      await run.page.clock.runFor(2500);
      await expect(run.page.locator('.rq-decide .rq-state')).toContainText(/This request expired/);
      const state=await run.page.evaluate(()=>({activeText:document.activeElement.textContent.trim(),activeTag:document.activeElement.tagName,
        activeConnected:document.activeElement.isConnected,liveCount:document.querySelectorAll('.rq-decide [role=status][aria-live=polite]').length,
        asideLive:document.querySelector('.rq-decide').getAttribute('aria-live'),
        announcement:document.querySelector('.rq-decide [role=status][aria-live=polite]')?.textContent.trim()??'',pointerCount:window.__releasePointerCount}));
      await saveEvidence(run.page,`m3-survive-${target.toLowerCase().replaceAll(' ','-')}-${viewport.name}-${theme}`,{viewport,theme,target,before,state});
      expect(state.activeText).toBe(before.text);
      expect(state.liveCount).toBe(1);
      expect(state.asideLive).toBe(null);
      expect(state.announcement).toMatch(/This request expired/);
      expect(state.pointerCount).toBe(0);
    } finally {await run.context.close();await Promise.all(run.cleanup.reverse().map(fn=>fn()));}
  });

  test(`M3 expiry hands focus off when Run it disappears at ${viewport.name} ${theme}`,async({browser})=>{
    const run=await startRequest(browser,viewport,theme,'m3-run',true);
    try {
      await focusWithTab(run.page,'.rq-run-action button');
      await expect(run.page.getByRole('button',{name:'Run it'})).toBeFocused();
      await run.page.clock.runFor(2500);
      await expect(run.page.getByRole('button',{name:'Run it'})).toHaveCount(0);
      const state=await run.page.evaluate(()=>({activeClass:document.activeElement.className,activeText:document.activeElement.textContent.trim(),
        liveCount:document.querySelectorAll('.rq-decide [role=status][aria-live=polite]').length,pointerCount:window.__releasePointerCount,
        asideLive:document.querySelector('.rq-decide').getAttribute('aria-live'),
        focusVisible:document.activeElement.matches(':focus-visible'),focusRing:{width:getComputedStyle(document.activeElement).outlineWidth,
          style:getComputedStyle(document.activeElement).outlineStyle,color:getComputedStyle(document.activeElement).outlineColor}}));
      await saveEvidence(run.page,`m3-disappearing-run-${viewport.name}-${theme}`,{viewport,theme,state});
      expect(state.activeClass).toBe('rq-state');
      expect(state.focusVisible).toBe(true);
      expect(state.focusRing.width).toBe('2px');
      expect(state.focusRing.style).toBe('solid');
      expect(state.liveCount).toBe(0);
      expect(state.asideLive).toBe(null);
      expect(state.pointerCount).toBe(0);
    } finally {await run.context.close();await Promise.all(run.cleanup.reverse().map(fn=>fn()));}
  });
}

for(const target of ['Protection details','Details'])for(const theme of themes)test(`M3 expiry preserves desktop focus on ${target} ${theme}`,async({browser})=>{
  const run=await startRequest(browser,{width:1440,height:900},theme,'m3-desktop-disclosure',true);
  try {
    const selector=target==='Details'?'.rq-more details:nth-child(2) summary':'.rq-more details:nth-child(1) summary';
    await focusWithTab(run.page,selector);
    const before=await run.page.evaluate(()=>({text:document.activeElement.textContent.trim(),tag:document.activeElement.tagName}));
    await run.page.clock.runFor(2500);
    await expect(run.page.locator('.rq-decide .rq-state')).toContainText(/This request expired/);
    const state=await run.page.evaluate(()=>({activeText:document.activeElement.textContent.trim(),activeTag:document.activeElement.tagName,
      liveCount:document.querySelectorAll('.rq-decide [role=status][aria-live=polite]').length,
      announcement:document.querySelector('.rq-decide [role=status][aria-live=polite]')?.textContent.trim()??'',
      asideLive:document.querySelector('.rq-decide').getAttribute('aria-live'),pointerCount:window.__releasePointerCount}));
    await saveEvidence(run.page,`m3-survive-desktop-${target.toLowerCase().replaceAll(' ','-')}-${theme}`,{viewport:{width:1440,height:900},theme,target,before,state});
    expect(state.activeText).toBe(before.text);
    expect(state.liveCount).toBe(1);
    expect(state.announcement).toMatch(/This request expired/);
    expect(state.asideLive).toBe(null);
    expect(state.pointerCount).toBe(0);
  } finally {await run.context.close();await Promise.all(run.cleanup.reverse().map(fn=>fn()));}
});

for(const theme of themes)test(`M3 expiry preserves focus in desktop navigation ${theme}`,async({browser})=>{
  const run=await startRequest(browser,{width:1440,height:900},theme,'m3-navigation',true);
  try {
    await focusWithTab(run.page,'.sidebar a[href="#/home"]');
    const before=await run.page.evaluate(()=>({text:document.activeElement.textContent.trim(),href:document.activeElement.getAttribute('href')}));
    await run.page.clock.runFor(2500);
    await expect(run.page.locator('.rq-decide .rq-state')).toContainText(/This request expired/);
    const state=await run.page.evaluate(()=>({activeText:document.activeElement.textContent.trim(),href:document.activeElement.getAttribute('href'),
      liveCount:document.querySelectorAll('.rq-decide [role=status][aria-live=polite]').length,announcement:document.querySelector('.rq-decide [role=status][aria-live=polite]')?.textContent.trim()??'',
      asideLive:document.querySelector('.rq-decide').getAttribute('aria-live'),pointerCount:window.__releasePointerCount}));
    await saveEvidence(run.page,`m3-survive-desktop-navigation-${theme}`,{viewport:{width:1440,height:900},theme,before,state});
    expect(state.activeText).toBe(before.text);
    expect(state.href).toBe(before.href);
    expect(state.liveCount).toBe(1);
    expect(state.asideLive).toBe(null);
    expect(state.announcement).toMatch(/This request expired/);
    expect(state.pointerCount).toBe(0);
  } finally {await run.context.close();await Promise.all(run.cleanup.reverse().map(fn=>fn()));}
});

test('M1 desktop decision controls remain reachable and incomplete requests cannot Run',async({browser})=>{
  const run=await startRequest(browser,{width:1440,height:900},'light','m1-desktop');
  try {
    await expect(run.page.getByRole('button',{name:'Run it'})).toBeEnabled();
    await expect(run.page.getByRole('button',{name:'Not now'})).toBeVisible();
    await focusWithTab(run.page,'.rq-actions button.btn-secondary');
    await expect(run.page.getByRole('button',{name:'Not now'})).toBeFocused();
    await focusWithTab(run.page,'.rq-actions button.btn-primary');
    await expect(run.page.getByRole('button',{name:'Run it'})).toBeFocused();
    await run.page.route('**/api/approvals',route=>route.fulfill({json:[{...run.card,prompt:''}]}));
    await run.page.reload();
    await expect(run.page.getByRole('button',{name:'Run it'})).toBeDisabled();
    await expect(run.page.getByRole('button',{name:'Not now'})).toBeEnabled();
    await focusWithTab(run.page,'.rq-actions button.btn-secondary');
    await expect(run.page.getByRole('button',{name:'Not now'})).toBeFocused();
    expect(await run.page.evaluate(()=>window.__releasePointerCount)).toBe(0);
  } finally {await run.context.close();await Promise.all(run.cleanup.reverse().map(fn=>fn()));}
});
