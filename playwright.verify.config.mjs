import { chromium, defineConfig } from '@playwright/test';
import { installOnlineShim } from './tests/helpers/browser-online-shim.mjs';

// V1, the browser verification lane (docs/testing-browser.md). Headless Chromium only, against the real app
// served from a temporary FARAVAN_HOME with fixture data. Run it with `npm run test:browser`.
// It is separate from `npm test` and from `npm run test:e2e` (playwright.config.mjs).
installOnlineShim(chromium);
export default defineConfig({
  testDir: 'tests/browser-verify',
  testMatch: /\.spec\.mjs$/,
  timeout: 60_000,
  expect: {timeout: 8_000},
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', {outputFile: 'test-artifacts/browser-verify/results.json'}]],
  outputDir: 'test-artifacts/browser-verify/pw',
  use: {headless: true, actionTimeout: 8_000},
});
