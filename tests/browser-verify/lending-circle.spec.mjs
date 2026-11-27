import {test, expect} from '@playwright/test';
import {patchHome, startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const homeEvidence = paused => ({
  effective:{intent:{on:true,state:paused?'paused':'ready'},execution:{state:'idle'},version:paused?'fixture-paused':'fixture-ready'},
  dailyLimitReached:false,
});
const patchLendingHome = paused => body => ({...body,lending_blockers:null,intent:{on:true,state:paused?'paused':'ready'},execution:{state:'idle'},lending:{...body.lending,enabled:true,paused,circle:'shared',mode:'ask',status:paused?'paused':'idle',limits:{...body.lending?.limits,timeZone:'UTC'}}});
async function installLendingHome(page, paused) {
  await page.unroute('**/api/home');
  await patchHome(page,homeEvidence(paused),patchLendingHome(paused));
}
test('reload then Pause and Resume preserve the server lending circle',async({page})=>{
  let paused=false;const posts=[];
  await installLendingHome(page,paused);
  await page.route('**/api/circles',route=>route.fulfill({json:[{id:'private',name:'My devices',origin:'http://fixture'}, {id:'shared',name:'Weekend projects',origin:'http://fixture'}]}));
  await page.route('**/api/agents',route=>route.fulfill({json:[{id:'codex',installed:true,signedIn:true,useForLending:true}]}));
  await page.route('**/api/readiness',route=>route.fulfill({json:{ready:true,checks:[]}}));
  await page.route(/\/api\/lending\/(?:pause|resume)$/,async route=>{
    posts.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});
    paused=route.request().url().endsWith('/pause');
    await installLendingHome(page,paused);
    await route.fulfill({json:{ok:true}});
  });
  await page.goto((await harness.link('lender'))+'#/lend');
  await page.getByRole('button',{name:/^Pause new jobs…/}).waitFor();
  await page.reload();
  await page.getByRole('button',{name:/^Pause new jobs…/}).click();
  await expect(page.getByRole('dialog',{name:'Pause new jobs'})).toContainText('Pause new jobs. Waiting offers are held, not declined, and return on Resume if still available. Running jobs continue within their saved limits.');
  await page.getByRole('button',{name:'For 1 hour',exact:true}).click();
  await page.getByRole('button',{name:'Resume now',exact:true}).click();
  await expect.poll(()=>posts.length).toBe(2);
  expect(posts.map(p=>p.body.circle)).toEqual(['shared','shared']);
  await expect(page.locator('.notice')).toContainText('Lending is on');
  await expect(page.locator('.headline')).not.toContainText('restarted');
  await page.getByRole('button',{name:/^Pause new jobs…/}).click();
  await page.getByRole('button',{name:'For 1 hour',exact:true}).click();
  await page.route('**/api/lending/resume',route=>route.fulfill({status:409,json:{code:'lending_busy'}}));
  await page.getByRole('button',{name:'Resume now',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Review the current job before starting another.'}).first()).toBeVisible();
  await expect(page.locator('.headline')).not.toContainText('restarted');
});
test('a slow activity read cannot hold live updates or completion of lending controls',async({page})=>{
  let subscribed=false;const calls=[];
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/events')subscribed=true;});
  await page.route('**/api/activity',async route=>{await new Promise(resolve=>setTimeout(resolve,3000));await route.fulfill({json:[]}).catch(()=>{});});
  await installLendingHome(page,false);
  await page.route('**/api/circles',route=>route.fulfill({json:[{id:'shared',name:'Weekend projects',origin:'http://fixture'}]}));
  await page.route('**/api/agents',route=>route.fulfill({json:[{id:'codex',installed:true,signedIn:true,useForLending:true}]}));
  await page.route('**/api/readiness',route=>route.fulfill({json:{ready:true,checks:[]}}));
  await page.route('**/api/lending/off',async route=>{
    calls.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});
    await page.unroute('**/api/home');
    await patchHome(page,{effective:{intent:{on:false,state:'off'},execution:{state:'idle'},version:'fixture-off'},dailyLimitReached:false},body=>({...body,lending_blockers:null,intent:{on:false,state:'off'},execution:{state:'idle'},lending:{...body.lending,enabled:false,paused:false,circle:'shared',mode:'ask',status:'idle'}}));
    await route.fulfill({json:{ok:true}});
  });
  await page.goto((await harness.link('lender'))+'#/lend');
  await expect.poll(()=>subscribed,{timeout:1500}).toBe(true);
  const toggle=page.getByRole('switch',{name:'Lending',exact:true});
  await expect(toggle).toHaveAttribute('aria-checked','true');
  await toggle.click();
  await expect.poll(()=>calls).toEqual([{path:'/api/lending/off',body:{circle:'shared'}}]);
  await expect(toggle).toHaveAttribute('aria-checked','false');
  await expect(page.locator('.headline')).toHaveText('Lending is off');
  await expect(page.locator('.notice')).toContainText('No new jobs will start.');
});
