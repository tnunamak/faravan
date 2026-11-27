import {freshLink} from '../helpers/fresh-link.mjs';
// A fresh home can open the lending limits page and save the engine-provided per-job cap at both target widths.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessPath = fileURLToPath(new URL('./v1-harness.mjs', import.meta.url));
const SHOTS = 'test-artifacts/e2e-v1';
const DESKTOP = {width: 1440, height: 900}, PHONE = {width: 390, height: 844};
let harness, urls;
const link=name=>freshLink(urls[name],urls.tokens[name]);

test.beforeAll(async () => {
  harness = spawn(process.execPath, [harnessPath], {stdio: ['ignore', 'pipe', 'inherit']});
  const lines = createInterface({input: harness.stdout});
  urls = JSON.parse(await Promise.race([
    once(lines, 'line').then(([line]) => line),
    once(harness, 'exit').then(([code]) => {throw new Error('harness exited early: ' + code);}),
  ]));
});

test.afterAll(async () => {
  if (!harness || harness.exitCode !== null) return;
  harness.kill('SIGTERM');
  await once(harness, 'exit');
});

test('fresh lending limits page has a usable engine-backed cap at desktop and phone widths', async ({browser}) => {
  await mkdir(SHOTS, {recursive: true});
  const context = await browser.newContext({viewport: DESKTOP});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  const engineSettingsResponse = page.waitForResponse(response =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/lending/owner-settings');
  await page.goto((await link('owner')) + '#/lend/limits');
  await expect(page.getByRole('heading', {name: 'What you lend', level: 1})).toBeVisible();
  await expect(page.getByText(/saved lending strategy was migrated/i)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/Protection source/i);

  const input = page.getByRole('spinbutton', {name: 'Most one friend’s job may spend'});
  const save = page.getByRole('button', {name: 'Save limit'});
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  const desktopControl = await page.evaluate(() => {
    const label = document.querySelector('.owner-limit-label'), hint = document.querySelector('.owner-limit-hint');
    const lines = element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    };
    return {labelWidth:label.getBoundingClientRect().width, labelLines:lines(label), hintWidth:hint.getBoundingClientRect().width,
      hintLines:lines(hint)};
  });
  expect(desktopControl.labelWidth, 'the label has room to read as a phrase').toBeGreaterThan(220);
  expect(desktopControl.labelLines, 'the desktop label is not squeezed into stacked words').toBeLessThanOrEqual(1);
  expect(desktopControl.hintWidth, 'the minimum explanation fills the control width').toBeGreaterThan(220);
  expect(desktopControl.hintLines, 'the minimum explanation is not squeezed into stacked words').toBeLessThanOrEqual(2);
  const engineResponse = await engineSettingsResponse;
  expect(engineResponse.ok(), 'the engine reports its per-model minimums').toBe(true);
  const engineSettings = await engineResponse.json();
  const engineMinimums = engineSettings.minimums.map(row => row.minimumMaxJobUsd);
  const minimum = Number(await input.getAttribute('min'));
  expect(engineMinimums).toContain(minimum);
  const savedOrDefault = engineSettings.values?.maxJobUsd ?? engineSettings.defaultMaxJobUsd;
  expect(Number(await input.inputValue())).toBe(Math.max(savedOrDefault, minimum));
  expect(Number(await input.inputValue())).toBeGreaterThanOrEqual(minimum);
  await expect(save).toBeEnabled();
  await page.screenshot({path: join(SHOTS, 'lend-limits-1440.png'), fullPage: true});

  await page.setViewportSize(PHONE);
  await expect(input).toBeVisible();
  await input.scrollIntoViewIfNeeded();
  const phoneControl = await page.evaluate(() => {
    const label = document.querySelector('.owner-limit-label'), hint = document.querySelector('.owner-limit-hint');
    const lines = element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    };
    return {labelWidth:label.getBoundingClientRect().width, labelLines:lines(label), hintLines:lines(hint)};
  });
  expect(phoneControl.labelWidth, 'the label uses the phone content width').toBeGreaterThan(220);
  expect(phoneControl.labelLines, 'the phone label wraps as a phrase, not one word per line').toBeLessThanOrEqual(2);
  expect(phoneControl.hintLines, 'the phone minimum explanation does not wrap one word per line').toBeLessThanOrEqual(3);
  const overlap = await page.evaluate(() => {
    const control = document.querySelector('.owner-limit-control').getBoundingClientRect();
    const tabbar = document.querySelector('.tabbar').getBoundingClientRect();
    return {controlBottom: control.bottom, tabbarTop: tabbar.top, viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth};
  });
  expect(overlap.controlBottom, 'the tab bar leaves the control visible').toBeLessThanOrEqual(overlap.tabbarTop);
  expect(overlap.documentWidth, 'the phone layout has no horizontal overflow').toBeLessThanOrEqual(overlap.viewportWidth);
  await expect(page.getByText(/saved lending strategy was migrated/i)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/Protection source/i);
  await page.screenshot({path: join(SHOTS, 'lend-limits-390.png'), fullPage: true});
  expect(errors).toEqual([]);
  await context.close();
});
