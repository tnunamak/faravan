import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { appFixture, api, boundedFetch, waitFor } from '../helpers/v1-app-fixture.mjs';
import { installOnlineShim } from '../helpers/browser-online-shim.mjs';

// The device journey in a real headless browser at phone size: pair from the QR link, compare words, see a real review
// card, decline it, get removed from the computer. Playwright comes from FARAVAN_PLAYWRIGHT (a path to playwright's
// index.mjs) or the 'playwright' package; without it the test is skipped, never faked. FARAVAN_BROWSER_EXECUTABLE points at
// a Chromium (or chrome-headless-shell) binary when the installed Playwright expects a browser build that is not present.
// Kept out of `npm test` (which only discovers tests/*.test.mjs). Run it explicitly:
//   FARAVAN_PLAYWRIGHT=/path/to/playwright/index.mjs [FARAVAN_BROWSER_EXECUTABLE=/path/to/chrome] \
//   [FARAVAN_PHONE_SHOTS=/dir/for/screenshots] node --test tests/e2e-browser/v1-phone.test.mjs
const testOptions = {timeout: 180000};
const networkInterfaces = () => ({eth0: [{address: '127.0.0.1', family: 'IPv4', internal: false}]});
const SHOTS = process.env.FARAVAN_PHONE_SHOTS ?? null;
const PHONE = {viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36'};

const launchOptions = () => ({headless: true, ...(process.env.FARAVAN_BROWSER_EXECUTABLE ? {executablePath: process.env.FARAVAN_BROWSER_EXECUTABLE} : {})});
async function loadPlaywright() {
  let playwright;
  try { playwright = await import(process.env.FARAVAN_PLAYWRIGHT ?? 'playwright'); } catch { return null; }
  installOnlineShim(playwright.chromium);
  return playwright;
}
async function shot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, {recursive: true});
  // Phone and desktop width, light and dark: the four combinations the design floor is judged on.
  for (const [size, width, height] of [['390', 390, 844], ['1440', 1440, 900]]) {
    await page.setViewportSize({width, height});
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({colorScheme: scheme});
      await page.waitForTimeout(300); // let the 120 ms button colour transition finish, or a shot catches it halfway
      await page.screenshot({path: join(SHOTS, name + '-' + size + '-' + scheme + '.png'), fullPage: true});
    }
  }
  await page.setViewportSize(PHONE.viewport);
  await page.emulateMedia({colorScheme: 'light'});
}
/** A POST from the Faravan window on this computer: its cookie and its own Origin, never the token alone. */
async function fromComputerWindow(app, path, body) {
  const response = await boundedFetch(app.handoffUrl(), {redirect: 'manual'});
  await response.text();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return api(app, path, {method: 'POST', token: null, headers: {cookie, origin: app.origin}, body});
}
const confirmOnComputer = (app, id) => fromComputerWindow(app, '/api/phone/pairing/confirm', {id, confirmed: true});
/** The page must not scroll sideways or cut off a control at phone width. */
async function fitsPhone(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth, problems = [];
    if (document.documentElement.scrollWidth > width + 1) problems.push('scrolls sideways');
    for (const node of document.querySelectorAll('button,input,a')) {
      const box = node.getBoundingClientRect();
      if (box.width && (box.left < -1 || box.right > width + 1)) problems.push((node.textContent || node.id) + ' cut off');
      if (box.width && box.height < 43.5 && node.tagName !== 'A') problems.push((node.textContent || node.id) + ' under 44px tall');
    }
    return problems;
  });
}

