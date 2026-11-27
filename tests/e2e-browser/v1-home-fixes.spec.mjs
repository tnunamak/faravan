import {test,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {freshLink} from '../helpers/fresh-link.mjs';
let child,harness;
const shots=process.env.HOME_FIX_SCREENSHOTS??'test-artifacts/home-fixes';
test.beforeAll(async()=>{
  child=spawn(process.execPath,[fileURLToPath(new URL('./v1-home-fixes-harness.mjs',import.meta.url))],{stdio:['ignore','pipe','inherit'],env:{...process.env,FARAVAN_NO_BROWSER:'1',DISPLAY:'',WAYLAND_DISPLAY:''}});
  harness=JSON.parse(await Promise.race([once(createInterface({input:child.stdout}),'line').then(([line])=>line),once(child,'exit').then(([code])=>{throw new Error('harness exited '+code);})]));
  await mkdir(shots,{recursive:true});
});
test.afterAll(async()=>{if(child?.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}});
const rawIds=/claude-code-(subscription|api-key)|\bgh-cli\b/;
async function capture(page,name){
  for(const [width,height,size] of [[1440,900,'desktop'],[390,844,'phone']])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
    await page.evaluate(()=>document.fonts.ready);
    expect(await page.locator('body').innerText()).not.toMatch(rawIds);
    expect(await page.locator('[aria-label],[title],[alt],[placeholder]').evaluateAll(elements=>elements.flatMap(element=>['aria-label','title','alt','placeholder'].map(name=>element.getAttribute(name)||'')).join(' '))).not.toMatch(rawIds);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:shots+'/'+name+'.'+size+'-'+theme+'.png',fullPage:true,animations:'disabled'});
  }
}

