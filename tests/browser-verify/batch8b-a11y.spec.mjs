// Batch 8b accessibility on the shell: the compose check summary is named by the text it shows (desktop width), and every
// phone tab label keeps 4.5:1 against its tab bar in both colour schemes (390 px wide).
import {test, expect} from '@playwright/test';
import {startHarness} from './lib.mjs';

const circle = {id: 'batch8b-a11y', name: 'Weekend projects', origin: 'https://fixture.test', enrollment: {state: 'approved'}, rosterMembershipVerified: true};
let harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.stop(); });

async function open(page, hash) {
  await page.addInitScript(circleId => { localStorage.setItem('faravan-compose-circle', circleId); }, circle.id);
  await page.route('**/api/circles', r => r.fulfill({json: [circle]}));
  await page.route('**/api/circles/*/compose', r => r.fulfill({json: {networked: true, host: {label: 'Ana’s MacBook', reachable: true}, lenders: []}}));
  await page.goto((await harness.link('owner')) + hash);
}

const collapse = text => text.replace(/\s+/g, ' ').trim();

// WCAG 2.x relative luminance and contrast, for colours printed by the browser as rgb() or rgba().
function channels(css) {
  const [r, g, b, a = 1] = css.match(/[\d.]+/g).map(Number);
  // Chromium prints colour-mix() results as color(srgb …) with channels from 0 to 1.
  return css.startsWith('color(srgb') ? {r: r * 255, g: g * 255, b: b * 255, a} : {r, g, b, a};
}
function luminance({r, g, b}) {
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(textCss, surfaceCss, pageCss) {
  const surface = channels(surfaceCss), page = channels(pageCss), text = channels(textCss);
  // The bar is translucent over the page: composite it, then measure the text against the result.
  const over = {
    r: surface.a * surface.r + (1 - surface.a) * page.r,
    g: surface.a * surface.g + (1 - surface.a) * page.g,
    b: surface.a * surface.b + (1 - surface.a) * page.b,
  };
  const textOnBar = text.a < 1 ? {r: text.a * text.r + (1 - text.a) * over.r, g: text.a * text.g + (1 - text.a) * over.g, b: text.a * text.b + (1 - text.a) * over.b} : text;
  const [hi, lo] = [luminance(textOnBar), luminance(over)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the check summary is named by the text it shows, at desktop width', async ({browser}) => {
  const context = await browser.newContext({viewport: {width: 1440, height: 900}});
  const page = await context.newPage();
  try {
    await open(page, '#/new');
    const summary = page.locator('#cmp-verify-heading');
    await expect(summary).toBeVisible();
    const name = (await summary.getAttribute('aria-label')) ?? (await summary.innerText());
    expect(collapse(name)).toBe(collapse(await summary.innerText()));
  } finally {
    await context.close();
  }
});

const PHONE_ROUTES = ['#/home', '#/jobs', '#/lend', '#/circles', '#/new'];
for (const colorScheme of ['light', 'dark']) for (const hash of PHONE_ROUTES) {
  test('phone tab labels keep 4.5:1 against the bar on ' + hash + ' in ' + colorScheme, async ({browser}) => {
    const context = await browser.newContext({viewport: {width: 390, height: 844}, colorScheme});
    const page = await context.newPage();
    try {
      await open(page, hash);
      await expect(page.locator('.tabbar .tab-label').first()).toBeVisible();
      const rows = await page.locator('.tabbar a').evaluateAll(links => links.map(link => {
        const label = link.querySelector('.tab-label');
        return {
          label: label.textContent.trim(),
          text: getComputedStyle(label).color,
          bar: getComputedStyle(link.closest('.tabbar')).backgroundColor,
          page: getComputedStyle(document.body).backgroundColor,
        };
      }));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const ratio = contrast(row.text, row.bar, row.page);
        console.log("tab-contrast", colorScheme, hash, row.label, ratio.toFixed(2));
        expect(ratio, JSON.stringify(row)).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await context.close();
    }
  });
}
