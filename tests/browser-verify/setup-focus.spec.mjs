import {test, expect} from '@playwright/test';
import {startHarness} from './lib.mjs';

test('keyboard navigation to Setup focuses its own heading', async ({browser}) => {
  test.info().annotations.push({type:'slice', description:'D-setup'}, {type:'check', description:'keyboard'});
  const harness = await startHarness(), context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto((await harness.link('lender')) + '#/home');
    const setup = page.getByRole('link', {name:'Setup', exact:true});
    await setup.focus();
    await page.keyboard.press('Enter');
    const heading = page.locator('main h1');
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
  } finally { await context.close(); await harness.stop(); }
});