test('Home starts the first circle directly, then another; folder and lending states offer recovery',async({page})=>{
  test.setTimeout(180000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  // Keep all listeners isolated, including CLI children. The app has no port setting in its form.
  await page.route('**/api/ops/hosting.start',route=>route.continue({postData:JSON.stringify({...route.request().postDataJSON(),port:harness.port})}));
  await page.goto((await freshLink(harness.owner,harness.token))+'#/home');
  await page.getByRole('link',{name:'Start a circle',exact:true}).waitFor();
  await capture(page,'home-fresh');
  await page.goto((await freshLink(harness.owner,harness.token))+'#/circles');
  await expect(page.getByText('Work with people you trust.',{exact:true})).toBeVisible();
  await capture(page,'circles-empty');
  await page.goto((await freshLink(harness.owner,harness.token))+'#/home');
  await page.getByRole('link',{name:'Start a circle',exact:true}).waitFor();
  await page.getByRole('link',{name:'Start a circle',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Start a circle',exact:true})).toBeVisible();
  await expect(page.getByLabel('Circle name',{exact:true})).toHaveValue('');
  await expect(page.getByRole('button',{name:'Start circle',exact:true})).toHaveAttribute('aria-disabled','true');
  expect(await page.getByText('Start from a terminal',{exact:true}).evaluate(element=>getComputedStyle(element).listStyleType)).toBe('none');
  await capture(page,'circle-first-empty');
  await page.getByLabel('Circle name',{exact:true}).fill('Weekend projects');
  await page.getByRole('radio',{name:/Local network only/}).check();
  await capture(page,'circle-first-ready');
  await page.getByRole('button',{name:'Start circle',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Weekend projects',exact:true})).toBeVisible({timeout:45000});
  await expect(page).toHaveURL(/#\/circle\//);
  await capture(page,'circle-created');
  await page.goto((await freshLink(harness.owner,harness.token))+'#/circles');
  await expect(page.locator('[aria-label="Your circles"]')).toContainText('Hosted on this computer');
  await capture(page,'circles');
  await page.getByRole('link',{name:'Start a circle',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Start another circle',exact:true})).toBeVisible();
  await expect(page.getByLabel('Circle name',{exact:true})).toHaveValue('');
  await capture(page,'circle-second-empty');
  await page.getByLabel('Circle name',{exact:true}).fill('Small fixes');
  await page.getByRole('button',{name:'Start circle',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Small fixes',exact:true})).toBeVisible({timeout:45000});
  await capture(page,'circle-second-created');
  await page.goto((await freshLink(harness.owner,harness.token))+'#/jobs/new');
  await page.getByRole('radio',{name:'Folder on this computer',exact:true}).click();
  await page.getByLabel('What the agent should do').fill('Make a checklist');
  await page.getByRole('textbox',{name:'Folder on this computer',exact:true}).fill('~/sandbox');
  await page.getByRole('textbox',{name:'Folder on this computer',exact:true}).press('Enter');
  await expect(page.getByText('You can send this folder as files.',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Choose another folder',exact:true})).toBeVisible();
  await expect(page.locator('body')).not.toContainText('is a folder but not a git repository');
  await capture(page,'compose-not-git');
  await page.getByRole('button',{name:'Choose another folder',exact:true}).click();
  expect(errors).toEqual([]);
  await expect(page.getByRole('dialog',{name:'Choose a project'})).toBeVisible();
  await page.getByRole('button',{name:'Close project picker'}).click();
  await page.route('**/api/home',async route=>{
    const response=await route.fetch(),data=await response.json();
    data.intent={...data.intent,on:true,state:'blocked'};data.lending={...data.lending,enabled:true};
    const blocker={key:'isolation_check',label:'Sandbox isolation',status:'blocked',detail:'The sandbox could read your agent sign-in. Check Docker Sandboxes, then resume lending.',action:'Resume lending'};
    data.isolationFailure=blocker.detail;data.lending_blockers={items:[blocker],first:blocker,needsYou:[blocker],canLend:false};
    data.lendingProjection={...data.lendingProjection,intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'isolation_check_failed'};
    await route.fulfill({response,json:data});
  });
  for(const [route,name] of [['home','home-blocked'],['lend','lending-blocked'],['setup','setup-blocked'],['lend/limits','limits'],['circles/host','hosting']]){
    await page.goto((await freshLink(harness.owner,harness.token))+'#/'+route);await page.locator('h1').waitFor();
    if(route==='home'||route==='lend')await expect(page.locator('body')).toContainText('Jobs can’t start');
    if(route==='home')await expect(page.getByText('Finished jobs will appear here.',{exact:true})).toBeVisible();
    if(route==='setup')await expect(page.locator('body')).toContainText('could read your agent sign-in');
    if(route==='lend/limits')await expect(page.getByText('At the same time',{exact:true})).toBeVisible();
    if(route==='circles/host')await expect(page.getByText('Runs on this computer',{exact:true})).toBeVisible();
    await capture(page,name);
    if(route==='setup'){
      await page.locator('#setup-safety-details>summary').click();
      await expect(page.locator('#setup-safety-details')).toHaveAttribute('open','');
      await capture(page,'setup-details');
    }
  }
  await page.unrouteAll({behavior:'ignoreErrors'});
  expect(errors).toEqual([]);
});

test('cold stale-token recovery uses app fonts under CSP and gives desktop and phone steps',async({browser})=>{
  const context=await browser.newContext();
  try{
    const page=await context.newPage();
    await page.addInitScript(()=>{globalThis.cspViolations=[];document.addEventListener('securitypolicyviolation',event=>globalThis.cspViolations.push(event.violatedDirective));});
    await page.goto(new URL(harness.owner).origin+'/?token=invalid-home-fix-test');
    await expect(page.getByRole('heading',{name:'Your session ended',exact:true})).toBeVisible();
    await expect(page.locator('body')).toContainText('faravan');
    await expect(page.locator('body')).toContainText('Settings → Pairing');
    await expect(page.locator('body')).toContainText('pair this device again');
    await expect.poll(()=>page.locator('body').evaluate(element=>getComputedStyle(element).fontFamily)).toContain('Instrument Sans');
    await capture(page,'session-lost');
    expect(await page.evaluate(()=>globalThis.cspViolations)).toEqual([]);
  }finally{await context.close();}
});
