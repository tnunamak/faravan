import {test,expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
test('Home contributions show only the aggregate sentence, without identity internals',async({page})=>{
 await page.route('**/api/contributions',r=>r.fulfill({json:{windows:{7:{devices:2,jobs:8,minutes:3,rows:[{keyId:'sha256:'+'b'.repeat(64),deviceName:'Sam laptop',run:5},{keyId:'sha256:'+'c'.repeat(64),localName:'Maya',run:3}]}},rows:[{keyId:'sha256:'+'a'.repeat(64),deviceName:'Sam laptop',coordinator:'internal',minutes:3}]}}));
 await page.goto((await harness.link('lender'))+'#/home');
 const section=page.locator('.home-contributions');
 await expect(section).toContainText('You helped Sam laptop and Maya with 8 jobs in the last 7 days.');
 await expect(section.locator('details,summary,table')).toHaveCount(0);
 await expect(section).not.toContainText(/\bkeys?\b|coordinator|sha256|[a-f0-9]{12,}|\(3 minutes\)/i);
 await expect(section.getByRole('link',{name:/Open Jobs/})).toHaveAttribute('href','#/jobs');
});
