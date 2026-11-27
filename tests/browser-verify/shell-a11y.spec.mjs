// The shell's accessibility gate (PRODUCT-UX-FIELD-RESEARCH §14.6): axe (WCAG 2.2 A/AA rules) on the main screens in
// light and dark at desktop and phone width, and a scripted keyboard pass through search, settings and theme.
// Headless only, against the real app on a temporary home (lib.mjs harness).
import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {startHarness} from './lib.mjs';
import {SETTINGS, visibleSettings} from '../../ui/v1/src/settings-registry.mjs';
import {SETTINGS_READY} from '../../ui/v1/src/settings-model.mjs';

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const SCREENS = ['#/home', '#/jobs', '#/lend', '#/lend/limits', '#/circles', '#/you/all', '#/you/profile', '#/you/appearance',
  '#/you/notifications', '#/you/updates', '#/you/phone', '#/new', '#/no-such-page'];
const SIZES = [[1440, 900], [390, 844]];

let harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.stop(); });

async function settle(page) {
  await page.locator('#app h1').first().waitFor({timeout: 15000});
  // Skeletons are announced as loading regions; scan the loaded screen, not the placeholder.
  await page.waitForFunction(() => !document.querySelector('.skel,.skeleton,[aria-label^="Loading"]'), null, {timeout: 8000}).catch(() => {});
}

async function axe(page) {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    // target-size is checked by targetSizes() below: axe counts a target as "obscured" when the scan's scroll
    // position leaves it under the sticky tab bar or save bar, which scrolling resolves.
    const result = await window.axe.run(document, {runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']},
      rules: {'target-size': {enabled: false}}});
    return result.violations.map(v => ({id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map(n => n.target.join(' ') + ' — ' + n.failureSummary.split('\n')[1]?.trim())}));
  });
}

// WCAG 2.5.8: a control is at least 24 × 24 CSS px, or a 24 px box centred on it touches no other control (the spacing
// exception). Links inside running text are exempt (the inline exception).
const targetSizes = page => page.evaluate(() => {
  const all = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=switch],[role=option]')]
    .filter(el => el.offsetParent !== null && !el.closest('dialog:not([open]),[hidden]'))
    .map(el => ({el, r: el.getBoundingClientRect()})).filter(({r}) => r.width > 0 && r.height > 0);
  const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  return all.filter(({el, r}) => (r.width < 24 || r.height < 24) && !(el.tagName === 'A' && el.closest('p,dd')))
    .filter(({el, r}) => {
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const box = {left: Math.min(r.left, cx - 12), right: Math.max(r.right, cx + 12), top: Math.min(r.top, cy - 12), bottom: Math.max(r.bottom, cy + 12)};
      return all.some(other => other.el !== el && !other.el.contains(el) && !el.contains(other.el) && hits(box, other.r));
    })
    .map(({el, r}) => (el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30) || el.tagName) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
});

for (const [width, height] of SIZES) for (const scheme of ['light', 'dark']) {
  test(`axe: no WCAG A/AA violations at ${width}px in ${scheme}`, async ({browser}) => {
    const context = await browser.newContext({viewport: {width, height}, colorScheme: scheme});
    const page = await context.newPage();
    const found = [];
    for (const hash of SCREENS) {
      await page.goto((await harness.link('lender')) + hash);
      try { await settle(page); } catch { found.push(hash + ' shows no h1'); continue; }
      for (const v of await axe(page)) found.push(hash + ' ' + v.id + ' (' + v.impact + '): ' + v.nodes.join(' | '));
      for (const small of await targetSizes(page)) found.push(hash + ' target smaller than 24px: ' + small);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (overflow > 1) found.push(hash + ' overflows horizontally by ' + overflow + 'px');
    }
    await context.close();
    expect(found, found.join('\n')).toEqual([]);
  });
}

test('keyboard: skip link first, search finds a setting by synonym and lands on the field', async ({page}) => {
  await page.goto((await harness.link('lender')) + '#/home');
  await settle(page);
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveText('Skip to content');
  await page.keyboard.press('Control+k');
  const search = page.getByRole('combobox', {name: 'Search or jump to'});
  await expect(search).toBeFocused();
  await search.fill('quota');
  await expect(page.getByRole('option', {name: /How much to lend/})).toBeVisible();
  await page.keyboard.press('ArrowDown');
  // Move until the highlighted option is the setting, using only keys.
  for (let i = 0; i < 8 && !/How much to lend/.test(await page.locator('[role=option][aria-selected=true]').innerText()); i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/lend\/limits$/);
  await expect(page.locator('input[name="protectionPosition"]:checked')).toBeFocused();
  await page.keyboard.press('Control+k');
  await search.fill('away');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const stopOnReturn = page.getByRole('switch', {name: 'Stop a running job when I return'});
  await expect(stopOnReturn).toBeFocused();
  await expect(stopOnReturn).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => window.__pointer ?? 0)).toBe(0);
});

