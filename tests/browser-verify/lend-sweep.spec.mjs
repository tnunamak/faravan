import {test,expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
import {mockFixture,NOW} from '../../ui/v1/src/lending-policy.fixture.mjs';
import {normalizeLendingPolicy} from '../../lib/v1/lending-policy.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
// Lend/Limits sweep: unsaved-change guard for rule drafts, local help links, and honest offline Save copy.
async function open(page){
 const limits={timeZone:'America/Chicago',dailyJobs:null,dailyMinutes:null,maxWallSeconds:null,quotaReserve:30,idleOnly:true,lendingPolicy:normalizeLendingPolicy({})};
 const dialogs=[];page.on('dialog',d=>{dialogs.push(d.message());d.dismiss();});
 await page.clock.setFixedTime(new Date(NOW));
 await page.route('**/api/home',r=>r.fulfill({json:{state:'ready',intent:{on:true,state:'ready'},execution:{state:'idle'},
  lending:{enabled:true,circle:'shared',mode:'ask',standingRules:[],limits,configVersion:7},lendingPolicy:mockFixture()}}));
 await page.route('**/api/circles',r=>r.fulfill({json:[{id:'shared',name:'Friends',origin:'http://fixture'}]}));
 await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:'me',name:'Laptop',circles:[{circle:'shared',members:[{key_id:'me',device_name:'Laptop'},{key_id:'sam',localName:'Sam'}]}]}}));
 await page.route('**/api/agents',r=>r.fulfill({json:[{id:'codex',installed:true,signedIn:true,useForLending:true}]}));
 await page.goto((await harness.link('lender'))+'#/lend/limits');
 await expect(page.getByRole('heading',{level:1,name:'What you lend',exact:true})).toBeVisible();
 return dialogs;
}
const back=page=>page.getByRole('link',{name:/^Lending$/}).first();
test('a rule draft with edits asks before leaving; an untouched or cancelled one does not',async({page})=>{
 const dialogs=await open(page);
 await page.getByRole('button',{name:'Add a rule'}).click();
 await back(page).click();
 await expect(page).toHaveURL(/#\/lend$/);
 await expect(page.getByRole('heading',{level:1,name:'Lending',exact:true})).toBeVisible();
 expect(dialogs).toEqual([]);
 await page.evaluate(()=>{location.hash='#/lend/limits';});
 await expect(page.getByRole('heading',{level:1,name:'What you lend',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Add a rule'}).click();
 await page.getByLabel('Rule: Jobs a day').fill('3');
 await page.getByRole('button',{name:'Cancel'}).click();
 await back(page).click();
 await expect(page).toHaveURL(/#\/lend$/);
 await expect(page.getByRole('heading',{level:1,name:'Lending',exact:true})).toBeVisible();
 expect(dialogs).toEqual([]);
 await page.evaluate(()=>{location.hash='#/lend/limits';});
 await expect(page.getByRole('heading',{level:1,name:'What you lend',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Add a rule'}).click();
 await page.getByLabel('Rule: Jobs a day').fill('3');
 await back(page).click();
 expect(dialogs).toEqual(['Discard your unsaved changes?']);
 await expect(page).toHaveURL(/#\/lend\/limits$/);
 await expect(page.getByLabel('Rule: Jobs a day')).toHaveValue('3');
});
test('opening the starting-assumption help with unsaved settings does not ask to discard',async({page})=>{
 const dialogs=await open(page);
 await page.getByLabel('Jobs a day').fill('3');
 await page.getByRole('link',{name:'Starting assumption for new users'}).first().click();
 expect(dialogs).toEqual([]);
 await expect(page).toHaveURL(/#\/lend\/limits$/);
 await expect(page.locator('#starting-assumption')).toHaveAttribute('open','');
 await expect(page.getByLabel('Jobs a day')).toHaveValue('3');
});
test('offline Save copy says the changes are not saved and nothing saves on reconnect',async({page,context})=>{
 await open(page);
 await page.getByLabel('Jobs a day').fill('3');
 await context.setOffline(true);
 const footer=page.locator('.limits-footer');
 await expect(footer).toContainText('Reconnect, then select Save. These changes are not saved yet.');
 await expect(footer).not.toContainText('Waits until');
});
