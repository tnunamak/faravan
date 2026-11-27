import {test, expect} from '@playwright/test';
import {patchHome, startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
test('Confirm restores its trigger and a non-destructive sheet closes on the backdrop',async({page})=>{
  await patchHome(page,{effective:{intent:{on:true,state:'ready'},admission:{reason:'busy'},execution:{state:'running',job:'attempt'},version:'fixture-v2'},dailyLimitReached:false},body=>({...body,state:'ready',intent:{on:true,state:'ready'},execution:{state:'running',job:'attempt',person:'Sam'},lending:{...body.lending,enabled:true,circle:'shared',mode:'ask',status:'running',current:'attempt',limits:{...body.lending?.limits,timeZone:'UTC'}}}));
  await page.route('**/api/circles',route=>route.fulfill({json:[{id:'shared',name:'Weekend projects',origin:'http://fixture'}]}));
  await page.route('**/api/agents',route=>route.fulfill({json:[{id:'codex',installed:true,signedIn:true,useForLending:true}]}));
  await page.route('**/api/readiness',route=>route.fulfill({json:{ready:true,checks:[]}}));
  await page.goto((await harness.link('lender'))+'#/lend');
  await expect(page.locator('.lending-page')).toContainText('No other job starts until this one finishes.');
  const trigger=page.getByRole('button',{name:'Stop Sam’s job…',exact:true});
  for(const dismiss of ['Escape','Keep going']) {
    await trigger.click();await expect(page.locator('dialog[open]')).toBeVisible();
    await page.mouse.click(5,5);
    await expect(page.locator('dialog[open]')).toBeVisible();
    if(dismiss==='Escape')await page.keyboard.press('Escape');else await page.getByRole('button',{name:'Keep going',exact:true}).click();
    await expect(trigger).toBeFocused();
  }
  const pause=page.getByRole('button',{name:/^Pause new jobs…/});await pause.click();
  await page.mouse.click(5,5);
  await expect(page.locator('dialog[open]')).toHaveCount(0);await expect(pause).toBeFocused();
});

test('a pending Action keeps keyboard focus and rejects a second activation',async({page})=>{
  await patchHome(page,{effective:{intent:{on:true,state:'ready'},execution:{state:'idle'},version:'fixture-v2'},dailyLimitReached:false},body=>({...body,
    state:'ready',intent:{on:true,state:'ready'},execution:{state:'idle'},
    lending:{...body.lending,enabled:true,circle:'shared',mode:'ask',status:'idle',limits:{...body.lending?.limits,timeZone:'UTC'}}}));
  await page.route('**/api/circles',route=>route.fulfill({json:[{id:'shared',name:'Weekend projects',origin:'http://fixture'}]}));
  await page.route('**/api/agents',route=>route.fulfill({json:[{id:'codex',installed:true,signedIn:true,useForLending:true}]}));
  await page.route('**/api/readiness',route=>route.fulfill({json:{ready:true,checks:[]}}));
  let calls=0, release;
  const wait=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/lending/off',async route=>{calls++;await wait;await route.fulfill({json:{ok:true}});});
  await page.goto((await harness.link('lender'))+'#/lend');
  const control=page.getByRole('switch',{name:'Lending',exact:true});
  await control.focus();await page.keyboard.press('Space');
  await expect(control).toHaveAttribute('aria-busy','true');
  await expect(control).toBeFocused();
  expect(await control.evaluate(el=>el.disabled)).toBe(false);
  await expect.poll(()=>calls).toBe(1);
  await page.keyboard.press('Space');expect(calls).toBe(1);
  release();await expect(control).not.toHaveAttribute('aria-busy','true');
  await expect(control).toBeFocused();
});

test('a pending profile Action retains focus when the connection becomes unavailable',async({page})=>{
  let calls=0,release;
  const wait=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/devices',async route=>{
    if(route.request().method()==='POST'){calls++;await wait;}
    await route.fulfill({json:{ownerName:calls?'Mo':'Sam',name:'Sam’s laptop',circles:[]}}).catch(()=>{});
  });
  await page.goto((await harness.link('lender'))+'#/you/profile');
  await page.getByLabel('Your name',{exact:true}).fill('Mo');
  const control=page.locator('.you-content .action button');
  await control.focus();await page.keyboard.press('Space');
  await expect(control).toHaveAttribute('aria-busy','true');
  await page.evaluate(()=>window.dispatchEvent(new Event('offline')));
  await expect(control).toHaveAttribute('aria-disabled','true');
  expect(await control.evaluate(el=>el.disabled)).toBe(false);
  await expect(control).toBeFocused();
  await page.keyboard.press('Space');expect(calls).toBe(1);
  release();
  await expect(page.locator('.notice')).toHaveText('Your name was saved.');
  await expect(page.locator('.notice')).toBeFocused();
});
