import { chromium, defineConfig } from '@playwright/test';
import { installOnlineShim } from './tests/helpers/browser-online-shim.mjs';

// Browser E2E for the Faravan v1 web app. Opt-in: `npm run test:e2e` (not part of `npm test`).
installOnlineShim(chromium);
export default defineConfig({
  testDir: 'tests/e2e-browser',
  testMatch: /v1-.*\.spec\.mjs$/,
  timeout: 90_000,
  expect: {timeout: 10_000},
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-artifacts/e2e-v1',
  use: {actionTimeout: 10_000, screenshot: 'only-on-failure', trace: 'retain-on-failure', viewport: {width: 1280, height: 800}},
});
