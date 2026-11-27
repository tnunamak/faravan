import {chromium, defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {installOnlineShim} from '../helpers/browser-online-shim.mjs';
installOnlineShim(chromium);
export default defineConfig({
  testDir:'.',
  testMatch:/(?:^|\/)(?:two-computer-(?:loop|admission|summary-retry|pause-stop|offline)|invariants-(?:negative|style-negative|lifecycle-negative))\.spec\.mjs$/,
  fullyParallel:false,workers:1,retries:0,
  timeout:60000,expect:{timeout:8000},
  reporter:[['list'],['json',{outputFile:fileURLToPath(new URL('../../test-artifacts/browser-verify/invariants/results.json',import.meta.url))}]],
  outputDir:'../../test-artifacts/browser-verify/invariants/pw',
  use:{headless:true,actionTimeout:8000},
  projects:[{name:'desktop-1280',use:{viewport:{width:1280,height:900}}},{name:'phone-390',use:{viewport:{width:390,height:844}}}],
});
