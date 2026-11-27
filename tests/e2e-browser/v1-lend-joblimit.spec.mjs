import {freshLink} from '../helpers/fresh-link.mjs';
// Uses a test home to check the default and a saved cap below the default model minimum.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessPath = fileURLToPath(new URL('./v1-harness.mjs', import.meta.url));
const SHOTS = process.env.JOBLIMIT_EVIDENCE_DIR ?? 'test-artifacts/e2e-v1';
const DESKTOP = {width: 1440, height: 900};
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

test('Lend shows the default and saves a $2 cap with the models that fit', async ({browser}) => {
  await mkdir(SHOTS,{recursive:true});
  const context = await browser.newContext({viewport:DESKTOP});
  const page = await context.newPage();
  await page.goto((await link('owner')) + '#/lend/limits');
  const input = page.getByRole('spinbutton',{name:'Most one friend’s job may spend'});
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('9.28');
  await page.screenshot({path:join(SHOTS,'lend-no-cap.png'),fullPage:true});
  await input.fill('2');
  await page.getByRole('button',{name:'Save limit',exact:true}).click();
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/lending/owner-settings');
  await page.locator('.owner-limit-confirm').click();
  expect((await response).ok()).toBe(true);
  await expect(page.locator('.owner-limit-summary')).toContainText('Claude Sonnet 5.5 jobs need at least $5.29.');
  await expect(page.locator('.owner-limit-summary')).toContainText('Claude Haiku 5.5');
  await expect(input).toHaveValue('2');
  await page.reload();
  await expect(page.locator('.owner-limit-saved')).toContainText('Saved per-job limit: $2.');
  await expect(page.locator('.owner-limit-summary')).toContainText('Claude Sonnet 5.5 jobs need at least $5.29.');
  await page.screenshot({path:join(SHOTS,'lend-saved-2.png'),fullPage:true});
  await context.close();
});