test('a device pairs from the QR link, sees a real request over HTTPS, declines it, and learns when it is removed', testOptions, async t => {
  const playwright = await loadPlaywright();
  if (!playwright) return t.skip('playwright is not installed; set FARAVAN_PLAYWRIGHT');
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect({networkInterfaces, name: 'Studio'});
  const app = lender.app, dir = await f.home('lender');
  const key = join(dir, 'phone-key.pem'), cert = join(dir, 'phone-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=faravan.test', '-keyout', key, '-out', cert], {stdio: 'ignore'});
  const on = await fromComputerWindow(app, '/api/phone/settings', {enabled: true, address: '127.0.0.1', certFile: cert, keyFile: key});
  assert.equal(on.reach.state, 'https');

  const browser = await playwright.chromium.launch(launchOptions());
  t.after(() => browser.close());
  const context = await browser.newContext({...PHONE, ignoreHTTPSErrors: true});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Expected noise: the 401 a never-paired phone gets, the refused connection of the offline check, and the service worker that a self-signed test certificate
  // cannot install (a real phone must trust the certificate; the reach copy says so, and the page carries on without it).
  page.on('console', message => { if (message.type() === 'error' && !/401|Failed to load resource|ERR_CONNECTION_REFUSED|SSL certificate error occurred when fetching the script/.test(message.text())) errors.push(message.text()); });

  // A device that was never paired sees the pair form, not an error.
  await page.goto(on.origin + '/');
  await page.getByRole('heading', {name: 'Pair this device'}).waitFor();
  assert.equal(await page.getByRole('alert').isVisible(), false);

  // The QR link fills the code and leaves no code in the address bar.
  const {pairing} = await api(app, '/api/phone/pairing', {method: 'POST', body: {}});
  await page.goto(pairing.url);
  assert.equal(await page.getByLabel('Pairing code').inputValue(), pairing.code);
  assert.equal(new URL(page.url()).hash, '');
  await page.getByLabel('Name for this device').fill('Pixel test');
  assert.deepEqual(await fitsPhone(page), []);
  await shot(page, 'phone-pair');
  await page.getByRole('button', {name: 'Pair this device'}).click();

  await page.getByRole('heading', {name: 'Check the words'}).waitFor();
  const shown = (await page.locator('.words span').allTextContents());
  const claimed = await api(app, '/api/phone');
  assert.deepEqual(shown, claimed.pairing.phrase, 'both screens show the same words');
  assert.equal(claimed.pairing.phone.label, 'Pixel test');
  await shot(page, 'phone-words');
  await confirmOnComputer(app, claimed.pairing.id);
  await page.getByRole('heading', {name: /^Requests for /}).waitFor({timeout: 15000});
  await page.getByText('Nothing needs your answer.').waitFor();

  // A real review card from a friend's job.
  await api(app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, git: 'https://github.com/example/synthetic.git',
    commit: '1'.repeat(40), prompt: 'Synthetic task: write a greeting.', harness: 'codex'}});
  const card = await waitFor(async () => (await api(app, '/api/approvals'))[0], 'review card', 30000);
  await page.reload();
  const request = page.getByRole('article', {name: /^Request from /});
  await request.waitFor();
  await request.getByText('Synthetic task: write a greeting.').waitFor();
  assert.match(await request.locator('.facts').textContent(), /codex.*Internet access/);
  assert.deepEqual(await fitsPhone(page), []);
  await shot(page, 'phone-inbox');

  // The desktop request page's decision and words: Run it / Not now, with what Run it does said up front.
  await request.getByText('Run it starts the job on your computer now').waitFor();
  assert.deepEqual(await request.getByRole('button').allTextContents(), [card.offer ? 'Not for me' : 'Not now', 'Run it']);
  assert.equal((await api(app, '/api/approvals'))[0]?.id, card.id, 'nothing is answered by looking');
  await request.getByRole('button', {name: card.offer ? 'Not for me' : 'Not now'}).click();
  await page.getByRole('status').filter({hasText: card.offer ? 'Not for me sent.' : 'Not now sent.'}).waitFor();
  await page.getByText((card.offer ? 'Not for me' : 'Not now') + ' · answered on Pixel test').waitFor();
  assert.deepEqual(await api(app, '/api/approvals'), []);
  assert.equal(await page.locator('#app').evaluate(node => node.textContent.includes('null')), false, 'no missing part prints as "null"');
  await shot(page, 'phone-answered');

  // Expired requests, as the inbox reports them (a review card times out after minutes; the shape is the server's).
  const expiredInbox = {computer: 'Studio', phone: {label: 'Pixel test', scopes: ['inbox:read', 'requests:answer']}, https: true, canAnswer: true, needs: [],
    answered: [{id: card.id, requester: 'Synthetic owner', agent: 'codex', runtimeSeconds: 1200, network: 'internet', startsNow: true, prompt: 'Synthetic task: write a greeting.', state: 'declined', by: 'Pixel test', at: new Date().toISOString()}],
    expired: [{id: 'old', requester: 'Ana', agent: 'claude', runtimeSeconds: 600, network: 'none', startsNow: true, prompt: 'Tidy the README.', state: 'expired', at: new Date().toISOString()}]};
  await page.route('**/phone/api/inbox', route => route.fulfill({json: expiredInbox}));
  await page.reload();
  await page.getByRole('heading', {name: /^Expired/}).waitFor();
  await shot(page, 'phone-expired');
  // The computer asleep or off this network: an honest "can't reach", with a way to try again.
  await page.unroute('**/phone/api/inbox');
  await page.route('**/phone/api/inbox', route => route.abort('connectionrefused'));
  await page.reload();
  await page.getByRole('alert').filter({hasText: 'Can’t reach your computer'}).waitFor();
  await page.getByRole('button', {name: 'Try again'}).waitFor();
  await shot(page, 'phone-offline');
  await page.unroute('**/phone/api/inbox');

  // Removed from the computer: the device says so, plainly, on its next load.
  const {phones} = await api(app, '/api/phone');
  await api(app, '/api/phone/phones/' + phones[0].id + '/revoke', {method: 'POST', body: {}});
  await page.reload();
  await page.getByRole('alert').filter({hasText: 'isn’t paired any more'}).waitFor();
  assert.deepEqual(errors, []);
});

