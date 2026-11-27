import {test, expect} from '@playwright/test';
import {startHarness} from './lib.mjs';

let harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.stop(); });

const circle = {id:'lost-circle', name:'Weekend projects', origin:'https://circle.example', enrollment:{state:'approved'}, rosterMembershipVerified:true};

// After the app restarts, every API call is a 401. The folder check must say the page needs opening again,
// never that the folder does not exist (the tester's phone, pin 2).
for (const [label, reply, expected] of [
  ['401', route => route.fulfill({status:401, json:{code:'unauthorized'}}), /This page is no longer connected to Faravan/],
  ['network', route => route.abort('failed'), /couldn.t check this folder/],
]) {
  test(`a ${label} from the folder check never says the folder is missing`, async ({page}) => {
    await page.route('**/api/circles', route => route.fulfill({json:[circle]}));
    await page.route('**/api/circles/*/compose', route => route.fulfill({json:{circle:circle.id, networked:true, host:{reachable:true}, lenders:[]}}));
    await page.route('**/api/repo/inspect', reply);
    await page.goto((await harness.link('owner')) + '#/new');
    if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
    const folder = page.getByRole('textbox',{name:'Project folder',exact:true});
    await folder.fill('/home/sam/code/waspflow');
    await folder.press('Tab');
    await expect(page.locator('main')).toContainText(expected);
    await expect(page.locator('main')).not.toContainText(/isn.t on this computer|Not found/);
  });
}

test('after a restart Home shows one plain banner, not a list of resources with an error code', async ({page}) => {
  await page.goto((await harness.link('owner')) + '#/home');
  await expect(page.getByRole('heading', {level: 1, name: 'What would you like to get done?'})).toBeVisible();
  await page.route('**/api/**', route => route.request().method() === 'GET' && !route.request().url().includes('/api/events')
    ? route.fulfill({status: 401, json: {code: 'unauthorized'}}) : route.fallback());
  await page.reload();
  const banner = page.locator('.offline');
  await expect(banner).toContainText('This page is no longer connected to Faravan.');
  await expect(banner).not.toContainText(/401|setup checks|Showing what we had/);
  await expect(banner).toContainText('Open it again from Faravan on this computer.');
  await expect(banner.getByRole('button', {name: 'Copy command'})).toHaveCount(0);
  await expect(page.locator('.offline')).toHaveCount(1);
});

for(const from of ["home","new"])test(`warm phone session loss preserves ${from} with pairing recovery`,async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.route("**/api/circles",r=>r.fulfill({json:[circle]}));
 await page.route("**/api/circles/*/compose",r=>r.fulfill({json:{circle:circle.id,networked:true,host:{reachable:true},lenders:[]}}));
 await page.goto((await harness.link('owner'))+"#/"+from);
 await expect(page.getByRole("heading",{level:1})).toBeVisible();
 if(from==="new")await page.getByLabel("What the agent should do").fill("Write a welcome poem");
 let losses=0;
 await page.route("**/api/**",r=>{
  if(r.request().method()==="GET"&&!r.request().url().includes("/api/events")){losses++;return r.fulfill({status:401,json:{code:"unauthorized"}});}
  return r.fallback();
 });
 // Change route in the already-loaded shell; do not invoke the cold bootstrap recovery.
 if(from==="home")await page.evaluate(()=>location.hash="#/new");
 else {if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();await page.getByRole("textbox",{name:"Project folder",exact:true}).fill("/synthetic/folder");await page.getByRole("textbox",{name:"Project folder",exact:true}).press("Tab");}
 const banner=page.locator(".offline");
 await expect(banner).toHaveCount(1,{timeout:20000});await expect(banner).toContainText("Settings → Pairing");
 await expect(banner).toContainText("pair this device again");
 await expect(banner).not.toContainText(/401|tray|run faravan|folder.*not found/i);
 await expect(banner.getByRole("button",{name:"Copy command"})).toHaveCount(0);
 expect(losses).toBeGreaterThan(0);
 if(from==="new"){
  expect(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("faravan-compose-draft:")).map(k=>JSON.parse(localStorage.getItem(k)).prompt))).toContain("Write a welcome poem");
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
