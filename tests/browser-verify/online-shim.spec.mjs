import {test, expect} from '@playwright/test';
import {startHarness, open} from './lib.mjs';

// Under `test-sandbox --net none` Chromium has only a loopback interface, so navigator.onLine is false on every page and
// context.setOffline() cannot make it true. tests/helpers/browser-online-shim.mjs (loaded by playwright.verify.config.mjs)
// makes the page report online, and keeps setOffline(true) reading offline. These checks pin that for the shared open()
// helper and for the built-in page fixture.
let harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.stop(); });

// The app's Home route has no level-1 "Home" heading (slices.mjs U2b/U4/U21 still wait for one), so wait for the main nav.
const HOME = {id: 'online-shim', hash: '#/home', ready: page => page.getByRole('navigation', {name: 'Main'}).waitFor()};
const onLine = page => page.evaluate(() => navigator.onLine);

test('the app page opened by the shared helper reads online', async ({browser}) => {
  const {context, page} = await open(browser, harness.urls, HOME);
  expect(await onLine(page)).toBe(true);
  await expect(page.locator('.offline')).toBeHidden();
  await context.close();
});

test('context.setOffline(true) still reads offline, and setOffline(false) reads online again', async ({browser}) => {
  const {context, page} = await open(browser, harness.urls, HOME);
  await context.setOffline(true);
  expect(await onLine(page)).toBe(false);
  await expect(page.locator('.offline').first()).toBeVisible();
  await context.setOffline(false);
  expect(await onLine(page)).toBe(true);
  await expect(page.locator('.offline')).toBeHidden();
  await context.close();
});

test('the built-in page fixture reads online, and setOffline(true) still reads offline', async ({page}) => {
  await page.goto((await harness.link('lender')) + HOME.hash);
  await HOME.ready(page);
  expect(await onLine(page)).toBe(true);
  await page.context().setOffline(true);
  expect(await onLine(page)).toBe(false);
  await page.context().setOffline(false);
  expect(await onLine(page)).toBe(true);
});
