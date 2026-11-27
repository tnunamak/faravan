// Screenshots of the shell's settings and onboarding screens at desktop and phone width, light and dark, for the
// person reviewing the change to LOOK at (cycle-2 rule). It also fails on page errors and horizontal overflow, so a
// broken screen cannot be captured as if it were fine. Output: $SHELL_SHOTS_DIR or test-artifacts/browser-verify/shell-shots.
// Run alone: npx playwright test -c playwright.verify.config.mjs shell-shots
import {test, expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {startHarness} from './lib.mjs';
import { qrPath } from '../../lib/v1/qr.mjs';
import { phoneReach } from '../../lib/v1/phone-access.mjs';

const OUT = process.env.SHELL_SHOTS_DIR || 'test-artifacts/browser-verify/shell-shots';
const SIZES = [['desktop', 1440, 900], ['phone', 390, 844]];
const now = Date.now();
// Fixtures follow the real GET /api/phone contract (briefs/shell-access-integration.md, REVISION 3).
const off = {enabled: false, address: null, hostname: null, https: false, certFile: null, keyFile: null, origin: null,
  reach: phoneReach({enabled: false}),
  addresses: [{address: '10.23.1.20', interface: 'wlan0', kind: 'lan'}], phones: [], pairing: null};
const on = {...off, enabled: true, address: '10.23.1.20', origin: 'http://10.23.1.20:47321',
  reach: phoneReach({enabled: true, listening: true, https: false, address: '10.23.1.20', kind: 'lan'}),
  phones: [{id: 'f1', label: 'Pixel 7', kind: 'phone', scopes: ['inbox:read'], created_at: now - 86400000 * 3, last_used_at: now - 7200000}]};
// The real encoder, so the shot shows (and a device could scan) the actual pairing QR.
const qr = qrPath('http://10.23.1.20:47321/pair#K7QF2M9D');
const waiting = {...on, pairing: {id: 'p1', state: 'waiting', code: 'K7QF-2M9D', expiresAt: new Date(now + 240000).toISOString(),
  url: 'http://10.23.1.20:47321/pair#K7QF2M9D', qr, scopes: ['inbox:read']}};
const claimed = {...on, pairing: {id: 'p1', state: 'claimed', expiresAt: new Date(now + 200000).toISOString(),
  phrase: ['amber', 'otter', 'lamp'], phone: {label: 'Pixel 8', address: '10.23.1.31'}, url: waiting.pairing.url, scopes: ['inbox:read']}};
const phone = view => async page => { await page.route('**/api/events**', () => new Promise(() => {})); await page.route('**/api/phone', route => route.fulfill({json: view})); };

// name → {hash, fixtures(page), after(page)}
const SCREENS = {
  'home-fresh': {hash: '#/home', fixtures: async page => {
    await page.route('**/api/circles', route => route.fulfill({json: []}));
    await page.route('**/api/jobs', route => route.fulfill({json: []}));
    await page.route('**/api/approvals', route => route.fulfill({json: []}));
  }, after: async page => { await page.getByRole('button', {name: 'See an example'}).click(); }},
  'home': {hash: '#/home'},
  'settings-map': {hash: '#/you/all'},
  'settings-map-search': {hash: '#/you/all', after: async page => { await page.getByRole('searchbox', {name: 'Search settings'}).fill('quota'); }},
  'appearance': {hash: '#/you/appearance'},
  'notifications': {hash: '#/you/notifications'},
  'updates': {hash: '#/you/updates', fixtures: async page => {
    await page.route('**/api/updates', route => route.fulfill({json: {owner: 'faravan', state: 'available', currentVersion: '1.0.0', candidate: '1.1.0',
      checkedAt: new Date(now - 3600000).toISOString(), nextCheckAt: new Date(now + 5 * 3600000).toISOString(), notes: ['Keep your browser signed in after a restart'], automatic: true}}));
  }},
  'phone-off': {hash: '#/you/phone', fixtures: phone(off)},
  'phone-connection': {hash: '#/you/phone', fixtures: phone(off), after: async page => { await page.getByText('Connection settings', {exact: true}).click(); }},
  'phone-on': {hash: '#/you/phone', fixtures: phone(on)},
  'phone-waiting': {hash: '#/you/phone', fixtures: phone(waiting)},
  'phone-manual': {hash: '#/you/phone', fixtures: phone({...waiting, pairing: {...waiting.pairing, qr: null, url: 'http://' + [63,63,63,55].map(n => 'a'.repeat(n)).join('.') + ':47321/pair#K7QF2M9D'}})},
  'phone-claimed': {hash: '#/you/phone', fixtures: phone(claimed)},
  'palette-setting': {hash: '#/home', after: async page => {
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', {name: 'Search or jump to'}).fill('minutes');
  }},
};

let harness;
test.beforeAll(async () => { harness = await startHarness(); await mkdir(OUT, {recursive: true}); });
test.afterAll(async () => { await harness?.stop(); });

for (const [size, width, height] of SIZES) for (const scheme of ['light', 'dark']) {
  test(`shots: ${size} ${scheme}`, async ({browser}) => {
    const problems = [];
    for (const [name, screen] of Object.entries(SCREENS)) {
      const context = await browser.newContext({viewport: {width, height}, colorScheme: scheme});
      const page = await context.newPage();
      page.on('pageerror', error => problems.push(name + ': ' + error.message));
      await screen.fixtures?.(page);
      await page.goto((await harness.link('lender')) + screen.hash);
      await page.locator('#app h1').first().waitFor();
      await page.waitForFunction(() => !document.querySelector('.skel,.skeleton,[aria-label^="Loading"]'), null, {timeout: 8000}).catch(() => {});
      await screen.after?.(page);
      await page.waitForTimeout(150);
      if (name === 'phone-waiting') {
        await expect(page.locator('.phone-qr > path')).toHaveCSS('fill', 'rgb(0, 0, 0)');
        await expect(page.locator('.phone-qr > rect')).toHaveCSS('fill', 'rgb(255, 255, 255)');
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (overflow > 1) problems.push(name + ' overflows horizontally by ' + overflow + 'px');
      await page.screenshot({path: join(OUT, `${name}.${size}.${scheme}.png`), fullPage: true});
      await context.close();
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
}