test('over plain HTTP the device sees who asked but not the task, and is told to answer on the computer', testOptions, async t => {
  const playwright = await loadPlaywright();
  if (!playwright) return t.skip('playwright is not installed; set FARAVAN_PLAYWRIGHT');
  const f = await appFixture(t);
  const {app} = await f.start('http-phone', {networkInterfaces});
  const on = await fromComputerWindow(app, '/api/phone/settings', {enabled: true, address: '127.0.0.1'});
  const browser = await playwright.chromium.launch(launchOptions());
  t.after(() => browser.close());
  const page = await (await browser.newContext(PHONE)).newPage();
  const {pairing} = await api(app, '/api/phone/pairing', {method: 'POST', body: {}});
  // Typed by hand, in lower case with a space: the code still works.
  await page.goto(on.origin + '/');
  await page.getByLabel('Pairing code').fill(pairing.code.toLowerCase().replace('-', ' '));
  await page.getByRole('button', {name: 'Pair this device'}).click();
  await page.getByText('To answer them here, your computer needs an encrypted (HTTPS) connection.').waitFor();
  await confirmOnComputer(app, (await api(app, '/api/phone')).pairing.id);
  await page.getByRole('heading', {name: /^Requests for /}).waitFor({timeout: 15000});
  // Keyboard reaches the only control without a pointer.
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Unpair this device');
  await shot(page, 'phone-http-inbox');
});

/** A headless phone on plain HTTP, started at the pair form. Resolves with what the lifecycle tests drive. */
async function phoneOnHttp(t, playwright) {
  const f = await appFixture(t);
  const {app} = await f.start('http-phone', {networkInterfaces});
  const on = await fromComputerWindow(app, '/api/phone/settings', {enabled: true, address: '127.0.0.1'});
  const browser = await playwright.chromium.launch(launchOptions());
  t.after(() => browser.close());
  const page = await (await browser.newContext(PHONE)).newPage();
  const claim = async () => {
    const {pairing} = await api(app, '/api/phone/pairing', {method: 'POST', body: {}});
    await page.goto(on.origin + '/');
    await page.getByLabel('Pairing code').fill(pairing.code);
    await page.getByRole('button', {name: 'Pair this device'}).click();
  };
  return {app, page, claim};
}
/** What a device does when its tab goes to the background: the page lifecycle says hidden, then visible again. */
const setVisibility = (page, state) => page.evaluate(value => {
  for (const name of ['visibilityState', 'hidden']) Object.defineProperty(document, name, {configurable: true, get: () => name === 'hidden' ? value === 'hidden' : value});
  document.dispatchEvent(new Event('visibilitychange'));
}, state);

test('a device that was in the background while waiting for the words keeps checking when it comes back', testOptions, async t => {
  const playwright = await loadPlaywright();
  if (!playwright) return t.skip('playwright is not installed; set FARAVAN_PLAYWRIGHT');
  const {app, page, claim} = await phoneOnHttp(t, playwright);
  let polls = 0;
  page.on('request', request => { if (request.url().endsWith('/phone/api/pair/status')) polls += 1; });
  await claim();
  await page.getByRole('heading', {name: 'Check the words'}).waitFor();

  await setVisibility(page, 'hidden');
  await page.waitForTimeout(500); // a poll already in flight may finish; none may start after this
  const whileHidden = polls;
  await page.waitForTimeout(3500);
  assert.equal(polls, whileHidden, 'a hidden page makes no pairing requests');
  // Confirmed on the computer while the device was away.
  await confirmOnComputer(app, (await api(app, '/api/phone')).pairing.id);

  const before = polls;
  await setVisibility(page, 'visible'); await setVisibility(page, 'visible');
  await page.getByRole('heading', {name: /^Requests for /}).waitFor({timeout: 15000});
  assert.ok(polls - before <= 2, 'coming back starts one poll, not one per event: ' + (polls - before));
});

test('Unpair keeps the device paired and says so when the computer cannot be told, and works on retry', testOptions, async t => {
  const playwright = await loadPlaywright();
  if (!playwright) return t.skip('playwright is not installed; set FARAVAN_PLAYWRIGHT');
  const {app, page, claim} = await phoneOnHttp(t, playwright);
  await claim();
  await page.getByRole('heading', {name: 'Check the words'}).waitFor();
  await confirmOnComputer(app, (await api(app, '/api/phone')).pairing.id);
  await page.getByRole('heading', {name: /^Requests for /}).waitFor({timeout: 15000});
  const tapUnpair = async () => {
    await page.getByRole('button', {name: 'Unpair this device'}).click();
    await page.getByRole('button', {name: 'Tap again to unpair'}).click();
  };

  await page.route('**/phone/api/unpair', route => route.abort('connectionrefused'));
  await tapUnpair();
  await page.getByRole('alert').filter({hasText: 'still paired'}).waitFor();
  await shot(page, 'phone-unpair-failed');
  assert.equal(await page.getByText('This device is unpaired').count(), 0, 'no success claim after a failure');
  assert.equal(await page.evaluate(() => localStorage.getItem('faravan.phone.paired')), 'yes');
  assert.equal((await api(app, '/api/phone')).phones.length, 1, 'the computer still lists the device');
  await page.getByRole('button', {name: 'Unpair this device'}).waitFor();

  await page.unroute('**/phone/api/unpair');
  await tapUnpair();
  await page.getByRole('alert').filter({hasText: 'This device is unpaired'}).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('faravan.phone.paired')), null);
  assert.equal((await api(app, '/api/phone')).phones.length, 0, 'the computer no longer lists the device');
});