test('keyboard: Ctrl+, opens the settings map; its search filters and a row opens the page at the field', async ({page}) => {
  await page.goto((await harness.link('lender')) + '#/jobs');
  await settle(page);
  await page.keyboard.press('Control+,');
  await expect(page).toHaveURL(/#\/you\/all$/);
  await expect(page.getByRole('heading', {name: 'All settings'})).toBeVisible();
  const field = page.getByRole('searchbox', {name: 'Search settings'});
  await field.focus();
  await field.fill('computer name');
  await expect(page.locator('.settings-map .row')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/you\/profile$/);
  await expect(page.locator('#setting-name')).toBeFocused();
});

test('every registry row that names a field leads to that field on its page', async ({page}) => {
  const missing = [];
  for (const item of visibleSettings(SETTINGS_READY).filter(i => i.focus && i.href.startsWith('#/'))) {
    await page.goto((await harness.link('lender')) + item.href);
    await settle(page);
    if (!(await page.locator(item.focus).count())) missing.push(item.key + ' → ' + item.href + ' ' + item.focus);
  }
  expect(missing, missing.join('\n')).toEqual([]);
  expect(SETTINGS.filter(i => i.focus).length).toBeGreaterThan(5);
});

test('theme: Dark is kept across a reload, System removes the override', async ({page}) => {
  await page.goto((await harness.link('lender')) + '#/you/appearance');
  await settle(page);
  const group = page.getByRole('group', {name: 'Theme'});
  await group.getByRole('button', {name: 'Dark'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(group.getByRole('button', {name: 'Dark'})).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await settle(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(17, 18, 22)');
  await page.getByRole('group', {name: 'Theme'}).getByRole('button', {name: 'System'}).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  expect(await page.evaluate(() => localStorage.getItem('faravan-theme'))).toBeNull();
});

test('session lost: Home and the computer chip stop saying Loading or Checking', async ({page}) => {
  await page.route('**/api/**', route => route.fulfill({status: 401, json: {code: 'unauthorized'}}));
  await page.goto((await harness.link('lender')) + '#/home');
  await expect(page.getByText(/This page is no longer connected to Faravan/).first()).toBeVisible();
  await expect(page.locator('main')).toContainText('Reconnect to Faravan');
  await expect(page.locator('main')).not.toContainText(/Loading/);
  await expect(page.locator('.machine')).not.toContainText(/Checking/);
});


for(const [name,className] of [['save limit','btn btn-primary owner-limit-save'],['a primary button','btn btn-primary']])
for(const scheme of ['light','dark'])test(name+' keeps contrast while becoming enabled in '+scheme,async({browser})=>{
  const context=await browser.newContext({colorScheme:scheme});
  try {
    const page=await context.newPage();await page.goto((await harness.link('lender'))+'#/home');await settle(page);
    const samples=await page.evaluate(className=>{
      const button=document.createElement('button');button.className=className;button.textContent='Save limit';button.disabled=true;document.body.append(button);
      getComputedStyle(button).backgroundColor;button.disabled=false;getComputedStyle(button).backgroundColor;
      const animation=button.getAnimations().find(a=>a.transitionProperty==='background-color');
      const luminance=rgb=>rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const samples=[];
      for(const fraction of [0,.5,1]) {
        if(animation){animation.pause();animation.currentTime=Number(animation.effect.getTiming().duration)*fraction;}
        const style=getComputedStyle(button),fg=luminance(style.color),bg=luminance(style.backgroundColor);
        samples.push({fraction,foreground:style.color,background:style.backgroundColor,ratio:(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05),disabled:button.disabled});
      }
      button.remove();return samples;
    },className);
    for(const sample of samples){expect(sample.disabled).toBe(false);expect(sample.ratio,JSON.stringify(sample)).toBeGreaterThanOrEqual(4.5);}
  }finally{await context.close();}
});

test('phone tab bar marks the current tab with a shape, not only colour',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  try {
    const page=await context.newPage();await page.goto((await harness.link('lender'))+'#/jobs');await settle(page);
    const marker=await page.locator('.tabbar a[aria-current=page]').evaluate(a=>{const s=getComputedStyle(a,'::after');return {content:s.content,width:s.width,height:s.height,display:s.display};});
    expect(marker.content).not.toBe('none');
    expect(marker.display).not.toBe('none');
    expect(parseFloat(marker.width)).toBeGreaterThanOrEqual(3);
    expect(parseFloat(marker.height)).toBeGreaterThanOrEqual(3);
  }finally{await context.close();}
});
