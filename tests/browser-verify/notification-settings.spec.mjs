import {test, expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {startHarness} from './lib.mjs';

let harness;
test.beforeAll(async () => {harness = await startHarness();});
test.afterAll(async () => {await harness?.stop();});
const defaults = () => Object.fromEntries(['requests','job_ready','needs_attention','security','lending_attention','circle_activity'].map(key => [key, {history:true, desktop:key !== 'circle_activity'}]));

async function fixture(page, {failRead = false, failSave = false, holdSave = false} = {}) {
  let settings = defaults(), readFailure = failRead, saveFailure = failSave, release;
  const posts = [], hold = holdSave ? new Promise(resolve => {release = resolve;}) : null;
  await page.addInitScript(() => {window.__notificationPermissions = 0; Notification.requestPermission = async () => {window.__notificationPermissions++; return 'denied';};});
  await page.route('**/api/notification-settings', async route => {
    if (route.request().method() === 'POST') {
      const patch = route.request().postDataJSON(); posts.push(patch);
      if (saveFailure) return route.fulfill({status:500, json:{code:'internal'}});
      if (hold) await hold;
      for (const [key,value] of Object.entries(patch)) settings[key] = {...settings[key], ...value};
    } else if (readFailure) return route.fulfill({status:500, json:{code:'internal'}});
    return route.fulfill({json:settings});
  });
  await page.goto((await harness.link('lender')) + '#/you/notifications');
  return {posts, recoverRead:() => {readFailure=false;}, recoverSave:() => {saveFailure=false;}, release:() => release?.()};
}

test('notification channels save together, survive remount and never ask browser permission', async ({page}) => {
  const f = await fixture(page, {holdSave:true});
  const history = page.getByRole('switch', {name:'Requests: history', exact:true});
  const desktop = page.getByRole('switch', {name:'Circle activity: desktop notifications', exact:true});
  await expect(page.getByRole('switch')).toHaveCount(12);
  await expect(history).toHaveAttribute('aria-checked','true');
  await expect(desktop).toHaveAttribute('aria-checked','false');
  await history.focus(); await page.keyboard.press('Space');
  await desktop.click();
  await page.getByRole('button', {name:'Save notification settings', exact:true}).click();
  await expect(page.getByRole('button',{name:'Saving…',exact:true})).toBeDisabled();
  await expect(history).toHaveAttribute('aria-disabled','true');
  expect(f.posts).toEqual([{requests:{history:false}, circle_activity:{desktop:true}}]);
  f.release();
  await expect(page.getByRole('status').filter({hasText:'Notification settings saved.'})).toBeFocused();
  await expect(page.getByRole('button', {name:'Save notification settings', exact:true})).toHaveCount(0);
  await page.getByRole('link',{name:'Jobs',exact:true}).first().click();
  await page.goto((await harness.link('lender')) + '#/you/notifications');
  await expect(history).toHaveAttribute('aria-checked','false');
  await expect(desktop).toHaveAttribute('aria-checked','true');
  expect(await page.evaluate(() => window.__notificationPermissions)).toBe(0);
});

test('a failed read offers Retry without presenting editable default values', async ({page}) => {
  const f = await fixture(page,{failRead:true});
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('switch')).toHaveCount(0);
  f.recoverRead();
  await page.getByRole('button',{name:'Retry notification settings',exact:true}).click();
  await expect(page.getByRole('switch')).toHaveCount(12);
});

test('a failed save preserves edits and a later retry saves the same patch', async ({page}) => {
  const f = await fixture(page,{failSave:true});
  const control = page.getByRole('switch',{name:'Job ready: desktop notifications',exact:true});
  await control.click();
  await page.getByRole('button',{name:'Save notification settings',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Faravan could not confirm what happened. Check the current state before taking another action.');
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(control).toHaveAttribute('aria-checked','false');
  f.recoverSave();
  await page.getByRole('button',{name:'Save notification settings',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Notification settings saved.'})).toBeFocused();
  expect(f.posts).toEqual([{job_ready:{desktop:false}},{job_ready:{desktop:false}}]);
});

test('discard restores both saved channels without writing', async ({page}) => {
  const f = await fixture(page);
  const control = page.getByRole('switch',{name:'Requests: history',exact:true});
  await control.click();
  await page.getByRole('button',{name:'Discard',exact:true}).click();
  await expect(control).toHaveAttribute('aria-checked','true');
  await expect(page.getByRole('status').filter({hasText:'Changes discarded.'})).toBeFocused();
  expect(f.posts).toEqual([]);
});

for (const [name, viewport] of [['desktop',{width:1440,height:900}], ['phone',{width:390,height:844}]]) {
  for (const colorScheme of ['light','dark']) test(`notification settings fit ${name} ${colorScheme}`, async ({page}) => {
    await page.setViewportSize(viewport); await page.emulateMedia({colorScheme});
    await fixture(page);
    await expect(page.getByRole('switch')).toHaveCount(12);
    await expect(page.getByRole('switch',{name:'Job ready: desktop notifications',exact:true})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const controls = page.getByRole('switch');
    for (const control of await controls.all()) {
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    }
    const alignment = await page.evaluate(() => {
      const center = element => {const box=element.getBoundingClientRect(); return box.left + box.width / 2;};
      const rows = [...document.querySelectorAll('.notification-table tbody tr')];
      return {
        rows: rows.map(row => [...row.querySelectorAll('td')].map(cell => center(cell.querySelector('[role=switch]')))),
        headers: [...document.querySelectorAll('.notification-table thead th')].slice(1).map(center),
      };
    });
    expect(alignment.rows).toHaveLength(6);
    for (let column=0; column<2; column++) {
      const centers=alignment.rows.map(row=>row[column]);
      expect(Math.max(...centers)-Math.min(...centers)).toBeLessThan(1);
      expect(Math.abs(centers[0]-alignment.headers[column])).toBeLessThan(1);
    }
    await mkdir('test-artifacts/browser-verify', {recursive:true});
    await page.screenshot({path:`test-artifacts/browser-verify/notification-settings-${name}-${colorScheme}.png`});
    await page.getByRole('switch',{name:'Circle activity: desktop notifications',exact:true}).click();
    const save = page.getByRole('button',{name:'Save notification settings',exact:true});
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    const saveHit = await save.evaluate(element => {
      const box=element.getBoundingClientRect();
      const hit=document.elementFromPoint(box.x+box.width/2, box.y+box.height/2);
      return hit===element || element.contains(hit);
    });
    expect(saveHit).toBe(true);
    await page.screenshot({path:`test-artifacts/browser-verify/notification-settings-${name}-${colorScheme}-save.png`});
  });
}
